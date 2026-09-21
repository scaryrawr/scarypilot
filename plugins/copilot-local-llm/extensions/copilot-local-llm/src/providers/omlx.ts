import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  JsonValueSchema,
  ModelListSchema,
  StringSchema,
  baseUrl,
  fetchJson,
  modelConfig,
  positiveInteger,
  providerConfig,
  type FetchImplementation,
} from "./types.ts";

export const OMLX_PROVIDER_NAME = "omlx";

const OmlxModelSchema = Type.Object({
  id: Type.String(),
  model_type: Type.Union([Type.Literal("llm"), Type.Literal("vlm")]),
  display_name: Type.Optional(JsonValueSchema),
  max_context_window: Type.Optional(JsonValueSchema),
  max_tokens: Type.Optional(JsonValueSchema),
});

export async function discoverOmlx(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
) {
  const name = OMLX_PROVIDER_NAME;
  const endpoint = baseUrl(environment.OMLX_BASE_URL, "http://localhost:8000");
  const apiKey = environment.OMLX_API_KEY ?? "omlx";

  const payload = await fetchJson(
    "OMLX",
    `${endpoint}/v1/models/status`,
    apiKey,
    fetchImplementation,
  );

  if (!Value.Check(ModelListSchema, payload)) return undefined;

  const models = payload.models.flatMap((model) => {
    if (!Value.Check(OmlxModelSchema, model)) return [];

    const contextWindow =
      positiveInteger(model.max_context_window) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

    return [
      modelConfig(
        name,
        model.id,
        Value.Check(StringSchema, model.display_name) ? model.display_name : model.id,
        contextWindow,
        positiveInteger(model.max_tokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
        model.model_type === "vlm" ? { supports: { vision: true } } : undefined,
      ),
    ];
  });

  return providerConfig(name, endpoint, apiKey, models);
}
