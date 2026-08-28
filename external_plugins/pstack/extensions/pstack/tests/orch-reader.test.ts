import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOrchStore } from "../src/orch-reader.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("readOrchStore", () => {
  it("projects existing flat-file state without writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pstack-orch-reader-"));
    directories.push(directory);
    await Promise.all([
      writeFile(join(directory, "units.tsv"), "id\ttrack\tstate\tbranch\tpr\tsha\tbrief\nu1\tbuild\tdone\ttopic\t12\tabc\tbrief.md\n"),
      writeFile(join(directory, "ledger.tsv"), "pr\tsha\tverdict\tevidence\tverifier\tts\n12\tabc\tunit-test-verified\treceipts/12/abc/r.json\ttest\t2026-01-01T00:00:00.000Z\n"),
      writeFile(join(directory, "gates.md"), "# Gates\n\n## ship\n\n- Status: open\n- Question: Ship it?\n- Options: yes,no\n- Default: no\n"),
      writeFile(join(directory, "frontier.json"), '{"generation":1,"prs":[],"lowestUnmerged":null}\n'),
    ]);
    const result = await readOrchStore(directory);
    expect(result.warnings).toEqual([]);
    expect(result.projection?.unitCounts).toEqual({ done: 1 });
    expect(result.projection?.ledger[0]?.verdict).toBe("unit-test-verified");
    expect(result.projection?.openGates[0]?.id).toBe("ship");
    expect(result.sources).toHaveLength(4);
  });

  it("surfaces malformed authoritative state instead of hiding it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pstack-orch-invalid-"));
    directories.push(directory);
    await Promise.all([
      writeFile(join(directory, "units.tsv"), "id\ttrack\tstate\tbranch\tpr\tsha\tbrief\n"),
      writeFile(join(directory, "ledger.tsv"), "pr\tsha\tverdict\tevidence\tverifier\tts\n"),
      writeFile(join(directory, "gates.md"), "# Gates\n\n## ship\n\n- Status: opne\n- Question: Ship it?\n- Options: yes,no\n- Default: no\n"),
      writeFile(join(directory, "frontier.json"), "{}\n"),
    ]);
    const result = await readOrchStore(directory);
    expect(result.projection?.openGates).toEqual([]);
    expect(result.warnings).toContainEqual({
      source: "orch",
      path: join(directory, "gates.md"),
      message: "gates.md has invalid status opne",
    });
  });
});
