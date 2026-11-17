import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const scripts = dirname(dirname(fileURLToPath(import.meta.url)));
const node = process.versions.bun ? "node" : process.execPath;
const labels = 'export const labels = ["Off", "On"];\n';

const dot = `strict digraph DiskGraph {
1 [label="/\\\\ on = FALSE",style = filled]
2 [label="/\\\\ on = TRUE"]
1 -> 2 [label="On"];
2 -> 1 [label="Off"];
}`;

const broken = `Error: Invariant Safe is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
on = FALSE

State 2: <On line 4, col 1 to line 4, col 16 of module Lamp>
on = TRUE

Model checking completed.
`;

function fixture(t, { bugs = false } = {}) {
  const dir = mkdtempSync(join(process.cwd(), ".statechart-mapping-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  writeFileSync(join(dir, "Lamp.tla"),
    "---- MODULE Lamp ----\nVARIABLE on\nInit == on = FALSE\nOn == on' = TRUE\nOff == on' = FALSE\nSpec == Init /\\ [][On \\/ Off]_on\nSafe == ~on\n====\n");
  writeFileSync(join(dir, "Lamp.cfg"), `SPECIFICATION Spec\n${bugs ? "INVARIANT Safe\n" : ""}`);
  writeFileSync(join(dir, "lamp.mmd"),
    "stateDiagram-v2\n[*] --> Off\nOff --> On : you flip the switch\nOn --> Off : you flip the switch\n");
  writeFileSync(join(dir, "labels.mjs"), labels);
  writeFileSync(join(dir, "exports.mjs"), 'export { labels } from "./labels.mjs";\n');
  writeFileSync(join(dir, "Lamp.map.mjs"), `import { labels } from "./exports.mjs";
export const state = (v) => labels[Number(v.on)];
export const step = () => "you flip the switch";
export const detail = state;
`);
  const java = join(dir, "java");
  writeFileSync(java, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const target = new URL("./labels.mjs", import.meta.url);
if (process.env.MAPPING_MUTATION === "before-tlc") {
  const original = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, original + "// changed during TLC\\n");
  fs.writeFileSync(target, original);
}
const dump = args.indexOf("-dump");
if (dump !== -1) fs.writeFileSync(args[dump + 2], ${JSON.stringify(dot)});
console.log(${JSON.stringify(bugs ? broken : "Model checking completed. No error has been found.")});
`, { mode: 0o755 });
  const jar = join(dir, "tla2tools.jar");
  writeFileSync(jar, "");

  return {
    dir,
    run(mode = "from-spec", mutation = "") {
      return spawnSync(node, [
        join(scripts, "statechart.mjs"),
        mode,
        mode === "from-chart" ? "lamp.mmd" : "Lamp.tla",
      ], {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          JAVA: java,
          TLA2TOOLS: jar,
          TMPDIR: scratch,
          MAPPING_MUTATION: mutation,
        },
      });
    },
  };
}

function outputFiles(dir) {
  const root = join(dir, "Lamp-statechart");
  const files = [];

  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);

      if (entry.isDirectory()) visit(file);
      else files.push([relative(root, file), readFileSync(file, "base64")]);
    }
  };

  visit(root);

  return files.sort(([a], [b]) => a.localeCompare(b));
}

for (const mode of ["from-spec", "from-chart"]) {
  test(`${mode} snapshots transitive reexported mapping inputs before TLC`, (t) => {
    const f = fixture(t);
    const first = f.run(mode);
    assert.equal(first.status, 0, first.stderr);
    const before = outputFiles(f.dir);
    const changed = f.run(mode, "before-tlc");
    assert.equal(changed.status, 2, changed.stderr);
    assert.match(changed.stderr, /labels\.mjs changed while this run read it/);
    assert.equal(readFileSync(join(f.dir, "labels.mjs"), "utf8"), labels);
    assert.deepEqual(outputFiles(f.dir), before);
  });
}

test("chart subprocess mapping imports are fingerprinted before their evaluation", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "child-only.mjs"), `import fs from "node:fs";
export const labels = ["Off", "On"];
if (process.env.MAPPING_MUTATION)
  fs.appendFileSync(new URL("./child-only.mjs", import.meta.url), "// changed after loading\\n");
`);
  writeFileSync(join(f.dir, "Lamp.map.mjs"), `
const { labels } = process.argv.includes("--dot")
  ? await import("./child-only.mjs")
  : { labels: ["Off", "On"] };
export const state = (v) => labels[Number(v.on)];
export const step = () => "you flip the switch";
`);
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const before = outputFiles(f.dir);
  const changed = f.run("from-spec", "child");
  assert.equal(changed.status, 2, changed.stderr);
  assert.match(changed.stderr, /child-only\.mjs changed while this run read it/);
  assert.deepEqual(outputFiles(f.dir), before);
});

test("chart subprocesses return dependency evidence larger than the default stdout buffer", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "labels.mjs"), `${labels}// ${"label words ".repeat(100_000)}\n`);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test("callback dynamic imports and their reexports retain observations across bug chart subprocesses", (t) => {
  const f = fixture(t, { bugs: true });
  writeFileSync(join(f.dir, "callback-leaf.mjs"), 'export const label = "seen";\n');
  writeFileSync(join(f.dir, "callback.mjs"), `export { label } from "./callback-leaf.mjs";
import fs from "node:fs";
if (process.env.MAPPING_MUTATION && process.argv.includes("--summary"))
  fs.appendFileSync(new URL("./callback-leaf.mjs", import.meta.url), "// changed after overview\\n");
`);
  writeFileSync(join(f.dir, "Lamp.map.mjs"), `
export function state(v) {
  import("./callback.mjs");
  return v.on ? "On" : "Off";
}
export const detail = state;
export const step = () => "you flip the switch";
`);
  const first = f.run();
  assert.equal(first.status, 1, first.stderr);
  const before = outputFiles(f.dir);
  assert.ok(before.some(([name]) => name === "bug-1-developer.mmd"));
  const changed = f.run("from-spec", "callback");
  assert.equal(changed.status, 2, changed.stderr);
  assert.match(changed.stderr, /callback-leaf\.mjs changed while this run read it/);
  assert.deepEqual(outputFiles(f.dir), before);
});

