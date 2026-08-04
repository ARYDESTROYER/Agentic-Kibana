/**
 * Tuning page — rule-scoped apply/busy-state regression.
 *
 * The backend apply endpoint recomputes and processes EVERY current proposal for one
 * rule. The UI must therefore group sibling recommendations under one honest action,
 * lock that rule while it runs, and leave an unrelated rule available.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';

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

vi.mock('@/soc/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Tuning from '../Tuning';
import type { TuningRecommendationsResponse } from '../Tuning.api';

// Two recommendations for the SAME rule_id plus one unrelated rule.
const RECS: TuningRecommendationsResponse = {
  enabled: true,
  cadence: 'nightly',
  fp_rate_target: 0.3,
  min_samples: 25,
  auto_apply_confirmed: true,
  window_cases: 100,
  rule_noise: [],
  recommendations: [
    {
      rule_id: 'auth-brute', kind: 'correlation_n', before: 3, after: 4,
      feed_key: null, source_id: null, feed_id: null, fp_rate: 0.62, samples: 40,
      auto_apply: true, shadow_blocked: false, reason: 'auto_apply_candidate',
    },
    {
      rule_id: 'auth-brute', kind: 'severity_floor', before: 1, after: 2,
      feed_key: 'src-1:feed-1', source_id: 'src-1', feed_id: 'feed-1', fp_rate: 0.62, samples: 40,
      auto_apply: true, shadow_blocked: false, reason: 'auto_apply_candidate',
    },
    {
      rule_id: 'mail-volume', kind: 'correlation_n', before: 2, after: 3,
      feed_key: null, source_id: null, feed_id: null, fp_rate: 0.58, samples: 32,
      auto_apply: true, shadow_blocked: false, reason: 'auto_apply_candidate',
    },
  ],
  applied: [
    {
      id: 'auth-ledger',
      rule_id: 'auth-brute',
      target: 'correlation_n',
      before: 2,
      after: 3,
      active: true,
      applied_at: '2026-07-30T12:00:00Z',
    },
  ],
};

const CONFIG = {
  config: {
    enabled: true, min_samples: 25, max_n_step: 1, fp_rate_target: 0.3,
    wilson_z: 1.96, ewma_alpha: 0.2, cadence: 'nightly' as const, shadow_eval: true,
    auto_apply_confirmed: true,
  },
};

describe('Tuning — apply is grouped and busy state is scoped to the rule', () => {
  beforeEach(() => {
    recsMock.mockReset();
    getConfigMock.mockReset();
    applyMock.mockReset();
    recsMock.mockResolvedValue(RECS);
    getConfigMock.mockResolvedValue(CONFIG);
    // Never-resolving apply → keeps the click's busy state in-flight for the assertion.
    applyMock.mockReturnValue(new Promise(() => {}));
  });

  it('uses one action for sibling recommendations and leaves an unrelated rule enabled', async () => {
    render(
      <TooltipProvider>
        <Tuning />
      </TooltipProvider>,
    );
    const authRule = await screen.findByRole('button', {
      name: 'Inspect rule auth-brute',
    });
    fireEvent.click(authRule);
    const authAction = screen.getByRole('button', {
      name: 'Process all changes for auth-brute',
    });

    fireEvent.click(authAction);

    await waitFor(() => {
      expect(authAction).toBeDisabled();
    });
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith('auth-brute');

    fireEvent.click(screen.getByRole('button', { name: 'Inspect rule mail-volume' }));
    expect(
      screen.getByRole('button', { name: 'Process all changes for mail-volume' }),
    ).not.toBeDisabled();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Policy & history' }), {
      key: 'Enter',
    });
    expect(
      await screen.findByRole('button', {
        name: 'Rollback latest change for auth-brute',
      }),
    ).toBeDisabled();
  });
});
