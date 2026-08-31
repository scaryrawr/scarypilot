import { readImageDataUri } from "./workspace-artifacts.ts";
import {
  ImageToolError,
  type FetchImplementation,
  type ImageOperation,
  type RenderImageRequest,
} from "./domain.ts";

const REQUEST_TIMEOUT_MS = 300_000;
const GENERATION_CAPABILITIES = new Set([
  "generate",
  "generation",
  "image-generation",
  "image_generation",
  "text-to-image",
  "text_to_image",
]);
const EDIT_CAPABILITIES = new Set([
  "edit",
  "editing",
  "image-edit",
  "image_edit",
  "image-to-image",
  "image_to_image",
]);

interface ModelInfo {
  id: string;
  image: boolean;
  loaded: boolean;
  capabilities: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsFrom(value: unknown): string[] {
  if (typeof value === "string") return [value.toLowerCase()];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [item.toLowerCase()] : []));
}

function parseLoaded(model: Record<string, unknown>): boolean {
  if (typeof model.loaded === "boolean") return model.loaded;
  if (typeof model.status === "string") {
    return ["loaded", "ready", "running"].includes(model.status.toLowerCase());
  }
  return true;
}

function parseModel(value: unknown): ModelInfo | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const capabilities = new Set([
    ...stringsFrom(value.capabilities),
    ...stringsFrom(value.tasks),
  ]);
  const image =
    (typeof value.engine_type === "string" && value.engine_type.toLowerCase() === "image") ||
    (typeof value.model_type === "string" && value.model_type.toLowerCase() === "image") ||
    [...capabilities].some(
      (capability) => GENERATION_CAPABILITIES.has(capability) || EDIT_CAPABILITIES.has(capability),
    );
  return {
    id: value.id,
    image,
    loaded: parseLoaded(value),
    capabilities,
  };
}

function supports(model: ModelInfo, operation: ImageOperation): boolean {
  const expected = operation === "generate" ? GENERATION_CAPABILITIES : EDIT_CAPABILITIES;
  if ([...model.capabilities].some((capability) => expected.has(capability))) return true;
  return model.image;
}

function responseErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload) || payload.error === undefined) return null;
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return "OMLX returned an error";
}

function requestErrorCode(status: number): string {
  return status === 401 || status === 403
    ? "AUTHENTICATION_FAILED"
    : "OMLX_REQUEST_FAILED";
}

