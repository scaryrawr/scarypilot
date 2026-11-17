import assert from "node:assert/strict";
import * as filesystem from "node:fs/promises";
import { mock, test } from "node:test";

test("CLI rejects every path representation before file lookup, opening, or network access", async (t) => {
  t.after(() => mock.restoreAll());
  const reads: string[] = [];
  let input = "";
  let filesystemLookups = 0;
  let networkRequests = 0;

  mock.module("node:fs/promises", {
    namedExports: {
      ...filesystem,
      readFile: async (path: string) => {
        reads.push(path);

        return input;
      },
      open: async () => { filesystemLookups++; throw new Error("Image must not be opened"); },
      lstat: async () => { filesystemLookups++; throw new Error("Image must not be inspected"); },
      realpath: async () => { filesystemLookups++; throw new Error("Image must not be resolved"); },
    },
  });
  mock.method(globalThis, "fetch", async () => {
    networkRequests++;
    throw new Error("Invalid input must not contact a server");
  });
  const { main } = await import("../src/cli.ts");
  const questions = { q: { type: "noul", instructions: "Is the supplied image relevant?" } };

  for (const image of [
    "/private/image.png", "./relative.png", "../outside.jpg", "file:///private/image.png",
    "C:\\private\\image.png", { path: "/private/image.png" }, { path: "/private/image.png", approved: true },
    "https://example.test/image.png",
  ]) {
    input = JSON.stringify({ state: "Synthetic", questions, images: [image] });
    await assert.rejects(main(["run", "--model", "installed", "--input", "/input.json"]), /never file paths/);
  }

  assert.equal(reads.length, 8);
  assert.ok(reads.every((path) => path === "/input.json"), "Only the explicit JSON input may be read");
  assert.equal(filesystemLookups, 0);
  assert.equal(networkRequests, 0);
});
