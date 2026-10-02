import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

function inside(root: string, path: string): boolean {
  const child = relative(root, path);

  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function validateWorkspaceFilePath(path: string): void {
  if (
    !path.trim() || path.includes("\0") ||
    /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw new Error("path must name one workspace file, without URLs or traversal");
  }
}

export async function openConfinedFile(path: string, openFile: typeof open = open) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

  if (process.platform === "darwin") {
    // Darwin's O_NOFOLLOW_ANY rejects symlinks in every component; Node exposes only O_NOFOLLOW.
    const noFollowAny = 0x20000000;

    return openFile(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollowAny);
  }

  if (process.platform !== "linux") {
    throw new Error("native workspace-confined validation requires macOS or Linux; use the approved-workspace CLI fallback on other platforms");
  }

  const directoryFlags = flags | constants.O_DIRECTORY;
  let parent = await openFile("/", directoryFlags);

  try {
    for (const directory of dirname(path).split(sep).filter(Boolean)) {
      const previous = parent;
      parent = await openFile(`/proc/self/fd/${parent.fd}/${directory}`, directoryFlags);
      await previous.close();
    }

    return await openFile(`/proc/self/fd/${parent.fd}/${basename(path)}`, flags);
  } finally {
    await parent.close();
  }
}

async function openWorkspaceFile(
  cwd: string,
  path: string,
  openFile: typeof open = open,
  rejectSymlinks = false,
) {
  validateWorkspaceFilePath(path);
  const root = await realpath(cwd);
  const target = resolve(cwd, path);

  if (!inside(resolve(cwd), target) && !inside(root, target)) {
    throw new Error("path must stay inside the current workspace");
  }

  const resolved = await realpath(target);

  if (!inside(root, resolved)) throw new Error("path resolves outside the current workspace");
  const lexical = inside(root, target) ? target : resolve(root, relative(resolve(cwd), target));
  const file = await openConfinedFile(rejectSymlinks ? lexical : resolved, openFile);

  try {
    if (!(await file.stat()).isFile()) throw new Error("path must name a regular file");

    return { path: resolved, file };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function readWorkspaceFile(
  cwd: string,
  path: string,
  openFile: typeof open = open,
  rejectSymlinks = false,
): Promise<{ path: string; bytes: Buffer }> {
  const authorized = await openWorkspaceFile(cwd, path, openFile, rejectSymlinks);

  try {
    return { path: authorized.path, bytes: await authorized.file.readFile() };
  } finally {
    await authorized.file.close();
  }
}

export async function hashWorkspaceFile(
  cwd: string,
  path: string,
  signal: AbortSignal,
  openFile: typeof open = open,
  rejectSymlinks = false,
): Promise<{ path: string; sha256: string }> {
  signal.throwIfAborted();
  const authorized = await openWorkspaceFile(cwd, path, openFile, rejectSymlinks);

  try {
    signal.throwIfAborted();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);

    while (true) {
      signal.throwIfAborted();

      const { bytesRead } = await authorized.file.read({
        buffer, offset: 0, length: buffer.length, position: null,
      });

      signal.throwIfAborted();

      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }

    signal.throwIfAborted();

    return { path: authorized.path, sha256: hash.digest("hex") };
  } finally {
    await authorized.file.close();
  }
}
