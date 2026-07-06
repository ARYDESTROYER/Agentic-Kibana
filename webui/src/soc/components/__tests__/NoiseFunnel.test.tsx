/**
 * NoiseFunnel — Round-8 coverage (redesigned from the SVG Sankey ribbon into horizontal
 * aligned stage bars, the industry-standard linear reduction funnel).
 *
 * Binds to the §D `GET /api/metrics/noise-reduction` contract: renders the big
 * "Noise reduced by X%" hero, the monotonic reduction spine (Ingested → Clustered →
 * Cases opened) as descending bars, and the four MECE case outcomes as a part-to-whole
 * disposition row. Keeps the outcomes MECE (they sum to `cases.total`), fires
 * `onStageClick` with the stage key, and degrades to a case-only funnel when the durable
 * counters are still warming up. All meaning lives on the focusable stage/outcome rail;
 * there is NO decorative SVG flow any more.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { NoiseFunnel, deriveFunnel } from '../NoiseFunnel';
import type { NoiseReduction } from '@/lib/types';

/** A well-formed §D payload: cases.total (40) = auto(25)+esc(8)+nh(5)+tp(2). */
function fixture(overrides: Partial<NoiseReduction> = {}): NoiseReduction {
  return {
    window_hours: 24,
    generated_at: '2026-07-05T00:00:00Z',
    bands: ['critical', 'high', 'medium', 'low', 'info'],
    stages: [
      {
        key: 'ingested',
        label: 'Ingested',
        source: 'counters',
        deterministic: true,
        total: 1000,
        by_severity: { critical: 50, high: 150, medium: 300, low: 400, info: 100 },
      },
      {
        key: 'clustered',
        label: 'Clustered',
        source: 'counters',
        deterministic: true,
        total: 220,
        by_severity: { critical: 40, high: 60, medium: 70, low: 40, info: 10 },
      },
      {
        key: 'cases',
        label: 'Cases opened',
        source: 'cases',
        deterministic: false,
        total: 40,
        by_severity: { critical: 8, high: 12, medium: 12, low: 6, info: 2 },
      },
      {
        key: 'auto_cleared',
        label: 'Auto-cleared',
        source: 'cases',
        deterministic: true,
        total: 25,
        by_severity: { medium: 10, low: 10, info: 5 },
      },
      {
        key: 'escalated',
        label: 'Escalated',
        source: 'cases',
        deterministic: true,
        total: 8,
        by_severity: { critical: 5, high: 3 },
      },
      {
        key: 'needs_human',
        label: 'Needs human',
        source: 'cases',
        deterministic: true,
        total: 5,
        by_severity: { high: 3, medium: 2 },
      },
    ],
    drops: { suppressed: 12, ignored: 4 },
    reduction: { overall_pct: 96, human_reduction_pct: 87 },
    counters: { available: true, since: '2026-07-01T00:00:00Z', incomplete: false },
    cases_meta: { truncated: false, store_total: 40, fetched: 40 },
    ...overrides,
  };
}

