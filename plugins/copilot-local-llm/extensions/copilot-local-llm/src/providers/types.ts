import type { NamedProviderConfig, ProviderModelConfig } from "@github/copilot-sdk";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 131_072;

export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

const DISCOVERY_TIMEOUT_MS = 3_000;

export const JsonValueSchema = Type.Recursive((self) =>
  Type.Union([
    Type.Boolean(),
    Type.Null(),
    Type.Number(),
    Type.String(),
    Type.Array(self),
    Type.Record(Type.String(), self),
  ]),
);

export const StringSchema = Type.String();

export const StringOrNumberSchema = Type.Union([Type.String(), Type.Number()]);

export const ModelListSchema = Type.Object({
  models: Type.Array(JsonValueSchema),
});

export const DataListSchema = Type.Object({
  data: Type.Array(JsonValueSchema),
});

export type JsonValue = Static<typeof JsonValueSchema>;

export type FetchImplementation = (url: string, init?: RequestInit) => Promise<Response>;

export interface LocalProvider {
  provider: NamedProviderConfig;
  models: ProviderModelConfig[];
}

export function baseUrl(value: string | undefined, fallback: string) {
  return (value ?? fallback).replace(/\/+$/, "");
}

export function modelConfig(
  provider: string,
  id: string,
  name: string,
  maxContextWindowTokens: number,
  maxOutputTokens: number,
  capabilities?: ProviderModelConfig["capabilities"],
): ProviderModelConfig {
  return {
    id,
    provider,
    name,
    maxContextWindowTokens,
    maxPromptTokens: maxContextWindowTokens,
    maxOutputTokens,
    capabilities,
  };
}

export function providerConfig(
  name: string,
  endpoint: string,
  apiKey: string | undefined,
  models: ProviderModelConfig[],
): LocalProvider | undefined {
  if (models.length === 0) return undefined;

  return {
    provider: { name, baseUrl: `${endpoint}/v1`, apiKey, wireApi: "completions" },
    models,
  };
}

export function positiveInteger(value: JsonValue | undefined): number | undefined {
  if (!Value.Check(StringOrNumberSchema, value)) return undefined;

  const parsed = Number.parseInt(String(value), 10);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function maxOutputTokens(contextWindow: number) {
  return Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4));
}

export async function fetchJson(
  provider: string,
  url: string,
  apiKey: string | undefined,
  fetchImplementation: FetchImplementation,
): Promise<JsonValue | undefined> {
  try {
    const response = await fetchImplementation(url, {
      headers: apiKey === undefined ? undefined : { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(
        `[copilot-local-llm] ${provider} model discovery failed: ${response.status} ${response.statusText}`,
      );

      return undefined;
    }

    const payload = await response.json();

    return Value.Check(JsonValueSchema, payload) ? payload : undefined;
  } catch (error) {
    console.warn(
      `[copilot-local-llm] ${provider} model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    return undefined;
  }
}
