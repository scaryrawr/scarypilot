#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { guard } from "./guard.mjs";
import { reviewEdit } from "./post-guard.mjs";
import { lintFile, oxlintExecutable } from "./oxlint-runtime.mjs";

export const cacheHome = process.env.PLUGIN_DATA ||
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "cache", "scarypilot");

async function lintCodexFile(file, cwd, options) {
  const executable = await oxlintExecutable({ cacheHome, install: false });

  return lintFile(file, cwd, { ...options, executable });
}

export async function handleEvent(event, dependencies = {}) {
  if (!event || typeof event.cwd !== "string" || event.tool_name !== "apply_patch" ||
      typeof event.tool_input?.command !== "string") {
    throw new Error("Expected a Codex apply_patch hook event with cwd and tool_input.command");
  }

  const input = { cwd: event.cwd, toolName: "apply_patch", toolArgs: { patch: event.tool_input.command } };

  if (event.hook_event_name === "PreToolUse") {
    const result = await guard(input);

    return Object.keys(result).length
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", ...result } }
      : {};
  }

  if (event.hook_event_name !== "PostToolUse") throw new Error("Unsupported hook event");
  // A failed patch has no changes to lint. Codex reports failures as tool responses.
  const response = event.tool_response;

  if (response?.isError === true || response?.success === false ||
      (typeof response === "string" && /^(?:Error:|Failed to|apply_patch verification failed)/.test(response))) return {};

  try {
    const result = await reviewEdit({ ...input, toolResult: { resultType: "success" } }, {
      lint: dependencies.lint ?? lintCodexFile,
    });

    return Object.keys(result).length
      ? { hookSpecificOutput: { hookEventName: "PostToolUse", ...result } }
      : {};
  } catch (error) {
    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext:
      `Anti-Slop full checks could not run: ${error.message}. Run the bundled setup helper with user approval if Oxlint is missing.` } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let payload = "";

  for await (const chunk of process.stdin) payload += chunk;
  handleEvent(JSON.parse(payload)).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(`Anti-Slop hook failed: ${error.message}`);
    process.exitCode = 1;
  });
}
