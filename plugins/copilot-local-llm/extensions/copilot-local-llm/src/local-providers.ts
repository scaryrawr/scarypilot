import type { NamedProviderConfig, ProviderModelConfig } from "@github/copilot-sdk";
import { discoverGeniex, GENIEX_PROVIDER_NAME } from "./providers/geniex.ts";
import { discoverLmStudio, LMSTUDIO_PROVIDER_NAME } from "./providers/lmstudio.ts";
import { discoverOllama, OLLAMA_PROVIDER_NAME } from "./providers/ollama.ts";
import { discoverOmlx, OMLX_PROVIDER_NAME } from "./providers/omlx.ts";
import { discoverOsaurus, OSAURUS_PROVIDER_NAME } from "./providers/osaurus.ts";
import type { FetchImplementation, LocalProvider } from "./providers/types.ts";

interface LocalProviderConfiguration {
  providers: NamedProviderConfig[];
  models: ProviderModelConfig[];
}

const LOCAL_PROVIDER_DISCOVERERS = {
  [OLLAMA_PROVIDER_NAME]: discoverOllama,
  [LMSTUDIO_PROVIDER_NAME]: discoverLmStudio,
  [OMLX_PROVIDER_NAME]: discoverOmlx,
  [OSAURUS_PROVIDER_NAME]: discoverOsaurus,
  [GENIEX_PROVIDER_NAME]: discoverGeniex,
} as const;

export type LocalProviderName = keyof typeof LOCAL_PROVIDER_DISCOVERERS;
export const LOCAL_PROVIDER_NAMES = Object.keys(LOCAL_PROVIDER_DISCOVERERS) as LocalProviderName[];

export async function discoverLocalProviders(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch,
): Promise<LocalProviderConfiguration> {
  const discovered = (
    await Promise.all(
      Object.values(LOCAL_PROVIDER_DISCOVERERS).map((discover) =>
        discover(environment, fetchImplementation),
      ),
    )
  ).filter((provider): provider is LocalProvider => provider !== undefined);

  return {
    providers: discovered.map(({ provider }) => provider),
    models: discovered.flatMap(({ models }) => models),
  };
}
