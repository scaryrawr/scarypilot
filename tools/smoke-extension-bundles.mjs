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
  "plugins/omlx-decisions/extensions/omlx-decisions",
  "plugins/screen-record/extensions/screen-record",
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
      writeFile(path.join(temporaryRoot, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
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
        "export function defineWorkflow(definition) { return Object.freeze({ meta: definition.meta }); }",
        "export async function joinSession(options) {",
        "  if (!options || typeof options !== 'object') throw new Error('Missing session options');",
        "  if ('factories' in options) throw new Error('Obsolete factory registration');",
        "  const workflows = options.workflows ?? [];",
        "  if (workflows.some((workflow) => !workflow.meta?.name || 'run' in workflow))",
        "    throw new Error('Invalid workflow registration');",
        "  console.log('SCARYPILOT_SMOKE:' + JSON.stringify({ joined: true, tools: options.tools?.length ?? 0,",
        "    toolNames: options.tools?.map((tool) => tool.name) ?? [],",
        "    workflows: workflows.map((workflow) => workflow.meta.name),",
        "    agents: options.customAgents?.map((agent) => agent.name) ?? [] }));",
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
        PATH: temporaryRoot,
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
      (!registration.workflows.includes("pstack-swarm") ||
        !registration.agents.includes("pstack-swarm-worker")))) {
      throw new Error(`${extension}: missing expected session registration`);
    }

    if (extension === "plugins/screen-record/extensions/screen-record" &&
      JSON.stringify(registration.toolNames.toSorted()) !== JSON.stringify([
        "screen_record_devices", "screen_record_doctor", "screen_record_start",
        "screen_record_status", "screen_record_stop", "screen_record_windows",
      ])) {
      throw new Error(`${extension}: missing expected capture lifecycle tools`);
    }

    if (extension === "plugins/omlx-decisions/extensions/omlx-decisions" &&
      JSON.stringify(registration.toolNames.toSorted()) !== JSON.stringify([
        "omlx_decide", "omlx_decision_models",
      ])) {
      throw new Error(`${extension}: missing expected SystemOne decision tools`);
    }

    console.log(`${extension}: isolated startup verified`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
