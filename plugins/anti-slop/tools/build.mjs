import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entries = [
  ["anti-slop", "../../../tools/oxlint/anti-slop/index.ts"],
  ["anti-slop-effect", "../../../tools/oxlint/anti-slop/effect/index.ts"],
];

for (const [name, source] of entries) {
  await build({
    entryPoints: [fileURLToPath(new URL(source, import.meta.url))],
    outfile: fileURLToPath(new URL(`../dist/${name}.mjs`, import.meta.url)),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    legalComments: "inline",
  });
}
