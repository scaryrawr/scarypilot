import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const marketplace = JSON.parse(readFileSync(path.join(root, ".github/plugin/marketplace.json"), "utf8"));
const readme = readFileSync(path.join(root, "README.md"), "utf8");

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
