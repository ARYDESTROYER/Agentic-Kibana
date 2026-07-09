/**
 * motion.dev layer — the lazy animation module (webui-motion / ask C).
 *
 * Covers the pieces jsdom can exercise deterministically: the provider renders its
 * subtree, the transition wrappers render their children, the count-up SNAPS under
 * reduced motion (its own JS guard — MotionConfig alone can't neutralise a MotionValue
 * tween), and the variant tokens are derived from the shared MOTION tempo.
 *
 * (The "no motion.dev on first paint" invariant is guarded by
 * soc/__tests__/bundle-first-paint.test.ts against the built dist/.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';

import { MOTION } from '@/soc/motion';
import {
  MotionProvider,
  PageTransition,
  TabPanelMotion,
  AnimatedNumber,
} from '../index';
import {
  EASE_PREMIUM,
  EASE_STANDARD,
  HOUSE_TRANSITION,
  HOUSE_SPRING,
  pageVariants,
  tabVariants,
  bulkBarVariants,
  verdictLandVariants,
} from '../variants';

/** Force matchMedia to a fixed `matches` (drives motion.dev's useReducedMotion). */
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
  stubMatchMedia(false); // restore the setup.ts default (motion allowed)
});

describe('motion variant tokens', () => {
  it('derive timing from the shared MOTION tempo (ms → s) and the CSS ease tokens', () => {
    // HOUSE_TRANSITION base duration = MOTION.base (200ms) → 0.2s.
    expect(HOUSE_TRANSITION.duration).toBeCloseTo(MOTION.base / 1000, 5);
    expect(HOUSE_TRANSITION.ease).toEqual(EASE_PREMIUM);
    // The cubic-bezier arrays mirror --motion-ease-premium / --motion-ease-standard.
    expect(EASE_PREMIUM).toEqual([0.16, 1, 0.3, 1]);
    expect(EASE_STANDARD).toEqual([0.2, 0, 0, 1]);
    // The house spring is velocity-aware (a real spring, low bounce).
    expect(HOUSE_SPRING.type).toBe('spring');
  });

  it('every enter variant starts hidden (opacity 0) and settles to opacity 1', () => {
    for (const v of [pageVariants, tabVariants, bulkBarVariants, verdictLandVariants]) {
      const hidden = v.hidden as { opacity?: number };
      const show = v.show as { opacity?: number };
      expect(hidden.opacity).toBe(0);
      expect(show.opacity).toBe(1);
    }
    // Only transform + opacity animate (GPU-composited house style) — no width/shadow.
    const show = pageVariants.show as Record<string, unknown>;
    expect(Object.keys(show).every((k) => ['opacity', 'y', 'x', 'scale', 'transition'].includes(k))).toBe(
      true,
    );
  });
});

describe('MotionProvider', () => {
  it('renders its subtree (LazyMotion domAnimation + MotionConfig)', () => {
    const { getByTestId } = render(
      <MotionProvider>
        <div data-testid="child">hi</div>
      </MotionProvider>,
    );
    expect(getByTestId('child')).toBeInTheDocument();
  });
});

describe('PageTransition', () => {
  it('renders the routed child under a keyed AnimatePresence', () => {
    const { getByTestId } = render(
      <MotionProvider>
        <PageTransition routeKey="overview">
          <div data-testid="page">Overview</div>
        </PageTransition>
      </MotionProvider>,
    );
    expect(getByTestId('page')).toBeInTheDocument();
  });
});

describe('TabPanelMotion', () => {
  it('renders the tab body it wraps', () => {
    const { getByTestId } = render(
      <MotionProvider>
        <TabPanelMotion>
          <div data-testid="tab">Investigation</div>
        </TabPanelMotion>
      </MotionProvider>,
    );
    expect(getByTestId('tab')).toBeInTheDocument();
  });
});

describe('AnimatedNumber', () => {
  it('SNAPS to the plain formatted value under reduced motion (no roll)', () => {
    stubMatchMedia(true); // prefers-reduced-motion: reduce
    const { container } = render(<AnimatedNumber value={1234} />);
    // Plain <span> with the formatted value — never a MotionValue tween.
    expect(container.textContent).toBe((1234).toLocaleString());
  });

  it('honours a custom format() under reduced motion', () => {
    stubMatchMedia(true);
    const { container } = render(
      <AnimatedNumber value={87} format={(n) => `${n}%`} />,
    );
    expect(container.textContent).toBe('87%');
  });

  it('renders a span (initialised at the target, never a 0 → N roll) with motion allowed', () => {
    stubMatchMedia(false);
    const { container } = render(
      <MotionProvider>
        <AnimatedNumber value={42} />
      </MotionProvider>,
    );
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
    // The spring is initialised AT the value, so the first paint already reads the target.
    expect(container.textContent).toContain('42');
  });
});
