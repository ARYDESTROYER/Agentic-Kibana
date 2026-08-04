/**
 * NoiseFunnel — the precision-flow rendering of the noise-reduction path:
 * ingested → clustered → cases → {auto-cleared | escalated → closed}.
 *
 * Binds to the §D `GET /api/metrics/noise-reduction` contract: renders the flow from a
 * §D-shaped fixture (aggregate processing stream → terminal-outcome fan out), surfaces the new
 * `closed` ("Closed by human") terminal stage, fires `onStageClick` with the stage key,
 * and degrades to a case-only funnel when the durable counters are still warming up. The
 * SVG flow is decorative (`aria-hidden`); all meaning lives on the focusable stage rail.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NoiseFunnel, deriveFunnel, ribbonPath } from '../NoiseFunnel';
import { NoiseLineageView } from '../NoiseLineage';
import type { NoiseLineage, NoiseReduction } from '@/lib/types';

/**
 * A well-formed §D payload. The backend folds needs_human + the true_positive residual
 * into the terminal `escalated` node, so `escalated`(15) == cases.total(40) −
 * auto_cleared(25) — i.e. auto_cleared + escalated cover every case (`closed`(7) is an
 * OVERLAPPING view, not a partition slice). `needs_human`(5) remains in the payload for
 * back-compat / other consumers but is no longer a rendered spine chip.
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
        by_severity: { high: 7, medium: 12, low: 4, info: 2 },
      },
      {
        // Folds in needs_human + the true_positive residual → cases(40) − auto_cleared(25).
        key: 'escalated',
        label: 'Escalated',
        source: 'cases',
        deterministic: true,
        total: 15,
        by_severity: { critical: 8, high: 5, low: 2 },
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

function lineageFixture(): NoiseLineage {
  return {
    window_hours: 24,
    generated_at: '2026-07-05T00:01:00Z',
    rows: [
      {
        case_id: 'case-lineage-1',
        display_id: 'CASE-000042',
        created_at: '2026-07-05T00:00:00Z',
        severity: 'critical',
        clustering: {
          available: true,
          cluster_id: '4cb33a5bf9d8d6880f',
          input_count: 2,
          input_refs: ['alert-a15bb2b03f10', 'alert-75536a9e82bc'],
          source_count: 1,
          source_breakdown: { entra: 2 },
          correlation: {
            mode: 'threshold',
            threshold: 2,
            observed_count: 2,
            window_seconds: 300,
            group_by: 'user',
            matched_rule: 'Impossible travel',
            reason: 'Two sign-ins matched inside the configured window.',
          },
        },
        outcome: {
          key: 'auto_cleared',
          label: 'Auto-cleared by AI',
          funnel_stage: 'auto_cleared',
          terminal: true,
          status: 'closed',
          verdict: 'FALSE_POSITIVE',
          disposition: 'false_positive',
          decision_by: 'agent',
        },
      },
    ],
    meta: {
      returned: 1,
      window_cases_in_fetched_page: 4,
      fetched_cases: 40,
      store_total: 40,
      limit: 12,
      truncated: true,
      store_truncated: false,
    },
    limitations:
      'Rows are a bounded newest-case sample. Alert references are stable one-way identifiers.',
  };
}

describe('NoiseFunnel', () => {
  it('uses a restrained instrument panel and keeps the complete rail responsive', () => {
    render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);

    expect(screen.getByTestId('noise-instrument-panel')).toHaveClass(
      'border-y',
      'border-border/60',
      'py-3',
    );
    expect(screen.getByTestId('noise-flow-band')).toHaveClass(
      'hidden',
      'h-36',
      'lg:block',
      'lg:h-44',
    );
    expect(screen.getByTestId('noise-stage-rail')).toHaveClass(
      'grid-cols-2',
      'gap-y-3',
      'border-t',
      'pt-3',
      'sm:grid-cols-3',
      'lg:grid-cols-6',
    );
    expect(screen.getByTestId('noise-stage-rail')).not.toHaveAttribute('style');
    expect(screen.getByText('Alerts ingested')).toHaveClass('min-h-7');
  });

  it('opens a wide aggregate plus bounded alert-to-outcome lineage inspection', async () => {
    const loader = vi.fn().mockResolvedValue(lineageFixture());
    render(
      <NoiseFunnel
        data={fixture()}
        animate={false}
        variant="flat"
        expandable
        lineageLoader={loader}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand noise reduction flow' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Noise reduction flow · Last 24 hours/i })).toBeInTheDocument();
    const expandedFlow = screen.getByRole('group', { name: 'Expanded noise reduction funnel' });
    expect(expandedFlow).toBeInTheDocument();
    expect(within(expandedFlow).getByTestId('noise-flow-band')).toHaveClass('h-44');
    expect(within(expandedFlow).getByTestId('noise-flow-band')).not.toHaveClass('hidden');
    expect(screen.getByText(/Raw identifiers and payloads are intentionally excluded/i)).toBeInTheDocument();

    const lineage = await screen.findByRole('region', { name: 'Inspectable case lineages' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(24, 12);
    expect(within(lineage).getByTestId('noise-lineage-row')).toBeInTheDocument();
    expect(within(lineage).getByText('2 persisted signals')).toBeInTheDocument();
    expect(within(lineage).getByText('cluster-4cb33a5bf9d8')).toBeInTheDocument();
    expect(within(lineage).getByText('Auto-cleared by AI')).toBeInTheDocument();
    expect(within(lineage).getAllByText(/bounded newest-case sample/i)).toHaveLength(2);

    const caseLink = within(lineage).getByRole('link', { name: /CASE-000042/i });
    expect(caseLink).toHaveAttribute('href', '#/case_manager?caseId=case-lineage-1');

    fireEvent.click(within(lineage).getByText('Inspect persisted clustering facts'));
    expect(within(lineage).getAllByText('alert-a15bb2b03f10').length).toBeGreaterThan(1);
    expect(within(lineage).getByText('Impossible travel')).toBeInTheDocument();
  });

  it('shows a retryable lineage error without hiding the aggregate flow', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('Lineage read denied'))
      .mockResolvedValueOnce(lineageFixture());
    render(
      <NoiseFunnel data={fixture()} animate={false} variant="flat" expandable lineageLoader={loader} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand noise reduction flow' }));
    expect(screen.getByRole('group', { name: 'Expanded noise reduction funnel' })).toBeInTheDocument();
    expect(await screen.findByText('Lineage read denied')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('cluster-4cb33a5bf9d8')).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('uses the shared feedback grammar for lineage loading, error, and empty states', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <NoiseLineageView data={null} loading error={null} onRetry={onRetry} />,
    );

    expect(screen.getByRole('status', { name: 'Loading case lineages' })).toBeInTheDocument();
    expect(screen.getByTestId('console-loading-glyph')).toBeInTheDocument();

    rerender(
      <NoiseLineageView
        data={{ ...lineageFixture(), rows: [] }}
        loading={false}
        error={null}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('No case-forming lineages in this window')).toBeInTheDocument();

    rerender(
      <NoiseLineageView data={null} loading={false} error="Lineage unavailable" onRetry={onRetry} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Lineage unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('restores the fixed ribbon canvas and extends only the flat plot toward the left', () => {
    const { container, rerender } = render(
      <NoiseFunnel data={fixture()} animate={false} variant="flat" />,
    );

    const nodeXs = () => {
      const rects = Array.from(
        container.querySelectorAll<SVGRectElement>('[data-testid="noise-flow-band"] svg rect'),
      );
      expect(rects.length).toBeGreaterThan(1);
      return {
        first: Number(rects[0].getAttribute('x')),
        last: Number(rects[rects.length - 1].getAttribute('x')),
      };
    };

    expect(
      container.querySelector('[data-testid="noise-flow-band"] svg'),
    ).toHaveAttribute('viewBox', '0 0 640 220');
    const flatXs = nodeXs();
    rerender(<NoiseFunnel data={fixture()} animate={false} variant="card" />);
    const cardXs = nodeXs();

    expect(cardXs.first - flatXs.first).toBeCloseTo(14, 5);
    expect(flatXs.last).toBeCloseTo(cardXs.last, 5);
  });

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
    // Two processing links + the restored three-view outcome fan.
    const ribbons = svg!.querySelectorAll<SVGPathElement>('[data-noise-ribbon]');
    expect(ribbons).toHaveLength(5);
    expect(svg!.querySelectorAll('defs linearGradient')).toHaveLength(0);
    expect(ribbons[0]).toHaveAttribute('data-source-stage', 'ingested');
    expect(ribbons[0]).toHaveAttribute('data-target-stage', 'clustered');
    expect(ribbons[0].style.fillOpacity).toBe('var(--noise-ribbon-opacity)');
    expect(ribbons[0].style.strokeOpacity).toBe('var(--noise-ribbon-stroke-opacity)');
    expect(ribbons[0]).toHaveAttribute('vector-effect', 'non-scaling-stroke');
    expect(svg!.querySelectorAll('[data-source-stage="ingested"]')).toHaveLength(1);
    expect(svg!.querySelector('[data-source-stage="cases"][data-target-stage="auto_cleared"]')).not.toBeNull();
    expect(svg!.querySelector('[data-source-stage="cases"][data-target-stage="escalated"]')).not.toBeNull();
    expect(svg!.querySelector('[data-source-stage="cases"][data-target-stage="closed"]')).not.toBeNull();
    expect(svg!.querySelector('[data-source-stage="escalated"][data-target-stage="closed"]')).toBeNull();

    // Square anchors and direct, unboxed loss annotations avoid decorative chart chrome.
    for (const node of svg!.querySelectorAll<SVGRectElement>('[data-node-key]')) {
      expect(node).toHaveAttribute('rx', '0');
    }
    expect(screen.getByText('−780 · 78% filtered')).toHaveAttribute('data-loss-annotation');

    // Operator-requested rail treatment: the stage controls carry text/count/share only.
    expect(screen.getByRole('button', { name: /^Cases opened:/i }).querySelector('svg')).toBeNull();
  });

  it('keeps node geometry exactly proportional to the underlying counts', () => {
    const { container } = render(<NoiseFunnel data={fixture()} animate={false} />);
    const height = (key: string) =>
      Number(container.querySelector<SVGRectElement>(`rect[data-node-key="${key}"]`)?.getAttribute('height'));

    expect(height('clustered') / height('ingested')).toBeCloseTo(220 / 1000, 6);
    expect(height('cases') / height('ingested')).toBeCloseTo(40 / 1000, 6);
    expect(height('closed') / height('cases')).toBeCloseTo(7 / 40, 6);
  });

  it('does not label a truthful non-zero survivor as zero percent', () => {
    const data = fixture();
    data.stages = data.stages.map((stage) =>
      stage.key === 'closed'
        ? { ...stage, total: 1, by_severity: { high: 1 } }
        : stage,
    );
    render(<NoiseFunnel data={data} animate={false} />);

    expect(
      screen.getByRole('button', {
        name: /^Closed by human: 1 case, less than 1% of ingested$/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('<1%')).toBeInTheDocument();
  });

  it('discloses partial aggregate coverage without requiring expansion', () => {
    const data = fixture({
      counters: {
        available: true,
        since: '2026-07-05T00:00:00Z',
        incomplete: true,
      },
    });
    render(<NoiseFunnel data={data} animate={false} />);

    expect(screen.getByTestId('noise-coverage-warning')).toHaveTextContent(
      /Partial coverage.*cover only part of the selected window/i,
    );
  });

  it('focuses the inspected stage path and mutes unrelated links', () => {
    const { container } = render(
      <NoiseFunnel data={fixture()} animate={false} onStageClick={vi.fn()} />,
    );
    const cases = screen.getByRole('button', { name: /^Cases opened:/i });
    const inbound = container.querySelector<SVGPathElement>(
      '[data-source-stage="clustered"][data-target-stage="cases"]',
    );
    const unrelated = container.querySelector<SVGPathElement>(
      '[data-source-stage="ingested"][data-target-stage="clustered"]',
    );

    fireEvent.focus(cases);
    expect(inbound?.style.fillOpacity).toBe('1');
    expect(unrelated?.style.fillOpacity).toBe('0.14');

    fireEvent.blur(cases);
    expect(inbound?.style.fillOpacity).toBe('var(--noise-ribbon-opacity)');
    expect(unrelated?.style.fillOpacity).toBe('var(--noise-ribbon-opacity)');
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

    // outcomeSum = auto(25) + escalated(15) + closed(7) — the outcomes OVERLAP (closed is
    // a subset of the folded escalated), so this compatibility sum can exceed cases.total.
    expect(derived.outcomeSum).toBe(47);

    // The legacy `needs_human` / `true_positive` keys are no longer rendered spine rows.
    expect(derived.rows.find((r) => r.key === 'needs_human')).toBeUndefined();
    expect(derived.rows.find((r) => r.key === 'true_positive')).toBeUndefined();
  });

  it('folds needs_human + the residual into escalated so the outcomes account for every case', () => {
    const data = fixture();
    const derived = deriveFunnel(data);
    const total = (key: string) => derived.rows.find((r) => r.key === key)?.total ?? 0;
    const cases = total('cases');
    const autoCleared = total('auto_cleared');
    const escalated = total('escalated');

    // The escalated node carries every non-auto-cleared case (= cases − auto_cleared),
    // dwarfing the standalone needs_human count still present in the raw payload — i.e.
    // needs_human + the true_positive residual were folded in.
    const needsHuman = data.stages.find((s) => s.key === 'needs_human')!.total as number;
    expect(escalated).toBe(cases - autoCleared);
    expect(escalated).toBeGreaterThan(needsHuman);

    // Terminal outcomes account for EVERY windowed case: the two disjoint covering nodes
    // (auto_cleared + escalated) sum to the case total, so no case renders in no node.
    expect(autoCleared + escalated).toBe(cases);
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

  it('renders the shared loading state and nothing when data is absent', () => {
    const { rerender, container } = render(<NoiseFunnel data={null} loading />);
    expect(screen.getByTestId('noise-funnel-loading')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading noise reduction flow' })).toBeInTheDocument();
    expect(screen.getByTestId('console-loading-glyph')).toBeInTheDocument();

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

  it('keeps inspect-only stages keyboard focusable when no drill-down handler exists', () => {
    render(<NoiseFunnel data={fixture()} animate={false} ariaLabel="Alert noise funnel" />);
    const escalated = screen.getByRole('button', { name: /^Escalated:/i });
    expect(escalated).toHaveAttribute('type', 'button');
    expect(escalated).toHaveAttribute('aria-describedby');
    expect(escalated).not.toHaveAttribute('title');
    expect(document.getElementById(escalated.getAttribute('aria-describedby') || '')).toHaveTextContent(
      /Every case not false-positive auto-cleared/i,
    );
    // The region carries the caller's aria-label.
    const region = screen.getByRole('group', { name: 'Alert noise funnel' });
    expect(within(region).getByText('Escalated')).toBeInTheDocument();
  });

  it('wires every stage chip as a per-stage hover-detail trigger', () => {
    const rendered = render(
      <NoiseFunnel data={fixture()} animate={false} onStageClick={vi.fn()} />,
    );
    // Each stage chip is a Radix HoverCard trigger — proven by the trigger `data-state`.
    const clickable = screen.getByRole('button', { name: /^Cases opened:/i });
    expect(clickable).toHaveAttribute('data-state', 'closed');
    // …and the terminal `closed` stage is likewise a hover trigger.
    rendered.unmount();
    render(<NoiseFunnel data={fixture()} animate={false} />);
    const inspectOnly = screen.getByRole('button', { name: /^Closed by human:/i });
    expect(inspectOnly).toHaveAttribute('data-state', 'closed');
  });

  it('explains outcome authority and retention without mislabelling human closure as AI work', async () => {
    const user = userEvent.setup();
    render(<NoiseFunnel data={fixture()} animate={false} onStageClick={vi.fn()} />);

    await user.hover(screen.getByRole('button', { name: /^Closed by human: 7 cases/i }));
    expect(await screen.findByText('Human-driven')).toBeInTheDocument();
    expect(screen.getByText(/47% of escalated/i)).toBeInTheDocument();

    await user.unhover(screen.getByRole('button', { name: /^Closed by human:/i }));
    await user.hover(screen.getByRole('button', { name: /^Cases opened: 40 cases/i }));
    expect(await screen.findByText('AI-assisted')).toBeInTheDocument();
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

    // When the backend adds a `candidate` stage it gets its own evidence column and a
    // side branch from clustered alerts; it is NOT inserted as the parent of opened cases.
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
    // It is a non-terminal side cohort, not a terminal case outcome.
    expect(cand.isOutcome).toBe(false);

    const { container } = render(<NoiseFunnel data={withCandidate} animate={false} />);
    expect(
      container.querySelector('[data-source-stage="clustered"][data-target-stage="candidate"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-source-stage="clustered"][data-target-stage="cases"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-source-stage="candidate"][data-target-stage="cases"]'),
    ).toBeNull();
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
