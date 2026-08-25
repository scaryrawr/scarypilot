import { mkdtempSync, rmSync } from "node:fs";
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
