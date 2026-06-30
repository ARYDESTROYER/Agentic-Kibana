/**
 * settings-dirty — pure helpers for the Round-3 Settings per-section dirty map.
 *
 * The Settings page buffers an editable `Preferences` draft against the last saved
 * snapshot. Instead of a whole-object diff (which forced a full PUT on any edit and
 * could clobber a concurrently-changed key), we compute the set of CHANGED TOP-LEVEL
 * keys and:
 *   - send ONLY those keys on Save (a minimal patch);
 *   - light a per-section "modified" dot when a section OWNS any changed key.
 *
 * Everything here is a pure function over plain data (no React, no DOM), so it is
 * unit-testable in isolation and shared by the page + its spec.
 *
 * SECURITY: this module never renders anything and never touches the network; it
 * only compares operator-entered preference values. Keys that are structurally
 * non-editable (`sources` / `setup_complete`) are excluded up front so they can
 * never appear in a patch.
 */

/** A loose Preferences view — we only ever index it by string key here. */
export type PrefsRecord = Record<string, unknown>;

/** Top-level keys that are never part of an editable patch (server-owned / derived). */
export const NON_EDITABLE_KEYS: ReadonlySet<string> = new Set(['sources', 'setup_complete']);

/**
 * Map each Settings SECTION id → the top-level Preferences keys it OWNS. Used only to
 * decide which section shows a "modified" dot; the Save patch is derived from the raw
 * changed-key set (so an unmapped/new key is still saved, just without a section dot).
 *
 * A key may legitimately appear under more than one section (e.g. `rag` is edited from
 * both Knowledge › Retrieval and Advanced › Suppression) — both sections then light up,
 * which is the correct, honest signal.
 */
export const SECTION_KEYS: Record<string, readonly string[]> = {
  general: [
    'data_view_pattern',
    'time_field',
    'source_ip_field',
    'user_field',
    'host_field',
    'rule_field',
    'rule_name_field',
    'severity_field',
    'severity_threshold',
    'investigate_lookback',
    'polling_enabled',
    'poll_interval_seconds',
    'poll_batch_size',
    'cold_start_lookback_minutes',
  ],
  models: [
    'router_model',
    'investigator_model',
    'formatter_model',
    'standup_model',
    'chat_model',
    'overview_model',
    'embedding_model',
  ],
  detection: [
    'default_correlation',
    'risk_weights',
    'escalation_confidence',
    'critical_severity',
    'fp_auto_close',
    'cross_source_correlation',
  ],
  cases: ['case_id_format'],
  automation: ['threshold_automation'],
  standup: ['standup'],
  notifications: ['notifications'],
  enrichment: ['enrichment'],
  knowledge: ['rag', 'threat_context'],
  security: ['sso', 'session_policy', 'mfa'],
  advanced: [
    'caps',
    'auto_forward_allowlist',
    'background_scan_enabled',
    'rag',
    'read_only_settings_mode',
    'excluded_rules',
    'in_scope_rules',
  ],
};

/** Stable, order-insensitive structural equality for two JSON-able values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * The set of EDITABLE top-level keys whose value diverges from the saved snapshot.
 * Considers keys present on either side (so a removed key counts), excludes the
 * structurally non-editable keys, and ignores `undefined`-vs-absent noise.
 */
export function changedKeys(
  draft: PrefsRecord | null | undefined,
  saved: PrefsRecord | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!draft || !saved) return out;
  const keys = new Set<string>([...Object.keys(draft), ...Object.keys(saved)]);
  for (const k of keys) {
    if (NON_EDITABLE_KEYS.has(k)) continue;
    const dv = draft[k];
    const sv = saved[k];
    // Treat `undefined` on one side and absent on the other as equal (no real edit).
    if (dv === undefined && sv === undefined) continue;
    if (!deepEqual(dv, sv)) out.add(k);
  }
  return out;
}

/**
 * Build the minimal Save patch: only the changed editable keys, taken from the draft.
 * A key changed to `undefined` is dropped (there is nothing to send), matching the
 * "additive fields are safe; omitted means unchanged" backend contract.
 */
export function changedPatch(
  draft: PrefsRecord | null | undefined,
  saved: PrefsRecord | null | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!draft) return patch;
  for (const k of changedKeys(draft, saved)) {
    const v = draft[k];
    if (v === undefined) continue;
    patch[k] = v;
  }
  return patch;
}

/** True when ANY editable top-level key differs from the saved snapshot. */
export function isDirty(
  draft: PrefsRecord | null | undefined,
  saved: PrefsRecord | null | undefined,
): boolean {
  return changedKeys(draft, saved).size > 0;
}

/** The subset of `changed` keys that belong to a given section (empty when none). */
export function sectionChangedKeys(sectionId: string, changed: ReadonlySet<string>): string[] {
  const owned = SECTION_KEYS[sectionId];
  if (!owned) return [];
  return owned.filter((k) => changed.has(k));
}

/** Whether a section owns at least one changed key (drives its "modified" dot). */
export function sectionIsDirty(sectionId: string, changed: ReadonlySet<string>): boolean {
  return sectionChangedKeys(sectionId, changed).length > 0;
}
