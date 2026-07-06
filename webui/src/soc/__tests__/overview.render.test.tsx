/**
 * Overview (Security Command Center) — render test for the Prisma-Cloud-style rebuild.
 *
 * Pins the load-bearing dashboard contract:
 *   1. the PLAIN header (page-hero, no hero card chrome, exactly one h1, PAGE_TITLE);
 *   2. the un-nested KPI micro-strip of 5 alert/case tiles (Open / Critical-High /
 *      Escalated / False-Positive-Rate / Auto-Resolved); LLM spend is NOT a hero tile;
 *   3. the hero row = the Active Risk Index (its own card) + a "Cases resolved" donut
 *      snapshot + an "Open cases" donut snapshot;
 *   4. Zone C = Cases-burndown · Mean-time-to-detect/respond · Top-open-cases;
 *   5. timing reads the SERVER posture (honest DASH / "not measured" for missing samples);
 *   6. KPI deltas are wired from the server `posture.compare` (unit-matched tiles only);
 *   7. tiles + snapshot CTAs deep-link to the filtered case list carrying the window;
 *   8. the loading skeleton mirrors the final dense layout.
 *
 * Fully offline. `noiseReduction` is intentionally omitted so the funnel band self-omits.
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

const { listCasesMock, getMetricsMock, usageMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  getMetricsMock: vi.fn(),
  usageMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
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
  burndown: [
    { date: '2026-06-30', opened: 4, resolved: 2 },
    { date: '2026-07-01', opened: 3, resolved: 5 },
  ],
  timing_trend: [
    { date: '2026-06-30', mttd: 12, respond: 30, resolve: 180 },
    { date: '2026-07-01', mttd: null, respond: 45, resolve: null },
  ],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const QUALITY = {
  total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
  needs_human_cases: 1, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
  alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0.33,
  containment_rate: 0.5, automation_rate: 0.5,
};

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 3,
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    // Unavailable → the timing card must show the honest reason, never a fake number.
    dwell_minutes: {
      p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false,
      reason: 'no case has received a first response yet',
    },
    // mttd_minutes intentionally ABSENT → the MTTD stat must read "not measured".
  },
  quality: QUALITY,
  aging: {
    queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1,
    closure_vs_arrival: 0.33, backlog: 2,
  },
  sla: {
    enabled: true, evaluated: 2, response_breached: 1, response_at_risk: 1,
    resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 87.5, breaching: [],
  },
};

/** Same posture, plus a period-over-period `compare` block (wires the KPI deltas). */
const POSTURE_CMP: PostureResponse = {
  ...POSTURE,
  compare: {
    mode: 'prev',
    case_count: { value: 3, prev: 4, delta_pct: -25 },
    alert_to_incident_ratio: { value: 0.33, prev: 0.4, delta_pct: -17.5 },
    false_positive_rate: { value: 0.5, prev: 0.6, delta_pct: -16.7 },
    escalation_rate: { value: 0.33, prev: 0.5, delta_pct: -20 },
    automation_rate: { value: 0.5, prev: 0.4, delta_pct: 25 },
    mttr_p50: { value: 180, prev: 200, delta_pct: -10 },
    mtta_p50: { value: 45, prev: 40, delta_pct: 12.5 },
  },
};

