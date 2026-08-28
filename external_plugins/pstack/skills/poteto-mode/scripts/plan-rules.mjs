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

export const PLAN_PROFILES = ["basic", "verified-stack"];

function preparedLines(rawText) {
  const raw = rawText.split(/\r?\n/);
  let start = 0;
  if (raw[0] === "---") {
    const end = raw.indexOf("---", 1);
    if (end !== -1) start = end + 1;
  }
  const lines = [];
  let fence = false;
  for (let i = start; i < raw.length; i++) {
    const text = raw[i];
    if (/^```/.test(text)) fence = !fence;
    lines.push({ n: i + 1, text, code: fence });
  }
  return lines;
}

function commonFindings(lines) {
  const findings = [];
  const fail = (line, rule, message) => findings.push({ line, rule, message });
  for (const line of lines) {
    if (line.code) continue;
    const prose = line.text
      .replace(/`[^`]*`/g, "`")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\]\([^)]*\)/g, "]");
    if (/[\u2013\u2014]/.test(prose)) fail(line.n, "ascii-dash", "long dash");
    if (/[\u2018\u2019\u201c\u201d]/.test(prose)) fail(line.n, "ascii-quote", "curly quote");
    if (/: \S/.test(prose)) fail(line.n, "sentence-colon", "mid-sentence colon");
  }
  if (!lines.some((line) => !line.code && line.text.startsWith("# "))) {
    fail(1, "h1", "no H1 title");
  }
  return findings;
}

