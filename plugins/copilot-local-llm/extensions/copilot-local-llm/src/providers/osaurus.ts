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

export const OSAURUS_PROVIDER_NAME = "osaurus";

const OsaurusModelSchema = Type.Object({
  name: Type.String(),
  model: Type.Optional(JsonValueSchema),
});

export async function discoverOsaurus(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
) {
  const name = OSAURUS_PROVIDER_NAME;

  const endpoint = baseUrl(
    environment.OSAURUS_BASE_URL ?? environment.OSARAUS_BASE_URL,
    "http://localhost:1337",
  );

  const apiKey = environment.OSAURUS_API_KEY ?? environment.OSARAUS_API_KEY ?? "osaurus";
  const payload = await fetchJson("OSaurus", `${endpoint}/api/tags`, apiKey, fetchImplementation);

  if (!Value.Check(ModelListSchema, payload)) return undefined;

  const contextWindow =
    positiveInteger(environment.OSAURUS_CONTEXT_LENGTH ?? environment.OSARAUS_CONTEXT_LENGTH) ??
    DEFAULT_CONTEXT_WINDOW_TOKENS;

  const models = payload.models.flatMap((model) => {
    if (!Value.Check(OsaurusModelSchema, model)) return [];

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
