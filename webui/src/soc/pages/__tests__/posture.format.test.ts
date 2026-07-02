/**
 * posture.format — deltaView interpretation (Round-6 sign-flip fix).
 *
 * The KpiTile redesign (bug #2) made the delta ARROW follow the SIGN of `value` and the
 * COLOR follow the separate `goodDirection` prop. deltaView must therefore return the
 * TRUE signed change (no pre-flip), so a rising metric yields a positive value + "+N%"
 * label and a falling metric a negative value + "-N%" label — the arrow can no longer
 * contradict its own label.
 */
import { describe, it, expect } from 'vitest';

import { deltaView } from '../posture.format';
import type { CompareBlock } from '../Metrics.posture.api';

const block = (delta_pct: CompareBlock['delta_pct']): CompareBlock => ({
  value: 1,
  prev: 1,
  delta_pct,
});

describe('deltaView', () => {
  it('returns the TRUE signed value for a rise (positive) — arrow matches label', () => {
    const dv = deltaView(block(20));
    expect(dv.value).toBe(20);
    expect(dv.label).toBe('+20%');
    expect(dv.show).toBe(true);
  });

  it('returns the TRUE signed value for a fall (negative) — arrow matches label', () => {
    const dv = deltaView(block(-10));
    expect(dv.value).toBe(-10);
    expect(dv.label).toBe('-10%');
    expect(dv.show).toBe(true);
  });

  it('does NOT flip the sign for lower-is-better metrics (goodDirection now owns color)', () => {
    // A falling FP-rate used to return value:+10 (flipped) with a "-10%" label; now the
    // value tracks the label sign so the arrow points down for a real drop.
    const dv = deltaView(block(-10));
    expect(Math.sign(dv.value ?? 0)).toBe(Math.sign(-10));
  });

  it('hides a zero delta', () => {
    expect(deltaView(block(0)).show).toBe(false);
  });

  it('marks a "new" (prior-zero) growth as shown but with NO numeric value (no arrow)', () => {
    const dv = deltaView(block(null));
    expect(dv.label).toBe('new');
    expect(dv.show).toBe(true);
    expect(dv.value).toBeUndefined();
  });

  it('draws no badge when there is no comparison', () => {
    expect(deltaView(undefined).show).toBe(false);
    expect(deltaView(block('—')).show).toBe(false);
  });
});
