import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { readImageDataUri } from "./workspace-artifacts.ts";
import {
  OmlxToolError,
  type AudioOperation,
  type FetchImplementation,
  type ImageOperation,
  type OmlxSpeechArgs,
  type OmlxTranscriptionArgs,
  type RenderImageRequest,
} from "./domain.ts";

const REQUEST_TIMEOUT_MS = 300_000;

const JsonValueSchema = Type.Recursive((self) =>
  Type.Union([
    Type.Boolean(),
    Type.Null(),
    Type.Number(),
    Type.String(),
    Type.Array(self),
    Type.Record(Type.String(), self),
  ]),
);

const StringSchema = Type.String();

const ModelPayloadSchema = Type.Object({
  id: Type.String(),
  loaded: Type.Optional(Type.Boolean()),
  status: Type.Optional(Type.String()),
  engine_type: Type.Optional(Type.String()),
  model_type: Type.Optional(Type.String()),
  capabilities: Type.Optional(JsonValueSchema),
  tasks: Type.Optional(JsonValueSchema),
});

const ModelStatusSchema = Type.Object({
  models: Type.Array(JsonValueSchema),
});

const ErrorEnvelopeSchema = Type.Object({
  error: JsonValueSchema,
});

const ErrorMessageSchema = Type.Object({
  message: Type.String(),
});

const ImageResponseSchema = Type.Object({
  data: Type.Array(JsonValueSchema, { minItems: 1 }),
});

const ImageDataSchema = Type.Object({
  b64_json: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
});

const TranscriptionResponseSchema = Type.Object({
  text: Type.String(),
});

type JsonValue = Static<typeof JsonValueSchema>;

type ModelPayload = Static<typeof ModelPayloadSchema>;

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
  modelType?: string;
  engineType?: string;
}

interface ImageRequestBody {
  prompt: string;
  model: string;
  n: number;
  response_format: "b64_json";
  size?: string;
  quality?: "standard" | "hd" | "quality";
  style?: "natural" | "vivid";
  images?: Array<{ image_url: string }>;
  mask?: { image_url: string };
  image_strength?: number;
  steps?: number;
  guidance?: number;
}

function stringsFrom(value: JsonValue | undefined): string[] {
  if (Value.Check(StringSchema, value)) return [value.toLowerCase()];

  if (!Array.isArray(value)) return [];

  return value.flatMap((item) =>
    Value.Check(StringSchema, item) ? [item.toLowerCase()] : [],
  );
}

function parseLoaded(model: ModelPayload): boolean {
  if (model.loaded !== undefined) return model.loaded;

  if (model.status !== undefined) {
    return ["loaded", "ready", "running"].includes(model.status.toLowerCase());
  }

  return true;
}

function parseModel(value: JsonValue): ModelInfo | null {
  if (!Value.Check(ModelPayloadSchema, value)) return null;

  const capabilities = new Set([
    ...stringsFrom(value.capabilities),
    ...stringsFrom(value.tasks),
  ]);

  const image =
    value.engine_type?.toLowerCase() === "image" ||
    value.model_type?.toLowerCase() === "image" ||
    [...capabilities].some(
      (capability) => GENERATION_CAPABILITIES.has(capability) || EDIT_CAPABILITIES.has(capability),
    );

  return {
    id: value.id,
    image,
    loaded: parseLoaded(value),
    capabilities,
    modelType: value.model_type?.toLowerCase(),
    engineType: value.engine_type?.toLowerCase(),
  };
}

function supports(model: ModelInfo, operation: ImageOperation): boolean {
  const expected = operation === "generate" ? GENERATION_CAPABILITIES : EDIT_CAPABILITIES;

  if ([...model.capabilities].some((capability) => expected.has(capability))) return true;

  return model.image;
}

