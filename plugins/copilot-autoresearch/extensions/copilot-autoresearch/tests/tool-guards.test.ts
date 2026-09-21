import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolInvocation } from "@github/copilot-sdk";
import { createCwdRef } from "../src/extension-context.ts";
import { autoresearchConfigPath, autoresearchJsonlPath, ensureParentDir } from "../src/paths.ts";
import { defaultRuntimeState, restoredMode } from "../src/state.ts";
import { createInitTool } from "../src/tools-init.ts";
import { createLogTool } from "../src/tools-log.ts";
import { createRunTool } from "../src/tools-run.ts";

const invocation: ToolInvocation = {
  sessionId: "test",
  toolCallId: "test",
  toolName: "test",
  arguments: {},
};

function mkTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "autoresearch-tool-test-"));
}

describe("tool mode guards", () => {
  it("rejects all experiment tools while autoresearch mode is off", async () => {
    const cwd = mkTmp();
    const runtime = defaultRuntimeState();
    const cwdRef = createCwdRef(cwd);

    try {
      const init = createInitTool({ cwdRef, runtime, log: () => {} });
      const run = createRunTool({ cwdRef, runtime, log: () => {} });
      const log = createLogTool({ cwdRef, runtime, log: () => {}, onLogged: () => {} });

      if (!init.handler || !run.handler || !log.handler) {
        throw new Error("autoresearch tools must define handlers");
      }

      const results = await Promise.all([
        init.handler({ name: "test", metric_name: "time" }, invocation),
        run.handler({ command: "true" }, invocation),
        log.handler(
          {
            commit: "0000000",
            metric: 1,
            status: "keep",
            description: "test",
            asi: { hypothesis: "test" },
          },
          invocation,
        ),
      ]);

      for (const result of results) {
        expect(result).toContain("Autoresearch mode is off");
      }
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it("blocks a run before spawning once maxIterations is exhausted", async () => {
    const cwd = mkTmp();
    const runtime = defaultRuntimeState();
    runtime.autoresearchMode = true;

    try {
      const configPath = autoresearchConfigPath(cwd);
      ensureParentDir(configPath);
      writeFileSync(configPath, JSON.stringify({ maxIterations: 1 }));
      writeFileSync(
        autoresearchJsonlPath(cwd),
        [
          JSON.stringify({
            type: "config",
            name: "test",
            metricName: "time",
            metricUnit: "ms",
            bestDirection: "lower",
          }),
          JSON.stringify({
            run: 1,
            commit: "0000000",
            metric: 10,
            metrics: {},
            status: "keep",
            description: "baseline",
            segment: 0,
          }),
        ].join("\n"),
      );

      const tool = createRunTool({
        cwdRef: createCwdRef(cwd),
        runtime,
        log: () => {},
      });

      if (!tool.handler) throw new Error("run_experiment must define a handler");

      const result = await tool.handler({ command: "exit 99" }, invocation);

      expect(result).toContain("Maximum experiments reached (1)");
      expect(runtime.autoresearchMode).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });
});

describe("log_experiment revisits_run", () => {
  it("renders a badge and next-step nudge for a valid earlier run", async () => {
    const cwd = mkTmp();
    const runtime = defaultRuntimeState();
    runtime.autoresearchMode = true;

    try {
      const tool = createLogTool({
        cwdRef: createCwdRef(cwd),
        runtime,
        log: () => {},
        onLogged: () => {},
      });

      if (!tool.handler) throw new Error("log_experiment must define a handler");

      await tool.handler(
        {
          commit: "0000000",
          metric: 10,
          status: "discard",
          description: "first attempt",
          asi: { hypothesis: "test" },
        },
        invocation,
      );

      const result = await tool.handler(
        {
          commit: "0000000",
          metric: 9,
          status: "discard",
          description: "retry after assumption changed",
          asi: { hypothesis: "test", revisits_run: 1 },
        },
        invocation,
      );

      expect(result).toContain("↻ Revisiting #1");
      expect(result).toContain("consider whether this result invalidates a previous discard");
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it("rejects revisit references that do not identify an earlier run", async () => {
    const cwd = mkTmp();
    const runtime = defaultRuntimeState();
    runtime.autoresearchMode = true;

    try {
      const tool = createLogTool({
        cwdRef: createCwdRef(cwd),
        runtime,
        log: () => {},
        onLogged: () => {},
      });

      if (!tool.handler) throw new Error("log_experiment must define a handler");

      for (const revisitsRun of [0, 1, 1.5, "1"]) {
        const result = await tool.handler(
          {
            commit: "0000000",
            metric: 1,
            status: "discard",
            description: "invalid revisit",
            asi: { hypothesis: "test", revisits_run: revisitsRun },
          },
          invocation,
        );

        expect(result).toContain(
          "asi.revisits_run must be a positive integer referencing an earlier run",
        );
      }
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it("rejects a missing run number even when earlier entries exist", async () => {
    const cwd = mkTmp();
    const runtime = defaultRuntimeState();
    runtime.autoresearchMode = true;

    try {
      const logPath = autoresearchJsonlPath(cwd);
      ensureParentDir(logPath);
      writeFileSync(
        logPath,
        JSON.stringify({
          run: 99,
          commit: "0000000",
          metric: 10,
          metrics: {},
          status: "discard",
          description: "non-contiguous imported run",
          segment: 0,
        }),
      );

      const tool = createLogTool({
        cwdRef: createCwdRef(cwd),
        runtime,
        log: () => {},
        onLogged: () => {},
      });

      if (!tool.handler) throw new Error("log_experiment must define a handler");

      const result = await tool.handler(
        {
          commit: "0000000",
          metric: 9,
          status: "discard",
          description: "missing referenced run",
          asi: { hypothesis: "test", revisits_run: 1 },
        },
        invocation,
      );

      expect(result).toContain(
        "asi.revisits_run must be a positive integer referencing an earlier run",
      );
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });
});

describe("restoredMode", () => {
  it("honors explicit persisted decisions", () => {
    expect(restoredMode(false, true, false)).toBe(false);
    expect(restoredMode(true, false, true)).toBe(true);
  });

  it("only infers activation for a log in the session working directory", () => {
    expect(restoredMode(undefined, true, false)).toBe(true);
    expect(restoredMode(undefined, true, true)).toBe(false);
    expect(restoredMode(undefined, false, false)).toBe(false);
  });
});
