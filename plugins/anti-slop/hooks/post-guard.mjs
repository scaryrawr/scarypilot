#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isGeneratedSource, isSafeWorkspaceFile } from "../skills/anti-slop/scripts/scan.mjs";
import { maskNonCode, projectedEdit, proposedChanges } from "./guard.mjs";
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

function recordGuardCandidates(text, touched) {
  const code = maskNonCode(text);
  const candidates = [];

  function wasAdded(start, end) {
    const first = lineNumber(text, start);
    const last = lineNumber(text, end);

    for (let line = first; line <= last; line++) {
      if (touched.has(line)) return true;
    }

    return false;
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

function introducedLine(diagnostic, touched, deletionAnchors, sourceBytes) {
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
      for (const adjacent of [line - 1, line, line + 1]) {
        if (touched.has(adjacent) || deletionAnchors.has(adjacent)) return adjacent;
      }
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
    const file = path.resolve(cwd, change.file);

    if (!await isSafeWorkspaceFile(file, cwd)) continue;

    const entries = files.get(file) ?? [];
    entries.push(change);
    files.set(file, entries);
  }

  for (const [file, entries] of files) {
    const metadata = await lstat(file);

    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;

    const text = await readFile(file, "utf8");

    if (isGeneratedSource(text)) continue;

    const relative = path.relative(cwd, file);
    const touched = new Set();
    const deletionAnchors = new Set();

    for (const change of entries) {
      const positions = projectedEdit(change, text, "post");

      for (const line of positions.touched) touched.add(line);

      for (const line of positions.deletionAnchors) deletionAnchors.add(line);
    }

    if (touched.size === 0 && deletionAnchors.size === 0) continue;

    const sourceBytes = Buffer.from(text);

    for (const diagnostic of await lint(file, cwd, { effect: await usesEffect(file, cwd) })) {
      const line = introducedLine(diagnostic, touched, deletionAnchors, sourceBytes);

      if (line === null) continue;
      const rule = diagnostic.code;
      findings.set(`${relative}:${line}:${rule}`,
        `${relative}:${line} ${rule}: ${diagnostic.message}`);
    }

    const sourceLines = text.split(/\r?\n/);

    if ([...touched].some((line) => POSSIBLE_GUARD.test(sourceLines[line - 1] ?? ""))) {
      for (const candidate of recordGuardCandidates(text, touched)) {
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
