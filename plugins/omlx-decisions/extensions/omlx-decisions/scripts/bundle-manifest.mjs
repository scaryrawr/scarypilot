import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] ?? "check";

if (!["write", "check"].includes(mode) || process.argv.length > 3) {
  throw new Error("Usage: node scripts/bundle-manifest.mjs <check|write>");
}

async function walk(relative) {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });

  const nested = await Promise.all(entries.map((entry) => {
    const file = path.posix.join(relative, entry.name);

    return entry.isDirectory() ? walk(file) : [file];
  }));

  return nested.flat().sort();
}

async function digest(files) {
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [
    file,
    createHash("sha256").update((await readFile(path.join(directory, file), "utf8")).replace(/\r\n/g, "\n")).digest("hex"),
  ])));
}

const inputs = ["extension.mjs", "package.json", "package-lock.json", "tsdown.config.mjs", ...await walk("src")];
const outputs = await walk("dist");

assert.ok(outputs.includes("dist/extension.mjs") && outputs.includes("dist/cli.mjs"));

for (const file of outputs.filter((file) => file.endsWith(".mjs"))) {
  const source = await readFile(path.join(directory, file), "utf8");

  for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    assert.ok(specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("@github/copilot-sdk/") || specifier === "@github/copilot-sdk",
      `Unbundled runtime import ${specifier} in ${file}`);
  }
}

const manifest = { version: 1, inputs: await digest(inputs), outputs: await digest(outputs) };
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
const file = path.join(directory, "bundle-manifest.json");

if (mode === "write") await writeFile(file, serialized);
else assert.equal((await readFile(file, "utf8")).replace(/\r\n/g, "\n"), serialized, "Stale bundle. Run npm run build.");

console.log(`omlx-decisions bundle ${mode === "write" ? "recorded" : "verified"}`);
