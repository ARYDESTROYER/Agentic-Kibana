/**
 * DonutChart center-overlay bounding (bug #1).
 *
 * The center overlay must be sized to the ACTUAL circular donut hole, NOT the whole
 * chart box. The hole diameter is `innerPct% * min(width, height)`; these charts are
 * height-constrained, so the overlay is a px SQUARE of `innerPct% * height` (`holePx`),
 * pinned to the height rather than the container WIDTH — a plain `width: innerPct%` was
 * far wider than the hole in a wide/stacked layout, so a long caption bled onto the ring.
 * Oversized content is clipped (`overflow-hidden`). jsdom has no layout engine, so these
 * assert via inline `style` / `className` (house style), never pixel bounds. The default
 * `height` is 200, so `holePx = round(innerPct/100 * 200)`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DonutChart } from '../charts';

describe('DonutChart — center overlay is bounded to the hole (bug #1)', () => {
  it('sizes the center wrapper to the px hole, not the full box, and clips overflow', () => {
    render(
      <DonutChart
        segments={[{ label: 'a', value: 1 }]}
        thickness={0.44}
        center={<span>X</span>}
      />,
    );
    // The center content's wrapper is its parent div.
    const wrapper = screen.getByText('X').parentElement as HTMLElement;
    // innerPct = round((1 - 0.44) * 70) = 39; holePx = round(39/100 * 200) = 78 → a px
    // SQUARE pinned to the hole, NOT a %-of-container width that bleeds onto the ring.
    expect(wrapper.style.width).toBe('78px');
    expect(wrapper.style.height).toBe('78px');
    expect(wrapper.style.width).not.toBe('100%');
    // width === height → the overlay is square (matches the circular hole).
    expect(wrapper.style.width).toBe(wrapper.style.height);
    // Oversized future content clips instead of painting over the ring; the box also
    // never exceeds the container (max-w/h-full guards a portrait container).
    expect(wrapper.className).toContain('overflow-hidden');
    expect(wrapper.className).toContain('max-w-full');
    expect(wrapper.className).toContain('max-h-full');
  });

  it('reuses innerPct from the default thickness (0.38 → 43% → 86px hole at height 200)', () => {
    render(
      <DonutChart segments={[{ label: 'a', value: 1 }]} center={<span>Y</span>} />,
    );
    const wrapper = screen.getByText('Y').parentElement as HTMLElement;
    // round((1 - 0.38) * 70) = 43; holePx = round(43/100 * 200) = 86 — derived from the
    // SAME innerPct source of truth the Pie uses for `innerRadius`.
    expect(wrapper.style.width).toBe('86px');
    expect(wrapper.style.height).toBe('86px');
  });

  it('still centers short content that fits comfortably', () => {
    render(<DonutChart segments={[{ label: 'a', value: 5 }]} center={<span>5</span>} />);
    // The chart container is still an accessible role="img"; the center renders in it.
    const chart = screen.getByRole('img');
    expect(chart).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('empty state is unaffected (early-return branch, no center overlay)', () => {
    render(<DonutChart segments={[]} center={<span>Z</span>} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
    // The early-return branch renders before the center overlay code path.
    expect(screen.queryByText('Z')).toBeNull();
  });
});
