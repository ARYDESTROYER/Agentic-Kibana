/**
 * `DashboardBuilder` tests (Round 5 / G7, CD4) — the 5-step builder loop.
 *
 * The load-bearing assertions:
 *   1. READ-ONLY by default — the grid is in view mode; an explicit "Edit dashboard"
 *      CTA enters edit mode (with the sticky Save/Discard bar).
 *   2. SAVE calls `api.dashboards.update(id, layout)` with the edited widget list — the
 *      persistence contract (a layout is advisory; it NEVER feeds `decide()`, #3).
 *   3. RESET-to-default deletes the saved copy via `api.dashboards.remove`.
 *
 * Auth is mocked OFF (transparent `<Can>`), the RGL edit surface is mocked, and the
 * widget-body data calls are mocked offline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Mock the RGL edit surface so edit mode renders synchronously without a real grid.
vi.mock('@/soc/dashboard/EditableGrid', () => {
  const React = require('react');
  return {
    default: ({
      widgets,
      renderItem,
    }: {
      widgets: unknown[];
      renderItem: (w: unknown) => React.ReactNode;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'editable-grid' },
        widgets.map((w, i) => React.createElement('div', { key: i }, renderItem(w))),
      ),
  };
});

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
  dashboards: {
    update: vi.fn(),
    remove: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    clone: vi.fn(),
  },
}));
vi.mock('@/lib/api', () => ({ api: apiMocks }));

import { AuthProvider } from '@/soc/auth';
import { DashboardBuilder } from '@/soc/dashboard/DashboardBuilder';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';

function w(partial: Record<string, unknown>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

const DASHBOARD: DashboardLayout = {
  id: 'overview',
  name: 'Overview',
  schema_version: 1,
  columns: 12,
  widgets: [w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} })],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Auth OFF → hasPermission() === true (transparent <Can>).
  apiMocks.auth.me.mockResolvedValue({ authenticated: false, auth_enabled: false, user: null });
  apiMocks.roles.get.mockResolvedValue({ matrix: {}, rbac_enabled: false });
  apiMocks.getMetrics.mockResolvedValue({ needs_human_cases: 1, open_cases: 2, cost: {} });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.standup.mockResolvedValue({ enabled: false });
  apiMocks.get.mockResolvedValue({ sources: [] });
  fetchPostureMock.mockResolvedValue({ window_hours: 168, lifecycle: {}, quality: {}, aging: {}, sla: {} });
  fetchMitreMock.mockResolvedValue({ by_tactic: {}, top_techniques: [] });
  apiMocks.dashboards.update.mockResolvedValue({ ...DASHBOARD });
  apiMocks.dashboards.remove.mockResolvedValue({ ok: true, id: 'overview' });
});

function renderBuilder(props: Partial<React.ComponentProps<typeof DashboardBuilder>> = {}) {
  return render(
    <AuthProvider>
      <DashboardBuilder dashboard={DASHBOARD} {...props} />
    </AuthProvider>,
  );
}

describe('DashboardBuilder — read-only default → explicit edit', () => {
  it('starts read-only with an Edit CTA, then enters edit mode', async () => {
    renderBuilder();
    // Read-only default: the edit button is present; the sticky save bar is not.
    const editBtn = await screen.findByTestId('dashboard-edit-btn');
    expect(editBtn).toBeInTheDocument();
    expect(screen.queryByText('Save dashboard')).not.toBeInTheDocument();

    fireEvent.click(editBtn);
    // Edit mode: the sticky save bar + Add-widget + the mocked RGL surface appear.
    expect(await screen.findByText('Save dashboard')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add widget/i })).toBeInTheDocument();
    expect(await screen.findByTestId('editable-grid')).toBeInTheDocument();
  });
});

describe('DashboardBuilder — persistence (#3: layout is advisory, never decide())', () => {
  it('SAVE calls api.dashboards.update with the dashboard id + widgets', async () => {
    const onSaved = vi.fn();
    renderBuilder({ onSaved });
    fireEvent.click(await screen.findByTestId('dashboard-edit-btn'));

    fireEvent.click(await screen.findByText('Save dashboard'));

    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    const [id, layout] = apiMocks.dashboards.update.mock.calls[0];
    expect(id).toBe('overview');
    expect(layout.id).toBe('overview');
    expect(Array.isArray(layout.widgets)).toBe(true);
    expect(layout.widgets[0].type).toBe('kpi.needs_human');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('RESET-to-default removes the saved copy via api.dashboards.remove', async () => {
    const onReset = vi.fn();
    renderBuilder({ onReset });
    fireEvent.click(await screen.findByTestId('dashboard-edit-btn'));

    fireEvent.click(await screen.findByText('Reset to default layout'));
    // Confirm in the destructive dialog.
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));

    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('overview'));
    await waitFor(() => expect(onReset).toHaveBeenCalled());
  });
});

describe('DashboardBuilder — #6/#7: the dashboards view bills ZERO LLM calls (H3)', () => {
  it('NEVER calls api.standup, and fetches ONLY the sources the placed widgets read', async () => {
    // The fixture has one `kpi.needs_human` widget → it reads only the `metrics` source.
    renderBuilder();
    // Let the (narrowed) provider settle its single fetch batch.
    await waitFor(() => expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1));

    // The billing standup call is never made (it isn't even in the source table now).
    expect(apiMocks.standup).not.toHaveBeenCalled();
    // And only the metrics source the widget declares is fetched — no fan-out to
    // posture/mitre/cases/sources-health that no placed widget consumes.
    expect(fetchPostureMock).not.toHaveBeenCalled();
    expect(fetchMitreMock).not.toHaveBeenCalled();
    expect(apiMocks.listCases).not.toHaveBeenCalled();
    expect(apiMocks.get).not.toHaveBeenCalledWith('sources/health');
  });

  it('an EMPTY dashboard fetches NOTHING (zero round-trips, zero UsageDoc)', async () => {
    const empty: DashboardLayout = { ...DASHBOARD, widgets: [] };
    render(
      <AuthProvider>
        <DashboardBuilder dashboard={empty} />
      </AuthProvider>,
    );
    // Give any (erroneous) fetch a chance to fire.
    await screen.findByTestId('dashboard-edit-btn');
    expect(apiMocks.standup).not.toHaveBeenCalled();
    expect(apiMocks.getMetrics).not.toHaveBeenCalled();
    expect(fetchPostureMock).not.toHaveBeenCalled();
    expect(fetchMitreMock).not.toHaveBeenCalled();
    expect(apiMocks.listCases).not.toHaveBeenCalled();
    expect(apiMocks.get).not.toHaveBeenCalledWith('sources/health');
  });
});
