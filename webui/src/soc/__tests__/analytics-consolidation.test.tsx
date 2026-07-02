/**
 * Analytics consolidation (Round 4 / #10 declutter) render test.
 *
 * The reporting surfaces used to be split four ways (Metrics operational / Cost /
 * Overview KPIs / Standup) behind a double tab strip. They now live under ONE strip
 * owned by the Metrics page:
 *
 *   Operational | Performance | Posture | Cost
 *
 * with Cost folded in as the SINGLE spend home. This spec asserts:
 *   1. all four tabs render in one strip (no double strip),
 *   2. the Cost tab shows the spend ledger (the former standalone Cost page, hosted),
 *   3. the Operational tab no longer owns the full cost view (LLM spend moved) but
 *      keeps a compact pointer into the Cost tab, and
 *   4. `onTabChange` fires so the host can mirror the tab into the route opts.
 *
 * Fully offline — only the data calls (posture + usage + metrics) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock, fetchMitreMock } = vi.hoisted(() => ({
  fetchPostureMock: vi.fn(),
  fetchMitreMock: vi.fn(),
}));

vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return {
    ...actual,
    fetchPosture: fetchPostureMock,
    fetchMitreCoverage: fetchMitreMock,
  };
});

vi.mock('@/lib/api', () => ({
  api: {
    getMetrics: vi.fn().mockResolvedValue({
      total_cases: 8,
      open_cases: 3,
      needs_human_cases: 1,
      closed_cases: 5,
      by_status: {},
      by_verdict: { TRUE_POSITIVE: 2, FALSE_POSITIVE: 4, NEEDS_HUMAN: 1, none: 1 },
      by_disposition: {},
      persona_usage: {},
      playbook_usage: {},
      avg_risk_score: 40,
      mttr_minutes: 90,
      resolved_count: 5,
      cases_per_day: [],
      feedback: {
        graded_cases: 0, feedback_count: 0, agreement_rate: 0,
        avg_accuracy: 0, avg_reasoning_quality: 0, avg_action_appropriateness: 0,
        time_saved_minutes: 0, outcome_distribution: {},
      },
      // The compact Operational spend pointer reads these; the FULL ledger is the Cost tab.
      cost: { total_cost: 1.23, total_tokens: 45000, call_count: 12, currency: 'USD' },
    }),
    ragStats: vi.fn().mockResolvedValue(null),
    getMemory: vi.fn().mockResolvedValue(null),
    // The Cost tab (embedded) reads this ONE ledger endpoint.
    usageSummary: vi.fn().mockResolvedValue({
      total_cost: 1.23,
      total_tokens: 45000,
      call_count: 12,
      today_cost: 0.5,
      currency: 'USD',
      cost_over_time: [{ cost: 0.4 }, { cost: 0.83 }],
      by_model: [{ key: 'claude-x', cost: 1.23, tokens: 45000, calls: 12 }],
      by_role: [],
      by_surface: [],
      top_cost_drivers: [],
    }),
  },
}));

import Metrics from '../pages/Metrics';
import type { PostureResponse } from '../pages/Metrics.posture.api';

const POSTURE: PostureResponse = {
  window_hours: 168,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 8,
  lifecycle: {
    mtta_minutes: { p50: 30, p90: 90, mean: 45, max: 150, count: 6, available: true, reason: '' },
    mttr_minutes: { p50: 90, p90: 300, mean: 150, max: 500, count: 5, available: true, reason: '' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no first response yet' },
  },
  quality: {
    total_cases: 8, verdicted_cases: 7, true_positive_cases: 2, false_positive_cases: 4,
    needs_human_cases: 1, escalated_cases: 1, terminal_cases: 5, auto_closed_cases: 2,
    alert_to_incident_ratio: 0.25, false_positive_rate: 0.5, escalation_rate: 0.12,
    containment_rate: 0.6, automation_rate: 0.4,
  },
  aging: {
    queue_depth: 3, age_buckets: [], oldest: [], arrivals: 8, closures: 5,
    closure_vs_arrival: 0.6, backlog: 3,
  },
  sla: { enabled: false, evaluated: 0, response_breached: 0, response_at_risk: 0, resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 0, breaching: [], reason: 'off' },
  compare: undefined,
};

describe('Analytics consolidation (Round 4 / #10)', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    fetchMitreMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    fetchMitreMock.mockResolvedValue(null);
  });

  it('renders ONE tab strip: Operational | Performance | Posture | Cost', async () => {
    render(<Metrics embedded />);
    // Anchor on the stable per-id tab testids (reword-proof) while KEEPING the
    // accessible role+name checks (a tab that drops its label still fails).
    await waitFor(() =>
      expect(screen.getByTestId('metrics-tab-operational')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('metrics-tab-performance')).toBeInTheDocument();
    expect(screen.getByTestId('metrics-tab-posture')).toBeInTheDocument();
    expect(screen.getByTestId('metrics-tab-cost')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /operational/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /performance/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /posture/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^cost$/i })).toBeInTheDocument();
    // Exactly four SECTION tabs in the metrics strip — no double strip / phantom
    // tab. Scoped to the metrics TabsList; the inline window/sort SegmentedControls
    // (now radiogroups, role="radio") in the same row can't inflate a role="tab" count.
    const strip = screen.getByTestId('metrics-tabs');
    expect(within(strip).getAllByRole('tab')).toHaveLength(4);
  });

  it('Cost tab is the single spend home — shows the ledger controls + breakdown', async () => {
    render(<Metrics embedded />);
    // Scope the section-tab lookup to the metrics strip: the embedded Cost ledger's
    // own window/rank SegmentedControls are radiogroups (one segment labelled "Cost");
    // scoping to the real TabsList keeps the section-tab lookup unambiguous.
    await waitFor(() => expect(screen.getByTestId('metrics-tabs')).toBeInTheDocument());
    const costTabTrigger = () =>
      within(screen.getByTestId('metrics-tabs')).getByRole('tab', { name: /^cost$/i });
    await waitFor(() => expect(costTabTrigger()).toBeInTheDocument());
    await userEvent.click(costTabTrigger());

    // The embedded Cost ledger renders its own breakdowns (single cost home).
    await waitFor(() => expect(screen.getByText(/detailed cost ledger/i)).toBeInTheDocument());
    expect(screen.getByText(/by model/i)).toBeInTheDocument();
    // The verbatim model id renders as plain text (#9).
    expect(screen.getAllByText('claude-x').length).toBeGreaterThan(0);
  });

  it('Operational tab keeps a compact spend pointer INTO the Cost tab (no full cost view)', async () => {
    render(<Metrics embedded />);
    await waitFor(() => expect(screen.getByText(/verdict mix/i)).toBeInTheDocument());

    // The compact spend card + its jump control live on Operational...
    const jump = await screen.findByRole('button', { name: /cost tab/i });
    expect(jump).toBeInTheDocument();
    // ...but the full ledger does NOT (it lives only in the Cost tab).
    expect(screen.queryByText(/detailed cost ledger/i)).not.toBeInTheDocument();

    // Clicking the pointer switches to the Cost tab (and reveals the ledger).
    await userEvent.click(jump);
    await waitFor(() => expect(screen.getByText(/detailed cost ledger/i)).toBeInTheDocument());
  });

  it('fires onTabChange so the host can mirror the tab into the route opts', async () => {
    const onTabChange = vi.fn();
    render(<Metrics embedded onTabChange={onTabChange} />);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /posture/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('tab', { name: /posture/i }));
    expect(onTabChange).toHaveBeenCalledWith('posture');
  });

  it('honours a deep-link `tab` prop (host drives the active tab from the route)', async () => {
    render(<Metrics embedded tab="cost" />);
    // With tab='cost' the Cost ledger is active on first paint.
    await waitFor(() => expect(screen.getByText(/detailed cost ledger/i)).toBeInTheDocument());
    // Sanity: the Cost SECTION tab is selected. Scope to the metrics strip so the
    // embedded ledger's own "Cost"-labelled SegmentedControl segment isn't matched.
    const costTab = within(screen.getByTestId('metrics-tabs')).getByRole('tab', {
      name: /^cost$/i,
    });
    expect(costTab).toHaveAttribute('aria-selected', 'true');
  });
});
