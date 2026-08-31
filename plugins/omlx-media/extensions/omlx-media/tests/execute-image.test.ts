import assert from "node:assert/strict";
import * as path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import { executeImage } from "../src/execute-image.ts";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "omlx-media-test-"));
  workspaces.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === code;
  });
}

describe("executeImage", () => {
  it("discovers a generation model and saves base64 image data", async () => {
    const root = await workspace();
    const image = Buffer.from("generated-image");
    const fetchImplementation = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models/status")) {
        return Response.json({
          models: [
            { id: "text-model", model_type: "llm", loaded: true },
            { id: "image-model", model_type: "image", loaded: true, capabilities: ["generation"] },
          ],
        });
      }
      assert.match(url, /\/v1\/images\/generations$/);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer secret");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        prompt: "a fox",
        model: "image-model",
        n: 1,
        response_format: "b64_json",
        size: "1024x1024",
        quality: "standard",
        style: "vivid",
      });
      return Response.json({ data: [{ b64_json: image.toString("base64") }] });
    };

    const result = await executeImage(
      { prompt: "a fox", size: "square", output: path.join(root, "art", "fox.png") },
      {
        environment: { OMLX_BASE_URL: "http://omlx.test", OMLX_API_KEY: "secret" },
        fetchImplementation,
      },
    );

    assert.deepEqual(result, {
      operation: "generate",
      model: "image-model",
      files: [path.join(root, "art", "fox.png")],
    });
    assert.deepEqual(await readFile(path.join(root, "art", "fox.png")), image);
  });

  it("infers editing from sources and sends data URIs", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "source.png"), Buffer.from("source"));
    await writeFile(path.join(root, "mask.png"), Buffer.from("mask"));
    const fetchImplementation = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models/status")) {
        return Response.json({
          models: [
            { id: "mage-flow", engine_type: "image", loaded: true },
            { id: "flux-klein-edit", engine_type: "image", loaded: true, tasks: ["edit"] },
          ],
        });
      }
      const body = JSON.parse(String(init?.body));
      assert.match(url, /\/v1\/images\/edits$/);
      assert.equal(body.model, "mage-flow");
      assert.match(body.images[0].image_url, /^data:image\/png;base64,/);
      assert.match(body.mask.image_url, /^data:image\/png;base64,/);
      assert.equal(body.image_strength, 0.4);
      return Response.json({ data: [{ b64_json: Buffer.from("edited").toString("base64") }] });
    };

    const result = await executeImage(
      {
        prompt: "replace the background",
        sources: [path.join(root, "source.png")],
        mask: path.join(root, "mask.png"),
        strength: 0.4,
        output: path.join(root, "edited.png"),
      },
      {
        environment: { OMLX_BASE_URL: "http://omlx.test" },
        fetchImplementation,
      },
    );

    assert.equal(result.operation, "edit");
    assert.equal(result.model, "mage-flow");
    assert.equal(await readFile(path.join(root, "edited.png"), "utf8"), "edited");
  });

  it("uses an explicit model when model discovery is unavailable", async () => {
    const root = await workspace();
    const fetchImplementation = async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/models/status")) {
        return new Response("not found", { status: 404, statusText: "Not Found" });
      }
      return Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] });
    };

    const result = await executeImage(
      { prompt: "a fox", model: "known-image-model", output: path.join(root, "fox.png") },
      {
        environment: { OMLX_BASE_URL: "http://omlx.test" },
        fetchImplementation,
      },
    );

    assert.equal(result.model, "known-image-model");
    assert.equal(await readFile(path.join(root, "fox.png"), "utf8"), "image");
  });

  it("does not bypass authentication failures for an explicit model", async () => {
    const root = await workspace();

    await rejectsWithCode(
      executeImage(
        { prompt: "a fox", model: "known-image-model", output: path.join(root, "fox.png") },
        {
          environment: { OMLX_BASE_URL: "http://omlx.test" },
          fetchImplementation: async () =>
            new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
        },
      ),
      "AUTHENTICATION_FAILED",
    );
  });

  it("requires absolute paths and rejects existing outputs", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "existing.png"), "existing");
    let fetchCalled = false;
    const unusedFetch = async () => {
      fetchCalled = true;
      return Response.json({});
    };

    await rejectsWithCode(
      executeImage(
        { prompt: "a fox", output: "../fox.png" },
        { fetchImplementation: unusedFetch },
      ),
      "ABSOLUTE_PATH_REQUIRED",
    );

    await rejectsWithCode(
      executeImage(
        { prompt: "a fox", output: path.join(root, "existing.png") },
        { fetchImplementation: unusedFetch },
      ),
      "OUTPUT_CONFLICT",
    );
    assert.equal(fetchCalled, false);
  });

  it("renders identical prompts again when given a new output", async () => {
    const root = await workspace();
    const fetchImplementation = async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/models/status")) {
        return Response.json({
          models: [{ id: "image-model", model_type: "image", capabilities: ["generation"] }],
        });
      }
      return Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] });
    };
    const dependencies = {
      environment: { OMLX_BASE_URL: "http://omlx.test" },
      fetchImplementation,
    };

    const first = await executeImage(
      { prompt: "same prompt", output: path.join(root, "first.png") },
      dependencies,
    );
    const second = await executeImage(
      { prompt: "same prompt", output: path.join(root, "second.png") },
      dependencies,
    );

    assert.notEqual(first.files[0], second.files[0]);
  });
});
