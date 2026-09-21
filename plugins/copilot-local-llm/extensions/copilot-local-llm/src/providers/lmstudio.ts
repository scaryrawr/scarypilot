import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  JsonValueSchema,
  ModelListSchema,
  StringSchema,
  baseUrl,
  fetchJson,
  maxOutputTokens,
  modelConfig,
  positiveInteger,
  providerConfig,
  type FetchImplementation,
} from "./types.ts";

export const LMSTUDIO_PROVIDER_NAME = "lmstudio";

const LmStudioModelSchema = Type.Object({
  key: Type.String(),
  display_name: Type.Optional(JsonValueSchema),
  max_context_length: Type.Optional(JsonValueSchema),
});

export async function discoverLmStudio(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
) {
  const name = LMSTUDIO_PROVIDER_NAME;
  const endpoint = baseUrl(environment.LMSTUDIO_BASE_URL, "http://localhost:1234");
  const apiKey = environment.LMSTUDIO_API_KEY ?? "lmstudio";

  const payload = await fetchJson(
    "LM Studio",
    `${endpoint}/api/v1/models`,
    apiKey,
    fetchImplementation,
  );

  if (!Value.Check(ModelListSchema, payload)) return undefined;

  const models = payload.models.flatMap((model) => {
    if (!Value.Check(LmStudioModelSchema, model)) return [];

    const contextWindow =
      positiveInteger(model.max_context_length) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

    return [
      modelConfig(
        name,
        model.key,
        Value.Check(StringSchema, model.display_name) ? model.display_name : model.key,
        contextWindow,
        maxOutputTokens(contextWindow),
      ),
    ];
  });

  return providerConfig(name, endpoint, apiKey, models);
}
