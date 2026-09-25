import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { guard } from "./guard.mjs";
import hooks from "./hooks.json" with { type: "json" };

const temporaryDirectories = [];

const hookScript = fileURLToPath(new URL("./guard.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anti-slop-hook-"));
  temporaryDirectories.push(directory);

  return directory;
}

function event(cwd, toolName, toolArgs) {
  return { cwd, toolName, toolArgs, sessionId: "test", timestamp: 0 };
}

describe("anti-slop preToolUse guard", () => {
  it("blocks new assertion chains and unknown aliases with remediation", async () => {
    const cwd = await workspace();

    const result = await guard(event(cwd, "create", {
      path: "src/types.ts",
      file_text: "type Json = unknown;\nconst value = input as unknown as Result;\n",
    }));

    assert.equal(result.permissionDecision, "deny");
    assert.match(result.permissionDecisionReason, /src\/types\.ts \[unknown-type-alias\]/);
    assert.match(result.permissionDecisionReason, /src\/types\.ts \[chained-assertion\]/);
    assert.match(result.permissionDecisionReason, /Parse the boundary value/);
    assert.match(result.permissionDecisionReason, /anti-slop skill/);
  });

  it("does not block legitimate unknowns, strings, or comments", async () => {
    const cwd = await workspace();

    const content = [
      "function parse(input: unknown): unknown {",
      "  // Avoid input as unknown as Result",
      "  const message = 'type Json = unknown';",
      "  /* type Json = unknown; */",
      "  return input;",
      "}",
    ].join("\n");

    assert.deepEqual(await guard(event(cwd, "create", { path: "src/parse.ts", content })), {});
  });

  it("checks only newly introduced lines in patch updates and ignores deleted files", async () => {
    const cwd = await workspace();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/old.ts"),
      "const existing = data as unknown as Existing;\nconst removed = data as unknown as Old;\n");

    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "@@",
      " const existing = data as unknown as Existing;",
      "-const removed = data as unknown as Old;",
      "+const revised = data;",
      "*** Delete File: src/deleted.ts",
      "-const deleted = data as unknown as Old;",
      "*** Add File: src/new.ts",
      "+const fresh = data as unknown as Fresh;",
      "*** End Patch",
    ].join("\n");

    const result = await guard(event(cwd, "apply_patch", { patch }));

    assert.equal(result.permissionDecision, "deny");
    assert.match(result.permissionDecisionReason, /src\/new\.ts \[chained-assertion\]/);
    assert.doesNotMatch(result.permissionDecisionReason, /src\/old\.ts|deleted\.ts/);
  });

  it("accepts patches that only remove slop", async () => {
    const cwd = await workspace();
    const patch = "*** Begin Patch\n*** Update File: src/old.ts\n@@\n-const x = value as unknown as Result;\n+const x = parse(value);\n*** End Patch";
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/old.ts"), "const x = value as unknown as Result;\n");

    assert.deepEqual(await guard(event(cwd, "apply_patch", patch)), {});
  });

  it("allows whitespace-only patch edits of existing findings", async () => {
    const cwd = await workspace();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/old.ts"), "const x = value as unknown as Result;\n");

    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "@@",
      "-const x = value as unknown as Result;",
      "+  const x = value as unknown as Result;",
      "*** End Patch",
    ].join("\n");

    assert.deepEqual(await guard(event(cwd, "apply_patch", { patch })), {});
  });

  it("checks only added replacement lines, not existing or moved lines", async () => {
    const cwd = await workspace();
    const oldString = "const old = x as unknown as Old;\nconst safe = 1;";
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/old.ts"), oldString);

    assert.deepEqual(await guard(event(cwd, "edit", {
      filePath: "src/old.ts",
      oldString,
      newString: "const safe = 1;\n  const old = x as unknown as Old;",
    })), {});

    const result = await guard(event(cwd, "str_replace_editor", {
      file_path: "src/old.ts",
      old_str: oldString,
      new_str: `${oldString}\nconst added = x as unknown as New;`,
    }));

    assert.equal(result.permissionDecision, "deny");
  });

  it("skips generated files, ignored directories, and non-source paths", async () => {
    const cwd = await workspace();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "generated.ts"), "// @generated\nexport const v = 1;");
    await writeFile(path.join(cwd, "src", "moved-generated.ts"), "// @generated\nexport const v = 1;");
    const bad = "const x = value as unknown as Result;";

    const patch = [
      "*** Begin Patch",
      "*** Add File: dist/bundle.ts",
      `+${bad}`,
      "*** Add File: README.md",
      `+${bad}`,
      "*** Add File: src/new-generated.ts",
      "+// @generated",
      `+${bad}`,
      "*** Update File: src/generated.ts",
      "@@",
      `+${bad}`,
      "*** Update File: src/moved-generated.ts",
      "*** Move to: src/moved.ts",
      "@@",
      `+${bad}`,
      "*** End Patch",
    ].join("\n");

    assert.deepEqual(await guard(event(cwd, "apply_patch", { patch })), {});
    assert.deepEqual(await guard(event(cwd, "create", {
      path: path.join(cwd, "..", "outside.ts"),
      content: bad,
    })), {});
  });

  it("uses surrounding lexical context, masking regex literals and scanning template expressions", async () => {
    const cwd = await workspace();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/comment.ts"), "/* start\n");
    await writeFile(path.join(cwd, "src/regex.ts"), "const matcher = /old/;\n");
    await writeFile(path.join(cwd, "src/template.ts"), "const text = `${old}`;\n");

    assert.deepEqual(await guard(event(cwd, "edit", {
      path: "src/comment.ts", old_str: "/* start\n",
      new_str: "/* start\ntype Json = unknown;\n",
    })), {});

    assert.deepEqual(await guard(event(cwd, "edit", {
      path: "src/regex.ts", old_str: "/old/", new_str: "/as unknown as Result/",
    })), {});

    assert.deepEqual(await guard(event(cwd, "create", {
      path: "src/mixed.ts",
      content: "const emoji = '🎃';\nconst regex = /[as unknown as Result]/;\n",
    })), {});

    const result = await guard(event(cwd, "edit", {
      path: "src/template.ts", old_str: "${old}", new_str: "${value as unknown as Result}",
    }));

    assert.equal(result.permissionDecision, "deny");
  });

  it("does not inspect files through directory symlinks", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await symlink(outside, path.join(cwd, "link"), "dir");
    await writeFile(path.join(outside, "file.ts"), "const value = 1;");

    assert.deepEqual(await guard(event(cwd, "edit", {
      path: "link/file.ts", old_str: "const value = 1;",
      new_str: "const value = x as unknown as Result;",
    })), {});
    assert.deepEqual(await guard(event(cwd, "create", {
      path: "link/new.ts",
      file_text: "const value = x as unknown as Result;",
    })), {});
  });

  it("emits CLI decision JSON and fails explicitly on unsupported payloads", async () => {
    const cwd = await workspace();
    assert.equal(hooks.version, 1);
    assert.equal(hooks.hooks.preToolUse[0].cwd, "${PLUGIN_ROOT}");
    assert.match(hooks.hooks.preToolUse[0].matcher, /apply_patch/);

    const denied = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify(event(cwd, "create", {
        path: "src/test.ts",
        content: "const x = value as unknown as Result;",
      })),
      encoding: "utf8",
    });

    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).permissionDecision, "deny");

    const unsupported = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify(event(cwd, "edit", { path: "src/test.ts" })),
      encoding: "utf8",
    });

    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /no readable replacement text/);
  });
});
