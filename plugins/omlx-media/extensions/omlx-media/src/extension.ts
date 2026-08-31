import { joinSession } from "@github/copilot-sdk/extension";
import { createOmlxImageTool } from "./image-tool.ts";

await joinSession({
  tools: [createOmlxImageTool()],
});
