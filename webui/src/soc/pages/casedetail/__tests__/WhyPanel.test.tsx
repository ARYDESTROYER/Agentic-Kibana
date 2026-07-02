/**
 * WhyPanel — enrichment-card presence (Round-6 finding #20).
 *
 * The Enrichment card only renders the reputation_score / is_malicious / country tiles,
 * but a fail-open enrichment result can be a truthy object with none of them. It must
 * then be treated as empty (no heading-only card), and shown only when it has content.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { WhyPanel } from '../WhyPanel';
import type { Case, CaseRationale } from '@/lib/types';

const CASE = { case_id: 'c1', verdict: 'true_positive', status: 'open' } as unknown as Case;
const rationaleWith = (enrichment: unknown): CaseRationale =>
  ({ verdict: 'true_positive', status: 'open', enrichment } as unknown as CaseRationale);

describe('WhyPanel — Enrichment card', () => {
  it('hides the card when enrichment has none of the displayed fields (#20)', () => {
    render(
      <WhyPanel
        c={CASE}
        rationale={rationaleWith({ asn: 5, org: 'evil-corp' })}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText('Enrichment')).toBeNull();
  });

  it('shows the card when a displayed field is present', () => {
    render(
      <WhyPanel
        c={CASE}
        rationale={rationaleWith({ reputation_score: 80 })}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('Enrichment')).toBeInTheDocument();
    expect(screen.getByText('Reputation score')).toBeInTheDocument();
  });
});

describe('WhyPanel — knowledge source fallback (#31)', () => {
  it('labels a snippet with an empty source "Knowledge", not a bare dash', () => {
    const rationale = {
      verdict: 'true_positive',
      status: 'open',
      knowledge: [{ source: '', snippet: 'runbook excerpt' }],
    } as unknown as CaseRationale;
    render(
      <WhyPanel c={CASE} rationale={rationale} loading={false} error={null} onRetry={vi.fn()} />,
    );
    expect(screen.getByText('Knowledge')).toBeInTheDocument();
    // The DASH glyph (—) must NOT be used as the source label.
    expect(screen.queryByText('—')).toBeNull();
  });
});

describe('WhyPanel — error state (#33)', () => {
  it('renders the shared LoadError (coerced message + Retry) instead of a hand-rolled Alert', () => {
    const onRetry = vi.fn();
    render(
      <WhyPanel
        c={CASE}
        rationale={null}
        loading={false}
        error={new Error('backend exploded')}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('Could not load decision rationale')).toBeInTheDocument();
    // LoadError coerces the caught value through errorMessage() (not "Something went wrong.").
    expect(screen.getByText('backend exploded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
