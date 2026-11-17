import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("committed helper bundles and their shared source inputs match the recorded hashes", () => {
  const manifest = JSON.parse(readFileSync(join(root, "bundle-manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);

  for (const [file, expected] of Object.entries(manifest.files)) {
    const text = readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(text).digest("hex"), expected, file);
  }
});

test("portable rebuild accepts CRLF source and bundle copies", (t) => {
  const stage = mkdtempSync(join(tmpdir(), "pstack-crlf-"));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(root, "bundle-manifest.json"), "utf8"));

  for (const file of [...Object.keys(manifest.files), "bundle-manifest.json"]) {
    const destination = join(stage, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(root, file), "utf8").replace(/\r?\n/g, "\r\n"));
  }

  cpSync(join(root, "node_modules"), join(stage, "node_modules"), { recursive: true });

  const result = spawnSync(process.execPath, [join(stage, "build.mjs"), "--check"], {
    cwd: stage, encoding: "utf8", timeout: 30000,
  });

  assert.equal(result.status, 0, result.stderr);
});

test("installed worker and watcher bundles run without source or package dependencies", (t) => {
  const stage = mkdtempSync(join(tmpdir(), "pstack-bundle-"));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const orch = join(stage, "orch.mjs");
  const watcher = join(stage, "watch-pr.mjs");
  copyFileSync(join(root, "skills/poteto-mode/scripts/orch/orch.mjs"), orch);
  copyFileSync(join(root, "skills/poteto-mode/scripts/watch-pr/watch-pr.mjs"), watcher);

  for (const file of [orch, watcher]) {
    const help = spawnSync(process.execPath, [file, "--help"], { cwd: stage, encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
  }

  const store = join(stage, "store");

  const invoke = (...args) => spawnSync(process.execPath, [orch, "--store", store, "--json", ...args], {
    cwd: stage,
    encoding: "utf8",
  });

  assert.equal(invoke("init").status, 0);
  const added = invoke("unit", "add", "cache", "--track", "backend");
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).id, "cache");

  const recorded = invoke("ledger", "record", "42", "abc123", "unit-test-verified", "--evidence", "tests.log");
  assert.equal(recorded.status, 0, recorded.stderr);
  const checked = invoke("ledger", "check", "42", "abc123");
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).verdict, "unit-test-verified");
  const missingHead = invoke("ledger", "check", "42", "another-head");
  assert.equal(missingHead.status, 2);
  assert.deepEqual(JSON.parse(missingHead.stdout), {
    pr: "42",
    sha: "another-head",
    verdict: "NOT-VERIFIED",
  });
});

test("installed statechart bundle replays committed TLC evidence through its bundled worker", {
  skip: process.platform === "win32" ? "POSIX process supervision is required" : false,
}, (t) => {
  const stage = mkdtempSync(join(tmpdir(), "pstack-statechart-bundle-"));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const scripts = join(root, "skills/statechart/scripts");

  for (const name of ["statechart.mjs", "worker.mjs"]) copyFileSync(join(scripts, name), join(stage, name));

  const fixture = join(scripts, "test/corpus/Login");
  const out = join(stage, "out");

  const result = spawnSync(process.execPath, [
    join(stage, "statechart.mjs"),
    join(fixture, "Login.tla"),
    "--view", join(fixture, "view.mjs"),
    "--out", out,
  ], {
    cwd: stage,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      JAVA: join(scripts, "test/java.ts"),
      TLA2TOOLS: "replayed-tlc-fixture.jar",
      STATECHART_REPLAY: fixture,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(out, "report.md"), "utf8"), readFileSync(join(fixture, "report.md"), "utf8"));
  assert.equal(readFileSync(join(out, "chart.mmd"), "utf8"), readFileSync(join(fixture, "chart.mmd"), "utf8"));
});
