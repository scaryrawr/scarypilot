import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionRoot = process.argv[2];

const sdkRoot = path.join(extensionRoot, "node_modules", "@github", "copilot-sdk");

await mkdir(sdkRoot, { recursive: true });

await writeFile(path.join(sdkRoot, "package.json"), JSON.stringify({
  type: "module", exports: { ".": "./extension.mjs", "./extension": "./extension.mjs" },
}));

await writeFile(path.join(sdkRoot, "extension.mjs"), [
  "let options;",
  "export function defineTool(name, definition) { return { name, ...definition }; }",
  "export function createCanvas(definition) { return definition; }",
  "export function getOptions() { return options; }",
  "export async function joinSession(config) { options = config; return { on: () => () => {} }; }",
].join("\n"));

await import(pathToFileURL(path.join(extensionRoot, "extension.mjs")).href);

const { getOptions } = await import(pathToFileURL(path.join(sdkRoot, "extension.mjs")).href);

const registration = getOptions();

const tool = registration.tools[0];

if (registration.tools.length !== 1 || tool.name !== "azure_devops_pr_snapshot") {
  throw new Error("Installed bundle did not register exactly the read-only snapshot tool.");
}

const snapshots = [];

for (let index = 0; index < 2; index++) {
  const result = await tool.handler({
    prUrl: "https://dev.azure.com/example/project/_git/repo/pullrequest/42",
  });

  if (result.resultType !== "success") throw new Error(result.textResultForLlm);
  snapshots.push(JSON.parse(result.textResultForLlm));
}

process.stdout.write(JSON.stringify({
  tools: registration.tools.map((registered) => registered.name),
  canvases: registration.canvases.length,
  commands: registration.commands.length,
  snapshots,
}));
