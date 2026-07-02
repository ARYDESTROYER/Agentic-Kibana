/**
 * Rules-FE constants spec — the pure verdict-condition helpers.
 *
 * `normalizedVerdictCondition` maps a stored verdict-condition value to the `<Select>`
 * item value that should render. The wire token can arrive UPPERCASE (config.py documents
 * FALSE_POSITIVE|TRUE_POSITIVE|NEEDS_HUMAN, backend matcher is case-insensitive) while the
 * Select items are lowercase — so a valid uppercase verdict must map to its lowercase item
 * or Radix renders a BLANK field for a real, active condition (#28).
 */
import { describe, it, expect } from 'vitest';
import { normalizedVerdictCondition, hasImpossibleVerdict } from '../constants';

describe('normalizedVerdictCondition (#28)', () => {
  it('maps a valid UPPERCASE verdict to its lowercase Select item', () => {
    expect(normalizedVerdictCondition('TRUE_POSITIVE')).toBe('true_positive');
    expect(normalizedVerdictCondition('False_Positive')).toBe('false_positive');
    expect(normalizedVerdictCondition('NEEDS_HUMAN')).toBe('needs_human');
  });

  it('passes a valid lowercase verdict through unchanged', () => {
    expect(normalizedVerdictCondition('true_positive')).toBe('true_positive');
  });

  it('returns empty for an absent/blank condition (caller maps to its "any" sentinel)', () => {
    expect(normalizedVerdictCondition(undefined)).toBe('');
    expect(normalizedVerdictCondition('')).toBe('');
  });

  it('keeps an out-of-enum value raw so the disabled "(invalid)" fallback can surface it', () => {
    expect(normalizedVerdictCondition('SUSPICIOUS')).toBe('SUSPICIOUS');
    // and that raw value is still flagged impossible by the sibling guard
    expect(hasImpossibleVerdict('SUSPICIOUS')).toBe(true);
  });
});
