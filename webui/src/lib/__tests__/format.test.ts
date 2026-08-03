/**
 * format — shared framework-free formatting helpers (Round-6 metrics/cost fixes).
 *
 *   1. fmtMoney maps ISO currency CODES to a symbol (not "USD0.05") + groups thousands;
 *   2. humanizeToken preserves acronyms / proper nouns while sentence-casing enum tokens;
 *   3. fmtTokens compacts >= 1000 and leaves smaller counts grouped.
 */
import { describe, it, expect } from 'vitest';

import { fmtMoney, humanizeToken, fmtTokens, humanizeUntil, DASH } from '../format';

describe('humanizeUntil', () => {
  it('keeps future approval deadlines future-facing', () => {
    const now = Date.now();
    expect(humanizeUntil(new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString())).toBe('in 7d');
  });

  it('makes expired and invalid deadlines explicit', () => {
    expect(humanizeUntil(new Date(Date.now() - 60_000).toISOString())).toBe('expired');
    expect(humanizeUntil('not-a-date')).toBe(DASH);
  });
});

describe('fmtMoney', () => {
  it('maps the ISO currency CODE "USD" to a $ symbol (not "USD0.0500")', () => {
    expect(fmtMoney(0.05, 'USD')).toBe('$0.0500');
    expect(fmtMoney(12.5, 'USD')).toBe('$12.50');
  });

  it('maps other known ISO codes to their symbol', () => {
    expect(fmtMoney(12.5, 'EUR')).toBe('€12.50');
    expect(fmtMoney(12.5, 'GBP')).toBe('£12.50');
  });

  it('groups large amounts with thousands separators (like fmtNumber)', () => {
    expect(fmtMoney(12345.5)).toBe('$12,345.50');
    expect(fmtMoney(1000000, 'USD')).toBe('$1,000,000.00');
  });

  it('uses 4 decimals for sub-dollar values and 2 otherwise', () => {
    expect(fmtMoney(0.5)).toBe('$0.5000');
    expect(fmtMoney(6.25)).toBe('$6.25');
  });

  it('treats an already-symbol argument verbatim (no "$ " prefix)', () => {
    expect(fmtMoney(1, '$')).toBe('$1.00');
    expect(fmtMoney(1, '€')).toBe('€1.00');
  });

  it('falls back to a "CODE " prefix for an unknown code and defaults to $', () => {
    expect(fmtMoney(1, 'BTC')).toBe('BTC 1.00');
    expect(fmtMoney(1)).toBe('$1.00');
  });

  it('returns DASH for non-numbers', () => {
    expect(fmtMoney(null)).toBe(DASH);
    expect(fmtMoney(undefined)).toBe(DASH);
    expect(fmtMoney(Number.NaN)).toBe(DASH);
  });
});

describe('humanizeToken', () => {
  it('sentence-cases a plain snake/kebab enum token (unchanged)', () => {
    expect(humanizeToken('needs_human')).toBe('Needs human');
    expect(humanizeToken('false_positive')).toBe('False positive');
    expect(humanizeToken('FALSE_POSITIVE')).toBe('False positive');
    expect(humanizeToken('read-only')).toBe('Read only');
  });

  it('preserves short all-caps acronyms ("US" -> "US", not "Us")', () => {
    expect(humanizeToken('US')).toBe('US');
    expect(humanizeToken('AWS')).toBe('AWS');
  });

  it('preserves mixed-case proper nouns / acronyms', () => {
    expect(humanizeToken('OpenAI')).toBe('OpenAI');
    expect(humanizeToken('United States')).toBe('United States');
    expect(humanizeToken('United_States')).toBe('United States');
  });

  it('returns DASH for empty input', () => {
    expect(humanizeToken('')).toBe(DASH);
    expect(humanizeToken(null)).toBe(DASH);
  });
});

describe('fmtTokens', () => {
  it('compacts values >= 1000 (matching the documented examples)', () => {
    expect(fmtTokens(2085)).toBe('2.1K');
    expect(fmtTokens(12000)).toBe('12K');
  });

  it('leaves smaller counts grouped', () => {
    expect(fmtTokens(850)).toBe('850');
  });
});
