import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { DecisionClient, createDecisionTools } from "../src/decisions.ts";
import { DecisionRequestSchema, DecisionResponseSchema, type DecisionRequest, type Question } from "../src/schemas.ts";

type ObservedRequest = { path: string; method: string; authorization?: string; body?: unknown };

type Route = (request: ObservedRequest, response: ServerResponse) => void;

async function server(t: TestContext, route: Route) {
  const requests: ObservedRequest[] = [];

  const http = createServer(async (request, response) => {
    let text = "";

    for await (const chunk of request) text += chunk;

    const observed: ObservedRequest = {
      path: request.url ?? "",
      method: request.method ?? "",
      authorization: request.headers.authorization,
    };

    if (text) observed.body = JSON.parse(text);
    requests.push(observed);
    route(observed, response);
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address === "object");

  return { requests, url: `http://127.0.0.1:${address.port}` };
}

function json<T>(response: ServerResponse, payload: T) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

const request = {
  model: "installed:latest",
  state: { ticket: "A public synthetic ticket about a duplicate charge.", history: [true, null, 42] },
  questions: {
    category: {
      type: "choice",
      instructions: "Classify the ticket.",
      criteria: { billing: "Payments", other: null },
    },
    refund: {
      type: "noul",
      instructions: "Is a refund requested?",
      criteria: { true: "A refund is requested" },
    },
    urgency: {
      type: "score",
      instructions: "Rate urgency.",
      criteria: ["Routine", "Soon", "Immediate"],
    },
  },
  keep_alive: "5m",
} satisfies DecisionRequest;

const response = {
  model: "installed:latest",
  answers: {
    category: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.8, other: 0.2 },
      confidence: 0.28,
    },
    refund: { type: "noul", noul: 0.75 },
    urgency: {
      type: "score",
      score: 1.6,
      legend: { "0": "Routine", "1": "Soon", "2": "Immediate" },
      probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
      confidence: 0.3,
    },
  },
  usage: { input_tokens: 174, output_tokens: 3 },
};

const installed = { models: [{ name: "installed:latest", capabilities: ["decision"] }] };

test("discovery filters capabilities without model-name heuristics and posts show only for missing metadata", async (t) => {
  const http = await server(t, (req, res) => {
    if (req.path === "/proxy/api/tags") {
      json(res, { models: [
        { name: "ordinary-name:latest", capabilities: ["decision", "completion"] },
        { name: "nimble:latest", capabilities: ["completion"] },
        { name: "unresolved:latest" },
        { name: "empty:latest", capabilities: [] },
      ] });
    } else {
      assert.equal(req.path, "/proxy/api/show");
      assert.deepEqual(req.body, { model: "unresolved:latest" });
      json(res, { capabilities: ["decision"] });
    }
  });

  const client = new DecisionClient({ environment: {
    OLLAMA_BASE_URL: `${http.url}/proxy/`,
    OLLAMA_API_KEY: "synthetic-test-key",
  } });

  assert.deepEqual(await client.discover(), { models: [
    { name: "ordinary-name:latest", capabilities: ["decision", "completion"] },
    { name: "unresolved:latest", capabilities: ["decision"] },
  ] });
  assert.deepEqual(http.requests.map((req) => [req.method, req.path, req.authorization]), [
    ["GET", "/proxy/api/tags", "Bearer synthetic-test-key"],
    ["POST", "/proxy/api/show", "Bearer synthetic-test-key"],
  ]);
  await client.discover();
  assert.equal(http.requests.length, 4, "each invocation refreshes installed metadata");
});

test("empty installed inventory is a valid discovery, not a default model", async (t) => {
  const http = await server(t, (_, res) => json(res, { models: [] }));
  const client = new DecisionClient({ environment: { OLLAMA_BASE_URL: http.url } });
  assert.deepEqual(await client.discover(), { models: [] });
  await assert.rejects(client.decide(request), /not installed/);
  assert.deepEqual(http.requests.map((req) => req.path), ["/api/tags", "/api/tags"]);
});

