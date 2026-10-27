import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, open, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  openConfinedFile, readWorkspaceFile, validateWorkspaceFilePath,
} from "../scripts/workspace-reader.mjs";
import { supported, workspace } from "./support.mjs";

it("rejects invalid path input before any filesystem access", async () => {
  for (const path of [
    undefined, null, 1, {}, "", " ", "../secret", "dir/../secret", "..\\secret",
    "file:///secret", "https://example.invalid/file", "//server/file", "secret\0",
  ]) {
    assert.throws(() => validateWorkspaceFilePath(path), {
      message: "path must name one workspace file, without URLs or traversal",
    });
    await assert.rejects(readWorkspaceFile("missing-root", path), {
      message: "path must name one workspace file, without URLs or traversal",
    });
  }
});

it("rejects unsupported platforms without opening a descriptor", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  let opened = false;

  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await assert.rejects(openConfinedFile("C:\\workspace\\file", async () => {
      opened = true;
    }), { message: "workspace-confined validation requires macOS or Linux" });
    assert.equal(opened, false);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

it("uses Darwin no-follow-any and nonblocking flags without silently weakening them", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const calls = [];
  const handle = {};

  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    assert.equal(await openConfinedFile("/workspace/file", async (...args) => {
      calls.push(args);

      return handle;
    }), handle);
    assert.deepEqual(calls, [["/workspace/file", constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000]]);
    await assert.rejects(openConfinedFile("/workspace/file", async () => {
      throw new Error("unsupported flag");
    }), /unsupported flag/);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

it("walks Linux directories through held descriptors with no-follow flags and closes them", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const calls = [];
  const closed = [];
  let fd = 10;

  try {
    Object.defineProperty(process, "platform", { value: "linux" });

    const file = await openConfinedFile("/workspace/dir/file", async (path, flags) => {
      const current = fd++;
      calls.push([path, flags]);

      return { fd: current, close: async () => { closed.push(current); } };
    });

    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    assert.deepEqual(calls, [
      ["/", flags | constants.O_DIRECTORY],
      ["/proc/self/fd/10/workspace", flags | constants.O_DIRECTORY],
      ["/proc/self/fd/11/dir", flags | constants.O_DIRECTORY],
      ["/proc/self/fd/12/file", flags],
    ]);
    assert.deepEqual(closed, [10, 11, 12]);
    assert.equal(file.fd, 13);
    const failureClosed = [];
    await assert.rejects(openConfinedFile("/file", async (path) => {
      if (path !== "/") throw new Error("no proc filesystem");

      return { fd: 20, close: async () => { failureClosed.push(20); } };
    }), /no proc filesystem/);
    assert.deepEqual(failureClosed, [20]);
    const walkClosed = [];
    await assert.rejects(openConfinedFile("/workspace/dir/file", async (path) => {
      if (path.endsWith("/dir")) throw new Error("ancestor rejected");
      const current = path === "/" ? 30 : 31;

      return { fd: current, close: async () => { walkClosed.push(current); } };
    }), /ancestor rejected/);
    assert.deepEqual(walkClosed, [30, 31]);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

describe("confined reader on the host filesystem", { skip: !supported }, () => {
  it("returns canonical path and exact bytes for relative and absolute paths", async () => {
    const cwd = await workspace();
    const bytes = Buffer.from([0, 255, 1, 10]);
    await writeFile(join(cwd, "artifact"), bytes);

    for (const path of ["artifact", join(cwd, "artifact")]) {
      assert.deepEqual(await readWorkspaceFile(cwd, path), { path: join(cwd, "artifact"), bytes });
    }
  });

  it("accepts a canonicalized cwd alias without accepting artifact symlinks", async () => {
    const parent = await workspace();
    const cwd = join(parent, "actual");
    const alias = join(parent, "alias");
    await mkdir(cwd);
    await symlink(cwd, alias);
    await writeFile(join(cwd, "artifact"), "bytes");

    for (const path of ["artifact", join(alias, "artifact"), join(cwd, "artifact")]) {
      assert.deepEqual(await readWorkspaceFile(alias, path), {
        path: join(cwd, "artifact"), bytes: Buffer.from("bytes"),
      });
    }
  });

  it("rejects missing files, directories, outside paths, and every artifact symlink", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await mkdir(join(cwd, "dir"));
    await writeFile(join(cwd, "dir", "file"), "bytes");
    await writeFile(join(cwd, "artifact"), "bytes");
    await writeFile(join(outside, "secret"), "secret");
    await symlink(join(cwd, "artifact"), join(cwd, "inside"));
    await symlink(join(outside, "secret"), join(cwd, "escape"));
    await symlink(join(cwd, "dir"), join(cwd, "inside-dir"));
    await symlink(outside, join(cwd, "escape-dir"));
    await symlink(join(cwd, "artifact"), join(outside, "alias-to-inside"));

    for (const path of [
      "missing", "dir", join(outside, "secret"), join(outside, "alias-to-inside"),
      "inside", "escape", "inside-dir/file", "escape-dir/secret",
    ]) {
      await assert.rejects(readWorkspaceFile(cwd, path));
    }

    await assert.rejects(readWorkspaceFile(cwd, "dir"), /path must name a regular file/);
  });

  for (const component of ["ancestor", "leaf"]) {
    it(`rejects a ${component} swapped for an outside symlink between authorization and open`, async () => {
      const cwd = await workspace();
      const outside = await workspace();
      const approved = join(cwd, "approved");
      await mkdir(approved);
      await writeFile(join(approved, "artifact"), "approved");
      await writeFile(join(outside, "artifact"), "outside");
      let swapped = false;

      const racingOpen = async (path, ...args) => {
        const marker = component === "ancestor" ? "approved" : "artifact";

        if (!swapped && String(path).includes(marker)) {
          swapped = true;
          const original = component === "ancestor" ? approved : join(approved, "artifact");
          const replacement = component === "ancestor" ? outside : join(outside, "artifact");
          await rename(original, `${original}-original`);
          await symlink(replacement, original);
        }

        return open(path, ...args);
      };

      await assert.rejects(readWorkspaceFile(cwd, "approved/artifact", racingOpen), {
        code: /^(ELOOP|ENOTDIR)$/,
      });
      assert.equal(swapped, true);
    });
  }

  it("keeps an opened Linux ancestor pinned if its directory name is swapped later", {
    skip: process.platform !== "linux",
  }, async () => {
    const cwd = await workspace();
    const outside = await workspace();
    const approved = join(cwd, "approved");
    await mkdir(approved);
    await writeFile(join(approved, "artifact"), "approved");
    await writeFile(join(outside, "artifact"), "outside");

    const racingOpen = async (path, ...args) => {
      const handle = await open(path, ...args);

      if (String(path).endsWith("/approved")) {
        await rename(approved, join(cwd, "original"));
        await symlink(outside, approved);
      }

      return handle;
    };

    assert.equal((await readWorkspaceFile(cwd, "approved/artifact", racingOpen)).bytes.toString(), "approved");
  });

  it("closes file handles for stat, non-file, and read failures", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "artifact"), "bytes");

    for (const failure of ["stat", "non-file", "readFile"]) {
      let closed = false;

      const instrumentedOpen = async (...args) => {
        const handle = await open(...args);

        if (String(args[0]).endsWith("/artifact")) {
          const close = handle.close.bind(handle);

          if (failure === "non-file") handle.stat = async () => ({ isFile: () => false });
          else handle[failure] = async () => { throw new Error(`failed ${failure}`); };

          handle.close = async () => { closed = true; await close(); };
        }

        return handle;
      };

      await assert.rejects(readWorkspaceFile(cwd, "artifact", instrumentedOpen), new RegExp(
        failure === "non-file" ? "path must name a regular file" : `failed ${failure}`,
      ));
      assert.equal(closed, true);
    }
  });
});
