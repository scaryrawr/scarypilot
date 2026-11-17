import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Value } from "@sinclair/typebox/value";
import { DecisionClient, DecisionError, validateInput } from "./decisions.ts";
import { CliInputSchema } from "./schemas.ts";

export function parseCliInput(text: string, model: string) {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new DecisionError("Input must be valid JSON.");
  }

  if (!Value.Check(CliInputSchema, value)) {
    throw new DecisionError("Invalid CLI input. Supply state (text, an object, or an array) or images, named questions with 2–26 choice/score criteria, and optional boolean truncate. Images accept only supplied padded base64 or data:image/...;base64,... strings, never file paths or path objects.");
  }

  if ((value.state === undefined || (typeof value.state === "string" && !value.state.trim())) && !value.images?.length) {
    throw new DecisionError("Input must contain state (text, an object, or an array) or images.");
  }

  for (const [name, question] of Object.entries(value.questions)) {
    if (question.type === "noul") continue;
    const count = question.type === "choice" ? Object.keys(question.criteria).length : question.criteria.length;

    if (count < 2 || count > 26 ||
        (question.type === "score" && question.criteria.some((label) => !label.trim()))) {
      throw new DecisionError(`Question ${JSON.stringify(name)} requires 2–26 nonempty criteria.`);
    }
  }

  const input = { ...value, model, state: value.state ?? "", truncate: value.truncate ?? false };

  validateInput(input, "cli");

  return input;
}

const usage = `Usage: node scripts/decide.mjs <command> [options]

Commands:
  models                           List installed models and decision model metadata
  run --model <id-or-alias> --input <file>   Send JSON {state, images?, questions, truncate?} to /v1/systemone
  help                             Show this help

Question types: choice, noul (yes/no probability), score (weighted zero-based level).
Use an exact installed model ID or an explicitly supplied unambiguous decision-model alias.
Exact IDs take precedence. Ambiguous aliases fail before inference.
Native tools require exact IDs. No automatic model choice, downloads, retries, or redirects.
Native text state must be nonblank, even with images.
Choice and score require 2–26 criteria. State may be omitted only with images.
Images accept supplied padded base64 or data:image/...;base64,... strings only.
Local file paths and path objects are rejected. There is no CLI approval override.
Native file uploads require the host's real per-call confirmation dialog.
Output preserves full SystemOne JSON, including answers, probabilities and usage.
truncate defaults to false. OpenJev never truncates; its vision models accept one image.
OMLX_BASE_URL defaults to http://localhost:8000. OMLX_API_KEY is optional.
Authenticated remote endpoints require HTTPS. Node 22.18.0 or later is required.`;

export async function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args;

  if (command === undefined || ["help", "--help", "-h"].includes(command)) {
    if (flags.length) throw new DecisionError("Help does not accept arguments.");
    console.log(usage);

    return;
  }

  if (command !== "run" && command !== "models") throw new DecisionError(`Unknown command: ${command}`);

  if (command === "models" && flags.length) throw new DecisionError("Models does not accept arguments.");

  const { values } = parseArgs({
    args: flags,
    options: { model: { type: "string" }, input: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });

  const client = new DecisionClient({
    metadataTimeoutMs: 10_000,
    inferenceTimeoutMs: 300_000,
    serverErrors: "messages",
    boundary: "cli",
  });

  if (command === "models") {
    const models = await client.listInstalled();

    if (!models.length) {
      console.log("No models found on OMLX endpoint. Install a decision model separately, then retry.");

      return;
    }

    console.log("DECISION MODELS (server-reported model_type=decision or engine_type=decision):");
    const decisions = models.filter((model) => model.model_type === "decision" || model.engine_type === "decision");

    for (const model of decisions) {
      console.log(`  - ${model.id}${model.model_alias ? ` (alias: ${model.model_alias})` : ""}${model.unavailable_reason ? ` (unavailable: ${model.unavailable_reason})` : ""}`);
    }

    if (!decisions.length) console.log("  None available. Install a decision model separately, then retry.");
    console.log("\nALL MODELS:");

    for (const model of models) {
      console.log(`  - ${model.id} (${model.model_type}${model.loaded === undefined ? "" : model.loaded ? ", loaded" : ", not loaded"})`);
    }

    return;
  }

  const { model, input } = values;

  if (!model?.trim()) throw new DecisionError("Provide --model with a non-empty value.");

  if (!input?.trim()) throw new DecisionError("Provide --input with a non-empty value.");
  let text: string;

  try {
    text = await readFile(input, "utf8");
  } catch {
    throw new DecisionError("Input file could not be read.");
  }

  const request = parseCliInput(text, model);
  console.log(JSON.stringify(await client.decide(request), null, 2));
}
