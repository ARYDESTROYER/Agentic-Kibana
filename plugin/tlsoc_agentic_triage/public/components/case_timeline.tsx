import React from 'react';
import {
  EuiAvatar,
  EuiBadge,
  EuiComment,
  EuiCommentList,
  EuiText,
} from '@elastic/eui';
import type { Case, VerdictHistoryEntry } from '../../common';

interface HistoryEntry {
  ts?: string;
  event?: string;
  action?: string;
  analyst?: string;
  note?: string;
  verdict?: string;
  [k: string]: unknown;
}

interface CaseTimelineProps {
  theCase: Case;
}

/** Matches the header verdict colour mapping used in case_detail. Returned as
 * a named EUI badge color (badges accept these). */
function verdictBadgeColor(verdict?: string): 'danger' | 'success' | 'warning' | 'default' {
  const v = (verdict || '').toUpperCase();
  if (v.includes('TRUE')) return 'danger';
  if (v.includes('FALSE')) return 'success';
  if (v.includes('INCONCLUSIVE') || v.includes('UNKNOWN') || v.includes('NEEDS_HUMAN')) {
    return 'warning';
  }
  return 'default';
}

type Kind = 'analyst_action' | 'decision' | 'attach' | 'verdict' | 'event';

/** Per-kind avatar presentation. Hex colours so they are valid EuiAvatar
 * background colours. */
function kindStyle(kind: Kind): { icon: string; color: string } {
  switch (kind) {
    case 'analyst_action':
      return { icon: 'user', color: '#0077cc' };
    case 'decision':
      return { icon: 'gear', color: '#69707d' };
    case 'attach':
      return { icon: 'paperClip', color: '#017d73' };
    case 'verdict':
      return { icon: 'inspect', color: '#bd271e' };
    default:
      return { icon: 'dot', color: '#98a2b3' };
  }
}

/** A normalized, sortable timeline node merged from history + verdict_history. */
interface TimelineNode {
  ts: string;
  kind: Kind;
  /** The plain-English sentence (rendered as text, never markup). */
  sentence: string;
  /** Optional verdict to render as a coloured badge (verdict-change highlight). */
  verdict?: string;
  /** Optional analyst quote (the note). Rendered as plain text. */
  note?: string;
  /** Dedupe count for collapsed consecutive identical decisions. */
  count: number;
  /** Stable-ish identity used to collapse consecutive identical entries. */
  dedupeKey: string;
}

function actionVerb(action?: string): string {
  switch ((action || '').toLowerCase()) {
    case 'close':
      return 'closed the case';
    case 'confirm_fp':
      return 'confirmed false positive';
    case 'reopen':
      return 'reopened the case';
    case 'escalate':
      return 'escalated the case';
    case 'acknowledge':
      return 'acknowledged the case';
    default:
      return action ? `performed “${action}”` : 'took an action';
  }
}

/** Build a sentence + dedupe key for an analyst action / generic event. */
function describeHistory(h: HistoryEntry): { kind: Kind; sentence: string; dedupeKey: string } {
  const event = (h.event || '').toLowerCase();
  if (event === 'analyst_action') {
    const who = h.analyst || 'Analyst';
    const sentence = `${who} ${actionVerb(h.action)}`;
    return { kind: 'analyst_action', sentence, dedupeKey: `analyst_action:${sentence}` };
  }
  if (event === 'decision') {
    // Decision spam: collapse consecutive identical decisions by their action.
    const sentence = h.action
      ? `Pipeline decision: ${h.action}`
      : h.note
        ? `Pipeline decision: ${h.note}`
        : 'Pipeline decision';
    return { kind: 'decision', sentence, dedupeKey: `decision:${h.action || h.note || ''}` };
  }
  if (event === 'attach') {
    const sentence = h.note ? `Attached: ${h.note}` : 'Evidence attached';
    return { kind: 'attach', sentence, dedupeKey: `attach:${h.note || ''}` };
  }
  // Generic / unknown event.
  const sentence =
    (h.event || 'event') + (h.action ? ` (${h.action})` : '') + (h.analyst ? ` by ${h.analyst}` : '');
  return { kind: 'event', sentence, dedupeKey: `event:${sentence}` };
}

