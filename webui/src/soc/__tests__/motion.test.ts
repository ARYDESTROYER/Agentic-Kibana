/**
 * motion.ts — Round-7 W0.1. The MOTION constants mirror the `--motion-*` CSS tokens,
 * and `chartAnimation(reduced)` returns recharts-shaped animation props that snap under
 * reduced motion (mount-only draw-in otherwise, never a replay-on-poll).
 */
import { describe, it, expect } from 'vitest';
import { MOTION, chartAnimation } from '../motion';

describe('MOTION constants', () => {
  it('mirror the --motion-* token tempo (ms) + easing curves', () => {
    expect(MOTION.fast).toBe(120);
    expect(MOTION.base).toBe(200);
    expect(MOTION.slow).toBe(280);
    expect(MOTION.countUp).toBeGreaterThan(0);
    expect(MOTION.easeStandard).toMatch(/cubic-bezier/);
    // The formalised "premium" curve = cubic-bezier(0.16,1,0.3,1).
    expect(MOTION.easePremium).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
  });
});

describe('chartAnimation(reduced)', () => {
  it('draws in (mount-only) when motion is allowed', () => {
    const a = chartAnimation(false);
    expect(a.isAnimationActive).toBe(true);
    expect(a.animationDuration).toBe(MOTION.base);
    expect(a.animationEasing).toBe('ease-out');
  });

  it('snaps (no animation) under reduced motion', () => {
    const a = chartAnimation(true);
    expect(a.isAnimationActive).toBe(false);
    expect(a.animationDuration).toBe(0);
    expect(a.animationEasing).toBe('linear');
  });
});
