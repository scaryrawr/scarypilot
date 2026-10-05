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

const expectedTools = [
  "azure_devops_pr_snapshot", "azure_devops_work_item_search",
  "azure_devops_work_item_query", "azure_devops_work_item_get",
];

if (JSON.stringify(registration.tools.map((registered) => registered.name)) !== JSON.stringify(expectedTools)) {
  throw new Error("Installed bundle did not register exactly the four read-only Azure DevOps tools.");
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
