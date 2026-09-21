#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const GENERATED_MARKERS = [
  /@generated\b/i,
  /\bautomatically generated\b/i,
  /\bdo not edit\b/i,
];

const PATTERNS = [
  {
    id: "chained-assertion",
    expression: /\bas\s+unknown\s+as\s+/,
    summary: "Chained type assertion discards the original type evidence.",
    remediation: "Parse the boundary value or preserve its precise type instead of asserting through unknown.",
  },
  {
    id: "open-unknown-dictionary",
    expression: /\bRecord\s*<\s*(?:string|PropertyKey)\s*,\s*unknown\s*>/,
    summary: "Open dictionary leaves its value contract unspecified.",
    remediation: "Use a concrete value type, a schema-derived JSON contract, or Map<Key, Value>.",
  },
  {
    id: "unknown-type-alias",
    expression: /\btype\s+[A-Za-z_$][\w$]*(?:\s*<[^=]+>)?\s*=\s*unknown\b/,
    summary: "Type alias renames uncertainty without establishing a contract.",
    remediation: "Define the domain type or parse the external value into a schema-derived type.",
  },
  {
    id: "unknown-parameter",
    expression: /(?:\(|,)\s*[A-Za-z_$][\w$]*\??\s*:\s*unknown\b/,
    summary: "Function parameter accepts an unparsed value.",
    remediation: "Parse at the caller's I/O boundary and pass a named domain type.",
  },
  {
    id: "unknown-return",
    expression: /\)\s*:\s*(?:Promise\s*<\s*)?unknown\b/,
    summary: "Function exposes uncertainty to its caller.",
    remediation: "Return a named domain result after parsing or validation.",
  },
  {
    id: "reflective-access",
    expression: /\bReflect\.(?:apply|get)\s*\(/,
    summary: "Reflective access hides an ordinary typed call or property contract.",
    remediation: "Use direct property access, a typed adapter, or an explicit callable contract.",
  },
  {
    id: "module-mocking",
    expression: /\b(?:jest|vi)\.mock\s*\(/,
    summary: "Module mocking can hide an unavailable dependency seam.",
    remediation: "Inject the dependency or expose a pure registration/builder function.",
  },
  {
    id: "filter-map-chain",
    expression: /\.filter\s*\(.*\)\s*\.map\s*\(/,
    summary: "Filter/map chain creates an avoidable intermediate collection.",
    remediation: "Use flatMap or a single clear loop when the intermediate list has no domain meaning.",
  },
  {
    id: "copying-reduce",
    expression: /\.reduce\s*\(.*=>\s*\(\s*\{\s*\.\.\./,
    summary: "Reduce appears to copy its accumulator on every iteration.",
    remediation: "Use a loop, mutate a local accumulator, or build entries and call Object.fromEntries.",
  },
  {
    id: "conditional-empty-spread",
    expression: /\.\.\.\s*\([^)]*\?\s*\{\s*\}\s*:[^)]*\)|\.\.\.\s*\([^)]*:[^)]*\{\s*\}\s*\)/,
    summary: "Conditional spread uses an empty object as control flow.",
    remediation: "Construct the optional property explicitly or branch before building the object.",
  },
  {
    id: "representation-name",
    expression: /\b(?:class|const|function|interface|let|type|var)\s+[A-Za-z_$][\w$]*Shape\b/,
    summary: "Symbol name describes a representation instead of a domain concept.",
    remediation: "Name the contract after its owner or purpose, such as PullRequestDetails or PersistedRuntime.",
  },
];

export function scanText(text, filePath = "<memory>") {
  const findings = [];
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    for (const pattern of PATTERNS) {
      const match = pattern.expression.exec(line);

      if (!match) continue;

      findings.push({
        file: filePath,
        line: index + 1,
        column: match.index + 1,
        pattern: pattern.id,
        summary: pattern.summary,
        remediation: pattern.remediation,
        excerpt: line.trim(),
      });
    }
  }

  return findings;
}

export function isGeneratedSource(text) {
  const header = text.split(/\r?\n/, 8).join("\n");

  return GENERATED_MARKERS.some((marker) => marker.test(header));
}

export async function scanPaths(inputs, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const ignoredDirectories = normalizeIgnoredDirectories(options.ignore ?? [], cwd);
  const files = await collectSourceFiles(inputs, cwd, ignoredDirectories);
  const findings = [];
  let generatedFilesSkipped = 0;

  for (const file of files) {
    const text = await readFile(file, "utf8");

    if (isGeneratedSource(text)) {
      generatedFilesSkipped++;
      continue;
    }

    findings.push(...scanText(text, displayPath(file, cwd)));
  }

  findings.sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.pattern.localeCompare(right.pattern)
  );

  return {
    filesScanned: files.length - generatedFilesSkipped,
    generatedFilesSkipped,
    findings,
  };
}

