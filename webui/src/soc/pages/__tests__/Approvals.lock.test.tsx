/**
 * Approvals — in-flight action lock (Round 6 admin-misc, finding #34).
 *
 * BUG: `decide()` opens with `if (busyId) return;`, but only the busy card's buttons
 * were disabled (`busy = busyId === p.id || bulkBusy`). Clicking Approve/Reject on a
 * DIFFERENT card while one decision was in flight was a SILENT no-op (dead button).
 *
 * FIX: the page passes a `locked` flag (any decision in flight) so every card's
 * Approve/Reject is disabled while a decision is pending — no silent no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { listProposalsMock, approveMock, rejectMock } = vi.hoisted(() => ({
  listProposalsMock: vi.fn(),
  approveMock: vi.fn(),
  rejectMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProposals: listProposalsMock,
      approveProposal: approveMock,
      rejectProposal: rejectMock,
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Approvals from '../Approvals';
import type { Proposal } from '@/lib/types';

const PROPOSALS = [
  { id: 'prop-a', kind: 'memory', status: 'pending', payload: { text: 'Alpha fact' } },
  { id: 'prop-b', kind: 'memory', status: 'pending', payload: { text: 'Bravo fact' } },
] as unknown as Proposal[];

function renderApprovals() {
  return render(
    <TooltipProvider>
      <Approvals onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Approvals in-flight lock (finding #34)', () => {
  beforeEach(() => {
    listProposalsMock.mockReset();
    approveMock.mockReset();
    rejectMock.mockReset();
    listProposalsMock.mockResolvedValue({ proposals: PROPOSALS });
  });

  it('disables a second card’s actions while another card’s decision is in flight', async () => {
    // Card A's approve never resolves → its decision stays in flight.
    approveMock.mockImplementation(() => new Promise(() => {}));

    renderApprovals();
    await waitFor(() => expect(screen.getByText('Bravo fact')).toBeInTheDocument());

    // Before any action, both cards' Reject buttons are enabled.
    const rejectsBefore = screen.getAllByRole('button', { name: /^reject$/i });
    expect(rejectsBefore).toHaveLength(2);
    expect(rejectsBefore[1]).not.toBeDisabled();

    // Approve card A (the first card).
    const approves = screen.getAllByRole('button', { name: /^approve$/i });
    fireEvent.click(approves[0]);

    // Card B's Reject (and Approve) are now disabled — not a silent no-op.
    await waitFor(() => {
      const rejectsAfter = screen.getAllByRole('button', { name: /^reject$/i });
      expect(rejectsAfter[1]).toBeDisabled();
    });
    // The other card's approve was never triggered while A was pending.
    expect(approveMock).toHaveBeenCalledTimes(1);
  });
});
