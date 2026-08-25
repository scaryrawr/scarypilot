import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  autoresearchJsonlPath,
  autoresearchConfigPath,
  autoresearchRuntimePath,
  ensureParentDir,
  readConfig,
  readMaxIterations,
  resolveWorkDir,
  validateWorkDir,
} from "../src/paths.ts";

function mkTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "autoresearch-test-"));
}

function writeConfig(dir: string, value: unknown): void {
  const configPath = autoresearchConfigPath(dir);
  ensureParentDir(configPath);
  writeFileSync(configPath, JSON.stringify(value));
}

describe("readConfig", () => {
  it("returns empty object when no config file", () => {
    const dir = mkTmp();
    try {
      expect(readConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("parses a valid config", () => {
    const dir = mkTmp();
    try {
      writeConfig(dir, { workingDir: "src", maxIterations: 10 });
      expect(readConfig(dir)).toEqual({ workingDir: "src", maxIterations: 10 });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns empty object on malformed JSON", () => {
    const dir = mkTmp();
    try {
      const configPath = autoresearchConfigPath(dir);
      ensureParentDir(configPath);
      writeFileSync(configPath, "{ not json");
      expect(readConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("readMaxIterations", () => {
  it("returns null when not set", () => {
    const dir = mkTmp();
    try {
      expect(readMaxIterations(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it("returns floored positive integer", () => {
    const dir = mkTmp();
    try {
      writeConfig(dir, { maxIterations: 3.9 });
      expect(readMaxIterations(dir)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it("returns null for non-positive values", () => {
    const dir = mkTmp();
    try {
      writeConfig(dir, { maxIterations: 0 });
      expect(readMaxIterations(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("resolveWorkDir", () => {
  it("returns cwd when no workingDir set", () => {
    const dir = mkTmp();
    try {
      expect(resolveWorkDir(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("resolves relative workingDir against cwd", () => {
    const dir = mkTmp();
    try {
      writeConfig(dir, { workingDir: "sub" });
      expect(resolveWorkDir(dir)).toBe(path.resolve(dir, "sub"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns absolute workingDir as-is", () => {
    const dir = mkTmp();
    const target = mkTmp();
    try {
      writeConfig(dir, { workingDir: target });
      expect(resolveWorkDir(dir)).toBe(target);
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(target, { recursive: true });
    }
  });
});

describe("validateWorkDir", () => {
  it("returns null when workingDir is the cwd", () => {
    const dir = mkTmp();
    try {
      expect(validateWorkDir(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns error when workingDir does not exist", () => {
    const dir = mkTmp();
    try {
      writeConfig(dir, { workingDir: "/definitely/not/here/x123" });
      expect(validateWorkDir(dir)).toMatch(/does not exist/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns null when workingDir is a real directory", () => {
    const dir = mkTmp();
    const sub = path.join(dir, "sub");
    mkdirSync(sub);
    try {
      writeConfig(dir, { workingDir: "sub" });
      expect(validateWorkDir(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("session layout", () => {
  it("uses .auto for a new session", () => {
    const dir = mkTmp();
    try {
      expect(autoresearchJsonlPath(dir)).toBe(path.join(dir, ".auto", "log.jsonl"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to a legacy flat session", () => {
    const dir = mkTmp();
    try {
      const legacy = path.join(dir, "autoresearch.jsonl");
      writeFileSync(legacy, "");
      expect(autoresearchJsonlPath(dir)).toBe(legacy);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("keeps a legacy log active when the internal runtime sidecar is current", () => {
    const dir = mkTmp();
    try {
      const legacy = path.join(dir, "autoresearch.jsonl");
      writeFileSync(legacy, "");
      const runtimePath = autoresearchRuntimePath(dir);
      ensureParentDir(runtimePath);
      writeFileSync(runtimePath, "{}");
      expect(autoresearchJsonlPath(dir)).toBe(legacy);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("prefers .auto consistently when both layouts exist", () => {
    const dir = mkTmp();
    try {
      writeFileSync(path.join(dir, "autoresearch.jsonl"), "");
      mkdirSync(path.join(dir, ".auto"));
      writeFileSync(path.join(dir, ".auto", "prompt.md"), "");
      expect(autoresearchJsonlPath(dir)).toBe(path.join(dir, ".auto", "log.jsonl"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
