import { createHash } from "node:crypto";
import { open, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashWorkspaceFile } from "../src/workspace-reader.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

it("hashes exact bytes across bounded reads without whole-file buffering", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pstack-hash-")));
  directories.push(cwd);
  const bytes = Buffer.alloc(1024 * 1024 + 17);

  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  await writeFile(join(cwd, "large.bin"), bytes);
  const lengths: number[] = [];

  const confinedOpen: typeof open = async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    handle.readFile = async () => { throw new Error("whole-file buffering is forbidden"); };

    handle.read = async (...readArgs: Parameters<typeof handle.read>) => {
      const result = await read(...readArgs);
      lengths.push(result.buffer.byteLength);

      return result;
    };

    return handle;
  };

  const result = await hashWorkspaceFile(cwd, "large.bin", new AbortController().signal, confinedOpen, true);

  expect(result).toEqual({
    path: join(cwd, "large.bin"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(lengths.length).toBeGreaterThan(16);
  expect(Math.max(...lengths)).toBe(64 * 1024);
});

it("propagates cancellation during streaming and closes the descriptor", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pstack-hash-")));
  directories.push(cwd);
  await writeFile(join(cwd, "large.bin"), Buffer.alloc(200000, 255));
  const controller = new AbortController();
  const reason = new Error("cancel hashing");
  let closed = false;

  const confinedOpen: typeof open = async (...args) => {
    const handle = await open(...args);

    if (String(args[0]).endsWith("large.bin")) {
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      handle.read = async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        controller.abort(reason);

        return result;
      };

      handle.close = async () => {
        closed = true;
        await close();
      };
    }

    return handle;
  };

  await expect(hashWorkspaceFile(cwd, "large.bin", controller.signal, confinedOpen, true)).rejects.toBe(reason);
  expect(closed).toBe(true);
});
