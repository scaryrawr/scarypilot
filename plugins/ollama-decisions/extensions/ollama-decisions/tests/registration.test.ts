import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Tool } from "@github/copilot-sdk";
import { invalidDurationNumbers, invalidDurationStrings, validDurationNumbers, validDurationStrings } from "./keep-alive-cases.ts";

test("source and shipped tools use granted configuration and validate durations before fetching", async (t) => {
  t.after(() => mock.restoreAll());
  const environment = process.env;

  const previous = {
    OLLAMA_BASE_URL: environment.OLLAMA_BASE_URL,
    OLLAMA_API_KEY: environment.OLLAMA_API_KEY,
  };

  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
  });
  const registrations: { tools: Tool[]; requestedEnvironmentVariables: string[] }[] = [];
  const fetched: { path: string; authorization?: string; body?: unknown }[] = [];
  const directory = await mkdtemp(join(tmpdir(), "ollama-decisions-registration-"));
  const imagePath = join(directory, "image.png");
  const imageBytes = Buffer.from([0, 1, 2, 255]);

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(imagePath, imageBytes);

  const input = {
    model: "installed:latest",
    state: "Synthetic ticket",
    questions: { refund: { type: "noul", instructions: "Is a refund requested?" } },
  };

  const response = {
    model: input.model,
    prompt_eval_cached_count: 0,
    answers: { refund: { type: "noul", noul: 0.75 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  const http = createServer(async (request, res) => {
    let text = "";

    for await (const chunk of request) text += chunk;
    const path = request.url ?? "";
    const body = text ? JSON.parse(text) : undefined;

    fetched.push({ path, authorization: request.headers.authorization, body });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(path === "/proxy/api/tags"
      ? { models: [{ name: input.model, capabilities: ["decision", "vision"] }] }
      : response));
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/proxy/`;
  const grants = { OLLAMA_BASE_URL: baseUrl, OLLAMA_API_KEY: "synthetic-test-key" };
  const fetch = globalThis.fetch;

  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(url)).origin, new URL(baseUrl).origin,
      "configuration granted during joinSession must route to the custom fixture, not localhost");

    return fetch(url, init);
  });
  mock.module("@github/copilot-sdk/extension", {
    namedExports: {
      joinSession: async (options: { tools: Tool[]; requestedEnvironmentVariables: string[] }) => {
        registrations.push(options);
        assert.equal(process.env, environment);
        assert.equal(environment.OLLAMA_BASE_URL, undefined);
        assert.equal(environment.OLLAMA_API_KEY, undefined);
        await Promise.resolve();

        for (const [name, value] of Object.entries(grants)) {
          if (options.requestedEnvironmentVariables.includes(name)) environment[name] = value;
        }

        return {};
      },
    },
  });

  for (const entry of ["../src/extension.ts", "../extension.mjs"]) {
    delete environment.OLLAMA_BASE_URL;
    delete environment.OLLAMA_API_KEY;
    await import(new URL(entry, import.meta.url).href);
    const registration = registrations.at(-1);
    assert.ok(registration);
    const handler = registration.tools[1].handler;
    assert.ok(handler);
    assert.deepEqual(await handler(input, {
      sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: input,
    }), {
      textResultForLlm: JSON.stringify(response),
      resultType: "success",
    }, `${entry} routes inference with configuration granted after tool creation`);
  }

  assert.equal(registrations.length, 2);

  for (const [index, registration] of registrations.entries()) {
    assert.deepEqual(Object.keys(registration).sort(), ["requestedEnvironmentVariables", "tools"]);
    assert.deepEqual(registration.requestedEnvironmentVariables, ["OLLAMA_BASE_URL", "OLLAMA_API_KEY"]);
    assert.deepEqual(registration.tools.map((tool) => tool.name), [
      "ollama_decision_models", "ollama_decide",
    ]);
    assert.ok(registration.tools[1].description?.includes("never permission"));
    assert.ok(registration.tools[1].description?.includes("images"));
    const handler = registration.tools[1].handler;
    assert.ok(handler);
    assert.deepEqual(await handler({}, {
      sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: {},
    }), {
      textResultForLlm: "Invalid decision request. Supply an explicit model, nonempty state, and 1-64 named questions with valid instructions and criteria.",
      resultType: "failure",
    });

    fetched.length = 0;
    const imageInput = { ...input, images: ["aGVsbG8=", { path: imagePath }] };

    assert.deepEqual(await handler(imageInput, {
      sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: imageInput,
    }), {
      textResultForLlm: JSON.stringify(response),
      resultType: "success",
    });
    assert.deepEqual(fetched.map(({ path, body }) => ({ path, body })), [
      { path: "/proxy/api/tags", body: undefined },
      { path: "/proxy/v1/systemone", body: { ...input, images: ["aGVsbG8=", imageBytes.toString("base64")] } },
    ], "source and bundle encode images without leaking local file paths");

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
        { path: "/proxy/api/tags", authorization: `Bearer ${grants.OLLAMA_API_KEY}`, body: undefined },
        { path: "/proxy/v1/systemone", authorization: `Bearer ${grants.OLLAMA_API_KEY}`, body: args },
      ]);
    }
  }

});
