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
  it("registers the read-only snapshot tool with the existing canvas and command in the packaged entry point", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "ado-registration-"));

    try {
      const { stdout } = await run(process.execPath, [path.join(root, "scripts/smoke-bundle.mjs")], {
        cwd: root,
        env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
        timeout: 20_000,
      });

      expect(stdout).toContain("Bundle registers its canvas and snapshot tool without installed Node dependencies");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