async function collectSourceFiles(inputs, cwd, ignoredDirectories) {
  const roots = inputs.length > 0 ? inputs : ["."];
  const files = [];

  for (const input of roots) {
    const target = path.resolve(cwd, input);
    await collect(target, files, cwd, ignoredDirectories);
  }

  return [...new Set(files)].sort();
}

async function collect(target, files, cwd, ignoredDirectories) {
  const metadata = await lstat(target);

  if (metadata.isSymbolicLink()) return;

  if (metadata.isFile()) {
    if (isSourceFile(target)) files.push(target);

    return;
  }

  if (
    !metadata.isDirectory() ||
    shouldIgnoreDirectory(target, cwd, ignoredDirectories)
  ) {
    return;
  }

  const entries = await readdir(target, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    await collect(path.join(target, entry.name), files, cwd, ignoredDirectories);
  }
}

function isSourceFile(filePath) {
  if (!SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;

  return !filePath.endsWith(".min.js") && !filePath.endsWith(".min.mjs");
}

function shouldIgnoreDirectory(directory, cwd, ignoredDirectories) {
  const name = path.basename(directory);

  if (IGNORED_DIRECTORIES.has(name)) return true;

  const normalized = path.relative(cwd, directory).split(path.sep).join("/");

  if (ignoredDirectories.some((ignored) =>
    ignored.includes("/")
      ? normalized === ignored || normalized.startsWith(`${ignored}/`)
      : name === ignored
  )) {
    return true;
  }

  return normalized === "public/assets" || normalized.endsWith("/public/assets");
}

function normalizeIgnoredDirectories(directories, cwd) {
  return directories.map((directory) => {
    const resolved = path.isAbsolute(directory)
      ? path.relative(cwd, directory)
      : directory;

    return resolved
      .split(path.sep).join("/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
  });
}

function displayPath(filePath, cwd) {
  const relative = path.relative(cwd, filePath);

  return relative && !relative.startsWith("..") ? relative : filePath;
}

function parseArguments(argv) {
  const inputs = [];
  const ignore = [];
  let json = false;
  let max = 200;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--max") {
      const value = Number(argv[++index]);

      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max must be a positive integer");
      }

      max = value;
      continue;
    }

    if (argument === "--ignore") {
      const value = argv[++index];

      if (!value || value.startsWith("-")) {
        throw new Error("--ignore requires a directory name or path");
      }

      ignore.push(value);
      continue;
    }

    if (argument.startsWith("--ignore=")) {
      const value = argument.slice("--ignore=".length);

      if (!value) throw new Error("--ignore requires a directory name or path");
      ignore.push(value);
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      return { help: true, ignore, inputs, json, max };
    }

    if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
    inputs.push(argument);
  }

  return { help: false, ignore, inputs, json, max };
}

function printHelp() {
  console.log(`Usage: node scripts/scan.mjs [paths...] [--json] [--max N]

Read-only, dependency-free heuristic scan for high-confidence Anti-Slop
candidates. This is advisory and does not replace parser-backed lint rules.

Options:
  --json         Emit machine-readable JSON.
  --max N        Limit displayed findings in text output (default: 200).
  --ignore DIR   Skip a directory name or relative path. Repeat as needed.
  -h             Show this help.

Generated files and conventional output directories are skipped.`);
}

function printText(result, max) {
  const counts = new Map();

  for (const finding of result.findings) {
    counts.set(finding.pattern, (counts.get(finding.pattern) ?? 0) + 1);
  }

  console.log(
    `Scanned ${result.filesScanned} source file(s); ` +
      `found ${result.findings.length} heuristic candidate(s).`,
  );

  if (result.generatedFilesSkipped > 0) {
    console.log(`Skipped ${result.generatedFilesSkipped} generated source file(s).`);
  }

  if (result.findings.length === 0) return;

  console.log("\nPatterns:");

  for (const [pattern, count] of [...counts].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0])
  )) {
    console.log(`  ${String(count).padStart(4)}  ${pattern}`);
  }

  console.log("\nCandidates:");

  for (const finding of result.findings.slice(0, max)) {
    console.log(
      `${finding.file}:${finding.line}:${finding.column} [${finding.pattern}] ${finding.summary}`,
    );
    console.log(`  ${finding.excerpt}`);
    console.log(`  Instead: ${finding.remediation}`);
  }

  if (result.findings.length > max) {
    console.log(`\n${result.findings.length - max} additional candidate(s) omitted; use --max to show more.`);
  }

  console.log("\nHeuristic results require review; they are not lint violations.");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    printHelp();

    return;
  }

  const result = await scanPaths(options.inputs, { ignore: options.ignore });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result, options.max);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`anti-slop scan failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
