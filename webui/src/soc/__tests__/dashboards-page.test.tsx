/**
 * `Dashboards` page smoke test (Round 5 / G7) — the read-only, per-role DEFAULT lands
 * calmly (#10) and ships ZERO grid JS on first render (react-grid-layout's module
 * factory is never evaluated in the default view).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

// Prove no RGL import on the default page render.
const rglEvaluated = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-grid-layout', () => {
  rglEvaluated.count += 1;
  const React = require('react');
  return {
    GridLayout: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    useContainerWidth: () => ({ width: 1200, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});
vi.mock('react-grid-layout/css/styles.css', () => ({}));
vi.mock('react-resizable/css/styles.css', () => ({}));

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
  auth: { me: vi.fn() },
  roles: { get: vi.fn() },
  dashboards: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), clone: vi.fn() },
}));
vi.mock('@/lib/api', () => ({ api: apiMocks }));

import { AuthProvider } from '@/soc/auth';
import { Dashboards } from '@/soc/pages/Dashboards';

beforeEach(() => {
  vi.clearAllMocks();
  rglEvaluated.count = 0;
  apiMocks.auth.me.mockResolvedValue({ authenticated: false, auth_enabled: false, user: null });
  apiMocks.roles.get.mockResolvedValue({ matrix: {}, rbac_enabled: false });
  // No saved dashboards → the read-only per-role DEFAULT is shown.
  apiMocks.dashboards.list.mockResolvedValue({ dashboards: [] });
  apiMocks.getMetrics.mockResolvedValue({ needs_human_cases: 1, open_cases: 2, cost: {} });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.standup.mockResolvedValue({ enabled: false });
  apiMocks.get.mockResolvedValue({ sources: [] });
  fetchPostureMock.mockResolvedValue({ window_hours: 168, lifecycle: {}, quality: {}, aging: {}, sla: {} });
  fetchMitreMock.mockResolvedValue({ by_tactic: {}, top_techniques: [] });
});

describe('Dashboards page', () => {
  it('uses the shared blocking state while saved layouts load', async () => {
    apiMocks.dashboards.list.mockReturnValue(new Promise(() => {}));

    render(
      <AuthProvider>
        <Dashboards />
      </AuthProvider>,
    );

    expect(
      await screen.findByRole('status', { name: 'Loading dashboards' }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByTestId('widget-grid-view')).toBeNull();
  });

  it('renders the read-only per-role default with zero grid JS', async () => {
    render(
      <AuthProvider>
        <Dashboards />
      </AuthProvider>,
    );

    // The page header + the default view render.
    expect(await screen.findByTestId('dashboards-header')).toBeInTheDocument();
    // The role-default widget set landed in VIEW mode (plain CSS grid, no RGL).
    await waitFor(() => expect(screen.getByTestId('widget-grid-view')).toBeInTheDocument());
    // A default-role widget resolves (needs-human is in every default set). The
    // provider settles one shared five-source batch; give a constrained native-Linux
    // runner the same bounded allowance as the dashboard accessibility acceptance.
    await waitFor(() => {
      expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Needs-human queue')).toBeInTheDocument();
    }, { timeout: 5000 });

    // THE lock: react-grid-layout was never evaluated on the default page render.
    expect(rglEvaluated.count).toBe(0);
  });
});
