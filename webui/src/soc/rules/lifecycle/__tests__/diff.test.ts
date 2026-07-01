/**
 * Field-diff spec (Round-5 G6 · R5) — the dep-free `diffConfigs` that powers the
 * red/green version-ledger diff. Proves added / removed / changed / unchanged
 * classification, nested-path flattening, array-as-leaf, and total/defensive behavior
 * (never throws) — WITHOUT any diff library.
 */
import { describe, it, expect } from 'vitest';
import { diffConfigs, hasChanges } from '../diff';

describe('diffConfigs', () => {
  it('classifies changed / added / removed scalar fields', () => {
    const before = { name: 'ssh', enabled: true, priority: 100 };
    const after = { name: 'ssh', enabled: false, note: 'tuned' };
    const rows = diffConfigs(before, after);
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));

    // enabled changed true -> false
    expect(byPath.enabled.kind).toBe('changed');
    expect(byPath.enabled.before).toBe('true');
    expect(byPath.enabled.after).toBe('false');
    // priority removed
    expect(byPath.priority.kind).toBe('removed');
    expect(byPath.priority.before).toBe('100');
    expect(byPath.priority.after).toBeUndefined();
    // note added
    expect(byPath.note.kind).toBe('added');
    expect(byPath.note.after).toBe('tuned');
    // unchanged (name) is hidden by default
    expect(byPath.name).toBeUndefined();
  });

  it('includes unchanged rows only when asked', () => {
    const rows = diffConfigs({ a: 1 }, { a: 1 }, { includeUnchanged: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('unchanged');
    // and by default an identical config yields no rows
    expect(diffConfigs({ a: 1 }, { a: 1 })).toHaveLength(0);
  });

  it('flattens nested objects to dotted paths and treats arrays as one leaf', () => {
    const before = { correlation: { n: 5, window_seconds: 120 }, match: { field: 'ip', op: 'equals' }, tags: ['a'] };
    const after = { correlation: { n: 10, window_seconds: 120 }, match: { field: 'ip', op: 'equals' }, tags: ['a', 'b'] };
    const rows = diffConfigs(before, after);
    const paths = rows.map((r) => r.path);
    // the nested scalar change surfaces as a dotted path
    expect(paths).toContain('correlation.n');
    expect(rows.find((r) => r.path === 'correlation.n')!.kind).toBe('changed');
    // an array change is a SINGLE changed row (not per-index)
    const tagRow = rows.find((r) => r.path === 'tags')!;
    expect(tagRow.kind).toBe('changed');
    expect(tagRow.before).toBe('["a"]');
    expect(tagRow.after).toBe('["a","b"]');
    // an unchanged nested object contributes nothing
    expect(paths).not.toContain('match.field');
  });

  it('is total — null/undefined inputs never throw and yield an empty diff', () => {
    expect(diffConfigs(null, null)).toEqual([]);
    expect(diffConfigs(undefined, { a: 1 }).map((r) => r.kind)).toEqual(['added']);
    expect(hasChanges({ a: 1 }, { a: 2 })).toBe(true);
    expect(hasChanges({ a: 1 }, { a: 1 })).toBe(false);
  });
});