describe('NoiseFunnel', () => {
  it('renders the hero, every stage bar + the disposition (no SVG ribbon)', () => {
    const { container } = render(<NoiseFunnel data={fixture()} animate={false} />);

    // The region + the big value-prop hero.
    expect(screen.getByTestId('noise-funnel')).toBeInTheDocument();
    expect(screen.getByText(/noise reduced by/i)).toBeInTheDocument();
    expect(screen.getByText('96%')).toBeInTheDocument();
    // The ingested→human cascade sub-line.
    expect(screen.getByText(/routed to a human/i)).toBeInTheDocument();

    // All six pipeline stages + the derived true-positive residual render on the rail
    // (spine: Ingested/Clustered/Cases opened; disposition: the four outcomes).
    for (const label of [
      'Ingested',
      'Clustered',
      'Cases opened',
      'Auto-cleared',
      'Escalated',
      'Needs human',
      'True positive',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // The part-to-whole disposition band is present.
    expect(screen.getByText(/case disposition/i)).toBeInTheDocument();

    // The drops footnote sums suppressed + ignored.
    expect(screen.getByText(/12 suppressed · 4 ignored/i)).toBeInTheDocument();

    // The Round-8 redesign RETIRED the 640×220 Sankey ribbon — no such SVG remains.
    expect(container.querySelector('svg[viewBox="0 0 640 220"]')).toBeNull();
  });

  it('keeps the case outcomes MECE — they sum to cases.total', () => {
    const data = fixture();
    const derived = deriveFunnel(data);

    const casesTotal = data.stages.find((s) => s.key === 'cases')!.total;
    const outcomes = derived.rows.filter((r) => r.isOutcome);

    // Exactly the four outcomes, summing to cases.total.
    expect(outcomes.map((r) => r.key).sort()).toEqual(
      ['auto_cleared', 'escalated', 'needs_human', 'true_positive'].sort(),
    );
    const sum = outcomes.reduce((a, r) => a + r.total, 0);
    expect(sum).toBe(casesTotal);
    expect(derived.outcomeSum).toBe(casesTotal);
    // The residual was derived correctly (40 − 25 − 8 − 5 = 2).
    expect(derived.rows.find((r) => r.key === 'true_positive')!.total).toBe(2);
  });

  it('fires onStageClick with the stage key', () => {
    const onStageClick = vi.fn();
    render(<NoiseFunnel data={fixture()} animate={false} onStageClick={onStageClick} />);

    // Each stage is an accessible button; clicking "Escalated" reports its key.
    fireEvent.click(screen.getByRole('button', { name: /^Escalated:/i }));
    expect(onStageClick).toHaveBeenCalledTimes(1);
    expect(onStageClick).toHaveBeenCalledWith('escalated');

    // The `cases` spine stage is likewise clickable and reports its key.
    fireEvent.click(screen.getByRole('button', { name: /^Cases opened:/i }));
    expect(onStageClick).toHaveBeenLastCalledWith('cases');
  });

  it('degrades to a case-only funnel when counters.available === false', () => {
    const data = fixture({
      counters: { available: false, since: null, incomplete: true },
      reduction: { overall_pct: '—', human_reduction_pct: '—' },
    });
    render(<NoiseFunnel data={data} animate={false} />);

    // The counter-sourced stages are dropped; the case-based funnel remains.
    expect(screen.queryByText('Ingested')).toBeNull();
    expect(screen.queryByText('Clustered')).toBeNull();
    expect(screen.getByText('Cases opened')).toBeInTheDocument();
    expect(screen.getByText('Auto-cleared')).toBeInTheDocument();

    // The honest "warming up" note replaces the reduced-by hero.
    const warming = screen.getByTestId('noise-funnel-warming');
    expect(warming.textContent?.toLowerCase()).toContain('counters warming up');
    expect(screen.queryByText(/noise reduced by/i)).toBeNull();

    // deriveFunnel agrees it is case-mode with cases as the funnel top.
    const derived = deriveFunnel(data);
    expect(derived.mode).toBe('cases');
    expect(derived.topTotal).toBe(40);
  });

  it('renders the loading skeleton and nothing when data is absent', () => {
    const { rerender, container } = render(<NoiseFunnel data={null} loading />);
    expect(screen.getByTestId('noise-funnel-loading')).toBeInTheDocument();

    rerender(<NoiseFunnel data={null} loading={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('collapses the body when hidden, keeping the header + toggle', () => {
    const onToggleHidden = vi.fn();
    render(<NoiseFunnel data={fixture()} animate={false} hidden onToggleHidden={onToggleHidden} />);

    // Header persists; the stage rows are gone.
    expect(screen.getByText('Noise reduction')).toBeInTheDocument();
    expect(screen.queryByText('Cases opened')).toBeNull();

    // The show/hide control toggles.
    const toggle = screen.getByRole('button', { name: /show noise funnel/i });
    fireEvent.click(toggle);
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
  });

  it('gives non-clickable stages an accessible group label (no onStageClick)', () => {
    render(<NoiseFunnel data={fixture()} animate={false} ariaLabel="Alert noise funnel" />);
    // No stage buttons when the handler is absent.
    expect(screen.queryByRole('button', { name: /^Escalated:/i })).toBeNull();
    // The root is a figure carrying the caller's aria-label; the stages are labelled groups.
    const region = screen.getByRole('figure', { name: 'Alert noise funnel' });
    expect(within(region).getByText('Escalated')).toBeInTheDocument();
    expect(within(region).getByRole('group', { name: /^Escalated:/i })).toBeInTheDocument();
  });
});