test("all question types preserve wire data and unnormalized score with one inference", async (t) => {
  const http = await server(t, (req, res) => {
    if (req.path === "/api/tags") json(res, installed);
    else {
      assert.equal(req.path, "/v1/systemone");
      assert.equal(req.method, "POST");
      assert.deepEqual(req.body, request);
      json(res, response);
    }
  });

  const client = new DecisionClient({ environment: { OLLAMA_BASE_URL: http.url } });
  assert.deepEqual(await client.decide(request), response);
  assert.equal(http.requests.length, 2);
  assert.ok(http.requests.every((req) => req.authorization === undefined));
});

test("inference and metadata carry bearer auth, JSON headers, and caller state without extra fields", async (t) => {
  const expected = { ...request, state: ["synthetic public input", { nested: [false, null, 1] }], keep_alive: 0 } satisfies DecisionRequest;

  const http = await server(t, (req, res) => {
    assert.equal(req.authorization, "Bearer synthetic-inference-key");

    if (req.path === "/api/tags") json(res, installed);
    else {
      assert.deepEqual(req.body, expected);
      json(res, response);
    }
  });

  const client = new DecisionClient({
    environment: { OLLAMA_BASE_URL: http.url, OLLAMA_API_KEY: "synthetic-inference-key" },
    fetch: (url, init) => {
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("Accept"), "application/json");

      if (init?.method === "POST") {
        assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
      }

      return fetch(url, init);
    },
  });

  assert.deepEqual(await client.decide(expected), response);
  assert.equal(http.requests.length, 2);
});

test("text-only request size uses serialized UTF-8 bytes and accepts exactly 64 KiB", async (t) => {
  const base = { model: "installed:latest", state: "", questions: { refund: request.questions.refund } } satisfies DecisionRequest;
  const padding = 65536 - Buffer.byteLength(JSON.stringify(base), "utf8");
  const exact = { ...base, state: "a".repeat(padding) } satisfies DecisionRequest;
  const expected = { ...response, answers: { refund: response.answers.refund } };

  const http = await server(t, (req, res) => {
    if (req.path === "/api/tags") json(res, installed);
    else {
      assert.equal(Buffer.byteLength(JSON.stringify(req.body), "utf8"), 65536);
      json(res, expected);
    }
  });

  const client = new DecisionClient({ environment: { OLLAMA_BASE_URL: http.url } });

  assert.deepEqual(await client.decide(exact), expected);
  await assert.rejects(client.decide({ ...exact, state: `${exact.state}a` }), /64 KiB/);
  await assert.rejects(client.decide({ ...base, state: "\u00e9".repeat(padding) }), /64 KiB/);
  assert.deepEqual(http.requests.map((req) => req.path), [
    "/api/tags", "/v1/systemone", "/api/tags", "/api/tags",
  ]);
});

test("implicit latest resolves only an untagged installed alias, preferring an exact name", async (t) => {
  const http = await server(t, (req, res) => {
    if (req.path === "/api/tags") json(res, installed);
    else {
      assert.deepEqual(req.body, request);
      json(res, response);
    }
  });

  const client = new DecisionClient({ environment: { OLLAMA_BASE_URL: http.url } });
  assert.deepEqual(await client.decide({ ...request, model: "installed" }), response);
  await assert.rejects(client.decide({ ...request, model: "installed:missing" }), /not installed/);
  assert.equal(http.requests.filter((req) => req.path === "/v1/systemone").length, 1);

  const exact = await server(t, (req, res) => {
    if (req.path === "/api/tags") json(res, { models: [
      { name: "installed", capabilities: ["decision"] },
      ...installed.models,
    ] });
    else {
      assert.deepEqual(req.body, { ...request, model: "installed" });
      json(res, { ...response, model: "installed" });
    }
  });

  assert.equal((await new DecisionClient({
    environment: { OLLAMA_BASE_URL: exact.url },
  }).decide({ ...request, model: "installed" })).model, "installed");
});

test("explicit unsupported model never falls back to another decision model", async (t) => {
  const http = await server(t, (_, res) => json(res, { models: [
    ...installed.models,
    { name: "nimble:other", capabilities: ["completion"] },
  ] }));

  const client = new DecisionClient({ environment: { OLLAMA_BASE_URL: http.url } });
  await assert.rejects(client.decide({ ...request, model: "nimble:other" }), /does not advertise/);
  assert.deepEqual(http.requests.map((req) => req.path), ["/api/tags"]);
});

