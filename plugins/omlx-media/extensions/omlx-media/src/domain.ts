export type ImageOperation = "generate" | "edit";

export type ImageSize =
  | "auto"
  | "square"
  | "portrait"
  | "landscape"
  | `${number}x${number}`;

export interface AdvancedImageOptions {
  steps?: number;
  guidance?: number;
  quality?: "standard" | "hd" | "quality";
  style?: "natural" | "vivid";
}

export interface OmlxImageArgs {
  prompt: string;
  output: string;
  sources?: string[];
  mask?: string;
  size?: ImageSize;
  model?: string;
  variants?: 1 | 2 | 3 | 4;
  strength?: number;
  advanced?: AdvancedImageOptions;
}

export interface OmlxImageResult {
  operation: ImageOperation;
  model: string;
  files: string[];
}

export interface RenderImageRequest {
  operation: ImageOperation;
  prompt: string;
  model: string;
  sourcePaths: string[];
  maskPath?: string;
  size?: string;
  variants: number;
  strength?: number;
  advanced?: AdvancedImageOptions;
}

export type AudioOperation = "speech" | "transcription";

export type SpeechFormat = "wav" | "mp3" | "opus" | "flac" | "pcm";

export interface OmlxSpeechArgs {
  input: string;
  output: string;
  model?: string;
  voice?: string;
  language?: string;
  speed?: number;
  instructions?: string;
  response_format?: SpeechFormat;
}

export interface OmlxTranscriptionArgs {
  input: string;
  output: string;
  model?: string;
  language?: string;
  prompt?: string;
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class OmlxToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OmlxToolError";
    this.code = code;
  }
}
