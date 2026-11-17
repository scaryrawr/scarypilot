import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const marketplace = JSON.parse(readFileSync(path.join(root, ".github/plugin/marketplace.json"), "utf8"));
const readme = readFileSync(path.join(root, "README.md"), "utf8");

function confinedPath(directory, relative) {
  assert.equal(typeof relative, "string", "Component paths must be strings");
  assert.ok(!path.isAbsolute(relative), "Component paths must be relative");
  const resolved = realpathSync(path.resolve(directory, relative));
  const local = path.relative(realpathSync(directory), resolved);

  assert.ok(local !== ".." && !local.startsWith(`..${path.sep}`) && !path.isAbsolute(local), "Path leaves its package");

  return resolved;
}

for (const plugin of marketplace.plugins) {
  test(`${plugin.name}: published Copilot manifest and component paths`, () => {
    const directory = path.resolve(root, plugin.source);
    const manifestPath = path.join(directory, "plugin.json");

    assert.ok(existsSync(path.join(directory, "README.md")), "Plugin README is missing");
    assert.ok(readme.includes(`(${plugin.source}/README.md)`), "Plugin is missing from the root README");

    assert.ok(existsSync(manifestPath), "Published plugins must supply plugin.json for CLI discovery");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    assert.equal(manifest.name, plugin.name);
    assert.ok(
      !manifest.$schema?.startsWith("https://agent-plugins.org/"),
      "This marketplace uses Copilot's legacy layout; Agent Plugins schemas change component discovery",
    );

    for (const field of ["skills", "agents", "commands", "hooks", "extensions", "mcpServers", "lspServers"]) {
      if (manifest[field] === undefined) continue;

      const paths = Array.isArray(manifest[field]) ? manifest[field] : [manifest[field]];

      for (const relative of paths) {
        assert.equal(typeof relative, "string", `${field} must name a component path`);
        const component = path.join(directory, relative);
        assert.ok(existsSync(component), `${field}: missing ${relative}`);

        if (["hooks", "mcpServers", "lspServers"].includes(field)) {
          JSON.parse(readFileSync(component, "utf8"));
        } else {
          assert.ok(statSync(component).isDirectory(), `${field}: ${relative} is not a directory`);
        }

        if (field === "extensions") {
          const children = readdirSync(component, { withFileTypes: true }).filter((entry) => entry.isDirectory());
          assert.ok(children.length > 0, "No native extensions found");

          for (const child of children) {
            assert.ok(existsSync(path.join(component, child.name, "extension.mjs")), `${child.name}: missing entrypoint`);
          }
        }
      }
    }

    const mcpPath = path.join(directory, ".mcp.json");

    if (existsSync(mcpPath)) {
      const servers = JSON.parse(readFileSync(mcpPath, "utf8"));
      assert.ok(!Object.hasOwn(servers, "mcpServers"), "Copilot MCP configuration uses top-level server names");
      assert.ok(Object.keys(servers).length > 0, "MCP configuration is empty");
    }
  });
}

