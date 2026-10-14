import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBash } from "../src/execution.ts";
import { runShell, runShellStreaming } from "../src/spawn.ts";
import { bridgeNativeRun } from "../src/windows-execution.ts";

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const command = (program: string) => `${quote(process.execPath.replaceAll("\\", "/"))} -e ${quote(program)}`;

const directories: string[] = [];

const bridges: ReturnType<typeof bridgeNativeRun>[] = [];

function fixture() {
  const directory = path.resolve(`.transport-test-${crypto.randomUUID()}`);
  mkdirSync(directory);
  directories.push(directory);

  return directory;
}

function bridge(overrides: Partial<Parameters<typeof bridgeNativeRun>[0]> = {}) {
  const streams = bridgeNativeRun({
    started: Promise.resolve(null), closed: Promise.resolve({ exitCode: 0, killed: false }),
    read: async () => null, write: async () => {}, endInput: async () => {},
    stop() {}, discard() {}, ...overrides,
  });

  bridges.push(streams);

  return streams;
}

afterEach(() => {
  for (const streams of bridges.splice(0)) {
    streams.stdin?.destroy();
    streams.stdout.destroy();
    streams.stderr.destroy();
  }

  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("native stream adapter credits", () => {
  it("allows one pending read and stops requesting at the readable high-water mark", async () => {
    const requests: ((data: Uint8Array | null) => void)[] = [];
    const read = vi.fn(() => new Promise<Uint8Array | null>((resolve) => requests.push(resolve)));
    const { stdout } = bridge({ read });
    stdout.read(0);
    stdout.read(0);
    expect(read).toHaveBeenCalledTimes(1);
    requests[0](Buffer.alloc(65536, 13));
    await vi.waitFor(() => expect(stdout.readableLength).toBe(65536));
    expect(read).toHaveBeenCalledTimes(1);
    expect(stdout.read(65536)).toEqual(Buffer.alloc(65536, 13));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    requests[1](null);
  });

  it("serializes bounded writes and sends EOF only after the last acknowledgement", async () => {
    const requests: (() => void)[] = [];
    const lengths: number[] = [];
    const endInput = vi.fn(async () => {});

    const { stdin } = bridge({
      write: (bytes) => {
        lengths.push(bytes.length);

        return new Promise<void>((resolve) => requests.push(resolve));
      },
      endInput,
    });

    if (!stdin) throw new Error("Missing bridge input");
    const done = finished(stdin, { cleanup: true });
    stdin.end(Buffer.alloc(3 * 65536 + 7));

    for (let index = 0; index < 4; index++) {
      await vi.waitFor(() => expect(requests).toHaveLength(index + 1));
      expect(endInput).not.toHaveBeenCalled();
      requests[index]();
    }

    await done;
    expect(lengths).toEqual([65536, 65536, 65536, 7]);
    expect(endInput).toHaveBeenCalledOnce();
  });

  it.each(["read", "write", "endInput"] as const)("propagates %s failures through real stream errors", async (operation) => {
    const failure = new Error(`native ${operation} failed`);

    const streams = bridge({
      [operation]: () => Promise.reject(failure),
    });

    const stream = operation === "read" ? streams.stdout : streams.stdin;

    if (!stream) throw new Error("Missing bridge stream");
    const done = finished(stream, { cleanup: true });

    if (operation === "read") streams.stdout.resume();
    else if (operation === "write") streams.stdin?.end("input");
    else streams.stdin?.end();

    await expect(done).rejects.toBe(failure);
  });
});

const runners = [
  { name: "buffered", run: runShell },
  { name: "streaming", run: (text: string, options: Parameters<typeof runShell>[1]) =>
    runShellStreaming(text, { ...options, maxBytes: 8 * 1024 * 1024, maxLines: 100 }) },
];

describe.each(runners)("$name real execution transport", ({ run }) => {
  it("delivers multi-megabyte UTF-8 JSON exactly and closes stdin", async () => {
    const input = { text: "🙂λ".repeat(400_000) };
    const bytes = Buffer.from(JSON.stringify(input));
    const program = "const a=[]; process.stdin.on('data',b=>a.push(b)); process.stdin.on('end',()=>{const b=Buffer.concat(a); process.stdout.write(b.length+'|'+require('node:crypto').createHash('sha256').update(b).digest('hex'))})";
    const result = await run(command(program), { stdinJson: input, timeoutMs: 10_000 });
    expect(result.killed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${bytes.length}|${createHash("sha256").update(bytes).digest("hex")}`);
  });

  it("drains saturated stdout and stderr without dropping bytes", async () => {
    const text = "abcdef".repeat(1000) + "\n";
    const program = `const text=${JSON.stringify(text)}; async function emit(s){for(let n=0;n<150;n++){const b=Buffer.from(text); for(const c of [b.subarray(0,1),b.subarray(1)]){if(!s.write(c)) await new Promise(r=>s.once('drain',r))}}} Promise.all([emit(process.stdout),emit(process.stderr)]).catch(e=>{throw e})`;
    const result = await run(command(program), { timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.stdout + result.stderr).not.toContain("�");
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBe(Buffer.byteLength(text) * 300);
  });

  it.each(["stdout", "stderr"])("preserves split UTF-8 on %s", async (channel) => {
    const text = "🙂λ".repeat(1000);
    const program = `const b=Buffer.from(${JSON.stringify(text)}); const s=process.${channel}; (async()=>{for(let i=0;i<b.length;i++){if(!s.write(b.subarray(i,i+1)))await new Promise(r=>s.once('drain',r))}})()`;
    const result = await run(command(program), { timeoutMs: 10_000 });
    expect(result.stdout + result.stderr).toBe(text);
    expect(result.exitCode).toBe(0);
  });

  it("cancels while the child never reads a full input pipe", async () => {
    const directory = fixture();
    const ready = path.join(directory, "ready");
    const controller = new AbortController();
    const program = "require('node:fs').writeFileSync('ready','ready'); process.stdin.pause(); setInterval(()=>{},1000)";

    const pending = run(command(program), {
      cwd: directory, stdinJson: { bytes: "x".repeat(4 * 1024 * 1024) },
      signal: controller.signal, timeoutMs: 1800,
    });

    void pending.catch(() => {});

    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 1500 });
      controller.abort();
      expect((await pending).killed).toBe(true);
    } finally {
      controller.abort();
      await pending;
    }
  });

  it("keeps concurrent cancellation independent of an unrelated execution", async () => {
    const controller = new AbortController();
    const cancelled = run("sleep 30", { signal: controller.signal, timeoutMs: 1800 });
    const completed = run("printf independent", { timeoutMs: 1800 });
    controller.abort();
    const [stopped, normal] = await Promise.all([cancelled, completed]);
    expect(stopped.killed).toBe(true);
    expect(normal).toMatchObject({ exitCode: 0, killed: false, stdout: "independent" });
  });

  it("rejects a real input-pipe failure and closes experiment ownership", async () => {
    const directory = fixture();
    const program = "const fs=require('node:fs'); fs.writeFileSync('ready.writing',String(process.pid)); fs.renameSync('ready.writing','ready'); process.exit(23)";

    const outcome = await run(command(program), {
      cwd: directory, stdinJson: { bytes: "x".repeat(4 * 1024 * 1024) }, timeoutMs: 1800,
    }).then(() => null, (error: Error) => error);

    expect(outcome).toBeInstanceOf(Error);
    const pid = Number(readFileSync(path.join(directory, "ready"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1500 });
  });
});

describe("real private execution streams", () => {
  it("resumes after a slow consumer without unbounded Node output buffering", async () => {
    const program = "const b=Buffer.alloc(65536,120); (async()=>{for(let n=0;n<64;n++)if(!process.stdout.write(b))await new Promise(r=>process.stdout.once('drain',r))})()";
    const execution = startBash(["-c", command(program)], { startedAt: Date.now(), timeoutMs: 10_000 }, "ignore");
    const result = execution.closed;
    void result.catch(() => {});
    execution.stderr.resume();

    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(execution.stdout.readableLength).toBeLessThanOrEqual(65536);
      let bytes = 0;

      for await (const chunk of execution.stdout) bytes += chunk.length;

      expect(bytes).toBe(64 * 65536);
      expect(await result).toMatchObject({ exitCode: 0, killed: false });
    } finally {
      await execution.dispose();
    }
  });

  it.runIf(process.platform === "win32")("kills remaining job members on normal root exit without changing its status", async () => {
    const directory = fixture();
    const worker = "require('node:fs').writeFileSync('ready',String(process.pid)); setTimeout(()=>require('node:fs').writeFileSync('survived','alive'),2500)";
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'inherit'}); const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync('ready')){clearInterval(t);process.exit(23)}},5)`;
    writeFileSync(path.join(directory, "parent.cjs"), parent);
    const result = await runShell(`${quote(process.execPath.replaceAll("\\", "/"))} parent.cjs`, { cwd: directory, timeoutMs: 1800 });
    expect(result).toMatchObject({ exitCode: 23, killed: false });
    const pid = Number(readFileSync(path.join(directory, "ready"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(existsSync(path.join(directory, "survived"))).toBe(false);
  }, 10_000);
});
