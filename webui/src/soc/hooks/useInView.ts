/**
 * useInView — Round-7 W0.1. Reveal-on-scroll helper built on IntersectionObserver.
 *
 * Returns `[ref, inView]`. Attach `ref` to the element you want to observe; `inView`
 * flips to `true` the first time the element crosses the viewport threshold (and, by
 * default, stays true — `once`). Under jsdom / any engine without IntersectionObserver
 * it fails OPEN (reports `inView: true` immediately) so content is never permanently
 * hidden behind an observer that will never fire.
 *
 * Intended pairing: gate a `<Reveal>`/`animate-*` on `inView` so below-the-fold
 * sections animate in as they scroll into view, not all at once on mount.
 */
import { type RefObject, useEffect, useRef, useState } from 'react';

export interface UseInViewOptions {
  /** Stop observing after the first intersection (default true). */
  once?: boolean;
  /** Fraction of the element that must be visible to count as in-view. */
  threshold?: number | number[];
  /** Grow/shrink the viewport bounds (e.g. '0px 0px -10% 0px'). */
  rootMargin?: string;
}

export function useInView<T extends Element = HTMLDivElement>(
  options: UseInViewOptions = {},
): [RefObject<T>, boolean] {
  const { once = true, threshold, rootMargin } = options;
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // No IntersectionObserver (jsdom / older engines) → fail open, show everything.
    if (typeof IntersectionObserver !== 'function') {
      setInView(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            if (once) io.disconnect();
          } else if (!once) {
            setInView(false);
          }
        }
      },
      { threshold, rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
    // `threshold`/`rootMargin` are usually inline literals; re-subscribing on identity
    // churn would thrash the observer, so we key only on `once`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [once]);

  return [ref, inView];
}
