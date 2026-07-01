/**
 * LiveAnnouncerRegions — the hidden `aria-live` DOM used by `useLiveAnnouncer`.
 *
 * This is a small, STABLE-IDENTITY companion component. `useLiveAnnouncer` returns a
 * `LiveRegion` bound to it (via props) so that React UPDATES the same two live-region
 * DOM nodes on every announce instead of remounting fresh nodes — the latter would
 * detach the node a caller (or test) is observing, so the announcement would never
 * reach the node they hold.
 *
 * SECURITY (#9): `polite`/`assertive` are rendered as React TEXT children only — never
 * HTML — so an operator-/log-derived value announced here can never inject markup.
 * There is no `dangerouslySetInnerHTML` anywhere on this path.
 */
import type { ReactElement } from 'react';

export interface LiveAnnouncerRegionsProps {
  /** Current text for the polite (`aria-live="polite"`, role=status) channel. */
  polite: string;
  /** Current text for the assertive (`aria-live="assertive"`, role=alert) channel. */
  assertive: string;
}

/**
 * Renders both live regions. Visually hidden (`sr-only`) but present for assistive tech.
 */
export function LiveAnnouncerRegions({
  polite,
  assertive,
}: LiveAnnouncerRegionsProps): ReactElement {
  return (
    <div className="sr-only" data-testid="live-announcer">
      <div role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </div>
  );
}
