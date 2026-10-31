import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const script = fileURLToPath(new URL("./guide.mjs", import.meta.url));

const config = JSON.parse(readFileSync(new URL("./hooks.json", import.meta.url), "utf8"));

function run(mode, input, env = process.env) {
  const result = spawnSync(process.execPath, [script, mode], { input, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);

  return JSON.parse(result.stdout);
}

function shell(command, toolName = "bash", extra = {}) {
  return run("shell", JSON.stringify({ toolName, toolArgs: { command }, ...extra }));
}

test("session guidance names uv commands and missing prerequisite", () => {
  const result = run("session", JSON.stringify({ source: "startup" }), { PATH: "" });
  assert.match(result.additionalContext, /uv was not found on PATH/);
  assert.match(result.additionalContext, /uv run python script\.py/);
  assert.match(result.additionalContext, /uv add package/);
  assert.match(result.additionalContext, /uv pip install package/);
  assert.match(result.additionalContext, /uv run pytest/);
  assert.match(result.additionalContext, /uv run ruff/);
  assert.match(result.additionalContext, /uvx tool/);
  assert.match(result.additionalContext, /uv tool install package/);
  assert.match(result.additionalContext, /may not include the project's packages/);
  assert.match(result.additionalContext, /Existing pipx installations are separate/);
  assert.match(result.additionalContext, /ask before installing/);
});

test("shell events give guidance for direct Python and pip commands", () => {
  for (const command of [
    "python script.py", "python3 -m pip install pytest", "pip install pytest",
    "cd src && python3.12 -m pytest", "FOO=bar pip3 install requests",
    "echo ok | python -m json.tool", "python -c 'print(1)'",
    "python <<'PY'\nprint('hello')\nPY",
    "python3 - <<EOF\nprint('hello')\nEOF",
  ]) {
    assert.match(shell(command).additionalContext, /Use uv for Python work/, command);
  }

  assert.match(shell("python script.py", "powershell").additionalContext, /uv run/);
  const result = run("shell", JSON.stringify({ toolName: "bash", toolArgs: JSON.stringify({ command: "pip install x" }) }));
  assert.match(result.additionalContext, /uv pip install/);
});

test("shell events guide pipx and project tools without matching uv invocations", () => {
  for (const command of [
    "pipx run ruff check .", "pipx install black", "pytest -q", "ruff check .",
    "cd src && pytest", "FOO=bar ruff format .",
  ]) {
    const result = shell(command);
    assert.match(result.additionalContext, /uvx tool/, command);
    assert.match(result.additionalContext, /uv run pytest/, command);
    assert.match(result.additionalContext, /uv run ruff/, command);
  }

  assert.match(shell("pipx run ruff", "powershell").additionalContext, /uvx tool/);
});

test("unrelated shell commands and unsupported tools get no feedback", () => {
  for (const command of [
    "uv run python script.py", "echo python", "echo 'x; python file.py'",
    "printf 'pip install x'", "grep python README.md", "pythonista test",
    "# python x\necho ok", "cat <<EOF\npython x\nEOF", "my-python script.py",
    "cat <<EOF\npython x\nEOF\npython x",
    "uvx ruff check .", "uv tool run pytest", "uv tool install black",
    "uv run pytest -q", "uv run ruff check .", "echo pipx pytest ruff",
    "ruffian check .", "pytest-helper", "pipx-wrapper",
  ]) {
    assert.deepEqual(shell(command), {}, command);
  }

  assert.deepEqual(shell("python x", "bash_extra"), {});
  assert.deepEqual(shell("python x", "edit"), {});

  for (const input of ["not-json", JSON.stringify({ toolName: "bash", toolArgs: "{invalid" })]) {
    const result = spawnSync(process.execPath, [script, "shell"], { input, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uv hook could not/);
  }
});

test("hook matcher is anchored to supported shell tools", () => {
  const matcher = new RegExp(config.hooks.postToolUse[0].matcher);

  for (const name of ["bash", "powershell"]) assert.equal(matcher.test(name), true);

  for (const name of ["bash_extra", "my_powershell", "edit"]) assert.equal(matcher.test(name), false);
  assert.equal(config.hooks.sessionStart[0].cwd, "${PLUGIN_ROOT}");
  assert.equal(config.hooks.postToolUse[0].cwd, "${PLUGIN_ROOT}");
});

test("configured commands execute from the plugin root", () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));

  for (const [hook, input] of [
    [config.hooks.sessionStart[0], { source: "startup" }],
    [config.hooks.subagentStart[0], { agentName: "explore" }],
    [config.hooks.postToolUse[0], { toolName: "bash", toolArgs: { command: "python example.py" } }],
  ]) {
    const command = process.platform === "win32" ? hook.powershell : hook.bash;
    const result = spawnSync(command, { cwd, shell: true, input: JSON.stringify(input), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).additionalContext, /Use uv for Python work/);
  }
});

test("failed shell commands receive recovery guidance through the failure hook", () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const hook = config.hooks.postToolUseFailure[0];
  const command = process.platform === "win32" ? hook.powershell : hook.bash;

  for (const attempted of ["python example.py", "pipx run ruff", "pytest", "ruff check ."]) {
    const input = JSON.stringify({ toolName: "bash", toolArgs: { command: attempted }, error: "command not found" });
    const result = spawnSync(command, { cwd, shell: true, input, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /uvx tool/);
    assert.match(result.stdout, /uv run python script\.py/);
  }

  assert.deepEqual(run("failure", JSON.stringify({ toolName: "edit", toolArgs: {} })), {});
});
