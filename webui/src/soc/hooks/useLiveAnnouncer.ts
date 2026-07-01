/**
 * useLiveAnnouncer — a screen-reader live-region announcer (WCAG-2.2 / a11y foundation).
 *
 * Round-5 W0-B B5 (feeds the a11y wave E3): returns an imperative `announce(message,
 * politeness?)` plus a hidden `<LiveRegion>` element the caller mounts once (typically at
 * the app root). Announcements — "sorted by risk, descending", "3 cases closed",
 * "settings saved" — reach assistive tech without any visible UI change.
 *
 * Implementation notes:
 *   - The region is a `sr-only` (visually hidden but present) `aria-live` node. Because
 *     jsdom / SSR has no `matchMedia` etc., this is DOM-only and test-friendly.
 *   - `LiveRegion` has a STABLE identity for the life of the hook and subscribes to an
 *     internal store, so an announce UPDATES the same two DOM nodes rather than
 *     remounting fresh ones — remounting would detach the node a caller (or test) is
 *     observing, so the text would never reach it.
 *   - We toggle the text off→on so REPEATED identical messages still fire (some screen
 *     readers ignore an unchanged text node). A short timeout clear then re-set does the
 *     trick without visible flicker.
 *   - Two channels: `polite` (default, `aria-live="polite"`) and `assertive` (for errors /
 *     time-critical outcomes). The element renders one node per channel.
 *
 * SECURITY (#9): callers pass plain strings; the region renders them as TEXT nodes only —
 * never HTML (no `dangerouslySetInnerHTML`) — so an operator-/log-derived value announced
 * here can never inject markup.
 */
import { createElement, useCallback, useMemo, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';

import { LiveAnnouncerRegions } from './LiveAnnouncerRegions';

export type AnnouncePoliteness = 'polite' | 'assertive';

export interface LiveAnnouncer {
  /** Announce a message on the given channel (default `polite`). */
  announce: (message: string, politeness?: AnnouncePoliteness) => void;
  /** Mount this ONCE (e.g. at the app root). Renders the hidden live regions. */
  LiveRegion: () => ReactElement;
}

interface AnnouncerState {
  polite: string;
  assertive: string;
}

export function useLiveAnnouncer(): LiveAnnouncer {
  // A tiny per-hook store so the STABLE `LiveRegion` can re-render on announce without
  // re-running the hook (which would change `LiveRegion`'s identity and remount the DOM).
  const store = useRef<{
    state: AnnouncerState;
    listeners: Set<() => void>;
    timers: { polite?: number; assertive?: number };
  }>();
  if (!store.current) {
    store.current = {
      state: { polite: '', assertive: '' },
      listeners: new Set(),
      timers: {},
    };
  }
  const s = store.current;

  const emit = useCallback(() => {
    for (const l of s.listeners) l();
  }, [s]);

  const setChannel = useCallback(
    (politeness: AnnouncePoliteness, text: string) => {
      // Replace the state object (immutable snapshot) so useSyncExternalStore detects it.
      s.state = { ...s.state, [politeness]: text };
      emit();
    },
    [s, emit],
  );

  const announce = useCallback(
    (message: string, politeness: AnnouncePoliteness = 'polite') => {
      const text = String(message ?? '');
      // Clear first so an identical repeat re-triggers the SR; re-set on the next tick.
      const prev = s.timers[politeness];
      if (prev !== undefined && typeof window !== 'undefined') {
        window.clearTimeout(prev);
        s.timers[politeness] = undefined;
      }
      setChannel(politeness, '');
      if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        s.timers[politeness] = window.setTimeout(() => {
          s.timers[politeness] = undefined;
          setChannel(politeness, text);
        }, 60);
      } else {
        // No timer host (rare) — set synchronously; the repeat-nudge is best-effort.
        setChannel(politeness, text);
      }
    },
    [s, setChannel],
  );

  const subscribe = useCallback(
    (onChange: () => void) => {
      s.listeners.add(onChange);
      return () => {
        s.listeners.delete(onChange);
      };
    },
    [s],
  );
  const getSnapshot = useCallback(() => s.state, [s]);

  // Stable component identity (created once) — React reconciles the SAME DOM nodes on
  // every announce, so a held reference keeps receiving updates.
  const LiveRegion = useCallback((): ReactElement => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- LiveRegion has stable identity (empty deps); its hook order is invariant.
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return createElement(LiveAnnouncerRegions, {
      polite: state.polite,
      assertive: state.assertive,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keep a stable component identity for the life of the hook.
  }, []);

  return useMemo(() => ({ announce, LiveRegion }), [announce, LiveRegion]);
}
