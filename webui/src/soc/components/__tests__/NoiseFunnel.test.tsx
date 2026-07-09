/**
 * NoiseFunnel — the horizontal-flow ribbon rendering the linear noise-reduction flow
 * ingested → clustered → cases → auto_cleared → escalated → CLOSED (TASK N).
 *
 * Binds to the §D `GET /api/metrics/noise-reduction` contract: renders the flow from a
 * §D-shaped fixture (severity strands in → terminal-outcome fan out), surfaces the new
 * `closed` ("Closed by human") terminal stage, fires `onStageClick` with the stage key,
 * and degrades to a case-only funnel when the durable counters are still warming up. The
 * SVG flow is decorative (`aria-hidden`); all meaning lives on the focusable stage rail.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { NoiseFunnel, deriveFunnel, ribbonPath } from '../NoiseFunnel';
import type { NoiseReduction } from '@/lib/types';

/**
 * A well-formed §D payload. The three terminal outcomes partition cases.total (40):
 * auto_cleared(25) + escalated(8) + closed(7). `needs_human` remains in the payload for
 * back-compat but is no longer a rendered spine chip.
 */
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
      {
        key: 'closed',
        label: 'Closed by human',
        source: 'cases',
        deterministic: true,
        total: 7,
        by_severity: { high: 4, medium: 2, low: 1 },
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
  it('renders the linear flow ending in "Closed by human" (headline + every stage)', () => {
    const { container } = render(<NoiseFunnel data={fixture()} animate={false} />);

    // The region + headline value-prop.
    expect(screen.getByTestId('noise-funnel')).toBeInTheDocument();
    expect(screen.getByText(/noise reduced by/i)).toBeInTheDocument();
    expect(screen.getByText('96%')).toBeInTheDocument();

    // The six visible flow stages ingested → … → closed render on the rail.
    for (const label of [
      'Ingested',
      'Clustered',
      'Cases opened',
      'Auto-cleared',
      'Escalated',
      'Closed by human',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // The legacy tail keys are no longer separate spine chips.
    expect(screen.queryByText('Needs human')).toBeNull();
    expect(screen.queryByText('True positive')).toBeNull();

    // The drops footnote sums suppressed + ignored.
    expect(screen.getByText(/12 suppressed · 4 ignored/i)).toBeInTheDocument();

    // The flow band is a decorative (aria-hidden) SVG whose ribbons carry no meaning.
    const svg = container.querySelector('svg[viewBox="0 0 640 220"]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    // Severity strands + the 3-outcome fan → several ribbon <path>s render.
    expect(svg!.querySelectorAll('path').length).toBeGreaterThan(4);
    // Each ribbon is painted by a userSpace linear gradient (survival = end opacity).
    expect(svg!.querySelectorAll('defs linearGradient').length).toBeGreaterThan(0);
  });

  it('surfaces the terminal `closed` outcome and drops the legacy tail keys', () => {
    const data = fixture();
    const derived = deriveFunnel(data);

    // The three terminal outcomes fan out of `cases`: auto-cleared, escalated, closed.
    const outcomes = derived.rows.filter((r) => r.isOutcome);
    expect(outcomes.map((r) => r.key).sort()).toEqual(['auto_cleared', 'closed', 'escalated']);

    // The `closed` stage total is read from the backend payload.
    expect(derived.rows.find((r) => r.key === 'closed')!.total).toBe(7);
    // Its per-severity split is carried through for the hover breakdown.
    expect(derived.rows.find((r) => r.key === 'closed')!.by_severity.high).toBe(4);

    // outcomeSum = auto(25) + escalated(8) + closed(7).
    expect(derived.outcomeSum).toBe(40);

    // The legacy `needs_human` / `true_positive` keys are no longer rendered spine rows.
    expect(derived.rows.find((r) => r.key === 'needs_human')).toBeUndefined();
    expect(derived.rows.find((r) => r.key === 'true_positive')).toBeUndefined();
  });

  it('fires onStageClick with the stage key (incl. the new `closed` stage)', () => {
    const onStageClick = vi.fn();
    render(<NoiseFunnel data={fixture()} animate={false} onStageClick={onStageClick} />);

    fireEvent.click(screen.getByRole('button', { name: /^Escalated:/i }));
    expect(onStageClick).toHaveBeenCalledWith('escalated');

    fireEvent.click(screen.getByRole('button', { name: /^Cases opened:/i }));
    expect(onStageClick).toHaveBeenLastCalledWith('cases');

    fireEvent.click(screen.getByRole('button', { name: /^Closed by human:/i }));
    expect(onStageClick).toHaveBeenLastCalledWith('closed');
  });

  it('degrades to a case-only funnel when counters.available === false', () => {
    const data = fixture({
      counters: { available: false, since: null, incomplete: true },
      reduction: { overall_pct: '—', human_reduction_pct: '—' },
    });
    render(<NoiseFunnel data={data} animate={false} />);

    // The counter-sourced stages are dropped; the case-based flow (…→ closed) remains.
    expect(screen.queryByText('Ingested')).toBeNull();
    expect(screen.queryByText('Clustered')).toBeNull();
    expect(screen.getByText('Cases opened')).toBeInTheDocument();
    expect(screen.getByText('Auto-cleared')).toBeInTheDocument();
    expect(screen.getByText('Closed by human')).toBeInTheDocument();

    // The honest "warming up" note replaces the reduced-by headline.
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
    // The region carries the caller's aria-label.
    const region = screen.getByRole('group', { name: 'Alert noise funnel' });
    expect(within(region).getByText('Escalated')).toBeInTheDocument();
  });

  it('wires every stage chip as a per-stage hover-detail trigger', () => {
    render(<NoiseFunnel data={fixture()} animate={false} onStageClick={vi.fn()} />);
    // Each stage chip is a Radix HoverCard trigger — proven by the trigger `data-state`.
    const clickable = screen.getByRole('button', { name: /^Cases opened:/i });
    expect(clickable).toHaveAttribute('data-state', 'closed');
    // …and the terminal `closed` stage is likewise a hover trigger.
    render(<NoiseFunnel data={fixture()} animate={false} />);
    const group = screen.getByRole('group', { name: /^Closed by human:/i });
    expect(group).toHaveAttribute('data-state', 'closed');
  });

  it('surfaces the below-floor "Awaiting review" candidate stage ONLY when the backend emits it', () => {
    // Absent by default → the flow is byte-identical (no candidate row).
    const base = deriveFunnel(fixture());
    expect(base.rows.find((r) => r.key === 'candidate' || r.key === 'awaiting')).toBeUndefined();
    expect(base.rows.map((r) => r.key)).toEqual([
      'ingested',
      'clustered',
      'cases',
      'auto_cleared',
      'escalated',
      'closed',
    ]);

    // When the backend adds a `candidate` stage it renders between clustered and cases —
    // honest that below-floor candidates were seen + risk-scored but NOT yet LLM-reasoned.
    const withCandidate = fixture();
    withCandidate.stages = [
      ...withCandidate.stages.slice(0, 2),
      {
        key: 'candidate',
        label: 'Awaiting review',
        source: 'counters',
        deterministic: true,
        total: 120,
        by_severity: { medium: 60, low: 60 },
      },
      ...withCandidate.stages.slice(2),
    ];
    const derived = deriveFunnel(withCandidate);
    expect(derived.rows.map((r) => r.key)).toEqual([
      'ingested',
      'clustered',
      'candidate',
      'cases',
      'auto_cleared',
      'escalated',
      'closed',
    ]);
    const cand = derived.rows.find((r) => r.key === 'candidate')!;
    expect(cand.total).toBe(120);
    // It is a spine node, not a terminal case outcome.
    expect(cand.isOutcome).toBe(false);
  });

  it('renders the fallback "Awaiting review" label when the candidate stage carries no label', () => {
    const data = fixture();
    data.stages = [
      ...data.stages.slice(0, 2),
      { key: 'candidate', label: '', source: 'counters', deterministic: true, total: 80, by_severity: {} },
      ...data.stages.slice(2),
    ];
    render(<NoiseFunnel data={data} animate={false} />);
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
  });
});

describe('ribbonPath (Sankey link geometry)', () => {
  it('emits the canonical closed cubic-Bezier ribbon between two fixed-height endpoints', () => {
    // xm = (0 + 100) / 2 = 50.
    expect(ribbonPath(0, 0, 10, 100, 20, 30)).toBe(
      'M0,0 C50,0 50,20 100,20 L100,30 C50,30 50,10 0,10 Z',
    );
  });

  it('uses the horizontal midpoint as the shared control x for both curves', () => {
    // For x0=40, x1=200 → xm=120; both Bezier control columns are at 120.
    const d = ribbonPath(40, 5, 15, 200, 25, 45);
    expect(d.startsWith('M40,5 C120,5 120,25 200,25')).toBe(true);
    expect(d.endsWith('C120,45 120,15 40,15 Z')).toBe(true);
  });

  it('is always a closed path (starts with M, ends with Z)', () => {
    const d = ribbonPath(1, 2, 3, 4, 5, 6);
    expect(d[0]).toBe('M');
    expect(d.trim().endsWith('Z')).toBe(true);
  });
});
