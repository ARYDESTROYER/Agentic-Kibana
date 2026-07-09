/**
 * AppShell route-motion latch (motion #1 regression).
 *
 * BUG: AppShell keyed the routed-content branch on `Boolean(RouteMotion)` (the lazily
 * imported motion chunk). When that chunk resolved mid-session while a page was already
 * displayed, the branch flipped plain → motion and React unmounted + REMOUNTED the current
 * page — losing component state, double-firing mount effects, re-fetching data.
 *
 * FIX: a `motionActive` latch engages the motion branch ONLY on an actual page navigation
 * that happens while the chunk is already loaded — never merely because the chunk
 * resolved. This test drives that exact ordering with a GATED mock of the RouteMotion
 * module (its dynamic import blocks until the test releases it), so the timing is
 * deterministic rather than dependent on microtask scheduling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, act } from '@testing-library/react';

// A gate the test releases to resolve AppShell's dynamic import('./components/motion/
// RouteMotion'). Hoisted so the (hoisted) vi.mock factory can await it.
const gate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
});

// Mock the RouteMotion module: its import BLOCKS until gate.release() is called, and it
// renders a detectable marker so the test can tell which branch (plain vs motion) is live.
vi.mock('../components/motion/RouteMotion', async () => {
  await gate.promise;
  const R = await import('react');
  const RouteMotion = (props: {
    routeKey: string;
    className?: string;
    children?: React.ReactNode;
  }): React.ReactElement =>
    R.createElement(
      'div',
      { 'data-testid': 'route-motion', 'data-route': props.routeKey, className: props.className },
      props.children,
    );
  return { RouteMotion };
});

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      get: ok({ unread: 0, items: [] }),
      post: ok({ ok: true }),
      put: ok({}),
      del: ok({}),
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
import type { PageId } from '../nav';

/** Fires `onMount` on every fresh mount so the test can count remounts of the page body. */
function Tracker({ onMount }: { onMount: () => void }): React.ReactElement {
  React.useEffect(() => {
    onMount();
  }, [onMount]);
  return <div data-testid="tracked-page" />;
}

/** Owns the `page` state so the test can navigate by flipping it (like the real router). */
let navigate: ((p: PageId) => void) | null = null;
function Harness({ onChildMount }: { onChildMount: () => void }): React.ReactElement {
  const [page, setPage] = React.useState<PageId>('overview');
  navigate = setPage;
  const onMount = React.useCallback(onChildMount, [onChildMount]);
  return (
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page={page} onNavigate={(p) => setPage(p as PageId)}>
                  <Tracker onMount={onMount} />
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

describe('AppShell route-motion latch (motion #1)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    navigate = null;
  });

  it('does NOT remount the current page when the lazy motion chunk resolves (branch not keyed on Boolean(RouteMotion))', async () => {
    let mounts = 0;
    render(<Harness onChildMount={() => { mounts += 1; }} />);

    // Initial landing page mounted once; the motion chunk is still gated (never resolved).
    expect(await screen.findByTestId('tracked-page')).toBeInTheDocument();
    expect(mounts).toBe(1);

    // Navigate BEFORE motion is available → plain branch. This remount is expected (a real
    // navigation to a NEW page), taking the counter to 2. No motion wrapper yet.
    await act(async () => {
      navigate!('cases');
    });
    expect(mounts).toBe(2);
    expect(screen.queryByTestId('route-motion')).toBeNull();

    // Now the lazy motion chunk RESOLVES while the SAME page ('cases') is shown. The branch
    // must stay plain — no motion wrapper, and CRITICALLY no remount of the current page.
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId('route-motion')).toBeNull(); // branch did NOT flip on resolve
    expect(mounts).toBe(2); // the page was NOT remounted (the bug would push this to 3)

    // Only the NEXT real navigation engages the motion branch (proving the chunk had loaded).
    await act(async () => {
      navigate!('overview');
    });
    const motion = await screen.findByTestId('route-motion');
    expect(motion).toHaveAttribute('data-route', 'overview');
  });
});