describe('Overview — Security Command Center (rebuild)', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({ total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD' });
  });

  it('renders a PLAIN header (page-hero testid, no hero card chrome) carrying the title', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const hero = await screen.findByTestId('page-hero');
    expect(hero).not.toHaveClass('hero-display');
    expect(hero).not.toHaveClass('bg-card');
    // Exactly one page-level h1 (the title) lives in the header.
    expect(hero.querySelectorAll('h1')).toHaveLength(1);
    expect(hero).toHaveTextContent(PAGE_TITLE);
  });

  it('renders the KPI micro-strip: 5 alert/case tiles (LLM spend NOT a hero tile)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-open-cases')).toBeInTheDocument());
    const strip = screen.getByTestId('kpi-strip');
    for (const id of [
      'kpi-open-cases',
      'kpi-critical-high',
      'kpi-escalated-to-human',
      'kpi-false-positive-rate',
      'kpi-auto-resolved',
    ]) {
      expect(within(strip).getByTestId(id)).toBeInTheDocument();
    }
    // EXACTLY 5 hero tiles.
    expect(strip.querySelectorAll('[data-testid^="kpi-"]')).toHaveLength(5);
    // Spend is not on the strip.
    expect(within(strip).queryByTestId('kpi-llm-spend')).toBeNull();
    // Open cases = the 1 open-status case (rolled via CountUp).
    expect(within(screen.getByTestId('kpi-open-cases')).getByText('1')).toBeInTheDocument();
    // False-positive rate reads the server quality rate (0.5 → "50%").
    expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('50%')).toBeInTheDocument();
    // Auto-resolved reads the server quality count (auto_closed_cases = 1).
    expect(within(screen.getByTestId('kpi-auto-resolved')).getByText('1')).toBeInTheDocument();
  });

  it('mounts the hero row: the Active Risk Index (own card) + two donut snapshots', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const heroRow = await screen.findByTestId('hero-row');
    // The ONE risk instrument, exactly once, inside the hero row.
    expect(within(heroRow).getByTestId('active-risk-index')).toBeInTheDocument();
    expect(screen.getAllByTestId('active-risk-index')).toHaveLength(1);
    // The two snapshot headings (h2) — resolved + open case donuts.
    expect(screen.getByRole('heading', { name: 'Cases resolved', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open cases', level: 2 })).toBeInTheDocument();
    // The resolved snapshot severity ring is present + labelled.
    expect(screen.getByRole('img', { name: /Resolved cases by severity/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Open cases by severity/i })).toBeInTheDocument();
  });

  it('leads with the burndown · detect/respond · top-cases zone', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    for (const name of [
      /Cases burndown/i,
      /Mean time to detect \/ respond/i,
      /Top open cases/i,
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('reads timing from the SERVER posture, honoring the honest "not measured" DASH', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const timingRegion = screen.getByRole('region', { name: /Mean time to detect/i });
    expect(timingRegion).toBeInTheDocument();
    // MTTD has no posture block here → an explicit "not measured", never a fabricated number.
    await waitFor(() => expect(screen.getByText(/not measured/i)).toBeInTheDocument());
    // "Respond" reads the ACK clock (mtta_minutes, p50 45) — the first HUMAN response, NOT
    // dwell (which would count an AI auto-close as a response). So it shows the honest value.
    expect(within(timingRegion).getByText('45m')).toBeInTheDocument();
    expect(fetchPostureMock).toHaveBeenCalled();
    // The posture fetch requests the period-over-period compare block.
    expect(fetchPostureMock).toHaveBeenCalledWith(expect.any(Number), 'prev');
  });

  it('attaches a delta ONLY to a unit-matched tile (FP-rate), never to the count tiles', async () => {
    fetchPostureMock.mockResolvedValue(POSTURE_CMP);
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // The False-Positive-RATE tile is unit-matched to `compare.false_positive_rate`.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('kpi-false-positive-rate')).getByText('-16.7%'),
      ).toBeInTheDocument(),
    );
    // The COUNT tiles must NOT borrow a rate/total delta (a KpiTile delta is the only
    // role="img" in the tile, so its absence proves no delta is drawn).
    expect(within(screen.getByTestId('kpi-open-cases')).queryByRole('img')).toBeNull();
    expect(within(screen.getByTestId('kpi-escalated-to-human')).queryByRole('img')).toBeNull();
    expect(within(screen.getByTestId('kpi-auto-resolved')).queryByRole('img')).toBeNull();
    const strip = screen.getByTestId('kpi-strip');
    expect(within(strip).queryByText('-20%')).toBeNull(); // escalation_rate
    expect(within(strip).queryByText('+25%')).toBeNull(); // automation_rate
    expect(within(strip).queryByText('-25%')).toBeNull(); // case_count
    // The comparison window is stated ONCE under the strip.
    expect(screen.getByText(/Deltas compare the previous/i)).toBeInTheDocument();
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

  it('deep-links the snapshot CTAs to the resolved / open case lists', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    await userEvent.click(await screen.findByRole('button', { name: /View resolved cases/i }));
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ status: 'closed', window: expect.any(Number) }),
    );
    await userEvent.click(screen.getByRole('button', { name: /View open cases/i }));
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ status: 'open', window: expect.any(Number) }),
    );
  });

  it('window-scopes the current case sample by created-at (#37)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
    // The FIRST listCases call is the current window (a second call fetches the previous
    // window for the snapshot trend deltas).
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
    expect(onNavigate).toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ severity: 'critical', window: expect.any(Number) }),
    );
    const [, opts] = onNavigate.mock.calls[0];
    expect(opts).not.toHaveProperty('status');
  });

  // The severity banding folds onto the ONE severity authority (badges.ts
  // severityBandFromNumber, the 74/48/22/8 ladder). A risk_score of 76 must band
  // CRITICAL (it read HIGH under the old 80-cut). Locked via the Critical/High KPI sub.
  it('bands a risk_score of 76 as CRITICAL (the unified 74-cut ladder)', async () => {
    listCasesMock.mockResolvedValue({
      cases: [
        { case_id: 'u1', status: 'open', risk_score: 88 }, // critical
        { case_id: 'u2', status: 'open', risk_score: 76 }, // critical NOW (was high @ 80-cut)
        { case_id: 'u3', status: 'open', risk_score: 65 }, // high
        { case_id: 'u4', status: 'open', risk_score: 20 }, // low
      ] as unknown as Case[],
      total: 4,
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // 88 + 76 BOTH band Critical → the Critical/High tile shows 3 (2 crit + 1 high) and
    // its sub reports "2 critical observed". Under the old 80-cut it would be "1 critical".
    const tile = await screen.findByTestId('kpi-critical-high');
    await waitFor(() => expect(within(tile).getByText('3')).toBeInTheDocument());
    expect(within(tile).getByText(/2 critical observed/i)).toBeInTheDocument();
  });

  // The Cases severity FILTER prefers the source-asserted `severity_band`; the Overview
  // banding must bucket by the SAME preference so a drilled list reconciles.
  it('buckets a source_asserted case by severity_band, not the risk band', async () => {
    listCasesMock.mockResolvedValue({
      cases: [
        {
          case_id: 's1', status: 'open',
          severity_band: 'critical', severity_source: 'source_asserted', risk_score: 20,
        },
        { case_id: 's2', status: 'open', risk_score: 65 }, // high (no severity_band)
      ] as unknown as Case[],
      total: 2,
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // s1 counts Critical (via severity_band, NOT its risk_score 20 which is Low) → the
    // Critical/High tile shows 2 (s1 crit + s2 high) with "1 critical observed".
    const tile = await screen.findByTestId('kpi-critical-high');
    await waitFor(() => expect(within(tile).getByText('2')).toBeInTheDocument());
    expect(within(tile).getByText(/1 critical observed/i)).toBeInTheDocument();
  });

  it('folds the secondary bands (autonomy #3, connectors, volume, full timing) into Deeper analytics', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // Folded away by default.
    expect(screen.queryByRole('region', { name: /Autonomous vs human/i })).toBeNull();
    expect(screen.queryByRole('region', { name: /Connector health/i })).toBeNull();
    // Expand.
    const deeper = await screen.findByRole('button', { name: /Deeper analytics/i });
    await userEvent.click(deeper);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /Autonomous vs human/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/never influences that/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Connector health/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Case volume/i })).toBeInTheDocument();
    // The full response-timing (MTTA/MTTR p50) lives here, not on the default view.
    expect(screen.getAllByText('45m').length).toBeGreaterThan(0); // MTTA p50
    expect(screen.getAllByText('3h').length).toBeGreaterThan(0); // MTTR p50 (180m)
    // LLM spend is the quiet runaway tripwire inside the fold.
    expect(screen.getByTestId('kpi-llm-spend-detail')).toBeInTheDocument();
  });

  it('the loading skeleton mirrors the dense layout: KPI · hero · noise · zone-C · fold', () => {
    listCasesMock.mockReturnValue(new Promise(() => {}));
    getMetricsMock.mockReturnValue(new Promise(() => {}));
    usageMock.mockReturnValue(new Promise(() => {}));
    fetchPostureMock.mockReturnValue(new Promise(() => {}));
    render(<Overview onNavigate={vi.fn()} />);
    const loading = screen.getByLabelText('Loading dashboard');
    expect(loading).toBeInTheDocument();
    expect(screen.getByTestId('kpi-strip-skeleton').children).toHaveLength(5);
    expect(screen.getByTestId('hero-skeleton-row').children).toHaveLength(3);
    expect(screen.getByTestId('noise-skeleton-row')).toBeInTheDocument();
    expect(screen.getByTestId('zonec-skeleton-row').children).toHaveLength(3);
    expect(screen.getByTestId('deeper-analytics-skeleton')).toBeInTheDocument();
  });
});
