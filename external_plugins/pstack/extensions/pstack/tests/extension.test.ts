import { describe, expect, it } from "vitest";
import { createPstackExtensionRegistration } from "../src/register.ts";

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
});
