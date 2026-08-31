import {
  ImageToolError,
  type FetchImplementation,
  type ImageOperation,
  type ImageSize,
  type OmlxImageArgs,
  type OmlxImageResult,
} from "./domain.ts";
import { OmlxClient } from "./omlx-client.ts";
import {
  persistImages,
  planImageOutputs,
  resolveImageInput,
} from "./workspace-artifacts.ts";

export interface ImageDependencies {
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: FetchImplementation;
}

function imageSize(value: ImageSize | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "square") return "1024x1024";
  if (value === "portrait") return "1024x1792";
  if (value === "landscape") return "1792x1024";
  if (value === "auto") return "auto";
  if (!/^[1-9]\d*x[1-9]\d*$/.test(value)) {
    throw new ImageToolError("INVALID_SIZE", `Invalid image size: ${value}`);
  }
  return value;
}

function validateArgs(args: OmlxImageArgs): {
  operation: ImageOperation;
  prompt: string;
  variants: number;
} {
  const prompt = args.prompt?.trim();
  if (!prompt) throw new ImageToolError("INVALID_PROMPT", "Image prompt must not be empty");
  const operation: ImageOperation = args.sources?.length ? "edit" : "generate";
  const variants = args.variants ?? 1;
  if (!Number.isInteger(variants) || variants < 1 || variants > 4) {
    throw new ImageToolError("INVALID_VARIANTS", "Image variants must be between 1 and 4");
  }
  if (operation === "generate" && (args.mask || args.strength !== undefined)) {
    throw new ImageToolError("EDIT_OPTIONS_WITHOUT_SOURCES", "Mask and strength require source images");
  }
  if (operation === "generate" && (args.advanced?.steps !== undefined || args.advanced?.guidance !== undefined)) {
    throw new ImageToolError("EDIT_OPTIONS_WITHOUT_SOURCES", "Steps and guidance require source images");
  }
  if (operation === "edit" && (args.advanced?.quality || args.advanced?.style)) {
    throw new ImageToolError("GENERATION_OPTIONS_WITH_SOURCES", "Quality and style are generation-only options");
  }
  if (args.strength !== undefined && (!Number.isFinite(args.strength) || args.strength < 0 || args.strength > 1)) {
    throw new ImageToolError("INVALID_STRENGTH", "Image strength must be between 0 and 1");
  }
  if (
    args.advanced?.steps !== undefined &&
    (!Number.isInteger(args.advanced.steps) || args.advanced.steps < 1)
  ) {
    throw new ImageToolError("INVALID_STEPS", "Image steps must be a positive integer");
  }
  if (
    args.advanced?.guidance !== undefined &&
    (!Number.isFinite(args.advanced.guidance) || args.advanced.guidance < 0)
  ) {
    throw new ImageToolError("INVALID_GUIDANCE", "Image guidance must be zero or greater");
  }
  return { operation, prompt, variants };
}

export async function executeImage(
  args: OmlxImageArgs,
  dependencies: ImageDependencies = {},
): Promise<OmlxImageResult> {
  const { operation, prompt, variants } = validateArgs(args);
  const sourcePaths = await Promise.all(
    (args.sources ?? []).map(resolveImageInput),
  );
  const maskPath = args.mask ? await resolveImageInput(args.mask) : undefined;
  const outputs = await planImageOutputs(args.output, variants);
  const client = new OmlxClient(
    dependencies.environment ?? process.env,
    dependencies.fetchImplementation ?? fetch,
  );
  const model = await client.selectModel(operation, args.model);
  const images = await client.render({
    operation,
    prompt,
    model,
    sourcePaths,
    maskPath,
    size: imageSize(args.size),
    variants,
    strength: args.strength,
    advanced: args.advanced,
  });
  await persistImages(outputs, images);
  return {
    operation,
    model,
    files: outputs,
  };
}
