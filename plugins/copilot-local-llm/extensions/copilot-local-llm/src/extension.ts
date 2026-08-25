import { joinSession } from "@github/copilot-sdk/extension";
import { discoverLocalProviders } from "./local-providers.ts";

const session = await joinSession();

if (!(await session.rpc.metadata.snapshot()).isRemote) {
  const configuration = await discoverLocalProviders();
  try {
    const result = await session.rpc.provider.add(configuration);
    await session.log(`Registered ${result.models.length} local model(s).`, {
      level: "info",
      ephemeral: true,
    });
  } catch (error) {
    await session.log(
      `Local model registration failed: ${error instanceof Error ? error.message : String(error)}`,
      { level: "error", ephemeral: true },
    );
  }
}
