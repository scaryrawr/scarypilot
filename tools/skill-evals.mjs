import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

const policyPath = "tools/skill-evals/policy.json";

const roots = ["plugins", "external_plugins"];

const globalInputs = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", ".github/plugin/marketplace.json"];

const globalPrefixes = [".github/instructions/", "tools/skill-evals/", ".github/workflows/skill-evals.yml"];

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function relativePath(value) {
  requireCondition(typeof value === "string" && value.length > 0 && !value.includes("\0"), "Expected a nonempty relative path");
  requireCondition(!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.includes("\\"), `Invalid path: ${value}`);
  requireCondition(value.split("/").every((part) => part !== ".." && part !== "." && part !== ""), `Noncanonical path: ${value}`);

  return value;
}

async function confined(root, relative) {
  relativePath(relative);

  let current = root;

  for (const component of relative.split("/")) {
    current = path.join(current, component);

    const entry = await lstat(current);

    requireCondition(!entry.isSymbolicLink(), `Symlinks are not allowed in eval inputs: ${relative}`);
  }

  const resolved = await realpath(current);
  const parent = await realpath(root);

  requireCondition(resolved.startsWith(`${parent}${path.sep}`), `Path escapes its root: ${relative}`);

  return resolved;
}

async function validateTree(root, relative) {
  const full = await confined(root, relative);
  const entry = await lstat(full);

  if (entry.isDirectory()) {
    for (const child of await readdir(full)) await validateTree(root, `${relative}/${child}`);
  }
}

