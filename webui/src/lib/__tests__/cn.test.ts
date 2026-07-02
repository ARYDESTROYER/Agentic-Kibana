import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/cn';

describe('cn', () => {
  it('merges class strings', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('filters falsy values', () => {
    expect(cn('a', undefined, null, '', 'b')).toBe('a b');
  });

  it('handles arrays', () => {
    expect(cn(['a', 'b'], 'c')).toBe('a b c');
  });

  it('de-duplicates tailwind conflicts (later wins)', () => {
    const result = cn('px-4', 'px-2');
    expect(result).not.toContain('px-4');
  });
});
