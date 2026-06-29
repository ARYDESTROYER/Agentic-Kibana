/**
 * Render regression test for the Settings page — guards the React #310 bug.
 *
 * The default <Settings/> component had hooks (the section-rail useMemos +
 * a section-sync useEffect) sitting AFTER an `if (loading) return <Skeleton/>`
 * early return. On the first data load `loading` flips false, the post-return
 * hooks suddenly run, the hook count changes between renders, and React throws
 * #310 ("Rendered more hooks than during the previous render") in production.
 *
 * This test mounts <Settings/> with the auth context + a mocked api, resolves
 * the mocked getSettings()/getModels(), and asserts the section rail renders
 * (a known section label is in the document) WITHOUT throwing. If the hooks
 * ever drift back below an early return, this test crashes on the loading→ready
 * transition and fails — exactly the regression we want to catch.
 *
 * A tiny smoke for the Overview page (another Wave-7 early-return page) is added
 * at the end so the loading→ready transition is exercised there too.
 */
import type * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock the typed api client BEFORE importing anything that pulls it in.
vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  const prefs = {
    // A representative slice of Preferences. Everything the General section reads
    // is present; the rest of the page tolerates undefined fields.
    data_view_pattern: 'all-logs-*',
    time_field: '@timestamp',
    source_ip_field: 'source.ip',
    user_field: 'user.name',
    host_field: 'host.name',
    rule_field: 'rule.id',
    rule_name_field: 'rule.name',
    severity_field: 'event.severity',
    severity_threshold: 3,
    investigate_lookback: 'now-24h',
    polling_enabled: false,
    poll_interval_seconds: 60,
    poll_batch_size: 100,
    cold_start_lookback_minutes: 60,
    sources: [],
    setup_complete: true,
  };
  return {
    setUnauthorizedHandler: vi.fn(),
    api: {
      auth: {
        me: ok({ auth_enabled: false, authenticated: true, user: null }),
        logout: ok({ ok: true }),
      },
      roles: {
        get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }),
      },
      // The two calls the Settings load() fires in parallel.
      getSettings: ok({ prefs, configured: {}, read_only: false }),
      getModels: ok({ providers: { anthropic: ['claude-sonnet'] } }),
      // Used by sub-sections that may lazily mount; harmless to provide.
      getPlaybooks: ok({ enabled: false, playbooks: [] }),
      getBranding: ok({}),
      caseIdPreview: ok({ samples: [], valid: true }),
    },
  };
});

import { AuthProvider } from '../auth';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Settings from '../pages/Settings';
import Overview from '../pages/Overview';

function renderWithProviders(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

describe('Settings page — #310 render regression', () => {
  it('mounts and survives the loading→ready transition, rendering the section rail', async () => {
    renderWithProviders(<Settings />);

    // Once getSettings() resolves, `loading` flips false and the (now-hoisted)
    // section-rail hooks run. The known "General & data scope" section label
    // appears BOTH as the rail nav button and as the rendered section title —
    // its presence proves the rail rendered AND that React did not throw #310
    // during the loading→ready transition.
    await waitFor(
      () => expect(screen.getAllByText('General & data scope').length).toBeGreaterThan(0),
      { timeout: 5000 },
    );

    // The page title is present too (it renders in both loading and ready states).
    expect(screen.getAllByText('Settings').length).toBeGreaterThan(0);
  });
});

describe('Overview page — render smoke', () => {
  it('mounts without throwing through the loading→ready transition', async () => {
    // Augment the mocked api with the calls Overview's load() makes. The module
    // mock above only stubs a subset, so add Overview's surface here.
    const { api } = await import('@/lib/api');
    const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
    Object.assign(api as Record<string, unknown>, {
      listCases: ok({ cases: [], total: 0 }),
      getMetrics: ok({ by_status: {}, by_verdict: {}, total_cases: 0 }),
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
    });

    renderWithProviders(<Overview />);

    // The Overview hero title is unique and renders after the data resolves.
    await waitFor(
      () => expect(screen.getByText('Security Posture Dashboard')).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });
});
