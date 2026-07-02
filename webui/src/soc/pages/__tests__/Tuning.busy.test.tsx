/**
 * Tuning page — busy-state scoping regression (#36).
 *
 * A rule can have MORE THAN ONE recommendation (e.g. a correlation_n bump AND a
 * severity_floor bump share one rule_id). The Apply/Rollback busy state must be keyed on
 * the ROW (`${rule_id}:${kind}` / ledger id), NOT the bare rule_id — otherwise applying
 * one recommendation disables (and spins) every sibling row that shares its rule_id.
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

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Tuning from '../Tuning';
import type { TuningRecommendationsResponse } from '../Tuning.api';

// Two recommendations for the SAME rule_id but DIFFERENT kinds — independent changes.
const RECS: TuningRecommendationsResponse = {
  enabled: true,
  cadence: 'nightly',
  fp_rate_target: 0.3,
  min_samples: 25,
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
  ],
  applied: [],
};

const CONFIG = {
  config: {
    enabled: true, min_samples: 25, max_n_step: 1, fp_rate_target: 0.3,
    wilson_z: 1.96, ewma_alpha: 0.2, cadence: 'nightly' as const, shadow_eval: true,
  },
};

describe('Tuning — busy state is scoped to the row, not the rule_id (#36)', () => {
  beforeEach(() => {
    recsMock.mockReset();
    getConfigMock.mockReset();
    applyMock.mockReset();
    recsMock.mockResolvedValue(RECS);
    getConfigMock.mockResolvedValue(CONFIG);
    // Never-resolving apply → keeps the click's busy state in-flight for the assertion.
    applyMock.mockReturnValue(new Promise(() => {}));
  });

  it('applying one recommendation does NOT disable a sibling row sharing the rule_id', async () => {
    render(
      <TooltipProvider>
        <Tuning />
      </TooltipProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^apply$/i })).toHaveLength(2),
    );
    const applyBtns = screen.getAllByRole('button', { name: /^apply$/i });

    fireEvent.click(applyBtns[0]); // apply the correlation_n row only

    await waitFor(() => {
      const btns = screen.getAllByRole('button', { name: /^apply$/i });
      // The clicked row is busy…
      expect(btns[0]).toBeDisabled();
      // …but the sibling (same rule_id, different kind) stays enabled.
      expect(btns[1]).not.toBeDisabled();
    });
  });
});
