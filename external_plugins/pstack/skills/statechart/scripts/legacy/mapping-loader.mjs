import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const observations = new Map();
const conflicting = "different mapping dependency observations";

export function fingerprint(file) {
  try {
    const { ino, ctimeNs } = fs.statSync(file, { bigint: true });

    return `${ino} ${ctimeNs} ${fs.readFileSync(file, "base64")}`;
  } catch {
    return null;
  }
}

export function mergeMappingInputs(inputs, entries) {
  for (const [file, observed] of entries)
    inputs.set(file, inputs.has(file) && inputs.get(file) !== observed ? conflicting : observed);
}

export function loadMapping(file, inputs = observations) {
  const root = pathToFileURL(path.resolve(file)).href;
  const modules = new Set([root]);

  const record = (url) => {
    if (url.startsWith("file:")) {
      const file = fileURLToPath(url);
      mergeMappingInputs(inputs, [[file, fingerprint(file)]]);
    }
  };

  // Keep the hook through callbacks too: they can import modules after the mapping evaluates.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromMapping = specifier === root || modules.has(context.parentURL);

      if (
        fromMapping &&
        (specifier.startsWith("file:") || specifier.startsWith(".") || specifier.startsWith("/"))
      )
        record(new URL(specifier, context.parentURL).href);

      const result = nextResolve(specifier, context);

      if (fromMapping || result.url === root) {
        modules.add(result.url);
        record(result.url);
      }

      return result;
    },
    load(url, context, nextLoad) {
      if (modules.has(url)) record(url);
      const result = nextLoad(url, context);

      if (modules.has(url)) record(url);

      return result;
    },
  });

  return import(root);
}

// The parent launches chart subprocesses through this wrapper, with a private evidence pipe.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.argv.splice(1, 1);
  process.once("exit", () => fs.writeFileSync(3, JSON.stringify([...observations])));
  import(pathToFileURL(path.resolve(process.argv[1])).href).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
