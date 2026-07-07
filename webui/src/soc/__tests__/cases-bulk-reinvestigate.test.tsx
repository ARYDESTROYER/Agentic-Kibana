/**
 * Bulk "Reinvestigate" (uifix Ask #4).
 *
 * The bulk Reinvestigate action loops the EXISTING single-case
 * POST /api/cases/{id}/reinvestigate over the current selection with a small
 * bounded-concurrency pool (REINVESTIGATE_CONCURRENCY = 3) — NOT a new backend bulk
 * route. It is gated behind a ConfirmDialog (it spends real LLM tokens per case, #6,
 * and re-runs decide() #3), reports partial failure without aborting the batch, and
 * drives ONE live-updating sonner progress toast (reused by id).
 *
 * These tests assert:
 *  1. the confirm gate fires BEFORE any call, then one call per selected case (no model
 *     arg — bulk never pins a model override);
 *  2. a partial failure doesn't abort the batch (warning toast + bulkError alert);
 *  3. the concurrency cap holds (only 3 in flight at once);
 *  4. reinvestigate NEVER routes through the lifecycle /cases/bulk endpoint (#3 boundary);
 *  5. the progress toast reuses ONE toast id (updates in place, not N stacked toasts).
 *
 * The api client is fully mocked (offline). Modeled on cases-bulk-tag-assign.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';

const {
  reinvestigateCaseMock,
  bulkMock,
  listCasesMock,
  toastLoading,
  toastSuccess,
  toastWarning,
  toastError,
} = vi.hoisted(() => ({
  reinvestigateCaseMock: vi.fn(),
  bulkMock: vi.fn(),
  listCasesMock: vi.fn(),
  toastLoading: vi.fn().mockReturnValue('toast-id-1'),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      getBranding: ok({
        org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '',
        accent_color: '', accent_color2: '', theme: '', login_subtitle: '',
      }),
      prefs: {
        effective: ok({
          terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [],
          tables: {}, last_list_state: {}, misc: {},
          org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] },
        }),
        putUser: ok({}),
      },
      views: { list: ok({ views: [], count: 0 }) },
      demo: { status: ok({ mode: 'off', active: false, run_id: null }) },
      listCases: listCasesMock,
      reinvestigateCase: reinvestigateCaseMock,
      cases: { bulk: bulkMock },
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    loading: toastLoading,
    success: toastSuccess,
    warning: toastWarning,
    error: toastError,
  },
  Toaster: () => null,
}));

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Cases from '../pages/Cases';

// One OPEN case + one CLOSED case — reinvestigate has no status guard (matches the
// single-case route), so both must be reinvestigated.
const CASES = [
  { case_id: 'case-001', case_number: 'TLSOC-001', title: 'Alpha', status: 'open', updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'case-002', case_number: 'TLSOC-002', title: 'Bravo', status: 'closed', updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
];

// Five cases for the concurrency-cap test.
const FIVE = [
  { case_id: 'case-001', case_number: 'TLSOC-001', title: 'Alpha', status: 'open', updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'case-002', case_number: 'TLSOC-002', title: 'Bravo', status: 'open', updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
  { case_id: 'case-003', case_number: 'TLSOC-003', title: 'Charlie', status: 'open', updated_at: '2026-06-29T02:00:00Z', tags: [], comments: [] },
  { case_id: 'case-004', case_number: 'TLSOC-004', title: 'Delta', status: 'open', updated_at: '2026-06-29T03:00:00Z', tags: [], comments: [] },
  { case_id: 'case-005', case_number: 'TLSOC-005', title: 'Echo', status: 'open', updated_at: '2026-06-29T04:00:00Z', tags: [], comments: [] },
];

function renderCases() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <Cases />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

/** Render, wait for rows, select all, and return the bulk-action bar region. */
async function selectAll() {
  renderCases();
  await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText('Select all rows'));
  return screen.findByRole('region', { name: /bulk actions/i });
}

/** Open the confirm gate from the bar and click through it. */
async function openBarAndConfirm(bar: HTMLElement) {
  fireEvent.click(within(bar).getByRole('button', { name: /reinvestigate/i }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^reinvestigate$/i }));
}

