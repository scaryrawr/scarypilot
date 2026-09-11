#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = resolve(TOOL_DIR, "..");
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

function toPosix(path) {
  return path.split(sep).join("/");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function frontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return new Map();
  const result = new Map();
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") return result;
    const match = /^(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)'):\s*(.*)$/.exec(
      lines[index],
    );
    if (match) result.set(match[1] ?? match[2] ?? match[3], match[4]);
  }
  return new Map();
}

function finding(code, message, path) {
  return { code, message, ...(path ? { path } : {}) };
}

function pathMatches(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function classifyUpstreamPath(path, policy) {
  const mapped = policy.mappedUpstreamPaths.find((rule) =>
    pathMatches(path, rule.path),
  );
  if (mapped) {
    return {
      disposition: "mapped",
      localPaths: mapped.localPaths,
      reason: mapped.reason,
    };
  }
  const copilotOwned = policy.copilotOwnedPaths.find((prefix) =>
    pathMatches(path, prefix),
  );
  if (copilotOwned) {
    return { disposition: "copilot-owned" };
  }
  const excluded = policy.excludedUpstreamPaths.find((rule) =>
    pathMatches(path, rule.path),
  );
  if (excluded) {
    return { disposition: "excluded", reason: excluded.reason };
  }
  if (path === "README.md" || path.startsWith("skills/") ||
      path.startsWith("docs/guide/") || path.startsWith("agents/")) {
    return { disposition: "adapted" };
  }
  return { disposition: "unclassified" };
}

function markdownLinkFindings(pluginRoot) {
  const findings = [];
  const markdownFiles = listFiles(pluginRoot).filter((path) => path.endsWith(".md"));
  const linkPattern = /\[[^\]]*]\(([^)]+)\)/g;
  for (const path of markdownFiles) {
    const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "");
    for (const match of text.matchAll(linkPattern)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, "");
      if (
        rawTarget === "" ||
        rawTarget === "url" ||
        rawTarget.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
      ) {
        continue;
      }
      const target = decodeURIComponent(rawTarget.split("#", 1)[0]);
      if (!existsSync(resolve(dirname(path), target))) {
        findings.push(
          finding(
            "broken-link",
            `Relative link does not resolve: ${rawTarget}`,
            toPosix(relative(pluginRoot, path)),
          ),
        );
      }
    }
  }
  return findings;
}