test("decide uses show fallback only for its requested model", async (t) => {
  const http = await server(t, (req, res) => {
    if (req.path === "/api/tags") json(res, { models: [
      { name: "unrelated:latest" }, { name: "installed:latest" },
    ] });
    else if (req.path === "/api/show") {
      assert.deepEqual(req.body, { model: "installed:latest" });
      json(res, { capabilities: ["decision"] });
    } else json(res, response);
  });

  assert.deepEqual(await new DecisionClient({
    environment: { OLLAMA_BASE_URL: http.url },
  }).decide(request), response);
  assert.deepEqual(http.requests.map((req) => req.path), ["/api/tags", "/api/show", "/v1/systemone"]);
});

for (const [label, payload] of [
  ["missing models", {}],
  ["null capabilities", { models: [{ name: "installed", capabilities: null }] }],
  ["wrong capability type", { models: [{ name: "installed", capabilities: [42] }] }],
  ["missing name", { models: [{ model: "installed", capabilities: ["decision"] }] }],
  ["duplicate names", { models: [...installed.models, ...installed.models] }],
]) {
  test(`discovery rejects ${label} rather than skipping failed metadata`, async (t) => {
    const http = await server(t, (_, res) => json(res, payload));
    await assert.rejects(new DecisionClient({
      environment: { OLLAMA_BASE_URL: http.url },
    }).discover(), /metadata|duplicate/);
  });
}

for (const payload of [{}, { capabilities: null }, { capabilities: "decision" }]) {
  test(`show metadata must resolve capabilities (${JSON.stringify(payload)})`, async (t) => {
    const http = await server(t, (req, res) => json(res,
      req.path === "/api/tags" ? { models: [{ name: "installed" }] } : payload));

    await assert.rejects(new DecisionClient({
      environment: { OLLAMA_BASE_URL: http.url },
    }).discover(), /unresolved/);
  });
}

