import type { JsonValue, WorkflowContext } from "@github/copilot-sdk/extension";
import * as fixtureFs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCwdRef } from "../src/extension-context.ts";
import {
  aggregateStepKey,
  pinnedInputStepKey,
  runSwarmWorkflow,
  type SwarmArgs,
} from "../src/workflows/swarm.ts";

const directories: string[] = [];

const pass = { status: "PASS", summary: "Covered.", evidence: ["input.bin"] };

const issues = { status: "ISSUES", summary: "An issue remains.", evidence: ["input.bin:1"] };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    fixtureFs.rm(path, { recursive: true, force: true })
  ));
});

async function workspace(bytes = Buffer.from([0, 255, 128, 13, 10])) {
  const directory = await fixtureFs.mkdtemp(join(tmpdir(), "pstack-pinned-"));
  directories.push(directory);
  const cwd = await fixtureFs.realpath(directory);
  await fixtureFs.writeFile(join(cwd, "input.bin"), bytes);

  return cwd;
}

function input(inputFiles?: string[]): SwarmArgs {
  const args: SwarmArgs = {
    schemaVersion: 1,
    objective: "Inspect the declared input.",
    donePredicate: "Each slice returns evidence.",
    aggregation: "coverage",
    workers: [
      { id: "first", brief: "Inspect bytes." },
      { id: "second", brief: "Inspect semantics." },
    ],
  };

  if (inputFiles !== undefined) args.inputFiles = inputFiles;

  return args;
}

function journalContext(args: SwarmArgs, signal = new AbortController().signal) {
  const steps = new Map<string, JsonValue>();
  const workers = new Map<string, JsonValue>();
  const stepExecutions: string[] = [];
  const admissions: string[] = [];
  let invocation = 0;

  const executeStep = async (key: string, producer: () => JsonValue | Promise<JsonValue>) => {
    const cached = steps.get(key);

    if (cached !== undefined) return structuredClone(cached);
    stepExecutions.push(key);
    const result = await producer();
    steps.set(key, structuredClone(result));

    return result;
  };

  const ctx: Pick<
    WorkflowContext<SwarmArgs>,
    "agent" | "args" | "log" | "parallel" | "phase" | "signal" | "step"
  > = {
    args,
    signal,
    agent: vi.fn(async (_prompt, options) => {
      const label = options?.label;

      if (!label) throw new Error("worker label is required");

      if (workers.has(label)) return structuredClone(workers.get(label));
      admissions.push(label);
      const result = invocation++ === 0 ? pass : issues;
      workers.set(label, result);

      return result;
    }),
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    phase: vi.fn(),
    log: vi.fn(),
    step: vi.fn(executeStep),
  };

  return { ctx, steps, workers, stepExecutions, admissions, executeStep };
}

async function inventory(cwd: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const entry of await fixtureFs.readdir(cwd, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    result[path] = entry.isFile()
      ? (await fixtureFs.readFile(path)).toString("hex")
      : entry.isSymbolicLink() ? `symlink:${await fixtureFs.readlink(path)}` : "directory";
  }

  return result;
}

