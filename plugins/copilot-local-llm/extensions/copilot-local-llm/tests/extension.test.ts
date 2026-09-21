import { describe, expect, it, vi } from "vitest";
import type { ModelChangeEvent } from "@github/copilot-sdk";
import { LOCAL_MODEL_EXCLUDED_TOOLS } from "../src/model-tools.ts";
import { registerLocalLlmExtension } from "../src/register.ts";
import { COMPACT_SYSTEM_MESSAGE } from "../src/system-message.ts";

describe("extension", () => {
  it("joins with discovered providers and the compact system message", async () => {
    const modelChangeHandlers: Array<(event: ModelChangeEvent) => void> = [];

    const session = {
      log: vi.fn(async () => undefined),
      on: vi.fn(
        (_eventType: "session.model_change", handler: (event: ModelChangeEvent) => void) => {
          modelChangeHandlers.push(handler);

          return () => undefined;
        },
      ),
      rpc: {
        model: {
          getCurrent: vi.fn(async () => ({ modelId: "ollama/local-model" })),
        },
        options: {
          update: vi.fn(async () => ({ success: true })),
        },
      },
    };

    const configuration = {
      providers: [{ name: "ollama", baseUrl: "http://localhost:11434/v1" }],
      models: [{ provider: "ollama", id: "local-model" }],
    };

    const discover = vi.fn(async () => configuration);
    const join = vi.fn(async () => session);

    await registerLocalLlmExtension({ discover, join });

    expect(join).toHaveBeenCalledWith({
      ...configuration,
      systemMessage: COMPACT_SYSTEM_MESSAGE,
    });
    expect(session.rpc.options.update).toHaveBeenCalledWith({
      excludedTools: [...LOCAL_MODEL_EXCLUDED_TOOLS],
      toolFilterPrecedence: "excluded",
    });
    expect(session.log).toHaveBeenCalledWith("Registered 1 local model(s).", {
      level: "info",
      ephemeral: true,
    });

    modelChangeHandlers[0]({
      id: "model-change",
      parentId: null,
      timestamp: "2026-08-31T18:43:00.000Z",
      type: "session.model_change",
      data: {
        newModel: "gpt-5.6-sol",
      },
    });

    await vi.waitFor(() => {
      expect(session.rpc.options.update).toHaveBeenLastCalledWith({
        excludedTools: [],
        toolFilterPrecedence: "excluded",
      });
    });
  });
});
