import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const instruction = "Automatic Git requires .auto/cli* control files to be ignored and untracked. Add .auto/cli* to your ignore rules and explicitly untrack any indexed control files, then retry; the CLI will not edit or stage ignore configuration.";

function queryGit(
  workDir: string,
  args: string[],
  allowedStatuses: number[],
  input?: string,
): string {
  const result = spawnSync("git", [
    "--no-optional-locks", "-c", "core.fsmonitor=false", ...args,
  ], {
    cwd: workDir, encoding: "utf8", input, timeout: 5000, maxBuffer: 65536,
    windowsHide: true,
  });

  if (result.error || result.status === null || !allowedStatuses.includes(result.status)) {
    throw new Error(`${instruction} Read-only Git inspection failed: ${result.error?.message ?? `exit ${result.status}: ${result.stderr.trim()}`}`);
  }

  return result.stdout;
}

export function requireIgnoredCliControls(workDir: string): void {
  const tracked = queryGit(workDir, ["ls-files", "--cached", "-z", "--", ".auto/cli*"], [0]);

  if (tracked.length > 0) throw new Error(`${instruction} Tracked control files: ${tracked.split("\0").filter(Boolean).join(", ")}.`);

  const required = new Set([
    ".auto/cli.json", ".auto/cli.lock", ".auto/cli.lock.recovery",
    `.auto/cli.json.${randomUUID()}.tmp`,
  ]);

  const directory = path.join(workDir, ".auto");

  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith("cli")) required.add(`.auto/${name}`);
    }
  }

  const ignored = new Set(queryGit(workDir, [
    "check-ignore", "--no-index", "--stdin", "-z",
  ], [0, 1], `${[...required].join("\0")}\0`).split("\0").filter(Boolean));

  const unignored = [...required].filter((file) => !ignored.has(file));

  if (unignored.length > 0) throw new Error(`${instruction} Not ignored: ${unignored.join(", ")}.`);
}
