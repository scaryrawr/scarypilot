import { describe, expect, it, vi } from "vitest";
import type { FactoryContext, JsonValue } from "@github/copilot-sdk/extension";
import {
  aggregateStepKey,
  parseSwarmArgs,
  pstackSwarmFactory,
  runSwarmFactory,
  type SwarmArgs,
  workerLabel,
} from "../src/factories/swarm.ts";
import { pstackFactories, pstackFactoryAgents } from "../src/factories/index.ts";

function args(overrides: Partial<SwarmArgs> = {}): SwarmArgs {
  return {
    schemaVersion: 1,
    objective: "Inspect the changed authentication code.",
    donePredicate: "Every assigned slice reports evidence.",
    aggregation: "coverage",
    workers: [
      { id: "api", brief: "Inspect API callers." },
      { id: "tests", brief: "Inspect behavioral tests." },
    ],
    ...overrides,
  };
}

function context(
  input: SwarmArgs,
  outputs: unknown[],
  signal: AbortSignal = new AbortController().signal,
) {
  const labels: string[] = [];
  const phases: string[] = [];
  const logs: string[] = [];
  let outputIndex = 0;

  const parallel = async <Result>(
    thunks: Array<() => Result | Promise<Result>>,
  ): Promise<Array<Result | null>> => Promise.all(thunks.map((thunk) => thunk()));

  const ctx: Pick<
    FactoryContext<SwarmArgs>,
    "agent" | "args" | "log" | "parallel" | "phase" | "signal" | "step"
  > = {
    args: input,
    signal,
    agent: vi.fn(async (_prompt: string, options?: { label?: string }) => {
      if (options?.label) labels.push(options.label);

      return outputs[outputIndex++] ?? null;
    }),
    parallel,
    phase: vi.fn((phase: string) => phases.push(phase)),
    log: vi.fn((message: string) => logs.push(message)),
    step: vi.fn(async (_key: string, producer: () => JsonValue | Promise<JsonValue>) => producer()),
  };

  return { ctx, labels, phases, logs };
}

describe("pstack-swarm factory", () => {
  it("registers stable metadata and argument schema", () => {
    expect(pstackFactories).toEqual([pstackSwarmFactory]);
    expect(pstackFactoryAgents).toEqual([
      expect.objectContaining({
        name: "pstack-swarm-worker",
        tools: ["read", "search"],
        infer: false,
      }),
    ]);
    expect(pstackSwarmFactory.meta.name).toBe("pstack-swarm");
    expect(pstackSwarmFactory.meta.phases.map((phase) => phase.title)).toEqual([
      "Fan out",
      "Aggregate",
    ]);
    expect(pstackSwarmFactory.meta.argsSchema).toBeDefined();
  });

  it("validates worker bounds and unique kebab-case ids", () => {
    expect(() => parseSwarmArgs(args({ workers: [{ id: "one", brief: "Only one." }] }))).toThrow(
      "between 2 and 8",
    );
    expect(() =>
      parseSwarmArgs(
        args({
          workers: [
            { id: "same", brief: "First." },
            { id: "same", brief: "Second." },
          ],
        }),
      ),
    ).toThrow("duplicate worker id");
    expect(() =>
      parseSwarmArgs(
        args({
          workers: [
            { id: "Not Kebab", brief: "First." },
            { id: "valid", brief: "Second." },
          ],
        }),
      ),
    ).toThrow("must be kebab-case");
    expect(() => parseSwarmArgs({ ...args(), aggregation: "best-of" })).toThrow(
      "aggregation must be coverage",
    );
    expect(() => parseSwarmArgs({ ...args(), unexpected: true })).toThrow(
      "args.unexpected is not supported",
    );
  });

  it("normalizes host-selected model aliases", () => {
    expect(
      parseSwarmArgs({
        ...args(),
        workers: [
          { id: "api", brief: "Inspect API callers.", model: "auto" },
          {
            id: "tests",
            brief: "Inspect behavioral tests.",
            model: "inherit-parent",
          },
          { id: "docs", brief: "Inspect documentation.", model: "gpt-5.4" },
        ],
      }).workers,
    ).toEqual([
      { id: "api", brief: "Inspect API callers." },
      { id: "tests", brief: "Inspect behavioral tests." },
      { id: "docs", brief: "Inspect documentation.", model: "gpt-5.4" },
    ]);
  });

  it("uses deterministic labels and versioned aggregate keys", () => {
    expect(workerLabel("api")).toBe("pstack-swarm:v1:api");
    expect(aggregateStepKey()).toBe("pstack-swarm/v1/aggregate");
  });

  it("returns a complete result when every worker reports", async () => {
    const { ctx, labels, phases } = context(args(), [
      { status: "PASS", summary: "API is covered.", evidence: ["api.test.ts"] },
      { status: "ISSUES", summary: "Missing rejection case.", evidence: ["auth.test.ts:42"] },
    ]);

    const result = await runSwarmFactory(ctx);

    expect(result.status).toBe("complete");
    expect(result.gaps).toEqual([]);
    expect(labels).toEqual(["pstack-swarm:v1:api", "pstack-swarm:v1:tests"]);
    expect(phases).toEqual(["Fan out", "Aggregate"]);

    for (const [, options] of vi.mocked(ctx.agent).mock.calls) {
      expect(options).toMatchObject({ agent: "pstack-swarm-worker" });
    }
  });

  it("normalizes a child failure to a partial blocked result", async () => {
    const { ctx } = context(args(), [
      { status: "PASS", summary: "API is covered.", evidence: ["api.test.ts"] },
      null,
    ]);

    const result = await runSwarmFactory(ctx);

    expect(result.status).toBe("partial");
    expect(result.gaps).toEqual(["tests"]);
    expect(result.workers[1]).toMatchObject({ id: "tests", status: "BLOCKED" });
  });

  it("returns blocked when all workers fail", async () => {
    const { ctx } = context(args(), [null, null]);
    await expect(runSwarmFactory(ctx)).resolves.toMatchObject({
      status: "blocked",
      gaps: ["api", "tests"],
    });
  });

  it("forbids nested factories and writes in every worker prompt", async () => {
    const { ctx } = context(args(), [
      { status: "PASS", summary: "Done.", evidence: [] },
      { status: "PASS", summary: "Done.", evidence: [] },
    ]);

    await runSwarmFactory(ctx);

    for (const [prompt] of vi.mocked(ctx.agent).mock.calls) {
      expect(prompt).toContain("Do not edit files");
      expect(prompt).toContain("Do not edit files or invoke run_factory/factories_manage");
    }
  });

  it("honors cancellation before launching workers", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = context(args(), [], controller.signal);

    await expect(runSwarmFactory(ctx)).rejects.toThrow();
    expect(ctx.agent).not.toHaveBeenCalled();
  });
});
