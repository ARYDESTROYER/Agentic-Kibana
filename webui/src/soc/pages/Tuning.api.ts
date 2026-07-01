/**
 * Co-located data layer for the adaptive-threshold TUNING admin surface
 * (Round 4 / Wave 4). Exposes the deterministic, no-LLM nightly tuner
 * (`backend/app/engine/threshold_tuner.py`) + its append-only audit/rollback ledger
 * (`backend/app/stores/tuning.py`) to an operator.
 *
 * Endpoints (all under `/api`, all gated `automation:read` / `automation:manage`):
 *   GET  /tuning/recommendations   — per-rule noise (Wilson-LB FP rate + counts) +
 *                                    the tuner's PROPOSED bounded change per rule
 *                                    (pure DRY-RUN — no write) + the applied ledger.
 *   GET  /tuning/config            — read Preferences.threshold_tuning.
 *   PUT  /tuning/config            — update Preferences.threshold_tuning (admin).
 *   POST /tuning/{rule_id}/apply   — apply ONE rule's proposed bounded change (shadow-
 *                                    evaluated; a DROP is routed to the HITL Proposal
 *                                    queue, never auto-applied here).
 *   POST /tuning/{rule_id}/rollback — reverse the latest active auto-applied change.
 *
 * We use the low-level `api.get/post/put` verbs from `@/lib/api` rather than adding
 * methods to the shared client, so this builder stays parallel-safe.
 *
 * ⛔ HONEST FRAMING (#3): tuning ONLY moves detection-VOLUME knobs (a correlation
 * rule's `n`, a feed's `severity_floor`) that change WHICH candidates get
 * investigated — it NEVER sets a case status/disposition/verdict/risk and never calls
 * the deterministic `decide()`. A suppression DROP is never auto-applied; it becomes a
 * HITL Proposal linked to the Approvals queue.
 *
 * SECURITY (#9): every rule_id / feed key / error string here is operator-/log-derived
 * PLAIN data. The consuming components render it escaped (plain text / CodeBlock) and
 * it is never fed back into a prompt. The types below describe the SHAPE only.
 */
import { api } from '@/lib/api';

/** How often the nightly tuner runs (mirrors backend `ThresholdTuningConfig.cadence`). */
export type TuningCadence = 'hourly' | 'nightly' | 'weekly' | 'manual';

/**
 * The tuning policy (mirrors backend `config.ThresholdTuningConfig`). Default OFF, so
 * out-of-the-box behaviour is byte-identical. Fields beyond the four the UI edits
 * (`enabled`/`min_samples`/`fp_rate_target`/`cadence`) are carried verbatim on
 * round-trip so a PUT never drops the advanced knobs.
 */
export interface TuningConfig {
  enabled: boolean;
  min_samples: number;
  max_n_step: number;
  fp_rate_target: number;
  wilson_z: number;
  ewma_alpha: number;
  cadence: TuningCadence;
  shadow_eval: boolean;
}

/** A safe default matching the backend's defaults (used before the config loads). */
export const DEFAULT_TUNING_CONFIG: TuningConfig = {
  enabled: false,
  min_samples: 25,
  max_n_step: 1,
  fp_rate_target: 0.3,
  wilson_z: 1.96,
  ewma_alpha: 0.2,
  cadence: 'nightly',
  shadow_eval: true,
};

/** One observed rule's noise picture (from `_accumulate_rule_stats`). */
export interface RuleNoise {
  rule_id: string;
  total: number;
  fp: number;
  tp: number;
  /** Wilson lower-bound FP rate (0..1). */
  fp_rate: number;
  volume_ewma: number | null;
  /** True when this rule has enough samples AND clears the FP-rate target. */
  over_target: boolean;
}

/** One dry-run proposed bounded change for a rule. */
export interface TuningRecommendation {
  rule_id: string;
  /** "correlation_n" | "severity_floor" | "suppression". */
  kind: string;
  before: unknown;
  after: unknown;
  feed_key: string | null;
  source_id: string | null;
  feed_id: string | null;
  fp_rate: number;
  samples: number;
  /** False for a suppression DROP or a shadow-blocked raise (both need review). */
  auto_apply: boolean;
  /** True when a shadow-eval showed the change would have hidden a true positive. */
  shadow_blocked: boolean;
  /** "suppression_drop" | "shadow_eval_would_hide_tp" | "auto_apply_candidate". */
  reason: string;
}

