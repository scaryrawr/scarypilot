import type { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  createPstackExtensionRegistration,
  registerPstackExtension,
} from "../src/register.ts";

type SessionOptions = NonNullable<Parameters<typeof joinSession>[0]>;

const execFileAsync = promisify(execFile);

describe("pstack extension", () => {
  it("registers the native tools and read-only swarm workflow", () => {
    const { options } = createPstackExtensionRegistration();

    expect(options.tools?.map((tool) => tool.name)).toEqual([
      "pstack_status",
      "pstack_capabilities",
      "pstack_validate_plan",
      "pstack_validate_artifact",
      "pstack_record_verification",
      "pstack_inspect_worktrees",
      "pstack_handoff",
    ]);
    expect(options.workflows?.map((workflow) => workflow.meta.name)).toEqual([
      "pstack-swarm",
    ]);
    expect(options).not.toHaveProperty("factories");
    expect(options.workflows?.[0]).not.toHaveProperty("run");
    expect(options.customAgents).toEqual([
      expect.objectContaining({
        name: "pstack-swarm-worker",
        tools: ["read", "search"],
        infer: false,
      }),
    ]);
  });

  it("loads the shipped entrypoint through the extension host boundary", async () => {
    const { SESSION_ID: _sessionId, ...env } = process.env;
    const entrypoint = fileURLToPath(new URL("../extension.mjs", import.meta.url));

    await expect(
      execFileAsync(process.execPath, [entrypoint], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "joinSession() is intended for extensions running as child processes",
      ),
    });
  });

  it("registers the restricted worker and workflow together at the session boundary", async () => {
    let options: SessionOptions | undefined;

    const registration = await registerPstackExtension(async (registeredOptions) => {
      options = registeredOptions;

      return { log: vi.fn() };
    });

    const workerAgent = options?.customAgents?.find(
      (agent) => agent.name === "pstack-swarm-worker",
    );

    expect(options).toBe(registration.options);
    expect(options?.workflows?.map((workflow) => workflow.meta.name)).toContain(
      "pstack-swarm",
    );
    expect(workerAgent).toMatchObject({ tools: ["read", "search"], infer: false });
    expect(options?.hooks).toMatchObject({
      onUserPromptSubmitted: expect.any(Function),
      onPreToolUse: expect.any(Function),
    });
  });
});
