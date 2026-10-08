import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Tool } from "@github/copilot-sdk";

test("source and shipped tools use granted configuration and enforce SystemOne inputs", async (t) => {
  t.after(() => mock.restoreAll());
  const environment = process.env;

  const previous = {
    OMLX_BASE_URL: environment.OMLX_BASE_URL,
    OMLX_API_KEY: environment.OMLX_API_KEY,
  };

  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
  });
  const registrations: { tools: Tool[]; requestedEnvironmentVariables: string[] }[] = [];
  const fetched: { path: string; authorization?: string; body?: unknown }[] = [];
  const confirmations: string[] = [];
  let approve = true;
  let pendingConfirmation: ReturnType<typeof Promise.withResolvers<boolean>> | undefined;
  let confirmationRequested: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const directory = await mkdtemp(join(tmpdir(), "omlx-decisions-registration-"));
  const imagePath = join(directory, "image.png");
  const imageBytes = Buffer.from([0, 1, 2, 255]);

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(imagePath, imageBytes);

  const input = {
    model: "installed",
    state: "Synthetic ticket",
    questions: { refund: { type: "noul", instructions: "Is a refund requested?" } },
    truncate: false,
  };

  const response = {
    model: input.model,
    answers: { refund: { type: "noul", noul: 0.75 } },
    usage: { input_tokens: 1, output_tokens: 0 },
  };

  const http = createServer(async (request, res) => {
    let text = "";

    for await (const chunk of request) text += chunk;
    const path = request.url ?? "";
    const body = text ? JSON.parse(text) : undefined;

    fetched.push({ path, authorization: request.headers.authorization, body });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(path === "/proxy/v1/models/status"
      ? { models: [{ id: input.model, model_type: "decision", engine_type: "decision", loaded: false, capabilities: [] }] }
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
  const grants = { OMLX_BASE_URL: baseUrl, OMLX_API_KEY: "synthetic-test-key" };
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
        assert.equal(environment.OMLX_BASE_URL, undefined);
        assert.equal(environment.OMLX_API_KEY, undefined);
        await Promise.resolve();

        for (const [name, value] of Object.entries(grants)) {
          if (options.requestedEnvironmentVariables.includes(name)) environment[name] = value;
        }

        return { ui: { confirm: async (message: string) => {
          confirmations.push(message);
          confirmationRequested?.resolve();

          return pendingConfirmation ? pendingConfirmation.promise : approve;
        } } };
      },
    },
  });

  for (const entry of ["../src/extension.ts", "../extension.mjs"]) {
    delete environment.OMLX_BASE_URL;
    delete environment.OMLX_API_KEY;
    await import(new URL(entry, import.meta.url).href);
    const registration = registrations.at(-1);
    assert.ok(registration);
    const handler = registration.tools[1].handler;
    assert.ok(handler);
    assert.deepEqual(await handler(input, {
      sessionId: "test", toolCallId: "test", toolName: "omlx_decide", arguments: input,
    }), {
      textResultForLlm: JSON.stringify(response),
      resultType: "success",
    }, `${entry} routes inference with configuration granted after tool creation`);
  }

  assert.equal(registrations.length, 2);

  for (const [index, registration] of registrations.entries()) {
    assert.deepEqual(Object.keys(registration).sort(), ["requestedEnvironmentVariables", "tools"]);
    assert.deepEqual(registration.requestedEnvironmentVariables, ["OMLX_BASE_URL", "OMLX_API_KEY"]);
    assert.deepEqual(registration.tools.map((tool) => tool.name), [
      "omlx_decision_models", "omlx_decide",
    ]);
    assert.ok(registration.tools[1].description?.includes("never permission"));
    assert.ok(registration.tools[1].description?.includes("images"));
    const handler = registration.tools[1].handler;
    assert.ok(handler);
    assert.deepEqual(await handler({}, {
      sessionId: "test", toolCallId: "test", toolName: "omlx_decide", arguments: {},
    }), {
      textResultForLlm: "Invalid decision request. Supply an explicit model, nonempty state, and named questions with valid instructions and criteria.",
      resultType: "failure",
    });

    fetched.length = 0;
    const imageInput = { ...input, images: ["aGVsbG8=", { path: imagePath }] };

    assert.deepEqual(await handler(imageInput, {
      sessionId: "test", toolCallId: "test", toolName: "omlx_decide", arguments: imageInput,
    }), {
      textResultForLlm: JSON.stringify(response),
      resultType: "success",
    });
    assert.deepEqual(fetched.map(({ path, body }) => ({ path, body })), [
      { path: "/proxy/v1/models/status", body: undefined },
      { path: "/proxy/v1/systemone", body: { ...input, images: ["data:image/png;base64,aGVsbG8=", `data:image/png;base64,${imageBytes.toString("base64")}`] } },
    ], "source and bundle encode images without leaking local file paths");
    assert.equal(confirmations.at(-1),
      `Allow reading local file ${JSON.stringify(await realpath(imagePath))} and transmitting its complete contents as an image to ${JSON.stringify(`${baseUrl}v1/systemone`)} for this decision request? Only approve a file you intend to share.`);

    approve = false;
    fetched.length = 0;

    const denied = await handler(imageInput, {
      sessionId: "test", toolCallId: "test", toolName: "omlx_decide", arguments: imageInput,
    });

    assert.ok(denied && typeof denied === "object" && "resultType" in denied && "textResultForLlm" in denied);
    assert.equal(denied.resultType, "failure");
    assert.match(String(denied.textResultForLlm), /not approved/);
    assert.deepEqual(fetched.map(({ path }) => path), ["/proxy/v1/models/status"]);
    approve = true;

    pendingConfirmation = Promise.withResolvers<boolean>();
    confirmationRequested = Promise.withResolvers<void>();
    fetched.length = 0;
    const controller = new AbortController();

    const pending = handler(imageInput, {
      sessionId: "test", toolCallId: "test", toolName: "omlx_decide", arguments: imageInput, signal: controller.signal,
    });

    const settled = Promise.resolve(pending).then((result) => {
      assert.ok(result && typeof result === "object" && "resultType" in result && "textResultForLlm" in result);
      assert.equal(result.resultType, "failure");
      assert.match(String(result.textResultForLlm), /cancelled/);
    });

    await confirmationRequested.promise;
    controller.abort();
    await settled;
    pendingConfirmation.resolve(true);
    pendingConfirmation = undefined;
    confirmationRequested = undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(fetched.map(({ path }) => path), ["/proxy/v1/models/status"], "late approval cannot send an image");

    await t.test(index === 0 ? "source rejects before fetching" : "shipped rejects before fetching", async () => {
      for (const invalid of [{ keep_alive: 0 }, { keep_alive: "5m" }, { truncate: "false" }]) {
        fetched.length = 0;
        const args = { ...input, ...invalid };

        const result = await handler(args, {
          sessionId: "test", toolCallId: "test", toolName: "omlx_decide", arguments: args,
        });

        assert.equal(fetched.length, 0, JSON.stringify(invalid));
        assert.ok(result && typeof result === "object" && "resultType" in result && "textResultForLlm" in result);
        assert.equal(result.resultType, "failure");
        assert.match(String(result.textResultForLlm), /Invalid decision request/);
      }
    });

    for (const truncate of [false, true]) {
      fetched.length = 0;
      const args = { ...input, truncate };

      assert.deepEqual(await handler(args, {
        sessionId: "test", toolCallId: "test", toolName: "omlx_decide", arguments: args,
      }), {
        textResultForLlm: JSON.stringify(response),
        resultType: "success",
      });
      assert.deepEqual(fetched, [
        { path: "/proxy/v1/models/status", authorization: `Bearer ${grants.OMLX_API_KEY}`, body: undefined },
        { path: "/proxy/v1/systemone", authorization: `Bearer ${grants.OMLX_API_KEY}`, body: args },
      ]);
    }
  }

});
