import type { Direction, ReconstructedRun } from "./jsonl.ts";

/** Median of a numeric array (returns 0 for empty). */
export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function isBetter(current: number, best: number, direction: Direction): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Get results in the current segment only. */
export function currentResults(
  results: ReconstructedRun[],
  segment: number,
): ReconstructedRun[] {
  return results.filter((r) => r.segment === segment);
}

export function findBaselineMetric(
  results: ReconstructedRun[],
  segment: number,
): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

export function findBestMetric(
  results: ReconstructedRun[],
  segment: number,
  direction: Direction,
): number | null {
  const kept = currentResults(results, segment)
    .filter((r) => r.status === "keep")
    .map((r) => r.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

export function findBaselineRunNumber(
  results: ReconstructedRun[],
  segment: number,
): number | null {
  const idx = results.findIndex((r) => r.segment === segment);
  return idx >= 0 ? idx + 1 : null;
}

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Uses Median Absolute Deviation (MAD) of all metric values in the current
 * segment as a robust noise estimator. Returns `|best_delta| / MAD`.
 *
 * Returns null when there are fewer than 3 data points or when MAD is 0.
 */
export function computeConfidence(
  results: ReconstructedRun[],
  segment: number,
  direction: Direction,
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);
  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status !== "keep" || r.metric <= 0) continue;
    if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
      bestKept = r.metric;
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  return Math.abs(bestKept - baseline) / mad;
}

export function findBaselineSecondary(
  results: ReconstructedRun[],
  segment: number,
  knownMetrics?: { name: string }[],
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> = cur.length > 0 ? { ...(cur[0].metrics ?? {}) } : {};

  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] !== undefined) continue;
      for (const r of cur) {
        const val = (r.metrics ?? {})[sm.name];
        if (val !== undefined) {
          base[sm.name] = val;
          break;
        }
      }
    }
  }

  return base;
}
