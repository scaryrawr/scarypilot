import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isOllamaDuration } from "./duration.ts";
import {
  DecisionInputSchema,
  DecisionResponseSchema,
  EmptySchema,
  ShowSchema,
  TagsSchema,
  type DecisionInput,
  type DecisionRequest,
  type DecisionResponse,
  type InstalledModel,
} from "./schemas.ts";

export class DecisionError extends Error {}

const maxDecisionRequestBytes = 64 * 1024;

const maxImageRequestBytes = 32 * 1024 * 1024;

const maxResponseBytes = 4 * 1024 * 1024;

async function encodeImages(images: NonNullable<DecisionInput["images"]>, signal: AbortSignal): Promise<string[]> {
  const encoded: string[] = [];
  let total = 0;

  for (const image of images) {
    if (signal.aborted) throw new DecisionError("Image reading was cancelled. No inference was attempted.");
    let base64: string;

    if (typeof image === "string") {
      base64 = image;
    } else {
      if (!isAbsolute(image.path)) {
        throw new DecisionError("Image file paths must be absolute.");
      }

      try {
        const file = await open(image.path, constants.O_RDONLY | constants.O_NONBLOCK);

        try {
          const stat = await file.stat();

          if (!stat.isFile() || stat.size === 0) {
            throw new DecisionError("Image paths must refer to nonempty regular files.");
          }

          const remainingBytes = Math.floor((maxImageRequestBytes - total) / 4) * 3;

          if (stat.size > remainingBytes) {
            throw new DecisionError("Decision request exceeds Ollama's 32 MiB image JSON limit. Reduce the images, state, or questions.");
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          const stream = file.createReadStream({ autoClose: false, end: remainingBytes, signal });

          for await (const chunk of stream) {
            bytes += chunk.length;

            if (bytes > remainingBytes) {
              throw new DecisionError("Decision request exceeds Ollama's 32 MiB image JSON limit. Reduce the images, state, or questions.");
            }

            chunks.push(chunk);
          }

          if (bytes === 0) throw new DecisionError("Image paths must refer to nonempty regular files.");
          base64 = Buffer.concat(chunks, bytes).toString("base64");
        } finally {
          await file.close();
        }
      } catch (error) {
        if (signal.aborted) throw new DecisionError("Image reading was cancelled. No inference was attempted.");

        if (error instanceof DecisionError) throw error;

        throw new DecisionError("Image file could not be read. Check that the supplied path is an accessible regular file.");
      }
    }

    total += base64.length;

    if (total > maxImageRequestBytes) {
      throw new DecisionError("Decision request exceeds Ollama's 32 MiB image JSON limit. Reduce the images, state, or questions.");
    }

    encoded.push(base64);
  }

  return encoded;
}

type Configuration = { baseUrl: URL; apiKey?: string };

type ClientOptions = {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  metadataTimeoutMs?: number;
  inferenceTimeoutMs?: number;
};

export class DecisionClient {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetch: typeof fetch;
  private readonly metadataTimeoutMs: number;
  private readonly inferenceTimeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
    this.inferenceTimeoutMs = options.inferenceTimeoutMs ?? 120_000;
  }

  private configuration(): Configuration {
    let baseUrl: URL;

    try {
      baseUrl = new URL(this.environment.OLLAMA_BASE_URL ?? "http://localhost:11434");
    } catch {
      throw new DecisionError("OLLAMA_BASE_URL must be an absolute HTTP or HTTPS URL.");
    }

    if (!["http:", "https:"].includes(baseUrl.protocol) ||
        baseUrl.username || baseUrl.password || baseUrl.href.includes("?") || baseUrl.href.includes("#")) {
      throw new DecisionError("OLLAMA_BASE_URL must use HTTP or HTTPS without credentials, query, or fragment.");
    }

    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;
    const apiKey = this.environment.OLLAMA_API_KEY;

    if (apiKey && /[\r\n]/.test(apiKey)) {
      throw new DecisionError("OLLAMA_API_KEY must not contain line breaks.");
    }

    if (apiKey && baseUrl.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)) {
      throw new DecisionError("Authenticated remote Ollama endpoints require HTTPS. HTTP authentication is allowed only for localhost, 127.0.0.1, or [::1].");
    }

    return { baseUrl, apiKey };
  }

  private async request<T extends TSchema>(
    config: Configuration,
    endpoint: string,
    signal: AbortSignal,
    schema: T,
    body?: DecisionRequest | { model: string },
  ): Promise<Static<T>> {
    try {
      const headers = new Headers({ Accept: "application/json" });

      const init: RequestInit = {
        method: body === undefined ? "GET" : "POST",
        headers,
        redirect: "error",
        signal,
      };

      if (body !== undefined) {
        const serialized = JSON.stringify(body);

        if (endpoint === "v1/systemone") {
          const hasImages = "images" in body && Boolean(body.images?.length);
          const limit = hasImages ? maxImageRequestBytes : maxDecisionRequestBytes;

          if (Buffer.byteLength(serialized, "utf8") > limit) {
            throw new DecisionError(hasImages
              ? "Decision request exceeds Ollama's 32 MiB image JSON limit. Reduce the images, state, or questions."
              : "Decision request exceeds Ollama's 64 KiB text-only JSON limit. Reduce the state or questions.");
          }
        }

        headers.set("Content-Type", "application/json");
        init.body = serialized;
      }

      if (config.apiKey) headers.set("Authorization", `Bearer ${config.apiKey}`);

      const response = await this.fetch(new URL(endpoint, config.baseUrl), init);

      if (!response.ok) {
        await response.body?.cancel();
        throw new DecisionError(`${endpoint} returned HTTP ${response.status}. Check Ollama version, authentication, and model support.`);
      }

      if (Number(response.headers.get("Content-Length")) > maxResponseBytes) {
        await response.body?.cancel();
        throw new DecisionError(`${endpoint} response exceeds the 4 MiB limit.`);
      }

      let payload: unknown;

      try {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const reader = response.body?.getReader();

        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();

              if (done) break;
              bytes += value.byteLength;

              if (bytes > maxResponseBytes) {
                await reader.cancel();
                throw new DecisionError(`${endpoint} response exceeds the 4 MiB limit.`);
              }

              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
        }

        signal.throwIfAborted();
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
      } catch (error) {
        signal.throwIfAborted();

        if (error instanceof DecisionError) throw error;

        throw new DecisionError(`${endpoint} returned malformed JSON.`);
      }

      if (!Value.Check(schema, payload)) {
        throw new DecisionError(`${endpoint} returned invalid metadata or response data. Capability discovery or inference is unresolved.`);
      }

      return payload;
    } catch (error) {
      if (signal.aborted) {
        throw new DecisionError(signal.reason?.name === "TimeoutError"
          ? `${endpoint} timed out. No retry was attempted.`
          : `${endpoint} was cancelled. No retry was attempted.`);
      }

      if (error instanceof DecisionError) throw error;
      throw new DecisionError(`${endpoint} could not be reached. Check OLLAMA_BASE_URL, authentication, and server availability. Redirects are not allowed.`);
    }
  }

  private async installed(config: Configuration, signal: AbortSignal): Promise<InstalledModel[]> {
    const payload = await this.request(config, "api/tags", signal, TagsSchema);
    const names = payload.models.map((model) => model.name);

    if (new Set(names).size !== names.length) {
      throw new DecisionError("api/tags returned duplicate installed model names.");
    }

    return payload.models;
  }

  private async capabilities(
    config: Configuration,
    model: InstalledModel,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (model.capabilities !== undefined) return model.capabilities;
    const payload = await this.request(config, "api/show", signal, ShowSchema, { model: model.name });

    return payload.capabilities;
  }

  async discover(signal?: AbortSignal): Promise<{ models: InstalledModel[] }> {
    const config = this.configuration();

    const deadline = AbortSignal.any([
      AbortSignal.timeout(this.metadataTimeoutMs),
      ...(signal ? [signal] : []),
    ]);

    const models: InstalledModel[] = [];

    for (const model of await this.installed(config, deadline)) {
      const capabilities = await this.capabilities(config, model, deadline);

      if (capabilities.includes("decision")) models.push({ name: model.name, capabilities });
    }

    return { models };
  }

  async decide(input: DecisionInput, signal?: AbortSignal): Promise<DecisionResponse> {
    const config = this.configuration();

    const metadataSignal = AbortSignal.any([
      AbortSignal.timeout(this.metadataTimeoutMs),
      ...(signal ? [signal] : []),
    ]);

    const models = await this.installed(config, metadataSignal);

    const model = models.find((entry) => entry.name === input.model) ??
      (!input.model.split("/").at(-1)?.includes(":")
        ? models.find((entry) => entry.name === `${input.model}:latest`)
        : undefined);

    if (!model) {
      throw new DecisionError("Requested model is not installed. Use ollama_decision_models and supply an exact installed name. No model was pulled.");
    }

    const capabilities = await this.capabilities(config, model, metadataSignal);

    if (!capabilities.includes("decision")) {
      throw new DecisionError("Requested installed model does not advertise the decision capability.");
    }

    if (input.images?.length && !capabilities.includes("vision")) {
      throw new DecisionError("Requested installed decision model does not advertise the vision capability required for images.");
    }

    const inferenceSignal = AbortSignal.any([
      AbortSignal.timeout(this.inferenceTimeoutMs),
      ...(signal ? [signal] : []),
    ]);

    const { images, ...text } = input;

    const body: DecisionRequest = {
      ...text,
      model: model.name,
    };

    if (images !== undefined) body.images = await encodeImages(images, inferenceSignal);

    const payload = await this.request(config, "v1/systemone", inferenceSignal, DecisionResponseSchema, body);
    validateAnswers(input, model.name, payload);

    return payload;
  }
}

