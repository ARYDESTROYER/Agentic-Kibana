/**
 * Regression test for BUG-3 — duplicate close (X) control in the case-detail Sheet.
 *
 * shadcn `SheetContent` ALWAYS renders its own built-in close X (accessible name
 * "Close", at right-4 top-4). CaseDetail previously ALSO hand-rolled a second
 * "Close" X in its header icon row, so two identical panel-dismiss controls
 * stacked in the top-right.
 *
 * The labeled "Close case" lifecycle action in the footer is a SEPARATE, correct
 * control (it changes case state — it does not dismiss the panel).
 *
 * This test renders CaseDetail with a mocked open case (and stubs for the other
 * load-time api calls) and asserts there is EXACTLY ONE panel-dismiss control
 * (a button whose accessible name is exactly "Close") plus the labeled
 * "Close case" lifecycle action. Before the fix this found TWO "Close" buttons.
 */
import type * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock the typed api client BEFORE importing the component (which pulls it in).
vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  // A minimal OPEN case — an open-ish status yields a footer "Close case" action.
  const openCase = {
    case_id: 'case-001',
    case_number: 'TLSOC-001',
    title: 'Suspicious login burst',
    status: 'open',
    disposition: null,
    verdict: 'needs_human',
    confidence: 0.5,
    risk_score: 60,
    created_at: '2026-06-29T00:00:00Z',
    updated_at: '2026-06-29T01:00:00Z',
    escalation_level: 0,
    evidence: [],
    assets: {},
    iocs: [],
    tags: [],
    comments: [],
  };
  return {
    setUnauthorizedHandler: vi.fn(),
    api: {
      // load-time calls fired when the sheet opens
      getCase: ok(openCase),
      getPlaybooks: ok({ enabled: false, playbooks: [] }),
      getModels: ok({ providers: {} }),
      getSettings: ok({ prefs: {}, configured: {}, read_only: false }),
      // namespaced calls referenced by the module (only fired on tab change)
      cases: {
        threatContext: ok(null),
        runPlaybook: ok(openCase),
        notify: ok({ sent: [] }),
      },
    },
  };
});

import { AuthProvider } from '../auth';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CaseDetail } from '../pages/CaseDetail';

function renderWithProviders(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

describe('CaseDetail — single panel-dismiss control (BUG-3)', () => {
  it('renders exactly ONE "Close" dismiss button plus the separate "Close case" action', async () => {
    renderWithProviders(<CaseDetail caseId="case-001" onClose={vi.fn()} />);

    // Wait for the case to load (the title is unique to the loaded state).
    await waitFor(() => expect(screen.getByText('Suspicious login burst')).toBeInTheDocument(), {
      timeout: 5000,
    });

    // Exactly one panel-dismiss control: the built-in SheetContent close X, whose
    // accessible name is exactly "Close". The removed header X had the same name —
    // before the fix this matched TWO buttons.
    const dismiss = screen.getAllByRole('button', { name: /^close$/i });
    expect(dismiss).toHaveLength(1);

    // The labeled lifecycle "Close case" footer action is separate and present.
    expect(screen.getByRole('button', { name: /^close case/i })).toBeInTheDocument();
  });
});
