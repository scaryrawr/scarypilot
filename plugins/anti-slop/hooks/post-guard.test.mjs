import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import hooks from "./hooks.json" with { type: "json" };
import genericBundle from "../dist/anti-slop.mjs";
import effectBundle from "../dist/anti-slop-effect.mjs";
import genericConfig from "../oxlint.config.mjs";
import effectConfig from "../oxlint-effect.config.mjs";
import { reviewEdit as reviewWithLint } from "./post-guard.mjs";
import { lintFile } from "./oxlint-runtime.mjs";

const temporaryDirectories = [];

const script = fileURLToPath(new URL("./post-guard.mjs", import.meta.url));

const localOxlint = fileURLToPath(new URL("../../../node_modules/oxlint/bin/oxlint", import.meta.url));

function reviewEdit(input) {
  return reviewWithLint(input, { lint: async () => [] });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anti-slop-post-"));
  temporaryDirectories.push(directory);

  return directory;
}

function event(cwd, toolName, toolArgs) {
  return {
    cwd, toolName, toolArgs,
    sessionId: "test",
    timestamp: 0,
    toolResult: { resultType: "success", textResultForLlm: "file written" },
  };
}

async function source(cwd, file, text) {
  const target = path.join(cwd, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}

describe("anti-slop postToolUse advisory", () => {
  it("flags newly created generic record predicates regardless of helper name", async () => {
    const cwd = await workspace();

    const text = [
      "function isCustomerRecord(value: unknown): value is Record<string, unknown> {",
      '  return typeof value === "object" && value !== null;',
      "}",
    ].join("\n");

    await source(cwd, "src/customer.ts", text);

    const result = await reviewEdit(event(cwd, "create", {
      path: "src/customer.ts",
      file_text: text,
    }));

    assert.match(result.additionalContext, /src\/customer\.ts:1/);
    assert.match(result.additionalContext, /generic record type predicate/);
    assert.match(result.additionalContext, /real I\/O boundary/);
    assert.equal(result.permissionDecision, undefined);
    assert.equal(result.modifiedResult, undefined);
  });

  it("recognizes multiline predicates without relying on an isRecord name", async () => {
    const cwd = await workspace();

    const text = [
      "const parsesObject = (value: unknown):",
      "  value is Record<PropertyKey, unknown> =>",
      '  typeof value === "object" && value !== null;',
    ].join("\n");

    await source(cwd, "src/object.ts", text);

    const result = await reviewEdit(event(cwd, "create", {
      path: "src/object.ts",
      file_text: text,
    }));

    assert.match(result.additionalContext, /src\/object\.ts:2/);
  });

  it("recognizes an is*Record wrapper with a generic object check in JavaScript", async () => {
    const cwd = await workspace();
    const text = 'const isPayloadRecord = (value) => typeof value === "object" && value !== null;';
    await source(cwd, "src/guard.js", text);

    const result = await reviewEdit(event(cwd, "create", {
      path: "src/guard.js",
      content: text,
    }));

    assert.match(result.additionalContext, /generic object guard isPayloadRecord/);
  });

  it("does not repeat advice for existing helpers on unrelated edits", async () => {
    const cwd = await workspace();
    const existing = "function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object'; }";
    await source(cwd, "src/index.ts", `${existing}\nconst added = 1;\n`);

    const result = await reviewEdit(event(cwd, "edit", {
      path: "src/index.ts",
      old_str: "const added = 0;",
      new_str: "const added = 1;",
    }));

    assert.deepEqual(result, {});
  });

  it("advises on new helpers in an edited file with surrounding context", async () => {
    const cwd = await workspace();
    const old = "const existing = 1;";
    const added = "function isOrderRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object'; }";
    await source(cwd, "src/orders.ts", `${old}\n${added}\n`);

    const result = await reviewEdit(event(cwd, "edit", {
      path: "src/orders.ts",
      old_str: old,
      new_str: `${old}\n${added}`,
    }));

    assert.match(result.additionalContext, /src\/orders\.ts:2/);
    assert.equal((result.additionalContext.match(/src\/orders\.ts:2/g) ?? []).length, 1);
  });

  it("ignores strings, comments, generated files, and unrelated output", async () => {
    const cwd = await workspace();
    const comment = "// function isRecord(v: unknown): v is Record<string, unknown> {}";
    await source(cwd, "src/comment.ts", comment);
    assert.deepEqual(await reviewEdit(event(cwd, "create", {
      path: "src/comment.ts", file_text: comment,
    })), {});

    const generated = "// @generated\nfunction isRecord(v: unknown): v is Record<string, unknown> {}";
    await source(cwd, "src/generated.ts", generated);
    assert.deepEqual(await reviewEdit(event(cwd, "create", {
      path: "src/generated.ts", file_text: generated,
    })), {});

    const guard = "function isRecord(v: unknown): v is Record<string, unknown> {}";
    await source(cwd, "dist/output.ts", guard);
    assert.deepEqual(await reviewEdit(event(cwd, "create", {
      path: "dist/output.ts", file_text: guard,
    })), {});
  });

  it("registers every generic and optional Effect rule", () => {
    assert.deepEqual(Object.keys(genericConfig.rules).sort(), [
      "oxc/no-accumulating-spread",
      ...Object.keys(genericBundle.rules).map((rule) => `anti-slop/${rule}`),
    ].sort());
    assert.deepEqual(Object.keys(effectConfig.rules).sort(), [
      ...Object.keys(genericConfig.rules),
      ...Object.keys(effectBundle.rules).map((rule) => `anti-slop-effect/${rule}`),
    ].sort());
    assert.equal(genericConfig.jsPlugins[0].name, "anti-slop");
    assert.equal(effectConfig.jsPlugins[1].name, "anti-slop-effect");
    assert.equal(hooks.hooks.postToolUse[0].timeoutSec, 120);
  });

  it("runs the bundled Oxlint rules on edited code in an unrelated workspace", async () => {
    const cwd = await workspace();

    const text = [
      "export function parse(value: unknown) {",
      "  const result = value as unknown as string;",
      "  return result;",
      "}",
    ].join("\n");

    await source(cwd, "src/parse.ts", text);

    const result = await reviewWithLint(event(cwd, "create", {
      path: "src/parse.ts", file_text: text,
    }), {
      lint: (file, root, options) => lintFile(file, root, { ...options, executable: localOxlint }),
    });

    assert.match(result.additionalContext, /anti-slop\(no-chained-type-assertions\)/);
    assert.match(result.additionalContext, /anti-slop\(no-unknown-parameters\)/);
    assert.doesNotMatch(result.additionalContext, /eslint\(no-unused-vars\)/);
  });

  it("reports multi-line findings when the new code is inside the diagnostic span", async () => {
    const cwd = await workspace();
    const before = "  .slice()";
    const after = "  .map(x => x * 2)";

    const text = [
      "const values: number[] = [1, 2];",
      "",
      "export const result = values",
      "  .filter(x => x > 0)",
      `${after};`,
    ].join("\n");

    await source(cwd, "src/chain.ts", text);

    const result = await reviewWithLint(event(cwd, "edit", {
      path: "src/chain.ts",
      old_str: `${before};`,
      new_str: `${after};`,
    }), {
      lint: (file, root, options) => lintFile(file, root, { ...options, executable: localOxlint }),
    });

    assert.match(result.additionalContext, /src\/chain\.ts:5 anti-slop\(no-array-filter-map\)/);
  });

  it("reports native and Effect-specific findings only when enabled", async () => {
    const cwd = await workspace();
    const file = path.join(cwd, "src", "effect.ts");
    const text = 'export const tag = error._tag === "Bad";';
    await source(cwd, "src/effect.ts", text);

    const regular = await lintFile(file, cwd, { executable: localOxlint });
    const effect = await lintFile(file, cwd, { effect: true, executable: localOxlint });

    assert.equal(regular.some((finding) => finding.code.startsWith("anti-slop-effect(")), false);
    assert.equal(effect.some((finding) => finding.code === "anti-slop-effect(no-manual-tag-comparison)"), true);
  });

  it("includes Oxlint's native accumulating-spread rule", async () => {
    const cwd = await workspace();
    const file = path.join(cwd, "src", "native.ts");
    await source(cwd, "src/native.ts", "export const merged = [1, 2].reduce((acc, x) => ({ ...acc, [x]: x }), {});");

    const findings = await lintFile(file, cwd, { executable: localOxlint });

    assert.equal(findings.some((finding) => finding.code === "oxc(no-accumulating-spread)"), true);
  });

  it("does not surface legacy diagnostics on an unrelated edit", async () => {
    const cwd = await workspace();
    const old = "const result = value as unknown as string;";
    await source(cwd, "src/legacy.ts", `${old}\n\nexport const added = 1;\n`);

    const result = await reviewWithLint(event(cwd, "edit", {
      path: "src/legacy.ts",
      old_str: "export const added = 0;",
      new_str: "export const added = 1;",
    }), {
      lint: (file, root, options) => lintFile(file, root, { ...options, executable: localOxlint }),
    });

    assert.deepEqual(result, {});
  });

  it("selects Effect rules from the nearest package manifest", async () => {
    const cwd = await workspace();
    const file = path.join(cwd, "packages", "app", "src", "example.ts");

    await source(cwd, "packages/app/package.json", JSON.stringify({
      dependencies: { effect: "3.0.0" },
    }));
    await source(cwd, "packages/app/src/example.ts", 'export const tag = error._tag === "Bad";');

    const selections = [];
    await reviewWithLint(event(cwd, "create", {
      path: file,
      file_text: 'export const tag = error._tag === "Bad";',
    }), {
      lint: async (_file, _root, options) => {
        selections.push(options.effect);

        return [];
      },
    });

    assert.deepEqual(selections, [true]);
  });

  it("emits additionalContext from the configured command hook", async () => {
    const cwd = await workspace();
    const text = "function isDataRecord(v: unknown): v is Record<string, unknown> { return true; }";
    await source(cwd, "src/check.ts", text);
    assert.equal(hooks.hooks.postToolUse[0].cwd, "${PLUGIN_ROOT}");
    assert.match(hooks.hooks.postToolUse[0].matcher, /edit/);

    const command = spawnSync(process.execPath, [script], {
      input: JSON.stringify(event(cwd, "create", {
        path: "src/check.ts", file_text: text,
      })),
      encoding: "utf8",
      env: {
        ...process.env,
        COPILOT_HOME: path.join(cwd, "home"),
      },
    });

    assert.equal(command.status, 0, command.stderr);
    assert.match(JSON.parse(command.stdout).additionalContext, /src\/check\.ts:1/);
  });

  it("reports bootstrap failures instead of claiming the file is clean", async () => {
    const cwd = await workspace();
    const text = "export const value = 1;";
    await source(cwd, "src/no-npm.ts", text);

    const command = spawnSync(process.execPath, [script], {
      input: JSON.stringify(event(cwd, "create", {
        path: "src/no-npm.ts", file_text: text,
      })),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        COPILOT_HOME: path.join(cwd, "home"),
      },
    });

    assert.equal(command.status, 0, command.stderr);
    assert.match(JSON.parse(command.stdout).additionalContext, /checks could not run.*npm and registry access/);
  });
});
