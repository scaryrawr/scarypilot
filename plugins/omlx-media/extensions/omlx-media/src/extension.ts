import { joinSession } from "@github/copilot-sdk/extension";
import { createOmlxSpeechTool, createOmlxTranscriptionTool } from "./audio-tools.ts";
import { createOmlxImageTool } from "./image-tool.ts";
import { createOmlxPrepareFramesTool } from "./frame-tool.ts";
import { groundedAgents, groundedNoteWorkflow } from "./grounded-registration.ts";

export { runGroundedNote } from "./grounded-note.ts";

await joinSession({
  tools: [createOmlxImageTool(), createOmlxSpeechTool(), createOmlxTranscriptionTool(), createOmlxPrepareFramesTool()],
  customAgents: groundedAgents,
  workflows: [groundedNoteWorkflow],
});
