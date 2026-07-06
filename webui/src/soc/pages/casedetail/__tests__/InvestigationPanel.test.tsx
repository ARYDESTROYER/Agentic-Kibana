/**
 * InvestigationPanel — the "Investigation" tab (task 5 split).
 *
 * Task 5 moved the "what happened" six-stage narrative out to the sibling
 * <TimelinePanel>, so this panel is now the investigation proper: the AI assessment
 * (WhyPanel reasoning), the pinned deterministic DecisionCard, and the collapsible full
 * ReAct trace. Verifies the two lanes render in order (AI ASSESSMENT → pinned DECISION),
 * that the AI lane is persistently AI-marked, that the raw ReAct trace stays behind a
 * "Full agent trace" disclosure, and that opening it lazy-loads the timeline when the
 * parent hasn't fetched it yet.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { InvestigationPanel, type InvestigationPanelProps } from '../InvestigationPanel';
import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';

expect.extend(toHaveNoViolations);

const CASE = {
  case_id: 'c1',
  verdict: 'true_positive',
  status: 'escalated',
  decision_by: 'agent',
  risk_score: 72,
} as unknown as Case;

const RATIONALE = {
  case_id: 'c1',
  reasoning: 'Repeated failed logons then a success from a new ASN — credential stuffing.',
} as unknown as CaseRationale;

const decisionSpan: TraceSpan = {
  step_index: 5,
  kind: 'decision',
  name: 'case_manager',
  ts: '2026-07-05T00:00:00Z',
  latency_ms: null,
  cost: null,
  tokens: null,
  trusted: true,
  summary: 'Escalated to a human analyst.',
  payload_ref: {
    verdict: 'true_positive',
    decision_status: 'escalated',
    decision_by: 'agent',
    escalate: true,
    policy_clause: { verdict_class: 'true_positive', auto_closable: false },
  },
};

const TIMELINE: TimelineResponse = {
  case_id: 'c1',
  total: 1,
  totals: { cost: 0, tokens: 0 },
  spans: [decisionSpan],
};

function props(over: Partial<InvestigationPanelProps> = {}): InvestigationPanelProps {
  return {
    c: CASE,
    rationale: RATIONALE,
    rationaleLoading: false,
    rationaleError: null,
    onRetryRationale: vi.fn(),
    timeline: TIMELINE,
    timelineLoading: false,
    timelineError: null,
    onRetryTimeline: vi.fn(),
    ...over,
  };
}

describe('InvestigationPanel — the AI-assessment + decision story', () => {
  it('renders AI ASSESSMENT → DECISION in order', () => {
    render(<InvestigationPanel {...props()} />);

    // 1. AI ASSESSMENT lane — marked "AI", showing the WhyPanel reasoning (not decision).
    expect(screen.getByText('AI assessment')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('Agent reasoning')).toBeInTheDocument();
    expect(
      screen.getByText(/Repeated failed logons then a success from a new ASN/),
    ).toBeInTheDocument();

    // 2. DECISION lane — the pinned deterministic authority card.
    expect(screen.getByRole('region', { name: 'Decision' })).toBeInTheDocument();
    expect(screen.getByText('Deterministic decision')).toBeInTheDocument();
  });

  it('no longer renders the "what happened" stage narrative (moved to TimelinePanel)', () => {
    render(<InvestigationPanel {...props()} />);
    expect(screen.queryByText('What happened')).toBeNull();
  });

  it('hides the WhyPanel decision summary (the DecisionCard is the sole authority)', () => {
    render(<InvestigationPanel {...props()} />);
    // hideDecision ⇒ the WhyPanel's own "Deterministic decision" Alert title is gone;
    // the only decision heading is the pinned DecisionCard's.
    expect(screen.getAllByText('Deterministic decision')).toHaveLength(1);
    // The pinned card reads the clause off the timeline (proves the timeline prop flows).
    expect(screen.getByText('Policy clause evaluated')).toBeInTheDocument();
  });

  it('keeps the raw ReAct trace behind a "Full agent trace" disclosure', () => {
    render(<InvestigationPanel {...props()} />);
    const trigger = screen.getByRole('button', { name: /full agent trace/i });
    expect(trigger).toBeInTheDocument();
  });

  it('lazy-loads the timeline when the disclosure opens and none is loaded yet', () => {
    const onRetryTimeline = vi.fn();
    render(
      <InvestigationPanel
        {...props({
          timeline: null,
          timelineLoading: false,
          timelineError: null,
          onRetryTimeline,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /full agent trace/i }));
    expect(onRetryTimeline).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch the timeline on open when it is already loaded', () => {
    const onRetryTimeline = vi.fn();
    render(<InvestigationPanel {...props({ onRetryTimeline })} />);
    fireEvent.click(screen.getByRole('button', { name: /full agent trace/i }));
    expect(onRetryTimeline).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const { container } = render(<InvestigationPanel {...props()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
