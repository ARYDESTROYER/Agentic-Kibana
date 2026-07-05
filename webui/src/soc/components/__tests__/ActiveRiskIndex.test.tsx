/**
 * ActiveRiskIndex — Round-7 W0.3 coverage.
 *
 * The ONE Command-Center risk instrument (#1): a compact caption + a (?) HelpTip and a
 * RiskGauge over the mean deterministic risk of the currently OPEN cases, degrading to
 * an honest DASH "no open cases" placeholder when there is nothing open to gauge.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ActiveRiskIndex } from '../ActiveRiskIndex';
import { ACTIVE_RISK_HELP_TEXT } from '../riskCopy';
import { SCORE_BANDS } from '../palette';

describe('ActiveRiskIndex (#1 Command-Center risk instrument)', () => {
  it('renders the RiskGauge with the score when there are open cases (count > 0)', () => {
    render(<ActiveRiskIndex score={62} count={7} />);

    // The caption + HelpTip head the instrument.
    expect(screen.getByText(/active risk index/i)).toBeInTheDocument();

    // The gauge renders (role="img" with a titled value) and shows the score.
    const gauge = screen.getByRole('img');
    expect(gauge).toBeInTheDocument();
    expect(gauge.textContent).toContain('62');

    // No empty placeholder when there are open cases.
    expect(screen.queryByTestId('active-risk-empty')).toBeNull();
  });

  it('marks the critical band cut with a decorative notch on the header gauge (W2.b)', () => {
    const { container } = render(<ActiveRiskIndex score={62} count={7} size={120} />);

    // The gauge draws a single decorative <line> notch at the critical boundary (74).
    const line = container.querySelector('line');
    expect(line).not.toBeNull();
    expect(line!.getAttribute('aria-hidden')).toBe('true');

    // The notch value is the ONE-source-of-truth critical floor (74), not a magic number.
    expect(SCORE_BANDS.critical[0]).toBe(74);
    // 74 > 50 → the tick sits on the RIGHT half of the compact gauge (x > centre).
    expect(Number(line!.getAttribute('x1'))).toBeGreaterThan(120 / 2);
  });

  it('draws no notch on the empty ("no open cases") placeholder', () => {
    const { container } = render(<ActiveRiskIndex score={0} count={0} />);
    expect(container.querySelector('line')).toBeNull();
  });

  it('renders a DASH "no open cases" placeholder (not a zero gauge) when count is 0', () => {
    render(<ActiveRiskIndex score={0} count={0} />);

    const empty = screen.getByTestId('active-risk-empty');
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toContain('—'); // DASH
    expect(empty.textContent?.toLowerCase()).toContain('no open cases');

    // The gauge is NOT drawn (no misleading zero arc).
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('degrades to the placeholder when count is omitted or the score is null', () => {
    // count undefined → treated as no open cases.
    const { rerender } = render(<ActiveRiskIndex score={40} />);
    expect(screen.getByTestId('active-risk-empty')).toBeInTheDocument();

    // A positive count but a null score also degrades (nothing to gauge).
    rerender(<ActiveRiskIndex score={null} count={3} />);
    expect(screen.getByTestId('active-risk-empty')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('always exposes the explanatory HelpTip affordance', () => {
    render(<ActiveRiskIndex score={62} count={7} />);
    // Long copy (>80 chars) opens as a Popover; the trigger is accessibly labelled.
    expect(
      screen.getByRole('button', { name: /what the active risk index means/i }),
    ).toBeInTheDocument();
  });

  it('ACTIVE_RISK_HELP_TEXT is long enough to open the HelpTip Popover (>80 chars)', () => {
    // Guards the HelpTip Popover branch (usePopover fires when text.length > 80) so the
    // affordance is a focusable Popover, not a bare Tooltip.
    expect(ACTIVE_RISK_HELP_TEXT.length).toBeGreaterThan(80);
    // The band-cut ladder is documented in the copy (Round-7 W0.3 requirement).
    expect(ACTIVE_RISK_HELP_TEXT).toContain('Critical ≥74');
  });
});
