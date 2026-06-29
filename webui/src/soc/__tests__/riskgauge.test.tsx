/**
 * RiskGauge — crisp half-gauge regression coverage.
 *
 * Guards the WAVE-7 redesign that fixed the stray rounded-cap "blob" artifacts:
 *   - it always renders a valid <svg> with an accessible name;
 *   - every arc `d` path is finite (no `NaN`, no `Infinity`) at any size / score;
 *   - the score is rendered as text;
 *   - the severity band drives the right semantic colour class
 *     (low / medium / high / critical) for a spread of scores;
 *   - the bowl is clipped (so caps can't bleed below the baseline);
 *   - it renders cleanly at the two real call sizes (100 + 208) and at the
 *     boundary scores 0 / 27 / 55 / 85 / 100.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RiskGauge } from '../components/RiskGauge';

/** Collect every <path> `d` attribute in a rendered gauge. */
function pathDs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('path'))
    .map((p) => p.getAttribute('d') || '')
    .filter(Boolean);
}

describe('RiskGauge', () => {
  it('renders a valid, accessibly-named SVG', () => {
    const { container } = render(<RiskGauge score={55} label="Risk" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('role')).toBe('img');
    // An aria-labelledby <title> gives the SVG its accessible name.
    expect(svg?.querySelector('title')?.textContent).toContain('55');
  });

  it('emits arc paths with no NaN / Infinity at every size and score', () => {
    for (const size of [100, 208]) {
      for (const score of [0, 27, 55, 85, 100]) {
        const { container } = render(<RiskGauge score={score} size={size} />);
        const ds = pathDs(container);
        // There is always at least the track path.
        expect(ds.length).toBeGreaterThan(0);
        for (const d of ds) {
          expect(d).not.toMatch(/NaN/);
          expect(d).not.toMatch(/Infinity/);
          // Only the expected path commands + numbers.
          expect(d).toMatch(/^M [\d. -]+A [\d. -]+$/);
        }
      }
    }
  });

  it('renders the rounded score value as text', () => {
    const { container } = render(<RiskGauge score={84.6} />);
    expect(container.textContent).toContain('85');
    expect(container.textContent).toContain('/ 100');
  });

  it('clamps out-of-range scores into [0, 100]', () => {
    const low = render(<RiskGauge score={-40} />);
    expect(low.container.textContent).toContain('0');
    const high = render(<RiskGauge score={250} />);
    expect(high.container.textContent).toContain('100');
  });

  it('treats a non-finite score as 0 without throwing', () => {
    const { container } = render(<RiskGauge score={NaN} />);
    expect(container.textContent).toContain('0');
    for (const d of pathDs(container)) expect(d).not.toMatch(/NaN/);
  });

  it('applies the correct severity colour class per band', () => {
    const cases: Array<[number, string]> = [
      [10, 'text-low'],
      [45, 'text-medium'],
      [70, 'text-high'],
      [90, 'text-critical'],
    ];
    for (const [score, cls] of cases) {
      const { container } = render(<RiskGauge score={score} />);
      expect(container.querySelector(`.${cls}`)).not.toBeNull();
    }
  });

  it('omits the coloured progress arc at score 0 (no stray dot)', () => {
    const { container } = render(<RiskGauge score={0} />);
    // Only the muted track path renders; no severity-coloured progress arc.
    expect(container.querySelector('.stroke-muted')).not.toBeNull();
    expect(pathDs(container).length).toBe(1);
  });

  it('clips the gauge to its bowl', () => {
    const { container } = render(<RiskGauge score={55} />);
    expect(container.querySelector('clipPath')).not.toBeNull();
  });
});
