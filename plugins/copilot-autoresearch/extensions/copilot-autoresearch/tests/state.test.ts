import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultRuntimeState,
  loadPersistedRuntime,
  savePersistedRuntime,
} from "../src/state.ts";
import { ensureParentDir } from "../src/paths.ts";

function mkTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "autoresearch-state-test-"));
}

describe("persisted runtime state", () => {
  it("isolates activation decisions by Copilot session", () => {
    const workDir = mkTmp();
    try {
      const sessionA = defaultRuntimeState();
      const sessionB = defaultRuntimeState();
      sessionA.autoresearchMode = true;
      sessionB.autoresearchMode = false;

      savePersistedRuntime(workDir, "session-a", sessionA);
      savePersistedRuntime(workDir, "session-b", sessionB);

      expect(loadPersistedRuntime(workDir, "session-a")?.autoresearchMode).toBe(true);
      expect(loadPersistedRuntime(workDir, "session-b")?.autoresearchMode).toBe(false);
      expect(loadPersistedRuntime(workDir, "session-c")).toBeNull();
    } finally {
      rmSync(workDir, { recursive: true });
    }
  });

  it("does not inherit the pre-fix shared runtime sidecar", () => {
    const workDir = mkTmp();
    try {
      const legacyRuntime = path.join(workDir, ".auto", "runtime.json");
      ensureParentDir(legacyRuntime);
      writeFileSync(legacyRuntime, JSON.stringify({ autoresearchMode: false }));

      expect(loadPersistedRuntime(workDir, "new-session")).toBeNull();
    } finally {
      rmSync(workDir, { recursive: true });
    }
  });
});
