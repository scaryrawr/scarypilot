import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validatePlanText } from "../skills/poteto-mode/scripts/plan-rules.mjs";

const playbook = readFileSync(
  new URL("../skills/poteto-mode/playbooks/multi-phase-plan.md", import.meta.url),
  "utf8",
);

function planTemplate(text) {
  const template = text.split(/````markdown\r?\n/)[1]?.split(/\r?\n````/)[0];
  assert.equal(typeof template, "string", "the playbook must contain a fenced Markdown plan");

  return template;
}

const template = planTemplate(playbook);

const fencedCadences = [
  "```text\nhourly audit tick\n```",
  "   ```text\nhourly audit tick\n   ```",
  "~~~text\nhourly audit tick\n~~~",
  "   ~~~text\nhourly audit tick\n   ~~~",
  "````text\n```\nhourly audit tick\n````",
  "~~~text\n```\nhourly audit tick\n~~~",
  "```text\n~~~\nhourly audit tick\n```",
  "```text\n```not-a-close\nhourly audit tick\n```",
];

for (const [label, newline] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`the ${label} playbook yields a plan with stable validation and CLI diagnostics`, (t) => {
    const plan = planTemplate(playbook.replace(/\r?\n/g, newline));
    const line = plan.split(/\r?\n/).indexOf("## Program checklist") + 1;
    assert.ok(line > 0);
    assert.deepEqual(validatePlanText(plan, "verified-stack").findings, []);
    const missing = plan.replace("hourly audit tick", "audit tick");
    assert.deepEqual(validatePlanText(missing, "verified-stack").findings, [{
      line,
      rule: "audit-cadence",
      message: 'Program checklist needs "hourly" or "30-minute" on the audit tick or status message line',
    }]);
    const root = mkdtempSync(join(process.cwd(), ".pstack-plan-newlines-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "plan.md");
    const cli = fileURLToPath(new URL("../skills/poteto-mode/scripts/check-plan.mjs", import.meta.url));
    writeFileSync(path, plan);
    const valid = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /\n0 problems\n$/);
    writeFileSync(path, missing);
    const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`:${line}: \\[audit-cadence\\]`));
  });
}

test("the shipped hourly plan skeleton passes verified-stack validation", () => {
  assert.equal(typeof template, "string");
  assert.match(template, /hourly audit tick/);
  assert.deepEqual(validatePlanText(template, "verified-stack").findings, []);
});

test("saved 30-minute plans remain valid", () => {
  const legacy = template.replace("hourly audit tick", "30-minute audit tick");
  assert.deepEqual(validatePlanText(legacy, "verified-stack").findings, []);
});

test("a plan without an audit cadence fails with an actionable finding", () => {
  const missingCadence = template.replace("hourly audit tick", "audit tick");
  const line = template.split(/\r?\n/).indexOf("## Program checklist") + 1;
  assert.deepEqual(validatePlanText(missingCadence, "verified-stack").findings, [
    {
      line,
      rule: "audit-cadence",
      message: 'Program checklist needs "hourly" or "30-minute" on the audit tick or status message line',
    },
  ]);
});

test("unrelated or fenced cadence text cannot schedule an audit", () => {
  const missing = template.replace("hourly audit tick", "audit tick");
  const line = template.split(/\r?\n/).indexOf("## Program checklist") + 1;

  for (const unrelated of [
    "- [ ] Reconcile hourly billing.",
    "- [ ] Reconcile 30-minute billing.",
    ...fencedCadences,
  ]) {
    const misleading = missing.replace("### Spawn owners", `${unrelated}\n\n### Spawn owners`);
    assert.deepEqual(validatePlanText(misleading, "verified-stack").findings, [{
      line,
      rule: "audit-cadence",
      message: 'Program checklist needs "hourly" or "30-minute" on the audit tick or status message line',
    }]);
  }
});

test("the CLI accepts the shipped skeleton and rejects a missing cadence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const path = join(root, "plan.md");

  const cli = fileURLToPath(
    new URL("../skills/poteto-mode/scripts/check-plan.mjs", import.meta.url),
  );

  writeFileSync(path, template);
  const valid = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /\n0 problems\n$/);
  assert.equal(valid.stderr, "");

  writeFileSync(path, template.replace("hourly audit tick", "audit tick"));
  const invalid = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /\n1 problems\n$/);
  assert.match(invalid.stderr, /\[audit-cadence\] Program checklist needs/);

  writeFileSync(path, template.replace("hourly audit tick", "audit tick")
    .replace("### Spawn owners", "- [ ] Reconcile hourly billing.\n\n### Spawn owners"));
  const misleading = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
  assert.equal(misleading.status, 1);
  assert.match(misleading.stdout, /\n1 problems\n$/);
  assert.match(misleading.stderr, /\[audit-cadence\] Program checklist needs/);

  for (const fenced of fencedCadences) {
    writeFileSync(path, template.replace("hourly audit tick", "audit tick")
      .replace("### Spawn owners", `${fenced}\n\n### Spawn owners`));
    const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
    assert.equal(result.status, 1, fenced);
    assert.match(result.stdout, /\n1 problems\n$/);
    assert.match(result.stderr, /\[audit-cadence\] Program checklist needs/);
  }
});

test("the portable artifact CLI validates both cadences with the shared rules", {
  skip: !["darwin", "linux"].includes(process.platform),
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-artifact-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const path = join(root, "plan.md");
  const cli = fileURLToPath(new URL("../skills/pstack-schema-validate/scripts/validate.mjs", import.meta.url));

  const line = template.split(/\r?\n/).indexOf("## Program checklist") + 1;

  const failure = {
    ok: false,
    findings: [{
      line,
      rule: "audit-cadence",
      message: 'Program checklist needs "hourly" or "30-minute" on the audit tick or status message line',
    }],
  };

  for (const [plan, expected] of [
    [template, { ok: true, findings: [] }],
    [template.replace("hourly audit tick", "30-minute audit tick"), { ok: true, findings: [] }],
    [template.replace("hourly audit tick", "audit tick"), failure],
    [template.replace("hourly audit tick", "audit tick")
      .replace("### Spawn owners", "- [ ] Reconcile hourly billing.\n\n### Spawn owners"), failure],
    ...fencedCadences.map((fenced) => [
      template.replace("hourly audit tick", "audit tick")
        .replace("### Spawn owners", `${fenced}\n\n### Spawn owners`),
      failure,
    ]),
  ]) {
    writeFileSync(path, plan);

    const result = spawnSync(process.execPath, [cli, "plan", "plan.md", "verified-stack"], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(result.status, expected.ok ? 0 : 1, result.stderr);
    assert.equal(result.stdout, expected.ok ? "plan contract valid: plan.md\n" : "");
    assert.equal(result.stderr, expected.findings.map((finding) =>
      `plan.md:${finding.line}: [${finding.rule}] ${finding.message}\n`
    ).join(""));
  }
});
