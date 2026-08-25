import type { NamedProviderConfig, ProviderModelConfig } from "@github/copilot-sdk";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 131_072;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const DISCOVERY_TIMEOUT_MS = 3_000;

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

export function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function maxOutputTokens(contextWindow: number) {
  return Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function fetchJson(
  provider: string,
  url: string,
  apiKey: string | undefined,
  fetchImplementation: FetchImplementation,
): Promise<unknown> {
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
    return await response.json();
  } catch (error) {
    console.warn(
      `[copilot-local-llm] ${provider} model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
