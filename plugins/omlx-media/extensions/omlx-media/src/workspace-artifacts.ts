import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { ImageToolError } from "./domain.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function requireAbsolutePath(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new ImageToolError("ABSOLUTE_PATH_REQUIRED", `Path must be absolute: ${value}`);
  }
  return path.resolve(value);
}

export async function resolveImageInput(value: string): Promise<string> {
  const candidate = requireAbsolutePath(value);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) throw new Error("not a file");
  } catch {
    throw new ImageToolError("INPUT_NOT_FOUND", `Image input was not found: ${value}`);
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new ImageToolError("UNSUPPORTED_IMAGE", `Image input must be PNG, JPEG, or WebP: ${value}`);
  }
  return resolved;
}

function outputForIndex(base: string, index: number, count: number): string {
  if (count === 1) return base;
  const extension = path.extname(base) || ".png";
  return path.join(path.dirname(base), `${path.basename(base, path.extname(base))}_${index}${extension}`);
}

export async function planImageOutputs(
  requestedOutput: string,
  count: number,
): Promise<string[]> {
  const base = requireAbsolutePath(requestedOutput);
  if (path.extname(base).toLowerCase() !== ".png") {
    throw new ImageToolError("INVALID_OUTPUT", "Image output must use a .png extension");
  }

  const outputs = Array.from({ length: count }, (_, index) => outputForIndex(base, index, count));
  for (const output of outputs) {
    await mkdir(path.dirname(output), { recursive: true });
    try {
      await access(output, fsConstants.F_OK);
      throw new ImageToolError("OUTPUT_CONFLICT", `Image output already exists: ${output}`);
    } catch (error) {
      if (error instanceof ImageToolError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return outputs;
}

export async function readImageDataUri(filePath: string): Promise<string> {
  const mimeType =
    path.extname(filePath).toLowerCase() === ".png"
      ? "image/png"
      : path.extname(filePath).toLowerCase() === ".webp"
        ? "image/webp"
        : "image/jpeg";
  const encoded = (await readFile(filePath)).toString("base64");
  return `data:${mimeType};base64,${encoded}`;
}

export async function persistImages(outputs: string[], images: Buffer[]): Promise<void> {
  if (outputs.length !== images.length) {
    throw new ImageToolError("INVALID_RESPONSE", "OMLX returned an unexpected number of images");
  }

  const temporary: string[] = [];
  const committed: string[] = [];
  try {
    for (let index = 0; index < outputs.length; index++) {
      if (images[index].length === 0) {
        throw new ImageToolError("EMPTY_IMAGE", `OMLX returned an empty image at index ${index}`);
      }
      const temp = path.join(
        path.dirname(outputs[index]),
        `.${path.basename(outputs[index])}.${randomUUID()}.tmp`,
      );
      await writeFile(temp, images[index], { flag: "wx" });
      temporary.push(temp);
    }
    for (let index = 0; index < outputs.length; index++) {
      try {
        await link(temporary[index], outputs[index]);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new ImageToolError(
            "OUTPUT_CONFLICT",
            `Image output already exists: ${outputs[index]}`,
          );
        }
        throw error;
      }
      committed.push(outputs[index]);
      await rm(temporary[index]);
    }
  } catch (error) {
    await Promise.allSettled(temporary.map((file) => rm(file, { force: true })));
    await Promise.allSettled(committed.map((file) => rm(file, { force: true })));
    throw error;
  }
}
