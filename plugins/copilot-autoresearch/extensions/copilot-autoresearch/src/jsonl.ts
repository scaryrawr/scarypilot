/**
 * Parses and reconstructs in-memory state from `autoresearch.jsonl`.
 * Ported from pi-autoresearch.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const JsonValueSchema = Type.Recursive((self) =>
  Type.Union([
    Type.Boolean(),
    Type.Null(),
    Type.Number(),
    Type.String(),
    Type.Array(self),
    Type.Record(Type.String(), self),
  ]),
);

const JsonlEntrySchema = Type.Record(Type.String(), JsonValueSchema);

const StringSchema = Type.String();

const NumberSchema = Type.Number();

const AutoresearchConfigEntrySchema = Type.Object({
  type: Type.Literal("config"),
  name: Type.Optional(JsonValueSchema),
  metricName: Type.Optional(JsonValueSchema),
  metricUnit: Type.Optional(JsonValueSchema),
  bestDirection: Type.Optional(JsonValueSchema),
  timestamp: Type.Optional(JsonValueSchema),
});

const AutoresearchRunEntrySchema = Type.Object({
  run: Type.Number(),
  commit: Type.Optional(JsonValueSchema),
  metric: Type.Optional(JsonValueSchema),
  metrics: Type.Optional(JsonValueSchema),
  status: Type.Optional(JsonValueSchema),
  description: Type.Optional(JsonValueSchema),
  timestamp: Type.Optional(JsonValueSchema),
  segment: Type.Optional(JsonValueSchema),
  confidence: Type.Optional(JsonValueSchema),
  asi: Type.Optional(JsonValueSchema),
});

type JsonValue = Static<typeof JsonValueSchema>;

export type JsonlEntry = Static<typeof JsonlEntrySchema>;

export type RunStatus = "keep" | "discard" | "crash" | "checks_failed";

export type Direction = "lower" | "higher";

export type AutoresearchConfigEntry = Static<typeof AutoresearchConfigEntrySchema>;

export type AutoresearchRunEntry = Static<typeof AutoresearchRunEntrySchema>;

export type MetricMap = Record<string, number>;

export interface ReconstructedMetricDef {
  name: string;
  unit: string;
}

export interface ReconstructedRun {
  run: number;
  commit: string;
  metric: number;
  metrics: MetricMap;
  status: RunStatus;
  description: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  asi?: JsonlEntry;
}

export interface ReconstructedJsonlState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: Direction;
  currentSegment: number;
  results: ReconstructedRun[];
  secondaryMetrics: ReconstructedMetricDef[];
}

const DEFAULT_METRIC_NAME = "metric";

const DEFAULT_METRIC_UNIT = "";

const DEFAULT_DIRECTION: Direction = "lower";

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

export function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";

  if (name.endsWith("_ms")) return "ms";

  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";

  if (name.endsWith("_kb")) return "kb";

  if (name.endsWith("_mb")) return "mb";

  return "";
}

function metricMapFrom(value: JsonValue | undefined) {
  if (!Value.Check(JsonlEntrySchema, value)) return {};

  const metrics: MetricMap = {};

  for (const [name, metric] of Object.entries(value)) {
    if (Value.Check(NumberSchema, metric) && Number.isFinite(metric)) metrics[name] = metric;
  }

  return metrics;
}

function statusFrom(value: JsonValue | undefined): RunStatus {
  if (value === "discard") return "discard";

  if (value === "crash") return "crash";

  if (value === "checks_failed") return "checks_failed";

  return "keep";
}

function directionFrom(value: JsonValue | undefined): Direction {
  return value === "higher" ? "higher" : DEFAULT_DIRECTION;
}

function asiFrom(value: JsonValue | undefined): JsonlEntry | undefined {
  return Value.Check(JsonlEntrySchema, value) ? value : undefined;
}

function emptyState(): ReconstructedJsonlState {
  return {
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    currentSegment: 0,
    results: [],
    secondaryMetrics: [],
  };
}

function applyConfig(state: ReconstructedJsonlState, entry: AutoresearchConfigEntry): void {
  if (Value.Check(StringSchema, entry.name)) state.name = entry.name;

  if (Value.Check(StringSchema, entry.metricName)) state.metricName = entry.metricName;

  if (Value.Check(StringSchema, entry.metricUnit)) state.metricUnit = entry.metricUnit;

  state.bestDirection = directionFrom(entry.bestDirection);
}

function nextSegment(state: ReconstructedJsonlState, segment: number): number {
  if (state.results.length === 0) return segment;
  state.secondaryMetrics = [];

  return segment + 1;
}

function runFrom(entry: AutoresearchRunEntry, segment: number): ReconstructedRun {
  return {
    run: entry.run,
    commit: Value.Check(StringSchema, entry.commit) ? entry.commit : "",
    metric: Value.Check(NumberSchema, entry.metric) ? entry.metric : 0,
    metrics: metricMapFrom(entry.metrics),
    status: statusFrom(entry.status),
    description: Value.Check(StringSchema, entry.description) ? entry.description : "",
    timestamp: Value.Check(NumberSchema, entry.timestamp) ? entry.timestamp : 0,
    segment,
    confidence: Value.Check(NumberSchema, entry.confidence) ? entry.confidence : null,
    asi: asiFrom(entry.asi),
  };
}

function registerSecondaryMetrics(
  state: ReconstructedJsonlState,
  metrics: MetricMap,
): void {
  for (const name of Object.keys(metrics)) {
    if (state.secondaryMetrics.find((m) => m.name === name)) continue;
    state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
  }
}

export function parseJsonlEntry(line: string): JsonlEntry | null {
  try {
    const parsed = JSON.parse(line);

    return Value.Check(JsonlEntrySchema, parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isAutoresearchConfigEntry(
  entry: JsonValue,
): entry is AutoresearchConfigEntry {
  return Value.Check(AutoresearchConfigEntrySchema, entry);
}

export function isAutoresearchRunEntry(entry: JsonValue): entry is AutoresearchRunEntry {
  return Value.Check(AutoresearchRunEntrySchema, entry);
}

function firstConfigEntry(jsonlContent: string): AutoresearchConfigEntry | null {
  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);

    if (isAutoresearchConfigEntry(entry)) return entry;
  }

  return null;
}

export function hasAutoresearchConfigHeader(jsonlContent: string): boolean {
  return firstConfigEntry(jsonlContent) !== null;
}

export function extractAutoresearchSessionName(jsonlContent: string): string {
  const name = firstConfigEntry(jsonlContent)?.name;

  return Value.Check(StringSchema, name) && name ? name : "Autoresearch";
}

export function reconstructJsonlState(jsonlContent: string): ReconstructedJsonlState {
  const state = emptyState();
  let segment = 0;

  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);

    if (!entry) continue;

    if (isAutoresearchConfigEntry(entry)) {
      applyConfig(state, entry);
      segment = nextSegment(state, segment);
      state.currentSegment = segment;
      continue;
    }

    if (!isAutoresearchRunEntry(entry)) continue;

    const run = runFrom(entry, segment);
    state.results.push(run);
    registerSecondaryMetrics(state, run.metrics);
  }

  return state;
}
