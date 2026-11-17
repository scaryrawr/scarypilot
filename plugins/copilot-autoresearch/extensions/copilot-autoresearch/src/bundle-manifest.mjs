import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resources } from "../native/resources.mjs";
import { verifyInstalledResources } from "../native/assemble.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

async function walk(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });

  const files = await Promise.all(entries.map((entry) => {
    const file = `${directory}/${entry.name}`;

    return entry.isDirectory() ? walk(file) : [file];
  }));

  return files.flat().sort();
}

async function digest(files) {
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => {
    const bytes = await readFile(path.join(root, file));
    const content = file.endsWith(".node") ? bytes : bytes.toString("utf8").replace(/\r\n/g, "\n");

    return [file, createHash("sha256").update(content).digest("hex")];
  })));
}

await verifyInstalledResources();

const native = await resources();

const inputs = [
  "extension.mjs", "package.json", "package-lock.json", "tsdown.config.mjs",
  ...await walk("src"), ...native.inputs,
];

const outputs = await walk("dist");

for (const file of outputs.filter((file) => file.endsWith(".mjs"))) {
  const source = await readFile(path.join(root, file), "utf8");

  for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
    const dependency = match[1];

    if (!dependency.startsWith(".") && !dependency.startsWith("node:") &&
        dependency !== "@github/copilot-sdk" && !dependency.startsWith("@github/copilot-sdk/")) {
      throw new Error(`${file} imports unbundled dependency ${dependency}`);
    }

    if (file.endsWith("/cli.mjs") && dependency.startsWith("@github/copilot-sdk")) {
      throw new Error("The standalone CLI cannot depend on the Copilot SDK.");
    }
  }
}

await writeFile(path.join(root, "bundle-manifest.json"),
  `${JSON.stringify({ version: 1, inputs: await digest(inputs), outputs: await digest(outputs) }, null, 2)}\n`);

console.log("Autoresearch extension and CLI bundles recorded.");
