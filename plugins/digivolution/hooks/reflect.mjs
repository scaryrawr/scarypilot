#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRepositoryCorrection, isUsageError } from "./evidence.mjs";

export const REFLECTION_PROMPT = "Run one repository-guidance review before finishing. Review whether this turn revealed a verified, durable repository-specific setup, validation, workflow, safety, convention, or instruction correction that would help future agents. Check existing guidance before editing, prefer correcting it over duplicating text, and use the narrowest relevant AGENTS.md or .agents/skills instruction surface. Do not add generic advice, one-off task details, secrets, private data, or speculative preferences. Make no change when there is no durable improvement; in that case finish silently. Do not acknowledge this hook.";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const VALIDATION = /\b(?:test|check|lint|typecheck|build|validate|pytest|rspec|verify)\b/i;

function commandResult(response) {
  if (typeof response === "string") {
    const exit = /(?:Process exited with code|Exit code:|exited with status)\s*(\d+)/i.exec(response);

    return exit ? { code: Number(exit[1]), text: response } : null;
  }

  if (!response || typeof response !== "object") return null;
  const code = response.exit_code ?? response.exitCode;

  return Number.isInteger(code) ? { code, text: String(response.stderr ?? response.output ?? "") } : null;
}

function commandOperation(event) {
  if (event.tool_name !== "Bash") return null;
  const input = event.tool_input;

  if (!input || typeof input.command !== "string") return null;
  const command = input.command.slice(0, 8192).trim().replace(/\s+/g, " ");

  if (!VALIDATION.test(command) || /https?:\/\//i.test(command)) return null;
  const cwd = path.resolve(event.cwd);
  const workdir = path.resolve(cwd, input.workdir ?? input.cwd ?? cwd);
  const relative = path.relative(cwd, workdir);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;

  return { command: digest(command), target: relative || "." };
}

async function handleUnlocked(event, { dataRoot = process.env.PLUGIN_DATA ||
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "cache", "scarypilot", "digivolution") } = {}) {
  if (!event || typeof event.session_id !== "string" || !event.session_id || typeof event.cwd !== "string") {
    throw new Error("Missing Codex session_id or cwd");
  }

  const sessionKey = digest(`${event.session_id}\0${path.resolve(event.cwd)}`);

  if (event.hook_event_name === "SessionEnd") {
    const files = await readdir(dataRoot);
    await Promise.all(files.filter((file) => file.startsWith(`${sessionKey}.`) && file.endsWith(".json"))
      .map((file) => rm(path.join(dataRoot, file), { force: true })));

    return {};
  }

  const isReflectionContinuation = event.hook_event_name === "UserPromptSubmit" && event.prompt?.startsWith(REFLECTION_PROMPT);

  if (isReflectionContinuation) return {};

  if (typeof event.turn_id !== "string" || !event.turn_id) return {};
  const file = path.join(dataRoot, `${sessionKey}.${digest(event.turn_id)}.json`);
  let state;

  try { state = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  if (state && (state.version !== 1 || typeof state.turn !== "string" ||
      !Array.isArray(state.failures) || !state.failures.every((failure) => failure &&
        typeof failure.command === "string" && /^[a-f0-9]{64}$/.test(failure.command) &&
        typeof failure.target === "string" && typeof failure.usage === "boolean") || typeof state.evidence !== "boolean" || typeof state.issued !== "boolean")) {
    throw new Error("Invalid digivolution state");
  }

  if (event.hook_event_name === "UserPromptSubmit") {
    if (typeof event.prompt !== "string") throw new Error("Missing user prompt");
    state = { version: 1, turn: event.turn_id, failures: [], issued: false,
      evidence: isRepositoryCorrection(event.prompt) };
  } else if (!state || state.turn !== event.turn_id) {
    return {};
  }

  let output = {};

  if (event.hook_event_name === "PostToolUse") {
    const operation = commandOperation(event);
    const result = commandResult(event.tool_response);

    if (operation && result) {
      if (result.code !== 0) {
        state.failures.push({ ...operation, usage: isUsageError(result.text) });
        state.failures = state.failures.slice(-32);
      } else {
        const related = state.failures.filter((failure) => failure.target === operation.target && failure.command !== operation.command);

        if (related.some((failure) => failure.usage) || related.length >= 2) state.evidence = true;
      }
    }
  } else if (event.hook_event_name === "Stop") {
    if (!event.stop_hook_active && state.evidence && !state.issued) {
      state.issued = true;
      output = { decision: "block", reason: REFLECTION_PROMPT };
    }
  }

  await mkdir(dataRoot, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;

  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }

  return output;
}

export async function handleEvent(event, { dataRoot = process.env.PLUGIN_DATA ||
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "cache", "scarypilot", "digivolution") } = {}) {
  if (!event || typeof event.session_id !== "string" || typeof event.cwd !== "string") throw new Error("Missing Codex session_id or cwd");
  await mkdir(dataRoot, { recursive: true });
  // Command hooks run in distinct processes; serialize a turn's state updates.
  const turnLockKey = digest(`${event.session_id}\0${path.resolve(event.cwd)}\0${event.turn_id ?? "session-end"}`);
  const lock = path.join(dataRoot, `${turnLockKey}.lock`);
  let handle;
  const started = Date.now();

  while (!handle) {
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;

      if (Date.now() - started > (event.hook_event_name === "SessionEnd" ? 1000 : 4000)) throw new Error("Digivolution state is busy; skipping this reflection event");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  try { return await handleUnlocked(event, { dataRoot }); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let payload = "";

  for await (const chunk of process.stdin) payload += chunk;
  handleEvent(JSON.parse(payload)).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(`Digivolution hook failed: ${error.message}`);
    console.log("{}");
  });
}
