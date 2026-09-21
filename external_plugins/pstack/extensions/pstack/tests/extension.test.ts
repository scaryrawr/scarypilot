import type {
  FactoryContext,
  JsonValue,
  joinSession,
} from "@github/copilot-sdk/extension";
import { describe, expect, it, vi } from "vitest";
import { runSwarmFactory, type SwarmArgs } from "../src/factories/swarm.ts";
import {
  createPstackExtensionRegistration,
  registerPstackExtension,
} from "../src/register.ts";

type SessionOptions = NonNullable<Parameters<typeof joinSession>[0]>;

describe("pstack extension", () => {
  it("registers the native tools and read-only swarm factory", () => {
    const { options } = createPstackExtensionRegistration();

    expect(options.tools?.map((tool) => tool.name)).toEqual([
      "pstack_status",
      "pstack_capabilities",
      "pstack_validate_plan",
      "pstack_record_verification",
      "pstack_inspect_worktrees",
      "pstack_handoff",
    ]);
    expect(options.factories?.map((factory) => factory.meta.name)).toEqual([
      "pstack-swarm",
    ]);
    expect(options.customAgents).toEqual([
      expect.objectContaining({
        name: "pstack-swarm-worker",
        tools: ["read", "search"],
      }),
    ]);
  });

  it("imports the entrypoint and dispatches the registered worker agent", async () => {
    let options: SessionOptions | undefined;

    await registerPstackExtension(async (registeredOptions) => {
      options = registeredOptions;

      return { log: vi.fn() };
    });

    const workerAgent = options?.customAgents?.find(
      (agent) => agent.name === "pstack-swarm-worker",
    );

    const agent = vi.fn(async (
      _prompt: string,
      _options?: { agent?: string },
    ) => ({
      status: "PASS",
      summary: "Registered worker completed.",
      evidence: ["registration-smoke"],
    }));

    const args: SwarmArgs = {
      schemaVersion: 1,
      objective: "Verify host registration.",
      donePredicate: "Every worker returns a report.",
      aggregation: "coverage",
      workers: [
        { id: "first", brief: "Run the first registered worker." },
        { id: "second", brief: "Run the second registered worker." },
      ],
    };

    const context: Pick<
      FactoryContext<SwarmArgs>,
      "agent" | "args" | "log" | "parallel" | "phase" | "signal" | "step"
    > = {
      agent,
      args,
      log: vi.fn(),
      parallel: async <Result>(
        thunks: Array<() => Result | Promise<Result>>,
      ): Promise<Array<Result | null>> => Promise.all(thunks.map((thunk) => thunk())),
      phase: vi.fn(),
      signal: new AbortController().signal,
      step: vi.fn(async (_key: string, producer: () => JsonValue | Promise<JsonValue>) =>
        producer()
      ),
    };

    expect(options?.factories?.map((factory) => factory.meta.name)).toContain(
      "pstack-swarm",
    );
    expect(workerAgent).toMatchObject({ tools: ["read", "search"] });

    await expect(runSwarmFactory(context)).resolves.toMatchObject({
      status: "complete",
      gaps: [],
    });

    expect(agent).toHaveBeenCalledTimes(2);

    for (const [, options] of agent.mock.calls) {
      expect(options).toMatchObject({ agent: workerAgent?.name });
    }
  });
});
