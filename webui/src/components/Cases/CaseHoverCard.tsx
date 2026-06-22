/**
 * CaseHoverCard — a rich, zero-cost-first case preview shown on hover/focus.
 *
 * Wraps any anchor element in an `EuiPopover` that opens on HOVER (and on keyboard
 * FOCUS for a11y), never stealing focus (`ownFocus={false}`). It renders from the
 * already-loaded list `Case` first (no network); only if the preview needs fields
 * the list row lacks (evidence / mitre / persona / playbook) does it lazily call
 * `api.getCase(id)` ONCE, caching the result in a `Map` ref shared by the page so
 * repeated hovers across rows never re-fetch.
 *
 * Debounced so the popover does not flicker: ~180ms to open, ~120ms to close, with
 * the close timer cleared when the cursor enters the panel — so you can move into
 * the preview without it dismissing. All timers are cleared on unmount.
 *
 * Motion is handled by the `.socHoverCard` CSS, which already respects
 * `prefers-reduced-motion`.
 */
import React, {
  cloneElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import {
  EuiBadge,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPopover,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { humanizeAge, humanizeToken } from '../../lib/format';
import { COLORS, riskBand, tint } from '../../lib/theme';
import { RiskGauge } from '../common/charts';
import {
  ConfidenceBadge,
  RiskBadge,
  StatusBadge,
  VerdictBadge,
} from '../common/ui';

const OPEN_DELAY_MS = 180;
const CLOSE_DELAY_MS = 120;

/** Fields the rich preview wants; if any are missing we lazily fetch the case. */
function isDetailed(c?: Case): boolean {
  if (!c) return false;
  return (
    Array.isArray(c.evidence) ||
    Array.isArray(c.mitre) ||
    typeof c.agent_persona === 'string' ||
    typeof c.playbook_id === 'string'
  );
}

export interface CaseHoverCardProps {
  /** The case id to preview. */
  caseId: string;
  /** The list `Case` we already have — rendered first, with zero network. */
  preloaded?: Case;
  /** Page-level cache (`case_id` → full Case) shared across all hover cards. */
  cache?: React.MutableRefObject<Map<string, Case>>;
  /** The element the preview hangs off (e.g. the case title). */
  anchor: ReactElement;
  /**
   * How the trigger wrapper lays out. `'inline'` (default) suits inline anchors
   * like a title; `'block'` lets the anchor fill its container (e.g. a grid card).
   */
  display?: 'inline' | 'block';
}

export const CaseHoverCard: React.FC<CaseHoverCardProps> = ({
  caseId,
  preloaded,
  cache,
  anchor,
  display = 'inline',
}) => {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<Case | undefined>(
    () => cache?.current.get(caseId) ?? preloaded,
  );

  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const fetching = useRef(false);

  const clearTimers = useCallback(() => {
    if (openTimer.current !== undefined) {
      window.clearTimeout(openTimer.current);
      openTimer.current = undefined;
    }
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  // The case we render: cached > fetched > preloaded list row.
  const data = full ?? cache?.current.get(caseId) ?? preloaded;

  const maybeFetch = useCallback(() => {
    if (fetching.current) return;
    const cached = cache?.current.get(caseId);
    if (cached) {
      if (cached !== full) setFull(cached);
      return;
    }
    if (isDetailed(data)) return; // list row already has what we show
    fetching.current = true;
    void api
      .getCase(caseId)
      .then((res) => {
        cache?.current.set(caseId, res);
        if (mounted.current) setFull(res);
      })
      .catch(() => {
        /* preview is best-effort; keep showing the preloaded row */
      })
      .finally(() => {
        fetching.current = false;
      });
  }, [cache, caseId, data, full]);

  const scheduleOpen = useCallback(() => {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
    if (open) return;
    openTimer.current = window.setTimeout(() => {
      if (!mounted.current) return;
      setOpen(true);
      maybeFetch();
    }, OPEN_DELAY_MS);
  }, [open, maybeFetch]);

  const scheduleClose = useCallback(() => {
    if (openTimer.current !== undefined) {
      window.clearTimeout(openTimer.current);
      openTimer.current = undefined;
    }
    closeTimer.current = window.setTimeout(() => {
      if (mounted.current) setOpen(false);
    }, CLOSE_DELAY_MS);
  }, []);

  // Wrap the anchor in a hover/focus-reactive span (so we never mutate the
  // anchor's own handlers). Keyboard focus opens the preview too.
  const trigger = (
    <span
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
      style={
        display === 'block'
          ? { display: 'block', width: '100%' }
          : { display: 'inline-flex', maxWidth: '100%' }
      }
    >
      {cloneElement(anchor, {
        tabIndex: anchor.props.tabIndex ?? 0,
      })}
    </span>
  );

  return (
    <EuiPopover
      button={trigger}
      isOpen={open}
      closePopover={() => setOpen(false)}
      ownFocus={false}
      anchorPosition="rightUp"
      panelPaddingSize="none"
      display={display === 'block' ? 'block' : 'inlineBlock'}
      hasArrow
      repositionOnScroll
    >
      <div
        className="socHoverCard"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
      >
        <CaseHoverBody c={data} />
      </div>
    </EuiPopover>
  );
};

/* --------------------------------------------------------------- body ------ */

const CaseHoverBody: React.FC<{ c?: Case }> = ({ c }) => {
  const band = useMemo(() => riskBand(c?.risk_score), [c?.risk_score]);

  if (!c) {
    return (
      <EuiText size="s" color="subdued">
        <span>Loading preview…</span>
      </EuiText>
    );
  }

  const evidence = (Array.isArray(c.evidence) ? c.evidence : [])
    .map((e) => e?.summary)
    .filter((s): s is string => Boolean(s))
    .slice(0, 2);
  const mitre = (Array.isArray(c.mitre) ? c.mitre : []).filter(Boolean);

  return (
    <div style={{ maxWidth: 312 }}>
      <EuiText size="s">
        <strong style={{ wordBreak: 'break-word' }}>{c.title || c.case_id}</strong>
      </EuiText>

      <EuiSpacer size="s" />

      <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
        <EuiFlexItem grow={false}>
          <VerdictBadge verdict={c.verdict} />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <StatusBadge status={c.status} />
        </EuiFlexItem>
        {typeof c.confidence === 'number' ? (
          <EuiFlexItem grow={false}>
            <ConfidenceBadge confidence={c.confidence} />
          </EuiFlexItem>
        ) : null}
      </EuiFlexGroup>

      <EuiSpacer size="s" />

      <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false} wrap={false}>
        <EuiFlexItem grow={false}>
          <RiskGauge score={c.risk_score ?? 0} size={84} color={band.color} />
        </EuiFlexItem>
        <EuiFlexItem>
          {c.entity ? (
            <EuiText size="xs">
              <span>
                {c.entity.type}:{' '}
                <span className="socMono">{c.entity.value}</span>
              </span>
            </EuiText>
          ) : (
            <EuiText size="xs" color="subdued">
              <span>No primary entity.</span>
            </EuiText>
          )}
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="subdued">
            <span>{band.label} risk</span>
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>

      {c.agent_persona || c.playbook_id ? (
        <>
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
            {c.agent_persona ? (
              <EuiFlexItem grow={false}>
                <EuiBadge color={tint(COLORS.accent, 0.16)} iconType="users">
                  <span style={{ color: COLORS.accent }}>
                    {humanizeToken(c.agent_persona)}
                  </span>
                </EuiBadge>
              </EuiFlexItem>
            ) : null}
            {c.playbook_id ? (
              <EuiFlexItem grow={false}>
                <EuiBadge color={tint(COLORS.primary, 0.16)} iconType="documentation">
                  <span style={{ color: COLORS.primary }}>
                    {humanizeToken(c.playbook_id)}
                  </span>
                </EuiBadge>
              </EuiFlexItem>
            ) : null}
          </EuiFlexGroup>
        </>
      ) : null}

      {evidence.length ? (
        <>
          <EuiSpacer size="s" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {evidence.map((s, i) => (
              <EuiText key={i} size="xs" color="subdued">
                <span style={{ display: 'flex', gap: 6 }}>
                  <span style={{ color: COLORS.subdued }}>•</span>
                  <span style={{ wordBreak: 'break-word' }}>{s}</span>
                </span>
              </EuiText>
            ))}
          </div>
        </>
      ) : null}

      {mitre.length ? (
        <>
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
            {mitre.slice(0, 4).map((m) => (
              <EuiFlexItem grow={false} key={m}>
                <EuiBadge color="hollow" iconType="branch">
                  {m}
                </EuiBadge>
              </EuiFlexItem>
            ))}
            {mitre.length > 4 ? (
              <EuiFlexItem grow={false}>
                <EuiBadge color="hollow">+{mitre.length - 4}</EuiBadge>
              </EuiFlexItem>
            ) : null}
          </EuiFlexGroup>
        </>
      ) : null}

      <EuiSpacer size="s" />

      <EuiFlexGroup
        gutterSize="xs"
        alignItems="center"
        responsive={false}
        justifyContent="spaceBetween"
      >
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            <span>Updated {humanizeAge(c.updated_at || c.created_at)}</span>
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <RiskBadge score={c.risk_score} />
        </EuiFlexItem>
      </EuiFlexGroup>
    </div>
  );
};
