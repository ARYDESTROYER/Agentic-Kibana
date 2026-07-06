/**
 * OverviewPanel — the task 7c redesign (clean, scannable case briefing).
 *
 * The overview reads top-to-bottom as: a DECISION BRIEF hero (verdict headline +
 * summary + chip row + recommended action + auto-close note), a 3-column PROVENANCE
 * row (SOURCE SAYS / AGENT FOUND / CODE DECIDED) anchored by the pinned deterministic
 * <DecisionCard>, an ENTITY row (primary entity / attack story / relationship), an
 * EVIDENCE row (checklist + reproduce), and collapsibles (related / provenance & audit).
 *
 * Provenance stays obvious: SIEM facts, AI judgement, and deterministic code are told
 * apart by <ProvenanceTag>. Every case-derived value renders as plain text / CodeBlock
 * (#9); the panel never decides or mutates the case (#3) — the DecisionCard only
 * PROJECTS the recorded deterministic decision.
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
  recommended_action: 'Reset the affected credentials and monitor for re-use.',
  summary: 'Repeated failed logons from 10.0.0.5. Then a success from a new ASN.',
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

describe('OverviewPanel — decision brief (task 7c)', () => {
  it('leads with a verdict headline, one-sentence summary, and the recommended action', () => {
    renderOverview(CASE);
    expect(screen.getByText('Decision brief')).toBeInTheDocument();
    // Verdict → a calm human headline (true_positive → "Likely a true positive").
    expect(screen.getByText('Likely a true positive')).toBeInTheDocument();
    // One-sentence summary (first sentence only).
    expect(screen.getByText(/Repeated failed logons from 10\.0\.0\.5\./)).toBeInTheDocument();
    // Recommended action text is surfaced.
    expect(screen.getByText('Recommended action')).toBeInTheDocument();
    expect(
      screen.getByText(/Reset the affected credentials and monitor for re-use\./),
    ).toBeInTheDocument();
  });

  it('shows the compact chip row (risk N/100, confidence %)', () => {
    renderOverview(CASE);
    // Risk chip "40/100" appears in the brief (also mirrored by the DecisionCard).
    expect(screen.getAllByText('40/100').length).toBeGreaterThanOrEqual(1);
    // Confidence "90%" is surfaced.
    expect(screen.getAllByText('90%').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the auto-close note (a quiet inline note, never a role="alert")', () => {
    render(
      <OverviewPanel
        c={CASE}
        fpPolicy={{ enabled: false, min_confidence: 0.8 }}
        triage={null}
        triageLoading={false}
      />,
    );
    expect(screen.getByText(/Auto-close policy/)).toBeInTheDocument();
    // No error alert (c.error unset) — the auto-close note is not an <Alert>.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('OverviewPanel — provenance row (source vs. agent vs. code)', () => {
  it('renders the three provenance columns, each with its provenance tag', () => {
    renderOverview(CASE);
    expect(screen.getByText('Source says')).toBeInTheDocument();
    expect(screen.getByText('Agent found')).toBeInTheDocument();
    expect(screen.getByText('Code decided')).toBeInTheDocument();
    // SOURCE header = 1 SIEM tag; AGENT header + verdict + confidence = 3 AI tags;
    // CODE header = 1 Code tag. (No source-asserted severity in the base case.)
    expect(screen.getAllByText('SIEM')).toHaveLength(1);
    expect(screen.getAllByText('AI')).toHaveLength(3);
    expect(screen.getAllByText('Code')).toHaveLength(1);
  });

  it('surfaces a source-asserted severity with its SIEM tag under "Source says"', () => {
    renderOverview({
      ...CASE,
      severity_band: 'high',
      severity_source: 'source_asserted',
    } as unknown as Case);
    expect(screen.getByText(/The source rated this alert High severity\./)).toBeInTheDocument();
    // Header SIEM tag + the per-severity SIEM tag = two.
    expect(screen.getAllByText('SIEM')).toHaveLength(2);
  });

  it('shows the delta cue when the source severity and our risk band DISAGREE', () => {
    // Source says High; risk 40 lands in the Medium band → they disagree.
    renderOverview({
      ...CASE,
      risk_score: 40,
      severity_band: 'high',
      severity_source: 'source_asserted',
    } as unknown as Case);
    const delta = screen.getByTestId('source-assessment-delta');
    expect(delta.textContent).toContain('High');
    expect(delta.textContent).toContain('Medium');
  });

  it('hides the delta cue when the source severity and our risk band AGREE', () => {
    // Source says High; risk 50 also lands in the High band → no delta.
    renderOverview({
      ...CASE,
      risk_score: 50,
      severity_band: 'high',
      severity_source: 'source_asserted',
    } as unknown as Case);
    expect(screen.queryByTestId('source-assessment-delta')).toBeNull();
  });

  it('never shows the delta cue OR a "Reported severity" row for a DERIVED severity', () => {
    renderOverview({
      ...CASE,
      risk_score: 40,
      severity_band: 'high',
      severity_source: 'derived',
    } as unknown as Case);
    expect(screen.queryByTestId('source-assessment-delta')).toBeNull();
    expect(screen.queryByText('Reported severity')).toBeNull();
  });

  it('shows the "Auto-closed by AI" marker (on the pinned DecisionCard) only when the AI closed it (#11)', () => {
    // Open case decided by the pipeline → NOT auto-closed → no marker.
    renderOverview(CASE);
    expect(screen.queryByText('Auto-closed by AI')).toBeNull();

    // Terminal status + decision_by === 'agent' → the AI auto-closed it.
    renderOverview({ ...CASE, status: 'closed', decision_by: 'agent' } as unknown as Case);
    expect(screen.getByText('Auto-closed by AI')).toBeInTheDocument();
  });
});

describe('OverviewPanel — entity, story, evidence, reproduce (task 7c)', () => {
  it('renders the primary entity, attack story, and entity-relationship cards', () => {
    renderOverview({
      ...CASE,
      entity: { type: 'ip', value: '10.0.0.5' },
    } as unknown as Case);
    expect(screen.getByText('Primary entity')).toBeInTheDocument();
    // The entity value renders inside an InlineCode fence (#9) + the relationship flow.
    expect(screen.getAllByText('10.0.0.5').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Attack story')).toBeInTheDocument();
    expect(screen.getByText('Agent searched the logs')).toBeInTheDocument();
    expect(screen.getByText('Entity relationship')).toBeInTheDocument();
  });

  it('renders the evidence checklist + a reproduce panel labelled "Search query" (not "Command Line")', () => {
    renderOverview(CASE);
    expect(screen.getByText('Evidence checklist')).toBeInTheDocument();
    // One positive finding row → a "Found" result.
    expect(screen.getByText('Found')).toBeInTheDocument();
    // The read-only query is a SEARCH query, never a shell "Command Line".
    expect(screen.getByText('Reproduce investigation')).toBeInTheDocument();
    expect(screen.getByText('Search query')).toBeInTheDocument();
    expect(screen.queryByText('Command Line')).toBeNull();
  });

  it('folds the lower-value sections into a "Provenance & audit" disclosure', () => {
    renderOverview(CASE);
    expect(screen.getByText('Provenance & audit')).toBeInTheDocument();
    // No cross-source linkage → the "Related cases" disclosure is not rendered.
    expect(screen.queryByText('Related cases')).toBeNull();
  });
});

describe('OverviewPanel — MITRE summary', () => {
  it('surfaces a compact MITRE finding that points at the Threat context tab', () => {
    renderOverview({ ...CASE, mitre: ['T1110', 'T1078'] } as unknown as Case);
    // "2 MITRE techniques mapped" appears in BOTH the agent-found bullet and the mini
    // attack-story step — so match all, then pin the tab pointer (unique to the bullet).
    expect(screen.getAllByText(/2 MITRE techniques mapped/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Threat context tab/i)).toBeInTheDocument();
  });
});

describe('riskFactorBarColor (#29 — shares the ONE palette scoreBand ladder 74/48/22)', () => {
  it('maps a factor score to the same band cut-points as every risk-coloured element', () => {
    expect(riskFactorBarColor(10)).toBe('bg-low'); // <22
    expect(riskFactorBarColor(25)).toBe('bg-medium'); // >=22
    expect(riskFactorBarColor(50)).toBe('bg-high'); // >=48
    expect(riskFactorBarColor(80)).toBe('bg-critical'); // >=74
  });
});
