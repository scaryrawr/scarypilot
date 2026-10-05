import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DeviceDiscoverySchema, WindowsDiscoverySchema } from "../src/domain.ts";
import { createRecordingTools, RECORDER_MAX_BUFFER, type RecorderRuntime } from "../src/tools.ts";

const directory = fileURLToPath(new URL("../", import.meta.url));

const script = fileURLToPath(new URL("../../../skills/screen-record/scripts/screen-record.mjs", import.meta.url));

const preload = new URL("./fixtures/media-subprocess.mjs", import.meta.url).href;

const invocation = { sessionId: "output-contract", toolCallId: "output-contract", toolName: "output-contract" };

const Envelope = Type.Object({
  resultType: Type.Union([Type.Literal("success"), Type.Literal("failure")]),
  textResultForLlm: Type.String(),
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "screen-record-output-"));

  const runtime: RecorderRuntime = {
    script, cwd: root, env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
  };

  return { root, runtime, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function call(runtime: RecorderRuntime, name: string) {
  const tool = createRecordingTools(runtime).find((entry) => entry.name === name)!;
  const result: unknown = await tool.handler!({}, { ...invocation, arguments: {} });
  assert.ok(Value.Check(Envelope, result));

  return result;
}

function maximumWindows(text = "\ud800") {
  return {
    platform: "win32",
    windows: Array.from({ length: 128 }, () => ({
      windowId: `w1_${"a".repeat(43)}`,
      title: text.repeat(1024).slice(0, 1024),
      processName: text.repeat(260).slice(0, 260),
      processId: Number.MAX_VALUE,
      bounds: { x: -Number.MAX_VALUE, y: -Number.MAX_VALUE, width: Number.MAX_VALUE, height: Number.MAX_VALUE },
      clientArea: { width: Number.MAX_VALUE, height: Number.MAX_VALUE },
      foreground: false,
    })),
    truncated: false,
    uninspectableCount: Number.MAX_VALUE,
    permissionsVerified: false,
  };
}

test("transport budget covers worst-case JSON escaping, UTF-8 and pretty-printed Windows schema", () => {
  const devices = {
    platform: "darwin", captureDevice: "avfoundation", listing: "\0".repeat(262144), permissionsVerified: false,
  };

  assert.ok(Value.Check(DeviceDiscoverySchema, devices));
  assert.equal(Buffer.byteLength(`${JSON.stringify(devices)}\n`), RECORDER_MAX_BUFFER);
  assert.equal(Buffer.byteLength(`${JSON.stringify(maximumWindows(), null, 2)}\n`), 1050132);
  assert.ok(1050132 < RECORDER_MAX_BUFFER);

  for (const text of ['"', "\\", "漢", "😀", "\ud800", "\0"]) {
    const value = { ...devices, listing: text.repeat(Math.floor(262144 / text.length)) };
    assert.ok(Value.Check(DeviceDiscoverySchema, value));
    assert.ok(Buffer.byteLength(`${JSON.stringify(value)}\n`) <= RECORDER_MAX_BUFFER);
  }
});

test("native devices accepts escaping-heavy inner-limit FFmpeg output on both discovery backends", async () => {
  const fixture = await setup();

  try {
    for (const platform of ["darwin", "win32"]) {
      fixture.runtime.env.RECORDER_FIXTURE_DISCOVERY_PLATFORM = platform;
      fixture.runtime.env.RECORDER_FIXTURE_MODE = "device-escaping-limit";
      const result = await call(fixture.runtime, "screen_record_devices");

      assert.equal(result.resultType, "success", result.textResultForLlm);
      const value: unknown = JSON.parse(result.textResultForLlm);
      assert.ok(Value.Check(DeviceDiscoverySchema, value));
      assert.equal(Buffer.byteLength(value.listing), 262144);
      assert.ok(Buffer.byteLength(result.textResultForLlm) > 262144);
      assert.ok(value.listing.includes("\0") && value.listing.includes("漢"));

      fixture.runtime.env.RECORDER_FIXTURE_MODE = "device-output-overflow";
      const overflow = await call(fixture.runtime, "screen_record_devices");
      assert.equal(overflow.resultType, "failure");
      assert.match(overflow.textResultForLlm, /device discovery failed/);
      assert.ok(overflow.textResultForLlm.length < 4096);
    }
  } finally { await fixture.cleanup(); }
});

test("native windows accepts the bounded schema maximum and actual escaped CLI window output", async () => {
  const fixture = await setup();

  try {
    const discovery = maximumWindows();
    assert.ok(Value.Check(WindowsDiscoverySchema, discovery));
    const serialized = `${JSON.stringify(discovery, null, 2)}\n`;
    assert.ok(Buffer.byteLength(serialized) > 262144);
    const output = join(fixture.root, "windows.json");
    const emitter = join(fixture.root, "emit.mjs");
    await writeFile(output, serialized);
    await writeFile(emitter, "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync(process.env.OUTPUT));");
    const maximum = await call({ ...fixture.runtime, script: emitter, env: { ...process.env, OUTPUT: output } }, "screen_record_windows");
    assert.equal(maximum.resultType, "success", maximum.textResultForLlm);
    assert.deepEqual(JSON.parse(maximum.textResultForLlm), discovery);

    const pattern = '"\\\ud800漢';

    const candidates = discovery.windows.map((window, index) => ({
      hwnd: `0x${(index + 1).toString(16)}`, processId: 4321, processStartTime: "133999999999999999",
      threadId: 100 + index, className: "Fixture", title: pattern.repeat(256),
      processName: pattern.repeat(65), clientWidth: 800, clientHeight: 600,
      windowLeft: -100, windowTop: 40, windowWidth: 820, windowHeight: 640, foreground: false,
    }));

    await writeFile(output, JSON.stringify({ windows: candidates, uninspectableCount: 0 }));
    fixture.runtime.env.RECORDER_FIXTURE_WINDOWS_FILE = output;
    fixture.runtime.env.RECORDER_FIXTURE_DISCOVERY_PLATFORM = "win32";
    const actual = await call(fixture.runtime, "screen_record_windows");
    assert.equal(actual.resultType, "success", actual.textResultForLlm);
    const value: unknown = JSON.parse(actual.textResultForLlm);
    assert.ok(Value.Check(WindowsDiscoverySchema, value));
    assert.equal(value.windows.length, 128);
    assert.equal(value.windows[0].title, candidates[0].title);
    assert.equal(value.windows[0].processName, candidates[0].processName);
    assert.ok(Buffer.byteLength(actual.textResultForLlm) > 262144);
  } finally { await fixture.cleanup(); }
});

test("native transport still rejects invalid shapes, invalid JSON and unbounded subprocess output", async () => {
  const fixture = await setup();

  try {
    const emitter = join(fixture.root, "invalid.mjs");
    fixture.runtime.script = emitter;
    fixture.runtime.env.NODE_OPTIONS = "";

    for (const payload of [
      "not JSON",
      JSON.stringify({ platform: "darwin", captureDevice: "avfoundation", listing: "a".repeat(262145), permissionsVerified: false }),
      JSON.stringify({ ...maximumWindows("a"), windows: Array(129).fill(maximumWindows("a").windows[0]) }),
    ]) {
      await writeFile(emitter, `process.stdout.write(${JSON.stringify(payload)});`);
      const result = await call(fixture.runtime, payload.includes("windows") ? "screen_record_windows" : "screen_record_devices");
      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, /invalid JSON/);
      assert.ok(result.textResultForLlm.length < 4096);
    }

    await writeFile(emitter, "process.stdout.write('x'.repeat(4 * 1024 * 1024));");
    const overflow = await call(fixture.runtime, "screen_record_devices");
    assert.equal(overflow.resultType, "failure");
    assert.match(overflow.textResultForLlm, /maxBuffer/);
    assert.ok(overflow.textResultForLlm.length < 4096);
    await writeFile(emitter, "process.stderr.write('x'.repeat(4 * 1024 * 1024));");
    const stderr = await call(fixture.runtime, "screen_record_devices");
    assert.equal(stderr.resultType, "failure");
    assert.match(stderr.textResultForLlm, /Command devices failed/);
    assert.ok(Buffer.byteLength(stderr.textResultForLlm) <= RECORDER_MAX_BUFFER + 256);
  } finally { await fixture.cleanup(); }
});

