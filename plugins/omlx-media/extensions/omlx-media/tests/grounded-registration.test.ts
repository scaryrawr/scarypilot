import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("entrypoint attaches legacy tools, both restricted agents and the native workflow in one joinSession call", () => {
  const sdk = import.meta.resolve("@github/copilot-sdk/extension");
  const entry = new URL("../src/extension.ts", import.meta.url).href;

  const mock = `
    export { defineWorkflow } from ${JSON.stringify(sdk)};
    export async function joinSession(options) {
      console.log(JSON.stringify({
        tools: options.tools.map(tool => tool.name),
        agents: options.customAgents,
        workflows: options.workflows.map(workflow => workflow.meta)
      }));
    }
  `;

  const script = `
    import { registerHooks } from 'node:module';
    const mock = ${JSON.stringify(`data:text/javascript;base64,${Buffer.from(mock).toString("base64")}`)};
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@github/copilot-sdk/extension') return {url: mock, shortCircuit: true};
      return next(specifier, context);
    }});
    await import(${JSON.stringify(entry)});
  `;

  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const joins = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(joins.length, 1);
  assert.deepEqual(joins[0].tools, ["omlx_image", "omlx_speech", "omlx_transcribe", "omlx_prepare_frames"]);
  assert.deepEqual(joins[0].agents.map((agent: { name: string; tools: string[]; infer: boolean }) => ({
    name: agent.name, tools: agent.tools, infer: agent.infer,
  })), [
    { name: "blogify-grounded-writer", tools: [], infer: false },
    { name: "blogify-grounded-checker", tools: [], infer: false },
  ]);
  assert.equal(joins[0].workflows.length, 1);
  const workflow = joins[0].workflows[0];
  assert.equal(workflow.name, "blogify-grounded-note");
  assert.deepEqual(workflow.limits, { maxTotalSubagents: 2, maxConcurrentSubagents: 1 });
  assert.deepEqual(workflow.argsSchema.required, ["manifest", "expected_manifest_sha256", "allow_agent_transmission", "intent"]);
  assert.equal(new Set(workflow.phases.map((phase: { title: string }) => phase.title)).size, 4);
});