for (const endpoint of ["/api/tags", "/api/show", "/v1/systemone"]) {
  for (const status of [401, 404, 500]) {
    test(`${endpoint} HTTP ${status} is explicit, redacted, and never retried`, async (t) => {
      const http = await server(t, (req, res) => {
        if (req.path === endpoint) {
          res.statusCode = status;
          json(res, { error: "synthetic-secret-state synthetic-api-key" });
        } else if (req.path === "/api/tags") {
          json(res, { models: [{ name: "installed:latest" }] });
        } else json(res, { capabilities: ["decision"] });
      });

      const tools = createDecisionTools(new DecisionClient({
        environment: { OLLAMA_BASE_URL: http.url, OLLAMA_API_KEY: "synthetic-api-key" },
      }));

      const result = await tools[1].handler({ ...request, state: "synthetic-secret-state" }, {
        sessionId: "test", toolCallId: "test", toolName: tools[1].name, arguments: request,
      });

      assert.ok(result && typeof result === "object" && "resultType" in result && "textResultForLlm" in result);
      assert.equal(result.resultType, "failure");
      assert.match(String(result.textResultForLlm), new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(String(result.textResultForLlm), /synthetic-secret-state|synthetic-api-key/);
      assert.equal(http.requests.filter((req) => req.path === endpoint).length, 1);
    });
  }

  test(`${endpoint} malformed JSON fails`, async (t) => {
    const http = await server(t, (req, res) => {
      if (req.path === endpoint) res.end("{broken");
      else if (req.path === "/api/tags") json(res, { models: [{ name: "installed:latest" }] });
      else json(res, { capabilities: ["decision"] });
    });

    await assert.rejects(new DecisionClient({
      environment: { OLLAMA_BASE_URL: http.url },
    }).decide(request), /malformed JSON/);
  });

  test(`${endpoint} invalid UTF-8 fails instead of replacing corrupted text`, async (t) => {
    const http = await server(t, (req, res) => {
      if (req.path === endpoint) {
        const payload = endpoint === "/api/tags"
          ? { models: [{ name: "corrupted", capabilities: ["decision"] }] }
          : endpoint === "/api/show"
            ? { capabilities: ["corrupted"] }
            : { ...response, model: "corrupted" };

        const bytes = Buffer.from(JSON.stringify(payload));

        bytes[bytes.indexOf("corrupted")] = 0xff;
        res.end(bytes);
      } else if (req.path === "/api/tags") json(res, { models: [{ name: "installed:latest" }] });
      else json(res, { capabilities: ["decision"] });
    });

    await assert.rejects(new DecisionClient({
      environment: { OLLAMA_BASE_URL: http.url },
    }).decide(request), /malformed JSON/);
  });
}

for (const hostname of ["remote.example", "localhost.example", "127.0.0.1.example", "[2001:db8::1]"]) {
  test(`authenticated remote HTTP rejects ${hostname} before network`, async () => {
    const client = new DecisionClient({
      environment: { OLLAMA_BASE_URL: `http://${hostname}:11434`, OLLAMA_API_KEY: "synthetic-secret-key" },
      fetch: async () => { assert.fail("credentials must not cross remote HTTP"); },
    });

    await assert.rejects(client.discover(), /HTTPS/);
    await assert.rejects(client.decide(request), /HTTPS/);
  });
}

for (const baseUrl of [
  "http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434", "https://remote.example",
]) {
  test(`authenticated endpoint permits ${baseUrl}`, async () => {
    let calls = 0;

    const client = new DecisionClient({
      environment: { OLLAMA_BASE_URL: baseUrl, OLLAMA_API_KEY: "synthetic-secret-key" },
      fetch: async (url, init) => {
        calls++;
        assert.equal(String(url), `${baseUrl}/api/tags`);
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-secret-key");

        return Response.json(installed);
      },
    });

    assert.deepEqual(await client.discover(), installed);
    assert.equal(calls, 1);
  });
}

test("redirects never forward credentials or request state", async (t) => {
  const destination = await server(t, (_, res) => json(res, installed));

  const origin = await server(t, (_, res) => {
    res.writeHead(307, { Location: destination.url });
    res.end();
  });

  await assert.rejects(new DecisionClient({
    environment: { OLLAMA_BASE_URL: origin.url, OLLAMA_API_KEY: "synthetic-key" },
  }).decide(request), /Redirects are not allowed/);
  assert.equal(destination.requests.length, 0);
});

test("unavailable network errors are redacted failures", async () => {
  const tools = createDecisionTools(new DecisionClient({
    environment: { OLLAMA_API_KEY: "synthetic-network-key" },
    fetch: async () => { throw new Error("synthetic-network-key synthetic-private-state"); },
  }));

  const result = await tools[1].handler({ ...request, state: "synthetic-private-state" }, {
    sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: request,
  });

  assert.equal(result.resultType, "failure");
  assert.match(result.textResultForLlm, /could not be reached/);
  assert.doesNotMatch(result.textResultForLlm, /synthetic-network-key|synthetic-private-state/);
});

for (const url of [
  "", "not a URL", "file:///path", "ftp://localhost", "http://user:password@localhost",
  "http://localhost?key=value", "http://localhost#part", "http://localhost?", "http://localhost#",
]) {
  test(`invalid base URL rejected before network (${url})`, async () => {
    const client = new DecisionClient({
      environment: { OLLAMA_BASE_URL: url },
      fetch: async () => { assert.fail("invalid config must not fetch"); },
    });

    await assert.rejects(client.discover(), /OLLAMA_BASE_URL/);
  });
}

test("default configuration uses localhost and no key", async () => {
  const client = new DecisionClient({
    environment: {},
    fetch: async (input, init) => {
      assert.equal(String(input), "http://localhost:11434/api/tags");
      assert.equal(new Headers(init?.headers).get("Authorization"), null);

      return Response.json({ models: [] });
    },
  });

  assert.deepEqual(await client.discover(), { models: [] });
});

test("invalid header configuration is redacted", async () => {
  await assert.rejects(new DecisionClient({
    environment: { OLLAMA_API_KEY: "secret\r\nother" },
    fetch: async () => { assert.fail("invalid config must not fetch"); },
  }).discover(), /must not contain line breaks/);
});

const invalidRequests: [string, unknown][] = [
  ["missing model", { ...request, model: undefined }],
  ["empty model", { ...request, model: " " }],
  ["null state", { ...request, state: null }],
  ["boolean state", { ...request, state: true }],
  ["numeric state", { ...request, state: 4 }],
  ["empty state", { ...request, state: " \n" }],
  ["nonfinite state", { ...request, state: { bad: Infinity } }],
  ["zero questions", { ...request, questions: {} }],
  ["65 questions", { ...request, questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), request.questions.refund])) }],
  ["blank question name", { ...request, questions: { " ": request.questions.refund } }],
  ["wrong type", { ...request, questions: { q: { type: "boolean", instructions: "Test" } } }],
  ["empty instructions", { ...request, questions: { q: { type: "noul", instructions: "" } } }],
  ["missing instructions", { ...request, questions: { q: { type: "noul" } } }],
  ["object instructions", { ...request, questions: { q: { type: "noul", instructions: {} } } }],
  ["one choice", { ...request, questions: { q: { ...request.questions.category, criteria: { a: null } } } }],
  ["27 choices", { ...request, questions: { q: { ...request.questions.category, criteria: Object.fromEntries(Array.from({ length: 27 }, (_, i) => [String(i), null])) } } }],
  ["blank choice key", { ...request, questions: { q: { ...request.questions.category, criteria: { a: null, " ": "blank" } } } }],
  ["numeric choice description", { ...request, questions: { q: { ...request.questions.category, criteria: { a: null, b: 1 } } } }],
  ["noul unknown key", { ...request, questions: { q: { ...request.questions.refund, criteria: { yes: "yes" } } } }],
  ["noul null description", { ...request, questions: { q: { ...request.questions.refund, criteria: { true: null } } } }],
  ["noul array criteria", { ...request, questions: { q: { ...request.questions.refund, criteria: [] } } }],
  ["score object criteria", { ...request, questions: { q: { ...request.questions.urgency, criteria: { a: "A", b: "B" } } } }],
  ["one score level", { ...request, questions: { q: { ...request.questions.urgency, criteria: ["one"] } } }],
  ["27 score levels", { ...request, questions: { q: { ...request.questions.urgency, criteria: Array(27).fill("level") } } }],
  ["null score level", { ...request, questions: { q: { ...request.questions.urgency, criteria: ["one", null] } } }],
  ["invented request field", { ...request, stream: false }],
  ["invented question field", { ...request, questions: { q: { ...request.questions.refund, confidence: 0.5 } } }],
  ["boolean keep alive", { ...request, keep_alive: false }],
  ["nonfinite keep alive", { ...request, keep_alive: NaN }],
];

