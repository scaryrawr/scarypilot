import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  DataListSchema,
  baseUrl,
  fetchJson,
  maxOutputTokens,
  modelConfig,
  positiveInteger,
  providerConfig,
  type FetchImplementation,
} from "./types.ts";

export const GENIEX_PROVIDER_NAME = "geniex";

const DEFAULT_GENIEX_CONTEXT_WINDOW_TOKENS = 65_536;

const GeniexModelSchema = Type.Object({
  id: Type.String(),
});

export async function discoverGeniex(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
) {
  const name = GENIEX_PROVIDER_NAME;
  const endpoint = baseUrl(environment.GENIEX_BASE_URL, "http://127.0.0.1:18181");
  const apiKey = environment.GENIEX_API_KEY ?? "geniex";
  const payload = await fetchJson("GenieX", `${endpoint}/v1/models`, apiKey, fetchImplementation);

  if (!Value.Check(DataListSchema, payload)) return undefined;

  const contextWindow =
    positiveInteger(environment.GENIEX_CONTEXT_LENGTH) ?? DEFAULT_GENIEX_CONTEXT_WINDOW_TOKENS;

  const models = payload.data.flatMap((model) => {
    if (!Value.Check(GeniexModelSchema, model)) return [];

    return [modelConfig(name, model.id, model.id, contextWindow, maxOutputTokens(contextWindow))];
  });

  return providerConfig(name, endpoint, apiKey, models);
}
