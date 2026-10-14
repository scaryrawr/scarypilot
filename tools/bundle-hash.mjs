import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function hashBundleFile(file) {
  const bytes = await readFile(file);

  const content = path.extname(file).toLowerCase() === ".node"
    ? bytes
    : bytes.toString("utf8").replace(/\r\n/g, "\n");

  return createHash("sha256").update(content).digest("hex");
}
