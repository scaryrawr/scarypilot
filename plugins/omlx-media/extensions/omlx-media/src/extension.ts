import { joinSession } from "@github/copilot-sdk/extension";
import { createOmlxSpeechTool, createOmlxTranscriptionTool } from "./audio-tools.ts";
import { createOmlxImageTool } from "./image-tool.ts";
import { createOmlxPrepareFramesTool } from "./frame-tool.ts";

await joinSession({
  tools: [createOmlxImageTool(), createOmlxSpeechTool(), createOmlxTranscriptionTool(), createOmlxPrepareFramesTool()],
});
