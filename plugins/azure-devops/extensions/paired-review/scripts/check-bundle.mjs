import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const distDirectory = path.join(root, "dist");
const extensionBundle = path.join(distDirectory, "extension.mjs");
const publicDirectory = path.join(root, "public");

const distFiles = (await walk(distDirectory)).filter((file) => file.endsWith(".mjs"));
for (const file of distFiles) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    const allowed =
      specifier.startsWith(".") ||
      specifier.startsWith("node:") ||
      specifier.startsWith("@github/copilot-sdk");
    if (!allowed) {
      throw new Error(`Extension bundle still imports runtime dependency ${specifier}`);
    }
  }
}

const publicFiles = await walk(publicDirectory);
if (publicFiles.length > 4) {
  throw new Error(`Expected a compact frontend bundle, found ${publicFiles.length} files`);
}
if (!publicFiles.some((file) => file.endsWith("/assets/app.js"))) {
  throw new Error("Frontend entry bundle is missing");
}

const totalBytes = (
  await Promise.all([
    ...distFiles.map((file) => stat(file).then((value) => value.size)),
    ...publicFiles.map((file) => stat(file).then((value) => value.size)),
  ])
).reduce((total, size) => total + size, 0);

console.log(
  `Self-contained bundle verified: ${publicFiles.length + distFiles.length + 1} files, ${formatBytes(totalBytes)}`,
);

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

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
