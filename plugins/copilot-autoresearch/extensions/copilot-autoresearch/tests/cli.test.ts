import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readCliState, writeCliState } from "../src/cli-state.ts";
import { reconstructJsonlState, type JsonlEntry } from "../src/jsonl.ts";

const pluginRoot = fileURLToPath(new URL("../../..", import.meta.url));
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "autoresearch CLI "));
  roots.push(root);
  const installed = path.join(root, "installed plugin with spaces");
  const workspace = path.join(root, "workspace with spaces");
  const cli = path.join(installed, "scripts", "autoresearch.mjs");
  mkdirSync(path.join(installed, "scripts"), { recursive: true });
  cpSync(path.join(pluginRoot, "scripts", "autoresearch.mjs"), cli);
  cpSync(
    path.join(pluginRoot, "extensions", "copilot-autoresearch", "dist"),
    path.join(installed, "extensions", "copilot-autoresearch", "dist"),
    { recursive: true },
  );
  mkdirSync(path.join(workspace, ".auto"), { recursive: true });
  writeFileSync(path.join(workspace, ".auto", "measure.sh"), "printf 'METRIC time=10\\nMETRIC memory_mb=4\\n'\n");

  function invoke(
    action: string,
    input?: JsonlEntry,
    flags: string[] = [],
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    return spawnSync(process.execPath, [
      cli, action, "--workspace", workspace, ...flags,
      ...(input === undefined ? [] : ["--json", JSON.stringify(input)]),
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, cwd: root, env: environment });
  }

  function init() {
    const result = invoke("init", { name: "fixture", metric_name: "time", metric_unit: "ms" }, ["--git", "manual"]);
    expect(result.status, result.stderr).toBe(0);
  }

  function run(flags: string[] = [], extra = {}) {
    return invoke("run", { command: "bash .auto/measure.sh", ...extra }, flags);
  }

  function log(extra = {}) {
    return invoke("log", {
      commit: "0000000", metric: 10, status: "keep", description: "fixture baseline",
      metrics: { memory_mb: 4 }, asi: { hypothesis: "fixture" }, ...extra,
    });
  }

  return { root, installed, workspace, cli, invoke, init, run, log };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitFixture(root: string) {
  const bin = path.join(root, "fixture-bin");
  const mutations = path.join(root, "git-mutations");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), `#!/usr/bin/env bash
case "$*" in
  *"rev-parse --is-inside-work-tree") printf 'true\\n'; exit 0;;
  *"ls-files --cached -z -- .auto/cli"*)
    if [ "$FIXTURE_TRACKED" = yes ]; then printf '.auto/cli.json\\0'; fi
    exit 0;;
  *"check-ignore --no-index --stdin -z")
    if [ "$FIXTURE_IGNORED" = partial ]; then printf '.auto/cli.json\\0'; exit 0; fi
    if [ "$FIXTURE_IGNORED" != yes ]; then exit 1; fi
    cat
    exit 0;;
  *) printf '%s\\n' "$*" >> "$FIXTURE_MUTATIONS"; printf 'fixture git rejection\\n' >&2; exit 9;;
esac
`, { mode: 0o755 });

  return {
    mutations,
    environment: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FIXTURE_IGNORED: "yes",
      FIXTURE_TRACKED: "no",
      FIXTURE_MUTATIONS: mutations,
    },
  };
}

