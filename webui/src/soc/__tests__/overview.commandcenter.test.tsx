/**
 * Overview — Security Command Center integration test (Stitch-inspired command center).
 *
 * Pins the four command-center signatures:
 *   1. the page is titled "Security Command Center";
 *   2. the Active Risk Index (#1 — the ONE risk instrument) is its own flat cell in the
 *      integrated instrument band, a sibling of the plain header, never nested inside it;
 *   3. the Noise-Reduction funnel renders the six-stage flow ending in "Closed by human"
 *      (fetched via the typeof-guarded `api.noiseReduction`), and its stages drill through;
 *   4. the KPI micro-strip is 5 alert/case tiles (LLM spend is not a hero tile).
 *
 * Offline — the api + posture fetch are mocked; no auth, no #3 behaviour touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));
vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

const { listCasesMock, getMetricsMock, usageMock, noiseMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  getMetricsMock: vi.fn(),
  usageMock: vi.fn(),
  noiseMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
    noiseReduction: noiseMock,
  },
}));

import Overview, { PAGE_TITLE } from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics, NoiseReduction } from '@/lib/types';

const CASES: Case[] = [
  { case_id: 'c1', status: 'open', risk_score: 88, source_name: 'Elastic SIEM', title: 'Impossible travel', entity: { type: 'ip', value: '10.0.0.1' } },
  { case_id: 'c2', status: 'needs_human', risk_score: 65, source_name: 'Wazuh', title: 'Brute force', entity: { type: 'host', value: 'web-01' } },
  { case_id: 'c3', status: 'resolved', risk_score: 20, source_name: 'Elastic SIEM', title: 'Impossible travel', entity: { type: 'ip', value: '10.0.0.1' } },
] as unknown as Case[];

const METRICS: Metrics = {
  total_cases: 3, open_cases: 1, needs_human_cases: 1, closed_cases: 1,
  by_status: { open: 1, needs_human: 1, resolved: 1 },
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 1, NEEDS_HUMAN: 1, none: 0 },
  persona_usage: {}, playbook_usage: {}, avg_risk_score: 57,
  active_risk_index: 76, active_risk_case_count: 2,
  mttr_minutes: 120, resolved_count: 1,
  cases_per_day: [{ date: '2026-06-30', count: 2 }, { date: '2026-07-01', count: 5 }],
  burndown: [{ date: '2026-06-30', opened: 4, resolved: 2 }],
  timing_trend: [{ date: '2026-06-30', mttd: 12, respond: 30, resolve: 180 }],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const POSTURE: PostureResponse = {
  window_hours: 24, generated_at: '2026-07-01T08:00:00Z', case_count: 3,
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no response yet' },
    mttd_minutes: { p50: 9, p90: 30, mean: 12, max: 60, count: 3, available: true, reason: '' },
  },
  quality: {
    total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 1, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
    alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0.33,
    containment_rate: 0.5, automation_rate: 0.5,
  },
  aging: { queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1, closure_vs_arrival: 0.33, backlog: 2 },
  sla: { enabled: false },
};

const NOISE: NoiseReduction = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  bands: ['critical', 'high', 'medium', 'low', 'info'],
  stages: [
    { key: 'ingested', label: 'Ingested', source: 'counters', deterministic: true, total: 1000, by_severity: { critical: 50, high: 150, medium: 300, low: 400, info: 100 } },
    { key: 'clustered', label: 'Clustered', source: 'counters', deterministic: true, total: 400, by_severity: { critical: 40, high: 100, medium: 120, low: 100, info: 40 } },
    { key: 'cases', label: 'Cases opened', source: 'cases', deterministic: false, total: 40, by_severity: { critical: 8, high: 12, medium: 12, low: 6, info: 2 } },
    { key: 'auto_cleared', label: 'Auto-cleared', source: 'cases', deterministic: true, total: 20, by_severity: {} },
    { key: 'escalated', label: 'Escalated', source: 'cases', deterministic: true, total: 8, by_severity: {} },
    { key: 'needs_human', label: 'Needs human', source: 'cases', deterministic: true, total: 6, by_severity: {} },
    { key: 'closed', label: 'Closed by human', source: 'cases', deterministic: true, total: 12, by_severity: { high: 5, medium: 5, low: 2 } },
  ],
  drops: { suppressed: 5, ignored: 2 },
  reduction: { overall_pct: 96, human_reduction_pct: 50 },
  counters: { available: true, since: '2026-06-30T08:00:00Z', incomplete: false },
  cases_meta: { truncated: false, store_total: 40, fetched: 40 },
};

describe('Overview — Security Command Center', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    noiseMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({ total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD' });
    noiseMock.mockResolvedValue(NOISE);
  });

  it('is titled "Security Command Center"', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const hero = await screen.findByTestId('page-hero');
    expect(PAGE_TITLE).toBe('Security Command Center');
    expect(hero).toHaveTextContent('Security Command Center');
  });

  it('mounts the Active Risk Index (#1) as its own flat cell in the instrument band', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const hero = await screen.findByTestId('page-hero');
    const heroRow = await screen.findByTestId('hero-row');
    const ari = screen.getByTestId('active-risk-index');
    expect(ari).toBeInTheDocument();
    // Its own instrument cell, inside the band but NOT nested inside the plain header.
    expect(within(heroRow).getByTestId('active-risk-index')).toBeInTheDocument();
    expect(within(hero).queryByTestId('active-risk-index')).toBeNull();
    expect(ari).toHaveClass('bg-transparent');
    // It is the ONLY risk instrument on the page.
    expect(screen.getAllByTestId('active-risk-index')).toHaveLength(1);
  });

  it('mounts the six-stage Noise-Reduction funnel ending in "Closed by human"', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('noise-funnel')).toBeInTheDocument());
    expect(noiseMock).toHaveBeenCalled();
    const funnel = screen.getByTestId('noise-funnel');
    // The new terminal stage renders.
    expect(within(funnel).getByText('Closed by human')).toBeInTheDocument();
    expect(within(funnel).getByText('Auto-cleared by AI')).toBeInTheDocument();
    expect(within(funnel).getByText(/reduced by/i)).toBeInTheDocument();
    // The six dashboard rail stages are text-only: no shield/bot phase glyphs.
    expect(within(funnel).getByRole('button', { name: /^Cases opened:/i }).querySelector('svg')).toBeNull();
    // At narrow widths the six labels wrap into a readable 2/3-column grid; desktop
    // restores the single six-column rail shown in the supplied reference.
    expect(within(funnel).getByTestId('noise-stage-rail')).toHaveClass(
      'grid-cols-2',
      'sm:grid-cols-3',
      'lg:grid-cols-6',
    );
  });

  it('clicking a funnel stage drills into the filtered case list', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const funnel = await screen.findByTestId('noise-funnel');
    await userEvent.click(within(funnel).getByRole('button', { name: /^Escalated:/i }));
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ status: 'escalated', window: expect.any(Number) }),
    );
    // The terminal `closed` stage drills to the closed-case list.
    await userEvent.click(within(funnel).getByRole('button', { name: /^Closed by human:/i }));
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ status: 'closed', window: expect.any(Number) }),
    );
  });

  it('renders a KPI micro-strip of 5 alert/case tiles (LLM spend not a hero tile)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-open-cases')).toBeInTheDocument());
    const strip = screen.getByTestId('kpi-strip');
    expect(strip.querySelectorAll('[data-testid^="kpi-"]')).toHaveLength(5);
    for (const id of [
      'kpi-open-cases',
      'kpi-critical-high',
      'kpi-escalated-to-human',
      'kpi-false-positive-rate',
      'kpi-auto-resolved',
    ]) {
      expect(within(strip).getByTestId(id)).toHaveClass('bg-transparent');
    }
    expect(within(strip).queryByTestId('kpi-llm-spend')).toBeNull();
  });
});
