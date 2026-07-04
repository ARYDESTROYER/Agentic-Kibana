/**
 * DecisionCard — the pinned deterministic-decision authority card (Round-7 #9a).
 *
 * Verifies the card reads the EXACT AutoClosePolicy clause off the terminal `decision`
 * TraceSpan in the timeline prop, surfaces the verdict/status/confidence + "Decided by",
 * flags an AI auto-close, shows the objection window, and degrades cleanly when no
 * timeline (and thus no clause) is available — falling back to the case fields.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { DecisionCard } from '../DecisionCard';
import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';

expect.extend(toHaveNoViolations);

const FUTURE_ISO = new Date(Date.now() + 3_600_000).toISOString();

const decisionSpan = (payload: Record<string, unknown>): TraceSpan => ({
  step_index: 9,
  kind: 'decision',
  name: 'case_manager',
  ts: '2026-07-05T00:00:00Z',
  latency_ms: null,
  cost: null,
  tokens: null,
  trusted: true,
  summary: 'Auto-closed as false positive: confidence 0.92 ≥ 0.8 bar and risk 12 ≤ 40.',
  payload_ref: payload,
});

/** A timeline whose terminal span carries the exact policy clause decide() evaluated. */
const TIMELINE: TimelineResponse = {
  case_id: 'c1',
  total: 2,
  totals: { cost: 0, tokens: 0 },
  spans: [
    { ...decisionSpan({}), kind: 'invoke_agent', name: 'investigator', step_index: 0 },
    decisionSpan({
      deterministic: true,
      verdict: 'false_positive',
      confidence: 0.92,
      risk_score: 12,
      decision_status: 'closed',
      decision_by: 'agent',
      escalate: false,
      objection_window_expires_at: FUTURE_ISO,
      policy_clause: {
        verdict_class: 'false_positive',
        auto_closable: true,
        enabled: true,
        min_confidence: 0.8,
        max_risk_score: 40,
        objection_window_minutes: 30,
      },
    }),
  ],
};

const CASE = {
  case_id: 'c1',
  verdict: 'false_positive',
  status: 'closed',
  decision_by: 'agent',
  risk_score: 12,
} as unknown as Case;

const RATIONALE = {
  case_id: 'c1',
  decision_rationale: 'FP auto-close bar met; scheduled behind a 30-minute objection window.',
} as unknown as CaseRationale;

describe('DecisionCard — policy clause from the timeline fixture', () => {
  it('reads the matched AutoClosePolicy clause off the terminal decision span', () => {
    render(<DecisionCard c={CASE} rationale={RATIONALE} timeline={TIMELINE} />);

    // The clause block is present and shows the exact thresholds decide() compared.
    expect(screen.getByText('Policy clause evaluated')).toBeInTheDocument();
    expect(screen.getByText('eligible')).toBeInTheDocument(); // auto_closable: true
    expect(screen.getByText('0.8')).toBeInTheDocument(); // min_confidence
    expect(screen.getByText('40')).toBeInTheDocument(); // max_risk_score
    // verdict_class humanized appears in the clause (and the verdict badge).
    expect(screen.getAllByText('False positive').length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces the decide() inputs (verdict / confidence / risk / result) + who decided', () => {
    render(<DecisionCard c={CASE} rationale={RATIONALE} timeline={TIMELINE} />);
    expect(screen.getByText('Deterministic decision')).toBeInTheDocument();
    // Confidence fact = round(0.92*100) = 92%.
    expect(screen.getAllByText('92%').length).toBeGreaterThanOrEqual(1);
    // Risk fact = 12/100 (from the span payload).
    expect(screen.getByText('12/100')).toBeInTheDocument();
    // decision_by 'agent' → the pipeline, not a human.
    expect(screen.getByText(/Decided by Automated/)).toBeInTheDocument();
  });

  it('flags an AI auto-close + the deterministic rationale (#3 authority)', () => {
    render(<DecisionCard c={CASE} rationale={RATIONALE} timeline={TIMELINE} />);
    // status closed + decision_by agent ⇒ AutoClosedBadge shows, with the reopen window.
    expect(screen.getByText(/Auto-closed by AI/)).toBeInTheDocument();
    expect(screen.getByText(/reopen before/)).toBeInTheDocument();
    // The deterministic rationale string is rendered as plain prose.
    expect(
      screen.getByText(/FP auto-close bar met; scheduled behind a 30-minute objection window\./),
    ).toBeInTheDocument();
  });

  it('shows an Escalate flag when the decision escalated', () => {
    const escalated: TimelineResponse = {
      ...TIMELINE,
      spans: [
        decisionSpan({
          verdict: 'needs_human',
          decision_status: 'escalated',
          decision_by: 'agent',
          escalate: true,
          policy_clause: { verdict_class: 'needs_human', auto_closable: false },
        }),
      ],
    };
    render(<DecisionCard c={CASE} rationale={null} timeline={escalated} />);
    expect(screen.getByText('Escalate')).toBeInTheDocument();
    expect(screen.getByText('off')).toBeInTheDocument(); // auto_closable false
  });

  it('degrades to the case fields and hides the clause block when no timeline', () => {
    render(<DecisionCard c={CASE} rationale={RATIONALE} timeline={null} />);
    // No decision span ⇒ no clause block.
    expect(screen.queryByText('Policy clause evaluated')).toBeNull();
    // But the card still renders the verdict/status derived from the case.
    expect(screen.getByText('Deterministic decision')).toBeInTheDocument();
    expect(screen.getAllByText('False positive').length).toBeGreaterThanOrEqual(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <DecisionCard c={CASE} rationale={RATIONALE} timeline={TIMELINE} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
