import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  DecisionInputSchema,
  DecisionResponseSchema,
  EmptySchema,
  ModelStatusSchema,
  type DecisionInput,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionModel,
  type InstalledModel,
} from "./schemas.ts";

export class DecisionError extends Error {}

const maxDecisionRequestBytes = 64 * 1024;

const maxImageRequestBytes = 32 * 1024 * 1024;

const maxResponseBytes = 4 * 1024 * 1024;

const imagePrefix = "data:image/png;base64,";

type ImageApproval = (image: { path: string; endpoint: string }) => Promise<boolean>;

async function waitForImageApproval(
  approveImage: ImageApproval,
  image: { path: string; endpoint: string },
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await Promise.race([approveImage(image), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function encodeImages(
  images: NonNullable<DecisionInput["images"]>,
  signal: AbortSignal,
  endpoint: string,
  approveImage?: ImageApproval,
): Promise<string[]> {
  const encoded: string[] = [];
  let total = 0;

  for (const image of images) {
    if (signal.aborted) throw new DecisionError("Image reading was cancelled. No inference was attempted.");
    let base64: string;

    if (typeof image === "string") {
      base64 = image.startsWith("data:") ? image : `${imagePrefix}${image}`;
    } else {
      if (!isAbsolute(image.path)) {
        throw new DecisionError("Image file paths must be absolute.");
      }

      if (!approveImage) {
        throw new DecisionError("Local image files require path-specific user approval through a host confirmation dialog. Use base64 input if the host cannot confirm.");
      }

      try {
        const path = await realpath(image.path);
        const approvedStat = await lstat(path);

        if (!approvedStat.isFile() || approvedStat.size === 0) {
          throw new DecisionError("Image paths must refer to nonempty regular files.");
        }

        let approved: boolean;

        try {
          approved = await waitForImageApproval(approveImage, { path, endpoint }, signal);
        } catch {
          throw new DecisionError("Image approval could not be obtained. No file contents were read or sent.");
        }

        if (!approved) throw new DecisionError("Image file transmission was not approved. No file contents were read or sent.");

        if (signal.aborted) throw new DecisionError("Image reading was cancelled. No inference was attempted.");

        const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);

        try {
          const stat = await file.stat();

          if (await realpath(path) !== path ||
              stat.dev !== approvedStat.dev || stat.ino !== approvedStat.ino ||
              stat.size !== approvedStat.size || stat.mtimeMs !== approvedStat.mtimeMs ||
              stat.ctimeMs !== approvedStat.ctimeMs) {
            throw new DecisionError("Image file changed after approval. No file contents were read or sent.");
          }

          if (!stat.isFile() || stat.size === 0) {
            throw new DecisionError("Image paths must refer to nonempty regular files.");
          }

          const remainingBytes = Math.floor((maxImageRequestBytes - total - imagePrefix.length) / 4) * 3;

          if (stat.size > remainingBytes) {
            throw new DecisionError("Decision request exceeds the client's 32 MiB image JSON limit. Reduce the images, state, or questions.");
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          const stream = file.createReadStream({ autoClose: false, end: approvedStat.size - 1, signal });

          for await (const chunk of stream) {
            bytes += chunk.length;

            if (bytes > remainingBytes) {
              throw new DecisionError("Decision request exceeds the client's 32 MiB image JSON limit. Reduce the images, state, or questions.");
            }

            chunks.push(chunk);
          }

          const finalStat = await file.stat();

          if (bytes !== approvedStat.size ||
              finalStat.dev !== approvedStat.dev || finalStat.ino !== approvedStat.ino ||
              finalStat.size !== approvedStat.size || finalStat.mtimeMs !== approvedStat.mtimeMs ||
              finalStat.ctimeMs !== approvedStat.ctimeMs) {
            throw new DecisionError("Image file changed during reading. No file contents were sent.");
          }

          base64 = `${imagePrefix}${Buffer.concat(chunks, bytes).toString("base64")}`;
        } finally {
          await file.close();
        }
      } catch (error) {
        if (signal.aborted) {
          throw new DecisionError(signal.reason?.name === "TimeoutError"
            ? "Image approval or reading timed out. No inference was attempted."
            : "Image approval or reading was cancelled. No inference was attempted.");
        }

        if (error instanceof DecisionError) throw error;

        throw new DecisionError("Image file could not be read. Check that the supplied path is an accessible regular file.");
      }
    }

    total += base64.length;

    if (total > maxImageRequestBytes) {
      throw new DecisionError("Decision request exceeds the client's 32 MiB image JSON limit. Reduce the images, state, or questions.");
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
  approveImage?: ImageApproval;
};

export class DecisionClient {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetch: typeof fetch;
  private readonly metadataTimeoutMs: number;
  private readonly inferenceTimeoutMs: number;
  private readonly approveImage?: ImageApproval;

  constructor(options: ClientOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
    this.inferenceTimeoutMs = options.inferenceTimeoutMs ?? 120_000;
    this.approveImage = options.approveImage;
  }

  private configuration(): Configuration {
    let baseUrl: URL;

    try {
      baseUrl = new URL(this.environment.OMLX_BASE_URL ?? "http://localhost:8000");
    } catch {
      throw new DecisionError("OMLX_BASE_URL must be an absolute HTTP or HTTPS URL.");
    }

    if (!["http:", "https:"].includes(baseUrl.protocol) ||
        baseUrl.username || baseUrl.password || baseUrl.href.includes("?") || baseUrl.href.includes("#")) {
      throw new DecisionError("OMLX_BASE_URL must use HTTP or HTTPS without credentials, query, or fragment.");
    }

    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;
    const apiKey = this.environment.OMLX_API_KEY;

    if (apiKey && /[\r\n]/.test(apiKey)) {
      throw new DecisionError("OMLX_API_KEY must not contain line breaks.");
    }

    if (apiKey && baseUrl.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)) {
      throw new DecisionError("Authenticated remote oMLX endpoints require HTTPS. HTTP authentication is allowed only for localhost, 127.0.0.1, or [::1].");
    }

    return { baseUrl, apiKey };
  }

  private async request<T extends TSchema>(
    config: Configuration,
    endpoint: string,
    signal: AbortSignal,
    schema: T,
    body?: DecisionRequest,
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
              ? "Decision request exceeds the client's 32 MiB image JSON limit. Reduce the images, state, or questions."
              : "Decision request exceeds the client's 64 KiB text-only JSON limit. Reduce the state or questions.");
          }
        }

        headers.set("Content-Type", "application/json");
        init.body = serialized;
      }

      if (config.apiKey) headers.set("Authorization", `Bearer ${config.apiKey}`);

      const response = await this.fetch(new URL(endpoint, config.baseUrl), init);

      if (!response.ok) {
        await response.body?.cancel();
        throw new DecisionError(`${endpoint} returned HTTP ${response.status}. Check oMLX SystemOne support, authentication, and model compatibility.`);
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
      throw new DecisionError(`${endpoint} could not be reached. Check OMLX_BASE_URL, authentication, and server availability. Redirects are not allowed.`);
    }
  }

  private async installed(config: Configuration, signal: AbortSignal): Promise<InstalledModel[]> {
    const payload = await this.request(config, "v1/models/status", signal, ModelStatusSchema);
    const names = payload.models.map((model) => model.id);

    if (new Set(names).size !== names.length) {
      throw new DecisionError("v1/models/status returned duplicate installed model IDs.");
    }

    return payload.models;
  }

  async discover(signal?: AbortSignal): Promise<{ models: DecisionModel[] }> {
    const config = this.configuration();

    const deadline = AbortSignal.any([
      AbortSignal.timeout(this.metadataTimeoutMs),
      ...(signal ? [signal] : []),
    ]);

    return { models: (await this.installed(config, deadline))
      .filter((model) => model.model_type === "decision" || model.engine_type === "decision")
      .map(({ id, loaded }) => ({ id, loaded })) };
  }

  async decide(input: DecisionInput, signal?: AbortSignal): Promise<DecisionResponse> {
    validateInput(input);
    const config = this.configuration();

    const metadataSignal = AbortSignal.any([
      AbortSignal.timeout(this.metadataTimeoutMs),
      ...(signal ? [signal] : []),
    ]);

    const models = await this.installed(config, metadataSignal);

    const model = models.find((entry) => entry.id === input.model);

    if (!model) {
      throw new DecisionError("Requested model is not installed. Use omlx_decision_models and supply an exact installed ID. No model was downloaded.");
    }

    if (model.model_type !== "decision" && model.engine_type !== "decision") {
      throw new DecisionError("Requested installed model does not have a decision model or engine type.");
    }

    const inferenceSignal = AbortSignal.any([
      AbortSignal.timeout(this.inferenceTimeoutMs),
      ...(signal ? [signal] : []),
    ]);

    const { images, ...text } = input;

    const body: DecisionRequest = {
      ...text,
      model: model.id,
      truncate: input.truncate ?? false,
    };

    if (images !== undefined) {
      body.images = await encodeImages(images, inferenceSignal, new URL("v1/systemone", config.baseUrl).href, this.approveImage);
    }

    const payload = await this.request(config, "v1/systemone", inferenceSignal, DecisionResponseSchema, body);
    validateAnswers(input, model.id, payload);

    return payload;
  }
}

