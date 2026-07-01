/**
 * Rules-FE shared types (Round-5 G6 · R2/R3) — the UI-only form model for the
 * "Detection & rules" editor, plus the RBAC grant every mutation gates on.
 *
 * ┌─ WHY A SEPARATE FORM MODEL ─────────────────────────────────────────────────┐
 * │ The editor is POLYMORPHIC on a TS discriminated union (`RuleForm`) over three │
 * │ tiers, but every tier is backed by an EXISTING backend config shape          │
 * │ (`RuleDefinition`/`CorrelationRule`/`RuleMatch`, `BaselineConfig`,           │
 * │ `CaseAutomationRule`). The form is a friendlier, tab-organised projection;   │
 * │ a THIN DETERMINISTIC ADAPTER (`./adapter`) maps `RuleForm` ⇄ those wire keys │
 * │ so `engine/case_manager.decide()` stays BYTE-IDENTICAL (#3). No control here │
 * │ ever calls `decide()` or sets a case status.                                 │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * Everything a rule carries — name, description, predicate field/value, tags — is
 * OPERATOR-authored and LOG-adjacent, so it renders PLAIN TEXT everywhere (#9).
 * Secrets never live on a rule; model overrides carry a selection, never a key (#10).
 *
 * These shapes are additive + defaulted; they mirror (and re-export) the config
 * types already in `@/lib/types` so a lifecycle/preview agent imports from ONE place.
 */
import type {
  AutomationActionType,
  AutomationConditions,
  AutomationRule,
  BaselineConfig,
  CorrelationMode,
  CorrelationRule,
  EntityTypeFull,
  ModelConfig,
  RuleDefinition,
  RuleMatch,
} from '@/lib/types';

// Re-export the backing config types so downstream (lifecycle/preview) importers use
// this module as the single rules entry-point rather than reaching into lib/types.
export type {
  AutomationActionType,
  AutomationConditions,
  AutomationRule,
  BaselineConfig,
  CorrelationMode,
  CorrelationRule,
  EntityTypeFull,
  ModelConfig,
  RuleDefinition,
  RuleMatch,
};

/* -------------------------------------------------------------- RBAC ------- */

/**
 * The ONE grant every rules MUTATION gates on (R9 unification). The backend RBAC
 * vocabulary (`rbac/policy.py RESOURCES`) exposes a narrow `automation` resource
 * with `read` / `manage`; the rules home/editors read on `automation:read` and
 * write on `automation:manage`. Surfacing this as a constant keeps the nav gate,
 * the section gate, and every in-editor `<Can>` on the SAME resolvable grant.
 */
export const RULES_PERM = { resource: 'automation', action: 'manage' } as const;
/** The read-only grant (view the catalog / open the read-only editor). */
export const RULES_READ_PERM = { resource: 'automation', action: 'read' } as const;

/* --------------------------------------------------------- tier taxonomy --- */

/**
 * The three rule tiers the editor exposes (RESEARCH_RULES_UX §2). Each is backed by
 * existing code; we deliberately do NOT copy Elastic's 7 rule types.
 *
 * - `detection_match`   — a classify-an-event rule (`RuleDefinition` + `RuleMatch`)
 *                          with an optional threshold/suppression (`CorrelationRule`:
 *                          `n === 1` ⇒ a simple match rule; `n > 1` ⇒ a threshold rule).
 * - `detection_anomaly` — fire on deviation from a learned baseline (`BaselineConfig`);
 *                          advisory input to a candidate, NEVER `decide()`.
 * - `case_automation`   — a POST-decision, HITL-safe reaction (`CaseAutomationRule`);
 *                          tag/recommend/notify/run_playbook/request_approval; NEVER
 *                          sets status or auto-closes (#3, code-enforced backend-side).
 */
export type RuleTier = 'detection_match' | 'detection_anomaly' | 'case_automation';

/** Static metadata per tier (label / blurb / whether it is a config-writer only). */
export interface RuleTierMeta {
  tier: RuleTier;
  label: string;
  /** One-line description (plain text). */
  blurb: string;
  /** True for a detection tier (writes `rule_catalog`); false for case-automation. */
  detection: boolean;
}

/* --------------------------------------------------------- condition rows -- */

/**
 * One flat predicate row (R3). This IS the backend `RuleMatch` shape
 * (`{field, op, value}`) — the condition builder is a repeatable list of these,
 * ANDed. Nested AND/OR is deferred to the gated Phase-3 wave. `field`/`value` are
 * operator-authored → plain text (#9). When `op === 'exists'` the value is unused.
 */
export interface PredicateRow {
  field: string;
  op: RuleMatch['op'];
  value?: string;
}

/** The predicate operators the backend `RuleMatch` evaluates. */
export type PredicateOp = 'equals' | 'prefix' | 'tag' | 'exists';

/* --------------------------------------------------------- threshold ------ */

/**
 * The threshold + grouping knobs (mirrors `CorrelationRule`). `n === 1` renders the
 * editor as a MATCH rule (no count gate); `n > 1` renders it as a THRESHOLD rule
 * ("fire when ≥ N events share the group-by within the window"). `mode` mirrors the
 * wire enum; the UI derives it from `n` on save (`n === 1 → 'every'`, else
 * `'threshold'`) but preserves an explicit `'never'`.
 */
export interface ThresholdForm {
  /** Group-by entity (the correlation key). */
  groupBy: EntityTypeFull;
  /** Trigger-after count (≥1). 1 ⇒ match rule; >1 ⇒ threshold rule. */
  n: number;
  /** Window (seconds ≥1) over which the N events must occur. */
  windowSeconds: number;
  /** Explicit correlation mode; preserved on round-trip (usually derived from `n`). */
  mode?: CorrelationMode;
}

