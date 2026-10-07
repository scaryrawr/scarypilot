import assert from "node:assert/strict";
import { appendFile, lstat, mkdtemp, open, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

test("mutation after pre-read checks rejects before image encoding and inference", async (t) => {
  t.after(() => mock.restoreAll());
  const directory = await mkdtemp(join(tmpdir(), "ollama-decisions-reading-"));

  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "image.png");
  const originalBytes = Buffer.alloc(128 * 1024, 1);
  let mutate = async () => {};

  let readBytes = 0;

  mock.module("node:fs/promises", {
    namedExports: {
      lstat,
      realpath,
      open: async (...args: Parameters<typeof open>) => {
        const file = await open(...args);
        const createReadStream = file.createReadStream.bind(file);

        mock.method(file, "createReadStream", (options: Parameters<typeof file.createReadStream>[0]) => {
          assert.equal(options?.end, originalBytes.length - 1, "read must be bounded to the approved size");
          const stream = createReadStream(options);
          const iterator = stream[Symbol.asyncIterator].bind(stream);

          mock.method(stream, Symbol.asyncIterator, async function* () {
            let changed = false;

            for await (const chunk of iterator()) {
              if (!changed) {
                changed = true;
                await mutate();
              }

              readBytes += chunk.length;
              yield chunk;
            }
          });

          return stream;
        });

        return file;
      },
    },
  });
  const { DecisionClient } = await import("../src/decisions.ts");

  for (const mutation of ["append", "overwrite", "truncate"] as const) {
    await t.test(mutation, async () => {
      await writeFile(path, originalBytes);
      readBytes = 0;
      mutate = async () => {
        if (mutation === "append") await appendFile(path, "synthetic-sensitive-appended-data");
        else if (mutation === "overwrite") await writeFile(path, Buffer.alloc(originalBytes.length, 2));
        else await truncate(path, 1);
      };

      let inferences = 0;

      const client = new DecisionClient({
        environment: {},
        approveImage: async () => true,
        fetch: async (url) => {
          if (String(url).endsWith("/api/tags")) {
            return Response.json({ models: [{ name: "installed:latest", capabilities: ["decision", "vision"] }] });
          }

          inferences++;
          assert.fail("a modified file must not be transmitted");
        },
      });

      await assert.rejects(client.decide({
        model: "installed:latest",
        state: "Synthetic image",
        images: [{ path }],
        questions: { food: { type: "noul", instructions: "Does the image show food?" } },
      }), /changed during reading/);
      assert.ok(readBytes <= originalBytes.length);
      assert.equal(inferences, 0);
    });
  }
});
