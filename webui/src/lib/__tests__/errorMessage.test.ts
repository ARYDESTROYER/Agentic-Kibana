/**
 * errorMessage — the shared caught-value → readable-text coercion.
 *
 *   1. ApiError uses its extracted backend message;
 *   2. a plain Error uses its message (name when empty);
 *   3. a non-blank string is used verbatim; blank falls back;
 *   4. null/undefined/un-stringifiable → the fallback;
 *   5. a plain object stringifies.
 */
import { describe, it, expect } from 'vitest';

import { errorMessage } from '../errorMessage';
import { ApiError } from '../api';

describe('errorMessage', () => {
  it('uses the ApiError message (backend detail)', () => {
    expect(errorMessage(new ApiError(404, 'case not found'))).toBe('case not found');
  });

  it('falls back for an empty ApiError message', () => {
    expect(errorMessage(new ApiError(500, ''), 'fallback')).toBe('fallback');
  });

  it('uses a plain Error message, else its name', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    const named = new Error('');
    named.name = 'RangeError';
    expect(errorMessage(named)).toBe('RangeError');
  });

  it('uses a non-blank string verbatim, else the fallback', () => {
    expect(errorMessage('plain text')).toBe('plain text');
    expect(errorMessage('   ', 'fb')).toBe('fb');
  });

  it('returns the fallback for null/undefined', () => {
    expect(errorMessage(null, 'fb')).toBe('fb');
    expect(errorMessage(undefined, 'fb')).toBe('fb');
  });

  it('stringifies a plain object; falls back on an empty one', () => {
    expect(errorMessage({ detail: 'x' })).toBe('{"detail":"x"}');
    expect(errorMessage({}, 'fb')).toBe('fb');
  });

  it('falls back on an empty array, like the empty object', () => {
    expect(errorMessage([], 'fb')).toBe('fb');
    expect(errorMessage([1, 2])).toBe('[1,2]');
  });

  it('falls back for values that stringify to the value undefined (functions/symbols)', () => {
    expect(errorMessage(() => {}, 'fb')).toBe('fb');
    expect(errorMessage(Symbol('x'), 'fb')).toBe('fb');
  });

  it('uses a default fallback when none given', () => {
    expect(errorMessage(null)).toBe('Something went wrong.');
  });
});
