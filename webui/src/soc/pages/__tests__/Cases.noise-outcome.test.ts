import { describe, expect, it } from 'vitest';

import type { Case } from '@/lib/types';
import { matchesNoiseOutcome, timeRangeFromWindowHours } from '../Cases';

const mk = (overrides: Partial<Case>): Case =>
  ({ case_id: 'case-noise-outcome', ...overrides }) as Case;

describe('Cases Noise Reduction outcome drill-through', () => {
  const autoCleared = mk({
    status: 'closed',
    decision_by: 'agent',
    verdict: 'FALSE_POSITIVE',
  });
  const humanClosed = mk({
    status: 'resolved',
    decision_by: 'analyst',
    verdict: 'TRUE_POSITIVE',
  });
  const awaitingHuman = mk({
    status: 'needs_human',
    decision_by: 'agent',
    verdict: 'NEEDS_HUMAN',
  });
  const agentTruePositiveClose = mk({
    status: 'closed',
    decision_by: 'agent',
    verdict: 'TRUE_POSITIVE',
  });

  it('matches the backend auto-cleared cohort exactly', () => {
    expect(matchesNoiseOutcome(autoCleared, 'auto_cleared')).toBe(true);
    expect(matchesNoiseOutcome(humanClosed, 'auto_cleared')).toBe(false);
  });

  it('treats every non-auto-cleared case as the folded escalated cohort', () => {
    expect(matchesNoiseOutcome(autoCleared, 'escalated')).toBe(false);
    expect(matchesNoiseOutcome(humanClosed, 'escalated')).toBe(true);
    expect(matchesNoiseOutcome(awaitingHuman, 'escalated')).toBe(true);
  });

  it('matches human terminal cases without including AI auto-closures', () => {
    expect(matchesNoiseOutcome(humanClosed, 'closed')).toBe(true);
    expect(matchesNoiseOutcome(autoCleared, 'closed')).toBe(false);
    expect(matchesNoiseOutcome(agentTruePositiveClose, 'closed')).toBe(false);
    expect(matchesNoiseOutcome(awaitingHuman, 'closed')).toBe(false);
  });

  it('preserves every dashboard metrics horizon the Cases view can represent', () => {
    expect(timeRangeFromWindowHours(1)).toBe('1h');
    expect(timeRangeFromWindowHours(24)).toBe('24h');
    expect(timeRangeFromWindowHours(168)).toBe('7d');
    expect(timeRangeFromWindowHours(720)).toBe('30d');
    expect(timeRangeFromWindowHours(12)).toBeUndefined();
  });
});
