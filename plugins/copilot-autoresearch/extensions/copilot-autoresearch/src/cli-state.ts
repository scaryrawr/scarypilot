import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { autoresearchJsonlPath } from "./paths.ts";
import { JsonlEntrySchema, reconstructJsonlState, type ReconstructedJsonlState } from "./jsonl.ts";
import type { RunOutcome } from "./operations.ts";
import type { ExperimentRuntime } from "./state.ts";

const OutcomeSchema = Type.Union([
  Type.Literal("passed"), Type.Literal("failed"), Type.Literal("timeout"),
  Type.Literal("checks_failed"), Type.Literal("aborted"),
]);

const CompletedSchema = Type.Object({
  phase: Type.Literal("completed"),
  id: Type.String(),
  command: Type.String(),
  outcome: OutcomeSchema,
});

const OutputIdentitySchema = Type.Object({
  path: Type.String(),
  dev: Type.Integer({ minimum: 0 }),
  ino: Type.Integer({ minimum: 0 }),
  birthtimeMs: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });

export const CliStateSchema = Type.Object({
  version: Type.Literal(1),
  workspace: Type.String(),
  workDir: Type.String(),
  git: Type.Union([Type.Literal("manual"), Type.Literal("automatic")]),
  journalHash: Type.String(),
  mode: Type.Boolean(),
  lastRunChecks: Type.Union([Type.Null(), Type.Object({
    pass: Type.Boolean(), output: Type.String(), durationSeconds: Type.Number(),
  })]),
  lastRunDurationSeconds: Type.Union([Type.Null(), Type.Number()]),
  lastOutputPath: Type.Union([Type.Null(), Type.String()]),
  lastOutputIdentity: Type.Optional(Type.Union([Type.Null(), OutputIdentitySchema])),
  pending: Type.Union([
    Type.Null(),
    Type.Object({
      phase: Type.Literal("running"), id: Type.String(), command: Type.String(),
    }),
    CompletedSchema,
    Type.Object({
      phase: Type.Literal("logging"), receipt: CompletedSchema,
      run: Type.Integer({ minimum: 1 }),
    }),
  ]),
}, { additionalProperties: false });

export type CliState = Static<typeof CliStateSchema>;

type CliBaseline = { kind: "missing" } | { kind: "failed" } | { kind: "ready"; metric: number };

export function cliBaseline(state: ReconstructedJsonlState): CliBaseline {
  const first = state.results.find((run) => run.segment === state.currentSegment);

  if (!first) return { kind: "missing" };

  if (first.status !== "keep" || first.metric <= 0) return { kind: "failed" };

  return { kind: "ready", metric: first.metric };
}

export function cliStatePath(workDir: string): string {
  return path.join(workDir, ".auto", "cli.json");
}

export function readCliState(workDir: string): CliState | null {
  const file = cliStatePath(workDir);

  if (!fs.existsSync(file)) return null;
  const input: unknown = JSON.parse(fs.readFileSync(file, "utf8"));

  if (!Value.Check(CliStateSchema, input)) throw new Error(`Invalid CLI state at ${file}. Inspect it before recovery.`);

  if (input.lastOutputPath !== null) {
    const output = input.lastOutputPath;

    if (!path.isAbsolute(output) ||
        path.normalize(output) !== output ||
        !/^copilot-autoresearch-[a-f0-9]{16}\.log$/.test(path.basename(output))) {
      throw new Error("CLI output receipt must reference an absolute autoresearch log path.");
    }
  }

  if (input.lastOutputIdentity && input.lastOutputIdentity.path !== input.lastOutputPath) {
    throw new Error("CLI output identity does not match its output pointer. Inspect it before recovery.");
  }

  return input;
}

export function reconcileCliOutput(state: CliState): string | null {
  const output = state.lastOutputPath;

  if (output === null) return null;
  const identity = state.lastOutputIdentity;
  const current = fs.lstatSync(output, { throwIfNoEntry: false });

  if (identity && current?.isFile() &&
      current.dev === identity.dev && current.ino === identity.ino &&
      current.birthtimeMs === identity.birthtimeMs) return null;

  state.lastOutputPath = null;
  state.lastOutputIdentity = null;

  return `Dropped stale output cleanup receipt for ${output}: missing, replaced, or legacy file without identity; no file was deleted.`;
}

export function writeCliState(state: CliState): void {
  const file = cliStatePath(state.workDir);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);

  try {
    fs.writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(temporary, file);
}

