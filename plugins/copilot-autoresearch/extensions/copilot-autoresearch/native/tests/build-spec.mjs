import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { auditImports, inventory, packageRoot, peMachine, sha256, sourceProvenance, verifyArtifact } from "../verify-artifact.mjs";
import { isNativeWindowsArchitecture } from "./windows-architecture.mjs";
import { resources } from "../resources.mjs";
import { preparePrebuilds, verifyInstalledResources } from "../assemble.mjs";

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

test("Windows API architecture evidence requires a matching native host and no emulation", () => {
  for (const arch of ["x64", "arm64"]) {
    const nativeMachine = inventory.architectures[arch].machine;
    assert.equal(isNativeWindowsArchitecture(arch, { processMachine: 0, nativeMachine }), true);

    for (const processMachine of [0x14c, 0x1c4, 0x8664, 0xaa64, undefined, "0"]) {
      assert.equal(isNativeWindowsArchitecture(arch, { processMachine, nativeMachine }), false);
    }

    for (const unknown of [0, 0xffff, undefined, String(nativeMachine)]) {
      assert.equal(isNativeWindowsArchitecture(arch, { processMachine: 0, nativeMachine: unknown }), false);
    }
  }

  assert.equal(isNativeWindowsArchitecture("x64", { processMachine: 0x8664, nativeMachine: 0xaa64 }), false);
  assert.equal(isNativeWindowsArchitecture("x64", { processMachine: 0, nativeMachine: 0xaa64 }), false);
  assert.equal(isNativeWindowsArchitecture("arm64", { processMachine: 0, nativeMachine: 0x8664 }), false);
  assert.equal(isNativeWindowsArchitecture("ia32", { processMachine: 0, nativeMachine: 0x14c }), false);
});

test("Node 22 ARM64's observed os.machine unknown cannot substitute for Windows API evidence", () => {
  const observed = { arch: "arm64", osMachine: "unknown", processMachine: 0, nativeMachine: 0xaa64 };
  assert.equal(isNativeWindowsArchitecture(observed.arch, observed), true);
  assert.equal(isNativeWindowsArchitecture(observed.arch, { ...observed, nativeMachine: 0 }), false);
  assert.equal(isNativeWindowsArchitecture(observed.arch, {
    ...observed, osMachine: "arm64", nativeMachine: 0,
  }), false);
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
  assert.ok(sources.files.length > 9);
  assert.ok(sources.files.some((file) => file.path === "native/shared/owned_job.h"));
  assert.ok(sources.files.some((file) => file.path === "native/runtime/owned_job_runtime.cc"));
  assert.equal(sources.fingerprint.length, 64);
  assert.ok(sources.files.every((entry) => entry.sha256.length === 64 && entry.bytes > 0));
});

