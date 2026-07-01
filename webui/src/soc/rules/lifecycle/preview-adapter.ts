/**
 * Preview adapter (Round-5 G6 · R5) — the thin, deterministic mapping from a
 * `RuleForm` to the flat predicate list the read-only `POST /api/rules/preview`
 * endpoint evaluates (`RuleMatch[]` → `{field, op, value}[]`).
 *
 * Only a detection-MATCH tier has a flat predicate to preview: anomaly rules fire on
 * a learned baseline and case-automation rules react AFTER the deterministic decision,
 * so neither has a predicate the preview can count against — for those we return an
 * empty list and the panel explains why (never a meaningless scan). A row with no
 * `field` is dropped (the backend also skips malformed rows leniently). Nothing here
 * touches `decide()` — it is a pure form→wire projection.
 */
import type { RuleForm } from '../types';

export interface PreviewPredicate {
  field: string;
  op: string;
  value?: string;
}

/**
 * Map a rule form to the preview predicate list. Returns `[]` for tiers without a
 * flat predicate (anomaly / case-automation) and for a match rule whose rows are all
 * empty. `exists` rows drop the value (the backend ignores it). Pure + total.
 */
export function predicatesForPreview(rule: RuleForm): PreviewPredicate[] {
  if (rule.tier !== 'detection_match') return [];
  const out: PreviewPredicate[] = [];
  for (const row of rule.predicates ?? []) {
    const field = (row.field ?? '').trim();
    if (!field) continue;
    const pred: PreviewPredicate = { field, op: row.op };
    if (row.op !== 'exists') pred.value = row.value ?? '';
    out.push(pred);
  }
  return out;
}
