import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const marketplace = JSON.parse(await readFile(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
const expected = new Set();

for (const plugin of marketplace.plugins) {
  const directory = path.resolve(root, plugin.source.path);
  const manifest = JSON.parse(await readFile(path.join(directory, ".codex-plugin/plugin.json"), "utf8"));

  for (const entry of await readdir(path.resolve(directory, manifest.skills), { withFileTypes: true })) {
    if (entry.isDirectory()) expected.add(`${plugin.name}:${entry.name}`);
  }
}

const home = await mkdtemp(path.join(os.tmpdir(), "scarypilot-codex-home-"));

const env = { ...process.env, CODEX_HOME: home };

let server;

try {
  for (const args of [["plugin", "marketplace", "add", root, "--json"],
    ...marketplace.plugins.map(({ name }) => ["plugin", "add", `${name}@${marketplace.name}`, "--json"])]) {
    const result = spawnSync("codex", args, { env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    if (output.pluginId) assert.equal(output.marketplaceName, marketplace.name);
  }

  server = spawn("codex", ["app-server", "--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", diagnostics = "", nextId = 0;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }

    pending.clear();
  };

  server.on("error", rejectPending);
  server.on("exit", (code, signal) => rejectPending(new Error(`Codex server exited with ${code ?? signal}: ${diagnostics}`)));
  server.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;

    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let value;

      try { value = JSON.parse(line); } catch {
        rejectPending(new Error(`Codex server emitted non-JSON output: ${line.slice(0, 200)}`));
        continue;
      }

      const request = pending.get(value.id);

      if (!request) continue;
      pending.delete(value.id); clearTimeout(request.timer);

      if (value.error) request.reject(new Error(JSON.stringify(value.error)));
      else request.resolve(value.result);
    }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}\n${diagnostics}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  await rpc("initialize", { clientInfo: { name: "scarypilot-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const result = await rpc("skills/list", { cwds: [root], forceReload: true });
  const entry = result.data.find((entry) => path.resolve(entry.cwd) === path.resolve(root));
  assert.ok(entry, "Codex did not return skills for the checkout");
  assert.deepEqual(entry.errors, []);
  const installed = entry.skills.filter((skill) => skill.path.includes(home) && path.relative(home, skill.path).split(path.sep).includes("plugins"));
  assert.deepEqual(new Set(installed.map((skill) => skill.name)), expected, "Installed skills differ from the native inventory");
  assert.equal(installed.length, expected.size, "Duplicate installed skills");

  console.log(`Codex installed ${marketplace.plugins.length} plugins and discovered ${expected.size} skills in an isolated home without model requests.`);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await exited;
  }

  await rm(home, { recursive: true, force: true });
}