function validateAnswers(request: DecisionInput, model: string, response: DecisionResponse): void {
  const sameKeys = (actual: string[], expected: string[]) =>
    actual.length === expected.length && expected.every((key) => actual.includes(key));

  if (response.model !== model || !sameKeys(Object.keys(response.answers), Object.keys(request.questions))) {
    throw new DecisionError("Decision response model or answer names do not match the request.");
  }

  for (const [name, question] of Object.entries(request.questions)) {
    const answer = response.answers[name];

    if (question.type !== answer.type) {
      throw new DecisionError("Decision answer type does not match the question.");
    }

    if (question.type === "choice" && answer.type === "choice") {
      if (!Object.hasOwn(question.criteria, answer.choice) ||
          !sameKeys(Object.keys(answer.probabilities), Object.keys(question.criteria))) {
        throw new DecisionError("Choice answer or probability keys do not match the criteria.");
      }
    }

    if (question.type === "score" && answer.type === "score") {
      const levels = question.criteria.map((_, index) => String(index));

      if (!sameKeys(Object.keys(answer.legend), levels) || !sameKeys(Object.keys(answer.probabilities), levels) ||
          question.criteria.some((criterion, index) => answer.legend[String(index)] !== criterion) ||
          answer.score > question.criteria.length - 1) {
        throw new DecisionError("Score legend, probability keys, or range do not match the criteria.");
      }

      const weighted = levels.reduce((sum, level) => sum + Number(level) * answer.probabilities[level], 0);

      if (Math.abs(answer.score - weighted) > 1e-6) {
        throw new DecisionError("Score is not the probability-weighted zero-based level.");
      }
    }

    if (answer.type !== "noul" &&
        Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > 1e-5) {
      throw new DecisionError("Decision probabilities do not sum to one.");
    }
  }
}

