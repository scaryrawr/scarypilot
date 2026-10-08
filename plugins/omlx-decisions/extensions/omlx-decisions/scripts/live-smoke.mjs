import assert from "node:assert/strict";
import { DecisionClient } from "../src/decisions.ts";

if (process.env.OMLX_DECISIONS_LIVE !== "1" || !process.env.OMLX_DECISIONS_MODEL) {
  throw new Error("Opt in with OMLX_DECISIONS_LIVE=1 and OMLX_DECISIONS_MODEL set to an exact installed decision model. No models are downloaded.");
}

const client = new DecisionClient();

const model = process.env.OMLX_DECISIONS_MODEL;

const discovery = await client.discover();

assert.ok(discovery.models.some((entry) => entry.id === model), "exact model must be installed and decision-capable");

const result = await client.decide({
  model,
  state: { ticket: "Synthetic public example. The customer asks for a refund after a duplicate charge." },
  questions: {
    category: {
      type: "choice",
      instructions: "Classify this synthetic ticket.",
      criteria: { billing: "Payments and refunds", other: null },
    },
    refund: {
      type: "noul",
      instructions: "Is the customer requesting a refund?",
      criteria: { true: "A refund is requested" },
    },
    urgency: {
      type: "score",
      instructions: "Rate urgency from routine to immediate.",
      criteria: ["Routine", "Soon", "Immediate"],
    },
  },
  truncate: false,
});

assert.equal(result.model, model);

assert.deepEqual(Object.keys(result.answers).sort(), ["category", "refund", "urgency"]);

assert.equal(result.answers.category.type, "choice");

assert.equal(result.answers.refund.type, "noul");

assert.equal(result.answers.urgency.type, "score");

assert.ok(Number.isInteger(result.usage.input_tokens));

assert.equal(result.usage.output_tokens, 0);

console.log("Live decision smoke passed. Discovery and all three answer shapes validated; no model-specific answer assumed.");
