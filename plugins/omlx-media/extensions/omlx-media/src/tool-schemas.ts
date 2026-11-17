import { Type } from "@sinclair/typebox";

export { TranscriptionSchema as transcriptionParameters, FramesSchema as framesParameters } from "./media-domain.ts";

export const imageParameters = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  output: Type.String({ minLength: 1 }),
  sources: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  mask: Type.Optional(Type.String({ minLength: 1 })),
  size: Type.Optional(Type.Union([
    Type.Literal("auto"), Type.Literal("square"), Type.Literal("portrait"),
    Type.Literal("landscape"), Type.TemplateLiteral("${number}x${number}"),
  ])),
  model: Type.Optional(Type.String({ minLength: 1 })),
  variants: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)])),
  strength: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  advanced: Type.Optional(Type.Object({
    steps: Type.Optional(Type.Integer({ minimum: 1 })),
    guidance: Type.Optional(Type.Number({ minimum: 0 })),
    quality: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("hd"), Type.Literal("quality")])),
    style: Type.Optional(Type.Union([Type.Literal("natural"), Type.Literal("vivid")])),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const speechParameters = Type.Object({
  input: Type.String({ minLength: 1 }),
  output: Type.String({ minLength: 1 }),
  model: Type.Optional(Type.String({ minLength: 1 })),
  voice: Type.Optional(Type.String()),
  language: Type.Optional(Type.String()),
  speed: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  instructions: Type.Optional(Type.String()),
  response_format: Type.Optional(Type.Union([
    Type.Literal("wav"), Type.Literal("mp3"), Type.Literal("opus"),
    Type.Literal("flac"), Type.Literal("pcm"),
  ])),
}, { additionalProperties: false });
