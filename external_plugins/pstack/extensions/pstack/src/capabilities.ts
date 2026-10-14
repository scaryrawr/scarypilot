import type { CapabilityState, PstackCapabilities } from "./types.ts";
import type { ProcessPort } from "./io.ts";
import { errorMessage, processPort } from "./io.ts";

async function usableExecutable(
  command: string,
  args: readonly string[],
  port: ProcessPort,
): Promise<CapabilityState> {
  const label = [command, ...args].join(" ");

  try {
    const result = await port.run(command, args, { timeoutMs: 3_000 });
    const detail = result.stdout.trim().split(/\r?\n/, 1)[0] || command;

    return { kind: "available", detail };
  } catch (error) {
    return { kind: "unavailable", reason: `${label} probe failed: ${errorMessage(error)}` };
  }
}

export async function detectCapabilities(
  port: ProcessPort = processPort,
): Promise<PstackCapabilities> {
  const [git, githubCli, ghStack, bunLegacyScripts] = await Promise.all([
    usableExecutable("git", ["--version"], port),
    usableExecutable("gh", ["--version"], port),
    usableExecutable("gh", ["stack", "--version"], port),
    usableExecutable("bun", ["--version"], port),
  ]);

  const hostUnknown = (surface: string): CapabilityState => ({
    kind: "unknown",
    reason: `${surface} availability is controlled by the Copilot host and is not exposed to extensions`,
  });

  return {
    git,
    githubCli,
    ghStack,
    bunLegacyScripts,
    taskAgents: hostUnknown("Task agents"),
    sessionHistory: hostUnknown("session history"),
    browserAutomation: hostUnknown("browser automation"),
    mcp: hostUnknown("MCP tools"),
    sidebarSessions: hostUnknown("App sidebar sessions"),
  };
}
