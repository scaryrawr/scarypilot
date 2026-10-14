import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Execution, ExecutionOptions } from "./execution.ts";
import { NativeAddon, createNativeRun } from "./native-run.ts";

const NativeFailure = Type.Object({
  stage: Type.String(),
  win32Code: Type.Number(),
  cleanupStage: Type.Optional(Type.String()),
});

export function bashError(error: NodeJS.ErrnoException) {
  return error.code === "ENOENT" || ("stage" in error && error.stage === "BashRequired")
    ? new Error("Bash is required to run experiments. Install Bash and add it to PATH (Git for Windows Bash on Windows).", { cause: error })
    : error;
}

const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });

const Index = Type.Object({
  schemaVersion: Type.Literal(1),
  nodeApiVersion: Type.Literal(8),
  protocolVersion: Type.Literal(2),
  sourceFingerprint: Digest,
  binaries: Type.Object({ x64: Digest, arm64: Digest }),
});

const Provenance = Type.Object({
  arch: Type.String(),
  nodeApiVersion: Type.Literal(8),
  protocolVersion: Type.Literal(2),
  kind: Type.Literal("runtime"),
  crt: Type.Literal("/MT"),
  sources: Type.Object({ fingerprint: Digest }),
  binary: Type.Object({ sha256: Digest, bytes: Type.Integer({ minimum: 1 }), machine: Type.Integer() }),
});

let addon: Static<typeof NativeAddon> | undefined;

function loadAddon() {
  if (addon) return addon;
  const arch = process.arch;

  if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported Windows Node architecture: ${arch}`);
  const root = fileURLToPath(new URL("../dist/native/", import.meta.url));
  const directory = path.join(root, `win32-${arch}`);

  try {
    const index = Value.Parse(Index, JSON.parse(readFileSync(path.join(root, "resources.json"), "utf8")));
    const metadata = Value.Parse(Provenance, JSON.parse(readFileSync(path.join(directory, "provenance.json"), "utf8")));
    const binary = path.join(directory, "owned-job.node");
    const bytes = readFileSync(binary);
    const hash = createHash("sha256").update(bytes).digest("hex");

    if (metadata.arch !== arch || metadata.sources.fingerprint !== index.sourceFingerprint ||
        hash !== index.binaries[arch] || hash !== metadata.binary.sha256 || bytes.length !== metadata.binary.bytes ||
        metadata.binary.machine !== (arch === "x64" ? 0x8664 : 0xaa64)) {
      throw new Error("Windows native execution resource integrity/provenance mismatch");
    }

    const loaded: unknown = createRequire(import.meta.url)(binary);

    if (!Value.Check(NativeAddon, loaded)) throw new Error("Windows native execution ABI mismatch");
    addon = loaded;

    return addon;
  } catch (cause) {
    throw new Error("Windows owned execution is unavailable. Reinstall the complete copilot-autoresearch plugin; no runtime download or ancestry fallback is permitted.", { cause });
  }
}

export function bridgeNativeRun(run: ReturnType<typeof createNativeRun>): Pick<Execution, "stdin" | "stdout" | "stderr"> {
  const output = (channel: number) => new Readable({
    highWaterMark: 65536,
    read() {
      void run.read(channel).then((data) => {
        if (!this.destroyed) this.push(data);
      }, (error: NodeJS.ErrnoException) => this.destroy(bashError(error)));
    },
  });

  const stdin = new Writable({
    highWaterMark: 65536,
    write(chunk: Buffer, _encoding, callback) {
      const write = async () => {
        for (let offset = 0; offset < chunk.length; offset += 65536) {
          await run.write(chunk.subarray(offset, offset + 65536));
        }
      };

      void write().then(() => callback(), (error: NodeJS.ErrnoException) => callback(bashError(error)));
    },
    final(callback) {
      void run.endInput().then(() => callback(), (error: NodeJS.ErrnoException) => callback(bashError(error)));
    },
  });

  return { stdin, stdout: output(1), stderr: output(2) };
}

export function startWindowsBash(args: string[], opts: ExecutionOptions, input: "pipe" | "ignore"): Execution {
  const api = loadAddon();

  const expired = opts.timeoutMs !== undefined && opts.timeoutMs > 0 &&
    Date.now() - opts.startedAt >= opts.timeoutMs;

  const native = createNativeRun(api, {
    executable: "bash",
    argv: ["bash", ...args],
    cwd: path.resolve(opts.cwd ?? process.cwd()),
    env: Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `${name}=${value}`),
    path: process.env.PATH ?? "",
    input: input === "pipe",
    cancelled: opts.signal?.aborted === true || expired,
  });

  const streams = bridgeNativeRun(native);

  const inputFailed = new Promise<never>((_resolve, reject) => {
    streams.stdin?.on("error", (error) => {
      native.discard();
      reject(error);
    });
  });

  const stop = () => native.stop();

  const timer = opts.timeoutMs && opts.timeoutMs > 0
    ? setTimeout(stop, Math.max(0, opts.timeoutMs - (Date.now() - opts.startedAt)))
    : undefined;

  const cleanup = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
  };

  if (opts.signal?.aborted) stop();
  else opts.signal?.addEventListener("abort", stop, { once: true });

  const started = native.started.then((pid) => {
    if (pid !== null) opts.processControl?.onWindowsStarted?.(pid);
  });

  const outputClosed = Promise.all([
    finished(streams.stdout, { cleanup: true }),
    finished(streams.stderr, { cleanup: true }),
    ...(input === "pipe" && streams.stdin ? [finished(streams.stdin, { cleanup: true })] : []),
  ]);

  const completion = Promise.all([native.closed, started, outputClosed]).then(([result]) => result);
  const closed = Promise.race([completion, inputFailed]).finally(cleanup);

  return {
    stdin: input === "pipe" ? streams.stdin : null,
    stdout: streams.stdout,
    stderr: streams.stderr,
    closed,
    dispose() {
      cleanup();
      native.discard();
      streams.stdin?.destroy();
      streams.stdout.destroy();
      streams.stderr.destroy();

      return native.closed.then(() => {}, (error: Error) => {
        if (!Value.Check(NativeFailure, error) || error.cleanupStage !== undefined) throw error;
      });
    },
  };
}
