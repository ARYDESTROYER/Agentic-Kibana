/**
 * Rules-FE api glue (Round-5 G6 · R2/R3) — a thin, typed wrapper over the EXISTING
 * `api` client so the rules subtree imports from ONE place and never re-implements a
 * request path.
 *
 * Every WRITE here is a CONFIG WRITE via the deep-merge `PUT /api/settings`
 * (`api.putSettings`) — the nginx `/api` proxy forwards arbitrary JSON, and the
 * backend deep-merges the patch, so we PATCH only the blocks we own
 * (`rule_catalog` / `threshold_automation` / `baseline`) and never full-doc-replace
 * the `Preferences` doc. No write here calls `decide()` (#3); no secret is ever sent
 * or returned (#10).
 *
 * The read/preview scaffolds mirror the W0-F contracts:
 *  - `api.rules.list()`             → the detection-rule catalog (GET /api/rules).
 *  - `api.triage.previewDecision()` → the PURE what-if over `decide()` (never bills
 *                                     an LLM, #6; never writes a case).
 */
import { api } from '@/lib/api';
import type {
  AutomationRule,
  BaselineConfig,
  Preferences,
  RuleDefinition,
} from '@/lib/types';
import type {
  PreviewDecisionInput,
  PreviewDecisionResult,
  RuleKind,
  RulePreviewInput,
  RulePreviewResult,
  RuleRollbackResult,
  RulesResponse,
  RuleVersion,
  RuleVersionsResponse,
} from '@/lib/api';

export type {
  PreviewDecisionInput,
  PreviewDecisionResult,
  RuleKind,
  RulePreviewInput,
  RulePreviewResult,
  RuleRollbackResult,
  RulesResponse,
  RuleVersion,
  RuleVersionsResponse,
};

/** GET the detection-rule catalog (scaffold; the home also derives it from prefs). */
export function listRules(): Promise<RulesResponse> {
  return api.rules.list();
}

/**
 * Save the whole detection-rule catalog. Rides the deep-merge `PUT /api/settings`
 * (`rule_catalog` is a full-array replace by design — the operator owns the ordered
 * list), never touching sibling `Preferences` blocks.
 */
export function saveRuleCatalog(catalog: RuleDefinition[]): Promise<{ ok: boolean; prefs: Preferences }> {
  return api.putSettings({ rule_catalog: catalog } as Partial<Preferences>);
}

/**
 * Save the case-automation rule list. Deep-merges the `threshold_automation` block so
 * its `enabled` master flag is preserved when only the rules change.
 */
export function saveAutomationRules(
  rules: AutomationRule[],
  enabled?: boolean,
): Promise<{ ok: boolean; prefs: Preferences }> {
  const block: Partial<Preferences>['threshold_automation'] = { rules };
  if (typeof enabled === 'boolean') block.enabled = enabled;
  return api.putSettings({ threshold_automation: block } as Partial<Preferences>);
}

/** Save the shared anomaly/baseline block (partial deep-merge). */
export function saveBaseline(config: Partial<BaselineConfig>): Promise<{ ok: boolean; prefs: Preferences }> {
  return api.putSettings({ baseline: config } as Partial<Preferences>);
}

/**
 * The PURE what-if over the deterministic `decide()`. It NEVER bills an LLM (#6, zero
 * UsageDoc), never writes a case, and never re-implements the decision — the backend
 * calls the SAME pure `decide()` and projects the result. The rules editor uses this
 * to prove a threshold/auto-close change moves what `decide()` acts on WITHOUT running
 * a real investigation.
 */
export function previewDecision(input: PreviewDecisionInput): Promise<PreviewDecisionResult> {
  return api.triage.previewDecision(input);
}

/* ----------------------------------------------------- lifecycle (R5) ------ */

/**
 * The immutable per-rule version ledger (newest first). READ-only; a rollback
 * appends a new version rather than mutating history (#2). `kind` is
 * `detection | correlation | case_automation`.
 */
export function listRuleVersions(kind: RuleKind, ruleId: string): Promise<RuleVersionsResponse> {
  return api.rules.versions(kind, ruleId);
}

/**
 * One-click rollback: restore a rule to a prior version's WHOLE config. Rides the
 * SAME deep-merge config-writer path a normal edit uses (never a full-doc replace),
 * then APPENDS a `rollback` version. NEVER calls `decide()` (#3).
 */
export function rollbackRule(
  kind: RuleKind,
  ruleId: string,
  versionId: string,
): Promise<RuleRollbackResult> {
  return api.rules.rollback(kind, ruleId, versionId);
}

/**
 * The read-only rule-scoped PREVIEW over recent data. Counts how many recent events
 * WOULD match the predicate through the scoped, read-only, hard-capped scatter-gather
 * (#1). It NEVER bills the LLM (#6, zero UsageDoc), NEVER calls `decide()` (#3), and
 * NEVER creates a case — it is a pure read that returns counts + a histogram.
 */
export function previewRule(input: RulePreviewInput): Promise<RulePreviewResult> {
  return api.rules.preview(input);
}
