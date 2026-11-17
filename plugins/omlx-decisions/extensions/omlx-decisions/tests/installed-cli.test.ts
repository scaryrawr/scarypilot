import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pluginRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("installed copy runs with Node alone, no SDK, sources, npm, or workspace-relative paths", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "decision installed with spaces "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = path.join(directory, "plugin with spaces");

  await cp(pluginRoot, installed, {
    recursive: true,
    filter: (file) => !["node_modules", "src", "tests"].includes(path.basename(file)),
  });
  const extension = path.join(installed, "extensions", "omlx-decisions");
  assert.ok(!(await readdir(extension)).some((name) => ["node_modules", "src"].includes(name)));
  const helper = path.join(installed, "skills", "decide", "scripts", "decide.mjs");

  const input = {
    state: [{ ticket: "Synthetic ticket" }],
    images: ["data:image/jpeg;base64,/9j/4A=="],
    questions: {
      q: { type: "choice", instructions: "Route", criteria: { a: null, b: "Other" } },
      p: { type: "noul", instructions: "Is a refund requested?", criteria: { true: "Refund", false: "No refund" } },
      s: { type: "score", instructions: "Score", criteria: ["Low", "High"] },
    },
  };

  const response = {
    model: "custom-openjev",
    answers: {
      q: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 },
      p: { type: "noul", noul: 0.75 },
      s: { type: "score", score: 0.4, legend: { "0": "Low", "1": "High" }, probabilities: { "0": 0.6, "1": 0.4 }, confidence: 0.2 },
    },
    usage: { input_tokens: 17, output_tokens: 0 },
    server_extension: { retained: true },
  };

  const requests: { path: string; auth?: string; body: unknown }[] = [];
  let redirect: "metadata" | "inference" | undefined;

  const server = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url ?? "", auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });

    if ((redirect === "metadata" && req.method === "GET") || (redirect === "inference" && req.method === "POST")) {
      res.writeHead(307, { Location: "/should-not-follow" });
      res.end();

      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url?.endsWith("models/status") ? {
      models: [
        { id: "custom-openjev", model_type: "decision", loaded: false, model_alias: "alias-only" },
        { id: "engine-decision", model_type: "llm", engine_type: "decision", loaded: true },
        { id: "not-a-decision", model_type: "llm", loaded: true },
      ],
    } : response));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const environment = {
    ...process.env,
    NODE_PATH: "",
    OMLX_BASE_URL: `http://127.0.0.1:${address.port}/proxy/`,
    OMLX_API_KEY: "synthetic-token",
    OMLX_IMAGE_APPROVED: "true",
  };

  const file = path.join(directory, "input with spaces.json");
  await writeFile(file, JSON.stringify(input));

  const invoke = (args: string[], env = environment) => exec(process.execPath, [helper, ...args], {
    cwd: tmpdir(), env, timeout: 15_000,
  });

  const listed = await invoke(["models"]);
  const [decisions] = listed.stdout.split("ALL MODELS:");
  assert.match(decisions, /custom-openjev/);
  assert.match(decisions, /engine-decision/);
  assert.ok(!decisions.includes("not-a-decision"));

  const result = await invoke(["run", "--model", "custom-openjev", "--input", file]);
  assert.deepEqual(JSON.parse(result.stdout), response);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("synthetic-token"));
  assert.deepEqual(requests.map((request) => request.path), [
    "/proxy/v1/models/status", "/proxy/v1/models/status", "/proxy/v1/systemone",
  ]);
  assert.ok(requests.every((request) => request.auth === "Bearer synthetic-token"));
  assert.deepEqual(requests.at(-1)?.body, { ...input, model: "custom-openjev", truncate: false });

  const aliased = await invoke(["run", "--model", "alias-only", "--input", file]);
  assert.deepEqual(JSON.parse(aliased.stdout), response);
  assert.deepEqual(requests.at(-1)?.body, { ...input, model: "custom-openjev", truncate: false });

  for (const model of ["missing", "not-a-decision"]) {
    const before = requests.length;
    await assert.rejects(invoke(["run", "--model", model, "--input", file]), /not installed|does not have a decision/);
    assert.equal(requests.length, before + 1, "An unsupported model must never cause inference");
  }

  for (const images of [["/private/file.png"], [{ path: "/private/file.png" }]]) {
    await writeFile(file, JSON.stringify({ ...input, images }));
    const before = requests.length;
    await assert.rejects(invoke(["run", "--model", "custom-openjev", "--input", file]), /never file paths/);
    await assert.rejects(invoke(["run", "--approved", "--model", "custom-openjev", "--input", file]), /Unknown option/);

    const stdinApproval = exec(process.execPath, [helper, "run", "--model", "custom-openjev", "--input", file], {
      cwd: tmpdir(), env: environment, timeout: 15_000,
    });

    stdinApproval.child.stdin?.end("yes\n");
    await assert.rejects(stdinApproval, /never file paths/);
    assert.equal(requests.length, before, "Environment flags and CLI flags do not grant image consent");
  }

  await assert.rejects(invoke(["models"], { ...environment, OMLX_BASE_URL: "http://remote.invalid" }), /require HTTPS/);
  await assert.rejects(invoke(["models"], { ...environment, OMLX_API_KEY: "bad\nkey" }), /line breaks/);

  redirect = "metadata";
  const before = requests.length;
  await assert.rejects(invoke(["models"]), /Redirects are not allowed/);
  assert.equal(requests.length, before + 1);

  await writeFile(file, JSON.stringify(input));
  redirect = "inference";
  await assert.rejects(invoke(["run", "--model", "custom-openjev", "--input", file]), /Redirects are not allowed/);
  assert.equal(requests.length, before + 3);
  assert.ok(requests.every((request) => !request.path.includes("should-not-follow")));
});
