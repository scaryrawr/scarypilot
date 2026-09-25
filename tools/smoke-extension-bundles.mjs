import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const extensions = [
  "external_plugins/pstack/extensions/pstack",
  "plugins/ado-codespaces/extensions/ado-codespaces",
  "plugins/copilot-autoresearch/extensions/copilot-autoresearch",
  "plugins/copilot-local-llm/extensions/copilot-local-llm",
  "plugins/digivolution/extensions/digivolution",
  "plugins/omlx-media/extensions/omlx-media",
];

for (const extension of extensions) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scarypilot-extension-"));

  try {
    const source = path.join(root, extension);
    const sdk = path.join(temporaryRoot, "node_modules", "@github", "copilot-sdk");

    await mkdir(sdk, { recursive: true });
    await Promise.all([
      cp(path.join(source, "extension.mjs"), path.join(temporaryRoot, "extension.mjs")),
      cp(path.join(source, "dist"), path.join(temporaryRoot, "dist"), { recursive: true }),
      writeFile(path.join(temporaryRoot, "gh"), "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 }),
      writeFile(path.join(temporaryRoot, "smoke.mjs"), [
        "globalThis.fetch = async () => { throw new Error('Network disabled during bundle smoke test'); };",
        "await import('./extension.mjs');",
      ].join("\n")),
      writeFile(path.join(sdk, "package.json"), JSON.stringify({
        name: "@github/copilot-sdk",
        type: "module",
        exports: { "./extension": "./extension.mjs" },
      })),
      writeFile(path.join(sdk, "extension.mjs"), [
        "export function defineFactory(definition) { return definition; }",
        "export async function joinSession(options) {",
        "  console.log('SCARYPILOT_SMOKE:' + JSON.stringify({ joined: true, tools: options.tools?.length ?? 0,",
        "    factories: options.factories?.length ?? 0, agents: options.customAgents?.length ?? 0 }));",
        "  return { log: async () => {}, on: () => () => {},",
        "    rpc: { model: { getCurrent: async () => ({}) },",
        "      options: { update: async () => ({ success: true }) } } };",
        "}",
      ].join("\n")),
    ]);

    const result = spawnSync(process.execPath, ["smoke.mjs"], {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        HOME: temporaryRoot,
        PATH: `${temporaryRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        SESSION_ID: "bundle-smoke",
      },
    });

    if (result.error || result.status !== 0) {
      throw new Error(`${extension}: isolated startup failed: ${result.error ?? result.stderr}`);
    }

    const registrationLine = result.stdout.split("\n")
      .find((line) => line.startsWith("SCARYPILOT_SMOKE:"));

    const registration = registrationLine && JSON.parse(registrationLine.slice("SCARYPILOT_SMOKE:".length));

    if (!registration || (extension.includes("/pstack/") &&
      (!registration.factories || !registration.agents))) {
      throw new Error(`${extension}: missing expected session registration`);
    }

    console.log(`${extension}: isolated startup verified`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
