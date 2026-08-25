#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const RULE =
  "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";
const LANES = "Parallel Copilot Task workers at the PR head";
const SUB_BLOCKS = [
  "Depends on.",
  "Files.",
  "Build.",
  "You see.",
  "Verify, unit.",
  "Verify, live.",
  "Verify, perf.",
  "Review gate.",
  "Merge.",
];
const PROGRAM_H3 = ["Arm the program", "Spawn owners", "PR mechanics", "Verdict and merge", "Boot recipe"];
const PROGRAM_MARKERS = ["decision-trail", /30[- ]minute/, "status message"];
const HOW_TO_READ_MARKERS = [
  "One box is one unit of work",
  "names the evidence",
  "Check a box only when its evidence exists",
  "playbooks/",
  RULE,
];
const PERF_ITEMS = ["Metric.", "Probe.", "Baseline.", "Rule."];
const BOX = /^\s*- \[[ x]\] (.*)$/;

const file = process.argv[2];
if (!file) {
  console.error("Usage: node check-plan.mjs <plan.md>");
  process.exit(2);
}

const raw = fs.readFileSync(file, "utf8").split(/\r?\n/);
const problems = [];
const fail = (line, message) => problems.push(`${file}:${line}: ${message}`);

let start = 0;
if (raw[0] === "---") {
  const end = raw.indexOf("---", 1);
  if (end !== -1) start = end + 1;
}

const lines = [];
let fence = false;
for (let i = start; i < raw.length; i++) {
  const text = raw[i];
  const n = i + 1;
  if (/^```/.test(text)) fence = !fence;
  lines.push({ n, text, code: fence });
  if (fence) continue;
  const prose = text
    .replace(/`[^`]*`/g, "`")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\]\([^)]*\)/g, "]");
  if (/[\u2013\u2014]/.test(prose)) fail(n, "long dash");
  if (/[\u2018\u2019\u201c\u201d]/.test(prose)) fail(n, "curly quote");
  if (/: \S/.test(prose)) fail(n, "mid-sentence colon");
}

const h2 = (line) => (!line.code && line.text.startsWith("## ") ? line.text.slice(3).trim() : null);
const sections = [];
for (const line of lines) {
  const title = h2(line);
  if (title !== null) sections.push({ title, n: line.n, body: [] });
  else if (sections.length) sections.at(-1).body.push(line);
}
const find = (title) => sections.find((section) => section.title === title);
const bodyText = (section) => section.body.map((line) => line.text).join("\n");
const boxes = (items) =>
  items.filter((line) => !line.code && BOX.test(line.text)).map((line) => ({
    n: line.n,
    text: line.text.match(BOX)[1],
  }));

const h1 = lines.findIndex((line) => !line.code && line.text.startsWith("# "));
if (h1 === -1) fail(1, "no H1 title");
const howToRead = find("How to read this");
if (!howToRead) fail(1, 'no "## How to read this" section');
if (h1 !== -1 && howToRead) {
  const intro = lines.slice(h1 + 1).filter((line) => line.n < howToRead.n && line.text.trim() !== "");
  if (intro.length >= 10) fail(lines[h1].n, `intro is ${intro.length} lines, under ten required`);
  for (const marker of HOW_TO_READ_MARKERS) {
    if (!bodyText(howToRead).includes(marker)) fail(howToRead.n, `How to read this lacks "${marker}"`);
  }
}

const program = find("Program checklist");
if (!program) fail(1, 'no "## Program checklist" section');
else {
  const h3s = program.body
    .filter((line) => !line.code && line.text.startsWith("### "))
    .map((line) => line.text.slice(4).trim());
  let cursor = 0;
  for (const name of PROGRAM_H3) {
    const at = h3s.findIndex((title, index) => index >= cursor && title.startsWith(name));
    if (at === -1) fail(program.n, `Program checklist lacks "### ${name}" in order`);
    else cursor = at + 1;
  }
  for (const marker of PROGRAM_MARKERS) {
    const ok = marker instanceof RegExp ? marker.test(bodyText(program)) : bodyText(program).includes(marker);
    if (!ok) fail(program.n, `Program checklist lacks "${marker}"`);
  }
}

const close = find("Close the program");
if (!close) fail(1, 'no "## Close the program" section');
const programIndex = sections.indexOf(program);
const closeIndex = sections.indexOf(close);
const prSections = programIndex === -1 || closeIndex === -1 ? [] : sections.slice(programIndex + 1, closeIndex);
if (prSections.length === 0) fail(1, "no PR sections between Program checklist and Close the program");