test("Codex publications use native manifests and share overlapping plugin roots", () => {
  const codex = JSON.parse(readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
  const copilotRoots = new Map(marketplace.plugins.map((entry) => [entry.name, entry.source]));
  const copilotDirectories = new Set([...copilotRoots.values()].map((relative) => confinedPath(root, relative)));
  const names = new Set();

  assert.equal(codex.name, "scarypilot");
  assert.ok(codex.plugins.length > 0, "Codex inventory is empty");
  const baseline = JSON.parse(readFileSync(path.join(root, "docs/scarydex-marketplace.json"), "utf8"));

  for (const entry of baseline.plugins.filter((plugin) => plugin.name !== "riverkids")) {
    assert.ok(codex.plugins.some((plugin) => plugin.name === entry.name), `Missing imported Codex plugin: ${entry.name}`);
  }

  for (const entry of codex.plugins) {
    assert.ok(!names.has(entry.name), `Duplicate Codex publication: ${entry.name}`);
    names.add(entry.name);
    assert.equal(entry.source.source, "local");
    const directory = confinedPath(root, entry.source.path);
    const manifest = JSON.parse(readFileSync(path.join(directory, ".codex-plugin/plugin.json"), "utf8"));

    assert.equal(manifest.name, entry.name);
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
    assert.ok(manifest.description);
    assert.ok(!manifest.extensions && !manifest.agents && !manifest.mcpServers, "Codex must not register Copilot components");
    assert.ok(existsSync(path.join(directory, "README.md")));
    assert.ok(readme.includes(`(${entry.source.path}/README.md)`), `${entry.name} is missing from README`);
    const skills = confinedPath(directory, manifest.skills);
    const skillDirectories = readdirSync(skills, { withFileTypes: true }).filter((item) => item.isDirectory());

    assert.ok(skillDirectories.length > 0, `${entry.name} has no skills`);

    for (const skill of skillDirectories) {
      const text = readFileSync(confinedPath(skills, `${skill.name}/SKILL.md`), "utf8");

      assert.match(text, /^---\r?\n/);
      assert.ok(text.includes(`name: ${skill.name}\n`), `${entry.name}/${skill.name} has mismatched metadata`);
    }

    if (copilotRoots.has(entry.name)) {
      assert.equal(directory, confinedPath(root, copilotRoots.get(entry.name)), `${entry.name} must not fork its skill tree`);
    }

    if (copilotDirectories.has(directory)) {
      const copilot = JSON.parse(readFileSync(path.join(directory, "plugin.json"), "utf8"));
      const sharedSkills = Array.isArray(copilot.skills) ? copilot.skills : [copilot.skills];

      assert.ok(sharedSkills.some((relative) => confinedPath(directory, relative) === skills));

      if (manifest.hooks && !copilot.hooks) {
        assert.ok(!existsSync(path.join(directory, "hooks/hooks.json")), `${entry.name}: Copilot would auto-discover Codex hooks`);
      }
    }

    if (manifest.hooks) {
      const hooks = JSON.parse(readFileSync(confinedPath(directory, manifest.hooks), "utf8")).hooks;

      for (const [event, rules] of Object.entries(hooks)) {
        assert.ok(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionEnd"].includes(event));

        for (const rule of rules) {
          if (rule.matcher) {
            const matcher = new RegExp(rule.matcher);

            assert.ok(rule.matcher.startsWith("^") && rule.matcher.endsWith("$"), "Tool matchers must be anchored");

            for (const unrelated of ["UnrelatedBash", "BashExtra", "not_apply_patch", "apply_patch_extra"]) {
              assert.equal(matcher.test(unrelated), false, `${entry.name} matches unrelated tool ${unrelated}`);
            }
          }

          for (const handler of rule.hooks) {
            assert.equal(handler.type, "command");
            const command = /^node "\$\{PLUGIN_ROOT\}\/([^"\n]+)"$/.exec(handler.command);

            assert.ok(command, "Codex hook must invoke a portable package-local helper");
            confinedPath(directory, command[1]);
            assert.ok(handler.timeout > 0 && handler.timeout <= 120);
          }
        }
      }
    }
  }
});

test("native decision and experiment publication aliases share their implementation roots", () => {
  const codex = JSON.parse(readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));

  for (const [codexName, copilotName] of [["decide", "omlx-decisions"], ["autoresearch", "copilot-autoresearch"]]) {
    const codexEntry = codex.plugins.find((entry) => entry.name === codexName);
    const copilotEntry = marketplace.plugins.find((entry) => entry.name === copilotName);
    assert.ok(codexEntry, `Missing Codex publication ${codexName}`);
    assert.ok(copilotEntry, `Missing Copilot publication ${copilotName}`);
    assert.equal(confinedPath(root, codexEntry.source.path), confinedPath(root, copilotEntry.source));
  }
});
