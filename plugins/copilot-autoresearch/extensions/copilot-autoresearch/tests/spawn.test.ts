import { existsSync, rmSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runShellStreaming } from "../src/spawn.ts";

describe("runShellStreaming", () => {
  it("retains overflowing output in a temporary file", async () => {
    const result = await runShellStreaming(
      "printf 'line-1\\nline-2\\nline-3\\nline-4\\n'",
      { maxBytes: 12, maxLines: 2 },
    );
    try {
      expect(result.truncated).toBe(true);
      expect(result.tail).toContain("line-4");
      expect(result.fullOutputPath).toBeTruthy();
      expect(existsSync(result.fullOutputPath!)).toBe(true);
    } finally {
      if (result.fullOutputPath) rmSync(result.fullOutputPath, { force: true });
    }
  });

  it("bounds retained output on disk", async () => {
    const result = await runShellStreaming("printf '12345678901234567890'", {
      maxBytes: 4,
      maxLines: 1,
      maxOutputFileBytes: 10,
    });
    try {
      expect(result.fullOutputTruncated).toBe(true);
      expect(statSync(result.fullOutputPath!).size).toBe(10);
    } finally {
      if (result.fullOutputPath) rmSync(result.fullOutputPath, { force: true });
    }
  });
});
