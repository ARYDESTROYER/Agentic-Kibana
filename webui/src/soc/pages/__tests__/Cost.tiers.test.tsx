/**
 * Cost processing-tier observability.
 *
 * The Console renders only actual UsageDoc.processing_tier attribution returned by
 * the backend. It must never infer Flex from a configured/requested policy, and a
 * standard result is not presented as a confirmed fallback without ledger proof.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const usageSummary = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { usageSummary: (...args: unknown[]) => usageSummary(...args) },
}));
vi.mock('@/soc/demo', () => ({ useDemo: () => ({ active: false }) }));

import Cost from '../Cost';

describe('Cost execution-tier observability', () => {
  beforeEach(() => usageSummary.mockReset());

  it('shows actual standard, Flex, Batch, and unconfirmed ledger values', async () => {
    usageSummary.mockResolvedValue({
      total_cost: 1,
      total_tokens: 10_000,
      call_count: 10,
      today_cost: 1,
      currency: 'USD',
      by_processing_tier: [
        { key: 'standard', calls: 4, tokens: 4_000, cost: 0.4 },
        { key: 'flex', calls: 3, tokens: 3_000, cost: 0.3 },
        { key: 'batch', calls: 2, tokens: 2_000, cost: 0.2 },
        { key: 'unconfirmed', calls: 1, tokens: 1_000, cost: 0.1 },
      ],
      discounted_tier_coverage: {
        calls: 5,
        tokens: 5_000,
        cost: 0.5,
        call_ratio: 0.5,
        token_ratio: 0.5,
        cost_ratio: 0.5,
      },
      processing_tier_attribution: {
        confirmed_calls: 9,
        unconfirmed_calls: 1,
        fallback_calls: null,
        fallback_attribution_available: false,
        requested_policy_inferred: false,
      },
    });

    render(<Cost />);

    const region = await screen.findByRole('region', { name: 'Execution tiers' });
    expect(within(region).getByText('50%')).toBeInTheDocument();
    expect(within(region).getByText('Discounted call coverage')).toBeInTheDocument();
    expect(within(region).getByText('50% of tokens · 50% of recorded spend')).toBeInTheDocument();

    const standard = within(region).getByTestId('processing-tier-standard');
    expect(within(standard).getByText('Standard')).toBeInTheDocument();
    expect(within(standard).getByText('4')).toBeInTheDocument();
    expect(within(standard).getByText('4.0K tokens · $0.4000')).toBeInTheDocument();

    const flex = within(region).getByTestId('processing-tier-flex');
    expect(within(flex).getByText('Flex')).toBeInTheDocument();
    expect(within(flex).getByText('3')).toBeInTheDocument();
    expect(within(flex).getByText('3.0K tokens · $0.3000')).toBeInTheDocument();

    const batch = within(region).getByTestId('processing-tier-batch');
    expect(within(batch).getByText('Batch')).toBeInTheDocument();
    expect(within(batch).getByText('2')).toBeInTheDocument();

    const unknown = within(region).getByTestId('processing-tier-unconfirmed');
    expect(within(unknown).getByText('Unconfirmed')).toBeInTheDocument();
    expect(within(unknown).getByText('1')).toBeInTheDocument();

    expect(
      within(region).getByText(/cannot distinguish an intentional standard request from a Flex fallback/i),
    ).toBeInTheDocument();
    expect(within(region).getByText(/1 call has legacy or unknown tier attribution/i)).toBeInTheDocument();
    expect(within(region).queryByText(/confirmed standard-tier fallback/i)).not.toBeInTheDocument();
  });

  it('states that attribution is unavailable instead of inferring it from totals', async () => {
    usageSummary.mockResolvedValue({
      total_cost: 2,
      total_tokens: 100,
      call_count: 2,
      currency: 'USD',
    });

    render(<Cost />);
    const region = await screen.findByRole('region', { name: 'Execution tiers' });
    await waitFor(() =>
      expect(
        within(region).getByText(/processing-tier attribution is unavailable/i),
      ).toBeInTheDocument(),
    );
    expect(within(region).queryByText('Discounted call coverage')).not.toBeInTheDocument();
  });
});
