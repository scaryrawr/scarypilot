import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashBundleFile } from "./bundle-hash.mjs";

test("text bundle hashes preserve LF/CRLF portability", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bundle-hash-"));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const lf = path.join(directory, "lf.mjs");
  const crlf = path.join(directory, "crlf.mjs");

  await Promise.all([
    writeFile(lf, "export const value = 1;\n"),
    writeFile(crlf, "export const value = 1;\r\n"),
  ]);

  assert.equal(await hashBundleFile(lf), await hashBundleFile(crlf));
});

test("native bundle hashes use exact bytes and distinguish invalid UTF-8", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bundle-hash-"));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = path.join(directory, "first.node");
  const second = path.join(directory, "second.node");
  const bytes = Buffer.from([0x4d, 0x5a, 0xff, 0x0d, 0x0a, 0x00]);

  await Promise.all([
    writeFile(first, bytes),
    writeFile(second, Buffer.from([0x4d, 0x5a, 0xfe, 0x0d, 0x0a, 0x00])),
  ]);

  assert.equal(await hashBundleFile(first), createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(await hashBundleFile(first), await hashBundleFile(second));
});
