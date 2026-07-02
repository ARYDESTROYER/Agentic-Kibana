/**
 * Baseline page — R6 config-editor coverage.
 *
 * Focus: the policy form must NOT render its DEFAULT values while the persisted
 * config is still loading (that flashes a misleading "disabled" state, then snaps to
 * the saved values). It shows a Skeleton until the GET resolves, matching the warm-up
 * section directly above it.
 *
 * The stats fetch + config client + auth are mocked (no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { fetchStatsMock, getConfigMock, putConfigMock } = vi.hoisted(() => ({
  fetchStatsMock: vi.fn(),
  getConfigMock: vi.fn(),
  putConfigMock: vi.fn(),
}));

vi.mock('@/soc/Baseline.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../Baseline.api')>();
  return { ...actual, fetchBaselineStats: fetchStatsMock };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, baseline: { getConfig: getConfigMock, putConfig: putConfigMock } },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'tester', authEnabled: false, hasPermission: () => true }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import { BaselineInner } from '../Baseline';
import type { BaselineConfig } from '@/lib/types';

function renderPage() {
  return render(
    <TooltipProvider>
      <BaselineInner />
    </TooltipProvider>,
  );
}

const SAVED_CONFIG: BaselineConfig = {
  enabled: true,
  half_life_days: 30,
  warmup_multiplier: 3,
  modified_z_threshold: 3.5,
  tdigest_compression: 100,
  seasonality: 'hour_of_week',
};

describe('Baseline config editor loading state', () => {
  beforeEach(() => {
    fetchStatsMock.mockReset();
    getConfigMock.mockReset();
    fetchStatsMock.mockResolvedValue(null);
  });

  it('does not show the default-valued policy form while the persisted config loads', async () => {
    // Keep the config GET pending so the editor stays in its loading state.
    let resolveCfg: (v: { config: BaselineConfig }) => void = () => {};
    getConfigMock.mockReturnValue(
      new Promise<{ config: BaselineConfig }>((res) => {
        resolveCfg = res;
      }),
    );

    renderPage();

    // While the config load is in flight the form (and its Enable switch) must be
    // absent — the operator never sees the DEFAULT (disabled) form as if it were saved.
    expect(
      screen.queryByRole('switch', { name: /enable anomaly baseline/i }),
    ).toBeNull();

    // Resolve with a persisted config that has the detector ENABLED.
    resolveCfg({ config: SAVED_CONFIG });

    const toggle = await screen.findByRole('switch', { name: /enable anomaly baseline/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Baseline warm-up empty-state (#41)', () => {
  beforeEach(() => {
    fetchStatsMock.mockReset();
    getConfigMock.mockReset();
    // No baseline data → the warm-up empty-state renders. The config resolves (disabled)
    // so the page settles out of loading.
    fetchStatsMock.mockResolvedValue(null);
    getConfigMock.mockResolvedValue({ config: { ...SAVED_CONFIG, enabled: false } });
  });

  it('states the enable + events-feed dependency (not an auto warm-up) and links to sources', async () => {
    renderPage();
    // The old copy ("warms up as EVENT-feed detection runs") implied auto warm-up; the
    // reworded copy spells out BOTH dependencies so an empty gauge does not read as broken.
    expect(await screen.findByText(/only warms up once it is enabled/i)).toBeInTheDocument();
    expect(screen.getByText(/events-role feed with detection/i)).toBeInTheDocument();
    // And offers a concrete next step: connect the missing half (an events source).
    expect(
      screen.getByRole('button', { name: /connect an events source/i }),
    ).toBeInTheDocument();
    // The stale "warms up as EVENT-feed detection runs" phrasing is gone.
    expect(screen.queryByText(/warms up as EVENT-feed detection runs/i)).toBeNull();
  });
});
