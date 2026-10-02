import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

const root = fileURLToPath(new URL("../", import.meta.url));

describe("extension registration", () => {
  it("registers exactly the snapshot and three Boards tools with the canvas and command through the SDK stub", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "ado-registration-"));

    try {
      const { stdout } = await run(process.execPath, [path.join(root, "scripts/smoke-bundle.mjs")], {
        cwd: root,
        env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
        timeout: 20_000,
      });

      expect(stdout).toContain("SDK stub smoke registers its canvas and exactly four read-only tools without installed Node dependencies");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
