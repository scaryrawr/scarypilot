import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildPlan,
  checkRepository,
  parseNameStatus,
} from "./pstack-sync.mjs";

const policy = {
  upstream: {
    repository: "https://github.com/cursor/plugins",
    subtree: "pstack",
  },
  mappedUpstreamPaths: [
    {
      path: ".cursor-plugin/plugin.json",
      localPaths: ["plugin.json"],
      reason: "mapped",
    },
    {
      path: "agents",
      localPaths: ["agents"],
      reason: "mapped",
    },
  ],
  excludedUpstreamPaths: [
    { path: "automations/benny", reason: "unsupported" },
  ],
  copilotOwnedPaths: ["extensions", "skills/deslop"],
};

test("classifies a bounded upstream change set", () => {
  const changes = parseNameStatus(
    [
      "M\tpstack/skills/how/SKILL.md",
      "A\tpstack/automations/benny/README.md",
      "M\tpstack/.cursor-plugin/plugin.json",
      "M\tpstack/agents/poteto-agent.md",
      "A\tpstack/extensions/runtime.mjs",
      "A\tpstack/new-runtime/file.md",
    ].join("\n"),
  );
  const plan = buildPlan({
    policy,
    changes,
    from: "a",
    to: "b",
    targetVersion: "0.15.1",
  });

  assert.deepEqual(
    plan.changes.map(({ path, disposition }) => [path, disposition]),
    [
      ["skills/how/SKILL.md", "adapted"],
      ["automations/benny/README.md", "excluded"],
      [".cursor-plugin/plugin.json", "mapped"],
      ["agents/poteto-agent.md", "mapped"],
      ["extensions/runtime.mjs", "copilot-owned"],
      ["new-runtime/file.md", "unclassified"],
    ],
  );
});

test("rejects Cursor invocation guards in every shipped skill", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  mkdirSync(join(root, "skills", "how"), { recursive: true });
  mkdirSync(join(root, "extensions"), { recursive: true });
  writeFileSync(
    join(root, "skills", "how", "SKILL.md"),
    [
      "---",
      "name: how",
      "description: test",
      "disable-model-invocation: true",
      "---",
      "",
      "# How",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "upstream-sync.json"),
    JSON.stringify({
      upstream: {
        version: "0.15.1",
        reviewedFromCommit: "base-sha",
        integratedCommit: "target-sha",
        contentCommit: "content-sha",
      },
      localVersion: "0.15.1-copilot.8",
      requiredSkills: ["how"],
      forbiddenSkillFrontmatter: ["disable-model-invocation"],
      forbiddenContent: [],
      excludedUpstreamPaths: [],
    }),
  );
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({
      version: "0.15.1-copilot.8",
      extensions: ["extensions"],
    }),
  );
  writeFileSync(
    join(root, "NOTICE.md"),
    "0.15.1 base-sha target-sha content-sha",
  );
  writeFileSync(join(root, "README.md"), "- 1 Agent Skills\n");

  assert.deepEqual(
    checkRepository(root)
      .filter(({ code }) => code === "forbidden-frontmatter")
      .map(({ path }) => path),
    ["skills/how/SKILL.md"],
  );
});

test("rejects a notice with a stale reviewed boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  mkdirSync(join(root, "skills", "how"), { recursive: true });
  mkdirSync(join(root, "extensions"), { recursive: true });
  writeFileSync(
    join(root, "skills", "how", "SKILL.md"),
    "---\nname: how\ndescription: test\n---\n\n# How\n",
  );
  writeFileSync(
    join(root, "upstream-sync.json"),
    JSON.stringify({
      upstream: {
        version: "0.15.1",
        reviewedFromCommit: "base-sha",
        integratedCommit: "target-sha",
        contentCommit: "content-sha",
      },
      localVersion: "0.15.1-copilot.8",
      requiredSkills: ["how"],
      forbiddenSkillFrontmatter: [],
      forbiddenContent: [],
      excludedUpstreamPaths: [],
    }),
  );
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({
      version: "0.15.1-copilot.8",
      extensions: ["extensions"],
    }),
  );
  writeFileSync(join(root, "NOTICE.md"), "0.15.1 target-sha content-sha");
  writeFileSync(join(root, "README.md"), "- 1 Agent Skills\n");

  assert.deepEqual(
    checkRepository(root)
      .filter(({ code }) => code === "provenance-drift")
      .map(({ message }) => message),
    ["NOTICE.md does not record base-sha"],
  );
});
