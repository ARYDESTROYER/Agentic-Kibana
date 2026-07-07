/**
 * DonutChart center-overlay bounding (bug #1).
 *
 * The center overlay must be sized to the ACTUAL donut hole (the same `innerPct`
 * formula the Pie uses for `innerRadius`), NOT the whole chart box (`absolute
 * inset-0` / 100%). Oversized center content is therefore clipped (`overflow-hidden`)
 * to the hole instead of bleeding onto the coloured ring. jsdom has no layout engine,
 * so these assert via inline `style` / `className` (house style), never pixel bounds.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DonutChart } from '../charts';

describe('DonutChart — center overlay is bounded to the hole (bug #1)', () => {
  it('sizes the center wrapper to innerPct%, not the full box, and clips overflow', () => {
    render(
      <DonutChart
        segments={[{ label: 'a', value: 1 }]}
        thickness={0.44}
        center={<span>X</span>}
      />,
    );
    // The center content's wrapper is its parent div.
    const wrapper = screen.getByText('X').parentElement as HTMLElement;
    // innerPct = round((1 - 0.44) * 70) = 39 → the wrapper hugs the hole, NOT 100%.
    expect(wrapper.style.width).toBe('39%');
    expect(wrapper.style.height).toBe('39%');
    expect(wrapper.style.width).not.toBe('100%');
    // Oversized future content clips instead of painting over the ring.
    expect(wrapper.className).toContain('overflow-hidden');
    expect(wrapper.className).toContain('max-w-full');
  });

  it('reuses innerPct from the default thickness (0.38 → 43%)', () => {
    render(
      <DonutChart segments={[{ label: 'a', value: 1 }]} center={<span>Y</span>} />,
    );
    const wrapper = screen.getByText('Y').parentElement as HTMLElement;
    // round((1 - 0.38) * 70) = 43 — the SAME source of truth as the Pie innerRadius.
    expect(wrapper.style.width).toBe('43%');
    expect(wrapper.style.height).toBe('43%');
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
