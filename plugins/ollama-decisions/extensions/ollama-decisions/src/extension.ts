import { joinSession } from "@github/copilot-sdk/extension";
import { createDecisionTools } from "./decisions.ts";

await joinSession({
  requestedEnvironmentVariables: ["OLLAMA_BASE_URL", "OLLAMA_API_KEY"],
  tools: createDecisionTools(),
});
