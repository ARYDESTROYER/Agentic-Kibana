/**
 * Smoke test for the rebuilt (Tailwind + shadcn) SOC console.
 *
 * Mounts the whole <App/> with a mocked API surface and asserts it boots through
 * auth -> setup -> shell and renders the Overview dashboard WITHOUT tripping the
 * top-level error boundary. This exercises ThemeProvider, RouterProvider,
 * AppShell, and the Overview page (KPI tiles, risk gauge, bar lists) together.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  const branding = {
    org_name: '',
    product_name: '',
    logo_data_url: '',
    favicon_data_url: '',
    accent_color: '',
    accent_color2: '',
    theme: '',
    login_subtitle: '',
    footer_text: '',
    support_url: '',
    dark_mode_default: false,
  };
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: {
        me: ok({ auth_enabled: false, authenticated: true, user: null }),
        login: ok({ token: 't', user: { username: 'x' } }),
        logout: ok({ ok: true }),
        changePassword: ok({ ok: true }),
      },
      setup: {
        status: ok({ setup_complete: true }),
        initAdmin: ok({ ok: true, username: 'x' }),
      },
      roles: {
        get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }),
      },
      getBranding: ok(branding),
      setupStatus: ok({ setup_complete: true }),
      health: ok({ es_connected: true, store_type: 'memory', version: 'test' }),
      getMetrics: ok({ by_status: {}, by_verdict: {}, total_cases: 0 }),
      listCases: ok({ cases: [], total: 0 }),
      usageSummary: ok({
        total_cost: 0,
        total_tokens: 0,
        total_calls: 0,
        by_model: [],
        by_role: [],
        by_surface: [],
        series: [],
      }),
      ragStats: ok({ total_chunks: 0, document_count: 0, embedding_model: '', vector_dims: 0, by_source: [] }),
      getFeedbackStats: ok({}),
      scanNotifications: ok({ new_count: 0 }),
    },
  };
});

import { App } from '../App';

describe('SOC console — app smoke', () => {
  it('boots to the Overview dashboard without throwing', async () => {
    render(<App />);
    // The dashboard hero title is unique to Overview and renders before the charts.
    await waitFor(
      () => expect(screen.getByText('Security Posture Dashboard')).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // The top-level ErrorBoundary fallback must NOT be showing.
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
  });
});