for (const [label, input] of invalidRequests) {
  test(`invalid request rejects ${label} without fetching`, async () => {
    let fetches = 0;

    const tools = createDecisionTools(new DecisionClient({
      fetch: async () => {
        fetches++;
        assert.fail("invalid request must not fetch");
      },
    }));

    const result = await tools[1].handler(input, {
      sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: input,
    });

    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /Invalid decision request/);
    assert.equal(fetches, 0);
  });
}

for (const endpoint of ["/api/tags", "/api/show", "/v1/systemone"]) {
  for (const declared of [true, false]) {
    test(`${endpoint} rejects ${declared ? "declared" : "chunked"} response over 4 MiB and closes the stream`, { timeout: 5_000 }, async (t) => {
      const closed = Promise.withResolvers<void>();
      const sensitive = "synthetic-sensitive-response";

      const http = await server(t, (req, res) => {
        if (req.path === endpoint) {
          res.once("close", () => closed.resolve());

          if (declared) res.setHeader("Content-Length", String(4 * 1024 * 1024 + 1));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write(declared ? sensitive : sensitive.padEnd(4 * 1024 * 1024 + 1, " "));
        } else if (req.path === "/api/tags") {
          json(res, { models: [{ name: "installed:latest" }] });
        } else json(res, { capabilities: ["decision"] });
      });

      const tools = createDecisionTools(new DecisionClient({
        environment: { OLLAMA_BASE_URL: http.url },
        metadataTimeoutMs: 1_000,
        inferenceTimeoutMs: 1_000,
      }));

      const result = await tools[1].handler(request, {
        sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: request,
      });

      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, /response exceeds.*4 MiB/);
      assert.doesNotMatch(result.textResultForLlm, new RegExp(sensitive));
      await closed.promise;
      assert.equal(http.requests.filter((req) => req.path === endpoint).length, 1);
    });
  }
}

