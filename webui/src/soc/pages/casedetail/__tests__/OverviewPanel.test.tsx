/**
 * OverviewPanel — IOC-query labelling + Round-7 D1b panel dedup.
 *
 *   #18 (Round-6): the read-only es_query search queries are labelled "Search query",
 *        NOT "Command Line" (which implied a shell command ran on the endpoint).
 *   #29 (Round-6): `riskFactorBarColor` shares the ONE palette scoreBand ladder
 *        (74/48/22) — kept as an exported helper even though the standalone
 *        risk-breakdown bars were removed from the overview in Round-7.
 *   Round-7 D1b: the secondary badge row was replaced by a concise header strip with
 *        provenance tags (verdict/confidence = AI, risk = code) + a self-hiding
 *        "Auto-closed by AI" marker; the standalone "Risk breakdown" card was removed
 *        (it lives in the investigation view); MITRE was compacted to a summary that
 *        points at the Threat context tab.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  api: {
    listCases: vi.fn().mockResolvedValue({ cases: [] }),
    get: vi.fn().mockResolvedValue({ found: false }),
  },
}));

import { OverviewPanel, riskFactorBarColor } from '../OverviewPanel';
import type { Case } from '@/lib/types';

const CASE = {
  case_id: 'c1',
  status: 'open',
  verdict: 'true_positive',
  risk_score: 40,
  confidence: 0.9,
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

function renderOverview(c: Case) {
  return render(<OverviewPanel c={c} fpPolicy={null} triage={null} triageLoading={false} />);
}

describe('OverviewPanel', () => {
  it('labels read-only search queries "Search query", not "Command Line" (#18)', () => {
    renderOverview(CASE);
    expect(screen.getByText('Search query')).toBeInTheDocument();
    expect(screen.queryByText('Command Line')).toBeNull();
  });

  it('drops the standalone "Risk breakdown" card (moved out of the overview) (D1b)', () => {
    renderOverview(CASE);
    // The old risk-breakdown card + its "Risk 30" total badge are gone; the overview
    // no longer shows the factor bars (they lived only in that card).
    expect(screen.queryByText('Risk breakdown')).toBeNull();
    expect(screen.queryByRole('progressbar', { name: 'Volume' })).toBeNull();
    expect(screen.queryByText('Risk 30')).toBeNull();
    // The Recommended action card is KEPT.
    expect(screen.getByText('Recommended action')).toBeInTheDocument();
  });
});

describe('OverviewPanel — header strip provenance (Round-7 #9b / D1b)', () => {
  it('tags verdict + confidence as AI and risk as code', () => {
    renderOverview(CASE);
    // Two AI provenance tags (verdict + confidence) and one code tag (risk).
    expect(screen.getAllByText('AI')).toHaveLength(2);
    expect(screen.getByText('Code')).toBeInTheDocument();
  });

  it('shows the "Auto-closed by AI" marker only when the AI closed the case (#11)', () => {
    // Open case decided by the pipeline → NOT auto-closed → no marker.
    renderOverview(CASE);
    expect(screen.queryByText('Auto-closed by AI')).toBeNull();

    // Terminal status + decision_by === 'agent' → the AI auto-closed it.
    renderOverview({ ...CASE, status: 'closed', decision_by: 'agent' } as unknown as Case);
    expect(screen.getByText('Auto-closed by AI')).toBeInTheDocument();
  });
});

describe('OverviewPanel — compact MITRE summary (D1b)', () => {
  it('renders a compact MITRE summary that points at the Threat context tab', () => {
    renderOverview({ ...CASE, mitre: ['T1110', 'T1078'] } as unknown as Case);
    expect(screen.getByText('MITRE ATT&CK')).toBeInTheDocument();
    expect(screen.getByText('T1110')).toBeInTheDocument();
    expect(screen.getByText('T1078')).toBeInTheDocument();
    // The full detail is delegated to the Threat context tab.
    expect(screen.getByText(/Threat context tab/i)).toBeInTheDocument();
  });

  it('caps the visible technique chips and shows a "+N more" overflow badge', () => {
    const many = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];
    renderOverview({ ...CASE, mitre: many } as unknown as Case);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    // The 7th/8th ids are folded into the overflow badge, not rendered as chips.
    expect(screen.queryByText('T7')).toBeNull();
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
