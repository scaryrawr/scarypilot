import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { detectCapabilities } from "./capabilities.ts";
import type { CwdRef } from "./extension-context.ts";
import { errorMessage, type ProcessPort, processPort } from "./io.ts";
import {
  gitStatePath,
  handoffDirectory,
  latestHandoff,
  readHandoff,
  writeHandoff,
} from "./handoff.ts";
import { readOrchStore } from "./orch-reader.ts";
import { recordVerificationReceipt, type RecordReceiptInput } from "./receipt.ts";
import { buildSnapshot } from "./snapshot.ts";
import type {
  HandoffV1,
  PstackCapabilities,
  PstackSnapshot,
  SourceWarning,
  VerificationReceiptV1,
  WorktreeProjection,
} from "./types.ts";
import { readWatchFiles } from "./watch-reader.ts";
import { inspectWorktrees } from "./worktrees.ts";
import {
  PLAN_PROFILES,
  validatePlanText,
  type PlanValidation,
} from "../../../skills/poteto-mode/scripts/plan-rules.mjs";

export interface StatusInput {
  readonly storeDir?: string;
  readonly watchFiles?: readonly string[];
  readonly includeWorktrees?: boolean;
  readonly baseRef?: string;
}

export interface PstackService {
  readonly capabilities: () => Promise<PstackCapabilities>;
  readonly status: (input?: StatusInput) => Promise<PstackSnapshot>;
  readonly validatePlan: (path: string, profile?: string) => Promise<PlanValidation>;
  readonly recordReceipt: (
    input: RecordReceiptInput,
  ) => Promise<{ readonly receipt: VerificationReceiptV1; readonly path: string }>;
  readonly inspectWorktrees: (baseRef?: string) => Promise<WorktreeProjection>;
  readonly writeHandoff: (
    sessionId: string,
    input: Omit<HandoffV1, "schemaVersion" | "sessionId" | "createdAt" | "snapshot"> & {
      readonly storeDir?: string;
      readonly watchFiles?: readonly string[];
    },
  ) => Promise<{ readonly path: string; readonly handoff: HandoffV1 }>;
  readonly readHandoff: (path?: string) => Promise<HandoffV1>;
}

async function discoverStore(cwd: string, port: ProcessPort): Promise<{
  readonly storeDir?: string;
  readonly warning?: SourceWarning;
}> {
  const parent = await gitStatePath(cwd, "pstack/orchestrate", port);
  let entries;
  try {
    entries = (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (entries.length === 1) return { storeDir: entries[0] };
  if (entries.length > 1) {
    return {
      warning: {
        source: "orch",
        path: parent,
        message: "multiple orch stores found; pass store_dir explicitly",
      },
    };
  }
  return {};
}

export function createPstackService(
  cwdRef: CwdRef,
  port: ProcessPort = processPort,
): PstackService {
  const capabilities = () => detectCapabilities(port);
  const worktrees = (baseRef?: string) => inspectWorktrees(cwdRef.get(), baseRef, port);

  const status = async (input: StatusInput = {}): Promise<PstackSnapshot> => {
    const warnings: SourceWarning[] = [];
    const discovered = input.storeDir ? { storeDir: resolve(input.storeDir) } : await discoverStore(cwdRef.get(), port);
    if (discovered.warning) warnings.push(discovered.warning);
    const [caps, orch, watch, handoff] = await Promise.all([
      capabilities(),
      readOrchStore(discovered.storeDir),
      readWatchFiles(input.watchFiles ?? []),
      latestHandoff(cwdRef.get(), port).catch((error) => {
        warnings.push({ source: "handoff", message: errorMessage(error) });
        return { summary: null, source: null };
      }),
    ]);
    let worktreeProjection: WorktreeProjection | null = null;
    if (input.includeWorktrees) {
      try {
        worktreeProjection = await worktrees(input.baseRef);
      } catch (error) {
        warnings.push({ source: "worktrees", message: errorMessage(error) });
      }
    }
    return buildSnapshot({
      capabilities: caps,
      sources: [
        ...orch.sources,
        ...watch.watch.map((entry) => ({
          kind: "watch-pr" as const,
          path: entry.path,
          digest: entry.digest,
        })),
        ...(handoff.source ? [handoff.source] : []),
      ],
      orch: orch.projection,
      watch: watch.watch,
      worktrees: worktreeProjection,
      handoff: handoff.summary,
      sourceWarnings: [...warnings, ...orch.warnings, ...watch.warnings],
    });
  };

  return {
    capabilities,
    status,
    validatePlan: async (path, profile = "verified-stack") => {
      if (!PLAN_PROFILES.includes(profile as (typeof PLAN_PROFILES)[number])) {
        throw new Error(`profile must be one of ${PLAN_PROFILES.join(", ")}`);
      }
      return validatePlanText(await readFile(resolve(path), "utf8"), profile);
    },
    recordReceipt: async (input) => {
      const result = await recordVerificationReceipt(input);
      return { receipt: result.receipt, path: result.path };
    },
    inspectWorktrees: worktrees,
    writeHandoff: async (sessionId, input) => {
      const snapshot = await status({
        storeDir: input.storeDir,
        watchFiles: input.watchFiles,
        includeWorktrees: false,
      });
      return writeHandoff(
        cwdRef.get(),
        sessionId,
        {
          intent: input.intent,
          progress: input.progress,
          nextAction: input.nextAction,
          keyFiles: input.keyFiles,
          snapshot,
        },
        port,
      );
    },
    readHandoff: async (path) => {
      if (path) return readHandoff(isAbsolute(path) ? path : resolve(cwdRef.get(), path));
      const directory = await handoffDirectory(cwdRef.get(), port);
      const entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => join(directory, entry.name));
      if (entries.length === 0) throw new Error("no pstack handoff found");
      const withTimes = await Promise.all(
        entries.map(async (entry) => ({
          entry,
          createdAt: (await readHandoff(entry)).createdAt,
        })),
      );
      return readHandoff(
        withTimes.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0].entry,
      );
    },
  };
}
