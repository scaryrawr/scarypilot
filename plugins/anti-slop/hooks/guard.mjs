#!/usr/bin/env node

import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isGeneratedSource, isSafeWorkspaceFile, scanText } from "../skills/anti-slop/scripts/scan.mjs";

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

  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);

    if (header) {
      current = {
        file: header[2],
        sourceFile: header[2],
        created: header[1] === "Add",
        rows: [],
        hunks: [],
      };

      if (header[1] !== "Delete") changes.push(current);
      continue;
    }

    if (line.startsWith("*** Move to: ") && current) {
      current.file = line.slice("*** Move to: ".length);
      continue;
    }

    if (line.startsWith("@@") && current) {
      if (current.rows.length > 0) current.hunks.push(current.rows);
      current.rows = [];
      continue;
    }

    if (line.startsWith("***")) continue;

    if (current && /^[ +\-]/.test(line)) {
      current.rows.push({ kind: line[0], text: line.slice(1) });
    }
  }

  return changes.map((change) => {
    if (change.rows.length > 0) change.hunks.push(change.rows);

    return {
      file: change.file,
      sourceFile: change.sourceFile,
      created: change.created,
      hunks: change.hunks,
      content: change.created ? change.hunks.flat().filter((row) => row.kind === "+")
        .map((row) => row.text).join("\n") : undefined,
    };
  });
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

    return [{ file, sourceFile: file, created: true, content }];
  }

  const before = args?.old_str ?? args?.oldString ?? args?.old_string ?? args?.oldText;
  const after = args?.new_str ?? args?.newString ?? args?.new_string ?? args?.newText;

  if (typeof before !== "string" || typeof after !== "string") {
    throw new Error(`${toolName} has no readable replacement text (fields: ${argumentFields(args)})`);
  }

  return [{ file, sourceFile: file, created: false, before, after }];
}

function locate(lines, fragment) {
  if (fragment.length === 0) throw new Error("edit has no matching context");

  const matches = [];

  for (let index = 0; index <= lines.length - fragment.length; index++) {
    if (fragment.every((line, offset) => line === lines[index + offset])) matches.push(index);
  }

  if (matches.length !== 1) throw new Error(`edit context matched ${matches.length} locations`);

  return matches[0];
}

function editedIndices(before, after) {
  const added = addedLines(before.join("\n"), after.join("\n"));
  const counts = new Map();

  for (const line of added) counts.set(line.trim(), (counts.get(line.trim()) ?? 0) + 1);

  return after.flatMap((line, index) => {
    const count = counts.get(line.trim()) ?? 0;

    if (count === 0 || !line.trim()) return [];
    counts.set(line.trim(), count - 1);

    return [index];
  });
}

export function projectedEdit(change, text, phase) {
  if (change.created) {
    const result = phase === "pre" ? change.content : text;

    return {
      text: result,
      touched: new Set(result.split(/\r?\n/).map((_, index) => index + 1)),
    };
  }

  if (change.hunks) {
    let lines = text.split(/\r?\n/);
    const touched = new Set();

    for (const hunk of change.hunks) {
      const before = hunk.filter((row) => row.kind !== "+").map((row) => row.text);
      const after = hunk.filter((row) => row.kind !== "-").map((row) => row.text);
      const source = phase === "pre" ? before : after;
      const at = locate(lines, source);

      const added = new Set(editedIndices(
        hunk.filter((row) => row.kind === "-").map((row) => row.text),
        hunk.filter((row) => row.kind === "+").map((row) => row.text),
      ));

      if (phase === "pre") {
        const shift = after.length - before.length;

        for (const line of [...touched]) {
          if (line <= at + before.length) continue;
          touched.delete(line);
          touched.add(line + shift);
        }
      }

      let plusIndex = 0;
      let resultIndex = 0;

      for (const row of hunk) {
        if (row.kind === "-") continue;

        if (row.kind === "+" && added.has(plusIndex)) touched.add(at + resultIndex + 1);

        if (row.kind === "+") plusIndex++;
        resultIndex++;
      }

      if (phase === "pre") lines.splice(at, before.length, ...after);
    }

    return { text: lines.join("\n"), touched };
  }

  const before = change.before;
  const after = change.after;
  const fragment = phase === "pre" ? before : after;

  if (fragment.length === 0) throw new Error("edit has no matching context");

  const start = text.indexOf(fragment);

  if (start < 0 || text.indexOf(fragment, start + 1) >= 0) {
    throw new Error("edit context must identify exactly one location");
  }

  const line = text.slice(0, start).split("\n").length;

  const touched = new Set(editedIndices(before.split(/\r?\n/), after.split(/\r?\n/))
    .map((index) => line + index));

  return {
    text: phase === "pre" ? text.slice(0, start) + after + text.slice(start + before.length) : text,
    touched,
  };
}

