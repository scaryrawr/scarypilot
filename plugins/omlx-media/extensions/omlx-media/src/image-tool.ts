import type { Tool } from "@github/copilot-sdk";
import { ImageToolError, type OmlxImageArgs } from "./domain.ts";
import { executeImage } from "./execute-image.ts";

export function createOmlxImageTool(): Tool<OmlxImageArgs> {
  return {
    name: "omlx_image",
    description:
      "Generate or edit images with OMLX and save them in the workspace. Add sources for editing; omit sources for generation. Returns paths only.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Finished image prompt, including anything an edit must preserve.",
        },
        output: {
          type: "string",
          description: "Absolute PNG output path. Must not already exist.",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Absolute read-only source image paths for image-to-image generation. Sources are never modified.",
        },
        mask: {
          type: "string",
          description: "Optional absolute mask path for an edit.",
        },
        size: {
          type: "string",
          pattern: "^(auto|square|portrait|landscape|[1-9][0-9]*x[1-9][0-9]*)$",
          description: "Output size preset or WIDTHxHEIGHT.",
        },
        model: {
          type: "string",
          description: "Optional explicit loaded OMLX image model.",
        },
        variants: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Number of fresh image variants. Default: 1.",
        },
        strength: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Edit strength from 0 to 1.",
        },
        advanced: {
          type: "object",
          properties: {
            steps: { type: "integer", minimum: 1 },
            guidance: { type: "number", minimum: 0 },
            quality: { type: "string", enum: ["standard", "hd", "quality"] },
            style: { type: "string", enum: ["natural", "vivid"] },
          },
          additionalProperties: false,
          description: "Optional model tuning for deliberate retries.",
        },
      },
      required: ["prompt", "output"],
      additionalProperties: false,
    },
    handler: async (args) => {
      try {
        const result = await executeImage(args);
        const files = result.files.map((file) => `- ${file}`).join("\n");
        return `Saved ${result.files.length} ${result.operation === "edit" ? "edited" : "generated"} image${result.files.length === 1 ? "" : "s"} with ${result.model}:\n${files}`;
      } catch (error) {
        if (error instanceof ImageToolError) return `❌ ${error.code}: ${error.message}`;
        return `❌ IMAGE_FAILED: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