export class OmlxClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImplementation: FetchImplementation;

  constructor(
    environment: NodeJS.ProcessEnv,
    fetchImplementation: FetchImplementation = fetch,
  ) {
    this.baseUrl = (environment.OMLX_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
    this.apiKey = environment.OMLX_API_KEY;
    this.fetchImplementation = fetchImplementation;
  }

  private headers(json: boolean): HeadersInit {
    const headers: Record<string, string> = {};
    if (json) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ImageToolError(
        "OMLX_UNREACHABLE",
        `Could not reach OMLX at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      if (!response.ok) {
        throw new ImageToolError(
          requestErrorCode(response.status),
          `OMLX request failed (${response.status}): ${response.statusText || "HTTP error"}`,
        );
      }
      throw new ImageToolError("INVALID_RESPONSE", `OMLX returned invalid JSON (${response.status})`);
    }
    const apiError = responseErrorMessage(payload);
    if (!response.ok || apiError) {
      const message = apiError || response.statusText || `HTTP ${response.status}`;
      throw new ImageToolError(
        requestErrorCode(response.status),
        `OMLX request failed (${response.status}): ${message}`,
      );
    }
    return payload;
  }

  private async models(): Promise<ModelInfo[]> {
    const payload = await this.requestJson(`${this.baseUrl}/v1/models/status`, {
      method: "GET",
      headers: this.headers(false),
    });
    if (!isRecord(payload) || !Array.isArray(payload.models)) {
      throw new ImageToolError("INVALID_MODEL_STATUS", "OMLX model status did not contain a models array");
    }
    return payload.models.flatMap((model) => {
      const parsed = parseModel(model);
      return parsed ? [parsed] : [];
    });
  }

  async selectModel(operation: ImageOperation, requestedModel?: string): Promise<string> {
    let models: ModelInfo[];
    try {
      models = await this.models();
    } catch (error) {
      if (
        requestedModel?.trim() &&
        error instanceof ImageToolError &&
        ["INVALID_MODEL_STATUS", "OMLX_REQUEST_FAILED"].includes(error.code)
      ) {
        return requestedModel.trim();
      }
      throw error;
    }

    if (requestedModel?.trim()) {
      const requested = models.find((model) => model.id === requestedModel.trim());
      if (!requested) {
        throw new ImageToolError("MODEL_NOT_FOUND", `OMLX model was not found: ${requestedModel}`);
      }
      if (!requested.loaded) {
        throw new ImageToolError("MODEL_NOT_LOADED", `OMLX model is not loaded: ${requestedModel}`);
      }
      if (!supports(requested, operation)) {
        throw new ImageToolError(
          "MODEL_CAPABILITY_MISMATCH",
          `OMLX model does not support image ${operation}: ${requestedModel}`,
        );
      }
      return requested.id;
    }

    const candidates = models.filter(
      (model) => model.loaded && model.image && supports(model, operation),
    );
    if (candidates.length === 0) {
      throw new ImageToolError(
        "NO_CAPABLE_MODEL",
        `No loaded OMLX model supports image ${operation}`,
      );
    }
    return candidates[0].id;
  }

  async render(request: RenderImageRequest): Promise<Buffer[]> {
    const body: Record<string, unknown> = {
      prompt: request.prompt,
      model: request.model,
      n: request.variants,
      response_format: "b64_json",
    };
    if (request.size) body.size = request.size;

    if (request.operation === "generate") {
      body.quality = request.advanced?.quality ?? "standard";
      body.style = request.advanced?.style ?? "vivid";
    } else {
      body.images = await Promise.all(
        request.sourcePaths.map(async (sourcePath) => ({ image_url: await readImageDataUri(sourcePath) })),
      );
      if (request.maskPath) {
        body.mask = { image_url: await readImageDataUri(request.maskPath) };
      }
      if (request.strength !== undefined) body.image_strength = request.strength;
      if (request.advanced?.steps !== undefined) body.steps = request.advanced.steps;
      if (request.advanced?.guidance !== undefined) body.guidance = request.advanced.guidance;
    }

    const endpoint =
      request.operation === "generate" ? "/v1/images/generations" : "/v1/images/edits";
    const payload = await this.requestJson(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
      throw new ImageToolError("INVALID_RESPONSE", "OMLX image response did not contain image data");
    }
    return Promise.all(payload.data.map((item, index) => this.decodeImage(item, index)));
  }

  private async decodeImage(item: unknown, index: number): Promise<Buffer> {
    if (!isRecord(item)) {
      throw new ImageToolError("INVALID_RESPONSE", `OMLX image data ${index} was invalid`);
    }
    if (typeof item.b64_json === "string") {
      return Buffer.from(item.b64_json, "base64");
    }
    if (typeof item.url === "string") {
      let response: Response;
      try {
        const target = new URL(item.url);
        const base = new URL(this.baseUrl);
        response = await this.fetchImplementation(target, {
          headers: target.origin === base.origin ? this.headers(false) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new ImageToolError(
          "IMAGE_DOWNLOAD_FAILED",
          `Could not download OMLX image ${index}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        throw new ImageToolError(
          "IMAGE_DOWNLOAD_FAILED",
          `Could not download OMLX image ${index} (${response.status})`,
        );
      }
      return Buffer.from(await response.arrayBuffer());
    }
    throw new ImageToolError(
      "INVALID_RESPONSE",
      `OMLX image data ${index} contained neither b64_json nor url`,
    );
  }
}