async function optionalJson(root, relative) {
  try {
    return JSON.parse(await readFile(await confined(root, relative), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;

    throw error;
  }
}

export async function loadPolicy(root) {
  const policy = await optionalJson(root, policyPath);

  requireCondition(policy?.version === 1 && policy.execution === "approval-required", "Unsupported eval policy or execution grant");
  requireCondition(Array.isArray(policy.sharedDependencies) && Array.isArray(policy.offlineSuites), "Missing policy entries");

  for (const dependency of policy.sharedDependencies) {
    relativePath(dependency.source.replace(/\/$/, ""));
    requireCondition(Array.isArray(dependency.consumers) && dependency.consumers.length > 0, "Missing dependency consumers");
    requireCondition(typeof dependency.reason === "string" && dependency.reason.length > 0, "Missing dependency reason");

    for (const prefix of dependency.consumers) relativePath(prefix.replace(/\/$/, ""));
  }

  const names = new Set();

  for (const suite of policy.offlineSuites) {
    relativePath(suite.skill);
    requireCondition(!names.has(suite.skill), `Duplicate offline suite: ${suite.skill}`);
    names.add(suite.skill);

    for (const key of ["taskIds", "triggerIndexes"]) {
      requireCondition(Array.isArray(suite[key]) && suite[key].every(Number.isSafeInteger), `Invalid ${key} policy`);
      requireCondition(new Set(suite[key]).size === suite[key].length, `Duplicate ${key} policy`);
    }
  }

  return policy;
}

async function suiteInventory(root, skillPath, name) {
  const taskPath = `${skillPath}/evals/evals.json`;
  const triggerPath = `${skillPath}/evals/trigger-evals.json`;
  const task = await optionalJson(root, taskPath);
  const trigger = await optionalJson(root, triggerPath);
  const tasks = task === null ? [] : task.evals;
  const triggers = trigger ?? [];

  if (task !== null) {
    requireCondition(task.skill_name === name && Array.isArray(tasks) && tasks.length > 0, `Invalid task suite: ${taskPath}`);
  }

  requireCondition(Array.isArray(triggers), `Invalid trigger suite: ${triggerPath}`);

  const ids = new Set();

  for (const item of tasks) {
    requireCondition(Number.isSafeInteger(item.id) && !ids.has(item.id), `Invalid or duplicate task id: ${taskPath}`);
    ids.add(item.id);
    requireCondition(typeof item.prompt === "string" && item.prompt.length > 0, `Missing task prompt: ${taskPath}`);
    requireCondition(typeof item.expected_output === "string" && item.expected_output.length > 0, `Missing expected task output: ${taskPath}`);

    const assertions = item.assertions ?? item.expectations;

    requireCondition(Array.isArray(assertions) && assertions.length > 0 && assertions.every((text) => typeof text === "string" && text.length > 0), `Missing task assertions: ${taskPath} case ${item.id}`);
    requireCondition(item.files === undefined || Array.isArray(item.files), `Invalid task fixtures: ${taskPath}`);

    const basenames = new Set();

    for (const fixture of item.files ?? []) {
      relativePath(fixture);
      requireCondition(!basenames.has(path.posix.basename(fixture)), `Colliding fixture names: ${taskPath}`);
      basenames.add(path.posix.basename(fixture));
      await validateTree(path.join(root, skillPath), fixture);
    }
  }

  const queries = new Set();

  for (const item of triggers) {
    requireCondition(typeof item.query === "string" && item.query.length > 0 && typeof item.should_trigger === "boolean", `Invalid trigger case: ${triggerPath}`);
    requireCondition(!queries.has(item.query), `Duplicate trigger prompt: ${triggerPath}`);
    queries.add(item.query);
    requireCondition(item.files === undefined || Array.isArray(item.files), `Invalid trigger fixtures: ${triggerPath}`);

    const basenames = new Set();

    for (const fixture of item.files ?? []) {
      relativePath(fixture);
      requireCondition(fixture.startsWith("evals/files/"), `Invalid trigger fixture path: ${triggerPath}`);

      const basename = path.posix.basename(fixture).toLowerCase();

      requireCondition(!basenames.has(basename), `Colliding trigger fixture names: ${triggerPath}`);
      basenames.add(basename);

      const full = await confined(path.join(root, skillPath), fixture);

      requireCondition((await lstat(full)).isFile() && path.posix.extname(fixture) === ".md" && !basename.startsWith("."), `Trigger fixtures must be visible Markdown files: ${triggerPath}`);
    }
  }

  return { taskPath: tasks.length ? taskPath : null, taskIds: [...ids], triggerPath: triggers.length ? triggerPath : null, triggerCount: triggers.length };
}

export async function inventory(root) {
  const skills = [];

  for (const prefix of roots) {
    const directory = path.join(root, prefix);
    let plugins;

    try {
      plugins = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;

      throw error;
    }

    for (const plugin of plugins) {
      requireCondition(!plugin.isSymbolicLink(), `Symlinked plugin: ${prefix}/${plugin.name}`);

      if (!plugin.isDirectory()) continue;

      const pluginPath = `${prefix}/${plugin.name}`;
      let entries;

      try {
        entries = await readdir(await confined(root, `${pluginPath}/skills`), { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;

        throw error;
      }

      for (const entry of entries) {
        requireCondition(!entry.isSymbolicLink(), `Symlinked skill: ${pluginPath}/${entry.name}`);

        if (!entry.isDirectory()) continue;

        const skillPath = `${pluginPath}/skills/${entry.name}`;
        let content;

        try {
          content = await readFile(await confined(root, `${skillPath}/SKILL.md`), "utf8");
        } catch (error) {
          if (error.code === "ENOENT") continue;

          throw error;
        }

        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
        const name = /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(frontmatter ?? "")?.[1];

        requireCondition(name === entry.name, `Skill name must match its directory: ${skillPath}`);
        requireCondition(/^description:\s*\S/m.test(frontmatter), `Missing skill description: ${skillPath}`);
        skills.push({ name, path: skillPath, pluginPath, ...await suiteInventory(root, skillPath, name) });
      }
    }
  }

  return skills.sort((a, b) => a.path.localeCompare(b.path));
}

export function parseDiff(output) {
  const fields = output.split("\0");
  const files = new Set();

  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    const count = /^[RC]/.test(status) ? 2 : 1;

    requireCondition(/^[ACDMRTUXB]\d*$/.test(status), `Invalid diff status: ${status}`);

    for (let offset = 0; offset < count; offset++) files.add(relativePath(fields[index++]));
  }

  return [...files].sort();
}

export function selectSkills(skills, files, policy) {
  const selected = [];

  for (const skill of skills) {
    const reasons = new Set();

    for (const file of files) {
      if (file.startsWith(`${skill.path}/`)) reasons.add(`skill input: ${file}`);
      else if (file.startsWith(`${skill.pluginPath}/`) && !file.startsWith(`${skill.pluginPath}/skills/`)) reasons.add(`shared plugin input: ${file}`);

      if (globalInputs.includes(file) || globalPrefixes.some((prefix) => file.startsWith(prefix)) || ["tools/skill-evals.mjs", "tools/skill-evals.test.mjs"].includes(file)) {
        reasons.add(`repository-wide eval input: ${file}`);
      }

      for (const dependency of policy.sharedDependencies) {
        if (file.startsWith(dependency.source) && dependency.consumers.some((prefix) => skill.path.startsWith(prefix))) {
          reasons.add(`${dependency.reason} Changed ${file}`);
        }
      }
    }

    if (!reasons.size) continue;

    const admitted = policy.offlineSuites.find((suite) => suite.skill === skill.path);
    const taskIds = admitted?.taskIds ?? [];
    const triggerIndexes = admitted?.triggerIndexes ?? [];
    const totalCases = skill.taskIds.length + skill.triggerCount;

    selected.push({
      ...skill,
      reasons: [...reasons],
      status: "not_run",
      coverage: totalCases ? "cases_available" : "missing_evals",
      runnable: { taskIds, triggerIndexes },
      excludedCases: totalCases - taskIds.length - triggerIndexes.length,
      reason: admitted ? "Awaiting model, budget, and execution approval. Task results also require complete independent grading." : "No reviewed offline execution policy. Cases are inventoried, not authorized.",
    });
  }

  return selected;
}

export function validatePolicyCoverage(skills, policy) {
  for (const suite of policy.offlineSuites) {
    const skill = skills.find((item) => item.path === suite.skill);

    requireCondition(skill, `Policy references a missing skill: ${suite.skill}`);
    requireCondition(suite.taskIds.every((id) => skill.taskIds.includes(id)), `Policy references a missing task: ${suite.skill}`);
    requireCondition(suite.triggerIndexes.every((index) => index >= 0 && index < skill.triggerCount), `Policy references a missing trigger: ${suite.skill}`);
  }
}

export async function coverageReport(root, base, head) {
  const baseCommit = git(root, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const headCommit = git(root, ["rev-parse", "--verify", `${head ?? "HEAD"}^{commit}`]).trim();

  if (head) {
    requireCondition(headCommit === git(root, ["rev-parse", "HEAD"]).trim(), "Explicit --head must match the checked-out HEAD");
    requireCondition(!git(root, ["diff", "--name-only", "-z", "HEAD", "--"]), "Explicit --head requires a clean tracked worktree; omit --head to include local edits");

    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0");
    const relevant = untracked.some((file) => roots.some((prefix) => file.startsWith(`${prefix}/`)) || globalInputs.includes(file) || globalPrefixes.some((prefix) => file.startsWith(prefix)) || ["tools/skill-evals.mjs", "tools/skill-evals.test.mjs"].includes(file));

    requireCondition(!relevant, "Explicit --head requires no untracked eval inputs; omit --head to include local edits");
  }

  const mergeBase = git(root, ["merge-base", baseCommit, headCommit]).trim();
  const args = ["diff", "--name-status", "-z", "--find-renames", mergeBase];

  if (head) args.push(headCommit);

  args.push("--");

  const files = parseDiff(git(root, args));

  if (!head) files.push(...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").flatMap((file) => file ? [relativePath(file)] : []));

  const policy = await loadPolicy(root);
  const skills = await inventory(root);

  validatePolicyCoverage(skills, policy);

  const selected = selectSkills(skills, [...new Set(files)], policy);
  const removedSkills = files.flatMap((file) => file.endsWith("/SKILL.md") && !skills.some((skill) => `${skill.path}/SKILL.md` === file) ? [file.slice(0, -"/SKILL.md".length)] : []);
  const proposedCalls = selected.reduce((count, skill) => count + skill.runnable.taskIds.length + skill.runnable.triggerIndexes.length, 0);

  return {
    version: 1,
    comparison: { base: baseCommit, head: headCommit, mergeBase, includesWorkingTree: !head },
    structuralStatus: "passed",
    behavioralStatus: selected.length ? "not_run" : "not_applicable",
    inventory: { skills: skills.length, taskSets: skills.filter((skill) => skill.taskPath).length, triggerSets: skills.filter((skill) => skill.triggerPath).length },
    changedFiles: [...new Set(files)].sort(),
    removedSkills: [...new Set(removedSkills)].sort(),
    proposedExecution: { approvalRequired: true, model: null, maxCalls: proposedCalls, repetitions: 1, baseline: false, workers: 1, monetaryLimit: null },
    selected,
    specializedCoverage: selected.some((skill) => skill.pluginPath === "plugins/anti-slop") ? ["Anti-Slop's hook behavioral runner remains a separate, approval-required local experiment."] : [],
  };
}

function parseArguments(args) {
  const command = args.shift();

  requireCondition(command === "check" || command === "select", "Usage: node tools/skill-evals.mjs <check|select> --base REF [--head REF] [--output FILE] [--json]");

  const options = new Map();

  while (args.length) {
    const flag = args.shift();

    if (flag === "--json") {
      requireCondition(!options.has(flag), `Duplicate option: ${flag}`);
      options.set(flag, true);
      continue;
    }

    const value = args.shift();

    requireCondition(["--base", "--head", "--output"].includes(flag) && value && !options.has(flag), `Invalid option: ${flag}`);
    options.set(flag, value);
  }

  requireCondition(options.has("--base"), "An explicit comparison --base is required");

  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await coverageReport(repository, options.get("--base"), options.get("--head"));
  const json = `${JSON.stringify(report, null, 2)}\n`;

  if (options.has("--output")) await writeFile(options.get("--output"), json, { flag: "wx" });

  if (options.has("--json")) {
    process.stdout.write(json);

    return;
  }

  console.log(`Structural validation: ${report.structuralStatus}. Model-backed behavior: ${report.behavioralStatus}.`);
  console.log(`Affected skills: ${report.selected.length}. Missing evals: ${report.selected.filter((skill) => skill.coverage === "missing_evals").length}. Removed skills: ${report.removedSkills.length}.`);
  console.log(`Proposal: ${report.proposedExecution.maxCalls} model calls, one repetition, no baseline, one worker. Model and spending are unapproved.`);

  for (const skill of report.selected) {
    console.log(`${skill.path}: ${skill.coverage}, ${skill.excludedCases} cases excluded by offline policy.`);
  }

  if (options.has("--output")) console.log(`Full coverage report: ${options.get("--output")}`);
  else console.log("Use --json or --output FILE for selection reasons and complete case coverage.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Skill eval coverage error: ${error.message}`);
    process.exitCode = 1;
  });
}