/**
 * One applied/rolled-back ledger row (from `TuningStore.list()` → `TuningRecord.to_json()`).
 *
 * ⚠ BUG #12 CONTRACT: the backend serializes `rolled_back` (bool) + `rolled_back_at`
 * — it does NOT emit an `active` field. The prior UI read a non-existent `row.active`,
 * so EVERY row rendered the same state. Consumers MUST derive the real state from
 * `rolled_back` (see {@link isLedgerRowActive}); a row without `rolled_back:true` is
 * still active. `active` is kept OPTIONAL only for the apply-response shape (which does
 * echo it in tests) and is never trusted for the ledger render.
 */
export interface TuningLedgerRow {
  id: string;
  rule_id: string;
  target: string;
  before: unknown;
  after: unknown;
  /** True once the change has been reversed (the authoritative state field, #12). */
  rolled_back?: boolean;
  rolled_back_at?: string | null;
  applied_at?: string;
  /** Optional; only some producers set it. NOT authoritative — use {@link isLedgerRowActive}. */
  active?: boolean;
  actor?: string;
  reason?: string;
  rationale?: string;
  [k: string]: unknown;
}

/**
 * BUG #12: the real per-row lifecycle state. A ledger row is ACTIVE unless it has been
 * rolled back. We honour an explicit `rolled_back` flag / `rolled_back_at` timestamp
 * first (the authoritative backend fields), then fall back to an `active` flag if a
 * producer happens to set one. A row that carries none of these defaults to ACTIVE
 * (it was just applied).
 */
export function isLedgerRowActive(row: TuningLedgerRow): boolean {
  if (row.rolled_back === true) return false;
  if (row.rolled_back_at) return false;
  if (typeof row.active === 'boolean') return row.active;
  return true;
}

/** GET /api/tuning/recommendations — the whole dry-run picture + ledger. */
export interface TuningRecommendationsResponse {
  enabled: boolean;
  cadence: string;
  fp_rate_target: number;
  min_samples: number;
  window_cases: number;
  rule_noise: RuleNoise[];
  recommendations: TuningRecommendation[];
  applied: TuningLedgerRow[];
}

/** POST /api/tuning/{rule}/apply outcome. */
export interface TuningApplyResponse {
  ok: boolean;
  rule_id: string;
  applied: TuningLedgerRow[];
  queued_proposals: Array<{ id: string; kind: string; status: string }>;
  shadow_blocked: string[];
}

export const tuningApi = {
  /** The dry-run per-rule noise + proposed changes + applied ledger. */
  recommendations: () =>
    api.get<TuningRecommendationsResponse>('tuning/recommendations'),
  /** Read the tuning policy. */
  getConfig: () => api.get<{ config: TuningConfig }>('tuning/config'),
  /** Update the tuning policy (admin). */
  putConfig: (config: TuningConfig) =>
    api.put<{ ok: boolean; config: TuningConfig }>('tuning/config', config),
  /** Apply ONE rule's proposed bounded change (shadow-evaluated). */
  apply: (ruleId: string) =>
    api.post<TuningApplyResponse>(
      `tuning/${encodeURIComponent(ruleId)}/apply`,
    ),
  /** Reverse the latest active auto-applied change for a rule/feed key. */
  rollback: (ruleId: string) =>
    api.post<{ ok: boolean; rule_id: string; record_id: string }>(
      `tuning/${encodeURIComponent(ruleId)}/rollback`,
    ),
};

/** Human labels for the recommendation `kind`. */
export const KIND_LABELS: Record<string, string> = {
  correlation_n: 'Correlation threshold',
  severity_floor: 'Severity floor',
  suppression: 'Suppression (drop)',
};

/** Human labels for the recommendation `reason`. */
export const REASON_LABELS: Record<string, string> = {
  auto_apply_candidate: 'Safe to apply',
  shadow_eval_would_hide_tp: 'Shadow-eval blocked (would hide a true positive)',
  suppression_drop: 'Routes to Approvals (never auto-applied)',
};

/** Present a possibly-object before/after change value as a plain string. */
export function tuneValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
