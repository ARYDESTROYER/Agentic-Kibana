/**
 * useMediaQuery / useIsMobile + usePrefersReducedMotion — matchMedia subscription coverage.
 *
 * jsdom's setup stub returns `matches:false` and a no-op listener API, so we override
 * matchMedia per-test with a controllable stub and assert:
 *   1. the initial snapshot reflects `matches`;
 *   2. a 'change' event updates the value;
 *   3. useIsMobile queries the mobile breakpoint; usePrefersReducedMotion the RM query.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useMediaQuery, useIsMobile, MOBILE_QUERY } from '../useMediaQuery';
import { usePrefersReducedMotion, REDUCED_MOTION_QUERY } from '../usePrefersReducedMotion';

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches,
    media: '',
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
    dispatchEvent: () => true,
    onchange: null,
  };
  const seen: string[] = [];
  const fn = vi.fn((q: string) => {
    seen.push(q);
    mql.media = q;
    return mql as unknown as MediaQueryList;
  });
  (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
    fn as unknown as typeof window.matchMedia;
  return {
    seen,
    setMatches(next: boolean) {
      mql.matches = next;
      listeners.forEach((cb) => cb());
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMediaQuery', () => {
  it('reflects the initial match and reacts to change', () => {
    const ctl = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(min-width: 900px)'));
    expect(result.current).toBe(false);
    act(() => ctl.setMatches(true));
    expect(result.current).toBe(true);
  });

  it('useIsMobile queries the mobile breakpoint', () => {
    const ctl = stubMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
    expect(ctl.seen).toContain(MOBILE_QUERY);
  });

  it('usePrefersReducedMotion queries the reduced-motion preference', () => {
    const ctl = stubMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
    expect(ctl.seen).toContain(REDUCED_MOTION_QUERY);
  });
});
