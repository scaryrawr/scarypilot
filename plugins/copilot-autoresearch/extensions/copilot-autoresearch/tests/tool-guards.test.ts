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
