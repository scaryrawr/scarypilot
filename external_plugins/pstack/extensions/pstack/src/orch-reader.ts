import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256 } from "./io.ts";
import type {
  FrontierSummary,
  GateSummary,
  LedgerSummary,
  OrchProjection,
  SourceDigest,
  SourceWarning,
  UnitSummary,
  VerificationVerdict,
} from "./types.ts";

const VERDICTS = new Set<VerificationVerdict>([
  "live-ui-verified",
  "unit-test-verified",
  "type-check-only",
  "verifier-blocked",
  "verifier-failed",
]);

interface OrchReadResult {
  readonly projection: OrchProjection | null;
  readonly sources: readonly SourceDigest[];
  readonly warnings: readonly SourceWarning[];
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function rows(raw: string, expectedHeader: string): string[][] {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.shift() !== expectedHeader) {
    throw new Error(`expected header ${JSON.stringify(expectedHeader)}`);
  }
  return lines.map((line) => line.split("\t"));
}

function counts(values: readonly string[]): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...new Set(values)].sort().map((value) => [
      value,
      values.filter((candidate) => candidate === value).length,
    ]),
  );
}

function parseUnits(raw: string): UnitSummary[] {
  return rows(raw, "id\ttrack\tstate\tbranch\tpr\tsha\tbrief").map(
    ([id = "", track = "", state = "", branch = "", pr = "", sha = "", brief = ""]) => ({
      id,
      track,
      state,
      branch,
      pr,
      sha,
      brief,
    }),
  );
}

function parseLedger(raw: string): LedgerSummary[] {
  return rows(raw, "pr\tsha\tverdict\tevidence\tverifier\tts").map(
    ([pr = "", sha = "", verdict = "", evidence = "", verifier = "", timestamp = ""]) => {
      if (!VERDICTS.has(verdict as VerificationVerdict)) {
        throw new Error(`unknown ledger verdict ${JSON.stringify(verdict)}`);
      }
      return {
        pr,
        sha,
        verdict: verdict as VerificationVerdict,
        evidence,
        verifier,
        timestamp,
      };
    },
  );
}

function parseGates(raw: string): GateSummary[] {
  const clean = raw.replace(/\r/g, "").trim();
  if (clean === "") return [];
  const prefix = "# Gates\n\n## ";
  if (!clean.startsWith(prefix)) throw new Error("gates.md has an invalid heading");
  const result: GateSummary[] = [];
  for (const block of clean.slice(prefix.length).split("\n\n## ")) {
    const lines = block.split("\n").filter(Boolean);
    const id = lines.shift() ?? "";
    const fields = new Map<string, string>();
    for (const line of lines) {
      const match = /^- ([^:]+): (.*)$/.exec(line);
      if (!match) throw new Error(`gates.md has a malformed gate ${id}`);
      fields.set(match[1] ?? "", match[2] ?? "");
    }
    const status = fields.get("Status");
    const question = fields.get("Question");
    const options = fields.get("Options");
    const defaultAnswer = fields.get("Default");
    if (!id || question === undefined || options === undefined || defaultAnswer === undefined) {
      throw new Error(`gates.md has a malformed gate ${id}`);
    }
    if (status === "open") {
      result.push({ id, question, options, defaultAnswer });
    } else if (status === "resolved" && fields.has("Answer")) {
      continue;
    } else {
      throw new Error(`gates.md has invalid status ${status ?? ""}`);
    }
  }
  if (new Set(result.map((gate) => gate.id)).size !== result.length) {
    throw new Error("gates.md has duplicate open gate ids");
  }
  return result;
}

function parseFrontier(raw: string): FrontierSummary {
  const value = JSON.parse(raw) as Partial<FrontierSummary>;
  if (Object.keys(value).length === 0) {
    return { generation: 0, prs: [], lowestUnmerged: null };
  }
  if (
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0 ||
    !Array.isArray(value.prs) ||
    !(
      value.lowestUnmerged === null ||
      (Number.isSafeInteger(value.lowestUnmerged) && Number(value.lowestUnmerged) > 0)
    )
  ) {
    throw new Error("frontier.json has an unsupported shape");
  }
  const prs = value.prs.map((row) => {
    if (
      row === null ||
      typeof row !== "object" ||
      !Number.isSafeInteger(row.pr) ||
      row.pr < 1 ||
      typeof row.branches !== "string" ||
      row.branches.length === 0 ||
      typeof row.sha !== "string" ||
      row.sha.length === 0 ||
      !["OPEN", "MERGED", "CLOSED"].includes(row.state)
    ) {
      throw new Error("frontier.json has an invalid PR row");
    }
    return row;
  });
  return {
    generation: value.generation as number,
    prs,
    lowestUnmerged: value.lowestUnmerged ?? null,
  };
}

export async function readOrchStore(storeDir?: string): Promise<OrchReadResult> {
  if (!storeDir) return { projection: null, sources: [], warnings: [] };
  const directory = resolve(storeDir);
  const warnings: SourceWarning[] = [];
  const sources: SourceDigest[] = [];
  const read = async (name: string): Promise<string | null> => {
    const path = join(directory, name);
    try {
      const raw = await optionalFile(path);
      if (raw !== null) sources.push({ kind: "orch", path, digest: sha256(raw) });
      return raw;
    } catch (error) {
      warnings.push({ source: "orch", path, message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  const [unitsRaw, ledgerRaw, gatesRaw, frontierRaw] = await Promise.all([
    read("units.tsv"),
    read("ledger.tsv"),
    read("gates.md"),
    read("frontier.json"),
  ]);
  if (unitsRaw === null && ledgerRaw === null && gatesRaw === null && frontierRaw === null) {
    warnings.push({ source: "orch", path: directory, message: "orch store is missing or uninitialized" });
    return { projection: null, sources, warnings };
  }
  let units: UnitSummary[] = [];
  let ledger: LedgerSummary[] = [];
  let openGates: GateSummary[] = [];
  let frontier: FrontierSummary | null = null;
  for (const [name, parse] of [
    ["units.tsv", () => { if (unitsRaw !== null) units = parseUnits(unitsRaw); }],
    ["ledger.tsv", () => { if (ledgerRaw !== null) ledger = parseLedger(ledgerRaw); }],
    ["gates.md", () => { if (gatesRaw !== null) openGates = parseGates(gatesRaw); }],
    ["frontier.json", () => { if (frontierRaw !== null) frontier = parseFrontier(frontierRaw); }],
  ] as const) {
    try {
      parse();
    } catch (error) {
      warnings.push({
        source: "orch",
        path: join(directory, name),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    projection: {
      storeDir: directory,
      units: units.sort((left, right) => left.id.localeCompare(right.id)),
      ledger: ledger.sort((left, right) => `${left.pr}:${left.sha}`.localeCompare(`${right.pr}:${right.sha}`)),
      openGates: openGates.sort((left, right) => left.id.localeCompare(right.id)),
      frontier,
      unitCounts: counts(units.map((unit) => unit.state)),
      ledgerCounts: counts(ledger.map((entry) => entry.verdict)),
    },
    sources: sources.sort((left, right) => left.path.localeCompare(right.path)),
    warnings,
  };
}
