/**
 * useCountUp — Round-7 W0.1. The rAF integer roll.
 *
 * jsdom has no real frame clock, so we exercise the LOAD-BEARING guards (all of which
 * settle synchronously inside the effect): first-mount-static (never 0 → N), and every
 * "snap immediately" branch — reduced motion, no `matchMedia`, and a hidden tab. The
 * setup stub returns `matches:false`; we override `window.matchMedia` per-test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCountUp } from '../useCountUp';

/** Force matchMedia to a fixed `matches` (drives usePrefersReducedMotion). */
function stubMatchMedia(matches: boolean) {
  const mql = {
    matches,
    media: '',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  };
  (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia = vi.fn(
    (q: string) => {
      mql.media = q;
      return mql as unknown as MediaQueryList;
    },
  ) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  vi.restoreAllMocks();
  // Restore the setup.ts default stub so later suites are unaffected.
  stubMatchMedia(false);
});

describe('useCountUp', () => {
  it('renders the value STATICALLY on first mount (never tweens 0 → N)', () => {
    stubMatchMedia(false); // motion allowed — first mount is STILL static
    const { result } = renderHook(() => useCountUp(77));
    expect(result.current).toBe('77');
  });

  it('under reduced motion, a value change SNAPS immediately (no tween)', () => {
    stubMatchMedia(true); // prefers-reduced-motion: reduce
    const { result, rerender } = renderHook(({ v }: { v: number }) => useCountUp(v), {
      initialProps: { v: 10 },
    });
    expect(result.current).toBe('10');
    rerender({ v: 50 });
    // Reduced motion → the effect sets the final value synchronously, no roll.
    expect(result.current).toBe('50');
  });

  it('with matchMedia ABSENT, a value change snaps (its own guard, not just the CSS reset)', () => {
    (window as unknown as { matchMedia?: typeof window.matchMedia }).matchMedia = undefined;
    const { result, rerender } = renderHook(({ v }: { v: number }) => useCountUp(v), {
      initialProps: { v: 3 },
    });
    expect(result.current).toBe('3');
    rerender({ v: 9 });
    expect(result.current).toBe('9');
  });

  it('snaps when the tab is hidden (document.hidden)', () => {
    stubMatchMedia(false);
    const spy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { result, rerender } = renderHook(({ v }: { v: number }) => useCountUp(v), {
      initialProps: { v: 1 },
    });
    rerender({ v: 42 });
    expect(result.current).toBe('42');
    spy.mockRestore();
  });

  it('runs the displayed integer through the formatter', () => {
    stubMatchMedia(true); // snap so we read the settled value directly
    const fmt = (n: number) => `${n} cases`;
    const { result, rerender } = renderHook(
      ({ v }: { v: number }) => useCountUp(v, { format: fmt }),
      { initialProps: { v: 4 } },
    );
    expect(result.current).toBe('4 cases');
    rerender({ v: 12 });
    expect(result.current).toBe('12 cases');
  });

  it('rounds non-integer inputs (integers only)', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useCountUp(12.7));
    expect(result.current).toBe('13');
  });

  it('a same-value re-render is a no-op (no reset)', () => {
    stubMatchMedia(false);
    const { result, rerender } = renderHook(({ v }: { v: number }) => useCountUp(v), {
      initialProps: { v: 20 },
    });
    rerender({ v: 20 });
    expect(result.current).toBe('20');
  });
});
