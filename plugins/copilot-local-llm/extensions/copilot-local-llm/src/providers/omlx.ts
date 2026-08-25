import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  baseUrl,
  fetchJson,
  isRecord,
  modelConfig,
  positiveInteger,
  providerConfig,
  type FetchImplementation,
} from "./types.ts";

export const OMLX_PROVIDER_NAME = "omlx";

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
  if (!isRecord(payload) || !Array.isArray(payload.models)) return undefined;

  const models = payload.models.flatMap((model) => {
    if (
      !isRecord(model) ||
      typeof model.id !== "string" ||
      (model.model_type !== "llm" && model.model_type !== "vlm")
    )
      return [];

    const contextWindow =
      positiveInteger(model.max_context_window) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    return [
      modelConfig(
        name,
        model.id,
        typeof model.display_name === "string" ? model.display_name : model.id,
        contextWindow,
        positiveInteger(model.max_tokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
        model.model_type === "vlm" ? { supports: { vision: true } } : undefined,
      ),
    ];
  });

  return providerConfig(name, endpoint, apiKey, models);
}
