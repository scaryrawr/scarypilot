import {
  baseUrl,
  fetchJson,
  isRecord,
  maxOutputTokens,
  modelConfig,
  positiveInteger,
  providerConfig,
  type FetchImplementation,
} from "./types.ts";

export const GENIEX_PROVIDER_NAME = "geniex";
const DEFAULT_GENIEX_CONTEXT_WINDOW_TOKENS = 65_536;

export async function discoverGeniex(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
) {
  const name = GENIEX_PROVIDER_NAME;
  const endpoint = baseUrl(environment.GENIEX_BASE_URL, "http://127.0.0.1:18181");
  const apiKey = environment.GENIEX_API_KEY ?? "geniex";
  const payload = await fetchJson("GenieX", `${endpoint}/v1/models`, apiKey, fetchImplementation);
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;

  const contextWindow =
    positiveInteger(environment.GENIEX_CONTEXT_LENGTH) ?? DEFAULT_GENIEX_CONTEXT_WINDOW_TOKENS;
  const models = payload.data.flatMap((model) => {
    if (!isRecord(model) || typeof model.id !== "string") return [];
    return [modelConfig(name, model.id, model.id, contextWindow, maxOutputTokens(contextWindow))];
  });

  return providerConfig(name, endpoint, apiKey, models);
}
