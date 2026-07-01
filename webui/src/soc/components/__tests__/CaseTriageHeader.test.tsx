/**
 * CaseTriageHeader — Group 5 / #12 coverage.
 *
 * Pins the honesty contract: the header renders FOUR distinct chips (RISK / SEVERITY
 * / IMPACT / PRIORITY) that show DIFFERENT values — they are NOT all derived from the
 * one risk number. Also covers the loading skeleton and the "(derived)" honesty badge
 * when a source never asserted a severity.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { CaseTriageHeader, RISK_FACTOR_HELP, RISK_HELP_TEXT } from '../CaseTriageHeader';
import type { TriageChips } from '@/soc/pages/CaseDetail.api';

/** A fully-populated chip set where every signal is deliberately DIFFERENT. */
const CHIPS: TriageChips = {
  risk: {
    value: 82,
    band: 'high',
    breakdown: { volume: 40, velocity: 90, reputation: 10, diversity: 55, asset_criticality: 70 },
    inputs: { definition: 'Deterministic 0-100 risk blend.' },
  },
  severity: {
    band: 'medium',
    value: 50,
    raw: 5,
    source: 'source_asserted',
    inputs: { definition: 'Max source-asserted severity.', severity_max: 5, severity_min: 2 },
  },
  impact: {
    band: 'low',
    value: 20,
    criticality: 20,
    entity: '10.0.0.5',
    inputs: { definition: 'Asset criticality.', entity_type: 'ip', entity_value: '10.0.0.5' },
  },
  priority: {
    level: 'P2',
    impact: 'low',
    matched: true,
    default: 'P3',
    urgency: { band: 'high', value: 82, escalated: false },
    inputs: { definition: 'ITIL Impact x Urgency.', impact_band: 'low', urgency_band: 'high' },
  },
};

describe('CaseTriageHeader (#12 four honest chips)', () => {
  it('renders four distinct chips with values that are NOT all the risk number', () => {
    const { container } = render(<CaseTriageHeader chips={CHIPS} />);

    // The four chips are present.
    expect(screen.getByText('Risk')).toBeInTheDocument();
    const severity = screen.getByTestId('triage-chip-severity');
    const impact = screen.getByTestId('triage-chip-impact');
    const priority = screen.getByTestId('triage-chip-priority');
    expect(severity).toBeInTheDocument();
    expect(impact).toBeInTheDocument();
    expect(priority).toBeInTheDocument();

    // Risk shows its 0-100 value (82) via the gauge (rendered in the header region).
    expect(container.textContent).toContain('82');
    // Severity is its OWN band (Medium), not the risk's High.
    expect(severity.textContent).toContain('Medium');
    // Impact is its OWN band (Low).
    expect(impact.textContent).toContain('Low');
    // Priority shows the derived P-level (P2), not a band copied from risk.
    expect(priority.textContent).toContain('P2');

    // Honesty assertion: the four chip headlines are NOT identical (the old bug was
    // severity/impact/priority all === the risk band).
    const sevBand = severity.textContent || '';
    const impBand = impact.textContent || '';
    expect(sevBand).not.toBe(impBand);
  });

  it('badges a severity with no source rating as "derived"', () => {
    const derivedChips: TriageChips = {
      ...CHIPS,
      severity: { band: 'low', value: 12, raw: null, source: 'derived', inputs: {} },
    };
    render(<CaseTriageHeader chips={derivedChips} />);
    const severity = screen.getByTestId('triage-chip-severity');
    expect(severity.textContent?.toLowerCase()).toContain('derived');
  });

  it('shows the asset-criticality on the impact chip', () => {
    render(<CaseTriageHeader chips={CHIPS} />);
    const impact = screen.getByTestId('triage-chip-impact');
    // "asset criticality 20/100" — the impact chip is honestly about the asset.
    expect(impact.textContent?.toLowerCase()).toContain('asset criticality');
    expect(impact.textContent).toContain('20');
  });

  it('renders four skeletons while loading', () => {
    const { container } = render(<CaseTriageHeader chips={null} loading />);
    const skeletons = container.querySelectorAll('.animate-pulse, [class*="rounded-lg"]');
    // At least four placeholder tiles are present (no real chip text).
    expect(screen.queryByTestId('triage-chip-severity')).toBeNull();
    expect(skeletons.length).toBeGreaterThanOrEqual(4);
  });

  it('degrades to skeletons when chips is null (no crash)', () => {
    const { container } = render(<CaseTriageHeader chips={null} />);
    expect(container).toBeTruthy();
    expect(screen.queryByTestId('triage-chip-priority')).toBeNull();
  });
});

describe('CaseTriageHeader risk-factor help (#8)', () => {
  // The authored copy is the load-bearing artefact — pin it directly so it can never
  // silently drift from backend/app/engine/risk.py's weights or the honest caveat.
  it('exports the canonical risk-factor help naming all 5 factors, weights and caveat', () => {
    for (const factor of ['Volume', 'Velocity', 'Reputation', 'Diversity', 'Asset criticality']) {
      expect(RISK_FACTOR_HELP).toContain(factor);
    }
    // The default weights 25/20/30/15/10 (Reputation heaviest at 30%).
    expect(RISK_FACTOR_HELP).toContain('25%');
    expect(RISK_FACTOR_HELP).toContain('20%');
    expect(RISK_FACTOR_HELP).toContain('30%');
    expect(RISK_FACTOR_HELP).toContain('15%');
    expect(RISK_FACTOR_HELP).toContain('10%');
    expect(RISK_FACTOR_HELP).toContain('heaviest');
    // The HONEST CAVEAT (both the factor help and the short risk help carry it).
    expect(RISK_FACTOR_HELP).toContain('never closes or escalates');
    expect(RISK_HELP_TEXT).toContain('never closes or escalates');
  });

  it('renders a (?) HelpTip in the risk breakdown whose popover shows the 5 factors + caveat', () => {
    render(<CaseTriageHeader chips={CHIPS} />);
    const helpRegion = screen.getByTestId('risk-factors-help');
    // The (?) affordance is present and accessibly labelled.
    const trigger = within(helpRegion).getByRole('button', {
      name: /how the 5 risk factors are weighted/i,
    });
    expect(trigger).toBeInTheDocument();

    // Opening the popover reveals the authored per-factor copy (long text → popover).
    fireEvent.click(trigger);
    const body = document.body.textContent || '';
    for (const factor of ['Volume', 'Velocity', 'Reputation', 'Diversity', 'Asset criticality']) {
      expect(body).toContain(factor);
    }
    expect(body).toContain('never closes or escalates');
  });
});