const report = [];
for (const pr of prSections) {
  const heads = [];
  for (const line of pr.body) {
    if (line.code) continue;
    const match = line.text.match(/^\*\*([^*]+)\*\*(.*)$/);
    if (match && SUB_BLOCKS.includes(match[1])) {
      heads.push({ name: match[1], n: line.n, rest: match[2].trim(), lines: [] });
    } else if (heads.length) heads.at(-1).lines.push(line);
  }
  const names = heads.map((head) => head.name);
  if (names.join("|") !== SUB_BLOCKS.join("|")) {
    fail(pr.n, `${pr.title}: sub-blocks are [${names.join(", ")}], expected [${SUB_BLOCKS.join(", ")}]`);
  }
  const block = (name) => heads.find((head) => head.name === name);
  const counts = {};
  for (const head of heads) counts[head.name] = boxes(head.lines).length;

  const depends = block("Depends on.");
  if (depends && depends.rest === "") fail(depends.n, `${pr.title}: Depends on names nothing`);
  for (const name of ["Files.", "Build.", "You see.", "Verify, unit.", "Merge."]) {
    const current = block(name);
    if (current && boxes(current.lines).length === 0) fail(current.n, `${pr.title}: ${name} has no box`);
  }
  for (const name of ["Verify, unit.", "Verify, live.", "Verify, perf."]) {
    const current = block(name);
    if (current && !current.rest.startsWith(RULE)) fail(current.n, `${pr.title}: ${name} does not open with the rule`);
  }

  const live = block("Verify, live.");
  if (live) {
    if (!live.rest.includes(LANES)) fail(live.n, `${pr.title}: Verify, live lacks "${LANES}"`);
    const lanes = boxes(live.lines).map((box) => ({ ...box, match: box.text.match(/^Lane (\d+)\. /) }));
    const numbers = lanes
      .filter((lane) => lane.match)
      .map((lane) => Number(lane.match[1]))
      .sort((a, b) => a - b);
    const expected = Array.from({ length: lanes.length }, (_, index) => index + 1).join(",");
    if (numbers.join(",") !== expected) fail(live.n, `${pr.title}: lanes are [${numbers.join(",")}], expected 1 to ${lanes.length}`);
    for (const lane of lanes) {
      if (!lane.match) fail(lane.n, `${pr.title}: live box is not a lane`);
      else if (!/Save `[^`]+`/.test(lane.text)) fail(lane.n, `${pr.title}: lane ${lane.match[1]} names no evidence artifact`);
      else if (!lane.text.includes("Pass when")) fail(lane.n, `${pr.title}: lane ${lane.match[1]} has no pass predicate`);
    }
  }

  const perf = block("Verify, perf.");
  if (perf) {
    const items = boxes(perf.lines).map((box) => box.text.split(" ")[0]);
    if (items.join("|") !== PERF_ITEMS.join("|")) fail(perf.n, `${pr.title}: perf boxes are [${items.join(", ")}], expected [${PERF_ITEMS.join(", ")}]`);
  }

  const gate = block("Review gate.");
  if (gate) {
    const gateBoxes = boxes(gate.lines);
    if (gate.rest.startsWith("None.")) {
      if (gateBoxes.length) fail(gate.n, `${pr.title}: Review gate says None but has boxes`);
    } else {
      if (gateBoxes.length === 0) fail(gate.n, `${pr.title}: Review gate has no box`);
      const text = gate.lines.map((line) => line.text).join("\n");
      for (const word of ["screenshot", "recording", "operator"]) {
        if (!text.includes(word)) fail(gate.n, `${pr.title}: Review gate lacks "${word}"`);
      }
    }
  }

  const total = boxes(pr.body).length;
  const cells = SUB_BLOCKS
    .filter((section) => section !== "Depends on.")
    .map((section) => `${section.replace(/[ ,.]+/g, "-").replace(/-$/, "").toLowerCase()}=${counts[section] ?? 0}`);
  report.push(`${pr.title}  boxes=${total}  ${cells.join(" ")}`);
}

if (closeIndex !== -1) {
  const tail = sections.slice(closeIndex + 1);
  for (const section of tail) {
    if (!section.title.startsWith("Appendix")) fail(section.n, `## ${section.title} after Close the program is not an appendix`);
  }
  if (!tail.some((section) => section.title.includes("Prototype evidence"))) {
    fail(close.n, 'no "## Appendix ... Prototype evidence" section');
  }
}

for (const line of report) console.log(line);
console.log(`${prSections.length} PR sections, ${problems.length} problems`);
for (const problem of problems) console.error(problem);
process.exit(problems.length ? 1 : 0);
