import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createCwdRef } from "./extension-context.ts";
import { resolveWorkDir, validateWorkDir, autoresearchConfigPath } from "./paths.ts";
import { isGitRepo, type ExperimentRuntime } from "./state.ts";
import { findBaselineMetric } from "./confidence.ts";
import { InitSchema, LogSchema, RunSchema, type OperationContext } from "./operations.ts";
import { initExperiment } from "./operation-init.ts";
import { runExperiment } from "./operation-run.ts";
import { logExperiment } from "./operation-log.ts";
import { requireIgnoredCliControls } from "./cli-git.ts";
import {
  acquireCliLock, cliBaseline, completeCliRun, journal, persistCliRuntime,
  readCliState, reconcileCliOutput, recoverCliState, writeCliState, type CliState,
} from "./cli-state.ts";

const help = `Autoresearch experiment CLI (Node 22+, Bash on PATH)
node <plugin>/extensions/copilot-autoresearch/dist/cli.mjs <action> --workspace <absolute-path> [options]

Actions
  init     --git manual|automatic --json '{"name":"goal","metric_name":"time"}'
  run      [--baseline] --json '{"command":"bash .auto/measure.sh"}'
  log      --json '{"commit":"0000000","metric":1,"status":"keep","description":"baseline","asi":{"hypothesis":"baseline"}}'
  status   Show journal summary and pending receipt as JSON.
  recover  --json '{"confirm_stopped":true}' after inspecting interrupted work.
  schema   Print init/run/log JSON schemas. No workspace required.

init explicitly activates CLI mode. run/log require that durable setup.
--baseline is required for the first run. A failed baseline needs a new init.
Each run needs one log. The first run must be a positive kept baseline.
manual never commits or reverts. automatic uses native Git commit/revert behavior.
No host sessions, dashboard, scheduling, agent wake-up, or dependency installation.
Exit codes: 0 success, 1 rejected/error, 2 failed benchmark/checks/timeout, 130 cancelled.
`;

const RecoverySchema = Type.Object({
  confirm_stopped: Type.Literal(true),
}, { additionalProperties: false });

const ConfigSchema = Type.Object({
  workingDir: Type.Optional(Type.String()),
  maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

const CliRunSchema = Type.Object({
  ...RunSchema.properties,
  command: Type.String({ minLength: 1 }),
  timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 86400 })),
  checks_timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 86400 })),
}, { additionalProperties: false });

