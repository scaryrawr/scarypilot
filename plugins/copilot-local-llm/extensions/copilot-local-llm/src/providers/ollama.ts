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

export const OLLAMA_PROVIDER_NAME = "ollama";

const OllamaModelSchema = Type.Object({
  name: Type.String(),
  model: Type.Optional(JsonValueSchema),
});

export async function discoverOllama(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
) {
  const name = OLLAMA_PROVIDER_NAME;
  const endpoint = baseUrl(environment.OLLAMA_BASE_URL, "http://localhost:11434");
  const apiKey = environment.OLLAMA_API_KEY ?? "ollama";
  const payload = await fetchJson("Ollama", `${endpoint}/api/tags`, apiKey, fetchImplementation);

  if (!Value.Check(ModelListSchema, payload)) return undefined;

  const contextWindow =
    positiveInteger(environment.OLLAMA_CONTEXT_LENGTH) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

  const models = payload.models.flatMap((model) => {
    if (!Value.Check(OllamaModelSchema, model)) return [];

    return [
      modelConfig(
        name,
        model.name,
        Value.Check(StringSchema, model.model) ? model.model : model.name,
        contextWindow,
        maxOutputTokens(contextWindow),
      ),
    ];
  });

  return providerConfig(name, endpoint, apiKey, models);
}
