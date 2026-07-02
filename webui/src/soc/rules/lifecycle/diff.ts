/**
 * A tiny, dependency-free FIELD DIFF between two rule-config snapshots (Round-5 G6 ·
 * R5, RESEARCH_RULES_UX §6c). The version-ledger UI shows a red/green inline diff of
 * what changed between two versions of a rule — we deliberately compute a SIMPLE
 * field diff rather than pulling a diff library (DESIGN_STANDARD dep ledger).
 *
 * Strategy: flatten both configs into a map of `dotted.path → stringified value`
 * (leaves = scalars; arrays + non-plain objects are stringified whole so a nested
 * change shows as one `changed` row rather than exploding), then union the key sets:
 *   - key only in `after`  → `added`
 *   - key only in `before` → `removed`
 *   - key in both, values differ → `changed`
 *   - key in both, values equal  → `unchanged` (hidden by default)
 *
 * Everything here is pure + defensive (never throws) and produces PLAIN strings the
 * UI render-escapes (#9). No value is ever interpolated into HTML or a prompt.
 */
import type { FieldDiff, FieldDiffKind } from './types';

/** JSON-safe primitive test. */
function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== 'object';
}

/** Max characters shown per diff value token (display only, never the compare basis). */
const DISPLAY_CAP = 2000;

/**
 * Stringify a leaf value for COMPARISON. Primitives use their string form; arrays +
 * objects are JSON-stringified (stable-ish — object key order is the snapshot's own,
 * which is deterministic per Pydantic `model_dump`). NOT truncated: comparing truncated
 * values would classify two long fields that differ only past the cap as `unchanged`,
 * silently hiding a real change in a trust/audit surface (#46). Truncation is applied
 * ONLY when building the display value (`capForDisplay`).
 */
function stringifyLeaf(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (isPrimitive(v)) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Bound a compared value for DISPLAY so an attacker-influenceable field can't bloat a
 * diff row. Applied after the (untruncated) equality decision. */
function capForDisplay(s: string): string {
  return s.length > DISPLAY_CAP ? `${s.slice(0, DISPLAY_CAP)}…` : s;
}

/**
 * Flatten an object into `dotted.path → stringified value`. Nested plain objects
 * recurse; arrays are treated as a single leaf (a whole-array change reads better as
 * one row than N index rows for a rule config). Depth-bounded to avoid pathological
 * nesting. `undefined`/functions are skipped.
 */
function flatten(
  obj: unknown,
  prefix = '',
  out: Record<string, string> = {},
  depth = 0,
): Record<string, string> {
  if (depth > 8 || obj === null || obj === undefined) {
    if (prefix) out[prefix] = stringifyLeaf(obj);
    return out;
  }
  if (Array.isArray(obj) || isPrimitive(obj)) {
    if (prefix) out[prefix] = stringifyLeaf(obj);
    return out;
  }
  // A plain object — recurse into its keys.
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0 && prefix) {
    out[prefix] = '{}';
    return out;
  }
  for (const [k, v] of entries) {
    if (typeof v === 'function') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    flatten(v, path, out, depth + 1);
  }
  return out;
}

/**
 * Compute the field-level diff between a PRIOR (`before`) and a CURRENT (`after`)
 * rule config snapshot. By default only the CHANGED rows (added/removed/changed) are
 * returned, sorted by path; pass `includeUnchanged` to keep equal rows too.
 *
 * Pure + total: any input degrades to `{}` flattening (empty diff), never throws.
 */
export function diffConfigs(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  opts: { includeUnchanged?: boolean } = {},
): FieldDiff[] {
  const a = flatten(before ?? {});
  const b = flatten(after ?? {});
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();

  const rows: FieldDiff[] = [];
  for (const path of keys) {
    const inA = Object.prototype.hasOwnProperty.call(a, path);
    const inB = Object.prototype.hasOwnProperty.call(b, path);
    let kind: FieldDiffKind;
    if (inA && !inB) kind = 'removed';
    else if (!inA && inB) kind = 'added';
    else if (a[path] !== b[path]) kind = 'changed';
    else kind = 'unchanged';

    if (kind === 'unchanged' && !opts.includeUnchanged) continue;
    rows.push({
      path,
      kind,
      // Compare on the full value (above); truncate only for the rendered token.
      before: inA ? capForDisplay(a[path]) : undefined,
      after: inB ? capForDisplay(b[path]) : undefined,
    });
  }
  return rows;
}

/** True when two configs differ in at least one field (any add/remove/change). */
export function hasChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): boolean {
  return diffConfigs(before, after).length > 0;
}
