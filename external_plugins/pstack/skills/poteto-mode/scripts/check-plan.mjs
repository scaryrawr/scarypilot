#!/usr/bin/env node
import fs from "node:fs";
import { PLAN_PROFILES, validatePlanText } from "./plan-rules.mjs";

const args = process.argv.slice(2);
let profile = "verified-stack";
const profileIndex = args.indexOf("--profile");
if (profileIndex !== -1) {
  profile = args[profileIndex + 1] ?? "";
  args.splice(profileIndex, 2);
}
const file = args[0];
if (!file || args.length !== 1) {
  console.error(`Usage: node check-plan.mjs [--profile ${PLAN_PROFILES.join("|")}] <plan.md>`);
  process.exit(2);
}

try {
  const result = validatePlanText(fs.readFileSync(file, "utf8"), profile);
  for (const line of result.report) console.log(line);
  console.log(`${result.findings.length} problems`);
  for (const finding of result.findings) {
    console.error(`${file}:${finding.line}: [${finding.rule}] ${finding.message}`);
  }
  process.exit(result.findings.length ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
