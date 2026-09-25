import type { CopilotSession } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";
import { discoverLocalProviders } from "./local-providers.ts";

type ProviderRegistration = Awaited<ReturnType<typeof discoverLocalProviders>>;

interface RegistrationDependencies {
  discover: typeof discoverLocalProviders;
  join: (options: ProviderRegistration) => Promise<Pick<CopilotSession, "log">>;
}

const defaultDependencies: RegistrationDependencies = {
  discover: discoverLocalProviders,
  join: joinSession,
};

export async function registerLocalLlmExtension(
  dependencies: RegistrationDependencies = defaultDependencies,
): Promise<void> {
  const configuration = await dependencies.discover();

  const session = await dependencies.join({
    providers: configuration.providers,
    models: configuration.models,
  });

  await session.log(`Registered ${configuration.models.length} local model(s).`, {
    level: "info",
    ephemeral: true,
  });
}
