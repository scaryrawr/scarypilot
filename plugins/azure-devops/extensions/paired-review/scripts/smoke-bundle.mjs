import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paired-review-bundle-"));

try {
  process.env.PAIRED_REVIEW_DISABLE_AUTOLOAD = "1";
  await Promise.all([
    cp(path.join(root, "extension.mjs"), path.join(temporaryRoot, "extension.mjs")),
    cp(path.join(root, "dist"), path.join(temporaryRoot, "dist"), { recursive: true }),
    cp(path.join(root, "public"), path.join(temporaryRoot, "public"), { recursive: true }),
  ]);

  const sdkDirectory = path.join(
    temporaryRoot,
    "node_modules",
    "@github",
    "copilot-sdk",
  );
  await mkdir(sdkDirectory, { recursive: true });
  await writeFile(
    path.join(sdkDirectory, "package.json"),
    JSON.stringify({
      name: "@github/copilot-sdk",
      type: "module",
      exports: { "./extension": "./extension.js" },
    }),
  );
  await writeFile(
    path.join(sdkDirectory, "extension.js"),
    [
      "export function createCanvas(options) {",
      "  globalThis.__pairedReviewCanvas = options;",
      "  return options;",
      "}",
      "export async function joinSession(options) {",
      "  globalThis.__pairedReviewSessionOptions = options;",
      "  return { log: async () => {}, send: async () => {}, rpc: { canvas: { open: async () => {} } } };",
      "}",
    ].join("\n"),
  );

  await import(`${pathToFileURL(path.join(temporaryRoot, "extension.mjs")).href}?smoke=1`);
  const canvas = globalThis.__pairedReviewCanvas;
  const sessionOptions = globalThis.__pairedReviewSessionOptions;
  if (!canvas || !sessionOptions) throw new Error("Bundled extension did not register");

  const opened = await canvas.open({
    instanceId: "bundle-smoke",
    input: {
      prUrl: "https://dev.azure.com/example/project/_git/repo/pullrequest/42",
    },
  });
  const response = await fetch(opened.url);
  const html = await response.text();
  if (!response.ok || !html.includes("/app/assets/app.js")) {
    throw new Error("Bundled canvas did not serve the production frontend");
  }
  await sessionOptions.hooks.onSessionEnd();
  console.log("Bundle runs without installed runtime dependencies");
} finally {
  delete process.env.PAIRED_REVIEW_DISABLE_AUTOLOAD;
  delete globalThis.__pairedReviewCanvas;
  delete globalThis.__pairedReviewSessionOptions;
  await rm(temporaryRoot, { recursive: true, force: true });
}
