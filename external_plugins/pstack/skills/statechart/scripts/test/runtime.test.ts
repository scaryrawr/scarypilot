import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { check, requirePosix } from "../run.ts";

const cli = path.join(import.meta.dirname, "../statechart.ts");
const login = path.join(import.meta.dirname, "corpus/Login/Login.tla");

test("the compiler explicitly rejects Windows process supervision", () => {
  assert.throws(() => requirePosix("win32"), /POSIX.*Windows is not supported/);
});

test("the Windows CLI fails before creating output or importing a view", {
  skip: process.platform !== "win32" && "Windows-only CLI check",
}, () => {
  const result = spawnSync(process.execPath, [cli, login, "--view", "missing-view.mjs"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Windows is not supported/);
  assert.doesNotMatch(result.stderr, /Cannot find module/);
});

test("missing TLC fails explicitly without invoking a provisioner", {
  skip: process.platform === "win32" && "POSIX runtime only",
}, async () => {
  const jar = process.env.TLA2TOOLS;
  delete process.env.TLA2TOOLS;

  try {
    await assert.rejects(check(login, login.replace(/\.tla$/, ".cfg")), /Cannot find TLC.*approval/);
  } finally {
    if (jar === undefined) delete process.env.TLA2TOOLS;
    else process.env.TLA2TOOLS = jar;
  }
});

test("the CLI keeps existing output and never installs missing TLC or Java", {
  skip: process.platform === "win32" && "POSIX runtime only",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statechart-prerequisites-"));

  try {
    const out = path.join(dir, "out");
    const attempted = path.join(dir, "attempted-install");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);

    for (const command of ["mise", "npm", "curl"])
      fs.writeFileSync(path.join(bin, command), `#!/bin/sh\n: > "${attempted}"\nexit 99\n`, {
        mode: 0o755,
      });
    const env = { ...process.env, PATH: bin, TLA2TOOLS: "", JAVA: path.join(dir, "no-java") };

    const missingTlc = spawnSync(process.execPath, [cli, login, "--out", out], {
      encoding: "utf8", env,
    });

    assert.equal(missingTlc.status, 2);
    assert.match(missingTlc.stderr, /Cannot find TLC.*approval/);
    assert.equal(fs.existsSync(out), false);

    const missingJava = spawnSync(process.execPath, [cli, login, "--out", out], {
      encoding: "utf8", env: { ...env, TLA2TOOLS: path.join(dir, "existing.jar") },
    });

    assert.equal(missingJava.status, 2);
    assert.match(missingJava.stderr, /Cannot start Java.*no-java ENOENT.*approval/);
    assert.equal(fs.existsSync(out), false);

    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "keep"), "original output");

    const occupied = spawnSync(process.execPath, [cli, login, "--out", out], {
      encoding: "utf8", env,
    });

    assert.equal(occupied.status, 2);
    assert.match(occupied.stderr, /not empty/);
    assert.equal(fs.readFileSync(path.join(out, "keep"), "utf8"), "original output");
    assert.equal(fs.existsSync(attempted), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("required TLC mode cannot silently skip when the jar is missing", () => {
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "run-tests.mjs")], {
    encoding: "utf8",
    env: { ...process.env, PSTACK_REQUIRE_TLC: "1", TLA2TOOLS: "" },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PSTACK_REQUIRE_TLC=1 requires/);
});