test("creation requires a suspended atomic JOB_LIST and a stdio-only HANDLE_LIST", async () => {
  const source = await readFile(new URL("../shared/owned_job.h", import.meta.url), "utf8");
  assert.match(source, /PROC_THREAD_ATTRIBUTE_JOB_LIST/);
  assert.match(source, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(source, /CREATE_SUSPENDED \| EXTENDED_STARTUPINFO_PRESENT/);
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(source, /limits\.BasicLimitInformation\.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;/);
  assert.doesNotMatch(source, /AssignProcessToJobObject|CREATE_BREAKAWAY_FROM_JOB/);
  assert.doesNotMatch(source, /\buv_[A-Za-z_]+\s*\(|v8::|node::/);
  assert.match(source, /IsWow64Process2\(GetCurrentProcess\(\), &processMachine, &nativeMachine\)/);
  const runtime = await readFile(new URL("../runtime/owned_job_runtime.cc", import.meta.url), "utf8");
  assert.match(runtime, /#include "\.\.\/shared\/owned_job\.h"/);
  assert.doesNotMatch(runtime, /CreateJobObject|CreateProcessW|AssignProcessToJobObject/);
  assert.doesNotMatch(runtime, /napi_deferred|napi_create_promise|napi_(?:resolve|reject)_deferred/);
  assert.match(runtime, /napi_call_function/);
  const calls = [...new Set([...`${source}\n${runtime}`.matchAll(/\b(napi_[a-z_]+)\s*\(/g)].map((match) => match[1]))];
  const actualImports = `\n    node.exe\n${calls.map((name) => `       1 ${name}`).join("\n")}\n    KERNEL32.dll\n`;
  assert.equal(auditImports(actualImports).nodeImports.length, calls.length);
});

test("one discovered source fingerprint and resource inventory drives both shipped architectures", async () => {
  const descriptor = await resources();
  assert.equal(descriptor.sources.fingerprint, (await sourceProvenance()).fingerprint);
  assert.deepEqual(descriptor.targets.map((target) => target.arch), ["x64", "arm64"]);
  assert.ok(descriptor.inputs.includes("native/assemble.mjs"));
  assert.deepEqual(descriptor.inputs, descriptor.sources.files.map((file) => file.path));
  assert.ok(descriptor.inputs.every((file) => !file.startsWith("native/prebuilds/")));
  assert.ok(descriptor.outputs.includes("dist/native/win32-arm64/owned-job.node"));
  assert.ok(descriptor.outputs.includes("dist/native/win32-x64/provenance.json"));
});

test("installed validation is read-only and cache-independent, with strict protocol, hashes and complete resources", async () => {
  const directory = path.join(packageRoot, "native/test-work", `installed-unit-${crypto.randomUUID()}`);
  const installedDirectory = path.join(directory, "installed");
  const cache = path.join(directory, "optional-source");
  const descriptor = await resources();
  const binaries = {};
  const original = new Map();

  try {
    // Synthetic PE unit fixtures are never loaded, assembled, or written to production prebuild/dist paths.
    for (const target of descriptor.targets) {
      const bytes = Buffer.alloc(128);
      bytes.writeUInt16LE(0x5a4d, 0);
      bytes.writeUInt32LE(64, 0x3c);
      bytes.writeUInt32LE(0x00004550, 64);
      bytes.writeUInt16LE(target.machine, 68);
      binaries[target.arch] = sha256(bytes);

      const metadata = {
        schemaVersion: 1, arch: target.arch, nodeApiVersion: 8, protocolVersion: 2, kind: "runtime", crt: "/MT",
        binary: { name: target.binary, bytes: bytes.length, sha256: sha256(bytes), machine: target.machine },
        sources: descriptor.sources, imports: auditImports(imports),
      };

      const files = {
        [target.binary]: bytes,
        "provenance.json": Buffer.from(JSON.stringify(metadata)),
        "imports.txt": Buffer.from(imports),
        "dependents.txt": Buffer.from("Synthetic unit fixture; not compiler evidence"),
        "compile.txt": Buffer.from("Synthetic unit fixture; never assembled"),
      };

      assert.deepEqual(Object.keys(files).sort(), [...target.files].sort());

      for (const root of [installedDirectory, cache]) {
        const destination = path.join(root, path.basename(target.directory));
        await mkdir(destination, { recursive: true });

        for (const [file, contents] of Object.entries(files)) {
          const pathname = path.join(destination, file);
          await writeFile(pathname, contents);
          original.set(pathname, contents);
        }
      }
    }

    const manifest = {
      schemaVersion: descriptor.schemaVersion, nodeApiVersion: descriptor.nodeApiVersion,
      protocolVersion: descriptor.protocolVersion, sourceFingerprint: descriptor.sources.fingerprint, binaries,
    };

    const index = path.join(installedDirectory, "resources.json");
    await writeFile(index, JSON.stringify(manifest));
    await assert.doesNotReject(verifyInstalledResources({ installedDirectory, prebuildsDirectory: cache }));
    assert.equal((await preparePrebuilds({ installedDirectory, prebuildsDirectory: cache })).hydrated, false);

    for (const [file, contents] of original) assert.deepEqual(await readFile(file), contents);

    const differing = path.join(cache, "win32-x64", "compile.txt");
    await writeFile(differing, "Altered receipt");
    await assert.rejects(verifyInstalledResources({ installedDirectory, prebuildsDirectory: cache }), /differs from its verified prebuild/);
    await rm(cache, { recursive: true });
    assert.deepEqual(await verifyInstalledResources({ installedDirectory }), manifest);
    assert.deepEqual(await readdir(directory), ["installed"]);
    assert.equal((await preparePrebuilds({ installedDirectory, prebuildsDirectory: cache })).hydrated, true);
    await verifyInstalledResources({ installedDirectory, prebuildsDirectory: cache });
    const corrupt = path.join(cache, "win32-x64", "owned-job.node");
    await writeFile(corrupt, Buffer.alloc(128));
    await assert.rejects(preparePrebuilds({ installedDirectory, prebuildsDirectory: cache }), /Expected a Windows PE/);
    assert.deepEqual(await readFile(corrupt), Buffer.alloc(128));
    await rm(cache, { recursive: true });

    for (const altered of [
      { ...manifest, schemaVersion: 2 }, { ...manifest, nodeApiVersion: 9 }, { ...manifest, protocolVersion: 1 },
      { ...manifest, sourceFingerprint: "0".repeat(64) },
      { ...manifest, binaries: { ...binaries, arm64: "0".repeat(64) } },
      { ...manifest, binaries: { x64: binaries.x64 } }, { ...manifest, extra: true },
    ]) {
      await writeFile(index, JSON.stringify(altered));
      await assert.rejects(verifyInstalledResources({ installedDirectory }), /manifest does not match/);
      await assert.rejects(preparePrebuilds({ installedDirectory, prebuildsDirectory: cache }), /manifest does not match/);
      assert.deepEqual(JSON.parse(await readFile(index, "utf8")), altered);
      assert.deepEqual(await readdir(directory), ["installed"]);
    }

    await writeFile(index, JSON.stringify(manifest));

    for (const target of descriptor.targets) {
      for (const file of target.files) {
        const pathname = path.join(installedDirectory, path.basename(target.installedDirectory), file);
        const contents = await readFile(pathname);
        await rm(pathname);
        await assert.rejects(verifyInstalledResources({ installedDirectory }), { code: "ENOENT" });
        await writeFile(pathname, contents);
      }
    }

    const binary = path.join(installedDirectory, "win32-arm64", "owned-job.node");
    const bytes = await readFile(binary);
    bytes[127] = 255;
    await writeFile(binary, bytes);
    await assert.rejects(verifyInstalledResources({ installedDirectory }), /raw-byte binary hash mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact verifier rejects incomplete source records, mismatched metadata and modified raw bytes", async () => {
  const directory = path.join(packageRoot, "native/test-work", `pe-unit-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  // Synthetic PE headers stay in this unit fixture; they are never loaded or assembled.
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(0x8664, 68);

  const metadata = {
    schemaVersion: 1, arch: "x64", nodeApiVersion: 8, protocolVersion: 2, kind: "runtime", crt: "/MT",
    binary: { name: "owned-job.node", bytes: bytes.length, sha256: sha256(bytes), machine: 0x8664 },
    sources: await sourceProvenance(), imports: auditImports(imports),
  };

  const provenance = path.join(directory, "provenance.json");
  const binary = path.join(directory, "owned-job.node");

  try {
    await writeFile(provenance, JSON.stringify(metadata));
    await writeFile(binary, bytes);
    await writeFile(path.join(directory, "imports.txt"), imports);
    await verifyArtifact("x64", directory, "runtime");

    for (const altered of [
      { ...metadata, kind: "harness" },
      { ...metadata, protocolVersion: 1 },
      { ...metadata, arch: "arm64" },
      { ...metadata, crt: "/MD" },
      { ...metadata, binary: { ...metadata.binary, machine: 0xaa64 } },
      { ...metadata, sources: { ...metadata.sources, files: metadata.sources.files.slice(1) } },
      { ...metadata, sources: { ...metadata.sources, fingerprint: "0".repeat(64) } },
    ]) {
      await writeFile(provenance, JSON.stringify(altered));
      await assert.rejects(verifyArtifact("x64", directory, "runtime"), /mismatch|stale|incomplete/);
    }

    await writeFile(provenance, JSON.stringify(metadata));
    bytes[127] = 255;
    await writeFile(binary, bytes);
    await assert.rejects(verifyArtifact("x64", directory, "runtime"), /raw-byte binary hash mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
