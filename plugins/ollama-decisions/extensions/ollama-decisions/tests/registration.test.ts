import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Tool } from "@github/copilot-sdk";
import { invalidDurationNumbers, invalidDurationStrings, validDurationNumbers, validDurationStrings } from "./keep-alive-cases.ts";

test("source and shipped tools register and validate durations before fetching", async (t) => {
  t.after(() => mock.restoreAll());
  const registrations: { tools: Tool[]; requestedEnvironmentVariables: string[] }[] = [];
  const fetched: { path: string; body?: unknown }[] = [];

  const input = {
    model: "installed:latest",
    state: "Synthetic ticket",
    questions: { refund: { type: "noul", instructions: "Is a refund requested?" } },
  };

  const response = {
    model: input.model,
    answers: { refund: { type: "noul", noul: 0.75 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    fetched.push({ path, body });
    assert.ok(path === "/api/tags" || path === "/v1/systemone");

    return Response.json(path === "/api/tags"
      ? { models: [{ name: input.model, capabilities: ["decision"] }] }
      : response);
  });
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

  for (const [index, registration] of registrations.entries()) {
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

    await t.test(index === 0 ? "source rejects before fetching" : "shipped rejects before fetching", async () => {
      for (const keep_alive of [...invalidDurationStrings, ...invalidDurationNumbers]) {
        fetched.length = 0;
        const args = { ...input, keep_alive };

        const result = await handler(args, {
          sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: args,
        });

        assert.equal(fetched.length, 0, String(keep_alive));
        assert.ok(result && typeof result === "object" && "resultType" in result && "textResultForLlm" in result);
        assert.equal(result.resultType, "failure");
        assert.match(String(result.textResultForLlm), /Invalid decision request/);
      }
    });

    for (const keep_alive of [...validDurationStrings, ...validDurationNumbers]) {
      fetched.length = 0;
      const args = { ...input, keep_alive };

      assert.deepEqual(await handler(args, {
        sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: args,
      }), {
        textResultForLlm: JSON.stringify(response),
        resultType: "success",
      });
      assert.deepEqual(fetched, [
        { path: "/api/tags", body: undefined },
        { path: "/v1/systemone", body: args },
      ]);
    }
  }

});
