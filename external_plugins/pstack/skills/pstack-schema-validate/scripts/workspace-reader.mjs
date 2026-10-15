import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

function inside(root, path) {
  const child = relative(root, path);

  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function validateWorkspaceFilePath(path) {
  if (
    typeof path !== "string" || !path.trim() || path.includes("\0") ||
    /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw new Error("path must name one workspace file, without URLs or traversal");
  }
}

export async function openConfinedFile(path, openFile = open) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

  if (process.platform === "darwin") {
    // Darwin's O_NOFOLLOW_ANY rejects symlinks in every component; Node exposes only O_NOFOLLOW.
    const noFollowAny = 0x20000000;

    return openFile(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollowAny);
  }

  if (process.platform !== "linux") {
    throw new Error("workspace-confined validation requires macOS or Linux");
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

export async function readWorkspaceFile(cwd, path, openFile = open) {
  validateWorkspaceFilePath(path);
  const root = await realpath(cwd);
  const target = resolve(cwd, path);

  if (!inside(resolve(cwd), target) && !inside(root, target)) {
    throw new Error("path must stay inside the current workspace");
  }

  const resolved = await realpath(target);

  if (!inside(root, resolved)) throw new Error("path resolves outside the current workspace");
  const lexical = inside(root, target) ? target : resolve(root, relative(resolve(cwd), target));
  const file = await openConfinedFile(lexical, openFile);

  try {
    const stat = await file.stat();

    if (!stat.isFile()) throw new Error("path must name a regular file");

    return { path: resolved, bytes: await file.readFile() };
  } finally {
    await file.close();
  }
}