export function journal(workDir: string) {
  const file = autoresearchJsonlPath(workDir);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

  for (const line of text.split("\n").filter(Boolean)) {
    const entry: unknown = JSON.parse(line);

    if (!Value.Check(JsonlEntrySchema, entry)) throw new Error(`Invalid journal entry at ${file}.`);
  }

  return {
    hash: createHash("sha256").update(text).digest("hex"),
    state: reconstructJsonlState(text),
  };
}

export function persistCliRuntime(state: CliState, runtime: ExperimentRuntime): void {
  state.mode = runtime.autoresearchMode;
  state.lastRunChecks = runtime.lastRunChecks;
  state.lastRunDurationSeconds = runtime.lastRunDurationSeconds;
  state.lastOutputPath = runtime.lastOutputPath;

  if (runtime.lastOutputPath === null) state.lastOutputIdentity = null;
  state.journalHash = journal(state.workDir).hash;
  writeCliState(state);
}

export function completeCliRun(state: CliState, outcome: RunOutcome, runtime: ExperimentRuntime): void {
  if (state.pending?.phase !== "running") throw new Error("No running CLI receipt.");
  const output = runtime.lastOutputPath;

  if (output !== null) {
    const current = fs.lstatSync(output);

    if (!current.isFile()) throw new Error("Executor output is not a regular file. Inspect it before recovery.");
    state.lastOutputIdentity = {
      path: output, dev: current.dev, ino: current.ino, birthtimeMs: current.birthtimeMs,
    };
  } else {
    state.lastOutputIdentity = null;
  }

  state.pending = { ...state.pending, phase: "completed", outcome };
}

const LockSchema = Type.Object({ pid: Type.Integer({ minimum: 1 }) });

export function acquireCliLock(workDir: string, recover: boolean): () => void {
  const lock = path.join(workDir, ".auto", "cli.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  if (recover) {
    const recoveryLock = `${lock}.recovery`;
    const recoveryFd = fs.openSync(recoveryLock, "wx", 0o600);

    try {
      fs.writeFileSync(recoveryFd, JSON.stringify({ pid: process.pid }));

      if (fs.existsSync(lock)) {
        const input: unknown = JSON.parse(fs.readFileSync(lock, "utf8"));

        if (!Value.Check(LockSchema, input)) throw new Error(`Invalid lock at ${lock}. Inspect it manually.`);
        let alive = true;

        try {
          process.kill(input.pid, 0);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
          alive = false;
        }

        if (alive) throw new Error(`CLI process ${input.pid} is still alive. Recovery refused.`);
        fs.unlinkSync(lock);
      }
    } finally {
      fs.closeSync(recoveryFd);
      fs.unlinkSync(recoveryLock);
    }
  }

  let fd: number;

  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch (cause) {
    throw new Error(`Cannot acquire ${lock}. Another CLI may be active; use status and recover after confirming commands stopped.`, { cause });
  }

  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  return () => fs.unlinkSync(lock);
}

export function recoverCliState(state: CliState): string {
  const current = journal(state.workDir);
  const pending = state.pending;

  if (pending?.phase === "completed" && current.hash !== state.journalHash) throw new Error("Journal diverged after the completed run. Inspect it manually.");

  if (!pending) {
    if (state.journalHash !== current.hash) throw new Error("Journal changed outside this CLI. Use init to explicitly start a new segment.");

    return "No pending operation. Stale lock, if present, was cleared.";
  }

  if (pending.phase === "logging") {
    const logged = current.state.results.find((run) =>
      run.run === pending.run && run.asi?.cli_operation_id === pending.receipt.id,
    );

    if (logged) {
      state.pending = null;
      state.lastRunChecks = null;
      state.lastRunDurationSeconds = null;
      state.journalHash = current.hash;
      writeCliState(state);

      return `Recovered logged result #${logged.run}; it will not be appended again.`;
    }

    if (current.hash !== state.journalHash) throw new Error("Journal diverged while logging. Inspect it manually.");
    state.pending = pending.receipt;
  } else if (pending.phase === "running") {
    if (current.hash !== state.journalHash) throw new Error("Journal diverged while running. Inspect it manually.");
    state.pending = { ...pending, phase: "completed", outcome: "aborted" };
    state.lastRunChecks = null;
    state.lastRunDurationSeconds = null;
  }

  writeCliState(state);

  return "Receipt recovered. Log the completed outcome before the next run; interrupted commands must be logged as crash.";
}