function strictFindings(lines) {
  const findings = [];
  const fail = (line, rule, message) => findings.push({ line, rule, message });
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
  const howToRead = find("How to read this");
  if (!howToRead) fail(1, "how-to-read", 'no "## How to read this" section');
  if (h1 !== -1 && howToRead) {
    const intro = lines.slice(h1 + 1).filter((line) => line.n < howToRead.n && line.text.trim() !== "");
    if (intro.length >= 10) fail(lines[h1].n, "intro-length", `intro is ${intro.length} lines, under ten required`);
    for (const marker of HOW_TO_READ_MARKERS) {
      if (!bodyText(howToRead).includes(marker)) {
        fail(howToRead.n, "how-to-read-marker", `How to read this lacks "${marker}"`);
      }
    }
  }

  const program = find("Program checklist");
  if (!program) fail(1, "program-checklist", 'no "## Program checklist" section');
  else {
    const h3s = program.body
      .filter((line) => !line.code && line.text.startsWith("### "))
      .map((line) => line.text.slice(4).trim());
    let cursor = 0;
    for (const name of PROGRAM_H3) {
      const at = h3s.findIndex((title, index) => index >= cursor && title.startsWith(name));
      if (at === -1) fail(program.n, "program-order", `Program checklist lacks "### ${name}" in order`);
      else cursor = at + 1;
    }
    for (const marker of PROGRAM_MARKERS) {
      const ok = marker instanceof RegExp ? marker.test(bodyText(program)) : bodyText(program).includes(marker);
      if (!ok) fail(program.n, "program-marker", `Program checklist lacks "${marker}"`);
    }
  }

  const close = find("Close the program");
  if (!close) fail(1, "close-program", 'no "## Close the program" section');
  const programIndex = sections.indexOf(program);
  const closeIndex = sections.indexOf(close);
  const prSections = programIndex === -1 || closeIndex === -1 ? [] : sections.slice(programIndex + 1, closeIndex);
  if (prSections.length === 0) fail(1, "pr-sections", "no PR sections between Program checklist and Close the program");

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
      fail(pr.n, "pr-blocks", `${pr.title}: sub-blocks are [${names.join(", ")}], expected [${SUB_BLOCKS.join(", ")}]`);
    }
    const block = (name) => heads.find((head) => head.name === name);
    const counts = {};
    for (const head of heads) counts[head.name] = boxes(head.lines).length;

    const depends = block("Depends on.");
    if (depends && depends.rest === "") fail(depends.n, "depends", `${pr.title}: Depends on names nothing`);
    for (const name of ["Files.", "Build.", "You see.", "Verify, unit.", "Merge."]) {
      const current = block(name);
      if (current && boxes(current.lines).length === 0) fail(current.n, "required-box", `${pr.title}: ${name} has no box`);
    }
    for (const name of ["Verify, unit.", "Verify, live.", "Verify, perf."]) {
      const current = block(name);
      if (current && !current.rest.startsWith(RULE)) {
        fail(current.n, "verification-rule", `${pr.title}: ${name} does not open with the rule`);
      }
    }

    const live = block("Verify, live.");
    if (live) {
      if (!live.rest.includes(LANES)) fail(live.n, "live-lanes", `${pr.title}: Verify, live lacks "${LANES}"`);
      const lanes = boxes(live.lines).map((box) => ({ ...box, match: box.text.match(/^Lane (\d+)\. /) }));
      const numbers = lanes
        .filter((lane) => lane.match)
        .map((lane) => Number(lane.match[1]))
        .sort((a, b) => a - b);
      const expected = Array.from({ length: lanes.length }, (_, index) => index + 1).join(",");
      if (numbers.join(",") !== expected) fail(live.n, "lane-sequence", `${pr.title}: lanes are [${numbers.join(",")}], expected 1 to ${lanes.length}`);
      for (const lane of lanes) {
        if (!lane.match) fail(lane.n, "lane-shape", `${pr.title}: live box is not a lane`);
        else if (!/Save `[^`]+`/.test(lane.text)) fail(lane.n, "lane-evidence", `${pr.title}: lane ${lane.match[1]} names no evidence artifact`);
        else if (!lane.text.includes("Pass when")) fail(lane.n, "lane-predicate", `${pr.title}: lane ${lane.match[1]} has no pass predicate`);
      }
    }

    const perf = block("Verify, perf.");
    if (perf) {
      const items = boxes(perf.lines).map((box) => box.text.split(" ")[0]);
      if (items.join("|") !== PERF_ITEMS.join("|")) {
        fail(perf.n, "perf-shape", `${pr.title}: perf boxes are [${items.join(", ")}], expected [${PERF_ITEMS.join(", ")}]`);
      }
    }

    const gate = block("Review gate.");
    if (gate) {
      const gateBoxes = boxes(gate.lines);
      if (gate.rest.startsWith("None.")) {
        if (gateBoxes.length) fail(gate.n, "review-gate", `${pr.title}: Review gate says None but has boxes`);
      } else {
        if (gateBoxes.length === 0) fail(gate.n, "review-gate", `${pr.title}: Review gate has no box`);
        const text = gate.lines.map((line) => line.text).join("\n");
        for (const word of ["screenshot", "recording", "operator"]) {
          if (!text.includes(word)) fail(gate.n, "review-gate-evidence", `${pr.title}: Review gate lacks "${word}"`);
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
      if (!section.title.startsWith("Appendix")) {
        fail(section.n, "appendix-order", `## ${section.title} after Close the program is not an appendix`);
      }
    }
    if (!tail.some((section) => section.title.includes("Prototype evidence"))) {
      fail(close.n, "prototype-evidence", 'no "## Appendix ... Prototype evidence" section');
    }
  }
  return { findings, report, prSections: prSections.length };
}

export function validatePlanText(rawText, profile = "verified-stack") {
  if (!PLAN_PROFILES.includes(profile)) {
    throw new Error(`unknown plan profile ${JSON.stringify(profile)}; expected ${PLAN_PROFILES.join(" or ")}`);
  }
  const lines = preparedLines(rawText);
  const common = commonFindings(lines);
  if (profile === "basic") {
    const boxes = lines.filter((line) => !line.code && BOX.test(line.text)).length;
    if (boxes === 0) common.push({ line: 1, rule: "checklist", message: "no checklist boxes" });
    return { profile, findings: common, report: [`${boxes} checklist boxes`] };
  }
  const strict = strictFindings(lines);
  return {
    profile,
    findings: [...common, ...strict.findings],
    report: [...strict.report, `${strict.prSections} PR sections`],
  };
}
