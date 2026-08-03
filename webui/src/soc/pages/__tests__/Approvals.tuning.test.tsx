import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { approveMock, listProposalsMock } = vi.hoisted(() => ({
  approveMock: vi.fn(),
  listProposalsMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProposals: listProposalsMock,
      approveProposal: approveMock,
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import type { Proposal } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import Approvals from '../Approvals';

const TUNING_PROPOSAL = {
  id: 'proposal-tuning-1',
  kind: 'tuning',
  status: 'pending',
  created_at: '2026-08-02T12:00:00Z',
  rationale: 'The change is bounded and uses analyst-confirmed dispositions only.',
  payload: {
    tuning: true,
    action: 'apply_change',
    reason_code: 'policy_requires_approval',
    reason: 'The rule exceeded its false-positive target using 14 analyst-confirmed outcomes.',
    recommended_action: 'Review the evidence and apply a one-step correlation threshold increase.',
    rule_id: 'demo_noisy_scanner',
    target: 'correlation_n',
    before: 2,
    after: 3,
    analyst_samples: 14,
    confirmed_false_positives: 12,
    confirmed_true_positives: 2,
    unconfirmed_cases: 41,
  },
} as unknown as Proposal;

function renderPage() {
  return render(
    <TooltipProvider>
      <Approvals onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Approvals tuning proposals', () => {
  beforeEach(() => {
    approveMock.mockReset();
    listProposalsMock.mockReset();
    listProposalsMock.mockResolvedValue({ proposals: [TUNING_PROPOSAL] });
  });

  it('explains why attention is needed, the exact bounded change, and its evidence', async () => {
    renderPage();

    expect(await screen.findByText('Tuning change')).toBeInTheDocument();
    expect(screen.getByText('demo_noisy_scanner')).toBeInTheDocument();
    expect(screen.getByText('2 → 3')).toBeInTheDocument();
    expect(screen.getByText('Why this needs attention')).toBeInTheDocument();
    expect(screen.getByText(/14 analyst-confirmed outcomes/)).toBeInTheDocument();
    expect(screen.getByText('Recommended action')).toBeInTheDocument();
    expect(screen.getByText(/one-step correlation threshold increase/)).toBeInTheDocument();
    expect(screen.getByText('Confirmed FP / TP')).toBeInTheDocument();
    expect(screen.getByText('12 / 2')).toBeInTheDocument();
  });

  it('uses the normalized approved proposal response to remove the pending item', async () => {
    approveMock.mockResolvedValue({ ...TUNING_PROPOSAL, status: 'approved' });
    renderPage();
    await screen.findByText('demo_noisy_scanner');

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('proposal-tuning-1'));
    await waitFor(() => expect(screen.queryByText('demo_noisy_scanner')).not.toBeInTheDocument());
    expect(screen.getByText('No pending proposals')).toBeInTheDocument();
  });
});