test("mapping loader follows computed dynamic imports without treating JavaScript text as imports", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "Lamp.map.mjs"), `
// import "./missing-comment.mjs"
const text = 'import "./missing-string.mjs"';
export async function state() {
  return (await import(new URL("./exports.mjs", import.meta.url))).labels[0] + text.length;
}
`);
  const loader = pathToFileURL(join(scripts, "mapping-loader.mjs")).href;

  const result = spawnSync(node, ["--input-type=module", "-e", `
import assert from "node:assert/strict";
import { loadMapping, fingerprint, mergeMappingInputs } from ${JSON.stringify(loader)};
const inputs = new Map();
const mapping = await loadMapping("./Lamp.map.mjs", inputs);
await mapping.state();
assert.deepEqual([...inputs.keys()].map(file => file.slice(file.lastIndexOf("/") + 1)).sort(),
  ["Lamp.map.mjs", "exports.mjs", "labels.mjs"]);
for (const [file, observed] of inputs) assert.equal(fingerprint(file), observed);
const file = [...inputs.keys()][0];
const original = inputs.get(file);
mergeMappingInputs(inputs, [[file, "another observation"]]);
mergeMappingInputs(inputs, [[file, original]]);
assert.notEqual(inputs.get(file), original);
`], { cwd: f.dir, encoding: "utf8", timeout: 30_000 });

  assert.equal(result.status, 0, result.stderr);
});

test("mapping loader observes symlinked mappings and the paths used to import dependencies", (t) => {
  const f = fixture(t);
  renameSync(join(f.dir, "labels.mjs"), join(f.dir, "original.mjs"));
  symlinkSync("original.mjs", join(f.dir, "labels.mjs"));
  symlinkSync("Lamp.map.mjs", join(f.dir, "alias.map.mjs"));
  writeFileSync(join(f.dir, "replacement.mjs"), labels);
  const loader = pathToFileURL(join(scripts, "mapping-loader.mjs")).href;

  const result = spawnSync(node, ["--input-type=module", "-e", `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadMapping, fingerprint } from ${JSON.stringify(loader)};
const inputs = new Map();
const mapping = await loadMapping("./alias.map.mjs", inputs);
assert.equal(mapping.state({on: false}), "Off");
for (const name of ["alias.map.mjs", "Lamp.map.mjs", "exports.mjs", "labels.mjs", "original.mjs"])
  assert.ok(inputs.has(path.resolve(name)), name);
const file = path.resolve("labels.mjs");
fs.unlinkSync(file);
fs.symlinkSync("replacement.mjs", file);
assert.notEqual(fingerprint(file), inputs.get(file));
`], { cwd: f.dir, encoding: "utf8", timeout: 30_000 });

  assert.equal(result.status, 0, result.stderr);
});
