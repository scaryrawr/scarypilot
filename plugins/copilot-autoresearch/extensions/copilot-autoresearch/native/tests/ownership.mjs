import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { machine } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inventory, packageRoot, peMachine, verifyArtifact } from "../verify-artifact.mjs";

assert.equal(process.platform, "win32", "Native ownership proof must run on Windows, not a platform seam");

assert.ok(["x64", "arm64"].includes(process.arch), "Require a supported native Node architecture");

assert.equal(process.arch, process.env.OWNERSHIP_EXPECT_ARCH, "CI must explicitly select the matching native Windows/Node architecture");

const nativeMachine = machine().toLowerCase();

assert.ok(process.arch === "arm64" ? ["arm64", "aarch64"].includes(nativeMachine) : ["x86_64", "amd64"].includes(nativeMachine),
  "A cross-built artifact must be tested on its corresponding native Windows machine");

assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Require Node 22+");

const artifact = await verifyArtifact(process.arch);

const binary = path.join(artifact.directory, inventory.binary);

const require = createRequire(import.meta.url);

const addon = require(binary);

assert.equal(addon.nodeApiVersion, 8);

assert.equal(addon.testOnly, true);

const bash = process.env.OWNERSHIP_BASH_EXE;

assert.ok(bash && path.isAbsolute(bash) && existsSync(bash), "Set OWNERSHIP_BASH_EXE to the resolved Git-for-Windows bash.exe");

const bashMachine = peMachine(readFileSync(bash));

const hostScript = fileURLToPath(new URL("./host.cjs", import.meta.url));

console.log("OWNERSHIP_HARNESS_PLATFORM", JSON.stringify({
  nodeArch: process.arch,
  nodeVersion: process.versions.node,
  nativeMachine,
  bashMachine,
  sourceFingerprint: artifact.metadata.sources.fingerprint,
  binarySha256: artifact.metadata.binary.sha256,
}));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const quote = (text) => `'${text.replace(/'/g, "'\\''")}'`;

async function until(condition, deadline, label) {
  while (!condition()) {
    assert.ok(Date.now() < deadline, label);
    await delay(5);
  }
}

function alive(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0 && pid <= 0xffff_ffff);

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;

    throw error;
  }
}

