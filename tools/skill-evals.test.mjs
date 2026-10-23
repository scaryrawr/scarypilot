import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { coverageReport, inventory, loadPolicy, parseDiff, selectSkills, validatePolicyCoverage } from "./skill-evals.mjs";

const policy = {
  version: 1,
  execution: "approval-required",
  sharedDependencies: [{ source: "external_plugins/pstack/skills/", consumers: ["external_plugins/pstack/skills/"], reason: "Sibling routing" }],
  offlineSuites: [{ skill: "plugins/sample/skills/sample", taskIds: [7], triggerIndexes: [0] }],
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-coverage-"));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

async function put(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

async function sample(root) {
  const skill = "plugins/sample/skills/sample";

  await put(root, `${skill}/SKILL.md`, "---\nname: sample\ndescription: Generate a greeting.\n---\n# Sample\n");
  await put(root, `${skill}/evals/evals.json`, JSON.stringify({
    skill_name: "sample",
    evals: [{ id: 7, prompt: "Write a greeting.", expected_output: "A greeting.", expectations: ["It greets the reader."], files: ["evals/files/input.txt"] }],
  }));
  await put(root, `${skill}/evals/trigger-evals.json`, JSON.stringify([{ query: "Write a greeting.", should_trigger: true }]));
  await put(root, `${skill}/evals/files/input.txt`, "Hello");
  await put(root, "tools/skill-evals/policy.json", JSON.stringify(policy));

  return skill;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

test("inventory validates fixture-backed suites without model access", async (t) => {
  const root = await fixture(t);
  const skill = await sample(root);
  const skills = await inventory(root);
  const selected = selectSkills(skills, [`${skill}/SKILL.md`], await loadPolicy(root));

  assert.equal(skills.length, 1);
  assert.equal(selected[0].status, "not_run");
  assert.equal(selected[0].coverage, "cases_available");
  assert.deepEqual(selected[0].runnable, { taskIds: [7], triggerIndexes: [0] });
  assert.equal(selected[0].excludedCases, 0);
});

test("a missing fixture fails safe validation", async (t) => {
  const root = await fixture(t);
  const skill = await sample(root);

  await rm(path.join(root, `${skill}/evals/files/input.txt`));
  await assert.rejects(inventory(root), /ENOENT/);
});

test("trigger fixtures validate presence, confinement, format and collisions", async (t) => {
  const root = await fixture(t);
  const skill = await sample(root);
  const suitePath = `${skill}/evals/trigger-evals.json`;

  await put(root, `${skill}/evals/files/AGENTS.md`, "# Fixture guidance\n");
  await put(root, suitePath, JSON.stringify([{ query: "Explain AGENTS.md without edits.", should_trigger: false, files: ["evals/files/AGENTS.md"] }]));
  assert.equal((await inventory(root))[0].triggerCount, 1);

  for (const [files, message] of [
    ["AGENTS.md", /Invalid trigger fixtures/],
    [["evals/files/missing.md"], /ENOENT/],
    [["../AGENTS.md"], /Noncanonical path/],
    [["SKILL.md"], /Invalid trigger fixture path/],
    [["evals/files/input.txt"], /visible Markdown files/],
    [["evals/files/AGENTS.md", "evals/files/AGENTS.md"], /Colliding trigger fixture names/],
  ]) {
    await put(root, suitePath, JSON.stringify([{ query: "Explain guidance.", should_trigger: false, files }]));
    await assert.rejects(inventory(root), message);
  }

  await symlink(path.join(root, "tools/skill-evals/policy.json"), path.join(root, `${skill}/evals/files/linked.md`));
  await put(root, suitePath, JSON.stringify([{ query: "Explain guidance.", should_trigger: false, files: ["evals/files/linked.md"] }]));
  await assert.rejects(inventory(root), /Symlinks are not allowed/);
});

test("fixture escapes and duplicate flattened names are rejected", async (t) => {
  const root = await fixture(t);
  const skill = await sample(root);
  const filename = `${skill}/evals/evals.json`;
  const suite = JSON.parse(await readFile(path.join(root, filename), "utf8"));

  suite.evals[0].files = ["../outside.txt"];
  await put(root, filename, JSON.stringify(suite));
  await assert.rejects(inventory(root), /Noncanonical path/);

  suite.evals[0].files = ["evals/files/input.txt", "other/input.txt"];
  await put(root, filename, JSON.stringify(suite));
  await assert.rejects(inventory(root), /Colliding fixture names/);
});

test("nested fixture symlinks never read outside files", async (t) => {
  const root = await fixture(t);
  const skill = await sample(root);
  const file = path.join(root, `${skill}/evals/files/input.txt`);

  await rm(file);
  await symlink(path.join(root, "tools/skill-evals/policy.json"), file);
  await assert.rejects(inventory(root), /Symlinks are not allowed/);
});

test("duplicate ids and malformed trigger cases fail inventory", async (t) => {
  const root = await fixture(t);
  const skill = await sample(root);
  const filename = `${skill}/evals/evals.json`;
  const suite = JSON.parse(await readFile(path.join(root, filename), "utf8"));

  suite.evals.push(suite.evals[0]);
  await put(root, filename, JSON.stringify(suite));
  await assert.rejects(inventory(root), /duplicate task id/);

  suite.evals.pop();
  await put(root, filename, JSON.stringify(suite));
  await put(root, `${skill}/evals/trigger-evals.json`, '[{"query":"Hi","should_trigger":"yes"}]');
  await assert.rejects(inventory(root), /Invalid trigger case/);
});

test("policy cannot silently authorize execution or unknown cases", async (t) => {
  const root = await fixture(t);

  await sample(root);

  const skills = await inventory(root);
  const invalid = structuredClone(policy);

  invalid.offlineSuites[0].taskIds = [99];
  assert.throws(() => validatePolicyCoverage(skills, invalid), /missing task/);
  invalid.execution = "automatic";
  await put(root, "tools/skill-evals/policy.json", JSON.stringify(invalid));
  await assert.rejects(loadPolicy(root), /execution grant/);
});

test("selection widens shared inputs and reports missing coverage", () => {
  const skills = [
    { name: "first", path: "external_plugins/pstack/skills/first", pluginPath: "external_plugins/pstack", taskIds: [], triggerCount: 0 },
    { name: "second", path: "external_plugins/pstack/skills/second", pluginPath: "external_plugins/pstack", taskIds: [], triggerCount: 1 },
    { name: "other", path: "plugins/other/skills/other", pluginPath: "plugins/other", taskIds: [], triggerCount: 0 },
  ];

  assert.equal(selectSkills(skills, ["README.md"], policy).length, 0);
  assert.equal(selectSkills(skills, ["AGENTS.md"], policy).length, 3);
  assert.equal(selectSkills(skills, ["external_plugins/pstack/plugin.json"], policy).length, 2);

  const selected = selectSkills(skills, ["external_plugins/pstack/skills/first/playbooks/shared.md"], policy);

  assert.equal(selected.length, 2);
  assert.equal(selected[0].coverage, "missing_evals");
  assert.equal(selected[1].excludedCases, 1);
  assert.equal(selected[1].status, "not_run");
  assert.match(selected[1].reasons[0], /Sibling routing/);
});

test("NUL-delimited diffs preserve spaces, newlines, rename origins, and deletions", () => {
  assert.deepEqual(parseDiff("R100\0old name/SKILL.md\0new\nname/SKILL.md\0D\0deleted/SKILL.md\0"), [
    "deleted/SKILL.md", "new\nname/SKILL.md", "old name/SKILL.md",
  ]);
  assert.throws(() => parseDiff("M\0../outside\0"), /Noncanonical/);
  assert.throws(() => parseDiff("M\0"), /relative path/);
});

test("explicit refs select committed changes and local mode includes untracked cases", async (t) => {
  const root = await fixture(t);
  const skill = await sample(root);

  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Initial fixture");

  const base = git(root, "rev-parse", "HEAD");
  const empty = await coverageReport(root, base, "HEAD");

  assert.equal(empty.behavioralStatus, "not_applicable");
  await put(root, `${skill}/references/context.md`, "A new instruction.");

  const local = await coverageReport(root, base);

  assert.equal(local.behavioralStatus, "not_run");
  assert.equal(local.proposedExecution.maxCalls, 2);
  assert.equal(local.proposedExecution.model, null);
  assert.equal(local.proposedExecution.approvalRequired, true);
  await assert.rejects(coverageReport(root, base, "HEAD"), /untracked eval inputs/);

  git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Change instructions");
  assert.equal((await coverageReport(root, base, "HEAD")).selected.length, 1);
  await assert.rejects(coverageReport(root, base, base), /checked-out HEAD/);

  await put(root, `${skill}/SKILL.md`, "---\nname: sample\ndescription: Local edit.\n---\n");
  await assert.rejects(coverageReport(root, base, "HEAD"), /clean tracked worktree/);
  git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Record local instruction edit");

  git(root, "rm", "-qr", "plugins");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Remove skill");
  await put(root, "tools/skill-evals/policy.json", JSON.stringify({ ...policy, offlineSuites: [] }));

  const removed = await coverageReport(root, base);

  assert.deepEqual(removed.removedSkills, [skill]);
});