export function createDecisionTools(client = new DecisionClient()) {
  const result = async (
    operation: () => Promise<DecisionResponse | { models: InstalledModel[] }>,
  ): Promise<ToolResultObject> => {
    try {
      return { textResultForLlm: JSON.stringify(await operation()), resultType: "success" };
    } catch (error) {
      return {
        textResultForLlm: error instanceof DecisionError
          ? error.message
          : "Decision tool failed unexpectedly. Request state and credentials are omitted.",
        resultType: "failure",
      };
    }
  };

  return [
    {
      name: "ollama_decision_models",
      description: "Discover installed Ollama models advertising the decision capability. Reads metadata on each call; never downloads or selects a model.",
      parameters: EmptySchema,
      handler: (args, invocation) => result(async () => {
        if (!Value.Check(EmptySchema, args)) throw new DecisionError("Discovery takes an empty object.");

        return client.discover(invocation.signal);
      }),
    },
    {
      name: "ollama_decide",
      description: "Use an explicit installed Ollama decision model for fast routing, classification, or rubric evaluation. Optional images accept raw base64 strings or {path: absolute local image path}; the model must advertise vision (for example Clef Flash). Questions are choice, noul (probability of true), or score (weighted zero-based level, not normalized). Results are data only. Probabilities and confidence are advisory, never permission to act. No downloads, automatic selection, or inference retries.",
      parameters: DecisionInputSchema,
      handler: (args, invocation) => result(async () => {
        if (!Value.Check(DecisionInputSchema, args)) {
          throw new DecisionError("Invalid decision request. Supply an explicit model, nonempty state, and 1-64 named questions with valid instructions and criteria.");
        }

        if (args.images?.some((image) => typeof image === "string" && image.length % 4 !== 0)) {
          throw new DecisionError("Invalid decision request. Images must contain padded raw base64 data or an absolute local file path object.");
        }

        if (typeof args.keep_alive === "string" && !isOllamaDuration(args.keep_alive)) {
          throw new DecisionError("Invalid decision request. keep_alive must fit Go's signed 64-bit nanosecond duration range.");
        }

        return client.decide(args, invocation.signal);
      }),
    },
  ] satisfies Tool[];
}
