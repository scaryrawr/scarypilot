import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionClient, createDecisionTools } from "../src/decisions.ts";
import type { DecisionInput, DecisionResponse } from "../src/schemas.ts";

const model = "Clef-Flash";

const metadata = { models: [{
  id: model, loaded: false, model_type: "decision", engine_type: "decision", capabilities: [],
}] };

const input = {
  model,
  state: "Synthetic public ticket",
  questions: {
    category: { type: "choice", instructions: "Choose a category.", criteria: { a: null, b: null, c: null } },
    urgency: { type: "score", instructions: "Rate urgency.", criteria: ["Low", "Medium", "High"] },
  },
} satisfies DecisionInput;

const rounded = {
  model,
  answers: {
    category: {
      type: "choice", choice: "a", confidence: 0.3333,
      probabilities: { a: 0.3333, b: 0.3333, c: 0.3333 },
    },
    urgency: {
      type: "score", score: 1, confidence: 0.3333,
      legend: { "0": "Low", "1": "Medium", "2": "High" },
      probabilities: { "0": 0.3333, "1": 0.3333, "2": 0.3333 },
    },
  },
  usage: { input_tokens: 123, output_tokens: 0 },
} satisfies DecisionResponse;

test("independently rounded SystemOne probabilities and scores are preserved, not normalized", async () => {
  let payload = rounded;

  const client = new DecisionClient({
    environment: {},
    fetch: async (url) => Response.json(String(url).endsWith("/v1/models/status") ? metadata : payload),
  });

  assert.deepEqual(await client.decide(input), rounded);
  payload = { ...rounded, answers: { ...rounded.answers, urgency: { ...rounded.answers.urgency, score: 1.0001 } } };
  assert.deepEqual(await client.decide(input), payload, "includes independent score and probability rounding");
  payload = { ...rounded, answers: { ...rounded.answers, urgency: { ...rounded.answers.urgency, score: 1.001 } } };
  await assert.rejects(client.decide(input), /probability-weighted/);
  payload = { ...rounded, answers: { ...rounded.answers, category: {
    ...rounded.answers.category, probabilities: { a: 0.3332, b: 0.3332, c: 0.3332 },
  } } };
  await assert.rejects(client.decide(input), /sum to one/);
});

test("scalar state, unloaded engines, and explicit truncation use the exact SystemOne wire contract", async () => {
  for (const state of [true, false, 0, 42, { ticket: "Synthetic" }, ["Synthetic"]]) {
    for (const truncate of [undefined, false, true]) {
      const request: DecisionInput = { ...input, state };

      if (truncate !== undefined) request.truncate = truncate;
      const paths: string[] = [];

      const client = new DecisionClient({
        environment: {},
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;

          paths.push(path);

          if (path === "/v1/models/status") {
            return Response.json({ models: [{ ...metadata.models[0], model_type: "llm" }] });
          }

          assert.equal(path, "/v1/systemone");
          assert.deepEqual(JSON.parse(String(init?.body)), { ...request, truncate: truncate ?? false });

          return Response.json(rounded);
        },
      });

      assert.deepEqual(await client.decide(request), rounded);
      assert.deepEqual(paths, ["/v1/models/status", "/v1/systemone"]);
    }
  }
});

test("singleton criteria and larger question/level sets have no inherited count ceilings", async () => {
  const levels = Array.from({ length: 27 }, (_, index) => `Level ${index}`);

  const request = {
    model, state: "Synthetic",
    questions: {
      ...Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
        `q${index}`, { type: "noul", instructions: "Is this synthetic?" } as const,
      ])),
      category: { type: "choice", instructions: "Choose.", criteria: { only: null } },
      singleton: { type: "score", instructions: "Score.", criteria: ["Only"] },
      score: { type: "score", instructions: "Score.", criteria: levels },
    },
  } satisfies DecisionInput;

  const response = {
    model,
    answers: {
      ...Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
        `q${index}`, { type: "noul", noul: 0.5 } as const,
      ])),
      category: { type: "choice", choice: "only", confidence: 1, probabilities: { only: 1 } },
      singleton: { type: "score", score: 0, confidence: 1, legend: { "0": "Only" }, probabilities: { "0": 1 } },
      score: {
        type: "score", score: 26, confidence: 1,
        legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
        probabilities: Object.fromEntries(levels.map((_, index) => [String(index), index === 26 ? 1 : 0])),
      },
    },
    usage: { input_tokens: 1000, output_tokens: 0 },
  } satisfies DecisionResponse;

  const client = new DecisionClient({
    environment: {},
    fetch: async (url) => Response.json(String(url).endsWith("/v1/models/status") ? metadata : response),
  });

  assert.deepEqual(await client.decide(request), response);
});

test("HTTP 200 late error envelopes fail with no state or server error disclosure", async () => {
  const tools = createDecisionTools(new DecisionClient({
    environment: {},
    fetch: async (url) => Response.json(String(url).endsWith("/v1/models/status")
      ? metadata : { error: { message: "synthetic-private-state synthetic-api-key" } }),
  }));

  const result = await tools[1].handler(input, {
    sessionId: "test", toolCallId: "test", toolName: "omlx_decide", arguments: input,
  });

  assert.equal(result.resultType, "failure");
  assert.match(result.textResultForLlm, /invalid metadata or response/);
  assert.doesNotMatch(result.textResultForLlm, /synthetic-private-state|synthetic-api-key/);
});
