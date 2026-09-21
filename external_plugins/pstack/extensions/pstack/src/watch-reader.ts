import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sha256 } from "./io.ts";
import type { SourceWarning, WatchProjection } from "./types.ts";

const WatchEventSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  sequence: Type.Integer(),
  observedAt: Type.Optional(Type.String()),
  mode: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  terminal: Type.Optional(Type.Boolean()),
  exitCode: Type.Optional(Type.Integer()),
}, { additionalProperties: true });

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
        .map((line) => JSON.parse(line))
        .filter((event) => Value.Check(WatchEventSchema, event))
        .sort((left, right) => left.sequence - right.sequence);

      const latest = events.at(-1);
      let latestEvent: WatchProjection["latest"] = null;

      if (latest) {
        const event = {
          sequence: latest.sequence,
          observedAt: latest.observedAt ?? "",
          mode: latest.mode ?? "",
          kind: latest.kind ?? "",
          terminal: latest.terminal === true,
        };

        latestEvent = latest.exitCode !== undefined
          ? { ...event, exitCode: latest.exitCode }
          : event;
      }

      watch.push({
        path,
        digest: sha256(raw),
        latest: latestEvent,
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
