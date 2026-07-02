/**
 * OverviewPanel — risk-breakdown scaling + IOC-query labelling (Round-6 findings).
 *
 *   #17: the risk_breakdown factors are ABSOLUTE 0-100 scores, so their bars are drawn
 *        `width: value%` (NOT normalised to the largest factor, which drew e.g. Volume
 *        40 as a full "100%" bar and disagreed with the triage RiskCard).
 *   #18: the read-only es_query search queries are labelled "Search query", NOT
 *        "Command Line" (which implied a shell command ran on the endpoint).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ api: { listCases: vi.fn().mockResolvedValue({ cases: [] }) } }));

import { OverviewPanel, riskFactorBarColor } from '../OverviewPanel';
import type { Case } from '@/lib/types';

const CASE = {
  case_id: 'c1',
  status: 'open',
  verdict: 'true_positive',
  risk_score: 40,
  evidence: [{ query: 'event.action:login and source.ip:10.0.0.5', summary: 'auth spike observed' }],
  risk_breakdown: {
    volume: 40,
    velocity: 10,
    reputation: 0,
    diversity: 0,
    asset_criticality: 0,
    total: 30,
  },
} as unknown as Case;

describe('OverviewPanel', () => {
  it('draws risk-factor bars on an ABSOLUTE 0-100 scale, not max-normalised (#17)', () => {
    render(
      <OverviewPanel c={CASE} fpPolicy={null} triage={null} triageLoading={false} />,
    );
    // Volume is the largest factor (40). Max-normalisation would report 100; the
    // absolute scale reports its real value 40.
    const volumeBar = screen.getByRole('progressbar', { name: 'Volume' });
    expect(volumeBar).toHaveAttribute('aria-valuenow', '40');
    // The misleading trailing "%" (share-of-max) is gone.
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('labels read-only search queries "Search query", not "Command Line" (#18)', () => {
    render(
      <OverviewPanel c={CASE} fpPolicy={null} triage={null} triageLoading={false} />,
    );
    expect(screen.getByText('Search query')).toBeInTheDocument();
    expect(screen.queryByText('Command Line')).toBeNull();
  });

  it('renders the Total risk with its default "Risk" label (no stray leading space) (#30)', () => {
    const { container } = render(
      <OverviewPanel c={CASE} fpPolicy={null} triage={null} triageLoading={false} />,
    );
    // rb.total = 30 (distinct from risk_score 40) → the total badge reads "Risk 30",
    // not a bare " 30" produced by the old label="" (which left a leading space).
    expect(container.textContent).toContain('Risk 30');
  });
});

describe('riskFactorBarColor (#29 — shares the ONE palette scoreBand ladder 74/48/22)', () => {
  it('maps a factor score to the same band cut-points as every risk-coloured element', () => {
    expect(riskFactorBarColor(10)).toBe('bg-low'); // <22
    expect(riskFactorBarColor(25)).toBe('bg-medium'); // >=22 (old 80/60/35 ladder said low)
    expect(riskFactorBarColor(50)).toBe('bg-high'); // >=48 (old ladder said medium)
    expect(riskFactorBarColor(80)).toBe('bg-critical'); // >=74
  });
});
