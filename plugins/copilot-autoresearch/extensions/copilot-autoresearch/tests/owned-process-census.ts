import { spawn, type ChildProcess } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export interface OwnedPids {
  root: number;
  markerParent: number;
  readyGrandchild: number;
}

const IdentitySchema = Type.Object({
  ProcessId: Type.Integer({ minimum: 1, maximum: 0xffff_ffff }),
  ParentProcessId: Type.Integer({ minimum: 0, maximum: 0xffff_ffff }),
  Name: Type.String({ maxLength: 512 }),
}, { additionalProperties: false });

const CensusSchema = Type.Array(IdentitySchema, { maxItems: 3 });

export type ProcessIdentity = Static<typeof IdentitySchema>;

export function censusCommand(pids: OwnedPids): string {
  const ids = [pids.root, pids.markerParent, pids.readyGrandchild];

  if (ids.some((pid) => !Number.isInteger(pid) || pid < 1 || pid > 0xffff_ffff)) {
    throw new Error("Census requires three validated, fixture-owned native PIDs");
  }

  const filter = [...new Set(ids)].map((pid) => `ProcessId = ${pid}`).join(" OR ");

  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::Error.WriteLine('OWNED_CENSUS_PHASE script-started')",
    `$rows = @(Get-CimInstance -ClassName Win32_Process -Filter '${filter}' | Select-Object ProcessId, ParentProcessId, Name)`,
    "[Console]::Error.WriteLine('OWNED_CENSUS_PHASE query-completed')",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("; ");
}

export interface CommandEvidence {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnErrorCode?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function observeCommand(child: ChildProcess): Promise<CommandEvidence> {
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let spawnErrorCode: string | undefined;
  child.stdout?.on("data", (data: Buffer) => {
    stdout = (stdout + data.toString("utf-8")).slice(-4096);
  });
  child.stderr?.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString("utf-8")).slice(-4096);
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    spawnErrorCode = error.code;
  });

  return new Promise((resolve) => {
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal, spawnErrorCode, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

export async function ownedCensus(pids: OwnedPids) {
  const command = censusCommand(pids);

  const evidence = await observeCommand(spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
  ], {
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }));

  let identities: ProcessIdentity[] = [];
  let probeError: string | undefined;

  const actors = [
    { role: "root", pid: pids.root },
    { role: "markerParent", pid: pids.markerParent },
    { role: "readyGrandchild", pid: pids.readyGrandchild },
  ];

  if (evidence.exitCode !== 0 || evidence.signal || evidence.spawnErrorCode) {
    probeError = "powershell-failed";
  } else {
    try {
      identities = Value.Parse(CensusSchema, JSON.parse(evidence.stdout.replace(/^\uFEFF/, "")));

      if (identities.some((identity) => !actors.some((actor) => actor.pid === identity.ProcessId))) {
        identities = [];
        probeError = "unexpected-pid";
      }
    } catch {
      probeError = "invalid-identity-response";
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    queryDurationMs: evidence.durationMs,
    queryExitCode: evidence.exitCode,
    querySignal: evidence.signal,
    querySpawnErrorCode: evidence.spawnErrorCode,
    queryStderr: evidence.stderr,
    probeError,
    actors: actors.map(({ role, pid }) => ({
      role,
      pid,
      identity: identities.find((identity) => identity.ProcessId === pid) ?? null,
    })),
  };
}
