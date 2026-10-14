import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export const inventory = JSON.parse(await readFile(new URL("./harness-resources.json", import.meta.url), "utf8"));

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const generated = new Set(inventory.sourceDiscovery.excludedDirectories);


export const artifactFiles = ["provenance.json", "imports.txt", "dependents.txt", "compile.txt"];

export function resource(kind, arch) {
  if (!["harness", "runtime"].includes(kind) || !["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported native resource: ${kind}/${arch}`);
  }

  const target = inventory.architectures[arch];

  return {
    kind, arch, machine: target.machine,
    directory: kind === "runtime" ? `native/prebuilds/win32-${arch}` : target.directory,
    installedDirectory: `dist/native/win32-${arch}`,
    binary: kind === "runtime" ? "owned-job.node" : inventory.binary,
    entry: kind === "runtime" ? "native/runtime/owned_job_runtime.cc" : "native/harness/owned_job_harness.cc",
  };
}

export async function sourceProvenance() {
  const files = [];

  async function discover(directory) {
    for (const entry of await readdir(path.join(packageRoot, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;

      if (entry.isDirectory() && !(directory === "native" && generated.has(entry.name))) await discover(relative);
      else if (entry.isSymbolicLink()) throw new Error(`Native source symlinks cannot bypass provenance: ${relative}`);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(packageRoot, relative));
        files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  }

  await discover("native");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  return { files, fingerprint: sha256(Buffer.from(JSON.stringify(files))) };
}

export async function resources() {
  const sources = await sourceProvenance();

  const targets = ["x64", "arm64"].map((arch) => {
    const target = resource("runtime", arch);

    return { ...target, files: [target.binary, ...artifactFiles] };
  });

  return {
    schemaVersion: 1, nodeApiVersion: 8, protocolVersion: 2, sources,
    inputs: sources.files.map((file) => file.path),
    targets,
    outputs: ["dist/native/resources.json", ...targets.flatMap((target) =>
      target.files.map((file) => `${target.installedDirectory}/${file}`))],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await resources(), null, 2));
}
