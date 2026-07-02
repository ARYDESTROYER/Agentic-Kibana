/**
 * Cost — Round-6 window-switch fetch-race guard.
 *
 * Switching the time window fires a fresh /usage/summary request. Only the
 * LATEST-issued request may commit, so a slow earlier window can never clobber the
 * current one. We drive two overlapping requests and resolve them out of order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/demo', () => ({ useDemo: () => ({ active: false }) }));

type Deferred = { resolve: (v: unknown) => void };
const pending = new Map<number, Deferred>();
const usageSummary = vi.fn(
  (hours: number) => new Promise((resolve) => pending.set(hours, { resolve })),
);

vi.mock('@/lib/api', () => ({
  api: { usageSummary: (h: number) => usageSummary(h) },
}));

import Cost from '../Cost';

const summary = (total: number) => ({
  total_cost: total,
  call_count: 3,
  currency: 'USD',
  total_tokens: 0,
  today_cost: 0,
});

describe('Cost window-switch race', () => {
  beforeEach(() => {
    pending.clear();
    usageSummary.mockClear();
  });

  it('ignores a stale earlier-window response that resolves last', async () => {
    render(<Cost />);

    // The initial 24h load is in flight.
    await waitFor(() => expect(pending.has(24)).toBe(true));

    // Switch the time window to 7d (168h) — a second request is issued. The window
    // switch is a SegmentedControl (Radix RadioGroup → role="radio"); a click selects.
    await userEvent.click(screen.getByRole('radio', { name: '7d' }));
    await waitFor(() => expect(pending.has(24 * 7)).toBe(true));

    // Resolve the LATEST (7d) request first; its total should render.
    pending.get(24 * 7)!.resolve(summary(99));
    await waitFor(() => expect(screen.getByText('$99.00')).toBeInTheDocument());

    // Now the STALE 24h request resolves — it must NOT clobber the 7d view.
    pending.get(24)!.resolve(summary(1));
    await waitFor(() => expect(usageSummary).toHaveBeenCalledTimes(2));

    expect(screen.getByText('$99.00')).toBeInTheDocument();
    expect(screen.queryByText('$1.00')).not.toBeInTheDocument();
  });
});
