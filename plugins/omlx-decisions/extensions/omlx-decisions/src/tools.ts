import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import { Value } from "@sinclair/typebox/value";
import { DecisionClient, DecisionError, validateInput } from "./decisions.ts";
import { DecisionInputSchema, EmptySchema, type DecisionModel, type DecisionResponse } from "./schemas.ts";

export function createDecisionTools(client = new DecisionClient()) {
  const result = async (
    operation: () => Promise<DecisionResponse | { models: DecisionModel[] }>,
  ): Promise<ToolResultObject> => {
    try {
      return { textResultForLlm: JSON.stringify(await operation()), resultType: "success" };
    } catch (error) {
      return {
        textResultForLlm: error instanceof DecisionError
          ? error.message
          : "Decision tool failed unexpectedly. Request state and credentials are omitted.",
        resultType: "failure",
      };
    }
  };

  return [
    {
      name: "omlx_decision_models",
      description: "Discover installed oMLX SystemOne decision models by model/engine type. Returns exact IDs and loaded status, including unloaded models. Reads metadata on each call; never downloads or selects a model.",
      parameters: EmptySchema,
      handler: (args, invocation) => result(async () => {
        if (!Value.Check(EmptySchema, args)) throw new DecisionError("Discovery takes an empty object.");

        return client.discover(invocation.signal);
      }),
    },
    {
      name: "omlx_decide",
      description: "Use an explicit installed oMLX decision model via SystemOne for fast routing, classification, or rubric evaluation. Optional images accept padded raw base64, inline image data URIs, or {path: absolute local image path}; local files require per-call user confirmation of the resolved path and destination before reading. The server verifies vision support (for example Clef Flash). Questions are choice, noul (probability of true), or score (weighted zero-based level, not normalized). State truncation defaults to false. Results are data only. Probabilities and confidence are advisory, never permission to act. No downloads, automatic selection, or inference retries.",
      parameters: DecisionInputSchema,
      handler: (args, invocation) => result(async () => {
        validateInput(args);

        return client.decide(args, invocation.signal);
      }),
    },
  ] satisfies Tool[];
}
