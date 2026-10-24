import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
      path: "plugin.json",
      localPaths: ["plugin.json"],
      reason: "legacy Copilot registration",
    },
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
    { path: "extensions", reason: "native runtime retired" },
  ],
  copilotOwnedPaths: ["skills/deslop"],
};

test("shipped pstack integration satisfies the sync policy", () => {
  assert.deepEqual(checkRepository(), []);
});

test("portable CI pins stable TLC with a documented SHA-256", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/pstack-portable.yml", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const digest = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";

  assert.match(workflow, /https:\/\/github\.com\/tlaplus\/tlaplus\/releases\/download\/v1\.7\.4\/tla2tools\.jar/);
  assert.ok(workflow.includes(digest));
  assert.ok(readme.includes(digest));
  assert.doesNotMatch(workflow, /releases\/download\/(?:v1\.8\.0|rolling)\//);
});

test("TLC provisioning exports only a successfully verified download", {
  skip: process.platform === "win32" ? "CI provisions TLC only on POSIX" : false,
}, (t) => {
  const workflow = readFileSync(new URL("../../../.github/workflows/pstack-portable.yml", import.meta.url), "utf8");

  const step = workflow.split("      - name: Provision pinned official TLC\n")[1]
    ?.split("      - name: Check sync policy and portable helpers\n")[0];

  assert.ok(step, "the provisioning step must remain covered");

  const script = step.split("        run: |\n")[1]?.replace(/^ {10}/gm, "");

  assert.ok(script, "the provisioning shell body must remain covered");

  const root = mkdtempSync(join(tmpdir(), "pstack-tlc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), `#!/bin/sh
if [ "$TLC_TEST_TRANSPORT_FAILURE" = 1 ]; then exit 22; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then
    printf '%s' 'synthetic TLC fixture' > "$2"
    exit 0
  fi
  shift
done
exit 2
`, { mode: 0o755 });

  const fixtureDigest = createHash("sha256").update("synthetic TLC fixture").digest("hex");

  for (const scenario of ["verified", "checksum-mismatch", "transport-failure"]) {
    const envFile = join(root, `${scenario}.env`);

    const run = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c",
      scenario === "verified"
        ? script.replace("936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88", fixtureDigest)
        : script,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: root,
        JAVA_HOME: join(root, "java"),
        GITHUB_ENV: envFile,
        TLC_TEST_TRANSPORT_FAILURE: scenario === "transport-failure" ? "1" : "0",
      },
    });

    assert.equal(run.error, undefined);

    if (scenario === "verified") {
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(envFile, "utf8"),
        `TLA2TOOLS=${join(root, "pstack-tlc", "tla2tools-1.7.4.jar")}\nJAVA=${join(root, "java", "bin", "java")}\n`);
    } else {
      assert.notEqual(run.status, 0, scenario);
      assert.ok(!readdirSync(root).includes(`${scenario}.env`), scenario);
    }
  }
});

test("the mapped manifest retains skills and agents without an extension", () => {
  const plugin = JSON.parse(
    readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
  );

  assert.equal(plugin.$schema, undefined);
  assert.deepEqual(plugin.skills, ["skills/"]);
  assert.equal(plugin.agents, "agents/");
  assert.equal(Object.hasOwn(plugin, "extensions"), false);
});

test("rejects native extension registration, including an empty registration", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-sync-portable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "skills"));
  writeFileSync(join(root, "upstream-sync.json"), JSON.stringify({
    upstream: {
      version: "test",
      reviewedFromCommit: "test",
      integratedCommit: "test",
      contentCommit: "test",
    },
    localVersion: "test",
    requiredSkills: [],
    forbiddenSkillFrontmatter: [],
    forbiddenContent: [],
    excludedUpstreamPaths: [],
  }));
  writeFileSync(join(root, "NOTICE.md"), "test");
  writeFileSync(join(root, "README.md"), "- 0 Agent Skills\n");
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ version: "test" }));
  assert.deepEqual(checkRepository(root), []);

  for (const extensions of [[], ["extensions/"], null]) {
    writeFileSync(join(root, "plugin.json"), JSON.stringify({ version: "test", extensions }));
    assert.deepEqual(checkRepository(root), [{
      code: "unexpected-extension",
      message: "pstack must publish skills and scripts without native extension registration",
      path: "plugin.json",
    }]);
  }
});

test("shipped skills and guides do not invoke retired native surfaces", () => {
  const retired = /\bpstack_(?:status|capabilities|validate_plan|validate_artifact|record_verification|inspect_worktrees|handoff)\b|\bpstack-swarm\b|\/pstack(?:\s|`)/;

  function checkDocs(root) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(root, entry.name);

      if (entry.isDirectory()) checkDocs(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        assert.doesNotMatch(readFileSync(path, "utf8"), retired, path);
      }
    }
  }

  checkDocs(fileURLToPath(new URL("../skills", import.meta.url)));
  checkDocs(fileURLToPath(new URL("../docs/guide", import.meta.url)));
});

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
      ["extensions/runtime.mjs", "excluded"],
      ["new-runtime/file.md", "unclassified"],
    ],
  );
});