const CommandSchema = Type.Union([
  Type.Object({ action: Type.Literal("init"), args: InitSchema }),
  Type.Object({ action: Type.Literal("run"), args: CliRunSchema }),
  Type.Object({ action: Type.Literal("log"), args: LogSchema }),
  Type.Object({ action: Type.Literal("recover"), args: RecoverySchema }),
]);

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      json: { type: "string" },
      git: { type: "string" },
      baseline: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(help);

    return;
  }

  if (positionals.length !== 1) throw new Error("Expected one action. Use --help.");
  const action = positionals[0];

  if (action === "schema") {
    console.log(JSON.stringify({ init: InitSchema, run: CliRunSchema, log: LogSchema }, null, 2));

    return;
  }

  if (!["init", "run", "log", "status", "recover"].includes(action)) throw new Error(`Unknown action ${action}.`);

  if (values.git !== undefined && action !== "init") throw new Error("--git is only valid for init.");

  if (values.baseline && action !== "run") throw new Error("--baseline is only valid for run.");

  if (!values.workspace || !path.isAbsolute(values.workspace)) throw new Error("--workspace must be an explicit absolute directory.");
  const workspace = fs.realpathSync(values.workspace);

  if (!fs.statSync(workspace).isDirectory()) throw new Error("--workspace must be a directory.");

  const configPath = autoresearchConfigPath(workspace);

  if (fs.existsSync(configPath)) {
    const config: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));

    if (!Value.Check(ConfigSchema, config)) throw new Error(`Invalid experiment config at ${configPath}.`);
  }

  const workDirError = validateWorkDir(workspace);

  if (workDirError) throw new Error(workDirError);
  const workDir = fs.realpathSync(resolveWorkDir(workspace));

  if (values.json && Buffer.byteLength(values.json) > 65536) throw new Error("--json is limited to 64 KiB.");
  const input: unknown = values.json === undefined ? undefined : JSON.parse(values.json);

  if (action === "status") {
    if (input !== undefined) throw new Error("status does not accept --json.");
    const saved = readCliState(workDir);
    const diagnostic = saved && reconcileCliOutput(saved);

    if (diagnostic) console.error(diagnostic);
    const current = journal(workDir);
    console.log(JSON.stringify({
      ok: true, workspace, workDir, cli: saved,
      journalChanged: saved !== null && saved.journalHash !== current.hash,
      name: current.state.name, metricName: current.state.metricName,
      baseline: findBaselineMetric(current.state.results, current.state.currentSegment),
      baselineState: cliBaseline(current.state),
      totalRuns: current.state.results.length, segment: current.state.currentSegment,
      recentRuns: current.state.results.slice(-10),
    }));

    return;
  }

  const command = { action, args: input };

  if (!Value.Check(CommandSchema, command)) throw new Error("Invalid action JSON. Use schema. Recovery requires {\"confirm_stopped\":true} after inspecting and stopping interrupted commands.");

  const release = acquireCliLock(workDir, action === "recover");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);

  try {
    let saved = readCliState(workDir);

    if (saved && (saved.workspace !== workspace || saved.workDir !== workDir)) throw new Error("CLI state belongs to another workspace/workdir.");
    const diagnostic = saved && reconcileCliOutput(saved);

    if (diagnostic) console.error(diagnostic);

    if (action === "recover") {
      if (!saved) throw new Error("No CLI state to recover. Use init.");
      console.log(JSON.stringify({ ok: true, message: recoverCliState(saved) }));

      return;
    }

    if (action === "init") {
      if (saved?.pending) throw new Error("A run is pending. Log it or recover it before init.");

      if (values.git !== "manual" && values.git !== "automatic") throw new Error("init requires --git manual or --git automatic. Automatic commits/reverts files.");

      if (values.git === "automatic" && !(await isGitRepo(workDir))) throw new Error("Automatic Git policy requires an accessible Git worktree.");

      if (values.git === "automatic") requireIgnoredCliControls(workDir);
      saved = {
        version: 1, workspace, workDir, git: values.git,
        journalHash: journal(workDir).hash, mode: true,
        lastRunChecks: null, lastRunDurationSeconds: null,
        lastOutputPath: saved?.lastOutputPath ?? null,
        lastOutputIdentity: saved?.lastOutputIdentity ?? null, pending: null,
      };
    }

    if (!saved) throw new Error("CLI mode is off. Run init with explicit --git policy first.");
    const state: CliState = saved;

    if (journal(workDir).hash !== state.journalHash) throw new Error("Journal changed outside this CLI. Inspect it and use init for a new segment, or recover an interrupted log.");

    const runtime: ExperimentRuntime = {
      autoresearchMode: state.mode,
      lastRunChecks: state.lastRunChecks,
      lastRunDurationSeconds: state.lastRunDurationSeconds,
      lastOutputPath: state.lastOutputPath,
    };

    const ctx: OperationContext = {
      cwdRef: createCwdRef(workspace), runtime, git: state.git,
      log: () => {},
      persist: () => persistCliRuntime(state, runtime),
      onRunCompleted: (outcome) => completeCliRun(state, outcome, runtime),
      onRunStarting: (benchmarkCommand) => {
        state.pending = { phase: "running", id: randomUUID(), command: benchmarkCommand };
        writeCliState(state);
      },
      onLogged: () => { state.pending = null; },
      onGitFailure: (message) => { throw new Error(message); },
    };

    let message: string;

    if (command.action === "init") {
      message = await initExperiment(ctx, command.args);
    } else if (command.action === "run") {
      if (state.pending) throw new Error("A run is pending. Log or recover it first.");
      const current = journal(workDir).state;
      const baseline = cliBaseline(current);

      if (baseline.kind === "failed") throw new Error("No baseline that passed and was kept. Use init for a fresh segment before rerunning the baseline.");

      if (baseline.kind === "missing" && !values.baseline) throw new Error("No baseline. Use run --baseline, then log a passing keep before candidates.");

      if (!runtime.autoresearchMode) throw new Error("CLI mode is off. Use init for a new segment.");
      message = await runExperiment(ctx, command.args, controller.signal);
      const pending = readCliState(workDir)?.pending;

      if (pending?.phase === "completed" && pending.outcome !== "passed") {
        process.exitCode = pending.outcome === "aborted" ? 130 : 2;
      }
    } else if (command.action === "log") {
      const input = command.args;
      const receipt = state.pending;

      if (state.git === "automatic" && !(await isGitRepo(workDir))) throw new Error("Automatic Git policy requires an accessible Git worktree.");

      if (state.git === "automatic") requireIgnoredCliControls(workDir);

      if (receipt?.phase !== "completed") throw new Error("No completed run. Run a benchmark first, or recover an interrupted operation.");

      if (receipt.outcome === "checks_failed" && input.status !== "checks_failed") throw new Error("Failed checks must be logged as checks_failed.");

      if (["failed", "timeout", "aborted"].includes(receipt.outcome) && (input.status !== "crash" || input.metric !== 0)) throw new Error("Failed, timed out or aborted runs must be logged as crash with metric 0.");

      if (receipt.outcome === "passed" && input.status !== "keep" && input.status !== "discard") throw new Error("A passing run must be logged as keep or discard.");
      const current = journal(workDir).state;

      if (receipt.outcome === "passed" && cliBaseline(current).kind === "missing" && (input.status !== "keep" || input.metric <= 0)) throw new Error("The first passing run must establish a positive kept baseline.");

      const args = {
        ...input,
        asi: {
          ...input.asi,
          cli_operation_id: receipt.id,
          cli_command: receipt.command,
          cli_outcome: receipt.outcome,
        },
      };

      ctx.onLogStarting = (run) => {
        state.pending = { phase: "logging", receipt, run };
        writeCliState(state);
      };

      message = await logExperiment(ctx, args);
    } else {
      throw new Error("Invalid action arguments. Use schema.");
    }

    console.log(JSON.stringify({ ok: process.exitCode === undefined || process.exitCode === 0, message }));
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    release();
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