test("chunked response limit counts UTF-8 bytes, not characters", async (t) => {
  const body = `"${"\u00e9".repeat(2 * 1024 * 1024)}"`;
  assert.equal(Buffer.byteLength(body, "utf8"), 4 * 1024 * 1024 + 2);

  const http = await server(t, (_, res) => {
    res.write(body.slice(0, 1024));
    res.end(body.slice(1024));
  });

  await assert.rejects(new DecisionClient({
    environment: { OLLAMA_BASE_URL: http.url },
  }).discover(), /response exceeds.*4 MiB/);
});

for (const declared of [true, false]) {
  test(`accepts ${declared ? "declared" : "chunked"} JSON response of exactly 4 MiB`, async (t) => {
    const serialized = JSON.stringify(response);
    const body = `${serialized}${" ".repeat(4 * 1024 * 1024 - Buffer.byteLength(serialized, "utf8"))}`;

    const http = await server(t, (req, res) => {
      if (req.path === "/api/tags") json(res, installed);
      else {
        if (declared) res.setHeader("Content-Length", String(Buffer.byteLength(body, "utf8")));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(body.slice(0, 1024));
        res.end(body.slice(1024));
      }
    });

    assert.deepEqual(await new DecisionClient({
      environment: { OLLAMA_BASE_URL: http.url },
    }).decide(request), response);
  });
}

test("schema accepts exact limits, JSON arrays, null choice descriptions, and partial noul criteria", () => {
  for (const criteria of [undefined, {}, { true: "Yes" }, { false: "No" }, { true: "", false: "" }]) {
    const question: Question = {
      type: "noul", instructions: "Decide",
    };

    if (criteria !== undefined) question.criteria = criteria;
    assert.ok(Value.Check(DecisionRequestSchema, {
      model: "installed",
      state: ["public", { nested: [true, null, 1] }],
      questions: { q: question },
      keep_alive: -1,
    }));
  }

  const choice = { ...request.questions.category, criteria: Object.fromEntries(Array.from({ length: 26 }, (_, i) => [String(i), null])) };
  assert.ok(Value.Check(DecisionRequestSchema, {
    ...request, questions: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [String(i), choice])),
  }));
  assert.ok(Value.Check(DecisionRequestSchema, {
    ...request, questions: { q: { ...request.questions.urgency, criteria: Array(26).fill("level") } },
  }));
});

