import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const script = fileURLToPath(new URL("../skills/show-me-your-work/scripts/log.mjs", import.meta.url));

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".pstack-log café "));
  directories.push(root);

  return join(root, "雪 path", "decision log.tsv");
}

function log(path, cells) {
  return spawnSync(process.execPath, [script, path, ...cells], { encoding: "utf8" });
}

test("creates an append-only TSV in paths with spaces and Unicode", () => {
  const path = fixture();
  assert.equal(log(path, ["phase", "=formula\tvalue\nnext\rline", "+why", "-evidence", "@result"]).status, 0);
  const first = readFileSync(path, "utf8");
  assert.match(first, /^ts\tphase\tdecision\twhy\tevidence\tresult\n\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\t/);
  assert.equal(first.split("\n")[1].split("\t").slice(1).join("\t"),
    "phase\t'=formula value next line\t'+why\t'-evidence\t'@result");
  assert.equal(log(path, ["next", "safe", "why", "evidence", "result"]).status, 0);
  const second = readFileSync(path, "utf8");
  assert.ok(second.startsWith(first));
  assert.equal(second.match(/ts\tphase\tdecision\twhy\tevidence\tresult/g).length, 1);
  assert.equal(second.trimEnd().split("\n").length, 3);
});

test("adds a header to an existing empty file, not a populated log", () => {
  const path = fixture();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  assert.equal(log(path, ["a", "b", "c", "d", "e"]).status, 0);
  assert.ok(readFileSync(path, "utf8").startsWith("ts\t"));
  writeFileSync(path, "existing rows\n");
  assert.equal(log(path, ["a", "b", "c", "d", "e"]).status, 0);
  assert.ok(readFileSync(path, "utf8").startsWith("existing rows\n"));
  assert.ok(!readFileSync(path, "utf8").includes("ts\tphase"));
});

test("rejects invalid argument counts without creating a log", () => {
  const result = log(fixture(), ["too few"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: node log.mjs/);
});
