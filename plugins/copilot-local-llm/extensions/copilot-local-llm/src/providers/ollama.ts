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

export const OLLAMA_PROVIDER_NAME = "ollama";

export async function discoverOllama(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
) {
  const name = OLLAMA_PROVIDER_NAME;
  const endpoint = baseUrl(environment.OLLAMA_BASE_URL, "http://localhost:11434");
  const apiKey = environment.OLLAMA_API_KEY ?? "ollama";
  const payload = await fetchJson("Ollama", `${endpoint}/api/tags`, apiKey, fetchImplementation);
  if (!isRecord(payload) || !Array.isArray(payload.models)) return undefined;

  const contextWindow =
    positiveInteger(environment.OLLAMA_CONTEXT_LENGTH) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const models = payload.models.flatMap((model) => {
    if (!isRecord(model) || typeof model.name !== "string") return [];
    return [
      modelConfig(
        name,
        model.name,
        typeof model.model === "string" ? model.model : model.name,
        contextWindow,
        maxOutputTokens(contextWindow),
      ),
    ];
  });

  return providerConfig(name, endpoint, apiKey, models);
}
