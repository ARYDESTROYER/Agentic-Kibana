/**
 * AppShell top-nav search trigger (Round-7 W0.10 / #7).
 *
 * The old compact Cmd-K "Search" outline button was replaced by a WIDE, input-styled
 * trigger that spans the top bar and opens the command palette, plus a `sm:hidden`
 * ghost icon opener for the narrowest widths. Both open the SAME palette that Cmd-K
 * toggles. These tests assert:
 *   - clicking the wide trigger (by its accessible name) opens the palette (the
 *     CommandInput placeholder appears — Radix only portals the Dialog when open);
 *   - the compact mobile opener opens the same palette;
 *   - the two openers carry DISTINCT accessible names (jsdom ignores the responsive
 *     visibility classes, so both are in the tree — disambiguated by name).
 *
 * The api client + every provider the shell consumes (theme/prefs/auth/demo/router)
 * are supplied with mocked load-time calls so the test is fully offline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {
      status: number;
      body: unknown;
      constructor(status = 0, message = '', body: unknown = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
      }
    },
    api: {
      // Generic verbs used by the NotificationBell inbox helpers.
      get: ok({ unread: 0, items: [] }),
      post: ok({ ok: true }),
      put: ok({}),
      del: ok({}),
      // Provider load-time calls (auth/prefs/theme/demo) + shell health poll.
      auth: { me: ok({ auth_enabled: false, authenticated: false, user: null }) },
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
      demo: { status: ok({ mode: 'off', active: false, run_id: null }), enable: ok({}) },
      health: ok({ es_connected: true, store_type: 'memory', version: 'test' }),
      account: { get: ok({}) },
      // Remote palette search — only fires when the palette is open + a term is typed;
      // provided so a stray call never rejects.
      search: ok({ query: '', cases: [], sources: [], nav: [] }),
    },
  };
});

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { AppShell } from '../AppShell';

const WIDE_TRIGGER = 'Search cases, sources, and actions';
const MOBILE_OPENER = 'Open search';
const PALETTE_INPUT = /jump to a page, search cases\/sources/i;

function renderShell() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page="overview" onNavigate={vi.fn()}>
                  <div>routed content</div>
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe('AppShell top-nav search (W0.10)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders both openers with DISTINCT accessible names', async () => {
    renderShell();
    const wide = await screen.findByRole('button', { name: WIDE_TRIGGER });
    const mobile = await screen.findByRole('button', { name: MOBILE_OPENER });
    expect(wide).toBeInTheDocument();
    expect(mobile).toBeInTheDocument();
    // The visible placeholder is decorative; the accessible name comes from aria-label.
    expect(wide).toHaveTextContent(/Search cases, sources, actions/);
  });

  it('the palette is closed until an opener is clicked', async () => {
    renderShell();
    await screen.findByRole('button', { name: WIDE_TRIGGER });
    // Radix only portals the Dialog content when open → the CommandInput is absent.
    expect(screen.queryByPlaceholderText(PALETTE_INPUT)).toBeNull();
  });

  it('clicking the wide trigger opens the command palette', async () => {
    renderShell();
    const wide = await screen.findByRole('button', { name: WIDE_TRIGGER });
    fireEvent.click(wide);
    // The palette's CommandInput now renders → the palette opened.
    expect(await screen.findByPlaceholderText(PALETTE_INPUT)).toBeInTheDocument();
  });

  it('clicking the compact mobile opener opens the SAME palette', async () => {
    renderShell();
    const mobile = await screen.findByRole('button', { name: MOBILE_OPENER });
    fireEvent.click(mobile);
    expect(await screen.findByPlaceholderText(PALETTE_INPUT)).toBeInTheDocument();
  });

  it('the old "Open command palette" outline button no longer exists', async () => {
    renderShell();
    await screen.findByRole('button', { name: WIDE_TRIGGER });
    expect(screen.queryByRole('button', { name: 'Open command palette' })).toBeNull();
  });
});
