import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { packageRoot, resources } from "./resources.mjs";
import { verifyArtifact } from "./verify-artifact.mjs";

async function expectedResources(artifactsDirectory, directoryKey = "directory") {
  const descriptor = await resources();
  const binaries = {};

  for (const target of descriptor.targets) {
    const directory = path.join(artifactsDirectory, path.basename(target[directoryKey]));
    const verified = await verifyArtifact(target.arch, directory, "runtime");

    for (const file of target.files) await readFile(path.join(directory, file));

    binaries[target.arch] = verified.metadata.binary.sha256;
  }

  return {
    descriptor,
    manifest: {
      schemaVersion: descriptor.schemaVersion,
      nodeApiVersion: descriptor.nodeApiVersion,
      protocolVersion: descriptor.protocolVersion,
      sourceFingerprint: descriptor.sources.fingerprint,
      binaries,
    },
  };
}

export async function verifyInstalledResources({ prebuildsDirectory, installedDirectory } = {}) {
  const descriptor = await resources();
  installedDirectory ??= path.join(packageRoot, path.dirname(descriptor.targets[0].installedDirectory));
  const expected = await expectedResources(installedDirectory, "installedDirectory");

  if (prebuildsDirectory !== undefined) {
    await expectedResources(prebuildsDirectory);

    for (const target of expected.descriptor.targets) {
      const source = path.join(prebuildsDirectory, path.basename(target.directory));
      const installed = path.join(installedDirectory, path.basename(target.installedDirectory));

      for (const file of target.files) {
        const [sourceBytes, installedBytes] = await Promise.all([
          readFile(path.join(source, file)), readFile(path.join(installed, file)),
        ]);

        if (!sourceBytes.equals(installedBytes)) {
          throw new Error(`Installed native resource differs from its verified prebuild: ${target.arch}/${file}`);
        }
      }
    }
  }

  const manifest = JSON.parse(await readFile(path.join(installedDirectory, "resources.json"), "utf8"));

  if (!isDeepStrictEqual(manifest, expected.manifest)) {
    throw new Error("Installed native resources manifest does not match the current inventory, protocol, source fingerprint or binary hashes");
  }

  return expected.manifest;
}

export async function preparePrebuilds({ prebuildsDirectory, installedDirectory } = {}) {
  const descriptor = await resources();
  prebuildsDirectory ??= path.join(packageRoot, path.dirname(descriptor.targets[0].directory));
  installedDirectory ??= path.join(packageRoot, path.dirname(descriptor.targets[0].installedDirectory));

  try {
    const expected = await expectedResources(prebuildsDirectory);

    return { prepared: true, hydrated: false, sourceFingerprint: expected.manifest.sourceFingerprint };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const manifest = await verifyInstalledResources({ installedDirectory });

  for (const target of descriptor.targets) {
    const source = path.join(installedDirectory, path.basename(target.installedDirectory));
    const destination = path.join(prebuildsDirectory, path.basename(target.directory));
    await mkdir(destination, { recursive: true });

    for (const file of target.files) await cp(path.join(source, file), path.join(destination, file));
  }

  await expectedResources(prebuildsDirectory);

  return { prepared: true, hydrated: true, sourceFingerprint: manifest.sourceFingerprint };
}

async function assemble() {
  const descriptor = await resources();
  const prebuildsDirectory = path.join(packageRoot, path.dirname(descriptor.targets[0].directory));
  const expected = await expectedResources(prebuildsDirectory);

  for (const target of expected.descriptor.targets) {
    const source = path.join(prebuildsDirectory, path.basename(target.directory));
    const destination = path.join(packageRoot, target.installedDirectory);
    await mkdir(destination, { recursive: true });

    for (const file of target.files) await cp(path.join(source, file), path.join(destination, file));
  }

  await writeFile(path.join(packageRoot, "dist/native/resources.json"),
    `${JSON.stringify(expected.manifest, null, 2)}\n`);

  await verifyInstalledResources({ prebuildsDirectory });

  return { assembled: expected.descriptor.outputs, sourceFingerprint: expected.manifest.sourceFingerprint };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== "--prepare")) {
    throw new Error("Usage: node native/assemble.mjs [--prepare]");
  }

  console.log(JSON.stringify(await (process.argv[2] === "--prepare" ? preparePrebuilds() : assemble())));
}
