import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const extensions = [
  "external_plugins/pstack/extensions/pstack",
  "plugins/ado-codespaces/extensions/ado-codespaces",
  "plugins/copilot-autoresearch/extensions/copilot-autoresearch",
  "plugins/copilot-local-llm/extensions/copilot-local-llm",
  "plugins/digivolution/extensions/digivolution",
  "plugins/omlx-media/extensions/omlx-media",
];

const [mode = "check", selected] = process.argv.slice(2);

if (!["check", "write"].includes(mode) || (selected && !extensions.includes(selected))) {
  throw new Error("Usage: node tools/check-extension-bundles.mjs <check|write> [extension path]");
}

const discovered = [];

for (const parent of ["plugins", "external_plugins"]) {
  for (const plugin of await readdir(path.join(root, parent), { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;

    const extensionRoot = path.join(root, parent, plugin.name, "extensions");

    if (!existsSync(extensionRoot)) continue;

    for (const entry of await readdir(extensionRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(extensionRoot, entry.name, "extension.mjs"))) {
        discovered.push(path.relative(root, path.join(extensionRoot, entry.name)));
      }
    }
  }
}

const expected = [...extensions, "plugins/azure-devops/extensions/paired-review"];

if (JSON.stringify(discovered.sort()) !== JSON.stringify(expected.sort())) {
  throw new Error(`Extension inventory changed: expected ${expected}, found ${discovered}`);
}

for (const extension of selected ? [selected] : extensions) {
  const directory = path.join(root, extension);

  const inputs = [
    "extension.mjs",
    "package.json",
    "tsdown.config.mjs",
    ...(await walk(path.join(directory, "src"))).map((file) => path.relative(directory, file)),
  ];

  if (existsSync(path.join(directory, "package-lock.json"))) inputs.push("package-lock.json");

  if (extension.startsWith("external_plugins/pstack/")) {
    inputs.push(
      "../../skills/poteto-mode/scripts/plan-rules.mjs",
      "../../skills/poteto-mode/scripts/orch/store.ts",
    );
  }

  const outputs = await walk(path.join(directory, "dist"));

  if (!outputs.length || !outputs.includes(path.join(directory, "dist", "extension.mjs"))) {
    throw new Error(`${extension}: missing dist/extension.mjs; run npm run build`);
  }

  for (const file of outputs.filter((entry) => entry.endsWith(".mjs"))) {
    const source = await readFile(file, "utf8");

    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1];

      if (
        !specifier.startsWith(".") &&
        !specifier.startsWith("node:") &&
        specifier !== "@github/copilot-sdk" &&
        !specifier.startsWith("@github/copilot-sdk/")
      ) {
        throw new Error(`${extension}: ${file} imports unbundled runtime dependency ${specifier}`);
      }
    }
  }

  const manifest = {
    version: 1,
    inputs: await digest(inputs.map((file) => path.resolve(directory, file)), directory),
    outputs: await digest(outputs, directory),
  };

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(directory, "bundle-manifest.json");

  if (mode === "write") {
    await writeFile(manifestPath, serialized);
  } else if ((await readFile(manifestPath, "utf8")) !== serialized) {
    throw new Error(`${extension}: stale bundle; run npm run build and commit dist/ and bundle-manifest.json`);
  }

  console.log(`${extension}: bundle ${mode === "write" ? "recorded" : "verified"}`);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  const children = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);

    return entry.isDirectory() ? walk(file) : [file];
  }));

  return children.flat().sort();
}

async function digest(files, directory) {
  return Object.fromEntries(
    await Promise.all(files.sort().map(async (file) => [
      path.relative(directory, file).split(path.sep).join("/"),
      createHash("sha256").update((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).digest("hex"),
    ])),
  );
}