const invalidResponses: [string, unknown][] = [
  ["wrong model", { ...response, model: "other" }],
  ["missing answer", { ...response, answers: { category: response.answers.category } }],
  ["extra answer", { ...response, answers: { ...response.answers, extra: response.answers.refund } }],
  ["wrong answer type", { ...response, answers: { ...response.answers, category: response.answers.refund } }],
  ["invalid choice", { ...response, answers: { ...response.answers, category: { ...response.answers.category, choice: "missing" } } }],
  ["probability missing key", { ...response, answers: { ...response.answers, category: { ...response.answers.category, probabilities: { billing: 1 } } } }],
  ["probability extra key", { ...response, answers: { ...response.answers, category: { ...response.answers.category, probabilities: { billing: 0.5, other: 0.4, extra: 0.1 } } } }],
  ["probability above one", { ...response, answers: { ...response.answers, category: { ...response.answers.category, probabilities: { billing: 1.2, other: 0 } } } }],
  ["negative probability", { ...response, answers: { ...response.answers, category: { ...response.answers.category, probabilities: { billing: 1, other: -0.1 } } } }],
  ["probability sum", { ...response, answers: { ...response.answers, category: { ...response.answers.category, probabilities: { billing: 0.1, other: 0.1 } } } }],
  ["negative confidence", { ...response, answers: { ...response.answers, category: { ...response.answers.category, confidence: -0.1 } } }],
  ["confidence above one", { ...response, answers: { ...response.answers, urgency: { ...response.answers.urgency, confidence: 1.1 } } }],
  ["boolean noul", { ...response, answers: { ...response.answers, refund: { type: "noul", noul: true } } }],
  ["noul out of range", { ...response, answers: { ...response.answers, refund: { type: "noul", noul: 1.1 } } }],
  ["invented noul confidence", { ...response, answers: { ...response.answers, refund: { ...response.answers.refund, confidence: 0.4 } } }],
  ["negative score", { ...response, answers: { ...response.answers, urgency: { ...response.answers.urgency, score: -1 } } }],
  ["score beyond rubric", { ...response, answers: { ...response.answers, urgency: { ...response.answers.urgency, score: 2.1 } } }],
  ["normalized score", { ...response, answers: { ...response.answers, urgency: { ...response.answers.urgency, score: 0.8 } } }],
  ["wrong legend text", { ...response, answers: { ...response.answers, urgency: { ...response.answers.urgency, legend: { "0": "Wrong", "1": "Soon", "2": "Immediate" } } } }],
  ["wrong legend keys", { ...response, answers: { ...response.answers, urgency: { ...response.answers.urgency, legend: { "1": "Routine", "2": "Soon", "3": "Immediate" } } } }],
  ["wrong score probabilities", { ...response, answers: { ...response.answers, urgency: { ...response.answers.urgency, probabilities: { low: 0.1, mid: 0.2, high: 0.7 } } } }],
  ["fractional input usage", { ...response, usage: { input_tokens: 1.2, output_tokens: 1 } }],
  ["negative output usage", { ...response, usage: { input_tokens: 1, output_tokens: -1 } }],
  ["missing usage", { model: response.model, answers: response.answers }],
  ["invented usage", { ...response, usage: { ...response.usage, total_tokens: 177 } }],
];

for (const [label, payload] of invalidResponses) {
  test(`invalid response rejects ${label}`, async (t) => {
    const http = await server(t, (req, res) => json(res, req.path === "/api/tags" ? installed : payload));
    await assert.rejects(new DecisionClient({
      environment: { OLLAMA_BASE_URL: http.url },
    }).decide(request), /response|answer|Choice|Score|probabilities/i);
    assert.equal(http.requests.length, 2);
  });
}

test("schema rejects nonfinite response numbers", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(Value.Check(DecisionResponseSchema, {
      ...response, answers: { ...response.answers, category: { ...response.answers.category, confidence: value } },
    }), false);
    assert.equal(Value.Check(DecisionResponseSchema, {
      ...response, usage: { input_tokens: value, output_tokens: 1 },
    }), false);
  }
});

for (const phase of ["metadata", "inference", "body"] as const) {
  test(`${phase} timeout aborts the HTTP operation with no retries`, async (t) => {
    const http = await server(t, (req, res) => {
      if (phase === "metadata") return;

      if (req.path === "/api/tags") json(res, installed);
      else if (phase === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write("{");
      }
    });

    const client = new DecisionClient({
      environment: { OLLAMA_BASE_URL: http.url },
      metadataTimeoutMs: 80,
      inferenceTimeoutMs: 80,
    });

    await assert.rejects(client.decide(request), /timed out/);
    assert.equal(http.requests.length, phase === "metadata" ? 1 : 2);
  });
}