function validateInput<T>(input: T): asserts input is T & DecisionInput {
  if (!Value.Check(DecisionInputSchema, input)) {
    throw new DecisionError("Invalid decision request. Supply an explicit model, nonempty state, and named questions with valid instructions and criteria.");
  }

  if (input.images?.some((image) => typeof image === "string" &&
      (image.startsWith("data:") ? image.slice(image.indexOf(",") + 1) : image).length % 4 !== 0)) {
    throw new DecisionError("Invalid decision request. Images must contain padded base64 data, an inline image data URI, or an absolute local file path object.");
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

      // Clef rounds probabilities and the independently weighted score to four decimals.
      const roundingTolerance = 0.00005 * (1 + levels.length * (levels.length - 1) / 2) + 1e-6;

      if (Math.abs(answer.score - weighted) > roundingTolerance) {
        throw new DecisionError("Score is not the probability-weighted zero-based level.");
      }
    }

    if (answer.type !== "noul" &&
        Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) >
          Object.keys(answer.probabilities).length * 0.00005 + 1e-6) {
      throw new DecisionError("Decision probabilities do not sum to one.");
    }
  }
}

export function createDecisionTools(client = new DecisionClient()) {
  const result = async (
    operation: () => Promise<DecisionResponse | { models: DecisionModel[] }>,
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
      name: "omlx_decision_models",
      description: "Discover installed oMLX SystemOne decision models by model/engine type. Returns exact IDs and loaded status, including unloaded models. Reads metadata on each call; never downloads or selects a model.",
      parameters: EmptySchema,
      handler: (args, invocation) => result(async () => {
        if (!Value.Check(EmptySchema, args)) throw new DecisionError("Discovery takes an empty object.");

        return client.discover(invocation.signal);
      }),
    },
    {
      name: "omlx_decide",
      description: "Use an explicit installed oMLX decision model via SystemOne for fast routing, classification, or rubric evaluation. Optional images accept padded raw base64, inline image data URIs, or {path: absolute local image path}; local files require per-call user confirmation of the resolved path and destination before reading. The server verifies vision support (for example Clef Flash). Questions are choice, noul (probability of true), or score (weighted zero-based level, not normalized). State truncation defaults to false. Results are data only. Probabilities and confidence are advisory, never permission to act. No downloads, automatic selection, or inference retries.",
      parameters: DecisionInputSchema,
      handler: (args, invocation) => result(async () => {
        validateInput(args);

        return client.decide(args, invocation.signal);
      }),
    },
  ] satisfies Tool[];
}
