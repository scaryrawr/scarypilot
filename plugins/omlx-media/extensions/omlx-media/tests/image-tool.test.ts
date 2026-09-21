import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createOmlxImageTool } from "../src/image-tool.ts";

const ToolParametersSchema = Type.Object({
  type: Type.String(),
  required: Type.Array(Type.String()),
  additionalProperties: Type.Boolean(),
  properties: Type.Object({
    prompt: Type.Object({ type: Type.String() }, { additionalProperties: true }),
    sources: Type.Object({
      type: Type.String(),
      minItems: Type.Number(),
    }, { additionalProperties: true }),
  }, { additionalProperties: true }),
}, { additionalProperties: true });

describe("omlx_image tool", () => {
  it("keeps a compact single-operation schema", () => {
    const tool = createOmlxImageTool();
    const parameters = Value.Parse(ToolParametersSchema, tool.parameters);

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