function closed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function fixture(t, label) {
  const directory = path.join(packageRoot, "native/test-work", `${label}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const cleanup = [];
  t.after(async () => {
    const failures = [];

    for (const dispose of [...cleanup].reverse()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) throw new AggregateError(failures, "Native fixture ownership cleanup failed; receipts retained");

    rmSync(directory, { recursive: true, force: true });
  });
  const ready = path.join(directory, "ready");
  const parent = path.join(directory, "parent");
  const marker = path.join(directory, "survived");
  const worker = "const fs = require('node:fs'); fs.writeFileSync('ready.writing', String(process.pid)); fs.renameSync('ready.writing', 'ready'); setTimeout(() => fs.writeFileSync('survived', 'alive'), 2500)";
  writeFileSync(path.join(directory, "marker.cjs"), [
    "const fs = require('node:fs'); fs.writeFileSync('parent.writing', String(process.pid)); fs.renameSync('parent.writing', 'parent')",
    `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'inherit' })`,
  ].join("; "));

  const launch = {
    executable: bash,
    argv: [bash, "-c", `${quote(process.execPath.replaceAll("\\", "/"))} marker.cjs`],
    cwd: directory,
    env: Object.entries(process.env).map(([key, value]) => `${key}=${value}`),
  };

  return { directory, ready, parent, marker, launch, cleanup };
}

function pidsOf(f) {
  return [Number(readFileSync(f.parent, "utf8")), Number(readFileSync(f.ready, "utf8"))];
}

function hostSpec(f, mode = "running") {
  return {
    addon: binary,
    mode,
    launch: f.launch,
    ready: f.ready,
    parent: f.parent,
    hostReceipt: path.join(f.directory, "host.json"),
    membership: path.join(f.directory, "membership.json"),
    stop: path.join(f.directory, "stop"),
    stopped: path.join(f.directory, "stopped.json"),
  };
}

function startHost(f, spec) {
  const specFile = path.join(spec.launch.cwd, "host-spec.json");
  writeFileSync(specFile, JSON.stringify(spec));

  const child = spawn(process.execPath, [hostScript, specFile], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
    windowsHide: true,
  });

  const exit = closed(child);
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data.toString()).slice(-4096);
  });
  f.cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();

    await exit;
    assert.equal(stderr, "", "Host setup/ownership error must not be hidden");
  });

  return { child, exit, stderr: () => stderr };
}

test("atomic membership exists while the root is still suspended; stop is pre-resume and idempotent", { timeout: 10_000 }, async (t) => {
  const f = fixture(t, "suspended");
  const run = addon.create(f.launch);
  f.cleanup.push(() => run.dispose());
  const state = run.snapshot();
  assert.ok(state.rootPid > 0);
  assert.equal(state.assignedBeforeResume, true);
  assert.equal(state.resumed, false);
  assert.equal(state.hostInOwnedJob, false);
  assert.equal(state.killOnClose, true);
  assert.equal(state.breakawayAllowed, false);
  assert.equal(state.jobHandleInheritable, false);
  assert.equal(run.contains(state.rootPid), true);
  assert.equal(existsSync(f.ready), false);
  assert.equal(run.stop().activeProcesses, 0);
  assert.equal(run.stop().activeProcesses, 0);
  assert.throws(() => run.resume(), (error) => error.stage === "ResumeCancelled");
  await until(() => !alive(state.rootPid), Date.now() + 1500, "Suspended root survived stop");
  assert.equal(existsSync(f.ready), false);
});

test("already-cancelled preparation creates no process", (t) => {
  const f = fixture(t, "cancelled");
  const run = addon.create({ ...f.launch, cancelled: true });
  f.cleanup.push(() => run.dispose());
  assert.equal(run.snapshot().rootPid, 0);
  assert.equal(run.snapshot().activeProcesses, 0);
  assert.throws(() => run.resume(), (error) => error.stage === "ResumeCancelled");
  assert.equal(existsSync(f.ready), false);
});

for (const cancellation of ["timeout", "abort"]) {
  test(`real Bash and native Node descendants are job-owned on ${cancellation}`, { timeout: 10_000 }, async (t) => {
    const f = fixture(t, cancellation);
    const started = Date.now();
    const run = addon.create(f.launch);
    f.cleanup.push(() => run.dispose());
    run.resume();
    await until(() => existsSync(f.ready), started + 1500, "Original 1500-ms descendant-ready gate failed");
    const pids = pidsOf(f);
    assert.ok(pids.every((pid) => run.contains(pid)), "Known native descendants must be job members");
    assert.equal(run.snapshot().hostInOwnedJob, false);
    console.log("OWNERSHIP_HARNESS_READY", JSON.stringify({
      cancellation, ...run.snapshot(), markerParent: pids[0], readyGrandchild: pids[1],
    }));

    if (cancellation === "timeout") await delay(Math.max(0, started + 1800 - Date.now()));

    const stopped = run.stop();
    assert.equal(stopped.activeProcesses, 0);
    await until(() => pids.every((pid) => !alive(pid)), Date.now() + 1500, "Known descendants survived an empty job");
    await delay(2600);
    assert.equal(existsSync(f.marker), false, "Original late-marker assertion failed");
  });
}

for (const barrier of ["beforeCreate", "afterCreate"]) {
  test(`forced host death at ${barrier} leaves no suspended orphan`, { timeout: 15_000 }, async (t) => {
    const fixtures = [];

    for (const jitter of [0, 1, 5]) {
      const f = fixture(t, `${barrier}-${jitter}`);
      const receipt = path.join(f.directory, "fault.pid");
      const spec = hostSpec(f);
      spec.launch = { ...spec.launch, barrier, receipt, release: path.join(f.directory, "release") };
      const host = startHost(f, spec);
      await until(() => existsSync(receipt), Date.now() + 1500, "Native fault barrier was not reached");
      const rootPid = Number(readFileSync(receipt, "utf8"));
      assert.equal(rootPid === 0, barrier === "beforeCreate");
      await delay(jitter);
      assert.equal(host.child.kill(), true);
      await host.exit;

      if (rootPid !== 0) await until(() => !alive(rootPid), Date.now() + 1500, "Suspended orphan survived owner death");

      fixtures.push(f);
    }

    await delay(2600);
    assert.ok(fixtures.every((f) => !existsSync(f.ready) && !existsSync(f.marker)));
  });
}

test("abrupt Node-host death closes the only job handle and kills real MSYS/native descendants", { timeout: 10_000 }, async (t) => {
  const f = fixture(t, "running-host-death");
  const spec = hostSpec(f);
  const started = Date.now();
  const host = startHost(f, spec);
  await until(() => existsSync(spec.membership), started + 1500, "Cold host/descendant readiness exceeded 1500 ms");
  const member = JSON.parse(readFileSync(spec.membership, "utf8"));
  assert.equal(member.hostInOwnedJob, false);
  assert.equal(member.parentMember, true);
  assert.equal(member.grandchildMember, true);
  const pids = [member.rootPid, member.markerParent, member.readyGrandchild];
  assert.equal(host.child.kill(), true);
  await host.exit;
  await until(() => pids.every((pid) => !alive(pid)), Date.now() + 1500, "Host death left known job members alive");
  await delay(2600);
  assert.equal(existsSync(f.marker), false);
});

test("atomic ownership nests beneath a private outer job without assigning the test host", { timeout: 10_000 }, async (t) => {
  const f = fixture(t, "nested");
  const spec = hostSpec(f);
  const specFile = path.join(f.directory, "nested-host.json");
  writeFileSync(specFile, JSON.stringify(spec));

  const outer = addon.create({
    executable: process.execPath,
    argv: [process.execPath, hostScript, specFile],
    cwd: f.directory,
    env: f.launch.env,
  });

  f.cleanup.push(() => outer.dispose());
  outer.resume();
  await until(() => existsSync(spec.membership), Date.now() + 1500, "Nested-job ownership was not established");
  const inner = JSON.parse(readFileSync(spec.membership, "utf8"));
  assert.equal(inner.hostInAnyJob, true);
  assert.equal(inner.hostInOwnedJob, false);
  assert.equal(inner.parentMember, true);
  assert.equal(inner.grandchildMember, true);
  assert.equal(outer.snapshot().hostInOwnedJob, false);
  writeFileSync(spec.stop, "");
  assert.equal(outer.waitRoot(5000), 0);
  assert.equal(JSON.parse(readFileSync(spec.stopped, "utf8")).activeProcesses, 0);
  assert.equal(outer.stop().activeProcesses, 0);
  assert.equal(existsSync(f.marker), false);
});

test("terminating one job leaves an unrelated native control process and another job untouched", { timeout: 10_000 }, async (t) => {
  const first = fixture(t, "first-job");
  const second = fixture(t, "second-job");
  const runs = [];

  for (const f of [first, second]) {
    const run = addon.create(f.launch);
    f.cleanup.push(() => run.dispose());
    runs.push(run);
  }

  const control = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { windowsHide: true, stdio: "ignore" });
  const controlExit = closed(control);
  first.cleanup.push(async () => {
    if (control.exitCode === null && control.signalCode === null) control.kill();

    await controlExit;
  });
  runs.forEach((run) => run.resume());
  await until(() => existsSync(first.ready) && existsSync(second.ready), Date.now() + 1500, "Concurrent readiness failed");
  assert.equal(runs[0].contains(control.pid), false);
  assert.equal(runs[0].stop().activeProcesses, 0);
  assert.ok(alive(control.pid));
  assert.ok(pidsOf(second).every((pid) => runs[1].contains(pid) && alive(pid)));
  assert.equal(runs[1].stop().activeProcesses, 0);
});

test("legitimate native root exit statuses are not ownership-error sentinels", { timeout: 10_000 }, (t) => {
  const f = fixture(t, "exit-status");
  writeFileSync(path.join(f.directory, "exit.cjs"), "process.exit(Number(process.argv[2]))");

  for (const code of [0, 1, 127, 255, 259]) {
    const run = addon.create({
      executable: process.execPath,
      argv: [process.execPath, "exit.cjs", String(code)],
      cwd: f.directory,
      env: f.launch.env,
    });

    try {
      run.resume();
      assert.equal(run.waitRoot(5000), code);
      assert.equal(run.stop().activeProcesses, 0);
    } finally {
      run.dispose();
    }
  }
});

test("Bash command, explicit exec and script root statuses remain the logical experiment status", { timeout: 15_000 }, (t) => {
  const f = fixture(t, "bash-exit-status");
  const node = quote(process.execPath.replaceAll("\\", "/"));
  writeFileSync(path.join(f.directory, "exit.cjs"), "process.exit(Number(process.argv[2]))");
  writeFileSync(path.join(f.directory, "exit.sh"), `${node} exit.cjs "$1"\n`);

  for (const mode of ["command", "exec", "script"]) {
    for (const code of [0, 1, 127, 255]) {
      const argv = mode === "script"
        ? [bash, "exit.sh", String(code)]
        : [bash, "-c", `${mode === "exec" ? "exec " : ""}${node} exit.cjs ${code}`];

      const run = addon.create({ ...f.launch, argv });

      try {
        run.resume();
        const actual = run.waitRoot(5000);
        console.log("OWNERSHIP_HARNESS_BASH_STATUS", JSON.stringify({ mode, expected: code, actual }));
        assert.equal(actual, code, "Do not infer the logical experiment status from an MSYS replacement stub");
        assert.equal(run.stop().activeProcesses, 0);
      } finally {
        run.dispose();
      }
    }
  }
});

test("explicit Unicode argv, environment and cwd survive the Win32 boundary", (t) => {
  const f = fixture(t, "unicode 空");
  writeFileSync(path.join(f.directory, "record.cjs"),
    "require('node:fs').writeFileSync('record.json', JSON.stringify({ args: process.argv.slice(2), env: process.env.OWNERSHIP_UNICODE, cwd: process.cwd() }))");
  const args = ["", "with spaces", "quote\"slash\\", "trailing\\\\", "λ 🧪 空"];

  const run = addon.create({
    executable: process.execPath,
    argv: [process.execPath, "record.cjs", ...args],
    cwd: f.directory,
    env: [...f.launch.env.filter((entry) => !/^OWNERSHIP_UNICODE=/i.test(entry)), "OWNERSHIP_UNICODE=λ 🧪 空"],
  });

  try {
    run.resume();
    assert.equal(run.waitRoot(5000), 0);
    assert.equal(run.stop().activeProcesses, 0);
    const record = JSON.parse(readFileSync(path.join(f.directory, "record.json"), "utf8"));
    assert.deepEqual(record.args, args);
    assert.equal(record.env, "λ 🧪 空");
    assert.equal(record.cwd.toLowerCase(), f.directory.toLowerCase());
  } finally {
    run.dispose();
  }
});

test("bad environment blocks and missing executables fail by stage, without downgrade", (t) => {
  const f = fixture(t, "setup-errors");
  assert.throws(() => addon.create({ ...f.launch, env: ["Path=a", "PATH=b"] }), (error) => error.stage === "EnvironmentDuplicateName");
  assert.throws(() => addon.create({ ...f.launch, env: ["MISSING_DELIMITER"] }), (error) => error.stage === "EnvironmentEntry");
  assert.throws(() => addon.create({ ...f.launch, argv: ["bad\0arg"] }), (error) => error.stage === "EmbeddedNulInput");
  assert.throws(() => addon.create({ ...f.launch, executable: path.join(f.directory, "missing.exe") }), (error) =>
    error.stage === "CreateProcessWithJobList" && error.win32Code > 0);
});
