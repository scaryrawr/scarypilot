import { describe, expect, it } from "vitest";
import { truncateHookStdout } from "../src/hooks.ts";

const MARKER = "\n…[truncated: hook stdout exceeded 8KB]";

describe("truncateHookStdout", () => {
  it("returns input unchanged when within budget", () => {
    expect(truncateHookStdout("hello\nworld\n", 1024)).toBe("hello\nworld\n");
  });

  it("returns input unchanged at exactly the byte budget", () => {
    const text = "x".repeat(16);
    expect(truncateHookStdout(text, 16)).toBe(text);
  });

  it("truncates at the last newline within the kept window", () => {
    // 30 bytes total; budget 20 keeps "line1\nline2\nline3\n" (18 bytes ending at \n=17)
    const text = "line1\nline2\nline3\nline4_extra";
    const result = truncateHookStdout(text, 20);
    expect(result).toBe("line1\nline2\nline3\n" + MARKER);
  });

  it("falls back to UTF-8 boundary when no newline in kept window", () => {
    // Pure ASCII run with no newlines in the kept window
    const text = "abcdefghijklmnopqrstuvwxyz";
    const result = truncateHookStdout(text, 10);
    expect(result).toBe("abcdefghij" + MARKER);
  });

  it("does not split a multi-byte UTF-8 character at the cut", () => {
    // "héllo" — é is 0xC3 0xA9 (2 bytes). Budget 2 would land mid-character.
    const result = truncateHookStdout("héllo world no newline here", 2);
    // Either drops "h" alone or keeps "h" + complete "é"; must not contain U+FFFD
    expect(result).not.toContain("\uFFFD");
    expect(result.endsWith(MARKER)).toBe(true);
    // The kept prefix must round-trip cleanly through UTF-8
    const kept = result.slice(0, -MARKER.length);
    expect(Buffer.from(kept, "utf-8").toString("utf-8")).toBe(kept);
  });

  it("prefers newline boundary over UTF-8 boundary when both apply", () => {
    // "ab\ncdé" — é is multi-byte. Budget 4 keeps "ab\nc" (newline at index 2).
    const result = truncateHookStdout("ab\ncdéfghijk", 4);
    expect(result).toBe("ab\n" + MARKER);
  });
});
