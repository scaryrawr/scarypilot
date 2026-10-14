import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inventory, packageRoot, resource, sha256, sourceProvenance } from "./resources.mjs";

export { inventory, packageRoot, sha256, sourceProvenance } from "./resources.mjs";

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
  "napi_acquire_threadsafe_function", "napi_add_env_cleanup_hook", "napi_call_threadsafe_function",
  "napi_create_buffer_copy", "napi_call_function", "napi_create_threadsafe_function", "napi_get_null",
  "napi_get_typedarray_info", "napi_release_threadsafe_function",
  "napi_remove_env_cleanup_hook",
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

export async function verifyArtifact(arch, directory, kind = "harness") {
  const target = resource(kind, arch);
  directory ??= path.join(packageRoot, target.directory);

  const metadata = JSON.parse(await readFile(path.join(directory, inventory.provenance), "utf8"));
  const bytes = await readFile(path.join(directory, target.binary));
  const imports = auditImports(await readFile(path.join(directory, "imports.txt"), "utf8"));
  const sources = await sourceProvenance();

  if (metadata.schemaVersion !== 1 || metadata.arch !== arch || metadata.nodeApiVersion !== 8 ||
      metadata.binary.machine !== target.machine || peMachine(bytes) !== target.machine) {
    throw new Error("Native artifact architecture or stable Node-API version mismatch");
  }

  if (metadata.kind !== kind || metadata.binary.name !== target.binary) {
    throw new Error("Native artifact kind/name mismatch");
  }

  if (kind === "runtime" && metadata.protocolVersion !== 2) {
    throw new Error("Native runtime notification protocol mismatch");
  }

  if (metadata.binary.sha256 !== sha256(bytes) || metadata.binary.bytes !== bytes.length) {
    throw new Error("Native artifact raw-byte binary hash mismatch");
  }

  if (JSON.stringify(metadata.sources) !== JSON.stringify(sources)) {
    throw new Error("Native artifact source provenance is stale or incomplete; rebuild the binary");
  }

  if (JSON.stringify(metadata.imports) !== JSON.stringify(imports) || metadata.crt !== "/MT") {
    throw new Error("Native artifact import audit or static CRT provenance mismatch");
  }

  return { arch, directory, metadata };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arch = process.argv[2];
  const directory = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
  const kind = process.argv[4] ?? "harness";
  const result = await verifyArtifact(arch, directory, kind);
  console.log(JSON.stringify({ verified: true, arch: result.arch, sourceFingerprint: result.metadata.sources.fingerprint }));
}
