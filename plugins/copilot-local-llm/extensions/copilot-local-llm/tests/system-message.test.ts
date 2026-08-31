import { describe, expect, it } from "vitest";
import { COMPACT_SYSTEM_MESSAGE, COMPACT_SYSTEM_MESSAGE_CONTENT } from "../src/system-message.ts";

describe("COMPACT_SYSTEM_MESSAGE", () => {
  it("replaces verbose generic guidance while preserving session-specific instructions", () => {
    expect(COMPACT_SYSTEM_MESSAGE).toEqual({
      mode: "customize",
      sections: {
        preamble: {
          action: "replace",
          content: COMPACT_SYSTEM_MESSAGE_CONTENT,
        },
        identity: { action: "remove" },
        tone: { action: "remove" },
        tool_efficiency: { action: "remove" },
        environment_context: { action: "preserve" },
        code_change_rules: { action: "remove" },
        guidelines: { action: "remove" },
        safety: { action: "preserve" },
        tool_instructions: {
          action: "replace",
          content: "Use the available tools to inspect, edit, and verify the repository.",
        },
        custom_instructions: { action: "preserve" },
        runtime_instructions: { action: "preserve" },
        last_instructions: { action: "preserve" },
      },
    });
  });

  it("keeps the replacement prompt compact", () => {
    expect(COMPACT_SYSTEM_MESSAGE_CONTENT.length).toBeLessThan(350);
  });
});
