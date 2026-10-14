import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export const inventory = JSON.parse(await readFile(new URL("./harness-resources.json", import.meta.url), "utf8"));

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function peMachine(bytes) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Expected a Windows PE binary");
  }

  const offset = bytes.readUInt32LE(0x3c);

  if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x00004550) {
    throw new Error("Invalid PE signature or header offset");
  }

  return bytes.readUInt16LE(offset + 4);
}

const systemDlls = new Set([
  "kernel32.dll", "kernelbase.dll", "ntdll.dll", "advapi32.dll", "bcrypt.dll",
  "crypt32.dll", "user32.dll", "userenv.dll", "version.dll", "ws2_32.dll",
]);

const nodeApi8Imports = new Set([
  "napi_create_double", "napi_create_error", "napi_create_object", "napi_create_string_utf8",
  "napi_define_properties", "napi_get_array_length", "napi_get_boolean", "napi_get_cb_info",
  "napi_get_element", "napi_get_named_property", "napi_get_undefined", "napi_get_value_bool",
  "napi_get_value_double", "napi_get_value_string_utf16", "napi_has_named_property",
  "napi_is_array", "napi_is_exception_pending", "napi_set_named_property", "napi_throw",
  "napi_throw_error", "napi_typeof", "napi_unwrap", "napi_wrap",
]);

export function auditImports(text) {
  const dlls = new Set();
  const nodeImports = new Set();
  let currentDll;

  for (const line of text.split(/\r?\n/)) {
    const dll = /^\s+([A-Za-z0-9_.-]+\.(?:dll|exe))\s*$/i.exec(line);

    if (dll) {
      currentDll = dll[1].toLowerCase();
      dlls.add(currentDll);
      continue;
    }

    if (/^\s*Summary\s*$/i.test(line)) currentDll = undefined;

    const symbol = /^\s*[0-9a-f]+\s+(\S+)\s*$/i.exec(line);

    if (currentDll === "node.exe" && symbol) nodeImports.add(symbol[1]);
  }

  if (!dlls.has("node.exe") || nodeImports.size === 0) {
    throw new Error("dumpbin output did not prove named Node-API imports");
  }

  for (const dll of dlls) {
    if (dll === "node.exe") continue;

    if (/^(?:vcruntime|msvcp|msvcr|ucrtbase|concrt|api-ms-win-crt-)/i.test(dll)) {
      throw new Error(`External C/C++ runtime dependency is forbidden: ${dll}`);
    }

    if (!systemDlls.has(dll) && !/^api-ms-win-core-[a-z0-9-]+\.dll$/.test(dll)) {
      throw new Error(`Unapproved non-system DLL dependency: ${dll}`);
    }
  }

  for (const symbol of nodeImports) {
    if (!nodeApi8Imports.has(symbol)) {
      throw new Error(`Import is not in the harness's Node-API 8 surface: ${symbol}`);
    }
  }

  return { dlls: [...dlls].sort(), nodeImports: [...nodeImports].sort() };
}

export async function sourceProvenance() {
  const files = [];

  for (const relative of [...inventory.sourceFiles].sort()) {
    const bytes = await readFile(path.join(packageRoot, relative));
    files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
  }

  return { files, fingerprint: sha256(Buffer.from(JSON.stringify(files))) };
}

export async function verifyArtifact(arch, directory = path.join(packageRoot, inventory.architectures[arch]?.directory ?? "")) {
  const target = inventory.architectures[arch];

  if (!target) throw new Error(`Unsupported harness architecture: ${arch}`);

  const metadata = JSON.parse(await readFile(path.join(directory, inventory.provenance), "utf8"));
  const bytes = await readFile(path.join(directory, inventory.binary));
  const imports = auditImports(await readFile(path.join(directory, "imports.txt"), "utf8"));
  const sources = await sourceProvenance();

  if (metadata.arch !== arch || metadata.nodeApiVersion !== 8 || peMachine(bytes) !== target.machine) {
    throw new Error("Harness architecture or stable Node-API version mismatch");
  }

  if (metadata.binary.sha256 !== sha256(bytes) || metadata.binary.bytes !== bytes.length) {
    throw new Error("Harness raw-byte binary hash mismatch");
  }

  if (metadata.sources.fingerprint !== sources.fingerprint) {
    throw new Error("Harness source fingerprint is stale; rebuild the binary");
  }

  if (JSON.stringify(metadata.imports) !== JSON.stringify(imports) || metadata.crt !== "/MT") {
    throw new Error("Harness import audit or static CRT provenance mismatch");
  }

  return { arch, directory, metadata };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arch = process.argv[2];
  const directory = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
  const result = await verifyArtifact(arch, directory);
  console.log(JSON.stringify({ verified: true, arch: result.arch, sourceFingerprint: result.metadata.sources.fingerprint }));
}
