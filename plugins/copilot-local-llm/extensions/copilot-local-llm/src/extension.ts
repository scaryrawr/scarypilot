import { joinSession } from "@github/copilot-sdk/extension";
import { discoverLocalProviders } from "./local-providers.ts";

const configuration = await discoverLocalProviders();
const session = await joinSession(configuration);

await session.log(`Registered ${configuration.models.length} local model(s).`, {
  level: "info",
  ephemeral: true,
});
