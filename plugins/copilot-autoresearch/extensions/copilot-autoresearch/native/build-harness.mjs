import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditImports, inventory, packageRoot, peMachine, sha256, sourceProvenance, verifyArtifact } from "./verify-artifact.mjs";

if (process.platform !== "win32") throw new Error("MSVC Windows harness builds require Windows; no compiler/download fallback");

const options = new Map();

for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  const value = process.argv[i + 1];

  if (!["--arch", "--node-include", "--node-lib", "--expect-msvc", "--expect-sdk"].includes(name) || !value || options.has(name)) {
    throw new Error("Usage: --arch x64|arm64 --node-include <Node headers> --node-lib <target node.lib> --expect-msvc <VCToolsVersion> --expect-sdk <WindowsSDKVersion>");
  }

  options.set(name, value);
}

for (const required of ["--arch", "--node-include", "--node-lib", "--expect-msvc", "--expect-sdk"]) {
  if (!options.has(required)) throw new Error(`Required explicit build input: ${required}`);
}

const arch = options.get("--arch");

const target = inventory.architectures[arch];

if (!target || process.env.VSCMD_ARG_TGT_ARCH !== arch) throw new Error("Use the matching MSVC target developer environment");

const trimVersion = (value = "") => value.replace(/[\\/]+$/, "");

for (const name of ["CL", "_CL_", "LINK", "_LINK_"]) {
  if (process.env[name]) throw new Error(`Implicit compiler options are forbidden; clear ${name}`);
}

if (trimVersion(process.env.VCToolsVersion) !== trimVersion(options.get("--expect-msvc"))) {
  throw new Error("MSVC version differs from the explicitly approved toolchain");
}

if (trimVersion(process.env.WindowsSDKVersion) !== trimVersion(options.get("--expect-sdk"))) {
  throw new Error("Windows SDK version differs from the explicitly approved toolchain");
}

const include = path.resolve(options.get("--node-include"));

const nodeLib = path.resolve(options.get("--node-lib"));

const versionHeader = await readFile(path.join(include, "node_version.h"), "utf8");

const headerVersion = ["MAJOR", "MINOR", "PATCH"].map((part) => {
  const value = new RegExp(`#define\\s+NODE_${part}_VERSION\\s+(\\d+)`).exec(versionHeader)?.[1];

  if (!value) throw new Error("Cannot identify Node header version");

  return value;
}).join(".");

if (headerVersion !== inventory.nodeHeadersVersion) throw new Error(`Require explicit Node ${inventory.nodeHeadersVersion} headers`);

const directory = path.join(packageRoot, target.directory);

const buildDirectory = path.join(packageRoot, "native/build", `win32-${arch}`);

await rm(directory, { recursive: true, force: true });

await mkdir(directory, { recursive: true });

await mkdir(buildDirectory, { recursive: true });

function execute(file, args, timeout = 30_000) {
  const result = spawnSync(file, args, {
    encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true,
    env: { ...process.env, VSLANG: "1033" },
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    throw new Error(`${path.basename(file)} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }

  return `${result.stdout}${result.stderr}`;
}

if (!process.env.VCToolsInstallDir) throw new Error("Require the selected MSVC developer environment's VCToolsInstallDir");

const toolRoot = path.resolve(process.env.VCToolsInstallDir);

const tools = {};

for (const name of ["cl.exe", "link.exe", "dumpbin.exe"]) {
  const selected = execute("where.exe", [name]).trim().split(/\r?\n/)[0];
  const relative = path.relative(toolRoot.toLowerCase(), path.resolve(selected).toLowerCase());

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${name} on PATH is outside the selected MSVC toolchain`);
  }

  tools[name] = { path: selected, relative, sha256: sha256(await readFile(selected)) };
}

const binary = path.join(directory, inventory.binary);

const args = [
  "/nologo", "/Bv", "/std:c++20", "/O2", "/W4", "/WX", "/EHsc", "/MT", "/LD", "/Brepro",
  "/DWIN32_LEAN_AND_MEAN", "/DNOMINMAX", "/D_WIN32_WINNT=0x0A00", "/DNAPI_VERSION=8",
  "/DNODE_GYP_MODULE_NAME=ownership_harness", "/DOWNERSHIP_HARNESS_TEST_ONLY=1",
  `/I${include}`, `/Fo${path.join(buildDirectory, "owned_job_harness.obj")}`, `/Fe${binary}`,
  path.join(packageRoot, "native/harness/owned_job_harness.cc"),
  "/link", "/WX", `/MACHINE:${arch === "x64" ? "X64" : "ARM64"}`, "/DYNAMICBASE", "/NXCOMPAT",
  "/INCREMENTAL:NO", "/Brepro", `/IMPLIB:${path.join(buildDirectory, "ownership-harness.lib")}`,
  nodeLib, "kernel32.lib",
];

const compileOutput = execute(tools["cl.exe"].path, args, 120_000);

await writeFile(path.join(directory, "compile.txt"), compileOutput);

const compilerVersions = [...new Set([...compileOutput.matchAll(/Version\s+(19\.\d+\.\d+(?:\.\d+)?)/g)].map((match) => match[1]))];

if (compilerVersions.length === 0) throw new Error("cl /Bv did not expose actual compiler versions; inspect compile output");

const importsText = execute(tools["dumpbin.exe"].path, ["/nologo", "/imports", binary]);

const dependentsText = execute(tools["dumpbin.exe"].path, ["/nologo", "/dependents", binary]);

await writeFile(path.join(directory, "imports.txt"), importsText);

await writeFile(path.join(directory, "dependents.txt"), dependentsText);

const imports = auditImports(importsText);

const bytes = await readFile(binary);

if (peMachine(bytes) !== target.machine) throw new Error("Compiler produced the wrong PE machine type");

const headers = [];

for (const name of ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h", "node_version.h"]) {
  headers.push({ name, sha256: sha256(await readFile(path.join(include, name))) });
}

const sources = await sourceProvenance();

const metadata = {
  schemaVersion: 1,
  purpose: inventory.purpose,
  arch,
  nodeApiVersion: inventory.nodeApiVersion,
  nodeHeadersVersion: headerVersion,
  crt: "/MT",
  binary: { name: inventory.binary, bytes: bytes.length, sha256: sha256(bytes), machine: peMachine(bytes) },
  sources,
  inputs: { headers, nodeLibSha256: sha256(await readFile(nodeLib)) },
  toolchain: {
    msvc: trimVersion(process.env.VCToolsVersion),
    sdk: trimVersion(process.env.WindowsSDKVersion),
    target: process.env.VSCMD_ARG_TGT_ARCH,
    compilerVersions,
    binaries: Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, {
      relative: tool.relative, sha256: tool.sha256,
    }])),
    flags: args.filter((arg) => !arg.includes(packageRoot) && !arg.includes(include) && arg !== nodeLib),
  },
  imports,
};

await writeFile(path.join(directory, inventory.provenance), `${JSON.stringify(metadata, null, 2)}\n`);

await verifyArtifact(arch);

console.log(JSON.stringify({ built: true, arch, directory: target.directory, sha256: metadata.binary.sha256, sourceFingerprint: sources.fingerprint }));
