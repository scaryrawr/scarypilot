import { describe, expect, it, vi } from "vitest";
import type { ModelChangeEvent } from "@github/copilot-sdk";
import { LOCAL_MODEL_TOOLS } from "../src/model-tools.ts";
import { COMPACT_SYSTEM_MESSAGE } from "../src/system-message.ts";

const mocks = vi.hoisted(() => {
  const modelChangeHandlers: Array<(event: ModelChangeEvent) => void> = [];
  const session = {
    log: vi.fn(async () => undefined),
    on: vi.fn((_eventType, handler) => {
      modelChangeHandlers.push(handler);
      return () => undefined;
    }),
    rpc: {
      model: {
        getCurrent: vi.fn(async () => ({ modelId: "ollama/local-model" })),
      },
      options: {
        update: vi.fn(async () => ({ success: true })),
      },
      tools: {
        initializeAndValidate: vi.fn(async () => ({})),
        getCurrentMetadata: vi.fn(async () => ({
          tools: [{ name: "bash" }, { name: "view" }, { name: "cloud-tool" }],
        })),
      },
    },
  };

  return {
    configuration: {
      providers: [{ name: "ollama", baseUrl: "http://localhost:11434/v1" }],
      models: [{ provider: "ollama", id: "local-model" }],
    },
    discoverLocalProviders: vi.fn(),
    joinSession: vi.fn(async () => session),
    modelChangeHandlers,
    session,
  };
});

mocks.discoverLocalProviders.mockResolvedValue(mocks.configuration);

vi.mock("@github/copilot-sdk/extension", () => ({
  joinSession: mocks.joinSession,
}));

vi.mock("../src/local-providers.ts", () => ({
  discoverLocalProviders: mocks.discoverLocalProviders,
}));

describe("extension", () => {
  it("joins with discovered providers and the compact system message", async () => {
    await import("../src/extension.ts");

    expect(mocks.joinSession).toHaveBeenCalledWith({
      ...mocks.configuration,
      systemMessage: COMPACT_SYSTEM_MESSAGE,
    });
    expect(mocks.session.rpc.options.update).toHaveBeenCalledWith({
      availableTools: [...LOCAL_MODEL_TOOLS],
    });
    expect(mocks.session.log).toHaveBeenCalledWith("Registered 1 local model(s).", {
      level: "info",
      ephemeral: true,
    });

    mocks.modelChangeHandlers[0]({
      id: "model-change",
      parentId: null,
      timestamp: "2026-08-31T18:43:00.000Z",
      type: "session.model_change",
      data: {
        newModel: "gpt-5.6-sol",
      },
    });

    await vi.waitFor(() => {
      expect(mocks.session.rpc.options.update).toHaveBeenLastCalledWith({
        availableTools: ["bash", "view", "cloud-tool"],
      });
    });
  });
});
