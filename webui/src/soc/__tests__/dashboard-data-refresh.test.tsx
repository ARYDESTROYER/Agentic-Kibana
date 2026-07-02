/**
 * `DashboardDataProvider` refresh tests (Round-6 dashboards integration).
 *
 * The provider used to fetch each source EXACTLY once at mount and never again, so a
 * dashboard left open froze on its mount snapshot. This spec pins the two refresh paths
 * added without regressing the fetch-once-per-pass contract:
 *
 *   1. EXTERNAL reload signal (`reloadNonce`) — a host header control OUTSIDE the
 *      provider (which can't reach the context) bumps it to force a re-fetch.
 *   2. LIGHT auto-refresh (`refreshIntervalMs`) — re-fetches on a visible-tab interval,
 *      and PAUSES while the tab is hidden (no background chatter). Off by default, so a
 *      provider that opts out still fetches exactly once.
 *
 * Fully offline — only the data calls are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import * as React from 'react';

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
} from '@/soc/dashboard/DashboardDataProvider';

const METRICS = { needs_human_cases: 1, open_cases: 2, cost: {} };

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getMetrics.mockResolvedValue(METRICS);
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.get.mockResolvedValue({ sources: [] });
  fetchPostureMock.mockResolvedValue({ window_hours: 168, lifecycle: {}, quality: {}, aging: {}, sla: {} });
  fetchMitreMock.mockResolvedValue({ by_tactic: {}, top_techniques: [] });
});

function MetricsConsumer({ testid }: { testid: string }) {
  const { loading, data } = useDashboardSource('metrics');
  return (
    <div data-testid={testid}>
      {loading ? 'loading' : `needs=${data ? (data as typeof METRICS).needs_human_cases : 'na'}`}
    </div>
  );
}

describe('DashboardDataProvider — external reloadNonce refresh', () => {
  it('re-fetches every active source when `reloadNonce` is bumped', async () => {
    function Harness() {
      const [nonce, setNonce] = React.useState(0);
      return (
        <div>
          <button data-testid="bump" onClick={() => setNonce((n) => n + 1)}>
            refresh
          </button>
          <DashboardDataProvider sourceKeys={['metrics']} reloadNonce={nonce}>
            <MetricsConsumer testid="c" />
          </DashboardDataProvider>
        </div>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('c')).toHaveTextContent('needs=1'));
    // One fetch at mount.
    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1);

    // Bumping the external signal forces a fresh fetch.
    fireEvent.click(screen.getByTestId('bump'));
    await waitFor(() => expect(apiMocks.getMetrics).toHaveBeenCalledTimes(2));
  });

  it('does NOT re-fetch when reloadNonce holds steady (fetch-once preserved)', async () => {
    render(
      <DashboardDataProvider sourceKeys={['metrics']} reloadNonce={0}>
        <MetricsConsumer testid="c" />
      </DashboardDataProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('c')).toHaveTextContent('needs=1'));
    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardDataProvider — light auto-refresh interval', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-fetches on the interval while VISIBLE and PAUSES while the tab is hidden', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);

    render(
      <DashboardDataProvider sourceKeys={['metrics']} refreshIntervalMs={1000}>
        <MetricsConsumer testid="c" />
      </DashboardDataProvider>,
    );

    // Let the mount fetch settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1);

    // One interval tick while visible → a fresh fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(2);

    // Hide the tab → the next tick must NOT fetch (no background chatter).
    hidden.mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(2);
  });

  it('never installs an interval when refreshIntervalMs is 0 (opt-out)', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    render(
      <DashboardDataProvider sourceKeys={['metrics']} refreshIntervalMs={0}>
        <MetricsConsumer testid="c" />
      </DashboardDataProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // Still exactly one — no interval was installed.
    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1);
  });
});
