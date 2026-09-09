import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolInvocation } from "@github/copilot-sdk";
import { createCwdRef } from "../src/extension-context.ts";
import { defaultRuntimeState } from "../src/state.ts";
import { createLogTool } from "../src/tools-log.ts";

const invocation: ToolInvocation = {
  sessionId: "test",
  toolCallId: "test",
  toolName: "test",
  arguments: {},
};

function mkTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "autoresearch-tools-log-test-"));
}

describe("log_experiment revisits_run badge", () => {
  it("renders a revisiting badge when asi.revisits_run is a positive integer", async () => {
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

      const result = await tool.handler(
        {
          commit: "0000000",
          metric: 1,
          status: "discard",
          description: "retry after assumption changed",
          asi: { hypothesis: "test", revisits_run: 2 },
        },
        invocation,
      );

      expect(result).toContain("↻ Revisiting #2");
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it("omits the badge when revisits_run is absent, non-integer, or non-positive", async () => {
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

      const result = await tool.handler(
        {
          commit: "0000000",
          metric: 1,
          status: "keep",
          description: "new idea",
          asi: { hypothesis: "test" },
        },
        invocation,
      );

      expect(result).not.toContain("Revisiting");
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });
});
