/**
 * Scans page — Round-6 sweep regressions.
 *
 * Covers the board's status/KPI/error fixes:
 *   - a fetch error shows ONLY the error (no zeroed KPIs, no "0 of 0" toolbar, no
 *     misleading "scans are off" empty state),
 *   - the "Open" tab captures the extended status taxonomy (investigating/etc.),
 *     not just the literal 'open' status, and the pill counts sum to "All",
 *   - the "Needs human" KPI tile count matches the rows shown after clicking it,
 *   - the controls toolbar does not flash "Showing 0 of 0" during the first load.
 *
 * `@/lib/api` and the heavy CaseDetail sheet are mocked (no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Case } from '@/lib/types';

const { scansMock, notifMock } = vi.hoisted(() => ({
  scansMock: vi.fn(),
  notifMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, scans: scansMock, scanNotifications: notifMock },
  };
});

vi.mock('@/soc/pages/CaseDetail', () => ({ CaseDetail: () => null }));

import { TooltipProvider } from '@/ui/tooltip';
import ScansPage from '../Scans';

function mk(partial: Partial<Case>): Case {
  return {
    case_id: partial.case_id || 'case-x',
    title: partial.title,
    status: partial.status,
    verdict: partial.verdict,
    risk_score: partial.risk_score ?? 10,
    created_at: partial.created_at || '2026-07-01T00:00:00Z',
    ...partial,
  } as Case;
}

function renderPage() {
  return render(
    <TooltipProvider>
      <ScansPage />
    </TooltipProvider>,
  );
}

describe('Scans — Round-6 sweep', () => {
  beforeEach(() => {
    scansMock.mockReset();
    notifMock.mockReset();
    notifMock.mockResolvedValue({ new_count: 0 });
  });

  it('shows only the error on a fetch failure — no zeroed KPIs or "scans are off" empty state', async () => {
    scansMock.mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Could not load scan cases')).toBeInTheDocument(),
    );
    // The misleading calm states must NOT co-render with the error banner.
    expect(screen.queryByText('No scan cases yet')).toBeNull();
    expect(screen.queryByText('Scanned cases')).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it('counts an investigating case under "Open" and keeps pill counts summing to All', async () => {
    scansMock.mockResolvedValue({
      cases: [
        mk({ case_id: 'c-open', status: 'investigating', verdict: 'true_positive', title: 'Investigating one' }),
        mk({ case_id: 'c-closed', status: 'closed', verdict: 'benign', title: 'Closed one', created_at: '2026-06-30T00:00:00Z' }),
      ],
    });
    renderPage();

    // Both visible under the default "All" tab.
    await waitFor(() => expect(screen.getByText('Investigating one')).toBeInTheDocument());
    expect(screen.getByText('Closed one')).toBeInTheDocument();

    // Pills: All 2 / Open 1 / Needs human 0 / Closed 1. The status filter is a
    // SegmentedControl (Radix RadioGroup → role="radio"), not a tab surface.
    expect(screen.getByRole('radio', { name: /all 2/i })).toBeInTheDocument();
    const openTab = screen.getByRole('radio', { name: /open 1/i });
    expect(openTab).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /closed 1/i })).toBeInTheDocument();

    // Filtering to Open shows the investigating case and hides the closed one.
    await userEvent.click(openTab);
    await waitFor(() => expect(screen.queryByText('Closed one')).toBeNull());
    expect(screen.getByText('Investigating one')).toBeInTheDocument();
  });

  it('makes the "Needs human" tile agree with the rows shown after clicking it', async () => {
    scansMock.mockResolvedValue({
      cases: [
        // verdict signals needs-human even though the status is not literally 'needs_human'.
        mk({ case_id: 'c-nh', status: 'open', verdict: 'NEEDS_HUMAN', title: 'Needs a human' }),
        mk({ case_id: 'c-ok', status: 'closed', verdict: 'benign', title: 'Benign one', created_at: '2026-06-30T00:00:00Z' }),
      ],
    });
    renderPage();

    const tile = await screen.findByTestId('kpi-needs-human');
    // The tile counts the verdict-signalled case.
    expect(tile).toHaveTextContent('1');
    // The Needs-human pill matches the tile (both use the same bucket predicate).
    expect(screen.getByRole('radio', { name: /needs human 1/i })).toBeInTheDocument();

    // Clicking the tile filters to needs-human and the case is still shown (no drop).
    fireEvent.click(tile);
    await waitFor(() => expect(screen.queryByText('Benign one')).toBeNull());
    expect(screen.getByText('Needs a human')).toBeInTheDocument();
  });

  it('does not flash "Showing 0 of 0" while the first fetch is in flight', () => {
    // A never-resolving fetch keeps the page in its initial loading state.
    scansMock.mockReturnValue(new Promise<never>(() => {}));
    renderPage();

    // The toolbar (SegmentedControl segments + "Showing N of M") is a skeleton, not live.
    expect(screen.queryByText(/Showing/)).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
