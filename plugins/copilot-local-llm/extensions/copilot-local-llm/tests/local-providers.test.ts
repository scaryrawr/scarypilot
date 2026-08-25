import { describe, expect, it, vi } from "vitest";
import { discoverLocalProviders } from "../src/local-providers.ts";
import { discoverGeniex } from "../src/providers/geniex.ts";

describe("discoverLocalProviders", () => {
  it("registers models returned by each supported local server", async () => {
    const fetchImplementation = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "http://localhost:11434/api/tags") {
        return jsonResponse({ models: [{ name: "qwen3:8b", model: "Qwen 3 8B" }] });
      }
      if (url === "http://localhost:1234/api/v1/models") {
        return jsonResponse({
          models: [
            {
              key: "local-model",
              display_name: "Local Model",
              max_context_length: 16_384,
            },
          ],
        });
      }
      if (url === "http://localhost:8000/v1/models/status") {
        return jsonResponse({
          models: [
            {
              id: "mlx-vlm",
              display_name: "MLX Vision Model",
              model_type: "vlm",
              max_context_window: 65_536,
              max_tokens: 16_384,
            },
            {
              id: "mlx-helper",
              model_type: "llm",
              engine_type: "batched",
            },
            {
              id: "mlx-embed",
              model_type: "embedding",
            },
          ],
        });
      }
      if (url === "http://localhost:1337/api/tags") {
        return jsonResponse({ models: [{ name: "osaurus-model" }] });
      }
      if (url === "http://127.0.0.1:18181/v1/models") {
        return jsonResponse({
          object: "list",
          data: [{ id: "ai-hub-models/Qwen3-4B-Instruct-2507", object: "model" }],
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const configuration = await discoverLocalProviders(
      {
        OLLAMA_API_KEY: "ollama-token",
        LMSTUDIO_API_KEY: "lmstudio-token",
        OMLX_API_KEY: "omlx-token",
        OSARAUS_API_KEY: "osaurus-token",
        OSARAUS_CONTEXT_LENGTH: "8192",
        GENIEX_API_KEY: "geniex-token",
        GENIEX_CONTEXT_LENGTH: "32768",
      },
      fetchImplementation,
    );

    expect(configuration.providers).toEqual([
      {
        name: "ollama",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "ollama-token",
        wireApi: "completions",
      },
      {
        name: "lmstudio",
        baseUrl: "http://localhost:1234/v1",
        apiKey: "lmstudio-token",
        wireApi: "completions",
      },
      {
        name: "omlx",
        baseUrl: "http://localhost:8000/v1",
        apiKey: "omlx-token",
        wireApi: "completions",
      },
      {
        name: "osaurus",
        baseUrl: "http://localhost:1337/v1",
        apiKey: "osaurus-token",
        wireApi: "completions",
      },
      {
        name: "geniex",
        baseUrl: "http://127.0.0.1:18181/v1",
        apiKey: "geniex-token",
        wireApi: "completions",
      },
    ]);
    expect(configuration.models).toMatchObject([
      { id: "qwen3:8b", provider: "ollama", name: "Qwen 3 8B" },
      {
        id: "local-model",
        provider: "lmstudio",
        name: "Local Model",
        maxContextWindowTokens: 16_384,
        maxOutputTokens: 4_096,
      },
      {
        id: "mlx-vlm",
        provider: "omlx",
        name: "MLX Vision Model",
        maxContextWindowTokens: 65_536,
        maxOutputTokens: 16_384,
        capabilities: { supports: { vision: true } },
      },
      {
        id: "mlx-helper",
        provider: "omlx",
        name: "mlx-helper",
      },
      {
        id: "osaurus-model",
        provider: "osaurus",
        maxContextWindowTokens: 8_192,
        maxOutputTokens: 2_048,
      },
      {
        id: "ai-hub-models/Qwen3-4B-Instruct-2507",
        provider: "geniex",
        name: "ai-hub-models/Qwen3-4B-Instruct-2507",
        maxContextWindowTokens: 32_768,
        maxOutputTokens: 8_192,
      },
    ]);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ headers: { Authorization: "Bearer ollama-token" } }),
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://localhost:1234/api/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer lmstudio-token" } }),
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://localhost:8000/v1/models/status",
      expect.objectContaining({ headers: { Authorization: "Bearer omlx-token" } }),
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://localhost:1337/api/tags",
      expect.objectContaining({ headers: { Authorization: "Bearer osaurus-token" } }),
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://127.0.0.1:18181/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer geniex-token" } }),
    );
  });

  it("skips unavailable local servers without preventing the extension from joining", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImplementation = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error("Connection refused");
    });

    await expect(discoverLocalProviders({}, fetchImplementation)).resolves.toEqual({
      providers: [],
      models: [],
    });
    expect(warning).toHaveBeenCalledTimes(5);
  });

  it("normalizes GenieX overrides and ignores malformed model entries", async () => {
    const fetchImplementation = vi.fn(async (url: string, _init?: RequestInit) => {
      expect(url).toBe("http://geniex.local:18182/v1/models");
      return jsonResponse({
        data: [{ id: "valid-model" }, { id: 123 }, null],
      });
    });

    await expect(
      discoverGeniex(
        {
          GENIEX_BASE_URL: "http://geniex.local:18182/",
        },
        fetchImplementation,
      ),
    ).resolves.toMatchObject({
      provider: {
        name: "geniex",
        baseUrl: "http://geniex.local:18182/v1",
        apiKey: "geniex",
      },
      models: [
        {
          id: "valid-model",
          provider: "geniex",
          maxContextWindowTokens: 65_536,
          maxOutputTokens: 16_384,
        },
      ],
    });
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
