/**
 * Tuning page — Round-6 regressions.
 *
 *  - #14/#15: a LOAD FAILURE renders ONLY the error (no contradictory "No
 *    recommendations" empty state beside it, and no editable DEFAULT config form whose
 *    Save would clobber the real, never-loaded policy).
 *  - #13: only the NEWEST active ledger row per rule_id offers a Rollback (the backend
 *    reverses the most-recent active record, and the FE only sends the rule_id).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { recsMock, getConfigMock, putConfigMock, applyMock, rollbackMock } = vi.hoisted(() => ({
  recsMock: vi.fn(),
  getConfigMock: vi.fn(),
  putConfigMock: vi.fn(),
  applyMock: vi.fn(),
  rollbackMock: vi.fn(),
}));

vi.mock('@/soc/pages/Tuning.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Tuning.api')>();
  return {
    ...actual,
    tuningApi: {
      recommendations: recsMock,
      getConfig: getConfigMock,
      putConfig: putConfigMock,
      apply: applyMock,
      rollback: rollbackMock,
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'tester', hasPermission: () => true, authEnabled: false }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Tuning from '../Tuning';
import type { TuningRecommendationsResponse } from '../Tuning.api';

const OK_CONFIG = {
  config: {
    enabled: false, min_samples: 25, max_n_step: 1, fp_rate_target: 0.3,
    wilson_z: 1.96, ewma_alpha: 0.2, cadence: 'nightly' as const, shadow_eval: true,
  },
};

describe('Tuning — load error (bug #14/#15)', () => {
  beforeEach(() => {
    recsMock.mockReset();
    getConfigMock.mockReset();
    recsMock.mockRejectedValue(new Error('backend down'));
    getConfigMock.mockResolvedValue(OK_CONFIG);
  });

  it('shows only the error — no "No recommendations" empty state and no editable config form', async () => {
    render(
      <TooltipProvider>
        <Tuning />
      </TooltipProvider>,
    );
    await waitFor(() => expect(recsMock).toHaveBeenCalled());
    expect(await screen.findByText('Could not load tuning data')).toBeInTheDocument();
    // The contradictory empty state must NOT appear beside the error.
    expect(screen.queryByText('No recommendations')).not.toBeInTheDocument();
    // The default config form must NOT be editable after a failed load.
    expect(screen.queryByText('Tuning policy')).not.toBeInTheDocument();
  });
});

describe('Tuning — rollback targets the newest active row only (bug #13)', () => {
  const RECS: TuningRecommendationsResponse = {
    enabled: false,
    cadence: 'nightly',
    fp_rate_target: 0.3,
    min_samples: 25,
    window_cases: 10,
    rule_noise: [],
    recommendations: [],
    applied: [
      // Two ACTIVE changes for the SAME rule (n:5→6 then 6→7). Only the newest may roll back.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'led-old', rule_id: 'auth-brute', target: 'correlation_n', before: 5, after: 6, rolled_back: false, applied_at: '2026-07-01T09:00:00Z' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'led-new', rule_id: 'auth-brute', target: 'correlation_n', before: 6, after: 7, rolled_back: false, applied_at: '2026-07-01T11:00:00Z' } as any,
    ],
  };

  beforeEach(() => {
    recsMock.mockReset();
    getConfigMock.mockReset();
    recsMock.mockResolvedValue(RECS);
    getConfigMock.mockResolvedValue(OK_CONFIG);
  });

  it('renders both rows Active but exactly one Rollback button', async () => {
    render(
      <TooltipProvider>
        <Tuning />
      </TooltipProvider>,
    );
    await waitFor(() => expect(recsMock).toHaveBeenCalled());
    await screen.findByText('Audit history');
    // Both rows are active.
    expect(screen.getAllByText('Active')).toHaveLength(2);
    // But only the newest active row for the rule offers a rollback.
    expect(screen.getAllByRole('button', { name: /rollback/i })).toHaveLength(1);
  });
});
