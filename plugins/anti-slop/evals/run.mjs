#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cases } from "./cases.mjs";
import { lintFile } from "../hooks/oxlint-runtime.mjs";

const execFile = promisify(execFileCallback);

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

const grader = fileURLToPath(new URL("./grade-case.mjs", import.meta.url));

const localOxlint = path.join(repositoryRoot, "node_modules", "oxlint", "bin", "oxlint");

const editingTools = new Set(["create", "edit", "apply_patch", "str_replace_editor"]);

function parseOptions(args) {
  const options = { cases, repeats: 1, mode: "both", timeoutMs: 180_000 };

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];

    if (flag === "--list") {
      options.list = true;
      continue;
    }

    const value = args[++index];

    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);

    switch (flag) {
      case "--case": {
        const selected = cases.find((item) => item.id === value);

        if (!selected) throw new Error(`Unknown case: ${value}`);
        options.cases = [selected];
        break;
      }

      case "--repeats":
        options.repeats = Number(value);

        if (!Number.isSafeInteger(options.repeats) || options.repeats < 1) {
          throw new Error("--repeats must be a positive integer");
        }

        break;
      case "--mode":
        if (!["both", "on", "off"].includes(value)) throw new Error(`Unknown mode: ${value}`);
        options.mode = value;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(value);

        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
          throw new Error("--timeout-ms must be at least 1000");
        }

        break;
      case "--model":
        options.model = value;
        break;
      case "--output":
        options.output = path.resolve(value);
        break;
      case "--trace-dir":
        options.traceDir = path.resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return options;
}

export function feedbackFromTrace(jsonl) {
  const tools = new Map();
  const feedback = { denials: 0, advisories: 0, failures: 0, edits: 0, legacyWarnings: 0, models: [] };

  for (const line of jsonl.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);

    if (event.type === "assistant.message") {
      if (event.data?.model && !feedback.models.includes(event.data.model)) {
        feedback.models.push(event.data.model);
      }

      for (const request of event.data?.toolRequests ?? []) {
        tools.set(request.toolCallId, request.name);
      }
    }

    if (event.type !== "tool.execution_complete") continue;

    if (!editingTools.has(tools.get(event.data?.toolCallId))) continue;

    feedback.edits++;
    const denial = event.data?.error?.message ?? "";
    const result = event.data?.result?.content ?? "";

    if (denial.startsWith("Denied by preToolUse hook: Anti-Slop rejected")) feedback.denials++;

    if (result.includes("Anti-Slop advisory on newly edited code:")) feedback.advisories++;

    if (result.includes("Anti-Slop full checks could not run:")) feedback.failures++;

    if (result.includes("anti-slop(no-chained-type-assertions)")) feedback.legacyWarnings++;
  }

  return feedback;
}

export function deliveredOnDraft(testCase, draftFeedback) {
  if (!draftFeedback) return false;

  if (testCase.expectedFeedback === "denial") return draftFeedback.denials > 0;

  if (testCase.expectedFeedback === "advisory") return draftFeedback.advisories > 0;

  return false;
}

