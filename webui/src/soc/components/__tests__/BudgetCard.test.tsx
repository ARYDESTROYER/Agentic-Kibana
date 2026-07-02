/**
 * BudgetCard — Round-6 ceiling-input fixes.
 *
 *   - parseCeiling: empty → null ("no limit"), finite ≥0 → the number, garbage/negative
 *     keeps the previous value.
 *   - The daily/monthly ceiling fields keep the RAW text while typing so intermediate
 *     decimal states ("10.", "10.50") survive, and commit a parsed number on blur — a
 *     plain <Input type="number"> bound to the parsed value stripped a trailing dot/zero
 *     and made decimals unenterable.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/soc/pages/Models.api', () => ({
  modelsApi: {
    getBudget: vi.fn(),
    budgetStatus: vi.fn(),
    putBudget: vi.fn(),
  },
}));

import { BudgetCard, parseCeiling } from '../BudgetCard';
import { modelsApi } from '@/soc/pages/Models.api';

describe('parseCeiling', () => {
  it('maps empty / whitespace to null (no limit)', () => {
    expect(parseCeiling('', 5)).toBeNull();
    expect(parseCeiling('   ', 5)).toBeNull();
  });

  it('parses a finite non-negative number', () => {
    expect(parseCeiling('10.5', null)).toBe(10.5);
    expect(parseCeiling('0', 5)).toBe(0);
  });

  it('keeps the previous value for garbage or negative input', () => {
    expect(parseCeiling('abc', 5)).toBe(5);
    expect(parseCeiling('-3', 5)).toBe(5);
    expect(parseCeiling('abc', null)).toBeNull();
  });
});

describe('BudgetCard ceiling input', () => {
  beforeEach(() => {
    (modelsApi.getBudget as Mock).mockResolvedValue({
      budget: {
        enabled: true,
        daily_usd: 5,
        monthly_usd: null,
        soft_warn_pct: 0.8,
        on_exceed: 'warn',
      },
    });
    // budgetStatus rejects here → BudgetCard swallows it (no live-spend section).
    (modelsApi.budgetStatus as Mock).mockRejectedValue(new Error('no status'));
  });

  it('preserves raw decimal text while typing and commits a number on blur', async () => {
    render(<BudgetCard />);
    const input = (await screen.findByLabelText('Daily ceiling (USD)')) as HTMLInputElement;

    // A trailing zero survives while typing (the old number-bound input collapsed it).
    fireEvent.change(input, { target: { value: '10.50' } });
    expect(input.value).toBe('10.50');

    // A lone trailing dot is enterable too.
    fireEvent.change(input, { target: { value: '10.' } });
    expect(input.value).toBe('10.');

    // On blur the raw text is parsed + normalised to the committed number.
    fireEvent.change(input, { target: { value: '10.50' } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe('10.5'));
  });
});
