/**
 * Cases — severity drill-through seeding (Round-6 #38).
 *
 * Overview's Critical/High KPI + open-by-severity rows deep-link to a severity-filtered
 * Cases view via `navigate('cases', { severity })` → the route passes `initialSeverity`.
 * This pins that Cases honours that seed: a recognised band narrows the loaded list to
 * that severity, and an unrecognised value is ignored (never silently empties the list
 * behind an un-representable filter).
 *
 * Fully mocked (offline); the severity narrowing is client-side over the loaded rows and
 * never touches #3 runtime behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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

// scoreBand (palette.ts): 74-100 critical · 48-73 high · 22-47 medium · 0-21 low.
const CASES = [
  { case_id: 'c-crit', case_number: 'T-1', title: 'CritCase', status: 'open', risk_score: 90, updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'c-high', case_number: 'T-2', title: 'HighCase', status: 'open', risk_score: 60, updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
  { case_id: 'c-low', case_number: 'T-3', title: 'LowCase', status: 'open', risk_score: 10, updated_at: '2026-06-29T02:00:00Z', tags: [], comments: [] },
];

function renderCases(props?: { initialSeverity?: string }) {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <Cases initialSeverity={props?.initialSeverity} />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe('Cases — severity drill-through seeding (#38)', () => {
  beforeEach(() => {
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
  });

  it('seeds the severity filter from initialSeverity, narrowing to that band', async () => {
    renderCases({ initialSeverity: 'critical' });
    // Only the critical (risk 90) case survives; the high + low cases are filtered out.
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());
    expect(screen.queryByText('HighCase')).toBeNull();
    expect(screen.queryByText('LowCase')).toBeNull();
  });

  it('honours a different band (high) independently', async () => {
    renderCases({ initialSeverity: 'high' });
    await waitFor(() => expect(screen.getByText('HighCase')).toBeInTheDocument());
    expect(screen.queryByText('CritCase')).toBeNull();
    expect(screen.queryByText('LowCase')).toBeNull();
  });

  it('ignores an unrecognised severity value (never silently empties the list)', async () => {
    renderCases({ initialSeverity: 'bogus-band' });
    // All three cases remain — the stray value is dropped, not applied as a filter.
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());
    expect(screen.getByText('HighCase')).toBeInTheDocument();
    expect(screen.getByText('LowCase')).toBeInTheDocument();
  });
});
