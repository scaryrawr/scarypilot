import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

const correctedPlugins = ["anti-slop", "better-init", "digivolution", "copilot-autoresearch"];

const agentPluginSchemas = ["1.0.0", "1.1.0"].map(
  (version) => `https://agent-plugins.org/schemas/${version}/plugin.schema.json`,
);

const agentPluginFields = new Set([
  "$schema", "name", "version", "description", "author", "homepage",
  "repository", "license", "keywords", "extensions",
]);

function checkManifestFormat(manifest) {
  if (!agentPluginSchemas.includes(manifest.$schema)) return;

  for (const field of Object.keys(manifest)) {
    assert.ok(agentPluginFields.has(field), `Agent Plugins manifest ignores legacy or unknown field: ${field}`);
  }

  if (manifest.extensions !== undefined) {
    assert.ok(
      manifest.extensions !== null
        && typeof manifest.extensions === "object"
        && !Array.isArray(manifest.extensions),
      "Agent Plugins extensions must be a namespace object, not legacy directory paths",
    );
  }
}

test("Agent Plugins formats reject legacy component registrations", () => {
  for (const $schema of agentPluginSchemas) {
    for (const field of ["skills", "agents", "hooks", "commands", "mcpServers", "lspServers"]) {
      assert.throws(
        () => checkManifestFormat({ $schema, name: "example", [field]: "components/" }),
        new RegExp(field),
      );
    }

    for (const extensions of [["extensions/"], "extensions/", null]) {
      assert.throws(
        () => checkManifestFormat({ $schema, name: "example", extensions }),
        /namespace object/,
      );
    }
  }
});

test("supported legacy paths and conventional Agent Plugins skills need no format conversion", () => {
  assert.doesNotThrow(() => checkManifestFormat({
    name: "legacy-example",
    skills: ["skills/"],
    hooks: "hooks/hooks.json",
    agents: "agents/",
    extensions: ["extensions/"],
  }));

  for (const $schema of agentPluginSchemas) {
    assert.doesNotThrow(() => checkManifestFormat({
      $schema,
      name: "portable-example",
      extensions: { "com.github.copilot": {} },
    }));
  }
});

test("corrected marketplace plugins use compatible manifest formats", async () => {
  const marketplace = JSON.parse(await readFile(path.join(root, ".github", "plugin", "marketplace.json"), "utf8"));

  for (const name of correctedPlugins) {
    const plugin = marketplace.plugins.find((entry) => entry.name === name);

    assert.ok(plugin, `${name}: missing marketplace entry`);
    assert.equal(typeof plugin.source, "string", `${plugin.name}: expected a local marketplace source`);
    const directory = path.resolve(root, plugin.source);
    const file = path.join(directory, "plugin.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));

    assert.equal(manifest.name, plugin.name, file);
    assert.doesNotThrow(() => checkManifestFormat(manifest), file);
  }
});

test("corrected legacy plugins retain their skill and component registrations", async () => {
  for (const name of correctedPlugins) {
    const directory = path.join(root, "plugins", name);
    const manifest = JSON.parse(await readFile(path.join(directory, "plugin.json"), "utf8"));

    assert.equal(manifest.$schema, undefined, `${name}: must retain legacy loading semantics`);
    assert.deepEqual(manifest.skills, ["skills/"], name);

    const skills = await readdir(path.join(directory, "skills"), { withFileTypes: true });

    assert.ok(skills.some((entry) => entry.isDirectory()), `${name}: missing skill directories`);

    for (const entry of skills.filter((entry) => entry.isDirectory())) {
      assert.ok(existsSync(path.join(directory, "skills", entry.name, "SKILL.md")), `${name}/${entry.name}`);
    }

    if (name === "anti-slop") {
      assert.equal(manifest.hooks, "hooks/hooks.json");
      assert.ok(existsSync(path.join(directory, manifest.hooks)));
    } else if (name === "better-init") {
      assert.equal(manifest.agents, "agents/");
      assert.ok(existsSync(path.join(directory, manifest.agents, "repo-instruction-researcher.agent.md")));
    } else {
      assert.deepEqual(manifest.extensions, ["extensions"]);
      assert.ok(existsSync(path.join(directory, "extensions", name, "extension.mjs")));
      const packageRoot = path.join(directory, "extensions", name);
      const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
      const lock = JSON.parse(await readFile(path.join(packageRoot, "package-lock.json"), "utf8"));

      assert.equal(pkg.version, manifest.version, name);
      assert.equal(lock.version, manifest.version, name);
      assert.equal(lock.packages[""].version, manifest.version, name);
    }
  }
});
