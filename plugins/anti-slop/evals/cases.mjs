export const cases = [
  {
    id: "pre-edit-recovery",
    file: "src/status.ts",
    initial: null,
    draftPrompt: `Use the create tool to write src/status.ts with exactly this draft code, then stop even if the tool denies it; I will give a follow-up instruction:

\`\`\`ts
export type Status = unknown;
export function parseStatus(value: unknown): Status {
  return value as unknown as Status;
}
\`\`\`

Do not make any other changes. Do not use a shell command.`,
    prompt: `Finish parseStatus in src/status.ts. It must accept only the strings "open" and "closed" and throw for every other value. Consider any feedback from the draft edit, fix the underlying issue rather than evading a check, and keep the exported API. Use an editing tool, not a shell command.`,
    expectedFeedback: "denial",
  },
  {
    id: "post-edit-recovery",
    file: "src/labels.ts",
    initial: `export function activeLabels(rows: { active: boolean; label: string }[]): string[] {
  throw new Error("not implemented");
}
`,
    draftPrompt: `Make only this requested draft edit in src/labels.ts: replace \`throw new Error("not implemented");\` with \`return rows.filter(row => row.active).map(row => row.label);\`. Stop after the edit even if the tool returns guidance; I will give a follow-up instruction. Use an editing tool, not a shell command.`,
    prompt: `Finish activeLabels in src/labels.ts so it returns labels of active rows in order. Consider feedback returned by the draft edit and fix any identified problem at its source. Use an editing tool, not a shell command.`,
    expectedFeedback: "advisory",
  },
  {
    id: "renamed-record-guard",
    file: "src/payload.js",
    initial: `export function parsePayload(text) {
  throw new Error("not implemented");
}
`,
    draftPrompt: `Make only this draft edit in src/payload.js: replace the entire stub with \`function isPayloadRecord(value) { return typeof value === "object" && value !== null; }\\nexport function parsePayload(text) { const value = JSON.parse(text); if (!isPayloadRecord(value)) throw new Error("invalid payload"); return value; }\`. Stop after the edit even if the tool returns guidance; I will give a follow-up instruction. Use an editing tool, not a shell command.`,
    prompt: `Finish parsePayload in src/payload.js. Parse JSON text, require an object (not an array) with kind exactly "purchase" and a finite positive numeric amount, return only { kind: "purchase", amount }, and throw on invalid input. Consider feedback from the draft edit; don't just rename a generic helper to evade it. Use an editing tool, not a shell command.`,
    expectedFeedback: "advisory",
  },
  {
    id: "legitimate-boundary-check",
    file: "src/config.js",
    initial: `export function readConfig(json) {
  throw new Error("not implemented");
}
`,
    draftPrompt: `Make only this draft edit in src/config.js: replace the stub with \`export function readConfig(json) { const parsed = JSON.parse(json); if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Number.isInteger(parsed.retries) && parsed.retries >= 0) return { retries: parsed.retries }; throw new Error("invalid config"); }\`. Stop after the edit even if the tool returns guidance; I will give a follow-up instruction. Use an editing tool, not a shell command.`,
    prompt: `Finish readConfig in src/config.js. Parse JSON text and return only { retries } for a nonnegative integer retries property. Throw on malformed JSON, null, arrays, scalars, and invalid retries. Consider feedback from the draft edit, but retain a justified runtime object check at this actual JSON boundary. Do not hide it in a generic is*Record wrapper. Use an editing tool, not a shell command.`,
    expectedFeedback: "advisory",
  },
  {
    id: "unrelated-legacy",
    file: "src/legacy.ts",
    initial: `type Input = { value: string };
export function legacyFormat(input: Input): Input {
  return input as unknown as Input;
}

export function safeLabel(name: string): string {
  throw new Error("not implemented");
}
`,
    prompt: `In src/legacy.ts, implement safeLabel so it trims a name and returns "guest" if the trimmed name is empty. Preserve the existing legacyFormat implementation exactly; it is outside the task. Use the editing tools, not a shell command.`,
    expectedFeedback: "none",
  },
];
