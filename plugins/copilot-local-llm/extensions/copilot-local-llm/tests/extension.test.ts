import { describe, expect, it, vi } from "vitest";
import { registerLocalLlmExtension } from "../src/register.ts";

describe("extension", () => {
  it("registers discovered providers and models without changing session behavior", async () => {
    const session = {
      log: vi.fn(async () => undefined),
    };

    const configuration = {
      providers: [{ name: "ollama", baseUrl: "http://localhost:11434/v1" }],
      models: [{ provider: "ollama", id: "local-model" }],
    };

    const discover = vi.fn(async () => configuration);
    const join = vi.fn(async () => session);

    await registerLocalLlmExtension({ discover, join });

    expect(join).toHaveBeenCalledWith({
      providers: configuration.providers,
      models: configuration.models,
    });
    expect(join).toHaveBeenCalledTimes(1);
    expect(session.log).toHaveBeenCalledWith("Registered 1 local model(s).", {
      level: "info",
      ephemeral: true,
    });
  });

  it("joins with empty registration when no local provider is available", async () => {
    const configuration = { providers: [], models: [] };
    const session = { log: vi.fn(async () => undefined) };
    const discover = vi.fn(async () => configuration);
    const join = vi.fn(async () => session);

    await registerLocalLlmExtension({ discover, join });

    expect(join).toHaveBeenCalledWith({
      providers: [],
      models: [],
    });
    expect(join).toHaveBeenCalledTimes(1);
    expect(session.log).toHaveBeenCalledWith("Registered 0 local model(s).", {
      level: "info",
      ephemeral: true,
    });
  });
});
