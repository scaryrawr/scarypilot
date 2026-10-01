import { fileURLToPath } from "node:url";
import { createBridgeTransport } from "../../src/ado-bridge.ts";

const bridge = createBridgeTransport(async () => ({
  file: process.execPath,
  args: [fileURLToPath(new URL("./bridge-owner.mjs", import.meta.url))],
}));

process.stdout.write(JSON.stringify(await bridge({
  operation: "snapshot",
  org: "https://dev.azure.com/diagnostic-fixture",
  pullRequestId: 42,
})));
