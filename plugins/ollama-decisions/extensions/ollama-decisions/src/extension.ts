import { joinSession } from "@github/copilot-sdk/extension";
import { DecisionClient, createDecisionTools } from "./decisions.ts";

const session = await joinSession({
  requestedEnvironmentVariables: ["OLLAMA_BASE_URL", "OLLAMA_API_KEY"],
  tools: createDecisionTools(new DecisionClient({
    approveImage: ({ path, endpoint }) => session.ui.confirm(
      `Allow reading local file ${JSON.stringify(path)} and transmitting its complete contents as an image to ${JSON.stringify(endpoint)} for this decision request? Only approve a file you intend to share.`,
    ),
  })),
});
