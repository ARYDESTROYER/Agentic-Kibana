/**
 * Cases list — jest-axe accessibility smoke (Round-5 G9 · DESIGN_STANDARD §6).
 *
 * The all-day triage surface: a dense, sortable, multi-select DataTable inside the full
 * provider stack (theme · prefs · auth · demo · router). It is the highest-frequency
 * analyst view, so an unlabeled sort button / select-all checkbox / missing table
 * semantics here is the costliest regression. We render the real <Cases/> page with a
 * mocked-offline api, wait for two rows to load, and assert the tree has no axe
 * violations.
 *
 * Offline: every api call is stubbed; no network, no #3 / runtime behaviour touched.
 *
 * Click-to-open tables expose a dedicated named action button instead of making the
 * `<tr>` itself interactive. Keep the full axe ruleset enabled so nested-interactive,
 * button-name, labels, roles, table semantics, contrast, and live regions all remain
 * guarded on the highest-traffic surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { listCasesMock } = vi.hoisted(() => ({ listCasesMock: vi.fn() }));

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
      cases: { bulk: vi.fn().mockResolvedValue({ results: [] }) },
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

const CASES = [
  { case_id: 'case-001', case_number: 'TLSOC-001', title: 'Alpha', status: 'open', risk_score: 82, updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'case-002', case_number: 'TLSOC-002', title: 'Bravo', status: 'needs_human', risk_score: 41, updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
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

describe('Cases list — a11y smoke (jest-axe)', () => {
  beforeEach(() => {
    listCasesMock.mockReset();
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
  });

  it('has no axe violations on the loaded case list', async () => {
    const { container } = renderCases();
    // Wait for the rows to load so the full table (sort buttons, select-all, row
    // checkboxes) is present before the audit.
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument(), { timeout: 5000 });
    expect(await axe(container)).toHaveNoViolations();
  });
});
