/**
 * Overview (Security Command Center) — Round-7 W1.A render test.
 *
 * Pins the load-bearing command-center contract:
 *   1. the PLAIN header (Round-8 #7) is present + addressable via `data-testid="page-hero"`,
 *      carries NO hero card chrome, and shows the `PAGE_TITLE`;
 *   2. the un-nested KPI STRIP is TRIMMED to 5 alert/case tiles (Open / Critical-High /
 *      Escalated / False-Positive-Rate / Auto-Resolved); the old Artifacts / Knowledge /
 *      Total tiles are GONE and LLM spend is DEMOTED off the hero (Round-8 Task 4);
 *   3. the timing trio reads the SERVER posture (`usePosture` → `fetchPosture`), honouring
 *      the honest DASH for an unavailable block (never a fabricated client value);
 *   4. KPI deltas are wired from the server `posture.compare` block, stated once under the
 *      strip;
 *   5. tiles deep-link to the filtered case list carrying the window;
 *   6. the loading skeleton mirrors the final layout (5 KPI tiles + a reserved funnel row).
 *
 * Fully offline — the page uses no auth; only the data calls + the posture fetch are
 * mocked. `noiseReduction` is intentionally omitted from the base mock so the funnel band
 * self-omits (the command-center test covers the funnel-present path).
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
    // Unavailable → the timing trio must show the honest reason, never a fake number.
    dwell_minutes: {
      p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false,
      reason: 'no case has received a first response yet',
    },
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

describe('Overview — Security Command Center (W1.A)', () => {
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
    // #7: the header is now plain/dense (like the Sources page) — NO hero card wash.
    expect(hero).not.toHaveClass('hero-display');
    expect(hero).not.toHaveClass('bg-card');
    // Exactly one page-level h1 (the title) lives in the header.
    expect(hero.querySelectorAll('h1')).toHaveLength(1);
    expect(hero).toHaveTextContent(PAGE_TITLE);
    // The eyebrow must NOT restate the title (breadcrumb/eyebrow ≠ title).
    expect(hero.textContent).not.toContain(`${PAGE_TITLE}${PAGE_TITLE}`);
  });

  it('renders the TRIMMED KPI strip: 5 alert/case tiles (LLM spend demoted off the hero)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-open-cases')).toBeInTheDocument());
    // The trimmed, alert/case-centric set (Round-8 Task 4).
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
    // EXACTLY 5 hero tiles now.
    expect(strip.querySelectorAll('[data-testid^="kpi-"]')).toHaveLength(5);
    // LLM spend was DEMOTED off the hero (Task 4) — no longer a strip tile.
    expect(within(strip).queryByTestId('kpi-llm-spend')).toBeNull();
    // The older demoted tiles are GONE.
    expect(screen.queryByTestId('kpi-artifacts-in-scope')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-knowledge-signals')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-total-cases')).not.toBeInTheDocument();
    // Open cases = the 1 open-status case in the sample (rolled via CountUp).
    expect(within(screen.getByTestId('kpi-open-cases')).getByText('1')).toBeInTheDocument();
    // False-positive rate reads the server quality rate (0.5 → "50%").
    expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('50%')).toBeInTheDocument();
    // Auto-resolved reads the server quality count (auto_closed_cases = 1).
    expect(within(screen.getByTestId('kpi-auto-resolved')).getByText('1')).toBeInTheDocument();
  });

  it('reads timing from the SERVER posture (no client math), honoring the unavailable DASH', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // Task 3: the Response-timing row (MTTA/MTTR/Dwell + an honest MTTD n/a) is now on the
    // MAIN dashboard — NOT hidden in the collapsed "Deeper analytics" fold. No expand needed.
    expect(screen.getByRole('region', { name: /Response timing/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('45m').length).toBeGreaterThan(0)); // MTTA p50
    expect(screen.getAllByText('3h').length).toBeGreaterThan(0); // MTTR p50 (180m)
    // Dwell is unavailable → the honest server reason, never a fabricated number.
    expect(
      screen.getAllByText(/no case has received a first response yet/i).length,
    ).toBeGreaterThan(0);
    // MTTD is shown as an explicit n/a (not measured), never invented.
    expect(screen.getByText(/not measured/i)).toBeInTheDocument();
    expect(fetchPostureMock).toHaveBeenCalled();
    // The posture fetch requests the period-over-period compare block.
    expect(fetchPostureMock).toHaveBeenCalledWith(expect.any(Number), 'prev');
  });

  it('attaches a delta ONLY to a unit-matched tile (FP-rate), never to the count tiles', async () => {
    fetchPostureMock.mockResolvedValue(POSTURE_CMP);
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // The False-Positive-RATE tile is unit-matched to `compare.false_positive_rate` (a
    // rate → a rate), so it carries the "-16.7%" delta chip.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('kpi-false-positive-rate')).getByText('-16.7%'),
      ).toBeInTheDocument(),
    );
    // The COUNT tiles must NOT borrow a rate/total delta (a unit mismatch whose
    // arrow/colour/number could contradict the shown count). A KpiTile delta renders as
    // the ONLY role="img" element in the tile, so its absence proves no delta is drawn —
    // Open Cases (count vs `case_count` TOTAL), Escalated (count vs `escalation_rate`),
    // Auto-Resolved (count vs `automation_rate`).
    expect(within(screen.getByTestId('kpi-open-cases')).queryByRole('img')).toBeNull();
    expect(within(screen.getByTestId('kpi-escalated-to-human')).queryByRole('img')).toBeNull();
    expect(within(screen.getByTestId('kpi-auto-resolved')).queryByRole('img')).toBeNull();
    // The mismatched raw deltas are nowhere in the strip.
    const strip = screen.getByTestId('kpi-strip');
    expect(within(strip).queryByText('-20%')).toBeNull(); // escalation_rate
    expect(within(strip).queryByText('+25%')).toBeNull(); // automation_rate
    expect(within(strip).queryByText('-25%')).toBeNull(); // case_count
    // The comparison window is stated ONCE under the strip (not per tile).
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

  it('window-scopes the case sample by created-at so case widgets honour the range (#37)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
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

  it('deep-links an open-by-severity row to that severity band, carrying the window (#38)', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const highRow = await screen.findByRole('button', { name: /view High severity cases/i });
    await userEvent.click(highRow);
    expect(onNavigate).toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ severity: 'high', window: expect.any(Number) }),
    );
  });

  // Round-7 W2.c — the severity widget's `bandOf` now folds onto the ONE severity
  // authority (badges.ts severityBandFromNumber, the 74/48/22/8 ladder) instead of its
  // old private 80/60/35/15 cuts. This LOCKS the unification: a risk_score of 76 must
  // band CRITICAL (it read HIGH under the old 80-cut), while 88/65/20 keep classifying
  // critical/high/low (both ladders agree on those). If the widget ever drifts back to
  // the 80-cut, `Critical` would drop to 1 and `High` rise to 2 and this test fails.
  it('bands a risk_score of 76 as CRITICAL on the severity widget (W2.c unification)', async () => {
    listCasesMock.mockResolvedValue({
      cases: [
        { case_id: 'u1', status: 'open', risk_score: 88 }, // critical (both ladders agree)
        { case_id: 'u2', status: 'open', risk_score: 76 }, // critical NOW (was high @ 80-cut)
        { case_id: 'u3', status: 'open', risk_score: 65 }, // high (both ladders agree)
        { case_id: 'u4', status: 'open', risk_score: 20 }, // low (both ladders agree)
      ] as unknown as Case[],
      total: 4,
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const criticalRow = await screen.findByRole('button', { name: /view Critical severity cases/i });
    const highRow = screen.getByRole('button', { name: /view High severity cases/i });
    const lowRow = screen.getByRole('button', { name: /view Low severity cases/i });
    // 88 + 76 BOTH land in Critical (only 65 in High, only 20 in Low). Under the old
    // 80-cut, 76 would have fallen into High (Critical=1 / High=2) — asserting the new
    // 74-cut here is what locks the deferred ladder unification.
    await waitFor(() => expect(within(criticalRow).getByText('2')).toBeInTheDocument());
    expect(within(highRow).getByText('1')).toBeInTheDocument();
    expect(within(lowRow).getByText('1')).toBeInTheDocument();
  });

  // Round-7 QA (severity drill regression) — the Cases severity FILTER now prefers the
  // source-asserted `severity_band`, so the Overview severity widget must bucket by the
  // SAME preference (severity_band, else the risk band). Otherwise a source_asserted case
  // counts under its risk band here but filters under its asserted band in Cases, and the
  // drilled list can never reconcile with the widget's count.
  it('buckets a source_asserted case by severity_band, not the risk band (drill reconcile)', async () => {
    listCasesMock.mockResolvedValue({
      cases: [
        // risk_score 20 would band LOW, but the source asserts CRITICAL → must count Critical.
        {
          case_id: 's1', status: 'open',
          severity_band: 'critical', severity_source: 'source_asserted', risk_score: 20,
        },
        { case_id: 's2', status: 'open', risk_score: 65 }, // high (no severity_band → risk band)
      ] as unknown as Case[],
      total: 2,
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const criticalRow = await screen.findByRole('button', { name: /view Critical severity cases/i });
    const highRow = screen.getByRole('button', { name: /view High severity cases/i });
    const lowRow = screen.getByRole('button', { name: /view Low severity cases/i });
    // The asserted-critical case lands in Critical (NOT Low, where its risk_score 20 sits).
    await waitFor(() => expect(within(criticalRow).getByText('1')).toBeInTheDocument());
    expect(within(highRow).getByText('1')).toBeInTheDocument();
    expect(within(lowRow).getByText('0')).toBeInTheDocument();
  });

  it('leads with a DENSE default dashboard: the primary bands render without expanding a fold', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // Task 4: the most-useful panels are PULLED UP onto the default view — no expand needed.
    for (const name of [
      /Response timing/i,
      /Attention queue/i,
      /Open cases by severity/i,
      /Case outcomes/i,
      /Top signatures/i,
      /Top entities/i,
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    // The secondary bands stay folded until "Deeper analytics" is opened.
    expect(screen.queryByRole('region', { name: /Autonomous vs human/i })).toBeNull();
    expect(screen.queryByRole('region', { name: /Connector health/i })).toBeNull();
    expect(screen.queryByRole('region', { name: /Case volume/i })).toBeNull();
  });

  it('folds the secondary bands (autonomy #3, connectors, volume, workload) into Deeper analytics', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const deeper = await screen.findByRole('button', { name: /Deeper analytics/i });
    await userEvent.click(deeper);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /Autonomous vs human/i })).toBeInTheDocument(),
    );
    // The #3 trust-surface advisory copy is preserved.
    expect(screen.getByText(/never influences that/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Connector health/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Case volume/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Case workload state/i })).toBeInTheDocument();
  });

  it('the loading skeleton mirrors the dense layout: KPI strip · timing row · noise · work row · fold', () => {
    // Never-resolving data calls → the page stays in its loading skeleton.
    listCasesMock.mockReturnValue(new Promise(() => {}));
    getMetricsMock.mockReturnValue(new Promise(() => {}));
    usageMock.mockReturnValue(new Promise(() => {}));
    fetchPostureMock.mockReturnValue(new Promise(() => {}));
    render(<Overview onNavigate={vi.fn()} />);
    const loading = screen.getByLabelText('Loading dashboard');
    expect(loading).toBeInTheDocument();
    // 5 KPI skeleton tiles in the same responsive grid as the real strip.
    expect(screen.getByTestId('kpi-strip-skeleton').children).toHaveLength(5);
    // The Response-timing row is now on the MAIN dashboard → 4 reserved tiles.
    expect(screen.getByTestId('timing-skeleton-row').children).toHaveLength(4);
    // A reserved full-width band for the Noise-Reduction ribbon.
    expect(screen.getByTestId('noise-skeleton-row')).toBeInTheDocument();
    // The work+mix row (attention queue · severity · verdict mix) → 3 reserved cells.
    expect(screen.getByTestId('work-skeleton-row').children).toHaveLength(3);
    // The remaining secondary bands stay folded under "Deeper analytics".
    expect(screen.getByTestId('deeper-analytics-skeleton')).toBeInTheDocument();
  });
});
