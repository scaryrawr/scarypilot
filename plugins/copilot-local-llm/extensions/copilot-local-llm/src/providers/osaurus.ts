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

export const OSAURUS_PROVIDER_NAME = "osaurus";

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
  if (!isRecord(payload) || !Array.isArray(payload.models)) return undefined;

  const contextWindow =
    positiveInteger(environment.OSAURUS_CONTEXT_LENGTH ?? environment.OSARAUS_CONTEXT_LENGTH) ??
    DEFAULT_CONTEXT_WINDOW_TOKENS;
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
