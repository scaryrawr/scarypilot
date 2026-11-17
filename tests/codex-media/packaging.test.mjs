import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const plugins = fileURLToPath(new URL("../../plugins/", import.meta.url));
const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

for (const name of ["omlx-media", "screen-record"]) {
  test(`${name} manifests share skills and installed CLI works without SDK, source or node_modules`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "installed-media-"));
    roots.push(root);
    const installed = path.join(root, "plugin with spaces");
    await cp(path.join(plugins, name), installed, {
      recursive: true,
      filter: (source) => !["node_modules", "src", "tests"].includes(path.basename(source)),
    });
    const copilot = JSON.parse(await readFile(path.join(installed, "plugin.json"), "utf8"));
    const codex = JSON.parse(await readFile(path.join(installed, ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(codex.repository, "https://github.com/scaryrawr/scarypilot");
    assert.equal(codex.interface.developerName, "ScaryPilot");
    assert.equal(codex.version, copilot.version);
    assert.equal(await realpath(path.resolve(installed, codex.skills)),
      await realpath(path.resolve(installed, copilot.skills[0])));

    const script = name === "omlx-media" ? path.join(installed, "scripts", "media.mjs")
      : path.join(installed, "skills", "screen-record", "scripts", "screen-record.mjs");

    const result = spawnSync(process.execPath, [script, "--help"], {
      cwd: root, encoding: "utf8", timeout: 5000,
      env: { ...process.env, PATH: "", NODE_OPTIONS: "", NODE_PATH: "" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  });
}
