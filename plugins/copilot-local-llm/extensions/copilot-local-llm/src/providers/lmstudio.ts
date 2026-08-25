import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  baseUrl,
  fetchJson,
  isRecord,
  maxOutputTokens,
  modelConfig,
  positiveInteger,
  providerConfig,
  type FetchImplementation,
} from "./types.ts";

export const LMSTUDIO_PROVIDER_NAME = "lmstudio";

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
  if (!isRecord(payload) || !Array.isArray(payload.models)) return undefined;

  const models = payload.models.flatMap((model) => {
    if (!isRecord(model) || typeof model.key !== "string") return [];
    const contextWindow =
      positiveInteger(model.max_context_length) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    return [
      modelConfig(
        name,
        model.key,
        typeof model.display_name === "string" ? model.display_name : model.key,
        contextWindow,
        maxOutputTokens(contextWindow),
      ),
    ];
  });

  return providerConfig(name, endpoint, apiKey, models);
}
