/**
 * DashboardBuilder chrome tests (Round-6 shell-chrome batch) — the reset/rename/delete
 * + debounce-cancel fixes:
 *
 *   - Resetting the NEVER-persisted role default reverts LOCALLY (no DELETE → no 404
 *     error toast).
 *   - A server 404 on delete is tolerated as success (the copy is already gone).
 *   - A user-CREATED board shows "Delete dashboard" copy (permanent), not "Reset".
 *   - The dashboard NAME is editable in edit mode and persists on Save.
 *   - A trailing geometry settle is cancelled on Discard so it can't re-dirty the draft.
 *
 * WidgetGrid / data provider / gallery / config are mocked so the builder renders
 * synchronously with zero grid JS + zero network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

const gridHolder = vi.hoisted(() => ({ onLayoutChange: null as ((l: unknown[]) => void) | null }));

vi.mock('@/soc/dashboard/WidgetGrid', () => {
  const React = require('react');
  return {
    WidgetGrid: (props: { onLayoutChange?: (l: unknown[]) => void }) => {
      gridHolder.onLayoutChange = props.onLayoutChange ?? null;
      return React.createElement('div', { 'data-testid': 'widget-grid-mock' });
    },
  };
});
vi.mock('@/soc/dashboard/DashboardDataProvider', () => ({
  DashboardDataProvider: ({ children }: { children: React.ReactNode }) => children,
  DASHBOARD_AUTO_REFRESH_MS: 60_000,
}));
vi.mock('@/soc/dashboard/WidgetGallery', () => ({ WidgetGallery: () => null }));
vi.mock('@/soc/dashboard/WidgetConfigSheet', () => ({ WidgetConfigSheet: () => null }));
vi.mock('@/soc/components/Can', () => ({ Can: ({ children }: { children: React.ReactNode }) => children }));

const apiMocks = vi.hoisted(() => ({
  dashboards: { update: vi.fn(), remove: vi.fn(), create: vi.fn(), list: vi.fn(), clone: vi.fn() },
}));
vi.mock('@/lib/api', () => ({
  api: apiMocks,
  // Mirror the real client's `ApiError` (carries the HTTP status).
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { DashboardBuilder } from '@/soc/dashboard/DashboardBuilder';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';

function w(partial: Record<string, unknown>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

const BOARD: DashboardLayout = {
  id: 'overview',
  name: 'Overview',
  schema_version: 1,
  columns: 12,
  widgets: [w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} })],
};

beforeEach(() => {
  vi.clearAllMocks();
  gridHolder.onLayoutChange = null;
  apiMocks.dashboards.update.mockResolvedValue({ ...BOARD });
  apiMocks.dashboards.remove.mockResolvedValue({ ok: true, id: 'overview' });
});

async function enterEdit() {
  fireEvent.click(await screen.findByTestId('dashboard-edit-btn'));
  await screen.findByText('Save dashboard');
}

describe('DashboardBuilder — reset the never-persisted default (local, no DELETE)', () => {
  it('reverts locally without calling api.dashboards.remove (no spurious 404)', async () => {
    const onReset = vi.fn();
    render(<DashboardBuilder dashboard={BOARD} persisted={false} onReset={onReset} />);
    await enterEdit();

    fireEvent.click(screen.getByText('Reset to default layout'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));

    await waitFor(() => expect(onReset).toHaveBeenCalled());
    expect(apiMocks.dashboards.remove).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('DashboardBuilder — reset tolerates a server 404', () => {
  it('treats a 404 from remove() as success (copy already gone), no error toast', async () => {
    apiMocks.dashboards.remove.mockRejectedValueOnce(new ApiError(404, 'no dashboard overview'));
    const onReset = vi.fn();
    render(<DashboardBuilder dashboard={BOARD} persisted onReset={onReset} />);
    await enterEdit();

    fireEvent.click(screen.getByText('Reset to default layout'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));

    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('overview'));
    await waitFor(() => expect(onReset).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('DashboardBuilder — user-created board deletes (accurate copy)', () => {
  it('shows "Delete dashboard" + a permanent-delete confirm, then removes', async () => {
    const board: DashboardLayout = { ...BOARD, id: 'dash-1', name: 'My board' };
    apiMocks.dashboards.remove.mockResolvedValue({ ok: true, id: 'dash-1' });
    const onReset = vi.fn();
    render(<DashboardBuilder dashboard={board} isDefaultBoard={false} persisted onReset={onReset} />);
    await enterEdit();

    // The destructive control reads "Delete dashboard", not "Reset to default layout".
    expect(screen.getByText('Delete dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Reset to default layout')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Delete dashboard'));
    expect(await screen.findByText('Delete this dashboard?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete dashboard' }));

    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('dash-1'));
    await waitFor(() => expect(onReset).toHaveBeenCalled());
  });
});

describe('DashboardBuilder — rename', () => {
  it('edits the dashboard name and persists it on Save', async () => {
    render(<DashboardBuilder dashboard={BOARD} />);
    await enterEdit();

    const nameInput = screen.getByTestId('dashboard-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('Overview');
    fireEvent.change(nameInput, { target: { value: 'My Ops Board' } });

    fireEvent.click(screen.getByText('Save dashboard'));

    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    const [, layout] = apiMocks.dashboards.update.mock.calls[0];
    expect(layout.name).toBe('My Ops Board');
  });
});

describe('DashboardBuilder — trailing geometry settle is cancelled on Discard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a pending layout settle does not re-dirty the draft after Discard', async () => {
    render(<DashboardBuilder dashboard={BOARD} />);
    // Enter edit (fake timers → drive clicks directly).
    fireEvent.click(screen.getByTestId('dashboard-edit-btn'));
    expect(screen.getByText('Save dashboard')).toBeInTheDocument();

    // Schedule a debounced geometry settle that would move widget 'a'.
    act(() => {
      gridHolder.onLayoutChange?.([{ i: 'a', x: 6, y: 6, w: 4, h: 4 }]);
    });
    // Discard BEFORE the 200ms settle fires.
    fireEvent.click(screen.getByText('Discard'));
    // Let the (now-cancelled) timer window elapse.
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Re-enter edit: the draft must be CLEAN (the settle never re-applied post-discard).
    fireEvent.click(screen.getByTestId('dashboard-edit-btn'));
    // Scope to the VISIBLE sticky bar (role=region "Unsaved changes"): the StickySaveBar
    // also mirrors its message into a sr-only aria-live region, so an unscoped getByText
    // would match twice. The clean-draft state shows the "Editing …" hint, not "unsaved".
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(
      within(bar).getByText('Editing — drag, resize, add or remove widgets.'),
    ).toBeInTheDocument();
    expect(
      within(bar).queryByText('You have unsaved dashboard changes.'),
    ).not.toBeInTheDocument();
  });
});
