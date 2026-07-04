/**
 * Cases — per-cell SEVERITY provenance (Round-7 #9b, W1.B).
 *
 * Severity is the one advisory field whose provenance FLIPS per row: a SIEM that
 * asserts a severity is tagged `severity_source: 'source_asserted'` (→ a `source`
 * provenance), while a case whose severity was derived from the deterministic risk
 * score is `'derived'` (→ a `code` provenance). This pins that the Cases "Severity"
 * cell renders a `<ProvenanceTag variant="icon">` beside the badge and that the tag
 * flips per row within the SAME table (unlike risk/verdict/confidence whose constant
 * provenance is declared once at the column header).
 *
 * Fully mocked (offline); nothing here touches #3 runtime behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

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

// A SIEM-asserted severity (source) and a code-derived one (fell back to risk_score)
// living in the SAME loaded list, so the per-row provenance flip is observable.
const CASES = [
  {
    case_id: 'c-src', case_number: 'T-1', title: 'SourceCase', status: 'open',
    severity_band: 'high', severity_source: 'source_asserted', risk_score: 40,
    updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [],
  },
  {
    case_id: 'c-der', case_number: 'T-2', title: 'DerivedCase', status: 'open',
    // no severity_band → band derived from risk_score; graded by code.
    severity_source: 'derived', risk_score: 90,
    updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [],
  },
];

// ProvenanceTag icon-variant accessible names (the fixed, controlled descriptions).
const SOURCE_NAME = /SIEM-asserted \(from the source\)/;
const CODE_NAME = /Deterministic \(code-derived\)/;

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

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest('tr');
  if (!row) throw new Error(`row for ${title} not found`);
  return row;
}

describe('Cases — per-cell severity provenance (#9b)', () => {
  beforeEach(() => {
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
  });

  it('tags the SIEM-asserted severity cell with a `source` provenance', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('SourceCase')).toBeInTheDocument());
    const row = rowFor('SourceCase');
    // The source row carries a `source` provenance and NOT a `code` one.
    expect(within(row).getByRole('img', { name: SOURCE_NAME })).toBeInTheDocument();
    expect(within(row).queryByRole('img', { name: CODE_NAME })).toBeNull();
  });

  it('tags the code-derived severity cell with a `code` provenance', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('DerivedCase')).toBeInTheDocument());
    const row = rowFor('DerivedCase');
    // The derived row carries a `code` provenance and NOT a `source` one.
    expect(within(row).getByRole('img', { name: CODE_NAME })).toBeInTheDocument();
    expect(within(row).queryByRole('img', { name: SOURCE_NAME })).toBeNull();
  });

  it('flips the provenance per row within the same table', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('SourceCase')).toBeInTheDocument());
    const src = within(rowFor('SourceCase')).getByRole('img', { name: SOURCE_NAME });
    const der = within(rowFor('DerivedCase')).getByRole('img', { name: CODE_NAME });
    // Distinct provenance kinds for the two rows (the flip).
    expect(src.getAttribute('data-provenance')).toBe('source');
    expect(der.getAttribute('data-provenance')).toBe('code');
  });
});