describe("pinned swarm caller contract", () => {
  it("normalizes extra worker metadata for pinned runs without storing it", async () => {
    const cwd = await workspace();
    const { ctx } = journalContext(input(["input.bin"]));
    vi.mocked(ctx.agent).mockResolvedValue({ ...pass, accepted: true });
    const result = await runSwarmWorkflow(ctx, cwd);

    expect(result.status).toBe("complete");
    expect(result.gaps).toEqual([]);
    expect(result.workers).toEqual([{ id: "first", ...pass }, { id: "second", ...pass }]);
  });

  it("returns ordered canonical paths, directory identity and exact-byte SHA256 without writes", async () => {
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    const cwd = await workspace(bytes);
    await fixtureFs.writeFile(join(cwd, "second.txt"), "second");
    const before = await inventory(cwd);
    const { ctx, stepExecutions } = journalContext(input(["second.txt", "./input.bin"]));
    const stat = await fixtureFs.stat(cwd, { bigint: true });

    const result = await runSwarmWorkflow(ctx, cwd);

    expect(result).toEqual({
      schemaVersion: 1,
      status: "complete",
      objective: input().objective,
      aggregation: "coverage",
      workers: [{ id: "first", ...pass }, { id: "second", ...issues }],
      gaps: [],
      pinnedInputSnapshot: {
        schemaVersion: 1,
        workspace: { root: cwd, dev: String(stat.dev), ino: String(stat.ino) },
        files: [
          { path: join(cwd, "second.txt"), sha256: createHash("sha256").update("second").digest("hex") },
          { path: join(cwd, "input.bin"), sha256: createHash("sha256").update(bytes).digest("hex") },
        ],
      },
    });
    expect(result.pinnedInputSnapshot?.files[1].sha256).not.toBe(
      createHash("sha256").update(bytes.toString("utf8")).digest("hex"),
    );
    expect(stepExecutions).toEqual([pinnedInputStepKey(), aggregateStepKey()]);
    expect(await inventory(cwd)).toEqual(before);

    for (const [prompt, options] of vi.mocked(ctx.agent).mock.calls) {
      expect(prompt).toContain(join(cwd, "input.bin"));
      expect(prompt).toContain(join(cwd, "second.txt"));
      expect(prompt).toContain("not truth or factual acceptance evidence");
      expect(options).toMatchObject({ agent: "pstack-swarm-worker" });
    }
  });

  it("accepts legacy args without a readable workspace", async () => {
    const { ctx } = journalContext(input());
    await expect(runSwarmWorkflow(ctx, "/not/a/workspace")).resolves.toMatchObject({
      status: "complete", workers: [{ status: "PASS" }, { status: "ISSUES" }],
    });
  });

  it.each([
    null, [], [" "], [""], [12], "input.bin", ["input.bin", "input.bin"],
    Array.from({ length: 129 }, (_, index) => `file-${index}`),
    ["../input.bin"], ["dir/../input.bin"], ["..\\input.bin"],
    ["https://example.invalid/input"], ["file:///input.bin"], ["//server/file"], ["input.bin\0"],
  ])("rejects malformed manifest %j before worker admissions without writes", async (inputFiles) => {
    const cwd = await workspace();
    const before = await inventory(cwd);
    const { ctx } = journalContext(input());
    Object.assign(ctx.args, { inputFiles });

    await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow();
    expect(ctx.agent).not.toHaveBeenCalled();
    expect(ctx.step).not.toHaveBeenCalled();
    expect(await inventory(cwd)).toEqual(before);
  });

  it("rejects arbitrary caller workspace and extra keys before admissions without writes", async () => {
    const cwd = await workspace();
    const before = await inventory(cwd);
    const { ctx } = journalContext(input(["input.bin"]));
    Object.assign(ctx.args, { workspace: "/arbitrary" });
    await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow("args.workspace is not supported");
    expect(ctx.agent).not.toHaveBeenCalled();
    expect(ctx.step).not.toHaveBeenCalled();
    expect(await inventory(cwd)).toEqual(before);
  });

  it.each(["missing", "directory", "absolute-escape", "symlink-escape", "symlink-inside", "symlink-directory"] as const)(
    "rejects %s targets before admissions",
    async (kind) => {
      const cwd = await workspace();
      const outside = await workspace();
      await fixtureFs.mkdir(join(cwd, "dir"));
      await fixtureFs.symlink(join(outside, "input.bin"), join(cwd, "escape"));
      await fixtureFs.symlink(join(cwd, "input.bin"), join(cwd, "alias"));
      await fixtureFs.symlink(cwd, join(cwd, "dir-alias"));

      const paths = {
        missing: "missing",
        directory: "dir",
        "absolute-escape": join(outside, "input.bin"),
        "symlink-escape": "escape",
        "symlink-inside": "alias",
        "symlink-directory": "dir-alias/input.bin",
      };

      const before = await inventory(cwd);
      const { ctx } = journalContext(input([paths[kind]]));

      await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow();
      expect(ctx.agent).not.toHaveBeenCalled();
      expect(ctx.step).not.toHaveBeenCalled();
      expect(await inventory(cwd)).toEqual(before);
    },
  );

  it.each(["./input.bin", "dir/../input.bin", "absolute"])(
    "rejects duplicate canonical target alias %s before admissions",
    async (alias) => {
      const cwd = await workspace();
      const { ctx } = journalContext(input(["input.bin", alias === "absolute" ? join(cwd, "input.bin") : alias]));
      await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow();
      expect(ctx.agent).not.toHaveBeenCalled();
      expect(ctx.step).not.toHaveBeenCalled();
    },
  );

  it("accepts 128 distinct inputs and canonicalizes a host cwd symlink", async () => {
    const parent = await workspace();
    const cwd = join(parent, "actual");
    await fixtureFs.mkdir(cwd);
    await fixtureFs.symlink(cwd, join(parent, "workspace-alias"));
    const files = Array.from({ length: 128 }, (_, index) => `file-${index}`);
    await Promise.all(files.map((file) => fixtureFs.writeFile(join(cwd, file), file)));
    const { ctx } = journalContext(input(files));
    const result = await runSwarmWorkflow(ctx, join(parent, "workspace-alias"));
    expect(result.status).toBe("complete");
    expect(result.pinnedInputSnapshot?.workspace.root).toBe(cwd);
    expect(result.pinnedInputSnapshot?.files.map((file) => file.path)).toEqual(files.map((file) => join(cwd, file)));
  });

  it("replays the same snapshot with no new worker or aggregate admissions", async () => {
    const cwd = await workspace();
    const { ctx, stepExecutions, admissions } = journalContext(input(["input.bin"]));
    const first = await runSwarmWorkflow(ctx, cwd);
    const before = await inventory(cwd);
    expect(await runSwarmWorkflow(ctx, cwd)).toEqual(first);
    expect(admissions).toEqual(["pstack-swarm:v1:first", "pstack-swarm:v1:second"]);
    expect(stepExecutions).toEqual([pinnedInputStepKey(), aggregateStepKey()]);
    expect(await inventory(cwd)).toEqual(before);
  });

  it.each(["bytes", "missing", "workspace-path", "workspace-inode", "path-order"])(
    "rejects resumed %s drift before cached workers or aggregate",
    async (change) => {
      const cwd = await workspace();
      await fixtureFs.writeFile(join(cwd, "second"), "second");
      const { ctx, admissions, stepExecutions } = journalContext(input(["input.bin", "second"]));
      const cwdRef = createCwdRef(cwd);
      await runSwarmWorkflow(ctx, cwdRef);
      vi.mocked(ctx.agent).mockClear();
      vi.mocked(ctx.step).mockClear();

      if (change === "bytes") {
        const changed = Buffer.from([0, 254, 128, 13, 10]);
        expect(changed.toString("utf8")).toBe(Buffer.from([0, 255, 128, 13, 10]).toString("utf8"));
        await fixtureFs.writeFile(join(cwd, "input.bin"), changed);
      }

      if (change === "missing") await fixtureFs.unlink(join(cwd, "input.bin"));

      if (change === "path-order") ctx.args.inputFiles = ["second", "input.bin"];

      if (change === "workspace-path") {
        const next = await workspace();
        await fixtureFs.writeFile(join(next, "second"), "second");
        cwdRef.set(next);
      }

      if (change === "workspace-inode") {
        await fixtureFs.rename(cwd, `${cwd}-previous`);
        directories.push(`${cwd}-previous`);
        await fixtureFs.mkdir(cwd);
        await fixtureFs.writeFile(join(cwd, "input.bin"), Buffer.from([0, 255, 128, 13, 10]));
        await fixtureFs.writeFile(join(cwd, "second"), "second");
      }

      await expect(runSwarmWorkflow(ctx, cwdRef)).rejects.toThrow("pinned input drift");
      expect(ctx.agent).not.toHaveBeenCalled();
      expect(vi.mocked(ctx.step).mock.calls.map(([key]) => key)).not.toContain(aggregateStepKey());
      expect(admissions).toHaveLength(2);
      expect(stepExecutions).toEqual([pinnedInputStepKey(), aggregateStepKey()]);
    },
  );

  it("rejects mutation during workers before aggregate journaling", async () => {
    const cwd = await workspace();
    const { ctx, stepExecutions } = journalContext(input(["input.bin"]));
    vi.mocked(ctx.agent).mockImplementation(async () => {
      await fixtureFs.writeFile(join(cwd, "input.bin"), "changed during worker");

      return pass;
    });
    await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow("pinned input drift");
    expect(stepExecutions).toEqual([pinnedInputStepKey()]);
  });

  it("rejects mutation during baseline journaling before worker admission", async () => {
    const cwd = await workspace();
    const { ctx, executeStep } = journalContext(input(["input.bin"]));
    vi.mocked(ctx.step).mockImplementation(async (key, producer) => {
      const result = await executeStep(key, producer);

      if (key === pinnedInputStepKey()) await fixtureFs.writeFile(join(cwd, "input.bin"), "changed while journaling");

      return result;
    });

    await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow("pinned input drift");
    expect(ctx.agent).not.toHaveBeenCalled();
  });

  it("checks freshness after returning a cached aggregate", async () => {
    const cwd = await workspace();
    const { ctx, executeStep } = journalContext(input(["input.bin"]));
    await runSwarmWorkflow(ctx, cwd);
    vi.mocked(ctx.step).mockImplementation(async (key, producer) => {
      const result = await executeStep(key, producer);

      if (key === aggregateStepKey()) await fixtureFs.writeFile(join(cwd, "input.bin"), "changed after cache lookup");

      return result;
    });

    await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow("pinned input drift");
  });

  it.each<JsonValue>([null, {}, { schemaVersion: 1, workspace: {}, files: [] }])(
    "rejects malformed journaled snapshot %j before workers",
    async (snapshot) => {
      const cwd = await workspace();
      const { ctx, steps } = journalContext(input(["input.bin"]));
      steps.set(pinnedInputStepKey(), snapshot);
      await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow("invalid journaled pinned input snapshot");
      expect(ctx.agent).not.toHaveBeenCalled();
    },
  );

  it.each(["extra", "workspace-extra", "file-extra", "invalid-digest"] as const)(
    "rejects snapshot %s instead of cleaning it into valid input",
    async (kind) => {
      const cwd = await workspace();
      const { ctx, steps } = journalContext(input(["input.bin"]));
      const first = await runSwarmWorkflow(ctx, cwd);
      const snapshot = first.pinnedInputSnapshot;

      if (!snapshot) throw new Error("missing pinned snapshot");

      const malformed = {
        extra: { ...snapshot, extra: true },
        "workspace-extra": { ...snapshot, workspace: { ...snapshot.workspace, extra: true } },
        "file-extra": { ...snapshot, files: [{ ...snapshot.files[0], extra: true }] },
        "invalid-digest": { ...snapshot, files: [{ ...snapshot.files[0], sha256: "not-a-digest" }] },
      } satisfies Record<string, JsonValue>;

      steps.set(pinnedInputStepKey(), malformed[kind]);
      vi.mocked(ctx.agent).mockClear();
      await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow("invalid journaled pinned input snapshot");
      expect(ctx.agent).not.toHaveBeenCalled();
    },
  );

  it.each(["null", "extra", "wrong-status", "nested-extra", "wrong-snapshot"] as const)(
    "rejects malformed or inconsistent aggregate %s visibly",
    async (kind) => {
      const cwd = await workspace();
      const { ctx, steps } = journalContext(input(["input.bin"]));
      const first = await runSwarmWorkflow(ctx, cwd);

      const malformed = {
        null: null,
        extra: { ...first, extra: true },
        "wrong-status": { ...first, status: "blocked" },
        "nested-extra": { ...first, workers: [{ ...first.workers[0], extra: true }, first.workers[1]] },
        "wrong-snapshot": { ...first, pinnedInputSnapshot: null },
      } satisfies Record<string, JsonValue>;

      steps.set(aggregateStepKey(), malformed[kind]);
      await expect(runSwarmWorkflow(ctx, cwd)).rejects.toThrow("invalid journaled swarm aggregate result");
    },
  );

  it.each(["before", "after-read", "after-snapshot", "before-admission", "after-workers", "before-aggregate", "after-aggregate", "before-return"])(
    "never swallows cancellation %s",
    async (boundary) => {
      const cwd = await workspace();
      const before = await inventory(cwd);
      const controller = new AbortController();
      const reason = new Error(`cancelled ${boundary}`);
      const abort = () => controller.abort(reason);
      const { ctx, stepExecutions, executeStep } = journalContext(input(["input.bin"]), controller.signal);

      if (boundary === "before") abort();

      if (boundary === "after-read") {
        vi.mocked(ctx.step).mockImplementation(async (_key, producer) => {
          abort();

          return producer();
        });
      }

      if (boundary === "after-snapshot" || boundary === "after-aggregate") {
        vi.mocked(ctx.step).mockImplementation(async (key, producer) => {
          const result = await executeStep(key, producer);

          if (key === (boundary === "after-snapshot" ? pinnedInputStepKey() : aggregateStepKey())) abort();

          return result;
        });
      }

      if (boundary === "before-admission" || boundary === "before-aggregate") {
        vi.mocked(ctx.phase).mockImplementation((phase) => {
          if (phase === (boundary === "before-admission" ? "Fan out" : "Aggregate")) abort();
        });
      }

      if (boundary === "after-workers") {
        vi.mocked(ctx.agent).mockImplementation(async () => {
          abort();

          return pass;
        });
      }

      if (boundary === "before-return") vi.mocked(ctx.log).mockImplementation(abort);

      await expect(runSwarmWorkflow(ctx, cwd)).rejects.toBe(reason);

      if (boundary === "before") expect(ctx.step).not.toHaveBeenCalled();

      if (boundary === "before" || boundary === "after-read") {
        expect(stepExecutions).toEqual([]);
      }

      if (["before", "after-read", "after-snapshot", "before-admission"].includes(boundary)) {
        expect(ctx.agent).not.toHaveBeenCalled();
      }

      if (!["after-aggregate", "before-return"].includes(boundary)) {
        expect(stepExecutions).not.toContain(aggregateStepKey());
      }

      expect(await inventory(cwd)).toEqual(before);
    },
  );
});
