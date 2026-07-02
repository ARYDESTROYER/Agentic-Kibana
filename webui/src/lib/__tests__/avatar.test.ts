import { describe, it, expect } from 'vitest';
import { initialsFrom } from '@/lib/avatar';

describe('initialsFrom', () => {
  it('returns ? for null or empty', () => {
    expect(initialsFrom(null)).toBe('?');
    expect(initialsFrom(undefined)).toBe('?');
    expect(initialsFrom('')).toBe('?');
  });

  it('takes first two chars of a single-word name', () => {
    expect(initialsFrom('john')).toBe('JO');
  });

  it('takes first char of first and last word', () => {
    expect(initialsFrom('john doe')).toBe('JD');
  });

  it('handles multiple names', () => {
    expect(initialsFrom('john michael doe')).toBe('JD');
  });

  it('handles custom fallback', () => {
    expect(initialsFrom(null, '??')).toBe('??');
  });
});