export function checkRepository(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const policy = readJson(join(pluginRoot, "upstream-sync.json"));
  const findings = [];
  const skillsRoot = join(pluginRoot, "skills");
  const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const names = new Map();

  for (const directory of skillDirectories) {
    const skillPath = join(skillsRoot, directory, "SKILL.md");
    if (!existsSync(skillPath)) {
      findings.push(
        finding("missing-skill", "Skill directory has no SKILL.md", `skills/${directory}`),
      );
      continue;
    }
    const metadata = frontmatter(readFileSync(skillPath, "utf8"));
    const name = metadata.get("name")?.replace(/^["']|["']$/g, "");
    if (name !== directory) {
      findings.push(
        finding(
          "skill-name-mismatch",
          `Frontmatter name ${JSON.stringify(name)} does not match directory`,
          `skills/${directory}/SKILL.md`,
        ),
      );
    }
    if (name) {
      const previous = names.get(name);
      if (previous) {
        findings.push(
          finding(
            "duplicate-skill",
            `Skill name also appears in ${previous}`,
            `skills/${directory}/SKILL.md`,
          ),
        );
      } else {
        names.set(name, `skills/${directory}/SKILL.md`);
      }
    }
    for (const key of policy.forbiddenSkillFrontmatter) {
      if (metadata.has(key)) {
        findings.push(
          finding(
            "forbidden-frontmatter",
            `${key} prevents reliable Copilot model invocation`,
            `skills/${directory}/SKILL.md`,
          ),
        );
      }
    }
  }

  for (const required of policy.requiredSkills) {
    if (!names.has(required)) {
      findings.push(
        finding("missing-required-skill", `Required skill is not shipped: ${required}`),
      );
    }
  }

  const plugin = readJson(join(pluginRoot, "plugin.json"));
  if (plugin.version !== policy.localVersion) {
    findings.push(
      finding(
        "version-mismatch",
        `plugin.json is ${plugin.version}; policy requires ${policy.localVersion}`,
        "plugin.json",
      ),
    );
  }
  if (!Array.isArray(plugin.extensions) || !plugin.extensions.includes("extensions")) {
    findings.push(
      finding(
        "missing-extension",
        "plugin.json must continue to publish the Copilot extension directory",
        "plugin.json",
      ),
    );
  }

  const notice = readFileSync(join(pluginRoot, "NOTICE.md"), "utf8");
  for (const expected of [
    policy.upstream.version,
    policy.upstream.reviewedFromCommit,
    policy.upstream.integratedCommit,
    policy.upstream.contentCommit,
  ]) {
    if (!notice.includes(expected)) {
      findings.push(
        finding("provenance-drift", `NOTICE.md does not record ${expected}`, "NOTICE.md"),
      );
    }
  }

  for (const rule of policy.excludedUpstreamPaths) {
    if (rule.path === ".cursor-plugin/plugin.json") {
      if (existsSync(join(pluginRoot, ".cursor-plugin"))) {
        findings.push(
          finding("excluded-path-present", rule.reason, ".cursor-plugin"),
        );
      }
      continue;
    }
    if (existsSync(join(pluginRoot, rule.path))) {
      findings.push(
        finding("excluded-path-present", rule.reason, rule.path),
      );
    }
  }

  for (const rule of policy.forbiddenContent) {
    for (const scope of rule.paths) {
      for (const path of listFiles(join(pluginRoot, scope))) {
        if (readFileSync(path, "utf8").includes(rule.pattern)) {
          findings.push(
            finding(
              "cursor-only-content",
              `Found Cursor-only token ${JSON.stringify(rule.pattern)}`,
              toPosix(relative(pluginRoot, path)),
            ),
          );
        }
      }
    }
  }

  const readme = readFileSync(join(pluginRoot, "README.md"), "utf8");
  const documentedCount = /- (\d+) Agent Skills\b/.exec(readme);
  if (!documentedCount || Number(documentedCount[1]) !== names.size) {
    findings.push(
      finding(
        "inventory-drift",
        `README skill count must match the ${names.size} discovered skills`,
        "README.md",
      ),
    );
  }

  findings.push(...markdownLinkFindings(pluginRoot));
  return findings;
}

function git(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function resolveUpstream(path) {
  const absolute = resolve(path);
  if (existsSync(join(absolute, "pstack", ".cursor-plugin", "plugin.json"))) {
    return { repoRoot: absolute, subtree: "pstack" };
  }
  if (existsSync(join(absolute, ".cursor-plugin", "plugin.json"))) {
    return { repoRoot: resolve(absolute, ".."), subtree: "pstack" };
  }
  throw new Error(`No upstream pstack checkout found at ${absolute}`);
}

export function parseNameStatus(output) {
  if (output.trim() === "") return [];
  return output.split(/\r?\n/).map((line) => {
    const [status, first, second] = line.split("\t");
    const path = (second ?? first).replace(/^pstack\//, "");
    return {
      status,
      path,
      ...(second ? { previousPath: first.replace(/^pstack\//, "") } : {}),
    };
  });
}

export function buildPlan({ policy, changes, from, to, targetVersion }) {
  return {
    schemaVersion: 1,
    upstream: policy.upstream.repository,
    subtree: policy.upstream.subtree,
    from,
    to,
    targetVersion,
    changes: changes.map((change) => ({
      ...change,
      ...classifyUpstreamPath(change.path, policy),
    })),
  };
}

function planCommand(pluginRoot, args) {
  const upstreamArg = args[args.indexOf("--upstream") + 1];
  if (!upstreamArg || upstreamArg.startsWith("--")) {
    throw new Error("plan requires --upstream <checkout>");
  }
  const policy = readJson(join(pluginRoot, "upstream-sync.json"));
  const upstream = resolveUpstream(upstreamArg);
  const fromIndex = args.indexOf("--from");
  const toIndex = args.indexOf("--to");
  const from = fromIndex >= 0 ? args[fromIndex + 1] : policy.upstream.integratedCommit;
  const requestedTo = toIndex >= 0 ? args[toIndex + 1] : "HEAD";
  const to = git(upstream.repoRoot, ["rev-parse", requestedTo]);
  git(upstream.repoRoot, ["merge-base", "--is-ancestor", from, to]);
  const manifest = JSON.parse(
    git(upstream.repoRoot, ["show", `${to}:pstack/.cursor-plugin/plugin.json`]),
  );
  const changes = parseNameStatus(
    git(upstream.repoRoot, [
      "diff",
      "--name-status",
      `${from}..${to}`,
      "--",
      upstream.subtree,
    ]),
  );
  const plan = buildPlan({
    policy,
    changes,
    from,
    to,
    targetVersion: manifest.version,
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  return plan.changes.some((change) => change.disposition === "unclassified") ? 1 : 0;
}

function printFindings(findings) {
  for (const item of findings) {
    const location = item.path ? `${item.path}: ` : "";
    process.stderr.write(`${item.code}: ${location}${item.message}\n`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "check";
  const rootIndex = argv.indexOf("--root");
  const pluginRoot =
    rootIndex >= 0 ? resolve(argv[rootIndex + 1]) : DEFAULT_PLUGIN_ROOT;
  if (command === "check") {
    const findings = checkRepository(pluginRoot);
    printFindings(findings);
    if (findings.length === 0) {
      process.stdout.write("pstack integration checks passed\n");
    }
    return findings.length === 0 ? 0 : 1;
  }
  if (command === "plan") return planCommand(pluginRoot, argv.slice(1));
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
