import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ProcessPort } from "./io.ts";
import { processPort, sha256, writeJsonAtomic } from "./io.ts";
import type { HandoffSummary, HandoffV1, PstackSnapshot, SourceDigest } from "./types.ts";

async function repositoryRoot(cwd: string, port: ProcessPort): Promise<string> {
  return (await port.run("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
}

export async function gitStatePath(
  cwd: string,
  relative: string,
  port: ProcessPort = processPort,
): Promise<string> {
  const root = await repositoryRoot(cwd, port);
  const value = (
    await port.run("git", ["-C", root, "rev-parse", "--git-path", relative])
  ).stdout.trim();
  return isAbsolute(value) ? value : resolve(root, value);
}

export async function handoffDirectory(
  cwd: string,
  port: ProcessPort = processPort,
): Promise<string> {
  const root = await repositoryRoot(cwd, port);
  const value = (
    await port.run("git", ["-C", root, "rev-parse", "--git-common-dir"])
  ).stdout.trim();
  const common = isAbsolute(value) ? value : resolve(root, value);
  return join(common, "pstack", "handoffs");
}

export async function latestHandoff(
  cwd: string,
  port: ProcessPort = processPort,
): Promise<{ readonly summary: HandoffSummary | null; readonly source: SourceDigest | null }> {
  const directory = await handoffDirectory(cwd, port);
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { summary: null, source: null };
    }
    throw error;
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      return { path, modified: (await stat(path)).mtimeMs };
    }),
  );
  const latest = entries.sort((left, right) => right.modified - left.modified)[0];
  if (!latest) return { summary: null, source: null };
  const raw = await readFile(latest.path, "utf8");
  const handoff = parseHandoff(JSON.parse(raw));
  return {
    summary: {
      path: latest.path,
      createdAt: handoff.createdAt,
      intent: handoff.intent,
      nextAction: handoff.nextAction,
    },
    source: { kind: "handoff", path: latest.path, digest: sha256(raw) },
  };
}

export async function writeHandoff(
  cwd: string,
  sessionId: string,
  input: {
    readonly intent: string;
    readonly progress: string;
    readonly nextAction: string;
    readonly keyFiles: readonly string[];
    readonly snapshot: PstackSnapshot;
  },
  port: ProcessPort = processPort,
): Promise<{ readonly path: string; readonly handoff: HandoffV1 }> {
  const directory = await handoffDirectory(cwd, port);
  const path = join(directory, `${sessionId}.json`);
  const handoff: HandoffV1 = {
    schemaVersion: 1,
    sessionId,
    createdAt: new Date().toISOString(),
    intent: input.intent.trim(),
    progress: input.progress.trim(),
    nextAction: input.nextAction.trim(),
    keyFiles: [...input.keyFiles].sort(),
    snapshot: input.snapshot,
  };
  if (!handoff.intent || !handoff.progress || !handoff.nextAction) {
    throw new Error("handoff intent, progress, and next action are required");
  }
  await writeJsonAtomic(path, handoff);
  return { path, handoff };
}

export async function readHandoff(path: string): Promise<HandoffV1> {
  return parseHandoff(JSON.parse(await readFile(resolve(path), "utf8")));
}

function parseHandoff(value: unknown): HandoffV1 {
  if (value === null || typeof value !== "object") throw new Error("handoff must be an object");
  const handoff = value as Partial<HandoffV1>;
  if (
    handoff.schemaVersion !== 1 ||
    typeof handoff.sessionId !== "string" ||
    typeof handoff.createdAt !== "string" ||
    typeof handoff.intent !== "string" ||
    typeof handoff.progress !== "string" ||
    typeof handoff.nextAction !== "string" ||
    !Array.isArray(handoff.keyFiles) ||
    handoff.snapshot?.schemaVersion !== 1
  ) {
    throw new Error("handoff has an unsupported shape");
  }
  return handoff as HandoffV1;
}
