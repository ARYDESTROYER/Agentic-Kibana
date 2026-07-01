/**
 * `DashboardDataProvider` tests (Round 5 / G7, CD2).
 *
 * The provider's whole reason for existing is to fetch each shared data source
 * EXACTLY ONCE and hand the result to every widget — the read-only-default acceptance
 * bar (no per-widget round-trips). These specs assert:
 *   1. FETCH-ONCE: N consumers reading the same source ⇒ ONE api call per source.
 *   2. SHARING: every consumer sees the shared payload.
 *   3. SUBSET: passing `sourceKeys` fetches only those sources.
 *   4. SENTINEL: `statNumber` never returns the DASH sentinel as a number.
 *
 * Fully offline — only the data calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { fetchPostureMock, fetchMitreMock } = vi.hoisted(() => ({
  fetchPostureMock: vi.fn(),
  fetchMitreMock: vi.fn(),
}));

vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock, fetchMitreCoverage: fetchMitreMock };
});

const apiMocks = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  listCases: vi.fn(),
  standup: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMocks }));

import {
  DashboardDataProvider,
  useDashboardSource,
  statNumber,
  isAvailable,
  type DashboardSourceKey,
} from '@/soc/dashboard/DashboardDataProvider';

const METRICS = {
  total_cases: 5,
  open_cases: 2,
  needs_human_cases: 1,
  closed_cases: 3,
  by_status: {},
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 3, NEEDS_HUMAN: 1, none: 0 },
  persona_usage: {},
  playbook_usage: {},
  avg_risk_score: 33,
  mttr_minutes: 60,
  resolved_count: 3,
  cases_per_day: [],
  feedback: {},
  cost: { total_cost: 1.23, currency: 'USD', call_count: 7 },
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getMetrics.mockResolvedValue(METRICS);
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.standup.mockResolvedValue({ enabled: false });
  apiMocks.get.mockResolvedValue({ sources: [] });
  fetchPostureMock.mockResolvedValue({
    window_hours: 168,
    generated_at: '',
    case_count: 5,
    lifecycle: {},
    quality: {},
    aging: {},
    sla: { enabled: false },
  });
  fetchMitreMock.mockResolvedValue({
    corpus_version: 'x',
    total_techniques: 0,
    covered_techniques: 0,
    coverage_pct: 0,
    invalid_dropped: 0,
    by_tactic: {},
    top_techniques: [],
    window_hours: 0,
  });
});

/** A tiny consumer that reads a source and prints its needs_human value once ready. */
function MetricsConsumer({ testid }: { testid: string }) {
  const { loading, data } = useDashboardSource('metrics');
  return (
    <div data-testid={testid}>
      {loading ? 'loading' : `needs=${data ? (data as typeof METRICS).needs_human_cases : 'na'}`}
    </div>
  );
}

describe('DashboardDataProvider — fetch once, share to all', () => {
  it('fetches EACH source exactly once even with many consumers of the same source', async () => {
    render(
      <DashboardDataProvider windowHours={168}>
        <MetricsConsumer testid="c1" />
        <MetricsConsumer testid="c2" />
        <MetricsConsumer testid="c3" />
        <MetricsConsumer testid="c4" />
      </DashboardDataProvider>,
    );

    // Every consumer resolves to the SHARED payload.
    await waitFor(() => {
      expect(screen.getByTestId('c1')).toHaveTextContent('needs=1');
    });
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      expect(screen.getByTestId(id)).toHaveTextContent('needs=1');
    }

    // FOUR consumers of `metrics` ⇒ still exactly ONE getMetrics call (no fan-out).
    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1);
    // Each OTHER declared source is also fetched exactly once.
    expect(fetchPostureMock).toHaveBeenCalledTimes(1);
    expect(fetchMitreMock).toHaveBeenCalledTimes(1);
    expect(apiMocks.listCases).toHaveBeenCalledTimes(1);
    expect(apiMocks.standup).toHaveBeenCalledTimes(1);
    // sources/health goes through the low-level api.get once.
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
    expect(apiMocks.get).toHaveBeenCalledWith('sources/health');
  });

  it('fetches ONLY the requested subset of sources', async () => {
    const only: DashboardSourceKey[] = ['metrics'];
    render(
      <DashboardDataProvider sourceKeys={only}>
        <MetricsConsumer testid="c" />
      </DashboardDataProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('c')).toHaveTextContent('needs=1'));

    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1);
    // None of the other sources were touched.
    expect(fetchPostureMock).not.toHaveBeenCalled();
    expect(fetchMitreMock).not.toHaveBeenCalled();
    expect(apiMocks.listCases).not.toHaveBeenCalled();
    expect(apiMocks.standup).not.toHaveBeenCalled();
    expect(apiMocks.get).not.toHaveBeenCalled();
  });

  it('one failing source never blocks its peers', async () => {
    apiMocks.getMetrics.mockRejectedValueOnce(new Error('boom'));
    render(
      <DashboardDataProvider>
        <MetricsConsumer testid="c" />
      </DashboardDataProvider>,
    );
    // The metrics consumer resolves (to na — errored, no data) rather than hanging,
    // and the sibling sources still fetched.
    await waitFor(() => expect(screen.getByTestId('c')).toHaveTextContent('needs=na'));
    expect(fetchPostureMock).toHaveBeenCalledTimes(1);
    expect(apiMocks.listCases).toHaveBeenCalledTimes(1);
  });
});

describe('sentinel helpers — never treat DASH as a number', () => {
  it('statNumber returns a number for real values and null for the DASH sentinel', () => {
    expect(statNumber(42)).toBe(42);
    expect(statNumber(0)).toBe(0);
    expect(statNumber('12.5')).toBe(12.5);
    expect(statNumber('—')).toBeNull(); // the backend DASH glyph
    expect(statNumber(null)).toBeNull();
    expect(statNumber(undefined)).toBeNull();
    expect(statNumber(Number.NaN)).toBeNull();
    expect(statNumber('not a number')).toBeNull();
  });

  it('isAvailable reflects the StatBlock.available flag', () => {
    expect(isAvailable({ available: true } as never)).toBe(true);
    expect(isAvailable({ available: false } as never)).toBe(false);
    expect(isAvailable(null)).toBe(false);
    expect(isAvailable(undefined)).toBe(false);
  });
});
