import { describe, it, expect } from 'vitest';
import {
  DASH,
  humanizeAge,
  formatTimestamp,
  fmtMoney,
  fmtNumber,
  fmtTokens,
  fmtPercent,
  toPercentValue,
  humanizeToken,
} from '@/lib/format';

describe('humanizeAge', () => {
  it('returns DASH for null/empty', () => {
    expect(humanizeAge(null)).toBe(DASH);
    expect(humanizeAge()).toBe(DASH);
    expect(humanizeAge('')).toBe(DASH);
  });

  it('returns DASH for invalid date', () => {
    expect(humanizeAge('not-a-date')).toBe(DASH);
  });

  it('returns just now for < 45 seconds', () => {
    const ago = new Date(Date.now() - 30_000).toISOString();
    expect(humanizeAge(ago)).toBe('just now');
  });

  it('returns minutes for < 1 hour', () => {
    const ago = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(humanizeAge(ago)).toMatch(/\d+m ago/);
  });

  it('returns hours for < 24 hours', () => {
    const ago = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(humanizeAge(ago)).toMatch(/\d+h ago/);
  });

  it('returns days for < 30 days', () => {
    const ago = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect(humanizeAge(ago)).toMatch(/\d+d ago/);
  });

  it('returns months for < 12 months', () => {
    const ago = new Date(Date.now() - 90 * 86_400_000).toISOString();
    expect(humanizeAge(ago)).toMatch(/\d+mo ago/);
  });

  it('returns years for >= 12 months', () => {
    const ago = new Date(Date.now() - 400 * 86_400_000).toISOString();
    expect(humanizeAge(ago)).toMatch(/\d+y ago/);
  });
});

describe('formatTimestamp', () => {
  it('returns DASH for null/empty', () => {
    expect(formatTimestamp(null)).toBe(DASH);
    expect(formatTimestamp()).toBe(DASH);
    expect(formatTimestamp('')).toBe(DASH);
  });

  it('returns raw string for unparseable input', () => {
    expect(formatTimestamp('garbage')).toBe('garbage');
  });

  it('formats a valid ISO string', () => {
    const result = formatTimestamp('2026-07-02T10:00:00.000Z');
    expect(result).not.toBe(DASH);
    expect(result).toContain('2026');
  });
});

describe('fmtMoney', () => {
  it('returns DASH for null/NaN', () => {
    expect(fmtMoney(null)).toBe(DASH);
    expect(fmtMoney(undefined)).toBe(DASH);
    expect(fmtMoney(NaN)).toBe(DASH);
  });

  it('formats large values with 2 decimals', () => {
    expect(fmtMoney(12.5)).toBe('$12.50');
    expect(fmtMoney(100)).toBe('$100.00');
  });

  it('formats small values with 4 decimals', () => {
    expect(fmtMoney(0.1234)).toBe('$0.1234');
    expect(fmtMoney(0.0012)).toBe('$0.0012');
  });

  it('uses custom currency symbol', () => {
    expect(fmtMoney(5, '€')).toBe('€5.00');
  });
});

describe('fmtNumber', () => {
  it('returns DASH for null/NaN', () => {
    expect(fmtNumber(null)).toBe(DASH);
    expect(fmtNumber(undefined)).toBe(DASH);
    expect(fmtNumber(NaN)).toBe(DASH);
  });

  it('formats with locale separators', () => {
    expect(fmtNumber(12345)).toBe('12,345');
    expect(fmtNumber(1000)).toBe('1,000');
  });

  it('formats zero', () => {
    expect(fmtNumber(0)).toBe('0');
  });
});

describe('fmtTokens', () => {
  it('returns DASH for null/NaN', () => {
    expect(fmtTokens(null)).toBe(DASH);
    expect(fmtTokens(undefined)).toBe(DASH);
  });

  it('formats small counts with fmtNumber', () => {
    expect(fmtTokens(999)).toBe('999');
  });

  it('formats thousands with K suffix', () => {
    expect(fmtTokens(12000)).toBe('12K');
    expect(fmtTokens(1500)).toBe('1.5K');
  });
});

describe('fmtPercent', () => {
  it('returns DASH for null/NaN', () => {
    expect(fmtPercent(null)).toBe(DASH);
    expect(fmtPercent(NaN)).toBe(DASH);
  });

  it('converts 0..1 fraction to percent', () => {
    expect(fmtPercent(0.85)).toBe('85%');
    expect(fmtPercent(0.5)).toBe('50%');
  });

  it('passes through 0..100 values', () => {
    expect(fmtPercent(85)).toBe('85%');
    expect(fmtPercent(100)).toBe('100%');
  });
});

describe('toPercentValue', () => {
  it('returns 0 for null/NaN', () => {
    expect(toPercentValue(null)).toBe(0);
    expect(toPercentValue(undefined)).toBe(0);
  });

  it('converts 0..1 to 0..100', () => {
    expect(toPercentValue(0.85)).toBe(85);
  });

  it('clamps to 0..100', () => {
    expect(toPercentValue(-1)).toBe(0);
    expect(toPercentValue(150)).toBe(100);
  });
});

describe('humanizeToken', () => {
  it('returns DASH for null/empty', () => {
    expect(humanizeToken(null)).toBe(DASH);
    expect(humanizeToken()).toBe(DASH);
    expect(humanizeToken('')).toBe(DASH);
  });

  it('converts underscore-separated tokens', () => {
    expect(humanizeToken('needs_human')).toBe('Needs human');
    expect(humanizeToken('true_positive')).toBe('True positive');
  });

  it('converts dash-separated tokens', () => {
    expect(humanizeToken('high-severity')).toBe('High severity');
  });

  it('handles single-word tokens', () => {
    expect(humanizeToken('open')).toBe('Open');
  });

  it('handles mixed case', () => {
    expect(humanizeToken('NEEDS_HUMAN')).toBe('Needs human');
  });
});
