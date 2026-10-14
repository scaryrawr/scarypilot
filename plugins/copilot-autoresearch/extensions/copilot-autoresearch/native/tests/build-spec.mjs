import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { auditImports, inventory, peMachine, sha256, sourceProvenance } from "../verify-artifact.mjs";

const imports = `
  Section contains the following imports:
    node.exe
             180003000 Import Address Table
                  13A napi_create_object
                  144 napi_wrap
    KERNEL32.dll
                  12C CreateProcessW
                  1AD UpdateProcThreadAttribute
  Summary
                1000 .rdata
`;

test("one inventory declares both matching-architecture proof artifacts and stable Node-API 8", () => {
  assert.equal(inventory.nodeApiVersion, 8);
  assert.deepEqual(Object.keys(inventory.architectures).sort(), ["arm64", "x64"]);
  assert.equal(inventory.architectures.x64.machine, 0x8664);
  assert.equal(inventory.architectures.arm64.machine, 0xaa64);
  assert.match(inventory.purpose, /test-only/);
});

test("binary SHA256 uses bytes, not UTF-8 decoding or newline normalization", () => {
  const bytes = Buffer.from([0x4d, 0x5a, 0x00, 0xff, 0x80, 0x0d, 0x0a]);
  assert.notEqual(sha256(bytes), sha256(Buffer.from(bytes.toString("utf8"))));
  assert.notEqual(sha256(bytes), sha256(Buffer.from([0x4d, 0x5a, 0x00, 0xff, 0x80, 0x0a])));
  assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("PE machine is read from validated binary headers", () => {
  for (const machine of [0x8664, 0xaa64]) {
    const bytes = Buffer.alloc(128);
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(64, 0x3c);
    bytes.writeUInt32LE(0x00004550, 64);
    bytes.writeUInt16LE(machine, 68);
    assert.equal(peMachine(bytes), machine);
    bytes.writeUInt32LE(0xffff_ffff, 0x3c);
    assert.throws(() => peMachine(bytes), /Invalid PE/);
  }

  assert.throws(() => peMachine(Buffer.alloc(8)), /Expected a Windows PE/);
});

test("DLL audit accepts only system DLLs plus the named stable Node-API surface", () => {
  assert.deepEqual(auditImports(imports), {
    dlls: ["kernel32.dll", "node.exe"],
    nodeImports: ["napi_create_object", "napi_wrap"],
  });

  for (const dll of ["VCRUNTIME140.dll", "MSVCP140.dll", "ucrtbase.dll", "api-ms-win-crt-runtime-l1-1-0.dll", "thirdparty.dll"]) {
    assert.throws(() => auditImports(imports.replace("KERNEL32.dll", dll)), /runtime dependency|non-system DLL/);
  }

  for (const symbol of ["uv_spawn", "napi_get_module_file_name", "?PrivateV8Symbol"]) {
    assert.throws(() => auditImports(imports.replace("napi_wrap", symbol)), /Node-API 8 surface/);
  }

  assert.throws(() => auditImports("not dumpbin output"), /did not prove/);
});

test("all native build/test inputs have raw-byte source provenance", async () => {
  const sources = await sourceProvenance();
  assert.equal(sources.files.length, inventory.sourceFiles.length);
  assert.equal(sources.fingerprint.length, 64);
  assert.ok(sources.files.every((entry) => entry.sha256.length === 64 && entry.bytes > 0));
});

test("creation requires a suspended atomic JOB_LIST and a stdio-only HANDLE_LIST", async () => {
  const source = await readFile(new URL("../harness/owned_job_harness.cc", import.meta.url), "utf8");
  assert.match(source, /PROC_THREAD_ATTRIBUTE_JOB_LIST/);
  assert.match(source, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(source, /CREATE_SUSPENDED \| EXTENDED_STARTUPINFO_PRESENT/);
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(source, /limits\.BasicLimitInformation\.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;/);
  assert.doesNotMatch(source, /AssignProcessToJobObject|CREATE_BREAKAWAY_FROM_JOB/);
  assert.doesNotMatch(source, /\buv_[A-Za-z_]+\s*\(|v8::|node::/);
  const calls = [...new Set([...source.matchAll(/\b(napi_[a-z_]+)\s*\(/g)].map((match) => match[1]))];
  const actualImports = `\n    node.exe\n${calls.map((name) => `       1 ${name}`).join("\n")}\n    KERNEL32.dll\n`;
  assert.equal(auditImports(actualImports).nodeImports.length, calls.length);
});
