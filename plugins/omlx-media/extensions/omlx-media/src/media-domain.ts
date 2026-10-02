import { Type, type Static } from "@sinclair/typebox";

const AbsolutePath = Type.String({ minLength: 1, maxLength: 4096, description: "Absolute path, validated using the platform's path.isAbsolute." });

const Recognition = {
  input: AbsolutePath,
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  language: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  prompt: Type.Optional(Type.String({ maxLength: 8192 })),
};

const Timeout = Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Total operation deadline in seconds. Default 600; maximum 1800." }));

export const LegacyTranscriptionSchema = Type.Object({
  input: Type.String(),
  output: Type.String(),
  model: Type.Optional(Type.String()),
  language: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const RecordingSchema = Type.Object({
  ...Recognition,
  output_dir: AbsolutePath,
  chunk_seconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 120, description: "Fixed mono 16 kHz WAV chunk length. Default 60. Maximum 120 chunks and 2 hours total." })),
  timeout_seconds: Timeout,
  allow_remote: Type.Optional(Type.Boolean({ description: "Explicitly consent to sending recording audio to a non-loopback OMLX endpoint. Redirects are never followed." })),
}, { additionalProperties: false });

export const TranscriptionSchema = Type.Union([LegacyTranscriptionSchema, RecordingSchema]);

export const TranscriptionParametersSchema = Type.Object({
  input: LegacyTranscriptionSchema.properties.input,
  output: Type.Optional(LegacyTranscriptionSchema.properties.output),
  output_dir: Type.Optional(RecordingSchema.properties.output_dir),
  model: LegacyTranscriptionSchema.properties.model,
  language: LegacyTranscriptionSchema.properties.language,
  prompt: LegacyTranscriptionSchema.properties.prompt,
  chunk_seconds: RecordingSchema.properties.chunk_seconds,
  timeout_seconds: RecordingSchema.properties.timeout_seconds,
  allow_remote: RecordingSchema.properties.allow_remote,
}, {
  additionalProperties: false,
  description: "Require exactly one of output or output_dir at execution. chunk_seconds, timeout_seconds and allow_remote are recording-mode options only.",
});

const CropSchema = Type.Object({
  x: Type.Integer({ minimum: 0 }),
  y: Type.Integer({ minimum: 0 }),
  width: Type.Integer({ minimum: 1, maximum: 16384 }),
  height: Type.Integer({ minimum: 1, maximum: 16384 }),
}, { additionalProperties: false });

export const FramesSchema = Type.Object({
  input: AbsolutePath,
  output_dir: AbsolutePath,
  max_frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 120, description: "Periodic sample count, default 24. Mutually exclusive with seconds." })),
  seconds: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { minItems: 1, maxItems: 120, uniqueItems: true, description: "Explicit requested timestamps; mutually exclusive with start/end/max_frames." })),
  start: Type.Optional(Type.Number({ minimum: 0 })),
  end: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  width: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096, description: "Maximum output width without upscaling. Default 1280. Crop is applied first." })),
  crop: Type.Optional(CropSchema),
  format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")], {
    description: "Default png is not discovered by classify_frames.py. Select jpeg for compatible .jpg candidate files.",
  })),
  timeout_seconds: Timeout,
}, { additionalProperties: false });

export type LegacyTranscriptionArgs = Static<typeof LegacyTranscriptionSchema>;

export type RecordingArgs = Static<typeof RecordingSchema>;

export type TranscriptionArgs = Static<typeof TranscriptionSchema>;

export type FramesArgs = Static<typeof FramesSchema>;

export const RecordingResultSchema = Type.Object({
  kind: Type.Literal("recording"),
  directory: Type.String(),
  manifest: Type.String(),
  transcript: Type.String(),
  model: Type.String(),
  chunks: Type.Integer({ minimum: 1, maximum: 120 }),
  timing: Type.String(),
}, { additionalProperties: false });

export const FramesResultSchema = Type.Object({
  kind: Type.Literal("frames"),
  directory: Type.String(),
  manifest: Type.String(),
  frames: Type.Integer({ minimum: 1, maximum: 120 }),
  format: Type.Union([Type.Literal("jpeg"), Type.Literal("png")]),
  timing: Type.String(),
  classification_script_compatible: Type.Boolean(),
  compatibility_note: Type.Optional(Type.String()),
}, { additionalProperties: false });

export type RecordingResult = Static<typeof RecordingResultSchema>;

export type FramesResult = Static<typeof FramesResultSchema>;

export interface AudioChunk {
  index: number;
  start_seconds: number;
  end_seconds: number;
  audio: string;
  text: string;
}

export interface PreparedFrame {
  index: number;
  requested_seconds: number;
  file: string;
}