describe("installed experiment CLI", () => {
  it("initializes automatic mode with real Git and ignored, untracked control files", () => {
    const f = fixture();

    const environment = {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(f.root, "unused-global-gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    };

    const repository = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", f.workspace], {
      encoding: "utf8", cwd: f.root, env: environment,
    });

    expect(repository.status, repository.stderr).toBe(0);
    const input = { name: "fixture", metric_name: "time" };
    const rejected = f.invoke("init", input, ["--git", "automatic"], environment);
    expect(rejected.status, rejected.stderr).toBe(1);
    expect(readCliState(f.workspace)).toBeNull();
    writeFileSync(path.join(f.workspace, ".gitignore"), ".auto/cli*\n");
    const initialized = f.invoke("init", input, ["--git", "automatic"], environment);
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(readCliState(f.workspace)?.git).toBe("automatic");
    expect(f.invoke("status", undefined, [], environment).status).toBe(0);
  });

  it("initializes, runs, logs and reads the journal across independent Node processes without SDK/source/dependencies", () => {
    const f = fixture();
    expect(existsSync(path.join(f.installed, "node_modules"))).toBe(false);
    expect(existsSync(path.join(f.installed, "extensions", "copilot-autoresearch", "src"))).toBe(false);
    f.init();
    expect(f.run(["--baseline"]).status).toBe(0);
    const receipt = readCliState(f.workspace);
    expect(receipt?.pending?.phase).toBe("completed");
    expect(receipt?.lastRunDurationSeconds).toBeTypeOf("number");
    expect(existsSync(path.join(f.workspace, ".auto", "runtime"))).toBe(false);
    expect(f.log().status).toBe(0);
    expect(f.log().status).toBe(1);
    const status = f.invoke("status");

    const StatusSchema = Type.Object({
      ok: Type.Literal(true), baseline: Type.Number(), totalRuns: Type.Number(),
      journalChanged: Type.Boolean(),
    });

    const parsed: unknown = JSON.parse(status.stdout);

    if (!Value.Check(StatusSchema, parsed)) throw new Error(status.stdout);
    expect(parsed.baseline).toBe(10);
    expect(parsed.totalRuns).toBe(1);
    expect(parsed.journalChanged).toBe(false);
    const results = reconstructJsonlState(readFileSync(path.join(f.workspace, ".auto", "log.jsonl"), "utf8")).results;
    expect(results[0].asi).toMatchObject({
      hypothesis: "fixture", cli_command: "bash .auto/measure.sh", cli_outcome: "passed",
    });
    expect(readCliState(f.workspace)?.pending).toBeNull();
  });

  it("requires explicit setup, a Git policy, a baseline and one log per run", () => {
    const f = fixture();
    expect(f.run().stderr).toContain("CLI mode is off");
    expect(f.log().status).toBe(1);
    expect(f.invoke("init", { name: "fixture", metric_name: "time" }).stderr).toContain("--git");
    f.init();
    expect(f.run().stderr).toContain("No baseline");
    expect(f.log().stderr).toContain("No completed run");
    expect(f.run(["--baseline"]).status).toBe(0);
    expect(f.run(["--baseline"]).stderr).toContain("pending");
    expect(f.log({ status: "discard" }).stderr).toContain("positive kept baseline");
    expect(f.log().status).toBe(0);
    expect(f.run().status).toBe(0);
    expect(f.log({ metric: 9, description: "candidate" }).status).toBe(0);
  });

  it("enforces benchmark, secondary metric and iteration gates before executing", () => {
    const f = fixture();
    writeFileSync(path.join(f.workspace, ".auto", "config.json"), JSON.stringify({ maxIterations: 1 }));
    f.init();
    const bypass = f.invoke("run", { command: "printf bypass > bypass" }, ["--baseline"]);
    expect(bypass.stderr).toContain("you must run it");
    expect(existsSync(path.join(f.workspace, "bypass"))).toBe(false);
    expect(readCliState(f.workspace)?.pending).toBeNull();
    expect(f.run(["--baseline"]).status).toBe(0);
    expect(f.log().status).toBe(0);
    expect(f.run().status).toBe(1);
    expect(readCliState(f.workspace)?.pending).toBeNull();
    f.init();
    expect(f.run(["--baseline"]).status).toBe(0);
    expect(f.log().status).toBe(0);
    writeFileSync(path.join(f.workspace, ".auto", "config.json"), JSON.stringify({ maxIterations: 5 }));
    f.init();
    expect(f.run(["--baseline"]).status).toBe(0);
    expect(f.log().status).toBe(0);
    expect(f.run().status).toBe(0);
    expect(f.log({ metrics: {} }).stderr).toContain("Missing secondary metrics");
    expect(f.log({ metrics: { memory_mb: 4, extra: 2 } }).stderr).toContain("not previously tracked");
    expect(f.log({ metrics: { memory_mb: 4, extra: 2 }, force: true }).status).toBe(0);
  });

  it("persists failed checks across processes and never keeps them", () => {
    const f = fixture();
    writeFileSync(path.join(f.workspace, ".auto", "checks.sh"), "printf checked > checked\nexit 1\n");
    f.init();
    expect(f.run(["--baseline"]).status).toBe(2);
    expect(existsSync(path.join(f.workspace, "checked"))).toBe(true);
    expect(readCliState(f.workspace)?.lastRunChecks?.pass).toBe(false);
    expect(f.log().stderr).toContain("Failed checks");
    expect(f.log({ status: "checks_failed" }).status).toBe(0);
    expect(f.run().stderr).toContain("No baseline");
  });

  it("skips checks after a failed benchmark and forbids a successful log", () => {
    const f = fixture();
    writeFileSync(path.join(f.workspace, ".auto", "measure.sh"), "exit 7\n");
    writeFileSync(path.join(f.workspace, ".auto", "checks.sh"), "printf bad > checks-ran\n");
    f.init();
    expect(f.run(["--baseline"]).status).toBe(2);
    expect(existsSync(path.join(f.workspace, "checks-ran"))).toBe(false);
    expect(f.log().stderr).toContain("must be logged as crash");
    expect(f.log({ status: "crash", metric: 0 }).status).toBe(0);
  });

  for (const stage of ["benchmark", "checks"]) {
    it(`times out ${stage}, preserves the gate and bounds returned output`, () => {
      const f = fixture();
      writeFileSync(path.join(f.workspace, ".auto", stage === "checks" ? "checks.sh" : "measure.sh"),
        "printf started > started\nsleep 30\nprintf bad > late\n");
      f.init();
      const result = f.run(["--baseline"], { timeout_seconds: 0.1, checks_timeout_seconds: 0.1 });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toContain("TIMEOUT");
      expect(existsSync(path.join(f.workspace, "late"))).toBe(false);
      expect(f.log().status).toBe(1);
      expect(f.log({ status: stage === "checks" ? "checks_failed" : "crash", metric: stage === "checks" ? 10 : 0 }).status).toBe(0);
    });
  }

  it("rejects malformed configuration and workspace escapes without touching the target", () => {
    const f = fixture();
    writeFileSync(path.join(f.workspace, ".auto", "config.json"), "{bad");
    expect(f.invoke("init", { name: "fixture", metric_name: "time" }, ["--git", "manual"]).status).toBe(1);
    writeFileSync(path.join(f.workspace, ".auto", "config.json"), JSON.stringify({ workingDir: ".." }));
    expect(f.run().stderr).toContain("must stay within");
    expect(existsSync(path.join(f.root, ".auto"))).toBe(false);
    writeFileSync(path.join(f.workspace, ".auto", "config.json"), JSON.stringify({ maxIterations: -1 }));
    expect(f.run().stderr).toContain("Invalid experiment config");
  });

  it("uses the configured workdir and rejects invalid CLI timeouts before execution", () => {
    const f = fixture();
    const nested = path.join(f.workspace, "nested project");
    mkdirSync(path.join(nested, ".auto"), { recursive: true });
    writeFileSync(path.join(nested, ".auto", "measure.sh"), "printf 'METRIC time=3\\n'\n");
    writeFileSync(path.join(f.workspace, ".auto", "config.json"), JSON.stringify({ workingDir: "nested project", maxIterations: 2 }));
    f.init();
    expect(existsSync(path.join(f.workspace, ".auto", "cli.json"))).toBe(false);
    expect(readCliState(nested)?.workspace).toBe(realpathSync(f.workspace));

    for (const timeout of [0, -1, 86401]) {
      expect(f.run(["--baseline"], { timeout_seconds: timeout }).stderr).toContain("Invalid action JSON");
    }

    expect(f.run(["--baseline"]).status).toBe(0);
    expect(f.log({ metric: 3, metrics: {} }).status).toBe(0);
    expect(reconstructJsonlState(readFileSync(path.join(nested, ".auto", "log.jsonl"), "utf8")).results[0].metric).toBe(3);
  });

  it("recovers a stale writer lock but never removes one owned by a live process", () => {
    const f = fixture();
    f.init();
    const lock = path.join(f.workspace, ".auto", "cli.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    expect(f.invoke("recover", { confirm_stopped: true }).stderr).toContain("still alive");
    expect(existsSync(lock)).toBe(true);
    writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
    expect(f.invoke("recover", { confirm_stopped: true }).status).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("fails closed on journal divergence and repairs a missing final newline on explicit re-init", () => {
    const f = fixture();
    f.init();
    const file = path.join(f.workspace, ".auto", "log.jsonl");
    const first = readFileSync(file, "utf8");
    writeFileSync(file, first.trimEnd());
    expect(f.run(["--baseline"]).stderr).toContain("Journal changed");
    f.init();
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    expect(f.run(["--baseline"]).status).toBe(0);
    expect(f.log().status).toBe(0);
    writeFileSync(file, readFileSync(file, "utf8") + "{\"partial\":");
    expect(f.invoke("status").status).toBe(1);
    expect(f.invoke("recover", { confirm_stopped: true }).status).toBe(1);
  });

  it("recovers interrupted receipts and append-before-exit logs without duplicates", () => {
    const f = fixture();
    f.init();
    const saved = readCliState(f.workspace);

    if (!saved) throw new Error("Missing initialized state");
    saved.pending = { phase: "running", id: "interrupted", command: "fixture command" };
    writeCliState(saved);
    expect(f.run(["--baseline"]).stderr).toContain("pending");
    expect(f.invoke("recover", { confirm_stopped: false }).status).toBe(1);
    expect(f.invoke("recover", { confirm_stopped: true }).status).toBe(0);
    expect(f.log().stderr).toContain("must be logged as crash");
    expect(f.log({ status: "crash", metric: 0 }).status).toBe(0);
    f.init();
    expect(f.run(["--baseline"]).status).toBe(0);
    const completed = readCliState(f.workspace);

    if (completed?.pending?.phase !== "completed") throw new Error("Missing completed receipt");
    const receipt = completed.pending;
    const previousHash = completed.journalHash;
    expect(f.log().status).toBe(0);
    completed.pending = {
      phase: "logging", receipt, run: 2,
    };
    completed.journalHash = previousHash;
    writeCliState(completed);
    expect(f.invoke("recover", { confirm_stopped: true }).stdout).toContain("will not be appended again");
    expect(f.log().status).toBe(1);
    expect(reconstructJsonlState(readFileSync(path.join(f.workspace, ".auto", "log.jsonl"), "utf8")).results).toHaveLength(2);
  });

  it("keeps check output bounded and leaves manual-policy files untouched", () => {
    const f = fixture();
    writeFileSync(path.join(f.workspace, ".auto", "checks.sh"),
      "for i in {1..4000}; do printf '%0100d\\n' 0; done\nexit 1\n");
    writeFileSync(path.join(f.workspace, "caller-owned"), "unchanged");
    f.init();
    const result = f.run(["--baseline"]);
    expect(result.status).toBe(2);
    expect(result.stdout.length).toBeLessThan(12_000);
    expect(f.log({ status: "checks_failed" }).status).toBe(0);
    expect(readFileSync(path.join(f.workspace, "caller-owned"), "utf8")).toBe("unchanged");
  });

  it("bounds multibyte benchmark output and cleans its durable overflow receipt after re-init", () => {
    const f = fixture();
    writeFileSync(path.join(f.workspace, ".auto", "measure.sh"),
      "for i in {1..4000}; do printf '🧪'; done\nprintf '\\nMETRIC time=10\\n'\n");
    f.init();
    const result = f.run(["--baseline"]);
    expect(result.status).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(6000);
    const output = readCliState(f.workspace)?.lastOutputPath;

    if (!output) throw new Error("Missing overflow receipt");
    expect(existsSync(output)).toBe(true);
    expect(f.log().status).toBe(0);
    f.init();
    expect(readCliState(f.workspace)?.lastOutputPath).toBe(output);
    writeFileSync(path.join(f.workspace, ".auto", "measure.sh"), "printf 'METRIC time=10\\n'\n");
    expect(f.run(["--baseline"]).status).toBe(0);
    expect(existsSync(output)).toBe(false);
    expect(f.log().status).toBe(0);
  });

  it("rejects persisted output pointers outside the executor's temporary logs", () => {
    const f = fixture();
    f.init();
    const saved = readCliState(f.workspace);

    if (!saved) throw new Error("Missing initialized state");
    const target = path.join(f.root, "caller-owned");
    writeFileSync(target, "untouched");
    saved.lastOutputPath = target;
    writeCliState(saved);
    expect(f.run(["--baseline"]).stderr).toContain("CLI output receipt");
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  for (const deletion of ["none", "missing", "parent", "replaced", "symlink", "legacy-existing", "legacy-parent"]) {
    it.skipIf(process.platform === "win32" && deletion === "symlink")(`keeps fresh-process state usable across temp changes with ${deletion} output deletion`, () => {
      const f = fixture();
      const tempA = path.join(f.root, "temp A");
      const tempB = path.join(f.root, "temp B");
      mkdirSync(tempA);
      mkdirSync(tempB);
      const envA = { ...process.env, TMPDIR: tempA, TMP: tempA, TEMP: tempA };
      const envB = { ...process.env, TMPDIR: tempB, TMP: tempB, TEMP: tempB };
      const initArgs = { name: "fixture", metric_name: "time" };
      const runArgs = { command: "bash .auto/measure.sh" };
      const logArgs = { commit: "0000000", metric: 10, status: "keep", description: "fixture" };
      writeFileSync(path.join(f.workspace, ".auto", "measure.sh"),
        "for i in {1..20}; do echo line; done\necho METRIC time=10\n");
      expect(f.invoke("init", initArgs, ["--git", "manual"], envA).status).toBe(0);
      expect(f.invoke("run", runArgs, ["--baseline"], envA).status).toBe(0);
      expect(f.invoke("log", logArgs, [], envA).status).toBe(0);
      const persisted: unknown = JSON.parse(readFileSync(path.join(f.workspace, ".auto", "cli.json"), "utf8"));
      const OutputPathSchema = Type.Object({ lastOutputPath: Type.String() });

      if (!Value.Check(OutputPathSchema, persisted)) throw new Error("Missing overflow receipt");
      const output = persisted.lastOutputPath;

      if (!output) throw new Error("Missing overflow receipt");
      const sentry = path.join(tempB, path.basename(output));
      writeFileSync(sentry, "sentry");

      if (deletion === "parent" || deletion === "legacy-parent" || deletion === "legacy-existing") {
        if (deletion !== "parent") {
          const legacy: unknown = JSON.parse(readFileSync(path.join(f.workspace, ".auto", "cli.json"), "utf8"));
          const LegacySchema = Type.Object({ lastOutputIdentity: Type.Optional(Type.Unknown()) });

          if (!Value.Check(LegacySchema, legacy)) throw new Error("Invalid fixture state");
          delete legacy.lastOutputIdentity;
          writeFileSync(path.join(f.workspace, ".auto", "cli.json"), JSON.stringify(legacy));
        }

        if (deletion !== "legacy-existing") rmSync(tempA, { recursive: true });
      } else if (deletion === "replaced") {
        rmSync(output);
        writeFileSync(output, "replacement sentry");
      } else if (deletion === "symlink") {
        rmSync(output);
        symlinkSync(sentry, output);
      } else if (deletion === "missing") {
        rmSync(output);
      }

      const status = f.invoke("status", undefined, [], envB);
      expect(status.status, status.stderr).toBe(0);
      expect(f.invoke("recover", { confirm_stopped: true }, [], envB).status).toBe(0);
      expect(f.invoke("init", initArgs, ["--git", "manual"], envB).status).toBe(0);
      writeFileSync(path.join(f.workspace, ".auto", "measure.sh"), "echo METRIC time=10\n");
      expect(f.invoke("run", runArgs, ["--baseline"], envB).status).toBe(0);
      expect(f.invoke("log", logArgs, [], envB).status).toBe(0);
      expect(readFileSync(sentry, "utf8")).toBe("sentry");

      if (deletion === "none") expect(existsSync(output)).toBe(false);
      else expect(status.stderr).toContain("Dropped stale output");

      if (deletion === "replaced") expect(readFileSync(output, "utf8")).toBe("replacement sentry");

      if (deletion === "symlink") expect(lstatSync(output).isSymbolicLink()).toBe(true);

      if (deletion === "legacy-existing") expect(existsSync(output)).toBe(true);

      writeFileSync(path.join(f.workspace, ".auto", "measure.sh"),
        "for i in {1..20}; do echo line; done\necho METRIC time=10\n");
      expect(f.invoke("run", runArgs, [], envB).status).toBe(0);
      expect(f.invoke("log", logArgs, [], envB).status).toBe(0);
      const newOutput = readCliState(f.workspace)?.lastOutputPath;

      if (!newOutput) throw new Error("Missing new overflow receipt");
      writeFileSync(path.join(f.workspace, ".auto", "measure.sh"), "echo METRIC time=10\n");
      expect(f.invoke("run", runArgs, [], envB).status).toBe(0);
      expect(existsSync(newOutput)).toBe(false);
      expect(readFileSync(sentry, "utf8")).toBe("sentry");
    });
  }

  it("rejects a forged log-shaped pointer that does not match the recorded file identity", () => {
    const f = fixture();
    const temp = path.join(f.root, "temp");
    mkdirSync(temp);
    const environment = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
    expect(f.invoke("init", { name: "fixture", metric_name: "time" }, ["--git", "manual"], environment).status).toBe(0);
    writeFileSync(path.join(f.workspace, ".auto", "measure.sh"),
      "for i in {1..20}; do echo line; done\necho METRIC time=10\n");
    expect(f.invoke("run", { command: "bash .auto/measure.sh" }, ["--baseline"], environment).status).toBe(0);
    const saved = readCliState(f.workspace);

    if (!saved?.lastOutputIdentity) throw new Error("Missing output identity");
    const sentry = path.join(f.root, "copilot-autoresearch-deadbeefdeadbeef.log");
    writeFileSync(sentry, "sentry");
    saved.lastOutputPath = sentry;
    writeCliState(saved);
    const result = f.invoke("status", undefined, [], environment);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("identity does not match");
    expect(readFileSync(sentry, "utf8")).toBe("sentry");
  });

  for (const unsafe of ["not ignored", "partly ignored", "tracked"]) {
    it.skipIf(process.platform === "win32")(`rejects automatic init/log when control files are ${unsafe} before Git mutation`, () => {
      const f = fixture();
      const git = gitFixture(f.root);

      const unsafeEnv = {
        ...git.environment,
        FIXTURE_IGNORED: unsafe === "not ignored" ? "no" : unsafe === "partly ignored" ? "partial" : "yes",
        FIXTURE_TRACKED: unsafe === "tracked" ? "yes" : "no",
      };

      const initArgs = { name: "fixture", metric_name: "time" };
      const rejected = f.invoke("init", initArgs, ["--git", "automatic"], unsafeEnv);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(".auto/cli*");
      expect(existsSync(git.mutations)).toBe(false);
      expect(f.invoke("init", initArgs, ["--git", "manual"], unsafeEnv).status).toBe(0);
      expect(f.invoke("run", { command: "bash .auto/measure.sh" }, ["--baseline"], unsafeEnv).status).toBe(0);
      expect(f.invoke("log", {
        commit: "0000000", metric: 10, status: "keep", description: "manual fixture",
      }, [], unsafeEnv).status).toBe(0);
      expect(existsSync(git.mutations)).toBe(false);
      expect(f.invoke("init", initArgs, ["--git", "automatic"], git.environment).status).toBe(0);
      expect(f.invoke("run", { command: "bash .auto/measure.sh" }, ["--baseline"], git.environment).status).toBe(0);

      const blockedLog = f.invoke("log", {
        commit: "0000000", metric: 10, status: "keep", description: "fixture",
      }, [], unsafeEnv);

      expect(blockedLog.status).toBe(1);
      expect(blockedLog.stderr).toContain(".auto/cli*");
      expect(existsSync(git.mutations)).toBe(false);
      expect(readCliState(f.workspace)?.pending?.phase).toBe("completed");
      expect(reconstructJsonlState(readFileSync(path.join(f.workspace, ".auto", "log.jsonl"), "utf8")).results).toHaveLength(1);
    });
  }

  it.skipIf(process.platform === "win32")("returns an error when automatic Git fails without recording a successful keep", () => {
    const f = fixture();
    const { environment } = gitFixture(f.root);
    expect(f.invoke("init", { name: "fixture", metric_name: "time" }, ["--git", "automatic"], environment).status).toBe(0);
    expect(f.invoke("run", { command: "bash .auto/measure.sh" }, ["--baseline"], environment).status).toBe(0);

    const result = f.invoke("log", {
      commit: "0000000", metric: 10, status: "keep", description: "fixture",
    }, [], environment);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git commit error");
    expect(reconstructJsonlState(readFileSync(path.join(f.workspace, ".auto", "log.jsonl"), "utf8")).results).toHaveLength(0);
    expect(readCliState(f.workspace)?.pending?.phase).toBe("logging");
  });

  for (const stage of ["benchmark", "checks"]) {
  it.skipIf(process.platform === "win32")(`cancels the owned ${stage} on a process signal and preserves its durable receipt`, async () => {
    const f = fixture();
    writeFileSync(path.join(f.workspace, ".auto", stage === "checks" ? "checks.sh" : "measure.sh"),
      "printf started > started\nsleep 30\nprintf bad > late\n");
    f.init();

    const child = spawn(process.execPath, [
      f.cli, "run", "--workspace", f.workspace, "--baseline",
      "--json", JSON.stringify({ command: "bash .auto/measure.sh", timeout_seconds: 5 }),
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });

    try {
      const deadline = Date.now() + 3000;

      while (!existsSync(path.join(f.workspace, "started"))) {
        if (Date.now() > deadline) throw new Error("Fixture command did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(f.invoke("run", { command: "true" }, ["--baseline"]).stderr).toContain("Cannot acquire");
      child.kill(stage === "checks" ? "SIGTERM" : "SIGINT");
      expect(await completion).toBe(130);
      expect(existsSync(path.join(f.workspace, "late"))).toBe(false);
      expect(readCliState(f.workspace)?.pending).toMatchObject({ phase: "completed", outcome: "aborted" });
      expect(f.log({ status: "crash", metric: 0 }).status).toBe(0);
    } finally {
      child.kill("SIGTERM");
      await completion;
    }
  });
  }
});