function responseErrorMessage(payload: JsonValue): string | null {
  if (!Value.Check(ErrorEnvelopeSchema, payload)) return null;

  if (Value.Check(StringSchema, payload.error)) return payload.error;

  if (Value.Check(ErrorMessageSchema, payload.error)) {
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

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;

    try {
      response = await this.fetchImplementation(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OmlxToolError(
        "OMLX_UNREACHABLE",
        `Could not reach OMLX at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const text = await response.text();
      let message = response.statusText || `HTTP ${response.status}`;

      try {
        const parsed = Value.Parse(JsonValueSchema, JSON.parse(text));
        message = responseErrorMessage(parsed) || message;

        if (Value.Check(Type.Object({ detail: Type.String() }), parsed)) message = parsed.detail;
      } catch {
        // Non-JSON error bodies still retain their HTTP status.
      }

      throw new OmlxToolError(
        requestErrorCode(response.status),
        `OMLX request failed (${response.status}): ${message}`,
      );
    }

    return response;
  }

  private async requestJson(url: string, init: RequestInit): Promise<JsonValue> {
    const response = await this.request(url, init);
    const text = await response.text();
    let payload: JsonValue;

    try {
      payload = text ? Value.Parse(JsonValueSchema, JSON.parse(text)) : {};
    } catch {
      throw new OmlxToolError("INVALID_RESPONSE", `OMLX returned invalid JSON (${response.status})`);
    }

    const apiError = responseErrorMessage(payload);

    if (apiError) {
      const message = apiError || response.statusText || `HTTP ${response.status}`;
      throw new OmlxToolError(
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

    if (!Value.Check(ModelStatusSchema, payload)) {
      throw new OmlxToolError("INVALID_MODEL_STATUS", "OMLX model status did not contain a models array");
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
        error instanceof OmlxToolError &&
        ["INVALID_MODEL_STATUS", "OMLX_REQUEST_FAILED"].includes(error.code)
      ) {
        return requestedModel.trim();
      }

      throw error;
    }

    if (requestedModel?.trim()) {
      const requested = models.find((model) => model.id === requestedModel.trim());

      if (!requested) {
        throw new OmlxToolError("MODEL_NOT_FOUND", `OMLX model was not found: ${requestedModel}`);
      }

      if (!requested.loaded) {
        throw new OmlxToolError("MODEL_NOT_LOADED", `OMLX model is not loaded: ${requestedModel}`);
      }

      if (!supports(requested, operation)) {
        throw new OmlxToolError(
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
      throw new OmlxToolError(
        "NO_CAPABLE_MODEL",
        `No loaded OMLX model supports image ${operation}`,
      );
    }

    return candidates[0].id;
  }

  async selectAudioModel(operation: AudioOperation, requestedModel?: string): Promise<string> {
    const models = await this.models();
    const requested = requestedModel?.trim();

    if (requestedModel !== undefined && !requested) {
      throw new OmlxToolError("INVALID_MODEL", "Audio model must not be empty");
    }

    const matches = (model: ModelInfo) => {
      const kind = operation === "speech" ? "audio_tts" : "audio_stt";

      return model.modelType === kind || model.engineType === kind;
    };

    if (requested) {
      const model = models.find((item) => item.id === requested);

      if (!model) throw new OmlxToolError("MODEL_NOT_FOUND", `OMLX model was not found: ${requested}`);

      if (!matches(model)) {
        throw new OmlxToolError("MODEL_CAPABILITY_MISMATCH", `OMLX model does not support audio ${operation}: ${requested}`);
      }

      return model.id;
    }

    const model = models.find((item) => item.loaded && matches(item))
      ?? models.find(matches);

    if (!model) throw new OmlxToolError("NO_CAPABLE_MODEL", `No OMLX model supports audio ${operation}`);

    return model.id;
  }

  async speech(args: OmlxSpeechArgs, model: string): Promise<Buffer> {
    const response = await this.request(`${this.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        model,
        input: args.input,
        voice: args.voice,
        language: args.language,
        speed: args.speed,
        instructions: args.instructions,
        response_format: args.response_format ?? "wav",
      }),
    });

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
      throw new OmlxToolError("INVALID_RESPONSE", `OMLX speech response was not audio: ${contentType || "missing content type"}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());

    if (!audio.length) throw new OmlxToolError("INVALID_RESPONSE", "OMLX returned empty speech audio");

    return audio;
  }

  async transcribe(args: OmlxTranscriptionArgs, model: string): Promise<string> {
    const form = new FormData();
    form.set("model", model);
    form.set("response_format", "json");

    if (args.language) form.set("language", args.language);

    if (args.prompt) form.set("prompt", args.prompt);
    form.set("file", new Blob([await readFile(args.input)]), path.basename(args.input));

    const payload = await this.requestJson(`${this.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: this.headers(false),
      body: form,
    });

    if (!Value.Check(TranscriptionResponseSchema, payload)) {
      throw new OmlxToolError("INVALID_RESPONSE", "OMLX transcription response did not contain text");
    }

    return payload.text;
  }

  async render(request: RenderImageRequest): Promise<Buffer[]> {
    const body: ImageRequestBody = {
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

    if (!Value.Check(ImageResponseSchema, payload)) {
      throw new OmlxToolError("INVALID_RESPONSE", "OMLX image response did not contain image data");
    }

    return Promise.all(payload.data.map((item, index) => this.decodeImage(item, index)));
  }

  private async decodeImage(item: JsonValue, index: number): Promise<Buffer> {
    if (!Value.Check(ImageDataSchema, item)) {
      throw new OmlxToolError("INVALID_RESPONSE", `OMLX image data ${index} was invalid`);
    }

    if (item.b64_json !== undefined) {
      return Buffer.from(item.b64_json, "base64");
    }

    if (item.url !== undefined) {
      let response: Response;

      try {
        const target = new URL(item.url);
        const base = new URL(this.baseUrl);
        response = await this.fetchImplementation(target, {
          headers: target.origin === base.origin ? this.headers(false) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new OmlxToolError(
          "IMAGE_DOWNLOAD_FAILED",
          `Could not download OMLX image ${index}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new OmlxToolError(
          "IMAGE_DOWNLOAD_FAILED",
          `Could not download OMLX image ${index} (${response.status})`,
        );
      }

      return Buffer.from(await response.arrayBuffer());
    }

    throw new OmlxToolError(
      "INVALID_RESPONSE",
      `OMLX image data ${index} contained neither b64_json nor url`,
    );
  }
}
