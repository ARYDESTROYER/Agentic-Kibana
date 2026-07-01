/**
 * Round-5 W0-A — the ONE label→token authority (palette.ts) + the runtime AA
 * accent guard (theme-tokens.ts). Asserts:
 *   - the 3 orthogonal semantic axes map to the documented tokens (incl. the two
 *     drift fixes: escalated→high, FP→info neutral, NOT green);
 *   - the ONE 0-100 threshold ladder (Elastic bands) + its band ranges;
 *   - the CVD-safe categorical ramp resolves off `--chart-*` (7 + grey "Other");
 *   - the viridis sequential() endpoints;
 *   - guardAccentTriplet passes an AA accent unchanged, darkens a failing one, and
 *     rejects an unsalvageable one.
 */
import { describe, it, expect } from 'vitest';
import {
  SEVERITY_COLOR,
  STATUS_COLOR,
  VERDICT_COLOR,
  SEMANTIC_ICON,
  semanticColor,
  semanticIcon,
  scoreBand,
  SCORE_BANDS,
  categorical,
  categoricalCapped,
  CATEGORICAL_CAP,
  sequential,
  token,
} from '../palette';
import { guardAccentTriplet } from '../../theme-tokens';

describe('the 3 orthogonal semantic axes', () => {
  it('SEVERITY has no green — --low is blue, --info neutral', () => {
    expect(SEVERITY_COLOR.low).toBe('low'); // token --low is BLUE in theme.css
    expect(SEVERITY_COLOR.info).toBe('info');
    // no severity key resolves to `success` (the green token lives on STATUS only)
    expect(Object.values(SEVERITY_COLOR)).not.toContain('success');
  });

  it('VERDICT FP/benign are neutral blue-grey (info), NOT green', () => {
    expect(VERDICT_COLOR.false_positive).toBe('info');
    expect(VERDICT_COLOR.benign).toBe('info');
    expect(VERDICT_COLOR.true_positive).toBe('critical');
  });

  it('STATUS escalated standardises on high (drift fix), resolved/closed green', () => {
    expect(STATUS_COLOR.escalated).toBe('high');
    expect(STATUS_COLOR.resolved).toBe('success');
    expect(STATUS_COLOR.closed).toBe('success');
    expect(STATUS_COLOR.investigating).toBe('primary');
  });

  it('semanticColor routes through the axes → hsl(var(--token)) strings', () => {
    expect(semanticColor('escalated')).toBe(token('high'));
    expect(semanticColor('false_positive')).toBe(token('info'));
    expect(semanticColor('True Positive')).toBe(token('critical')); // case/space-insensitive
    // unknown label → a stable categorical color (never throws)
    expect(semanticColor('totally-unknown', 2)).toBe(categorical(2));
  });

  it('SEMANTIC_ICON gives a beside-color glyph for every axis label (1.4.1)', () => {
    for (const k of [
      ...Object.keys(SEVERITY_COLOR),
      ...Object.keys(STATUS_COLOR),
      ...Object.keys(VERDICT_COLOR),
    ]) {
      expect(SEMANTIC_ICON[k]).toBeTruthy();
    }
    expect(semanticIcon('true positive')).toBe(SEMANTIC_ICON.true_positive);
    expect(semanticIcon(null)).toBeUndefined();
  });
});

describe('the ONE 0-100 threshold ladder (Elastic bands)', () => {
  it('maps scores to bands at 22/48/74', () => {
    expect(scoreBand(0)).toBe('low');
    expect(scoreBand(21)).toBe('low');
    expect(scoreBand(22)).toBe('medium');
    expect(scoreBand(47)).toBe('medium');
    expect(scoreBand(48)).toBe('high');
    expect(scoreBand(73)).toBe('high');
    expect(scoreBand(74)).toBe('critical');
    expect(scoreBand(100)).toBe('critical');
  });
  it('exposes the inclusive band ranges', () => {
    expect(SCORE_BANDS.low).toEqual([0, 21]);
    expect(SCORE_BANDS.medium).toEqual([22, 47]);
    expect(SCORE_BANDS.high).toEqual([48, 73]);
    expect(SCORE_BANDS.critical).toEqual([74, 100]);
  });
});

describe('categorical chart ramp (CVD-safe, off --chart-*)', () => {
  it('resolves to --chart-n tokens and wraps', () => {
    expect(categorical(0)).toBe(token('chart-1'));
    expect(categorical(7)).toBe(token('chart-8'));
    expect(categorical(8)).toBe(token('chart-1')); // wraps
  });
  it('caps arbitrary series at 7 + grey "Other"', () => {
    const total = 10;
    expect(categoricalCapped(0, total)).toBe(token('chart-1'));
    expect(categoricalCapped(CATEGORICAL_CAP - 1, total)).toBe(token('chart-7'));
    expect(categoricalCapped(CATEGORICAL_CAP, total)).toBe(token('chart-8')); // grey Other
    expect(categoricalCapped(9, total)).toBe(token('chart-8'));
    // a short series is NOT folded
    expect(categoricalCapped(7, 8)).toBe(categorical(7));
  });
});

describe('viridis sequential()', () => {
  it('returns rgb() strings; endpoints are the viridis extremes', () => {
    expect(sequential(0)).toBe('rgb(68, 1, 84)'); // #440154
    expect(sequential(1)).toBe('rgb(253, 231, 37)'); // #fde725
    expect(sequential(0.5)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    // clamps out-of-range
    expect(sequential(-1)).toBe(sequential(0));
    expect(sequential(2)).toBe(sequential(1));
  });
});

describe('guardAccentTriplet — runtime AA guard (A7)', () => {
  it('passes an AA accent unchanged (white-on-fill ≥ 4.5:1)', () => {
    // 216 84% 52% (=#1f6feb) clears 4.5:1 with white text → returned verbatim.
    expect(guardAccentTriplet('216 84% 52%')).toBe('216 84% 52%');
  });
  it('darkens a failing accent until white text clears AA', () => {
    // A light teal fails AA; the guard darkens (lowers L) but keeps the hue.
    const guarded = guardAccentTriplet('174 84% 40%');
    expect(guarded).not.toBeNull();
    expect(guarded).not.toBe('174 84% 40%');
    const m = /^(\d+) (\d+)% (\d+)%$/.exec(guarded!);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(174); // hue preserved
    expect(Number(m![3])).toBeLessThan(40); // darkened
  });
  it('returns null for an unparseable triplet', () => {
    expect(guardAccentTriplet('not a triplet')).toBeNull();
    expect(guardAccentTriplet(null)).toBeNull();
  });
});
