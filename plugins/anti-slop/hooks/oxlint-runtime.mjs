import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const VERSION = "1.83.0";

const INSTALL_TIMEOUT = 90_000;

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));

const RULE_CODE = /^(?:anti-slop(?:-effect)?\(|oxc\(no-accumulating-spread\))/;

function runtimeRoot() {
  const home = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");

  return path.join(home, "anti-slop", `oxlint-${VERSION}-${process.platform}-${process.arch}`);
}

async function npmInvocation() {
  if (process.platform !== "win32") return ["npm", []];

  const directories = [
    path.dirname(process.execPath),
    ...(process.env.PATH ?? "").split(path.delimiter),
  ];

  for (const directory of directories) {
    if (!directory) continue;

    const cli = path.join(directory, "node_modules", "npm", "bin", "npm-cli.js");

    try {
      await access(cli);

      return [process.execPath, [cli]];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  throw new Error("npm CLI was not found alongside Node.js or on PATH");
}

async function readyRuntime(directory) {
  try {
    const installedVersion = await readFile(path.join(directory, ".ready"), "utf8");
    const executable = path.join(directory, "node_modules", "oxlint", "bin", "oxlint");

    await access(executable);

    return installedVersion === VERSION ? executable : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function oxlintExecutable() {
  const directory = runtimeRoot();
  const ready = await readyRuntime(directory);

  if (ready) return ready;

  await mkdir(path.dirname(directory), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(directory), "oxlint-install-"));

  try {
    const [npm, npmArguments] = await npmInvocation();

    try {
      await execFile(npm, [...npmArguments,
        "install", "--prefix", staging, "--no-save", "--no-package-lock",
        "--ignore-scripts", "--no-audit", "--no-fund", `oxlint@${VERSION}`,
      ], { timeout: INSTALL_TIMEOUT });
    } catch (error) {
      throw new Error(`Could not install Oxlint ${VERSION} in the user cache (${error?.code ?? "unknown error"}); check npm and registry access.`);
    }

    const binary = path.join(staging, "node_modules", "oxlint", "bin", "oxlint");

    await access(binary);

    const { stdout: versionOutput } = await execFile(process.execPath, [binary, "--version"], {
      timeout: 5_000,
    });

    if (!versionOutput.includes(VERSION)) {
      throw new Error(`Installed Oxlint version does not match ${VERSION}`);
    }

    await writeFile(path.join(staging, ".ready"), VERSION);

    try {
      await rename(staging, directory);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;

      if (!await readyRuntime(directory)) throw new Error(`Oxlint cache is incomplete: ${directory}`);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const executable = await readyRuntime(directory);

  if (!executable) throw new Error(`Oxlint installation is incomplete: ${directory}`);

  return executable;
}

export async function lintFile(file, cwd, { effect = false, executable } = {}) {
  const oxlint = executable ?? await oxlintExecutable();
  const config = path.join(PLUGIN_ROOT, effect ? "oxlint-effect.config.mjs" : "oxlint.config.mjs");

  const argumentsList = [
    oxlint, "--config", config, "--format", "json",
    "--disable-nested-config", "--no-ignore", file,
  ];

  let stdout;

  try {
    ({ stdout } = await execFile(process.execPath, argumentsList, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20_000,
    }));
  } catch (error) {
    if (error?.code !== 1) throw error;
    stdout = error.stdout;
  }

  const result = JSON.parse(stdout);

  if (!Array.isArray(result.diagnostics)) throw new Error("Oxlint produced an invalid diagnostics payload");

  return result.diagnostics.filter((diagnostic) =>
    typeof diagnostic.code === "string" && RULE_CODE.test(diagnostic.code)
  );
}
