/**
 * Bulk "Add tag" / "Assign" are STATUS-NEUTRAL (round-6 cases-page findings #1/#8).
 *
 * The old wiring posted action:'acknowledge' (tag) and action:'escalate' (assign)
 * through /cases/bulk, which silently moved open cases to INVESTIGATING/ESCALATED
 * (distorting SLA/MTTA) and 400-ed closed/resolved cases ("illegal transition"). This
 * asserts both affordances now route through the dedicated status-neutral endpoints —
 * api.caseTags (POST /cases/{id}/tags) and api.caseAssign (POST /cases/{id}/assign) —
 * once per selected case, and NEVER through the lifecycle bulk endpoint. The api client
 * is fully mocked (offline).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { bulkMock, listCasesMock, caseTagsMock, caseAssignMock } = vi.hoisted(() => ({
  bulkMock: vi.fn(),
  listCasesMock: vi.fn(),
  caseTagsMock: vi.fn(),
  caseAssignMock: vi.fn(),
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
      cases: { bulk: bulkMock },
      caseTags: caseTagsMock,
      caseAssign: caseAssignMock,
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Cases from '../pages/Cases';

// One OPEN case (with an existing tag, to prove merge) + one CLOSED case (which the old
// acknowledge/escalate path would have 400-ed).
const CASES = [
  { case_id: 'case-001', case_number: 'TLSOC-001', title: 'Alpha', status: 'open', updated_at: '2026-06-29T00:00:00Z', tags: ['existing'], comments: [] },
  { case_id: 'case-002', case_number: 'TLSOC-002', title: 'Bravo', status: 'closed', updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
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

async function selectAll() {
  renderCases();
  await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText('Select all rows'));
  return screen.findByRole('region', { name: /bulk actions/i });
}

describe('Bulk tag / assign are status-neutral (round-6 #1/#8)', () => {
  beforeEach(() => {
    bulkMock.mockReset().mockResolvedValue({ results: [] });
    caseTagsMock.mockReset().mockResolvedValue({});
    caseAssignMock.mockReset().mockResolvedValue({});
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
  });

  it('bulk "Add tag" posts to /cases/{id}/tags (merged), never bulk acknowledge', async () => {
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: /add tag/i }));
    const input = await screen.findByLabelText('Tag to add to selected cases');
    fireEvent.change(input, { target: { value: 'phishing' } });
    fireEvent.click(screen.getByRole('button', { name: /^tag 2$/i }));

    await waitFor(() => expect(caseTagsMock).toHaveBeenCalledTimes(2));
    // Merges with the case's existing tags (open case had ['existing']).
    expect(caseTagsMock).toHaveBeenCalledWith('case-001', ['existing', 'phishing']);
    expect(caseTagsMock).toHaveBeenCalledWith('case-002', ['phishing']);
    // Never the lifecycle bulk path (no acknowledge → no status move).
    expect(bulkMock).not.toHaveBeenCalled();
  });

  it('bulk "Assign" posts to /cases/{id}/assign, never bulk escalate', async () => {
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: /^assign$/i }));
    const input = await screen.findByLabelText('Owner for bulk assignment');
    fireEvent.change(input, { target: { value: 'ana' } });
    fireEvent.click(screen.getByRole('button', { name: /^assign 2$/i }));

    await waitFor(() => expect(caseAssignMock).toHaveBeenCalledTimes(2));
    expect(caseAssignMock).toHaveBeenCalledWith('case-001', 'ana');
    expect(caseAssignMock).toHaveBeenCalledWith('case-002', 'ana');
    // Never the lifecycle bulk path (no escalate → no status move).
    expect(bulkMock).not.toHaveBeenCalled();
  });
});
