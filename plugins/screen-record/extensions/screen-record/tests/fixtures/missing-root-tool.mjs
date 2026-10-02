import { createRecordingTools } from "../../src/tools.ts";

const runtime = {
  cwd: process.cwd(),
  script: process.env.RECORDER_FIXTURE_SCRIPT,
  env: process.env,
};

const tool = createRecordingTools(runtime).find((entry) => entry.name === "screen_record_status");

const result = await tool.handler({ output: "missing/raw.mp4" }, {
  sessionId: "fixture", toolCallId: "fixture", toolName: tool.name,
});

console.log(JSON.stringify(result));
