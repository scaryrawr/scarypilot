import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: undefined as
    | {
        factories?: Array<{ meta: { name: string } }>;
        customAgents?: Array<{ name: string; tools?: string[] | null }>;
        tools?: Array<{ name: string }>;
      }
    | undefined,
}));

vi.mock("@github/copilot-sdk/extension", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@github/copilot-sdk/extension")>();
  return {
    ...actual,
    joinSession: vi.fn(async (options: typeof mocks.options) => {
      mocks.options = options;
      return { log: vi.fn() };
    }),
  };
});

describe("pstack extension", () => {
  it("registers the native tools and read-only swarm factory", async () => {
    await import("../src/extension.ts");

    expect(mocks.options?.tools?.map((tool) => tool.name)).toEqual([
      "pstack_status",
      "pstack_capabilities",
      "pstack_validate_plan",
      "pstack_record_verification",
      "pstack_inspect_worktrees",
      "pstack_handoff",
    ]);
    expect(mocks.options?.factories?.map((factory) => factory.meta.name)).toEqual([
      "pstack-swarm",
    ]);
    expect(mocks.options?.customAgents).toEqual([
      expect.objectContaining({
        name: "pstack-swarm-worker",
        tools: ["read", "search"],
      }),
    ]);
  });
});
