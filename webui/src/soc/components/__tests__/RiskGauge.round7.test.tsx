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
  const r = w / 2 - stroke / 2 - pad;
  const len = Math.PI * r;
  return { r, len };
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
});
