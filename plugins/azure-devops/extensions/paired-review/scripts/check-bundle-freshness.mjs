import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "write" && mode !== "check") {
  throw new Error("Usage: check-bundle-freshness.mjs <write|check>");
}

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, "bundle-manifest.json");
const inputs = [
  "index.html",
  "package.json",
  "tsconfig.frontend.json",
  "tsconfig.json",
  "tsdown.config.ts",
  "vite.config.ts",
  ...(await walk(path.join(root, "src"))),
];
const outputs = [
  ...(await walk(path.join(root, "dist"))),
  ...(await walk(path.join(root, "public"))),
];
const manifest = {
  version: 1,
  inputs: await digestFiles(inputs),
  outputs: await digestFiles(outputs),
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (mode === "write") {
  await writeFile(manifestPath, serialized);
  console.log("Recorded paired-review bundle manifest");
} else {
  const recorded = await readFile(manifestPath, "utf8");
  if (recorded !== serialized) {
    throw new Error("Paired-review bundle is stale; run npm run build and commit the generated artifacts.");
  }
  console.log("Paired-review bundle matches its recorded inputs");
}

async function digestFiles(files) {
  return Object.fromEntries(
    await Promise.all(
      files.sort().map(async (file) => {
        const absolutePath = path.isAbsolute(file) ? file : path.join(root, file);
        const relativePath = path.relative(root, absolutePath);
        const digest = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
        return [relativePath, digest];
      }),
    ),
  );
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(fullPath) : [fullPath];
    }),
  );
  return files.flat();
}
