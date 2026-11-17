import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionClient } from "../src/decisions.ts";
import { createDecisionTools } from "../src/tools.ts";

test("native discovery preserves required loaded status without exposing server paths", async () => {
  const client = new DecisionClient({
    fetch: async () => Response.json({
      models: [
        { id: "native-model", model_type: "decision", engine_type: "decision", loaded: true, model_alias: "informational", model_path: "/private/server/checkpoint" },
        { id: "engine-decision", model_type: "llm", engine_type: "decision", loaded: false },
      ],
    }),
  });

  const tool = createDecisionTools(client)[0];

  const result = await tool.handler({}, {
    sessionId: "test", toolCallId: "test", toolName: "omlx_decision_models", arguments: {},
  });

  assert.equal(result.resultType, "success");
  assert.deepEqual(JSON.parse(result.textResultForLlm), {
    models: [{ id: "native-model", loaded: true }, { id: "engine-decision", loaded: false }],
  });
  assert.ok(!result.textResultForLlm.includes("/private/"));
  assert.ok(!result.textResultForLlm.includes("informational"));
});

test("native discovery ignores irrelevant alias and unavailability metadata regardless of value", async () => {
  for (const metadata of [
    { model_alias: null, unavailable_reason: null },
    { model_alias: "", unavailable_reason: "" },
    { model_alias: { ignored: true }, unavailable_reason: false },
  ]) {
    const client = new DecisionClient({
      fetch: async () => Response.json({
        models: [{ id: "native-model", model_type: "decision", engine_type: "decision", loaded: false, ...metadata }],
      }),
    });

    assert.deepEqual(await client.discover(), { models: [{ id: "native-model", loaded: false }] });
  }
});

for (const [missing, model] of [
  ["loaded", { id: "installed", model_type: "decision", engine_type: "decision" }],
  ["engine_type", { id: "installed", model_type: "decision", loaded: false }],
]) {
  test(`native rejects missing ${missing} metadata in discovery and before inference`, async () => {
    const requests: string[] = [];

    const client = new DecisionClient({
      fetch: async (url) => {
        requests.push(new URL(String(url)).pathname);

        return Response.json({ models: [model] });
      },
    });

    await assert.rejects(client.discover(), /v1\/models\/status returned invalid metadata/);
    await assert.rejects(client.listInstalled(), /v1\/models\/status returned invalid metadata/);
    await assert.rejects(client.decide({
      model: "installed",
      state: "Synthetic request.",
      questions: { q: { type: "noul", instructions: "Is this synthetic?" } },
    }), /v1\/models\/status returned invalid metadata/);
    assert.deepEqual(requests, Array(3).fill("/v1/models/status"));
  });
}
