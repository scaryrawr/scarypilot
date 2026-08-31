import { joinSession } from "@github/copilot-sdk/extension";
import { discoverLocalProviders } from "./local-providers.ts";
import { configureLocalModelTools } from "./model-tools.ts";
import { COMPACT_SYSTEM_MESSAGE } from "./system-message.ts";

const configuration = await discoverLocalProviders();
const session = await joinSession({
  ...configuration,
  systemMessage: COMPACT_SYSTEM_MESSAGE,
});

await configureLocalModelTools(session, configuration.models);

await session.log(`Registered ${configuration.models.length} local model(s).`, {
  level: "info",
  ephemeral: true,
});