describe('Bulk reinvestigate (uifix #4)', () => {
  beforeEach(() => {
    reinvestigateCaseMock.mockReset().mockResolvedValue({});
    bulkMock.mockReset().mockResolvedValue({ results: [] });
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    toastLoading.mockReset().mockReturnValue('toast-id-1');
    toastSuccess.mockReset();
    toastWarning.mockReset();
    toastError.mockReset();
    window.localStorage.clear();
  });

  it('confirms first, then calls reinvestigateCase once per selected case (no model arg)', async () => {
    const bar = await selectAll();

    // Clicking the bar button opens the confirm gate — NO call yet.
    fireEvent.click(within(bar).getByRole('button', { name: /reinvestigate/i }));
    expect(await screen.findByText(/reinvestigate 2 cases\?/i)).toBeInTheDocument();
    expect(reinvestigateCaseMock).not.toHaveBeenCalled();
    expect(bulkMock).not.toHaveBeenCalled();

    // Confirm → one call per selected case.
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^reinvestigate$/i }));

    await waitFor(() => expect(reinvestigateCaseMock).toHaveBeenCalledTimes(2));
    // Called with ONLY the case id — bulk never pins a model override.
    expect(reinvestigateCaseMock).toHaveBeenCalledWith('case-001');
    expect(reinvestigateCaseMock).toHaveBeenCalledWith('case-002');
    for (const call of reinvestigateCaseMock.mock.calls) {
      expect(call).toHaveLength(1);
    }
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/2 cases reinvestigated/i),
        { id: 'toast-id-1' },
      ),
    );
  });

  it('reports partial failure without aborting the batch', async () => {
    reinvestigateCaseMock.mockImplementation((id: string) =>
      id === 'case-002'
        ? Promise.reject(new Error('This case has no stored evidence to reinvestigate.'))
        : Promise.resolve({}),
    );

    const bar = await selectAll();
    await openBarAndConfirm(bar);

    // BOTH cases were attempted — the failure of one does not stop the other.
    await waitFor(() => expect(reinvestigateCaseMock).toHaveBeenCalledTimes(2));
    expect(reinvestigateCaseMock).toHaveBeenCalledWith('case-001');
    expect(reinvestigateCaseMock).toHaveBeenCalledWith('case-002');

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        expect.stringMatching(/1 reinvestigated, 1 failed/i),
        { id: 'toast-id-1' },
      ),
    );
    // The bulkError alert surfaces the (deduped) reason.
    expect(
      await screen.findByText(/could not be reinvestigated/i),
    ).toBeInTheDocument();
    expect(bulkMock).not.toHaveBeenCalled();
  });

  it('respects the concurrency cap (only 3 in flight at once)', async () => {
    const resolvers: Array<() => void> = [];
    reinvestigateCaseMock.mockImplementation(
      () => new Promise<void>((resolve) => resolvers.push(() => resolve())),
    );
    listCasesMock.mockResolvedValue({ cases: FIVE, total: FIVE.length });

    const bar = await selectAll();
    await openBarAndConfirm(bar);

    // Only REINVESTIGATE_CONCURRENCY (3) workers start — not all 5 fired at once.
    await waitFor(() => expect(reinvestigateCaseMock).toHaveBeenCalledTimes(3));
    expect(reinvestigateCaseMock).toHaveBeenCalledTimes(3);

    // Freeing one slot starts exactly one more (the 4th), still bounded — not all 5.
    resolvers[0]();
    await waitFor(() => expect(reinvestigateCaseMock).toHaveBeenCalledTimes(4));
    expect(reinvestigateCaseMock).toHaveBeenCalledTimes(4);

    // Drain the rest so the batch finishes cleanly (no late act() warnings).
    await act(async () => {
      for (let i = 0; i < 50 && reinvestigateCaseMock.mock.calls.length < 5; i++) {
        resolvers.splice(0).forEach((r) => r());
        await Promise.resolve();
      }
      resolvers.splice(0).forEach((r) => r());
      await Promise.resolve();
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    // Never the lifecycle bulk path — reinvestigate must re-run decide() (#3).
    expect(bulkMock).not.toHaveBeenCalled();
  });

  it('never routes reinvestigate through the lifecycle /cases/bulk endpoint (#3)', async () => {
    const bar = await selectAll();
    await openBarAndConfirm(bar);
    await waitFor(() => expect(reinvestigateCaseMock).toHaveBeenCalledTimes(2));
    expect(bulkMock).not.toHaveBeenCalled();
  });

  it('drives ONE progress toast reused by id (updates in place, not N stacked)', async () => {
    const bar = await selectAll();
    await openBarAndConfirm(bar);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));

    // Called more than once: one to create + one per completed item to update.
    expect(toastLoading.mock.calls.length).toBeGreaterThan(1);
    const toastId = toastLoading.mock.results[0].value;
    expect(toastId).toBe('toast-id-1');
    // Every update after the first reuses the SAME toast id.
    for (const call of toastLoading.mock.calls.slice(1)) {
      expect(call[1]).toEqual({ id: toastId });
    }
    // The final success toast also targets that same toast (in place).
    expect(toastSuccess).toHaveBeenCalledWith(expect.any(String), { id: toastId });
  });
});
