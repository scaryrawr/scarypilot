import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import path from "node:path";

const directory = path.resolve(import.meta.dirname, "..");

const [mode = "check"] = process.argv.slice(2);

if (!["check", "write"].includes(mode)) throw new Error("Usage: check-bundle.mjs <check|write>");

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });

  return (await Promise.all(entries.map((entry) => {
    const file = path.join(root, entry.name);

    return entry.isDirectory() ? walk(file) : [file];
  }))).flat().sort();
}

async function digest(files) {
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [
    path.relative(directory, file).split(path.sep).join("/"),
    createHash("sha256").update((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).digest("hex"),
  ])));
}

const inputs = [
  "extension.mjs", "package.json", "package-lock.json", "tsdown.config.mjs",
  "../../skills/screen-record/scripts/screen-record.mjs",
  "../../skills/screen-record/scripts/windows-enumerate.ps1",
  "../../skills/screen-record/scripts/sapi-narrate.ps1",
].map((file) => path.resolve(directory, file));

inputs.push(...await walk(path.join(directory, "src")));

const outputs = await walk(path.join(directory, "dist"));

if (!outputs.includes(path.join(directory, "dist/extension.mjs"))) throw new Error("Missing dist/extension.mjs");

for (const file of outputs.filter((entry) => entry.endsWith(".mjs"))) {
  const source = await readFile(file, "utf8");

  for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
    const specifier = match[1];

    if (!specifier.startsWith(".") && !specifier.startsWith("node:") &&
      specifier !== "@github/copilot-sdk" && !specifier.startsWith("@github/copilot-sdk/")) {
      throw new Error(`Unbundled runtime dependency ${specifier}`);
    }
  }
}

const lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8"));

for (const [name, version] of Object.entries(lock.packages["node_modules/@github/copilot-sdk"].optionalDependencies)) {
  const platform = lock.packages[`node_modules/${name}`];

  if (platform?.version !== version || !platform.resolved || !platform.integrity) {
    throw new Error(`SDK platform package ${name}@${version} is not fully locked`);
  }
}

const serialized = `${JSON.stringify({ version: 1, inputs: await digest(inputs), outputs: await digest(outputs) }, null, 2)}\n`;

const manifest = path.join(directory, "bundle-manifest.json");

if (mode === "write") await writeManifest(manifest, serialized);
else if ((await readFile(manifest, "utf8")).replace(/\r\n/g, "\n") !== serialized) throw new Error("Stale bundle; run npm run build");

console.log(`screen-record: bundle ${mode === "write" ? "recorded" : "verified"}`);

async function writeManifest(file, contents) {
  let current;

  try {
    current = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const lineEnding = current === undefined ? EOL : current.includes("\r\n") ? "\r\n" : "\n";

  await writeFile(file, contents.replace(/\n/g, lineEnding));
}
