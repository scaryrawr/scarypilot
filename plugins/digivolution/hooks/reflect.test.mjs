import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { handleEvent, REFLECTION_PROMPT } from "./reflect.mjs";

const roots = [];

afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function session(id = "main", turn = "turn-1") {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "digivolution-")); roots.push(dataRoot);

  return { dataRoot, run: (hook_event_name, extras = {}) => handleEvent({ session_id: id, turn_id: turn, cwd: dataRoot, hook_event_name, ...extras }, { dataRoot }) };
}

test("ordinary successful work and one-off failures do not trigger reflection", async () => {
  const { run } = await session();
  await run("UserPromptSubmit", { prompt: "Fix the user interface" });
  await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "Process exited with code 1\nassertion failed" });
  assert.deepEqual(await run("Stop", { stop_hook_active: false }), {});
});

test("repository corrections reflect once, without storing prompt text", async () => {
  const { run, dataRoot } = await session();
  await run("UserPromptSubmit", { prompt: "Remember that this repository uses bun test. SECRET_TOKEN_123" });
  assert.deepEqual(await run("Stop"), { decision: "block", reason: REFLECTION_PROMPT });
  await run("UserPromptSubmit", { prompt: REFLECTION_PROMPT });
  assert.deepEqual(await run("Stop", { stop_hook_active: true }), {});
  assert.deepEqual(await run("Stop"), {});

  for (const file of await readdir(dataRoot)) assert.doesNotMatch(await readFile(path.join(dataRoot, file), "utf8"), /SECRET_TOKEN|bun test/);
});

test("a recovered validation usage mistake triggers reflection", async () => {
  const { run } = await session();
  await run("UserPromptSubmit", { prompt: "Test the package" });
  await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test --wrong" }, tool_response: "Process exited with code 1\nUnknown option --wrong" });
  await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "Process exited with code 0\npassed" });
  assert.equal((await run("Stop")).decision, "block");
});

test("two recovered validation failures trigger reflection but unrelated commands do not", async () => {
  const { run } = await session();
  await run("UserPromptSubmit", { prompt: "Run tests" });

  for (const command of ["npm test --first", "npm test --second"]) {
    await run("PostToolUse", { tool_name: "Bash", tool_input: { command }, tool_response: { exit_code: 1, stderr: "failed" } });
  }

  await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { exit_code: 0 } });
  assert.deepEqual(await run("Stop"), {});
  await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
  assert.equal((await run("Stop")).decision, "block");
});

test("different sessions and turns cannot inherit reflection evidence", async () => {
  const { run, dataRoot } = await session();
  await run("UserPromptSubmit", { prompt: "Remember this repo uses bun" });
  assert.deepEqual(await handleEvent({ cwd: dataRoot, session_id: "other", turn_id: "turn-1", hook_event_name: "Stop" }, { dataRoot }), {});
  assert.deepEqual(await handleEvent({ cwd: dataRoot, session_id: "main", turn_id: "other", hook_event_name: "Stop" }, { dataRoot }), {});
  await run("SessionEnd");
  assert.deepEqual(await readdir(dataRoot), []);
});

test("commands outside the repository and unsupported output formats do not become evidence", async () => {
  const { run } = await session();
  await run("UserPromptSubmit", { prompt: "Check the repo" });

  for (const code of [1, 0]) {
    await run("PostToolUse", { tool_name: "Bash", tool_input: { command: `npm test --${code}`, workdir: ".." }, tool_response: { exit_code: code, stderr: "unknown option" } });
  }

  await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "no exit status" });
  assert.deepEqual(await run("Stop"), {});
});

test("concurrent Stop hooks issue at most one reflection", async () => {
  const { run } = await session();
  await run("UserPromptSubmit", { prompt: "Remember this repository uses bun" });
  const results = await Promise.all(Array.from({ length: 8 }, () => run("Stop")));
  assert.equal(results.filter((result) => result.decision === "block").length, 1);
});

test("overlapping turns preserve their own reflection evidence and clean up together", async () => {
  const { run, dataRoot } = await session();
  await run("UserPromptSubmit", { prompt: "Run tests" });
  await Promise.all([
    run("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } }),
    run("UserPromptSubmit", { turn_id: "next", prompt: "Remember this repository uses bun" }),
  ]);
  assert.equal((await run("Stop", { turn_id: "next" })).decision, "block");
  assert.deepEqual(await run("Stop"), {});
  await run("SessionEnd");
  assert.deepEqual(await readdir(dataRoot), []);
});
