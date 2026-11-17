import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const checking = process.argv.includes("--check");

const bundles = [
  ["tools/entries/orch.mjs", "skills/poteto-mode/scripts/orch/orch.mjs"],
  ["tools/entries/watch-pr.mjs", "skills/poteto-mode/scripts/watch-pr/watch-pr.mjs"],
  ["skills/statechart/scripts/statechart.ts", "skills/statechart/scripts/statechart.mjs"],
  ["skills/statechart/scripts/worker.ts", "skills/statechart/scripts/worker.mjs"],
];

const inputs = new Set(["build.mjs", "package.json", "package-lock.json"]);
const files = new Map();
const digest = (bytes) => createHash("sha256").update(Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

for (const [entry, outfile] of bundles) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    legalComments: "linked",
    metafile: true,
    write: false,
  });

  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.split("/").includes("node_modules")) inputs.add(input);
  }

  for (const output of result.outputFiles) {
    const path = relative(root, output.path).split("\\").join("/");
    files.set(path, digest(output.contents));

    if (checking) {
      assert.equal(digest(await readFile(output.path)), digest(output.contents), `Stale bundle ${path}`);
    } else {
      await writeFile(output.path, output.contents);
    }
  }
}

for (const input of inputs) files.set(input, digest(await readFile(resolve(root, input))));

const manifest = { version: 1, files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))) };
const manifestPath = resolve(root, "bundle-manifest.json");

if (checking) {
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), manifest, "Bundle input manifest is stale");
  console.log("pstack bundles match current shared sources");
} else {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("Built pstack worker, watcher, and statechart bundles");
}
