import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validatePlanText } from "../skills/poteto-mode/scripts/plan-rules.mjs";

const playbook = readFileSync(
  new URL("../skills/poteto-mode/playbooks/multi-phase-plan.md", import.meta.url),
  "utf8",
);

const template = playbook.split("````markdown\n")[1]?.split("\n````")[0];

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
  const line = template.split("\n").indexOf("## Program checklist") + 1;
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
  const line = template.split("\n").indexOf("## Program checklist") + 1;

  for (const unrelated of [
    "- [ ] Reconcile hourly billing.",
    "- [ ] Reconcile 30-minute billing.",
    "```text\nhourly audit tick\n```",
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
});

test("the shipped bundle validates both cadences through its native tools", {
  skip: !["darwin", "linux"].includes(process.platform),
}, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-bundle-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const path = join(root, "plan.md");
  const entry = new URL("../extensions/pstack/extension.mjs", import.meta.url).href;

  const host = `
    import { registerHooks } from "node:module";
    const sdk = \`
      export const defineWorkflow = (value) => value;
      export async function joinSession(options) {
        const results = {};
        for (const name of ["pstack_validate_plan", "pstack_validate_artifact"]) {
          const tool = options.tools.find((item) => item.name === name);
          const args = name === "pstack_validate_plan"
            ? { plan_path: process.argv[2] }
            : { kind: "plan", path: process.argv[2] };
          const result = JSON.parse(await tool.handler(args));
          results[name] = { ok: result.ok, findings: result.findings };
        }
        console.log(JSON.stringify(results));
        return { log: async () => {} };
      }
    \`;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@github/copilot-sdk/extension") {
          return { url: "data:text/javascript," + encodeURIComponent(sdk), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    await import(process.argv[1]);
  `;

  const line = template.split("\n").indexOf("## Program checklist") + 1;

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
  ]) {
    writeFileSync(path, plan);

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", host, entry, path], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      pstack_validate_plan: expected,
      pstack_validate_artifact: expected,
    });
  }
});