function buildNodes(theCase: Case): TimelineNode[] {
  const raw: TimelineNode[] = [];

  const history = (theCase.history as HistoryEntry[] | undefined) || [];
  for (const h of history) {
    const { kind, sentence, dedupeKey } = describeHistory(h);
    raw.push({
      ts: h.ts || '',
      kind,
      sentence,
      note: typeof h.note === 'string' && h.note.trim() ? h.note.trim() : undefined,
      count: 1,
      dedupeKey,
    });
  }

  const vh = (theCase.verdict_history as VerdictHistoryEntry[] | undefined) || [];
  for (const v of vh) {
    const conf = typeof v.confidence === 'number' ? ` (${(v.confidence * 100).toFixed(0)}% confidence)` : '';
    raw.push({
      ts: v.ts || '',
      kind: 'verdict',
      sentence: `Agent verdict: ${v.verdict || 'UNKNOWN'}${conf}`,
      verdict: v.verdict,
      count: 1,
      dedupeKey: `verdict:${v.verdict || ''}`,
    });
  }

  // Sort chronologically. ISO strings sort lexicographically; empty ts sinks last.
  raw.sort((a, b) => {
    if (!a.ts && !b.ts) return 0;
    if (!a.ts) return 1;
    if (!b.ts) return -1;
    return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
  });

  // Collapse CONSECUTIVE identical `decision` entries into one with a ×N badge.
  const collapsed: TimelineNode[] = [];
  for (const node of raw) {
    const prev = collapsed[collapsed.length - 1];
    if (
      prev &&
      prev.kind === 'decision' &&
      node.kind === 'decision' &&
      prev.dedupeKey === node.dedupeKey
    ) {
      prev.count += 1;
      // Keep the latest timestamp for the collapsed group.
      if (node.ts && (!prev.ts || node.ts > prev.ts)) {
        prev.ts = node.ts;
      }
      continue;
    }
    collapsed.push({ ...node });
  }

  return collapsed;
}

/**
 * C3-7 — chronological case timeline. Merges `Case.history` (analyst_action /
 * decision / attach) and `Case.verdict_history` into one stream, dedupes
 * consecutive identical decision spam with a ×N badge, and highlights verdict
 * changes with a coloured badge matching the header verdict colour. Renders as
 * an `EuiCommentList`. All log/note text is rendered as plain text, never markup.
 */
export const CaseTimeline: React.FC<CaseTimelineProps> = ({ theCase }) => {
  const nodes = buildNodes(theCase);

  if (!nodes.length) {
    return (
      <EuiText size="s" color="subdued">
        <p>No history yet.</p>
      </EuiText>
    );
  }

  return (
    <EuiCommentList aria-label="Case history timeline">
      {nodes.map((node, i) => {
        const style = kindStyle(node.kind);
        const event = (
          <EuiText size="xs">
            <span>{node.sentence}</span>
            {node.count > 1 ? (
              <>
                {' '}
                <EuiBadge color="hollow">×{node.count}</EuiBadge>
              </>
            ) : null}
            {node.kind === 'verdict' && node.verdict ? (
              <>
                {' '}
                <EuiBadge color={verdictBadgeColor(node.verdict)}>{node.verdict}</EuiBadge>
              </>
            ) : null}
          </EuiText>
        );
        return (
          <EuiComment
            key={i}
            username=""
            timelineAvatar={
              <EuiAvatar
                name={node.kind}
                iconType={style.icon}
                color={style.color}
                iconColor="#ffffff"
                size="s"
              />
            }
            timelineAvatarAriaLabel={node.kind}
            event={event}
            timestamp={node.ts || undefined}
          >
            {node.note ? (
              <EuiText size="s" color="subdued">
                {/* Analyst note — rendered as plain text. */}
                <p>“{node.note}”</p>
              </EuiText>
            ) : null}
          </EuiComment>
        );
      })}
    </EuiCommentList>
  );
};
