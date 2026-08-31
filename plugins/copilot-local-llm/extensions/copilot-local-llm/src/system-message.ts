import type { SystemMessageConfig } from "@github/copilot-sdk";

export const COMPACT_SYSTEM_MESSAGE_CONTENT =
  "You are GitHub Copilot, a coding agent. Inspect the relevant repository files before changing them. " +
  "Follow the user's request and project instructions. Make the smallest correct change, " +
  "preserve existing behavior unless asked to change it, run relevant checks, and report results concisely.";

export const COMPACT_SYSTEM_MESSAGE = {
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
} satisfies SystemMessageConfig;
