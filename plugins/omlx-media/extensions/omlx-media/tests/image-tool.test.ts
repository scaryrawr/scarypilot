import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOmlxImageTool } from "../src/image-tool.ts";

describe("omlx_image tool", () => {
  it("keeps a compact single-operation schema", () => {
    const tool = createOmlxImageTool();

    const parameters = tool.parameters as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    assert.equal(tool.name, "omlx_image");
    assert.equal(parameters.type, "object");
    assert.deepEqual(parameters.required, ["prompt", "output"]);
    assert.equal(parameters.additionalProperties, false);
    const properties = parameters.properties;
    assert.equal(properties.prompt.type, "string");
    assert.equal(properties.sources.type, "array");
    assert.equal(properties.sources.minItems, 1);
    assert.equal("operation" in properties, false);
  });
});
