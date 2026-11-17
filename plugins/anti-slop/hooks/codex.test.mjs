import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { handleEvent } from "./codex.mjs";

const roots = [];

async function root() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scarypilot-hook-"));
  roots.push(directory);

  return directory;
}

afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });

const event = (cwd, hook_event_name, patch) => ({ cwd, session_id: "test", turn_id: "one", hook_event_name,
  tool_name: "apply_patch", tool_input: { command: patch }, tool_response: "Success. Updated the following files:\nA src/demo.ts" });

const patch = (text) => `*** Begin Patch\n*** Add File: src/demo.ts\n+${text}\n*** End Patch`;

test("Codex PreToolUse blocks a new assertion chain using the supported wire schema", async () => {
  const result = await handleEvent(event(await root(), "PreToolUse", patch("const a = value as unknown as Result;")));
  assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /chained-assertion/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /src\/demo\.ts \[chained-assertion\]/);
});

test("Codex allows clean patches and ignores assertion-like strings", async () => {
  const cwd = await root();

  for (const text of ["export const a = 1;", 'export const a = "value as unknown as Result";']) {
    assert.deepEqual(await handleEvent(event(cwd, "PreToolUse", patch(text))), {});
  }
});

test("Codex PostToolUse returns context only for new findings", async () => {
  const cwd = await root(); const text = "export const a = 1;";
  await mkdir(path.join(cwd, "src")); await writeFile(path.join(cwd, "src/demo.ts"), text);

  const result = await handleEvent(event(cwd, "PostToolUse", patch(text)), { lint: async () => [
    { code: "anti-slop(no-unknown-parameters)", message: "parse at boundary", labels: [{ span: { line: 1, offset: 0, length: 5 } }] },
  ] });

  assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(result.hookSpecificOutput.additionalContext, /parse at boundary/);
  assert.match(result.hookSpecificOutput.additionalContext, /src\/demo\.ts:1 anti-slop\(no-unknown-parameters\)/);
});

test("post hook ignores explicit patch failures and reports unavailable lint without installing", async () => {
  const cwd = await root();
  const failed = event(cwd, "PostToolUse", patch("const a = 1;")); failed.tool_response = { isError: true };
  assert.deepEqual(await handleEvent(failed), {});
  await mkdir(path.join(cwd, "src")); await writeFile(path.join(cwd, "src/demo.ts"), "const a = 1;");

  const output = await handleEvent(event(cwd, "PostToolUse", patch("const a = 1;")), {
    lint: async () => { throw new Error("Oxlint is not set up"); },
  });

  assert.match(output.hookSpecificOutput.additionalContext, /not set up/);
});

test("pre-hook does not inspect targets outside the workspace or through symlinks", async () => {
  const cwd = await root(); const outside = await root();
  await symlink(outside, path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");

  for (const file of ["../escape.ts", "linked/escape.ts"]) {
    assert.deepEqual(await handleEvent(event(cwd, "PreToolUse", patch("const a = x as unknown as T;").replace("src/demo.ts", file))), {});
  }
});

test("the configured hook entrypoint executes the Codex adapter", async () => {
  const input = event(await root(), "PreToolUse", patch("type Json = unknown;"));

  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./codex.mjs", import.meta.url))], {
    input: JSON.stringify(input), encoding: "utf8",
  }));

  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
});

test("Codex post hooks report a missing runtime without populating either host's cache", async () => {
  const cwd = await root();
  const cache = await root();
  const text = "export const value = 1;";
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src/demo.ts"), text);

  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./codex.mjs", import.meta.url))], {
    input: JSON.stringify(event(cwd, "PostToolUse", patch(text))),
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: cache, COPILOT_HOME: cache, CODEX_HOME: cache },
  }));

  assert.match(result.hookSpecificOutput.additionalContext, /not set up/);
  assert.deepEqual(await readdir(cache), []);
});