/**
 * Suppression (collapse alert storms) — a DISTINCT concept from threshold (Elastic
 * keeps them separate; conflating them is a known analyst pitfall). Up to 3 group-by
 * fields + a scope + window. This is a UI-forward concept; today it maps onto the
 * same `CorrelationRule.window_seconds`/`group_by` knobs, so the adapter keeps it
 * OPTIONAL and non-destructive (never drops a candidate, #4).
 */
export interface SuppressionForm {
  /** Up-to-3 fields to collapse a storm by (plain text). */
  by: string[];
  /** Per-run vs. per-time-window suppression. */
  scope: 'per_run' | 'per_window';
  /** Window (seconds) for `per_window` scope. */
  windowSeconds?: number;
  /** Behaviour when a group-by field is missing on an event. */
  missingField: 'suppress' | 'keep';
}

/* --------------------------------------------------------- anomaly -------- */

/**
 * The anomaly/baseline knobs (mirrors `BaselineConfig`). Fires when a signature
 * deviates from its learned baseline; advisory only (never feeds `decide()`).
 */
export interface AnomalyForm {
  /** Group-by entity for the per-signature baseline. */
  groupBy: EntityTypeFull;
  /** Modified-z deviation bar (default |M| > 3.5). */
  sensitivity: number;
  /** `warmup_multiplier` × min_samples guards a cold series. */
  warmupMultiplier: number;
  /** Seasonality bucketing (mirrors `BaselineConfig.seasonality`). */
  seasonality: NonNullable<BaselineConfig['seasonality']>;
}

/* --------------------------------------------------------- case-automation- */

/**
 * The case-automation form (mirrors `CaseAutomationRule` / `AutomationRule`). A
 * matched rule reacts AFTER the deterministic decision and can only tag / recommend /
 * notify / run a playbook / request approval — it NEVER sets status (#3). This mirrors
 * the existing `Settings › Automation` editor so the two stay wire-compatible.
 */
export interface CaseAutomationForm {
  /** ANDed conditions; an absent condition means "any". */
  conditions: AutomationConditions;
  /** The single #3-safe action. */
  action: AutomationActionType;
  /** Action-specific payload (operator-authored, TRUSTED-but-plain). */
  payload: Record<string, unknown>;
}

/* --------------------------------------------------------- the union ------ */

/**
 * The "About" metadata shared by every tier (name / description / enabled /
 * priority / per-role model overrides / MITRE). `name`/`description` are plain (#9);
 * `modelOverride` carries a ModelConfig selection, never a secret key (#10).
 */
export interface RuleAbout {
  name: string;
  description: string;
  enabled: boolean;
  /** Lower runs first. */
  priority: number;
  /** Per-role model overrides (role → selection). Detection tiers only. */
  modelOverride?: Record<string, ModelConfig>;
  /** MITRE technique ids (advisory, About-advanced). Plain text (#9). */
  mitre?: string[];
}

/**
 * The lifecycle state a rule sits in (RESEARCH_RULES_UX §6a). `shadow` evaluates
 * against live data but creates no real cases (degrades to advisory). This is a
 * UI-forward concept the lifecycle wave persists; the editor carries it so the shell
 * can render it. Detection tiers use `enabled`⇄`disabled`; `shadow` is opt-in.
 */
export type RuleLifecycleState = 'enabled' | 'disabled' | 'shadow';

/**
 * The DISCRIMINATED UNION the editor's Define tab is polymorphic on. Each variant is
 * a self-contained, tier-specific form. `about` + `schedule` are common. A thin
 * deterministic adapter (`./adapter`) maps this ⇄ the existing wire keys.
 */
export type RuleForm =
  | {
      tier: 'detection_match';
      about: RuleAbout;
      /** Flat AND predicate rows (R3); the first row backs the wire `match`. */
      predicates: PredicateRow[];
      threshold: ThresholdForm;
      suppression?: SuppressionForm;
      schedule?: ScheduleForm;
    }
  | {
      tier: 'detection_anomaly';
      about: RuleAbout;
      anomaly: AnomalyForm;
      schedule?: ScheduleForm;
    }
  | {
      tier: 'case_automation';
      about: RuleAbout;
      automation: CaseAutomationForm;
    };

/**
 * The Schedule tab (RESEARCH_RULES_UX §3). Detection rules "run every {interval}"
 * with an "additional look-back". Today this reuses the per-feed schedule +
 * `{source.id}:{feed.id}` cursor, so it is OPTIONAL/advisory in the form (the wire
 * `RuleDefinition` has no schedule of its own — the poller schedule owns cadence).
 */
export interface ScheduleForm {
  /** How often the rule evaluates (seconds). */
  intervalSeconds?: number;
  /** Extra look-back window on each run (seconds) to catch late-arriving events. */
  lookbackSeconds?: number;
}

/* --------------------------------------------------------- catalog item --- */

/**
 * A row in the "Detection & rules" home. Detection rules come from
 * `Preferences.rule_catalog` (a `RuleDefinition[]`); case-automation rules from
 * `Preferences.threshold_automation.rules`. The home merges both into one table
 * keyed by a stable local `key` (name for detection, id for automation).
 */
export interface RuleCatalogItem {
  /** Stable local key for React lists (detection: name; automation: id). */
  key: string;
  tier: RuleTier;
  /** Display name (plain text). */
  name: string;
  enabled: boolean;
  /** Ascending run order. */
  priority: number;
  /** The lifecycle state chip (defaults from `enabled`). */
  lifecycle: RuleLifecycleState;
}
