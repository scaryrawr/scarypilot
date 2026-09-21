import type { CopilotSession } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";
import { discoverLocalProviders } from "./local-providers.ts";
import { configureLocalModelTools, type LocalModelSession } from "./model-tools.ts";
import { COMPACT_SYSTEM_MESSAGE } from "./system-message.ts";

interface RegistrationDependencies {
  discover: typeof discoverLocalProviders;
  join: (options: Parameters<typeof joinSession>[0]) => Promise<LocalModelSession>;
}

const defaultDependencies: RegistrationDependencies = {
  discover: discoverLocalProviders,
  join: async (options) => localModelSession(await joinSession(options)),
};

function localModelSession(session: CopilotSession): LocalModelSession {
  return {
    log: (message, options) => session.log(message, options),
    on: (eventType, handler) => session.on(eventType, handler),
    rpc: session.rpc,
  };
}

export async function registerLocalLlmExtension(
  dependencies: RegistrationDependencies = defaultDependencies,
): Promise<void> {
  const configuration = await dependencies.discover();

  const session = await dependencies.join({
    ...configuration,
    systemMessage: COMPACT_SYSTEM_MESSAGE,
  });

  await configureLocalModelTools(session, configuration.models);

  await session.log(`Registered ${configuration.models.length} local model(s).`, {
    level: "info",
    ephemeral: true,
  });
}
