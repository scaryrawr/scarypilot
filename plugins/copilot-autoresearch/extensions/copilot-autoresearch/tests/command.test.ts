import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CopilotSession } from "@github/copilot-sdk";
import { createAutoresearchCommand } from "../src/command.ts";
import { createCwdRef } from "../src/extension-context.ts";
import { defaultRuntimeState, loadPersistedRuntime } from "../src/state.ts";

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
  const configLine = JSON.stringify({
    type: "config", name: "t", metricName: "ms", metricUnit: "ms", bestDirection: "lower",
  });

  const log = [
    configLine,
    JSON.stringify({
      run: 1, commit: "abc", metric: 1, metrics: {}, status: "keep",
      description: "d", timestamp: 1, confidence: null,
    }),
    "",
  ].join("\n");

  function writeLog(file: string, content = log) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  function setup(cwd: string) {
    const logs: string[] = [];
    const levels: Array<string | undefined> = [];
    const sent: string[] = [];
    let aborts = 0;

    const session: TestSession = {
      abort: async () => {
        aborts += 1;
      },
      log: async (message, options) => {
        logs.push(message);
        levels.push(options?.level);
      },
      send: async (options) => {
        sent.push(typeof options === "string" ? options : options.prompt);

        return "message-id";
      },
    };

    const runtime = defaultRuntimeState();
    const resetAutoResume = vi.fn();

    const command = createAutoresearchCommand({
      cwdRef: createCwdRef(cwd),
      runtime,
      getSession: () => session,
      resetAutoResume,
    });

    return { logs, levels, sent, runtime, command, session, resetAutoResume, aborts: () => aborts };
  }

  for (const alias of ["", "help", "--help", "-h", " HELP "]) {
    it(`${JSON.stringify(alias)} shows usage without changing an active session`, async () => {
      const cwd = mkTmp();
      const { logs, sent, runtime, command, resetAutoResume, aborts } = setup(cwd);
      runtime.autoresearchMode = true;

      try {
        await command.handler(commandContext(alias));
        expect(logs[0]).toContain("Usage: /autoresearch");
        expect(logs[0]).toContain("finalize");
        expect(sent).toEqual([]);
        expect(runtime.autoresearchMode).toBe(true);
        expect(aborts()).toBe(0);
        expect(resetAutoResume).not.toHaveBeenCalled();
        expect(existsSync(path.join(cwd, ".auto"))).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true });
      }
    });
  }

  for (const content of [undefined, "", `${configLine}\n`]) {
    it(`finalize rejects ${content === undefined ? "missing" : content === "" ? "empty" : "config-only"} logs`, async () => {
      const cwd = mkTmp();
      const { logs, levels, sent, runtime, command, aborts, resetAutoResume } = setup(cwd);
      runtime.autoresearchMode = true;

      try {
        if (content !== undefined) writeLog(path.join(cwd, ".auto", "log.jsonl"), content);
        await command.handler(commandContext("finalize"));
        expect(logs[0]).toContain("No logged experiments");
        expect(levels[0]).toBe("error");
        expect(sent).toEqual([]);
        expect(runtime.autoresearchMode).toBe(true);
        expect(aborts()).toBe(0);
        expect(resetAutoResume).not.toHaveBeenCalled();
      } finally {
        rmSync(cwd, { recursive: true });
      }
    });
  }

  it("finalize reports a log read failure instead of claiming there are no experiments", async () => {
    const cwd = mkTmp();
    const { logs, levels, sent, runtime, command, aborts } = setup(cwd);
    runtime.autoresearchMode = true;

    try {
      mkdirSync(path.join(cwd, ".auto", "log.jsonl"), { recursive: true });
      await command.handler(commandContext("finalize"));
      expect(logs[0]).toContain("Failed to read experiment log");
      expect(levels[0]).toBe("error");
      expect(sent).toEqual([]);
      expect(runtime.autoresearchMode).toBe(true);
      expect(aborts()).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  for (const layout of ["current", "legacy", "redirected"]) {
    it(`finalize stops the loop and selects the ${layout} session for the skill`, async () => {
      const cwd = mkTmp();
      const { sent, runtime, command, aborts, resetAutoResume } = setup(cwd);
      const workDir = layout === "redirected" ? path.join(cwd, "experiment") : cwd;

      const logFile = layout === "legacy"
        ? path.join(workDir, "autoresearch.jsonl")
        : path.join(workDir, ".auto", "log.jsonl");

      try {
        writeLog(logFile);

        if (layout === "redirected") {
          mkdirSync(path.join(cwd, ".auto"));
          writeFileSync(path.join(cwd, ".auto", "config.json"), JSON.stringify({ workingDir: "experiment" }));
        }

        runtime.autoresearchMode = true;
        runtime.lastRunChecks = { pass: true, output: "ok", durationSeconds: 1 };
        runtime.lastRunDurationSeconds = 1;
        await command.handler(commandContext("finalize"));
        expect(runtime.autoresearchMode).toBe(false);
        expect(runtime.lastRunChecks).toBeNull();
        expect(runtime.lastRunDurationSeconds).toBeNull();
        expect(resetAutoResume).toHaveBeenCalledOnce();
        expect(aborts()).toBe(1);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain("autoresearch-finalize");
        expect(sent[0]).toContain(JSON.stringify(workDir));
        expect(sent[0]).toContain(JSON.stringify(logFile));
        expect(readFileSync(logFile, "utf-8")).toBe(log);
        expect(loadPersistedRuntime(workDir, "session-a")).toEqual({
          autoresearchMode: false,
          lastRunChecks: null,
          lastRunDurationSeconds: null,
        });
      } finally {
        rmSync(cwd, { recursive: true });
      }
    });
  }

  it("finalize does not send the skill if abort fails", async () => {
    const cwd = mkTmp();
    const { logs, levels, sent, runtime, command, session } = setup(cwd);
    session.abort = async () => {
      throw new Error("abort unavailable");
    };

    try {
      writeLog(path.join(cwd, ".auto", "log.jsonl"));
      runtime.autoresearchMode = true;
      await command.handler(commandContext("finalize"));
      expect(runtime.autoresearchMode).toBe(false);
      expect(logs).toEqual([
        "Autoresearch mode changed, but the active turn could not be aborted: abort unavailable",
      ]);
      expect(levels).toEqual(["warning"]);
      expect(sent).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it("finalize waits for abort acknowledgement before sending the skill", async () => {
    const cwd = mkTmp();
    const { sent, command, session } = setup(cwd);
    let acknowledgeAbort!: () => void;
    let abortStarted!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { acknowledgeAbort = resolve; });
    const started = new Promise<void>((resolve) => { abortStarted = resolve; });
    session.abort = async () => {
      abortStarted();
      await acknowledgement;
    };

    try {
      writeLog(path.join(cwd, ".auto", "log.jsonl"));
      const handler = command.handler(commandContext("finalize"));
      await started;
      expect(sent).toEqual([]);
      acknowledgeAbort();
      await handler;
      expect(sent).toHaveLength(1);
    } finally {
      acknowledgeAbort();
      rmSync(cwd, { recursive: true });
    }
  });
});
