/**
 * Regression test for the EuiAvatar white-screen bug.
 *
 * The "Notes & feedback" (collab) tab renders avatars whose `color` was a
 * `tint(...)` rgba string — which EuiAvatar in EUI 95 rejects, throwing during
 * render and (without an error boundary) blanking the whole app. This test
 * renders the flyout, opens that tab, and asserts it renders WITHOUT throwing.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EuiProvider } from '@elastic/eui';

// Mock the whole api surface the flyout touches: getCase resolves a minimal
// case; everything else resolves something empty/benign so no call rejects.
// NOTE: the factory is hoisted above imports, so the minimal Case must be
// defined INSIDE it (no top-level references allowed).
vi.mock('../../lib/api', () => {
  // A minimal Case that satisfies the fields the flyout + collab tab read.
  const minimalCase = {
    case_id: 'c1',
    status: 'open',
    verdict: null,
    confidence: 0,
    risk_score: 0,
    title: 'Test case',
    summary: '',
    feedback: [],
    comments: [],
    tags: [],
    assignee: '',
    evidence: [],
    mitre: [],
    rule_ids: [],
  };
  const noop = vi.fn().mockResolvedValue({});
  return {
    api: {
      getCase: vi.fn().mockResolvedValue(minimalCase),
      get: vi.fn().mockResolvedValue({ case_id: 'c1', steps: [], total: 0 }),
      caseRationale: vi.fn().mockResolvedValue({}),
      getModels: vi.fn().mockResolvedValue({ models: [] }),
      // The flyout reads the FP auto-close policy (best-effort) for the
      // calibration-aware confidence badge; stub it so the effect's call resolves.
      getSettings: vi.fn().mockResolvedValue({ prefs: {} }),
      caseFeedback: noop,
      caseComment: noop,
      caseTags: noop,
      caseAssign: noop,
      exportCase: noop,
      caseActionExec: noop,
      reinvestigateCase: noop,
    },
  };
});

import { CaseDetailFlyout } from './CaseDetailFlyout';

function renderFlyout() {
  return render(
    <EuiProvider colorMode="LIGHT">
      <CaseDetailFlyout caseId="c1" onClose={() => {}} />
    </EuiProvider>,
  );
}

describe('CaseDetailFlyout — collab tab avatars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Notes & feedback tab without throwing on avatar colors', async () => {
    renderFlyout();

    // Wait for the case to load, then open the "Notes & feedback" (collab) tab,
    // which renders the composer + owner avatars that previously crashed.
    const collabTab = await screen.findByText('Notes & feedback');
    fireEvent.click(collabTab);

    // The collab tab's "Rate the AI decision" card is unique to that tab and sits
    // alongside the avatars. Its presence proves the tab rendered fully (the
    // avatars did NOT throw). If EuiAvatar had thrown, the ErrorBoundary fallback
    // ("Something went wrong …") would replace the whole tab body instead.
    await waitFor(() => {
      expect(screen.getByText('Rate the AI decision')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
  });
});
