#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isGeneratedSource, isScannableFile } from "../skills/anti-slop/scripts/scan.mjs";
import { maskNonCode, proposedChanges } from "./guard.mjs";
import { lintFile } from "./oxlint-runtime.mjs";

const GENERIC_RECORD = String.raw`Record\s*<\s*(?:string|PropertyKey)\s*,\s*(?:unknown|any)\s*>`;

const RECORD_PREDICATE = new RegExp(
  String.raw`\b[A-Za-z_$][\w$]*\s+is\s+${GENERIC_RECORD}`,
  "g",
);

const NAMED_GUARD = /\b(?:function|const|let)\s+(is[A-Za-z_$\d]*Record[A-Za-z_$\d]*)\b/g;

const OBJECT_CHECK = /\btypeof\s+[A-Za-z_$][\w$]*\s*===?\s*(['"])object\1/g;

const POSSIBLE_GUARD = /\bRecord\b|\bis[A-Za-z_$\d]*Record[A-Za-z_$\d]*\b/;

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function recordGuardCandidates(text, changedLines) {
  const code = maskNonCode(text);
  const added = new Set(changedLines.map((line) => line.trim()).filter(Boolean));
  const candidates = [];

  function wasAdded(start, end) {
    const firstLine = text.lastIndexOf("\n", start - 1) + 1;
    const lastLine = text.indexOf("\n", end);
    const span = text.slice(firstLine, lastLine === -1 ? text.length : lastLine);

    return span.split(/\r?\n/).some((line) => added.has(line.trim()));
  }

  for (const match of code.matchAll(RECORD_PREDICATE)) {
    if (!wasAdded(match.index, match.index + match[0].length)) continue;

    candidates.push({
      line: lineNumber(text, match.index),
      kind: "generic record type predicate",
    });
  }

  for (const match of code.matchAll(NAMED_GUARD)) {
    if (!wasAdded(match.index, match.index + match[0].length)) continue;

    const end = Math.min(text.length, match.index + 350);
    const declaration = text.slice(match.index, end);
    const terminator = declaration.search(/[;}]/);
    const snippet = declaration.slice(0, terminator === -1 ? undefined : terminator + 1);
    const objectCheck = OBJECT_CHECK.exec(snippet);

    OBJECT_CHECK.lastIndex = 0;

    if (
      !objectCheck ||
      code.slice(match.index + objectCheck.index).slice(0, 6) !== "typeof" ||
      [...code.slice(match.index, match.index + snippet.length).matchAll(RECORD_PREDICATE)].length > 0
    ) {
      continue;
    }

    candidates.push({
      line: lineNumber(text, match.index),
      kind: `generic object guard ${match[1]}`,
    });
  }

  return candidates;
}

async function usesEffect(file, cwd) {
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    let manifest;

    try {
      manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (manifest) {
      return ["dependencies", "devDependencies", "peerDependencies"].some((group) =>
        typeof manifest[group]?.effect === "string"
      );
    }

    if (directory === cwd) return false;
  }
}

function touchedLines(text, addedLines) {
  const added = new Set(addedLines.map((line) => line.trim()).filter(Boolean));
  const touched = new Set();

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (added.has(line.trim())) touched.add(index + 1);
  }

  return touched;
}

function introducedLine(diagnostic, touched, sourceBytes) {
  for (const label of diagnostic.labels ?? []) {
    const span = label.span;
    const line = span?.line;

    if (!Number.isInteger(line)) continue;

    const excerpt = Number.isInteger(span.offset) && Number.isInteger(span.length)
      ? sourceBytes.subarray(span.offset, span.offset + span.length).toString("utf8")
      : "";

    const lastLine = line + (excerpt.match(/\n/g)?.length ?? 0);

    for (let current = line; current <= lastLine; current++) {
      if (touched.has(current)) return current;
    }

    if (diagnostic.code === "anti-slop(require-readable-spacing)") {
      if (touched.has(line - 1)) return line - 1;

      if (touched.has(line + 1)) return line + 1;
    }
  }

  return null;
}

export async function reviewEdit(input, { lint = lintFile } = {}) {
  if (
    !input ||
    typeof input.cwd !== "string" ||
    typeof input.toolName !== "string" ||
    input.toolResult?.resultType !== "success"
  ) {
    throw new Error("invalid postToolUse payload");
  }

  const cwd = path.resolve(input.cwd);
  const changes = proposedChanges(input.toolName, input.toolArgs);
  const findings = new Map();
  const files = new Map();

  for (const change of changes) {
    if (change.lines.length === 0) continue;

    const file = path.resolve(cwd, change.file);

    if (!isScannableFile(file, cwd)) continue;

    const lines = files.get(file) ?? [];
    lines.push(...change.lines);
    files.set(file, lines);
  }

  for (const [file, lines] of files) {
    const metadata = await lstat(file);

    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;

    const text = await readFile(file, "utf8");

    if (isGeneratedSource(text)) continue;

    const relative = path.relative(cwd, file);
    const touched = touchedLines(text, lines);
    const sourceBytes = Buffer.from(text);

    for (const diagnostic of await lint(file, cwd, { effect: await usesEffect(file, cwd) })) {
      const line = introducedLine(diagnostic, touched, sourceBytes);

      if (line === null) continue;
      const rule = diagnostic.code;
      findings.set(`${relative}:${line}:${rule}`,
        `${relative}:${line} ${rule}: ${diagnostic.message}`);
    }

    if (lines.some((line) => POSSIBLE_GUARD.test(line))) {
      for (const candidate of recordGuardCandidates(text, lines)) {
        const location = `${relative}:${candidate.line}`;
        findings.set(`${location}:record-guard`, `${location} ${candidate.kind}: ` +
          "use a named domain contract for internal values, or parse at a real I/O boundary.");
      }
    }
  }

  if (findings.size === 0) return {};

  const locations = [...findings.values()];
  const more = locations.length > 4 ? ` (+${locations.length - 4} more)` : "";

  return {
    additionalContext: `Anti-Slop advisory on newly edited code:\n` +
      `${locations.slice(0, 4).join("\n")}${more}\n` +
      "Review each finding in context and fix its root cause; retain intentional boundary checks where justified.",
  };
}

async function main() {
  let payload = "";

  for await (const chunk of process.stdin) payload += chunk;
  process.stdout.write(`${JSON.stringify(await reviewEdit(JSON.parse(payload)))}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`anti-slop post-edit hook failed: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`${JSON.stringify({
      additionalContext: `Anti-Slop full checks could not run: ${error instanceof Error ? error.message : String(error)}`,
    })}\n`);
  });
}