test("isolated shipped bundle registers six tools and dispatches the escaping-heavy output contracts", async () => {
  const fixture = await setup();

  try {
    const sdk = join(fixture.root, "node_modules", "@github", "copilot-sdk");
    await mkdir(sdk, { recursive: true });
    await cp(join(directory, "dist"), join(fixture.root, "dist"), { recursive: true });
    await cp(join(directory, "extension.mjs"), join(fixture.root, "extension.mjs"));
    await writeFile(join(sdk, "package.json"), JSON.stringify({
      name: "@github/copilot-sdk", type: "module", exports: { "./extension": "./extension.mjs" },
    }));
    await writeFile(join(sdk, "extension.mjs"), "export async function joinSession(options) { globalThis.tools = options.tools; }");
    const discovery = maximumWindows();
    const devices = { platform: "darwin", captureDevice: "avfoundation", listing: "\0".repeat(262144), permissionsVerified: false };
    await writeFile(join(fixture.root, "windows.json"), JSON.stringify(discovery, null, 2));
    await writeFile(join(fixture.root, "devices.json"), JSON.stringify(devices));
    await writeFile(join(fixture.root, "preload.mjs"), [
      "import { readFileSync, writeSync } from 'node:fs';",
      "writeSync(1, readFileSync(process.argv.includes('windows') ? 'windows.json' : 'devices.json'));",
      "process.exit(0);",
    ].join("\n"));
    await writeFile(join(fixture.root, "smoke.mjs"), [
      "import assert from 'node:assert/strict';",
      "globalThis.fetch = async () => { throw new Error('Network disabled'); };",
      "await import('./extension.mjs');",
      "process.env.NODE_OPTIONS = '--import=' + new URL('./preload.mjs', import.meta.url).href;",
      "assert.deepEqual(globalThis.tools.map(t => t.name).sort(), ['screen_record_devices','screen_record_doctor','screen_record_start','screen_record_status','screen_record_stop','screen_record_windows']);",
      "for (const name of ['screen_record_devices', 'screen_record_windows']) {",
      " const result = await globalThis.tools.find(t => t.name === name).handler({}, {});",
      " assert.equal(result.resultType, 'success', result.textResultForLlm);",
      " assert.ok(Buffer.byteLength(result.textResultForLlm) > 262144);",
      "}",
      "console.log('six-tool shipped output smoke passed');",
    ].join("\n"));

    const result = spawnSync(process.execPath, [join(fixture.root, "smoke.mjs")], {
      cwd: fixture.root, encoding: "utf8", timeout: 15000, maxBuffer: 16384,
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /six-tool shipped output smoke passed/);
  } finally { await fixture.cleanup(); }
});