for (const endpoint of ["/api/tags", "/api/show", "/v1/systemone"]) {
  for (const cancel of [false, true]) {
    test(`${endpoint} stalled response body ${cancel ? "cancels" : "times out"} and closes the stream`, { timeout: 5_000 }, async (t) => {
      const controller = new AbortController();
      const closed = Promise.withResolvers<void>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      t.after(() => clearTimeout(timer));

      const http = await server(t, (req, res) => {
        if (req.path === endpoint) {
          res.once("close", () => closed.resolve());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write("{");
        } else if (req.path === "/api/tags") {
          json(res, { models: [{ name: "installed:latest" }] });
        } else json(res, { capabilities: ["decision"] });
      });

      const tools = createDecisionTools(new DecisionClient({
        environment: { OLLAMA_BASE_URL: http.url },
        metadataTimeoutMs: 100,
        inferenceTimeoutMs: 100,
        fetch: async (url, init) => {
          const reply = await fetch(url, init);

          if (cancel && String(url) === `${http.url}${endpoint}`) {
            timer = setTimeout(() => controller.abort(new Error("synthetic-sensitive-reason")), 20);
          }

          return reply;
        },
      }));

      const result = await tools[1].handler(request, {
        sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: request, signal: controller.signal,
      });

      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, cancel ? /cancelled/ : /timed out/);
      assert.doesNotMatch(result.textResultForLlm, /synthetic-sensitive-reason/);
      await closed.promise;
      assert.equal(http.requests.filter((req) => req.path === endpoint).length, 1);
    });
  }
}

test("host cancellation reaches the tool's active inference request", async (t) => {
  const controller = new AbortController();

  const http = await server(t, (req, res) => {
    if (req.path === "/api/tags") json(res, installed);
    else controller.abort(new Error("synthetic-sensitive-cancel-reason"));
  });

  const tools = createDecisionTools(new DecisionClient({ environment: { OLLAMA_BASE_URL: http.url } }));

  const result = await tools[1].handler(request, {
    sessionId: "test", toolCallId: "test", toolName: tools[1].name, arguments: request, signal: controller.signal,
  });

  assert.ok(result && typeof result === "object" && "resultType" in result && "textResultForLlm" in result);
  assert.equal(result.resultType, "failure");
  assert.match(String(result.textResultForLlm), /cancelled/);
  assert.doesNotMatch(String(result.textResultForLlm), /sensitive/);
  assert.equal(http.requests.length, 2);
});

test("discovery host cancellation stops serial show requests", async (t) => {
  const controller = new AbortController();

  const http = await server(t, (req, res) => {
    if (req.path === "/api/tags") json(res, { models: [{ name: "first" }, { name: "second" }] });
    else controller.abort();
  });

  await assert.rejects(new DecisionClient({
    environment: { OLLAMA_BASE_URL: http.url },
  }).discover(controller.signal), /cancelled/);
  assert.equal(http.requests.length, 2);
});

test("discovery has a single metadata deadline across serial lookups", async (t) => {
  const timers: ReturnType<typeof setTimeout>[] = [];

  t.after(() => timers.forEach(clearTimeout));

  const http = await server(t, (req, res) => {
    if (req.path === "/api/tags") {
      json(res, { models: [{ name: "first" }, { name: "second" }] });
    } else {
      timers.push(setTimeout(() => json(res, { capabilities: ["decision"] }), 70));
    }
  });

  await assert.rejects(new DecisionClient({
    environment: { OLLAMA_BASE_URL: http.url },
    metadataTimeoutMs: 120,
  }).discover(), /timed out/);
  assert.deepEqual(http.requests.map((req) => req.body), [
    undefined, { model: "first" }, { model: "second" },
  ]);
});

test("pre-cancelled request sends no HTTP traffic", async (t) => {
  const http = await server(t, (_, res) => json(res, installed));
  await assert.rejects(new DecisionClient({
    environment: { OLLAMA_BASE_URL: http.url },
  }).decide(request, AbortSignal.abort()), /cancelled/);
  assert.equal(http.requests.length, 0);
});

test("tool returns exact data and rejects discovery arguments", async (t) => {
  const http = await server(t, (req, res) => json(res, req.path === "/api/tags" ? installed : response));
  const tools = createDecisionTools(new DecisionClient({ environment: { OLLAMA_BASE_URL: http.url } }));
  const invocation = { sessionId: "test", toolCallId: "test", toolName: "ollama_decide", arguments: request };
  assert.deepEqual(await tools[1].handler(request, invocation), {
    textResultForLlm: JSON.stringify(response), resultType: "success",
  });
  assert.deepEqual(await tools[0].handler({ model: "not allowed" }, invocation), {
    textResultForLlm: "Discovery takes an empty object.", resultType: "failure",
  });
});
