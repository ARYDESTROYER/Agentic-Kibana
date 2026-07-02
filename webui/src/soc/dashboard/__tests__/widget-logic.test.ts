/**
 * Round-6 dashboard-core widget-logic regression tests (pure).
 *
 * The "Autonomous vs human" donut previously (a) double-counted the human arc by
 * summing OVERLAPPING escalated + needs_human tallies (which also include OPEN cases),
 * and (b) painted both arcs the same color (semanticColor() can't resolve the token
 * names 'success'/'warning'). `autonomySegments` fixes both: mutually-exclusive counts
 * off `terminal_cases`, distinct token colors.
 */
import { describe, it, expect } from 'vitest';
import { autonomySegments } from '@/soc/dashboard/widgets/mix';
import { token } from '@/soc/components/palette';

describe('autonomySegments — the auto-resolved vs human-handled split', () => {
  it('splits terminal cases into MUTUALLY EXCLUSIVE auto + human (no double-count)', () => {
    // Old bug: human = escalated(5) + needs_human(4) = 9, total = 7 + 9 = 16.
    // Fixed: human = terminal(10) − auto(7) = 3, total = 10 (the true resolved count).
    const out = autonomySegments({
      terminal_cases: 10,
      auto_closed_cases: 7,
    });
    const byLabel = Object.fromEntries(out.map((s) => [s.label, s.value]));
    expect(byLabel['Auto-resolved']).toBe(7);
    expect(byLabel['Human-handled']).toBe(3);
    // Center total == resolved (terminal), never the inflated 16.
    expect(out.reduce((a, s) => a + s.value, 0)).toBe(10);
  });

  it('paints the two arcs DISTINCT token colors', () => {
    const out = autonomySegments({ terminal_cases: 10, auto_closed_cases: 4 });
    expect(out[0].color).toBe(token('success'));
    expect(out[1].color).toBe(token('warning'));
    expect(out[0].color).not.toBe(out[1].color);
  });

  it('clamps auto to terminal (never a negative human arc)', () => {
    const out = autonomySegments({ terminal_cases: 5, auto_closed_cases: 8 });
    // auto clamps to 5; human = 0 → a single arc, no negative slice.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: 'Auto-resolved', value: 5 });
  });

  it('returns no segments when there is no quality data', () => {
    expect(autonomySegments(null)).toEqual([]);
    expect(autonomySegments(undefined)).toEqual([]);
    expect(autonomySegments({})).toEqual([]);
  });
});
