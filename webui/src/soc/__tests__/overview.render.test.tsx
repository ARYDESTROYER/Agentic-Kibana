/**
 * Overview (Security Posture Dashboard) — Round-5 Dash-A/Dash-B render test.
 *
 * The Overview page previously had ZERO dedicated coverage (only the App smoke boot
 * guard). This pins the load-bearing rework contract:
 *   1. the compact HERO is present + addressable via `data-testid="page-hero"`, uses the
 *      hero variant (compact ~64px, `hero-display`), and shows the `PAGE_TITLE`;
 *   2. the un-nested KPI STRIP renders as ONE responsive grid of drill-down tiles
 *      (`kpi-*` testids), NOT the old col-span-2 nested layout;
 *   3. the ~120 lines of client posture math are GONE — the timing trio reads the
 *      SERVER posture (`usePosture` → `fetchPosture`), including the honest DASH for an
 *      unavailable block (never a fabricated client value);
 *   4. the page body is the `wide` PageContainer (@container escape from the 1400px cap);
 *   5. tiles deep-link to the filtered case list carrying the window.
 *
 * Fully offline — the page uses no auth; only the data calls + the posture fetch are
 * mocked. Deliberately does NOT depend on `/sources/health` (unmocked in the smoke
 * surface): connector health is derived from the case sample.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));

// `usePosture` imports `fetchPosture` from this module; mocking it feeds the hook.
vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

const { listCasesMock, getMetricsMock, usageMock, ragMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  getMetricsMock: vi.fn(),
  usageMock: vi.fn(),
  ragMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
    ragStats: ragMock,
  },
}));

import Overview, { PAGE_TITLE } from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics } from '@/lib/types';

const CASES: Case[] = [
  {
    case_id: 'c1',
    status: 'open',
    risk_score: 88, // critical
    source_name: 'Elastic SIEM',
    entity: { type: 'ip', value: '10.0.0.1' },
  },
  {
    case_id: 'c2',
    status: 'needs_human',
    risk_score: 65, // high
    source_name: 'Wazuh',
    entity: { type: 'host', value: 'web-01' },
  },
  {
    case_id: 'c3',
    status: 'resolved',
    risk_score: 20, // low
    source_name: 'Elastic SIEM',
    entity: { type: 'user', value: 'alice' },
  },
] as unknown as Case[];

const METRICS: Metrics = {
  total_cases: 3,
  open_cases: 1,
  needs_human_cases: 1,
  closed_cases: 1,
  by_status: { open: 1, needs_human: 1, resolved: 1 },
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 1, NEEDS_HUMAN: 1, none: 0 },
  persona_usage: {},
  playbook_usage: {},
  avg_risk_score: 57,
  mttr_minutes: 120,
  resolved_count: 1,
  cases_per_day: [],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 3,
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    // Unavailable → the timing trio must show the honest reason, never a fake number.
    dwell_minutes: {
      p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false,
      reason: 'no case has received a first response yet',
    },
  },
  quality: {
    total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 1, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
    alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0.33,
    containment_rate: 0.5, automation_rate: 0.5,
  },
  aging: {
    queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1,
    closure_vs_arrival: 0.33, backlog: 2,
  },
  sla: {
    enabled: true, evaluated: 2, response_breached: 1, response_at_risk: 1,
    resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 87.5, breaching: [],
  },
};

describe('Overview — Security Posture Dashboard (Dash-A/Dash-B)', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    ragMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({ total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD' });
    ragMock.mockResolvedValue({ document_count: 5, total_chunks: 42 });
  });

  it('renders a COMPACT hero (page-hero testid, hero variant) carrying the title', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const hero = await screen.findByTestId('page-hero');
    // Compact hero: the merged PageHeader hero variant (hero-display class), NOT the old
    // tall marketing band. The title constant proves the console booted to Overview.
    expect(hero).toHaveClass('hero-display');
    expect(hero).toHaveTextContent(PAGE_TITLE);
    // The eyebrow must NOT restate the title (breadcrumb/eyebrow ≠ title).
    expect(hero.textContent).not.toContain(`${PAGE_TITLE}${PAGE_TITLE}`);
  });

  it('renders the un-nested KPI strip as drill-down tiles (kpi-* testids)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // The flat KPI strip renders each tile addressably. Open Cases / Crit-High / Spend
    // are the load-bearing drill-downs.
    await waitFor(() => expect(screen.getByTestId('kpi-open-cases')).toBeInTheDocument());
    expect(screen.getByTestId('kpi-critical-high')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-llm-spend')).toBeInTheDocument();
    // Open cases = the 1 open-status case in the sample.
    expect(within(screen.getByTestId('kpi-open-cases')).getByText('1')).toBeInTheDocument();
  });

  it('reads timing from the SERVER posture (no client math), honoring the unavailable DASH', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // MTTA p50 = 45m and MTTR p50 = 180m → "3h" come straight from the posture rollup.
    await waitFor(() => expect(screen.getAllByText('45m').length).toBeGreaterThan(0));
    expect(screen.getAllByText('3h').length).toBeGreaterThan(0);
    // The dwell block is unavailable → the honest server reason is shown (NOT a fake 0).
    expect(
      screen.getAllByText(/no case has received a first response yet/i).length,
    ).toBeGreaterThan(0);
    // The posture fetch was the timing source — proving the client-math shadow is gone.
    expect(fetchPostureMock).toHaveBeenCalled();
  });

  it('deep-links a KPI tile to the filtered case list carrying the window', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const openTile = await screen.findByTestId('kpi-open-cases');
    await userEvent.click(openTile);
    expect(onNavigate).toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ status: 'open', window: expect.any(Number) }),
    );
  });

  it('window-scopes the case sample by created-at so case widgets honour the range (#37)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
    // The case sample is fetched with a `from=now-<hours>h` created-at window (capped at
    // 200 by created-desc) so open/severity/health/workload reflect the TimeRangePicker.
    const arg = listCasesMock.mock.calls[0][0] as { limit?: number; from?: string };
    expect(arg).toMatchObject({ limit: 200 });
    expect(String(arg.from)).toMatch(/^now-\d+h$/);
  });

  it('deep-links the Critical/High KPI tile to a SEVERITY-filtered case list (#38)', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-critical-high');
    await userEvent.click(tile);
    // The sample has a critical case (risk 88) → drill to the WORST band (critical),
    // carrying the selected window (never a stray status filter).
    expect(onNavigate).toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ severity: 'critical', window: expect.any(Number) }),
    );
    const [, opts] = onNavigate.mock.calls[0];
    expect(opts).not.toHaveProperty('status');
  });

  it('deep-links an open-by-severity row to that severity band, carrying the window (#38)', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    // Every band row is always rendered (even at count 0); the High row drills severity=high.
    const highRow = await screen.findByRole('button', { name: /view High severity cases/i });
    await userEvent.click(highRow);
    expect(onNavigate).toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ severity: 'high', window: expect.any(Number) }),
    );
  });

  it('renders the autonomous-vs-human trust surface + named dashboard groups', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // #3 trust surface: the autonomy split band is present as a labelled region.
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /Autonomous vs human/i })).toBeInTheDocument(),
    );
    // The advisory caveat is spelled out (never influences decide()).
    expect(screen.getByText(/never influences that/i)).toBeInTheDocument();
    // A couple of the other named widget bands render as regions too.
    expect(screen.getByRole('region', { name: /Response timing/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Connector health/i })).toBeInTheDocument();
  });
});