test("maps the upstream root manifest before Copilot-owned paths", () => {
  const plan = buildPlan({
    policy: { ...policy, copilotOwnedPaths: ["plugin.json"] },
    changes: [{ status: "A", path: "plugin.json" }],
    from: "a",
    to: "b",
    targetVersion: "0.15.25",
  });

  assert.deepEqual(plan.changes, [{
    status: "A",
    path: "plugin.json",
    disposition: "mapped",
    localPaths: ["plugin.json"],
    reason: "legacy Copilot registration",
  }]);
});

test("excludes the Claude Code adapter without allowing unrelated harness paths", () => {
  const shippedPolicy = JSON.parse(
    readFileSync(new URL("../upstream-sync.json", import.meta.url), "utf8"),
  );

  const plan = buildPlan({
    policy: shippedPolicy,
    changes: parseNameStatus([
      "A\tpstack/docs/harness/claude-code.md",
      "A\tpstack/docs/harness/new-client.md",
      "A\tpstack/skills/create-formal-verification-skill/SKILL.md",
      "A\tpstack/skills/maintain-formal-verification-skill/SKILL.md",
    ].join("\n")),
    from: "a",
    to: "b",
    targetVersion: "0.15.29",
  });

  assert.deepEqual(
    plan.changes.map(({ path, disposition }) => [path, disposition]),
    [
      ["docs/harness/claude-code.md", "excluded"],
      ["docs/harness/new-client.md", "unclassified"],
      ["skills/create-formal-verification-skill/SKILL.md", "adapted"],
      ["skills/maintain-formal-verification-skill/SKILL.md", "adapted"],
    ],
  );
});

test("rejects Cursor invocation guards in every shipped skill", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "skills", "how"), { recursive: true });
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
      localVersion: "0.15.1-copilot.9",
      requiredSkills: ["how"],
      forbiddenSkillFrontmatter: ["disable-model-invocation"],
      forbiddenContent: [],
      excludedUpstreamPaths: [],
    }),
  );
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({
      version: "0.15.1-copilot.9",
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

test("rejects a notice with a stale reviewed boundary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "skills", "how"), { recursive: true });
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
      localVersion: "0.15.1-copilot.9",
      requiredSkills: ["how"],
      forbiddenSkillFrontmatter: [],
      forbiddenContent: [],
      excludedUpstreamPaths: [],
    }),
  );
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({
      version: "0.15.1-copilot.9",
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

test("rejects quoted forbidden skill frontmatter keys", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "skills", "how"), { recursive: true });
  writeFileSync(
    join(root, "skills", "how", "SKILL.md"),
    [
      "---",
      "name: how",
      "description: test",
      "'disable-model-invocation': true",
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
      localVersion: "0.15.1-copilot.9",
      requiredSkills: ["how"],
      forbiddenSkillFrontmatter: ["disable-model-invocation"],
      forbiddenContent: [],
      excludedUpstreamPaths: [],
    }),
  );
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({
      version: "0.15.1-copilot.9",
    }),
  );
  writeFileSync(
    join(root, "NOTICE.md"),
    "0.15.1 base-sha target-sha content-sha",
  );
  writeFileSync(join(root, "README.md"), "- 1 Agent Skills\n");

  assert.equal(
    checkRepository(root).filter(({ code }) => code === "forbidden-frontmatter")
      .length,
    1,
  );
});

test("scans non-Markdown files for forbidden content", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "skills", "how"), { recursive: true });
  writeFileSync(
    join(root, "skills", "how", "SKILL.md"),
    "---\nname: how\ndescription: test\n---\n\n# How\n",
  );
  writeFileSync(
    join(root, "skills", "how", "helper.mjs"),
    'export const worker = { subagent_type: "generalPurpose" };\n',
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
      localVersion: "0.15.1-copilot.9",
      requiredSkills: ["how"],
      forbiddenSkillFrontmatter: [],
      forbiddenContent: [{ pattern: "subagent_type", paths: ["skills"] }],
      excludedUpstreamPaths: [],
    }),
  );
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({
      version: "0.15.1-copilot.9",
    }),
  );
  writeFileSync(
    join(root, "NOTICE.md"),
    "0.15.1 base-sha target-sha content-sha",
  );
  writeFileSync(join(root, "README.md"), "- 1 Agent Skills\n");

  assert.deepEqual(
    checkRepository(root)
      .filter(({ code }) => code === "cursor-only-content")
      .map(({ path }) => path),
    ["skills/how/helper.mjs"],
  );
});
