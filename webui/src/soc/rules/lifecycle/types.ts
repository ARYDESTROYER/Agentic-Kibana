/**
 * Rules-FE lifecycle types (Round-5 G6 · R5) — the small, UI-forward shapes the
 * lifecycle surface (health chip · preview panel · version ledger + diff · rollback)
 * consumes, on top of the shared rules types + the backend contracts.
 *
 * ┌─ THE HARD INVARIANTS THIS SURFACE UPHOLDS ──────────────────────────────────┐
 * │ #3  Nothing here calls `decide()`. The Test/Preview reads recent data via the │
 * │     read-only, hard-capped RB endpoint and the pure `previewDecision` wrapper. │
 * │     The version ledger + rollback are CONFIG operations only — a rollback rides │
 * │     the deep-merge config-writer path and NEVER sets a case status.            │
 * │ #6  The preview NEVER bills the LLM (zero UsageDoc) — it is a pure read.       │
 * │ #2  Every lifecycle event (create/edit/enable/disable/rollback) is append-only │
 * │     audited + versioned server-side; the ledger renders that immutable history. │
 * │ #9  Every rule id/name/field/summary/log value renders PLAIN text.            │
 * └────────────────────────────────────────────────────────────────────────────────┘
 *
 * These are additive + defaulted; they re-export the backend-mirrored shapes so the
 * lifecycle subtree imports from ONE place.
 */
import type {
  RuleKind,
  RulePreviewBucket,
  RulePreviewInput,
  RulePreviewResult,
  RulePreviewSampleRow,
  RuleRollbackResult,
  RuleVersion,
  RuleVersionsResponse,
} from '@/lib/api';
import type { RuleLifecycleState } from '../types';

export type {
  RuleKind,
  RulePreviewBucket,
  RulePreviewInput,
  RulePreviewResult,
  RulePreviewSampleRow,
  RuleRollbackResult,
  RuleVersion,
  RuleVersionsResponse,
  RuleLifecycleState,
};

/* ------------------------------------------------------------ health chip -- */

/**
 * The per-rule "last response" health signal (RESEARCH_RULES_UX §6e). A rule that
 * suddenly goes silent is a top breakage signal; the chip makes it visible. Derived
 * client-side from the last-run outcome + the version ledger — advisory only.
 */
export type RuleHealthStatus = 'ok' | 'warning' | 'failed' | 'unknown';

export interface RuleHealth {
  status: RuleHealthStatus;
  /** A short, plain human label ("Succeeded", "No recent matches", …). */
  label: string;
  /** Optional last-run ISO timestamp (from the ledger's newest version). */
  lastRunAt?: string | null;
}

/* -------------------------------------------------------- diff (dep-free) -- */

/**
 * The kind of change to a single field when diffing two rule-config snapshots.
 * Computed by a tiny in-house field diff — NO diff library (DESIGN_STANDARD dep
 * ledger; RESEARCH_RULES_UX §6c).
 */
export type FieldDiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

/**
 * One field-level diff row between a PRIOR (`before`) and a CURRENT (`after`) rule
 * config. `path` is a dotted key path (plain text). `before`/`after` are the
 * JSON-stringified scalar/array/object values (plain text — render escaped, #9).
 */
export interface FieldDiff {
  path: string;
  kind: FieldDiffKind;
  /** Stringified prior value (undefined when `added`). */
  before?: string;
  /** Stringified current value (undefined when `removed`). */
  after?: string;
}

/* --------------------------------------------------------- what-if (F4) ----
 *
 * The preview panel's "what would the deterministic decision be?" strip consumes
 * `PreviewDecisionInput`/`PreviewDecisionResult` from `@/lib/api` directly (via
 * `previewDecision`). A separate local `WhatIfInputs` duplicate was never imported by
 * the panel and has been removed to avoid a misleading orphan type (#47).
 */
