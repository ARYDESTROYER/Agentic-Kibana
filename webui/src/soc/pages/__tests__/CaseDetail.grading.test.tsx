/**
 * CaseDetail — feedback-into-close (Round-7 #10, DERIVED model).
 *
 * The standalone Feedback tab is retired; AI-decision grading now folds INTO the close
 * dialog. On a close-with-verdict the orchestrator's `runAction` fires TWO SEPARATE api
 * calls (#3 intact):
 *
 *   1. `caseActionExec`  — the EXISTING lifecycle verb; the backend still runs the real
 *                          deterministic `decide()`/`apply()`.
 *   2. `caseFeedback`    — a best-effort grading POST, with the agree/override assessment
 *                          DERIVED from the disposition ↔ verdict diff. It NEVER touches
 *                          `decide()`.
 *
 * This spec pins the two-call contract behaviourally (a live mount over a mocked
 * `@/lib/api`, like the sibling CaseDetail.footer/campaign specs):
 *
 *   - closing a VERDICT-bearing case issues BOTH the action POST and the feedback POST,
 *     the feedback carrying the DERIVED assessment;
 *   - CANCELLING the dialog issues NEITHER;
 *   - closing a NO-VERDICT case issues ONLY the action POST (grading is skipped).
 *
 * #9 is unaffected — no attacker-influenceable text is rendered by these assertions.
 */
import type * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { caseActionExec, caseFeedback, getCase } = vi.hoisted(() => ({
  caseActionExec: vi.fn(),
  caseFeedback: vi.fn(),
  getCase: vi.fn(),
}));

const BASE_CASE = {
  case_id: 'case-91',
  case_number: 'TLSOC-091',
  title: 'Credential stuffing burst',
  status: 'open',
  disposition: null as string | null,
  confidence: 0.8,
  risk_score: 68,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T01:00:00Z',
  escalation_level: 0,
  evidence: [],
  assets: {},
  iocs: [],
  tags: [],
  comments: [],
};

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    api: {
      getCase,
      getPlaybooks: ok({ enabled: false, playbooks: [] }),
      getModels: ok({ providers: {} }),
      getSettings: ok({ prefs: {}, configured: {}, read_only: false }),
      caseActionExec,
      caseFeedback,
      cases: {
        threatContext: ok(null),
        runPlaybook: ok(null),
        notify: ok({ sent: [] }),
      },
    },
  };
});

import { AuthProvider } from '../../auth';
import { RouterProvider } from '../../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CaseDetail } from '../CaseDetail';

function renderWithProviders(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

/** Open the footer "Close case" dialog and pick a disposition (leaves it submittable). */
async function openCloseDialogAndPick(disposition: RegExp): Promise<HTMLElement> {
  await waitFor(
    () => expect(screen.getByText('Credential stuffing burst')).toBeInTheDocument(),
    { timeout: 5000 },
  );
  fireEvent.click(screen.getByRole('button', { name: /^close case/i }));
  const dialog = await screen.findByRole('dialog');
  // Disposition select is the first combobox in the dialog.
  const combos = within(dialog).getAllByRole('combobox');
  fireEvent.click(combos[0]);
  fireEvent.click(await screen.findByRole('option', { name: disposition }));
  return dialog;
}

describe('CaseDetail — feedback-into-close (two separate POSTs, #3)', () => {
  beforeEach(() => {
    caseActionExec.mockReset();
    caseFeedback.mockReset();
    getCase.mockReset();
  });

  it('closing a VERDICT-bearing case issues BOTH the action POST and a derived feedback POST', async () => {
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'true_positive' });
    caseActionExec.mockResolvedValue({
      ...BASE_CASE,
      verdict: 'true_positive',
      status: 'closed',
      disposition: 'true_positive',
    });
    caseFeedback.mockResolvedValue({
      ...BASE_CASE,
      verdict: 'true_positive',
      status: 'closed',
      disposition: 'true_positive',
      feedback: [{ assessment: 'agree' }],
    });

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/True positive/i);

    // The DERIVED agree/override badge proves the grading section wired the
    // verdict ↔ disposition diff (true_positive matches true_positive → agree).
    await screen.findByText(/Matches AI verdict/i);

    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    // 1) The deterministic close verb (decide()/apply() runs server-side, #3).
    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    const [, actionInput] = caseActionExec.mock.calls[0];
    expect(actionInput.action).toBe('close');
    expect(actionInput.disposition).toBe('true_positive');

    // 2) The SEPARATE grading POST, carrying the derived 'agree' assessment.
    await waitFor(() => expect(caseFeedback).toHaveBeenCalledTimes(1));
    const [feedbackId, feedbackBody] = caseFeedback.mock.calls[0];
    expect(feedbackId).toBe('case-91');
    expect(feedbackBody.assessment).toBe('agree');
  });

  it('CANCELLING the close dialog issues NEITHER the action nor the feedback POST', async () => {
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: 'true_positive' });

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/True positive/i);

    // Cancel routes through `closeAction` (setPending(null)) and triggers NO POST at
    // all — neither the deterministic action nor the grading feedback.
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(caseActionExec).not.toHaveBeenCalled();
    expect(caseFeedback).not.toHaveBeenCalled();
  });

  it('closing a NO-VERDICT case issues ONLY the action POST (grading skipped)', async () => {
    // No AI verdict to grade — the second POST must be suppressed.
    getCase.mockResolvedValue({ ...BASE_CASE, verdict: undefined });
    caseActionExec.mockResolvedValue({
      ...BASE_CASE,
      verdict: undefined,
      status: 'closed',
      disposition: 'false_positive',
    });

    renderWithProviders(<CaseDetail caseId="case-91" onClose={vi.fn()} />);
    const dialog = await openCloseDialogAndPick(/False positive/i);

    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    // The close resolves and re-renders the footer to the terminal (Reopen) state — a
    // signal that runAction's whole continuation (incl. the grading guard) ran. With no
    // verdict the feedback POST is skipped; only the deterministic action POST fired.
    await screen.findByRole('button', { name: /reopen/i });
    expect(caseActionExec).toHaveBeenCalledTimes(1);
    expect(caseFeedback).not.toHaveBeenCalled();
  });
});
