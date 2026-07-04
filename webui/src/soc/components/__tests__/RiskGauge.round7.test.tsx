/**
 * RiskGauge — Round-7 W0.1 additive props (`animateValue` mount draw-in + optional
 * threshold `notch`). The BUG-1 ring geometry is guarded by RiskGauge.test.tsx (which
 * stays green — these props are opt-in and default off).
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RiskGauge } from '../RiskGauge';

/** The component's arc geometry for a given size (mirrors RiskGauge.tsx). */
function geom(size: number) {
  const w = size;
  const stroke = Math.max(8, Math.round(size * 0.07));
  const pad = Math.max(2, Math.round(stroke / 2));
  const cx = w / 2;
  const r = w / 2 - stroke / 2 - pad;
  const cy = stroke / 2 + pad + r;
  const len = Math.PI * r;
  return { cx, cy, r, stroke, len };
}

/**
 * Expected notch endpoints for a 0-100 value, mirroring RiskGauge.tsx: the semicircle
 * sweeps left baseline (value 0, θ=π) → top → right baseline (value 100, θ=0), so a
 * value maps to θ = π·(1 − v/100); the tick spans the stroke thickness radially.
 */
function expectedNotch(size: number, value: number) {
  const { cx, cy, r, stroke } = geom(size);
  const f = Math.max(0, Math.min(100, value)) / 100;
  const theta = Math.PI * (1 - f);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const inner = r - stroke / 2;
  const outer = r + stroke / 2;
  return {
    x1: cx + inner * cos,
    y1: cy - inner * sin,
    x2: cx + outer * cos,
    y2: cy - outer * sin,
  };
}

/** The progress arc = the path carrying a stroke-dasharray. */
function progressPath(container: HTMLElement) {
  return Array.from(container.querySelectorAll('path')).find(
    (p) => p.getAttribute('stroke-dasharray') != null,
  ) as SVGPathElement | undefined;
}

describe('RiskGauge round-7 props', () => {
  it('default (no animateValue): the arc is filled to the score immediately (byte-identical)', () => {
    const { container } = render(<RiskGauge score={50} size={160} />);
    const { len } = geom(160);
    const expected = (1 - 50 / 100) * len;
    const p = progressPath(container);
    expect(p).toBeTruthy();
    expect(Number(p!.getAttribute('stroke-dashoffset'))).toBeCloseTo(expected, 2);
  });

  it('animateValue starts the arc EMPTY (draws in from 0 via the CSS transition)', () => {
    const { container } = render(<RiskGauge score={50} size={160} animateValue />);
    const { len } = geom(160);
    const p = progressPath(container);
    // Before the rAF flips `drawn`, the offset is the full length = empty arc.
    expect(Number(p!.getAttribute('stroke-dashoffset'))).toBeCloseTo(len, 2);
  });

  it('draws a single <line> notch WITHOUT altering the 2-path arc geometry', () => {
    const { container } = render(<RiskGauge score={30} size={160} notch={74} />);
    expect(container.querySelectorAll('path').length).toBe(2);
    expect(container.querySelectorAll('line').length).toBe(1);
    const line = container.querySelector('line')!;
    expect(line.getAttribute('aria-hidden')).toBe('true');
    // Every coordinate is finite (no NaN from the angle math).
    for (const attr of ['x1', 'y1', 'x2', 'y2']) {
      expect(Number.isFinite(Number(line.getAttribute(attr)))).toBe(true);
    }
  });

  it('renders no notch line when `notch` is not provided', () => {
    const { container } = render(<RiskGauge score={30} size={160} />);
    expect(container.querySelectorAll('line').length).toBe(0);
    expect(container.querySelectorAll('path').length).toBe(2);
  });

  it('positions the notch=74 tick on the SAME arc geometry the gauge uses', () => {
    // The Active-Risk-Index passes notch={74} (the `critical` band cut); the tick must
    // land on the muted track at θ = π·(1 − 0.74), spanning the stroke radially.
    const { container } = render(<RiskGauge score={30} size={160} notch={74} />);
    const line = container.querySelector('line')!;
    const exp = expectedNotch(160, 74);
    for (const attr of ['x1', 'y1', 'x2', 'y2'] as const) {
      expect(Number(line.getAttribute(attr))).toBeCloseTo(exp[attr], 2);
    }
    // 74 is past the top (>50), so the tick sits on the RIGHT half (x > centre 80).
    expect(Number(line.getAttribute('x1'))).toBeGreaterThan(160 / 2);
    // The tick is decorative — no aria role, aria-hidden.
    expect(line.getAttribute('aria-hidden')).toBe('true');
  });

  it('notch position tracks the value (0 → left baseline, 100 → right baseline)', () => {
    const left = render(<RiskGauge score={30} size={160} notch={0} />).container.querySelector(
      'line',
    )!;
    const right = render(<RiskGauge score={30} size={160} notch={100} />).container.querySelector(
      'line',
    )!;
    const cx = 160 / 2;
    // 0 → left of centre, 100 → right of centre, and they mirror across the centre.
    expect(Number(left.getAttribute('x1'))).toBeLessThan(cx);
    expect(Number(right.getAttribute('x1'))).toBeGreaterThan(cx);
    expect(Number(left.getAttribute('x1')) - cx).toBeCloseTo(cx - Number(right.getAttribute('x1')), 2);
  });

  it('adding a notch does NOT perturb the 0/100 edge arc geometry (Active-Risk-Index glitch lock)', () => {
    const { len } = geom(160);
    // score=0 → empty arc (offset == len); score=100 → full arc (offset == 0), WITH a notch.
    const empty = progressPath(render(<RiskGauge score={0} size={160} notch={74} />).container)!;
    expect(Number(empty.getAttribute('stroke-dashoffset'))).toBeCloseTo(len, 4);
    expect(Number(empty.getAttribute('stroke-dasharray'))).toBeCloseTo(len, 4);

    const full = progressPath(render(<RiskGauge score={100} size={160} notch={74} />).container)!;
    expect(Number(full.getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 4);
    expect(Number(full.getAttribute('stroke-dasharray'))).toBeCloseTo(len, 4);

    // The notch is a <line>, so the arc is still exactly 2 <path>s at both extremes.
    expect(render(<RiskGauge score={0} size={160} notch={74} />).container.querySelectorAll('path').length).toBe(2);
    expect(render(<RiskGauge score={100} size={160} notch={74} />).container.querySelectorAll('path').length).toBe(2);
  });
});
