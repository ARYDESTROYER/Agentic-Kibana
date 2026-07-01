/**
 * AnnouncerProvider — the app-level screen-reader live region (Round-5 W0-E / E3,
 * DESIGN_STANDARD §6.3).
 *
 * The suite mounts exactly ONE `aria-live` region (via the W0-B `useLiveAnnouncer`
 * hook) at the app root and shares its imperative `announce()` through this Context.
 * Deep components — `DataTable` ("Cases sorted by risk, descending" / bulk-action
 * outcomes), future DnD "move" surfaces, "settings saved" — call `useAnnouncer()`
 * and push a short plain-text message that reaches assistive tech without any
 * visible UI change. This matters because `aria-sort` is silently ignored by
 * VoiceOver / TalkBack, so a sort change must ALSO be spoken through the live region.
 *
 * Fallback: `useAnnouncer()` returns a NO-OP `announce` when no provider is mounted
 * (isolated component tests, storybook, the auth/login screens before the shell is
 * up), so a caller never crashes and never has to null-check.
 *
 * SECURITY (#9): callers pass plain strings; the underlying region renders them as
 * TEXT nodes only — never HTML — so an operator-/log-derived value announced here can
 * never inject markup.
 */
import * as React from 'react';
import { useLiveAnnouncer, type AnnouncePoliteness } from '@/soc/hooks/useLiveAnnouncer';

export type Announce = (message: string, politeness?: AnnouncePoliteness) => void;

const NOOP: Announce = () => {};

const AnnouncerContext = React.createContext<Announce>(NOOP);

/**
 * Mount ONCE at the app root (inside `AppShell`). Renders the single hidden
 * `aria-live` region and provides `announce()` to the tree below.
 */
export function AnnouncerProvider({ children }: { children: React.ReactNode }) {
  const { announce, LiveRegion } = useLiveAnnouncer();
  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <LiveRegion />
    </AnnouncerContext.Provider>
  );
}

/** Consume the shared `announce()`; a no-op when no provider is mounted. */
export function useAnnouncer(): Announce {
  return React.useContext(AnnouncerContext);
}
