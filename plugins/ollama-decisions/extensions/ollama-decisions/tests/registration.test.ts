import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Tool } from "@github/copilot-sdk";

test("source and shipped entry point register only two tools and request optional API key access", async () => {
  const registrations: { tools: Tool[]; requestedEnvironmentVariables: string[] }[] = [];
  mock.module("@github/copilot-sdk/extension", {
    namedExports: {
      joinSession: async (options: { tools: Tool[]; requestedEnvironmentVariables: string[] }) => {
        registrations.push(options);

        return {};
      },
    },
  });
  await import("../src/extension.ts");
  await import(new URL("../extension.mjs", import.meta.url).href);
  assert.equal(registrations.length, 2);

  for (const registration of registrations) {
    assert.deepEqual(Object.keys(registration).sort(), ["requestedEnvironmentVariables", "tools"]);
    assert.deepEqual(registration.requestedEnvironmentVariables, ["OLLAMA_API_KEY"]);
    assert.deepEqual(registration.tools.map((tool) => tool.name), [
      "ollama_decision_models", "ollama_decide",
    ]);
    assert.ok(registration.tools[1].description?.includes("never permission"));
    const handler = registration.tools[1].handler;
    assert.ok(handler);
    assert.deepEqual(await handler({}, {
      sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: {},
    }), {
      textResultForLlm: "Invalid decision request. Supply an explicit model, nonempty state, and 1-64 named questions with valid instructions and criteria.",
      resultType: "failure",
    });
  }

  mock.restoreAll();
});
