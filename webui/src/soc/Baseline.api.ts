/**
 * Co-located API + types for the anomaly-BASELINE warm-up gauge (Round 4 / Wave 4).
 *
 * Kept OUT of the shared `lib/api.ts` (parallel-build hygiene) per the co-located
 * `*.api.ts` convention. Endpoints (all under `/api`, READ-ONLY, `settings:read`):
 *   GET /api/baseline/stats          — the tenant-wide warm-up + coverage overview
 *                                      (how many signatures/buckets, how many WARM,
 *                                      and the config knobs that drive the gauge).
 *   GET /api/baseline/{signature}    — one signature's per-bucket warm-up state
 *                                      (n / target, warm bool, progress) + robust
 *                                      p50/p95/p99 read from the persisted t-digest.
 *
 * These make the "improves over time" WARM-UP visible so an operator can audit that
 * a baseline is still warming (n/target) rather than silently trusting it.
 *
 * SECURITY (#9): a `signature` is source-derived (it can embed rule/entity text). The
 * backend returns it BOUNDED + PLAIN; the consuming components render it as a plain
 * React text node / in a fenced CodeBlock — never HTML, never re-fed into a prompt.
 * The types below describe the SHAPE only; they grant no trust.
 *
 * #3/#4: the baseline is a PURE ADVISORY producer — nothing here (or the routes it
 * calls) touches `decide()` or mutates a cluster signature. A warm-up state can never
 * close or escalate a case.
 */
import { api } from '@/lib/api';

/** One signature's warm-up rollup within GET /api/baseline/stats. */
export interface BaselineSignatureStat {
  /** Source-derived, bounded PLAIN text (#9). */
  signature: string;
  /** How many per-signature seasonal buckets have a sketch. */
  buckets: number;
  /** How many of those buckets are WARM (crossed the warm-up target). */
  warm_buckets: number;
  /** The largest per-bucket sample count seen for this signature. */
  max_samples: number;
  /** True when every bucket for this signature is warm. */
  fully_warm: boolean;
}

/** GET /api/baseline/stats — the tenant-wide warm-up + coverage overview. */
export interface BaselineStats {
  enabled: boolean;
  signature_count: number;
  total_buckets: number;
  warm_buckets: number;
  /** Observations a bucket needs to be WARM (warmup_multiplier x seasonal_period). */
  warmup_target: number;
  /** Plain text seasonality key (e.g. "hour_of_week"). */
  seasonality: string;
  half_life_days: number;
  modified_z_threshold: number;
  sketch_version: number;
  signatures: BaselineSignatureStat[];
}

/** One per-bucket warm-up + percentile row within GET /api/baseline/{signature}. */
export interface BaselineBucketRow {
  /** The seasonal bucket index (e.g. 0..167 for hour-of-week). */
  bucket: number;
  /** Observations seen in this bucket so far. */
  n: number;
  /** Observations needed for this bucket to be WARM. */
  target: number;
  /** True once `n >= target`. */
  warm: boolean;
  /** min(1, n/target) — the 0..1 warm-up progress for the gauge. */
  progress: number;
  p50: number;
  p95: number;
  p99: number;
}

/** GET /api/baseline/{signature} — one signature's warm-up state + percentiles. */
export interface BaselineSignature {
  /** Source-derived, bounded PLAIN text (#9). */
  signature: string;
  /** False when the signature has no persisted baseline yet (empty-but-renderable). */
  found: boolean;
  warmup_target: number;
  buckets: number;
  warm_buckets: number;
  seasonality: string;
  series: BaselineBucketRow[];
}

/** GET /api/baseline/stats. */
export function fetchBaselineStats(): Promise<BaselineStats> {
  // Defer through Promise.resolve so a synchronous stub failure surfaces as a
  // rejection (callers wrap this in try/catch or Promise.allSettled).
  return Promise.resolve().then(() => api.get<BaselineStats>('baseline/stats'));
}

/** GET /api/baseline/{signature} (never 404s — an unseen signature returns a shell). */
export function fetchBaselineSignature(signature: string): Promise<BaselineSignature> {
  return Promise.resolve().then(() =>
    api.get<BaselineSignature>(`baseline/${encodeURIComponent(signature)}`),
  );
}

export const baselineApi = {
  stats: fetchBaselineStats,
  signature: fetchBaselineSignature,
};
