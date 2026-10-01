import { access, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paired-review-bundle-"));

const extensionRoot = path.join(temporaryRoot, "azure-devops", "extensions", "paired-review");

const helperRoot = path.join(temporaryRoot, "azure-devops", "skills", "azure-devops", "scripts");

try {
  process.env.PAIRED_REVIEW_DISABLE_AUTOLOAD = "1";
  await mkdir(extensionRoot, { recursive: true });
  await Promise.all([
    cp(path.join(root, "extension.mjs"), path.join(extensionRoot, "extension.mjs")),
    cp(path.join(root, "dist"), path.join(extensionRoot, "dist"), { recursive: true }),
    cp(path.join(root, "public"), path.join(extensionRoot, "public"), { recursive: true }),
    cp(path.resolve(root, "../../skills/azure-devops/scripts"), helperRoot, {
      recursive: true,
      filter: (source) => !["tests", "__pycache__"].includes(path.basename(source)),
    }),
  ]);

  await access(path.join(helperRoot, "ado-bridge.py"));

  const sdkDirectory = path.join(
    extensionRoot,
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
      exports: { ".": "./extension.js", "./extension": "./extension.js" },
    }),
  );
  await writeFile(
    path.join(sdkDirectory, "extension.js"),
    [
      "export function defineTool(name, options) {",
      "  return { name, ...options };",
      "}",
      "export function createCanvas(options) {",
      "  globalThis.__pairedReviewCanvas = options;",
      "  return options;",
      "}",
      "export async function joinSession(options) {",
      "  globalThis.__pairedReviewSessionOptions = options;",
      "  return {",
      "    log: async () => {},",
      "    send: async () => {},",
      "    rpc: { canvas: { open: async () => {} } },",
      "    on: (event, listener) => { globalThis.__pairedReviewListeners.set(event, listener); return () => {}; },",
      "  };",
      "}",
    ].join("\n"),
  );

  globalThis.__pairedReviewListeners = new Map();
  await import(`${pathToFileURL(path.join(extensionRoot, "extension.mjs")).href}?smoke=1`);
  const canvas = globalThis.__pairedReviewCanvas;
  const sessionOptions = globalThis.__pairedReviewSessionOptions;

  if (!canvas || !sessionOptions) throw new Error("Bundled extension did not register");

  if ("hooks" in sessionOptions) throw new Error("Bundled extension unexpectedly registered hooks");

  const snapshotTool = sessionOptions.tools?.[0];

  if (sessionOptions.tools?.length !== 1 || snapshotTool?.name !== "azure_devops_pr_snapshot") {
    throw new Error("Bundled extension must register only the read-only PR snapshot tool");
  }

  if (sessionOptions.canvases?.[0] !== canvas || sessionOptions.commands?.length !== 1) {
    throw new Error("Snapshot tool must share the canvas and command registration");
  }

  if (snapshotTool.parameters?.properties?.prUrl?.type !== "string" ||
      !snapshotTool.parameters?.required?.includes("prUrl")) {
    throw new Error("Snapshot tool must require a prUrl string");
  }

  const invalidSnapshot = await snapshotTool.handler({ prUrl: "https://example.invalid/not-ado" });

  if (invalidSnapshot?.resultType !== "failure") {
    throw new Error("Bundled snapshot tool did not reject an unsupported URL");
  }

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

  const shutdown = globalThis.__pairedReviewListeners.get("session.shutdown");

  if (!shutdown) throw new Error("Bundled extension did not register shutdown cleanup");
  await shutdown({ type: "session.shutdown", data: { shutdownType: "routine" } });
  console.log("Bundle registers its canvas and snapshot tool without installed Node dependencies");
} finally {
  delete process.env.PAIRED_REVIEW_DISABLE_AUTOLOAD;
  delete globalThis.__pairedReviewCanvas;
  delete globalThis.__pairedReviewListeners;
  delete globalThis.__pairedReviewSessionOptions;
  await rm(temporaryRoot, { recursive: true, force: true });
}
