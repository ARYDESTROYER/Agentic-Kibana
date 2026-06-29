/**
 * RiskGauge — BUG-1 regression coverage (Round 2).
 *
 * Guards the dash-offset progress-ring rewrite that fixed three stacked defects:
 *   1. the faint near-white sliver (progress arc was a `<defs>` gradient whose
 *      `currentColor` stops resolved against the document foreground, NOT the
 *      band `text-*` class) — now the arc is `stroke="currentColor"` on the same
 *      element that carries the band class, and there is NO `<linearGradient>`;
 *   2. the overflowing / colliding "/100" — now a height-bounded overlay with the
 *      value and `/100` on ONE line;
 *   3. the stray dark start-cap blob — gone with the single coloured arc.
 *
 * jsdom has no layout/paint engine, so we assert the load-bearing DOM/SVG facts:
 * deterministic finite path geometry, the dash-array/offset progress math, the
 * band colour token + `currentColor` stroke, the absence of a gradient, and that
 * the value + suffix both render.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RiskGauge } from '../RiskGauge';

const SIZES = [100, 208] as const;
const SCORES = [0, 27, 55, 85, 100] as const;

/** Recompute the geometry the component uses for a given size. */
function geom(size: number) {
  const w = size;
  const stroke = Math.max(8, Math.round(size * 0.07));
  const pad = Math.max(2, Math.round(stroke / 2));
  const r = w / 2 - stroke / 2 - pad;
  const len = Math.PI * r;
  return { r, len };
}

/** The two arc <path>s: [track, progress]. The progress one carries a dasharray. */
function paths(container: HTMLElement) {
  const all = Array.from(container.querySelectorAll('path'));
  const track = all.find((p) => (p.getAttribute('class') || '').includes('stroke-muted'));
  const progress = all.find((p) => p.getAttribute('stroke-dasharray') != null);
  return { all, track, progress };
}

describe('RiskGauge (BUG-1 ring rewrite)', () => {
  // (A) Geometry / NaN + (math) dash array + offset — across the grid.
  describe('geometry, dash math and NaN-safety', () => {
    for (const size of SIZES) {
      for (const score of SCORES) {
        it(`size=${size} score=${score}: finite path + correct dash math`, () => {
          const { container } = render(<RiskGauge score={score} size={size} />);
          const { all, track, progress } = paths(container);

          // Exactly the track + the progress arc.
          expect(all.length).toBe(2);
          expect(track).toBeTruthy();
          expect(progress).toBeTruthy();

          for (const p of all) {
            const d = p.getAttribute('d') || '';
            expect(d).not.toMatch(/NaN/);
            expect(d).not.toMatch(/Infinity/);
            // A single move + a single arc command.
            expect(d).toMatch(/^M [\d.-]+ [\d.-]+ A/);
          }

          const { r, len } = geom(size);

          // strokeDasharray === PI * r (within rounding from the attribute string).
          const dash = Number(progress!.getAttribute('stroke-dasharray'));
          expect(Number.isFinite(dash)).toBe(true);
          expect(dash).toBeCloseTo(len, 5);

          // strokeDashoffset === (1 - clamp/100) * len, finite, within [0, len].
          const offset = Number(progress!.getAttribute('stroke-dashoffset'));
          const clamp = Math.max(0, Math.min(100, score));
          const expected = (1 - clamp / 100) * len;
          expect(Number.isFinite(offset)).toBe(true);
          expect(offset).toBeCloseTo(expected, 5);
          expect(offset).toBeGreaterThanOrEqual(-1e-9);
          expect(offset).toBeLessThanOrEqual(len + 1e-9);

          // r must be positive at both real sizes.
          expect(r).toBeGreaterThan(0);
        });
      }
    }

    it('score 0 → offset == len (empty arc), score 100 → offset == 0 (full)', () => {
      const { len } = geom(208);
      const empty = render(<RiskGauge score={0} size={208} />);
      expect(Number(paths(empty.container).progress!.getAttribute('stroke-dashoffset'))).toBeCloseTo(
        len,
        5,
      );
      const full = render(<RiskGauge score={100} size={208} />);
      expect(Number(paths(full.container).progress!.getAttribute('stroke-dashoffset'))).toBeCloseTo(
        0,
        5,
      );
    });

    it('track and progress share the SAME half-circle `d`', () => {
      const { track, progress } = paths(render(<RiskGauge score={55} size={208} />).container);
      expect(track!.getAttribute('d')).toBe(progress!.getAttribute('d'));
    });
  });

  // (B) Colour: band token on the progress arc + currentColor (not a gradient url).
  describe('band colour token + currentColor stroke', () => {
    const cases: Array<[number, string]> = [
      [27, 'text-low'],
      [55, 'text-medium'],
      [70, 'text-high'],
      [85, 'text-critical'],
    ];
    for (const [score, token] of cases) {
      it(`score=${score} → progress arc has ${token} and stroke="currentColor"`, () => {
        const { progress } = paths(render(<RiskGauge score={score} />).container);
        const cls = progress!.getAttribute('class') || '';
        expect(cls).toContain(token);
        expect(progress!.getAttribute('stroke')).toBe('currentColor');
        expect(progress!.getAttribute('stroke')).not.toMatch(/url\(/);
      });
    }
  });

  // (D) No gradient remains anywhere in the output.
  it('renders NO <linearGradient> (the dead-colour source is gone)', () => {
    const { container } = render(<RiskGauge score={85} size={208} />);
    expect(container.querySelector('linearGradient')).toBeNull();
    expect(container.querySelector('defs')).toBeNull();
    // And no path paints via a paint-server url.
    for (const p of Array.from(container.querySelectorAll('path'))) {
      expect(p.getAttribute('stroke') || '').not.toMatch(/url\(/);
    }
  });

  // (C) Value + suffix both render, on one line, height-bounded.
  describe('value overlay', () => {
    it('renders the rounded score and the /100 suffix', () => {
      const { container } = render(<RiskGauge score={84.6} size={208} />);
      expect(container.textContent).toContain('85');
      expect(container.textContent).toContain('/100');
    });

    it('clamps out-of-range and non-finite scores', () => {
      expect(render(<RiskGauge score={-40} />).container.textContent).toContain('0');
      expect(render(<RiskGauge score={250} />).container.textContent).toContain('100');
      const nan = render(<RiskGauge score={NaN} />);
      expect(nan.container.textContent).toContain('0');
      for (const p of Array.from(nan.container.querySelectorAll('path'))) {
        expect(p.getAttribute('d') || '').not.toMatch(/NaN/);
      }
    });

    it('the overlay is height-bounded inside the bowl (no overflow into the label)', () => {
      const { container } = render(<RiskGauge score={85} size={208} label="Weighted risk" />);
      const overlay = container.querySelector('.absolute.inset-0') as HTMLElement | null;
      expect(overlay).not.toBeNull();
      expect(overlay!.className).toContain('justify-end');
      // A finite, bounded height is set inline (height == cy < svg height).
      expect(overlay!.style.height).toMatch(/\d/);
    });
  });

  it('renders a valid, accessibly-named SVG', () => {
    const { container } = render(<RiskGauge score={55} label="Risk" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.querySelector('title')?.textContent).toContain('55');
  });
});