export function maskNonCode(text) {
  const output = text.split("");
  const stack = [{ type: "code", expression: true, depth: 0 }];

  function hide(index) {
    if (text[index] !== "\n") output[index] = " ";
  }

  for (let index = 0; index < text.length; index++) {
    const frame = stack.at(-1);
    const char = text[index];
    const next = text[index + 1];

    if (frame.type === "line") {
      hide(index);

      if (char === "\n") stack.pop();
    } else if (frame.type === "block") {
      hide(index);

      if (char === "*" && next === "/") {
        hide(++index);
        stack.pop();
      }
    } else if (frame.type === "string" || frame.type === "regex") {
      hide(index);

      if (char === "\\") {
        if (next) hide(++index);
      } else if (frame.type === "regex" && char === "[") {
        frame.inClass = true;
      } else if (frame.type === "regex" && char === "]") {
        frame.inClass = false;
      } else if (char === frame.quote && !frame.inClass) {
        stack.pop();
        stack.at(-1).expression = false;
      }
    } else if (frame.type === "template") {
      hide(index);

      if (char === "\\") {
        if (next) hide(++index);
      } else if (char === "`") {
        stack.pop();
        stack.at(-1).expression = false;
      } else if (char === "$" && next === "{") {
        hide(++index);
        stack.push({ type: "code", expression: true, depth: 1 });
      }
    } else if (char === "/" && (next === "/" || next === "*")) {
      hide(index);
      hide(++index);
      stack.push({ type: next === "/" ? "line" : "block" });
    } else if (char === "/" && frame.expression) {
      hide(index);
      stack.push({ type: "regex", quote: "/", inClass: false });
    } else if (char === "'" || char === '"') {
      hide(index);
      stack.push({ type: "string", quote: char });
    } else if (char === "`") {
      hide(index);
      stack.push({ type: "template" });
    } else if (char === "}" && frame.depth > 0 && --frame.depth === 0) {
      hide(index);
      stack.pop();
    } else if (char === "{" && frame.depth > 0) {
      frame.depth++;
      frame.expression = true;
    } else if (/[A-Za-z_$\d]/.test(char)) {
      let end = index + 1;

      while (end < text.length && /[\w$]/.test(text[end])) end++;

      const token = text.slice(index, end);
      frame.expression = /^(?:return|throw|case|yield|await|typeof|void|delete|instanceof|in|of|new)$/.test(token);
      index = end - 1;
    } else if (!/\s/.test(char)) {
      frame.expression = !/[)\]}]/.test(char);
    }
  }

  return output.join("");
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

    if (!await isSafeWorkspaceFile(file, cwd) || !await isSafeWorkspaceFile(sourceFile, cwd)) continue;

    if (await isExistingGeneratedFile(sourceFile)) continue;

    const original = change.created ? "" : await readFile(sourceFile, "utf8");
    const { text, touched } = projectedEdit(change, original, "pre");

    if (change.created && isGeneratedSource(text)) continue;

    findings.push(...scanText(maskNonCode(text), path.relative(cwd, file))
      .filter((finding) => BLOCKED_PATTERNS.has(finding.pattern) && touched.has(finding.line)));
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
