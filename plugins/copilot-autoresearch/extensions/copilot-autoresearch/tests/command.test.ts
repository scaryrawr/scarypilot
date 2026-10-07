import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { CopilotSession } from "@github/copilot-sdk";
import { createAutoresearchCommand } from "../src/command.ts";
import { createCwdRef } from "../src/extension-context.ts";
import { defaultRuntimeState } from "../src/state.ts";

type TestSession = Pick<CopilotSession, "abort" | "log" | "send">;

function mkTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "autoresearch-command-test-"));
}

function commandContext(args: string) {
  return {
    sessionId: "session-a",
    command: `/autoresearch ${args}`,
    commandName: "autoresearch",
    args,
  };
}

describe("/autoresearch lifecycle commands", () => {
  for (const subcommand of ["off", "clear"]) {
    it(`${subcommand} aborts the active agent turn`, async () => {
      const cwd = mkTmp();
      let abortCount = 0;

      const session: TestSession = {
        abort: async () => {
          abortCount += 1;
        },
        log: async () => {},
        send: async () => "message-id",
      };

      const command = createAutoresearchCommand({
        cwdRef: createCwdRef(cwd),
        runtime: defaultRuntimeState(),
        getSession: () => session,
        resetAutoResume: () => {},
      });

      try {
        await command.handler(commandContext(subcommand));
        expect(abortCount).toBe(1);
      } finally {
        rmSync(cwd, { recursive: true });
      }
    });
  }
});

describe("/autoresearch help and finalize", () => {
  function setup(cwd: string) {
    const logs: string[] = [];
    const sent: string[] = [];
    let aborts = 0;
    const session: TestSession = {
      abort: async () => {
        aborts += 1;
      },
      log: async (message: string) => {
        logs.push(message);
      },
      send: async (options) => {
        sent.push(typeof options === "string" ? options : options.prompt);
        return "message-id";
      },
    };
    const runtime = defaultRuntimeState();
    const command = createAutoresearchCommand({
      cwdRef: createCwdRef(cwd),
      runtime,
      getSession: () => session,
      resetAutoResume: () => {},
    });

    return { logs, sent, runtime, command, aborts: () => aborts };
  }

  for (const alias of ["help", "--help", "-h"]) {
    it(`${alias} shows usage without starting a session`, async () => {
      const cwd = mkTmp();
      const { logs, sent, runtime, command } = setup(cwd);

      try {
        await command.handler(commandContext(alias));
        expect(logs[0]).toContain("Usage: /autoresearch");
        expect(sent).toEqual([]);
        expect(runtime.autoresearchMode).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true });
      }
    });
  }

  it("finalize errors without logged experiments", async () => {
    const cwd = mkTmp();
    const { logs, sent, command } = setup(cwd);

    try {
      await command.handler(commandContext("finalize"));
      expect(logs[0]).toContain("No logged experiments");
      expect(sent).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it("finalize stops the loop and loads the finalize skill", async () => {
    const cwd = mkTmp();
    const { sent, runtime, command, aborts } = setup(cwd);

    try {
      mkdirSync(path.join(cwd, ".auto"));
      writeFileSync(
        path.join(cwd, ".auto", "log.jsonl"),
        [
          JSON.stringify({ type: "config", name: "t", metricName: "ms", metricUnit: "ms", bestDirection: "lower" }),
          JSON.stringify({ run: 1, commit: "abc", metric: 1, metrics: {}, status: "keep", description: "d", timestamp: 1, confidence: null }),
        ].join("\n") + "\n",
      );
      runtime.autoresearchMode = true;
      await command.handler(commandContext("finalize"));
      expect(runtime.autoresearchMode).toBe(false);
      expect(aborts()).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("autoresearch-finalize");
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });
});
