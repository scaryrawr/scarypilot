import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cases } from "./cases.mjs";
import { deliveredOnDraft, feedbackFromTrace, sourceChecks } from "./run.mjs";

function trace(name, { error, content } = {}) {
  return [
    JSON.stringify({
      type: "assistant.message",
      data: { toolRequests: [{ toolCallId: "one", name, arguments: {} }] },
    }),
    JSON.stringify({
      type: "tool.execution_complete",
      data: { toolCallId: "one", success: !error, error: error && { message: error },
        result: content && { content } },
    }),
  ].join("\n");
}

describe("anti-slop behavioral eval", () => {
  it("recognizes delivered pre-edit denial and post-edit advisory in CLI JSONL", () => {
    assert.deepEqual(feedbackFromTrace(trace("create", {
      error: "Denied by preToolUse hook: Anti-Slop rejected new code",
    })), { denials: 1, advisories: 0, failures: 0, edits: 1, legacyWarnings: 0, models: [] });

    assert.deepEqual(feedbackFromTrace(trace("edit", {
      content: "Tool succeeded. Additional guidance from postToolUse hooks:\nAnti-Slop advisory on newly edited code:",
    })), { denials: 0, advisories: 1, failures: 0, edits: 1, legacyWarnings: 0, models: [] });
  });

  it("does not count unrelated tool errors as hook feedback", () => {
    assert.deepEqual(feedbackFromTrace(trace("view", {
      error: "Denied by preToolUse hook: Anti-Slop rejected",
    })), { denials: 0, advisories: 0, failures: 0, edits: 0, legacyWarnings: 0, models: [] });

    assert.deepEqual(feedbackFromTrace(trace("edit", {
      error: "File not found",
    })), { denials: 0, advisories: 0, failures: 0, edits: 1, legacyWarnings: 0, models: [] });

    assert.equal(feedbackFromTrace(trace("create", {
      content: "Anti-Slop full checks could not run: npm unavailable",
    })).failures, 1);
    assert.equal(feedbackFromTrace(trace("edit", {
      content: "Anti-Slop advisory on newly edited code: anti-slop(no-chained-type-assertions)",
    })).legacyWarnings, 1);
  });

  it("requires the matching feedback on the draft turn", () => {
    assert.equal(deliveredOnDraft(cases[0], { denials: 1, advisories: 0 }), true);
    assert.equal(deliveredOnDraft(cases[0], { denials: 0, advisories: 1 }), false);
    assert.equal(deliveredOnDraft(cases[1], { denials: 0, advisories: 1 }), true);
    assert.equal(deliveredOnDraft(cases[1], undefined), false);
    assert.equal(deliveredOnDraft(cases[4], { denials: 0, advisories: 1 }), false);
  });

  it("scores final code rather than an agent's assertion that it complied", () => {
    const [preEdit, postEdit, renamed, boundary, legacy] = cases;

    assert.equal(sourceChecks(preEdit, "return value as unknown as Status;", []).noAssertionChain, false);
    assert.equal(sourceChecks(postEdit, "return values.filter(x => x).map(x => x);", [
      { code: "anti-slop(no-array-filter-map)" },
    ]).noFilterMapDiagnostic, false);
    assert.equal(sourceChecks(renamed,
      "function isNewPayloadRecord(x) { return typeof x === 'object'; }", []
    ).noGenericRecordHelper, false);
    assert.equal(sourceChecks(boundary,
      'const isPlainObject = typeof parsed === "object" && !Array.isArray(parsed);', []
    ).noGenericRecordHelper, true);
    assert.equal(sourceChecks(boundary,
      'const isPlainObject = (x) => typeof x === "object";', []
    ).noGenericRecordHelper, false);
    assert.equal(sourceChecks(boundary,
      'const valid = typeof parsed === "object" && !Array.isArray(parsed);', []
    ).retainsBoundaryObjectCheck, true);
    assert.equal(sourceChecks(legacy,
      `${legacy.initial.slice(0, legacy.initial.indexOf("export function safeLabel"))}export function safeLabel() {}`,
      []
    ).legacyUnchanged, true);
    assert.equal(sourceChecks(legacy, "export function safeLabel() {}", []).legacyUnchanged, false);
  });
});
