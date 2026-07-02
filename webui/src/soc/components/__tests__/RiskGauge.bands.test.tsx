/**
 * RiskGauge — canonical scoreBand ladder (F1).
 *
 * The gauge previously used a divergent 80/60/35 ladder, so the same score rendered a
 * different band than RiskBadge/posture (which use palette's ONE 74/48/22 `scoreBand`).
 * This pins the gauge to `scoreBand`, so its band label always agrees with the rest of
 * the app.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RiskGauge } from '../RiskGauge';
import { scoreBand } from '../palette';

const LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

describe('RiskGauge — canonical scoreBand ladder', () => {
  for (const score of [10, 22, 30, 47, 48, 50, 73, 74, 76, 100]) {
    it(`score ${score} → band "${LABEL[scoreBand(score)]}" (matches scoreBand)`, () => {
      const { container } = render(<RiskGauge score={score} />);
      const title = container.querySelector('title')?.textContent || '';
      expect(title).toContain(LABEL[scoreBand(score)]);
    });
  }

  it('score 50 reads High (not Medium) — the old 80/60/35 gauge ladder is gone', () => {
    const { container } = render(<RiskGauge score={50} />);
    expect(container.querySelector('title')?.textContent).toContain('High');
    // The visible non-color band label agrees too.
    expect(container.textContent).toContain('High');
  });

  it('score 76 reads Critical (>= 74), not High', () => {
    const { container } = render(<RiskGauge score={76} />);
    expect(container.querySelector('title')?.textContent).toContain('Critical');
  });
});
