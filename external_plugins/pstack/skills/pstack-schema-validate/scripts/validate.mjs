#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { validatePlanText } from "../../poteto-mode/scripts/plan-rules.mjs";
import { ARTIFACT_KINDS, validateArtifact } from "./artifact-rules.mjs";

const [kind, file, profile = "verified-stack", ...extra] = process.argv.slice(2);

if (
  !kind || !file || extra.length > 0 ||
  ![...ARTIFACT_KINDS, "plan"].includes(kind)
) {
  console.error("Usage: node validate.mjs <snapshot|receipt|handoff|plan> <file> [basic|verified-stack]");
  process.exit(2);
}

try {
  const raw = readFileSync(file, "utf8");

  const findings = kind === "plan"
    ? validatePlanText(raw, profile).findings.map(
      (finding) => `${file}:${finding.line}: [${finding.rule}] ${finding.message}`,
    )
    : validateArtifact(kind, JSON.parse(raw)).findings.map(
      (finding) => `${finding.path}: ${finding.message}`,
    );

  for (const finding of findings) console.error(finding);

  if (findings.length > 0) process.exit(1);
  console.log(`${kind} contract valid: ${file}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
