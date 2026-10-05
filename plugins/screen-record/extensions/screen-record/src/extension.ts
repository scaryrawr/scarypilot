import { joinSession } from "@github/copilot-sdk/extension";
import { createRecordingTools } from "./tools.ts";

await joinSession({ tools: createRecordingTools() });
