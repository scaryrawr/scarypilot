import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "./io.ts";
import type { SourceWarning, WatchProjection } from "./types.ts";

export async function readWatchFiles(
  paths: readonly string[],
): Promise<{ readonly watch: readonly WatchProjection[]; readonly warnings: readonly SourceWarning[] }> {
  const watch: WatchProjection[] = [];
  const warnings: SourceWarning[] = [];
  for (const input of [...paths].sort()) {
    const path = resolve(input);
    try {
      const raw = await readFile(path, "utf8");
      const events = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.schemaVersion === 1 && Number.isInteger(event.sequence))
        .sort((left, right) => Number(left.sequence) - Number(right.sequence));
      const latest = events.at(-1);
      watch.push({
        path,
        digest: sha256(raw),
        latest: latest
          ? {
              sequence: Number(latest.sequence),
              observedAt: String(latest.observedAt ?? ""),
              mode: String(latest.mode ?? ""),
              kind: String(latest.kind ?? ""),
              terminal: latest.terminal === true,
              ...(Number.isInteger(latest.exitCode) ? { exitCode: Number(latest.exitCode) } : {}),
            }
          : null,
      });
    } catch (error) {
      warnings.push({
        source: "watch-pr",
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { watch, warnings };
}