export function sourceChecks(testCase, source, diagnostics) {
  const codes = new Set(diagnostics.map((item) => item.code));
  const genericGuard = /\bfunction\s+is[\w$]*(?:Record|Object)\s*\(|\b(?:const|let)\s+is[\w$]*(?:Record|Object)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;

  const noGenericRecord = !genericGuard.test(source) &&
    !/\bRecord\s*<\s*(?:string|PropertyKey)\s*,\s*(?:unknown|any)\s*>/.test(source);

  switch (testCase.id) {
    case "pre-edit-recovery":
      return {
        noAssertionChain: !/\bas\s+unknown\s+as\b/.test(source),
        noUnknownAlias: !/\btype\s+\w+\s*=\s*unknown\b/.test(source),
      };
    case "post-edit-recovery":
      return { noFilterMapDiagnostic: !codes.has("anti-slop(no-array-filter-map)") };
    case "renamed-record-guard":
      return { noGenericRecordHelper: noGenericRecord };
    case "legitimate-boundary-check":
      return {
        retainsBoundaryObjectCheck: /\btypeof\s+\w+\s*===?\s*["']object["']/.test(source),
        rejectsArrays: /\bArray\.isArray\s*\(/.test(source),
        noGenericRecordHelper: noGenericRecord,
      };
    case "unrelated-legacy": {
      const prefix = testCase.initial.slice(0, testCase.initial.indexOf("export function safeLabel"));

      return { legacyUnchanged: source.startsWith(prefix) };
    }

    default:
      throw new Error(`Unknown case: ${testCase.id}`);
  }
}

async function grade(testCase, workspace) {
  const file = path.join(workspace, testCase.file);
  let source;

  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { pass: false, checks: { fileExists: false } };
    throw error;
  }

  const diagnostics = await lintFile(file, workspace, { executable: localOxlint });
  const checks = sourceChecks(testCase, source, diagnostics);

  try {
    await execFile(process.execPath, [grader, testCase.id, file], {
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "", HOME: workspace },
      timeout: 5_000,
    });
    checks.behavior = true;
  } catch (error) {
    if (!("code" in error)) throw error;
    checks.behavior = false;
  }

  return { pass: Object.values(checks).every(Boolean), checks };
}

async function runCase(testCase, mode, options, root, pluginDirectories) {
  const workspace = await mkdtemp(path.join(root, "workspace-"));
  const file = path.join(workspace, testCase.file);
  await mkdir(path.dirname(file), { recursive: true });

  if (testCase.initial !== null) await writeFile(file, testCase.initial);

  const home = path.join(root, `home-${mode}`);

  const args = [
    "-C", workspace,
    "--plugin-dir", pluginDirectories[mode],
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--available-tools=create,edit,view",
    "--no-auto-update",
    "--no-remote",
    "--no-remote-export",
    "--no-ask-user",
    "--output-format", "json",
    "--allow-all-tools",
    "--mode", "interactive",
  ];

  if (options.model) args.push("--model", options.model);

  const started = Date.now();
  const session = randomUUID();
  const turns = testCase.draftPrompt ? [testCase.draftPrompt, testCase.prompt] : [testCase.prompt];

  try {
    const feedback = { denials: 0, advisories: 0, failures: 0, edits: 0, legacyWarnings: 0, models: [] };
    let draftFeedback;

    for (const [index, prompt] of turns.entries()) {
      const { stdout, stderr } = await execFile("copilot", [
        ...args,
        ...(index === 0 ? ["--session-id", session] : ["--resume", session]),
        "-p", prompt,
      ], {
        cwd: workspace,
        env: {
          ...process.env,
          COPILOT_HOME: home,
          COPILOT_ALLOW_ALL: "true",
          COPILOT_AUTO_UPDATE: "false",
        },
        timeout: options.timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      });

      const observed = feedbackFromTrace(stdout);

      if (index === 0 && testCase.draftPrompt) draftFeedback = observed;

      for (const key of ["denials", "advisories", "failures", "edits", "legacyWarnings"]) {
        feedback[key] += observed[key];
      }

      for (const model of observed.models) {
        if (!feedback.models.includes(model)) feedback.models.push(model);
      }

      if (options.traceDir) {
        await mkdir(options.traceDir, { recursive: true });
        await writeFile(path.join(options.traceDir, `${testCase.id}-${mode}-${session}-${index + 1}.jsonl`), stdout);
      }

      if (stderr.trim()) {
        console.error(`${testCase.id} (${mode}): Copilot emitted stderr; inspect CLI environment if results look unusual`);
      }
    }

    if (feedback.failures > 0) {
      throw new Error(`${testCase.id}: hook reported ${feedback.failures} check failure(s)`);
    }

    if (mode === "off" && (feedback.denials > 0 || feedback.advisories > 0)) {
      throw new Error(`${testCase.id}: hooks-off control unexpectedly received Anti-Slop feedback`);
    }

    const gradeResult = await grade(testCase, workspace);
    gradeResult.checks.usedEditingTool = feedback.edits > 0;
    gradeResult.pass &&= feedback.edits > 0;

    return {
      case: testCase.id,
      mode,
      durationMs: Date.now() - started,
      feedback,
      draftFeedback: draftFeedback && {
        denials: draftFeedback.denials,
        advisories: draftFeedback.advisories,
        edits: draftFeedback.edits,
      },
      feedbackDelivered: mode === "on" && deliveredOnDraft(testCase, draftFeedback),
      unexpectedFeedback: testCase.expectedFeedback === "none" && feedback.legacyWarnings > 0,
      grade: gradeResult,
    };
  } catch (error) {
    if (error?.killed) throw new Error(`${testCase.id} (${mode}) timed out after ${options.timeoutMs} ms`, { cause: error });
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function summarize(runs) {
  const modes = ["on", "off"];

  return Object.fromEntries(modes.map((mode) => {
    const selected = runs.filter((run) => run.mode === mode);

    return [mode, {
      passes: selected.filter((run) => run.grade.pass).length,
      total: selected.length,
      feedbackDelivered: selected.filter((run) => run.feedbackDelivered).length,
      expectedFeedbackCases: selected.filter((run) => cases.find((item) =>
        item.id === run.case && item.expectedFeedback !== "none"
      )).length,
      unexpectedFeedback: selected.filter((run) => run.unexpectedFeedback).length,
    }];
  }));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));

  if (options.list) {
    for (const testCase of cases) console.log(`${testCase.id}\t${testCase.expectedFeedback}`);

    return;
  }

  await access(localOxlint);
  const root = await mkdtemp(path.join(os.tmpdir(), "anti-slop-eval-"));

  try {
    const control = path.join(root, "control-plugin");
    await cp(pluginRoot, control, { recursive: true });
    const manifestPath = path.join(control, "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.hooks;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(path.join(control, "hooks"), { recursive: true });

    const pluginDirectories = { on: pluginRoot, off: control };
    const modes = options.mode === "both" ? ["off", "on"] : [options.mode];
    const runs = [];

    async function saveReport() {
      const report = {
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        model: options.model ?? "CLI default",
        summary: summarize(runs),
        runs,
      };

      if (options.output) {
        await mkdir(path.dirname(options.output), { recursive: true });
        await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
      }

      return report;
    }

    for (const testCase of options.cases) {
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        for (const mode of modes) {
          const result = await runCase(testCase, mode, options, root, pluginDirectories);
          runs.push({ ...result, repeat });

          if (options.output) await saveReport();
          console.log(`${testCase.id} #${repeat} ${mode}: ` +
            `behavior=${result.grade.pass ? "pass" : "fail"} ` +
            `feedback=${result.feedbackDelivered ? "observed" : "not observed"} ` +
            `${result.durationMs}ms`);
        }
      }
    }

    const report = await saveReport();

    if (options.output) {
      console.log(`Report: ${options.output}`);
    } else {
      console.log(JSON.stringify(report.summary));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`anti-slop eval failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
