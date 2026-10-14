import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { packageRoot, verifyArtifact } from "../verify-artifact.mjs";
import { createNativeRun } from "../../src/native-run.ts";

assert.equal(process.platform, "win32", "Production transport proof requires real Windows");

assert.equal(process.arch, process.env.OWNERSHIP_EXPECT_ARCH, "Test the artifact with its matching Node architecture");

const verified = await verifyArtifact(process.arch, undefined, "runtime");

const binary = path.join(verified.directory, "owned-job.node");

const api = createRequire(import.meta.url)(binary);

assert.equal(api.nodeApiVersion, 8);

assert.equal(api.protocolVersion, 2);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function within(promise, ms) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native runtime proof timed out")), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function spec(program, cwd = packageRoot, input = false) {
  return {
    executable: process.execPath, argv: [process.execPath, "-e", program], cwd, input, cancelled: false,
    env: Object.entries(process.env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`),
    path: process.env.PATH ?? "",
  };
}

async function drain(run, channel) {
  const chunks = [];

  for (;;) {
    const bytes = await run.read(channel);

    if (bytes === null) return Buffer.concat(chunks);
    chunks.push(bytes);
  }
}

function observe(run) {
  const completion = Promise.all([run.closed, run.started, drain(run, 1), drain(run, 2)]);
  void completion.catch(() => {});

  return completion;
}

function owned(t, launch) {
  const run = createNativeRun(api, launch);
  void run.started.catch(() => {});
  void run.closed.catch(() => {});
  t.after(async () => {
    run.discard();
    await within(run.closed.catch((error) => {
      if (error.cleanupStage || (error.pid && error.stage !== "OutputDrainTimeout")) throw error;
    }), 12_000);
  });

  return run;
}

test("runtime contains no public harness preparation/fault API", () => {
  assert.equal(typeof api.begin, "function");
  assert.equal("prepare" in api, false);
});

test("read credits and input chunks are bounded before touching kernel I/O", async (t) => {
  const run = owned(t, spec("process.stdin.resume()", packageRoot, true));
  const closed = run.closed;
  void closed.catch(() => {});
  const read = run.read(1);
  void read.catch(() => {});

  try {
    assert.throws(() => run.read(1), { stage: "OutstandingIoCredit" });
    assert.throws(() => run.write(Buffer.alloc(65537)), { stage: "BoundedInputChunk" });
  } finally {
    run.discard();
    await within(Promise.all([closed, read, run.started]), 12_000);
  }
});

test("normal native status 259 survives asynchronous output drain and resource close", async (t) => {
  const program = "process.stdout.write('stdout🙂'); process.stderr.write('stderrλ'); process.exitCode=259";
  const run = owned(t, spec(program));
  const [result, pid, stdout, stderr] = await within(observe(run), 5000);
  assert.equal(Number.isSafeInteger(pid) && pid > 0, true);
  assert.deepEqual(result, { exitCode: 259, killed: false });
  assert.equal(stdout.toString(), "stdout🙂");
  assert.equal(stderr.toString(), "stderrλ");
  run.stop();
  run.discard();
  assert.deepEqual(await run.closed, result);
});

test("creation errors reject both receipts without inventing a root PID", async (t) => {
  const launch = spec("");
  launch.executable = path.join(packageRoot, "native", "missing-owned-runtime.exe");
  const run = owned(t, launch);
  const started = assert.rejects(run.started, (error) => error.stage === "CreateProcessWithJobList" && !("pid" in error));
  const closed = assert.rejects(run.closed, (error) => error.stage === "CreateProcessWithJobList" && !("pid" in error));
  await within(Promise.all([started, closed]), 5000);
});

test("missing Bash explains its prerequisite without creating an experiment", async (t) => {
  const launch = { ...spec(""), executable: "bash", argv: ["bash", "-c", "exit 0"], path: "" };
  const run = owned(t, launch);
  await within(Promise.all([
    assert.rejects(run.started, { stage: "BashRequired" }),
    assert.rejects(run.closed, { stage: "BashRequired" }),
  ]), 5000);
});

test("unconsumed output rejects at the bounded drain deadline, then discards idempotently", async (t) => {
  const run = owned(t, spec("process.stdout.write('unconsumed')"));
  await run.started;
  await within(assert.rejects(run.closed, { stage: "OutputDrainTimeout" }), 12_000);
  run.discard();
  run.discard();
});

test("a blocked input pipe does not block owned stop or the shared JS event loop", async (t) => {
  const run = owned(t, spec("process.stdin.pause(); setInterval(()=>{},1000)", packageRoot, true));
  const completion = observe(run);
  await run.started;
  let acknowledgements = 0;
  let writing = true;

  const input = (async () => {
    while (writing) {
      await run.write(Buffer.alloc(65536));
      acknowledgements++;
    }
  })();

  void input.catch(() => {});
  await delay(100);
  const before = acknowledgements;
  await delay(100);
  assert.equal(acknowledgements, before, "The real child must have filled its unread input pipe");
  writing = false;
  run.stop();
  run.stop();
  const [result] = await within(completion, 5000);
  await within(input, 5000);
  assert.equal(result.killed, true);
});

test("terminating a Node Worker closes runtime ownership and real descendant processes", { timeout: 20_000 }, async () => {
  const directory = path.join(packageRoot, "native", "test-work", crypto.randomUUID());
  await mkdir(directory, { recursive: true });
  const grandchild = "const fs=require('node:fs'); fs.writeFileSync('ready.writing',String(process.pid)); fs.renameSync('ready.writing','ready'); setInterval(()=>{},1000)";
  const parent = `const fs=require('node:fs'); fs.writeFileSync('parent.writing',String(process.pid)); fs.renameSync('parent.writing','parent'); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'})`;
  const program = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(parent)}],{stdio:'inherit'})`;

  const source = `
    (async () => {
    const { parentPort, workerData } = require('node:worker_threads');
    const { createNativeRun } = await import(workerData.client);
    const run = createNativeRun(require(workerData.binary), workerData.spec);
    run.started.then(pid => parentPort.postMessage(pid));
    run.closed.catch(() => {});
    for (const channel of [1,2]) (async()=>{while(await run.read(channel)!==null){}})().catch(()=>{});
    (async()=>{for(;;)await run.write(Buffer.alloc(65536))})().catch(()=>{});
    })().catch(error => { throw error; });
  `;

  const deadline = Date.now() + 1500;

  const worker = new Worker(source, {
    eval: true,
    workerData: { binary, client: new URL("../../src/native-run.ts", import.meta.url).href, spec: spec(program, directory, true) },
  });

  const started = new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });

  void started.catch(() => {});

  try {
    const root = await within(started, Math.max(1, deadline - Date.now()));
    let ready;

    while (Date.now() < deadline) {
      try { ready = Number(await readFile(path.join(directory, "ready"), "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }

      await delay(10);
    }

    assert.ok(ready > 0, "The real descendant must report readiness");
    const pids = [root, Number(await readFile(path.join(directory, "parent"), "utf8")), ready];
    await within(worker.terminate(), 12_000);

    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  } finally {
    await within(worker.terminate(), 12_000);
    await rm(directory, { recursive: true, force: true });
  }
});
