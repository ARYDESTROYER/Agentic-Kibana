/**
 * Tuning page tests (Round 4 / Wave 4 — WB).
 *
 * Mocks the co-located Tuning.api module (no network) + the auth context (grant-all)
 * and asserts:
 *   - recommendations render with rule id, FP rate, and the proposed before→after
 *     change as PLAIN text (#9),
 *   - the honest-framing banner is present (tuning never closes a case, #3),
 *   - a suppression DROP shows a "needs approval" affordance + links to Approvals
 *     (never auto-applied),
 *   - Apply calls tuningApi.apply for a safe recommendation,
 *   - the config panel reflects the loaded policy.
 *
 * The api module is fully mocked; the config-save path is exercised via the apply
 * button (a full StickySaveBar flow is left to manual QA).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { recsMock, getConfigMock, putConfigMock, applyMock, rollbackMock } = vi.hoisted(
  () => ({
    recsMock: vi.fn(),
    getConfigMock: vi.fn(),
    putConfigMock: vi.fn(),
    applyMock: vi.fn(),
    rollbackMock: vi.fn(),
  }),
);

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
  useAuth: () => ({
    username: 'tester',
    hasPermission: () => true,
    authEnabled: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Tuning from '../Tuning';
import type { TuningRecommendationsResponse } from '../Tuning.api';

const RECS: TuningRecommendationsResponse = {
  enabled: true,
  cadence: 'nightly',
  fp_rate_target: 0.3,
  min_samples: 25,
  window_cases: 120,
  rule_noise: [
    { rule_id: 'auth-brute', total: 40, fp: 30, tp: 10, fp_rate: 0.62, volume_ewma: 4.2, over_target: true },
  ],
  recommendations: [
    {
      rule_id: 'auth-brute',
      kind: 'correlation_n',
      before: 3,
      after: 4,
      feed_key: null,
      source_id: null,
      feed_id: null,
      fp_rate: 0.62,
      samples: 40,
      auto_apply: true,
      shadow_blocked: false,
      reason: 'auto_apply_candidate',
    },
    {
      rule_id: 'noisy-web',
      kind: 'suppression',
      before: null,
      after: 'drop',
      feed_key: 'src-1:feed-2',
      source_id: 'src-1',
      feed_id: 'feed-2',
      fp_rate: 0.85,
      samples: 55,
      auto_apply: false,
      shadow_blocked: false,
      reason: 'suppression_drop',
    },
  ],
  applied: [],
};

const CONFIG = {
  config: {
    enabled: true,
    min_samples: 25,
    max_n_step: 1,
    fp_rate_target: 0.3,
    wilson_z: 1.96,
    ewma_alpha: 0.2,
    cadence: 'nightly' as const,
    shadow_eval: true,
  },
};

function renderTuning(onNavigate = vi.fn()) {
  const utils = render(
    <TooltipProvider>
      <Tuning onNavigate={onNavigate} />
    </TooltipProvider>,
  );
  return { ...utils, onNavigate };
}

describe('Tuning page', () => {
  beforeEach(() => {
    recsMock.mockReset();
    getConfigMock.mockReset();
    applyMock.mockReset();
    recsMock.mockResolvedValue(RECS);
    getConfigMock.mockResolvedValue(CONFIG);
    applyMock.mockResolvedValue({
      ok: true,
      rule_id: 'auth-brute',
      applied: [{ id: 'led-1', rule_id: 'auth-brute', target: 'correlation_n', before: 3, after: 4, active: true }],
      queued_proposals: [],
      shadow_blocked: [],
    });
  });

  it('renders recommendations with rule id, FP rate, and the proposed change as plain text', async () => {
    renderTuning();
    await waitFor(() => expect(recsMock).toHaveBeenCalled());

    expect(await screen.findByText('Adaptive tuning')).toBeInTheDocument();
    // Rule id renders as plain text / InlineCode.
    expect(screen.getByText('auth-brute')).toBeInTheDocument();
    // FP rate formatted as a percent.
    expect(screen.getAllByText('62%').length).toBeGreaterThan(0);
    // Proposed change before→after values render as plain text.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('shows the honest-framing banner (tuning never closes a case)', async () => {
    renderTuning();
    await screen.findByText('auth-brute');
    expect(
      screen.getByText(/only changes what gets investigated/i),
    ).toBeInTheDocument();
  });

  it('routes a suppression drop to Approvals instead of applying it', async () => {
    const { onNavigate } = renderTuning();
    await screen.findByText('noisy-web');

    // The suppression row is marked "Needs approval" and offers an Approvals link.
    expect(screen.getByText(/needs approval/i)).toBeInTheDocument();
    const openApprovals = screen.getByRole('button', { name: /open approvals/i });
    fireEvent.click(openApprovals);
    expect(onNavigate).toHaveBeenCalledWith('approvals');
    // A suppression is NEVER auto-applied from here.
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('applies a safe recommendation via tuningApi.apply', async () => {
    renderTuning();
    await screen.findByText('auth-brute');

    const applyBtn = screen.getByRole('button', { name: /^apply$/i });
    fireEvent.click(applyBtn);
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith('auth-brute'));
  });

  it('reflects the loaded policy in the config panel', async () => {
    renderTuning();
    await screen.findByText('auth-brute');
    // The min-samples input carries the loaded value.
    const minSamples = screen.getByLabelText(/minimum samples/i) as HTMLInputElement;
    expect(minSamples.value).toBe('25');
  });
});
