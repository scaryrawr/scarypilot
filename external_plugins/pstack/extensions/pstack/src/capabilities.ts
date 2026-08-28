import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { CapabilityState, PstackCapabilities } from "./types.ts";
import type { ProcessPort } from "./io.ts";
import { processPort } from "./io.ts";

function executableState(command: string, pathValue = process.env.PATH ?? ""): CapabilityState {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  const candidates = pathValue.split(delimiter).flatMap((directory) =>
    extensions.map((extension) => join(directory, `${command}${extension}`)),
  );
  const detail = candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  return detail
    ? { kind: "available", detail }
    : { kind: "unavailable", reason: `${command} is not on PATH` };
}

async function usableExecutable(
  command: string,
  args: readonly string[],
  port: ProcessPort,
): Promise<CapabilityState> {
  const installed = executableState(command);
  if (installed.kind !== "available") return installed;
  try {
    const result = await port.run(command, args, { timeoutMs: 3_000 });
    const detail = result.stdout.trim().split(/\r?\n/, 1)[0] || installed.detail;
    return { kind: "available", detail };
  } catch {
    return { kind: "available", detail: installed.detail };
  }
}

export async function detectCapabilities(
  port: ProcessPort = processPort,
): Promise<PstackCapabilities> {
  const [git, githubCli, graphite, bunLegacyScripts] = await Promise.all([
    usableExecutable("git", ["--version"], port),
    usableExecutable("gh", ["--version"], port),
    usableExecutable("gt", ["--version"], port),
    usableExecutable("bun", ["--version"], port),
  ]);
  const hostUnknown = (surface: string): CapabilityState => ({
    kind: "unknown",
    reason: `${surface} availability is controlled by the Copilot host and is not exposed to extensions`,
  });
  return {
    git,
    githubCli,
    graphite,
    bunLegacyScripts,
    taskAgents: hostUnknown("Task agents"),
    sessionHistory: hostUnknown("session history"),
    browserAutomation: hostUnknown("browser automation"),
    mcp: hostUnknown("MCP tools"),
    sidebarSessions: hostUnknown("App sidebar sessions"),
  };
}
