#!/usr/bin/env node

import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isGeneratedSource, isScannableFile, scanText } from "../skills/anti-slop/scripts/scan.mjs";

const BLOCKED_PATTERNS = new Set(["chained-assertion", "unknown-type-alias"]);

function argumentFields(args) {
  return args && typeof args === "object" ? Object.keys(args).join(", ") : typeof args;
}

function addedLines(before, after) {
  const existing = new Map();

  for (const line of before.split(/\r?\n/)) {
    const key = line.trim();

    existing.set(key, (existing.get(key) ?? 0) + 1);
  }

  return after.split(/\r?\n/).filter((line) => {
    const key = line.trim();
    const count = existing.get(key) ?? 0;

    if (count === 0) return true;
    existing.set(key, count - 1);

    return false;
  });
}

function patchChanges(patch) {
  const changes = [];
  let current;
  let inHunk = false;

  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);

    if (header) {
      current = {
        file: header[2],
        sourceFile: header[2],
        created: header[1] === "Add",
        lines: [],
        removed: [],
      };

      if (header[1] !== "Delete") changes.push(current);
      inHunk = current.created;
      continue;
    }

    if (line.startsWith("*** Move to: ") && current) {
      current.file = line.slice("*** Move to: ".length);
      continue;
    }

    if (line.startsWith("@@") && current) {
      inHunk = true;
      continue;
    }

    if (line.startsWith("***")) {
      inHunk = false;
      continue;
    }

    if (inHunk && line.startsWith("+") && current) {
      current.lines.push(line.slice(1));
    } else if (inHunk && line.startsWith("-") && current && !current.created) {
      current.removed.push(line.slice(1));
    }
  }

  return changes.map((change) => ({
    ...change,
    lines: change.created
      ? change.lines
      : addedLines(change.removed.join("\n"), change.lines.join("\n")),
  }));
}

export function proposedChanges(toolName, args) {
  if (toolName === "apply_patch") {
    const patch = typeof args === "string" ? args : args?.patch ?? args?.input;

    if (typeof patch !== "string") {
      throw new Error(`apply_patch has no readable patch argument (fields: ${argumentFields(args)})`);
    }

    return patchChanges(patch);
  }

  const file = args?.path ?? args?.filePath ?? args?.file_path ?? args?.file;

  if (typeof file !== "string") {
    throw new Error(`${toolName} has no readable file path (fields: ${argumentFields(args)})`);
  }

  if (toolName === "create") {
    const content = args?.file_text ?? args?.content ?? args?.contents;

    if (typeof content !== "string") {
      throw new Error(`create has no readable content (fields: ${argumentFields(args)})`);
    }

    return [{ file, sourceFile: file, created: true, lines: content.split(/\r?\n/) }];
  }

  const before = args?.old_str ?? args?.oldString ?? args?.old_string ?? args?.oldText;
  const after = args?.new_str ?? args?.newString ?? args?.new_string ?? args?.newText;

  if (typeof before !== "string" || typeof after !== "string") {
    throw new Error(`${toolName} has no readable replacement text (fields: ${argumentFields(args)})`);
  }

  return [{ file, sourceFile: file, created: false, lines: addedLines(before, after) }];
}

export function maskNonCode(text) {
  let state = "code";
  let output = "";

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\n") {
      output += "\n";

      if (state === "line" || state === "single" || state === "double") state = "code";
      continue;
    }

    if (state === "line") {
      output += " ";
    } else if (state === "block") {
      output += " ";

      if (char === "*" && next === "/") {
        output += " ";
        index++;
        state = "code";
      }
    } else if (state !== "code") {
      output += " ";

      if (char === "\\") {
        output += " ";
        index++;
      } else if (
        (state === "single" && char === "'") ||
        (state === "double" && char === '"') ||
        (state === "template" && char === "`")
      ) {
        state = "code";
      }
    } else if (char === "/" && (next === "/" || next === "*")) {
      output += "  ";
      index++;
      state = next === "/" ? "line" : "block";
    } else if (char === "'" || char === '"' || char === "`") {
      output += " ";
      state = char === "'" ? "single" : char === '"' ? "double" : "template";
    } else {
      output += char;
    }
  }

  return output;
}

async function isExistingGeneratedFile(file) {
  let metadata;

  try {
    metadata = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  if (metadata.isSymbolicLink()) return true;

  if (!metadata.isFile()) return false;

  const handle = await open(file, "r");

  try {
    const buffer = Buffer.alloc(2048);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    return isGeneratedSource(buffer.toString("utf8", 0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function guard(input) {
  if (!input || typeof input.cwd !== "string" || typeof input.toolName !== "string") {
    throw new Error("invalid preToolUse payload");
  }

  const cwd = path.resolve(input.cwd);
  const changes = proposedChanges(input.toolName, input.toolArgs);
  const findings = [];

  for (const change of changes) {
    const file = path.resolve(cwd, change.file);
    const sourceFile = path.resolve(cwd, change.sourceFile);

    if (!isScannableFile(file, cwd) || change.lines.length === 0) continue;

    if (change.created && isGeneratedSource(change.lines.join("\n"))) continue;

    if (isScannableFile(sourceFile, cwd) && await isExistingGeneratedFile(sourceFile)) continue;

    findings.push(...scanText(maskNonCode(change.lines.join("\n")), path.relative(cwd, file))
      .filter((finding) => BLOCKED_PATTERNS.has(finding.pattern)));
  }

  if (findings.length === 0) return {};

  const details = findings.slice(0, 3).map((finding) =>
    `${finding.file} [${finding.pattern}]: ${finding.remediation}`
  );

  const remainder = findings.length > 3 ? ` (${findings.length - 3} more)` : "";

  return {
    permissionDecision: "deny",
    permissionDecisionReason: `Anti-Slop rejected new code: ${details.join(" ")}${remainder} Use the anti-slop skill for guidance.`,
  };
}

async function main() {
  let payload = "";

  for await (const chunk of process.stdin) payload += chunk;
  process.stdout.write(`${JSON.stringify(await guard(JSON.parse(payload)))}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`anti-slop hook failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
