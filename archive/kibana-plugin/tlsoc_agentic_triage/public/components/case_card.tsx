/**
 * The one case card used across every surface (Investigate, Automated Scans, and
 * — with a drag handle — the Case Board). Uniform on purpose: a severity-banded
 * accent, the entity + a prominent risk number, verdict/status, rule pills, and a
 * created stamp. Clicking anywhere opens the case (the app-level detail flyout);
 * per-case actions live in the flyout so the cards stay calm and scannable.
 */
import React from 'react';
import { EuiBadge, EuiFlexGroup, EuiFlexItem, EuiText } from '@elastic/eui';
import type { Case } from '../../common';
import { DASH, formatTimestamp, humanizeToken } from '../lib/format';
import { riskBand, riskBandHex, riskBandLabel } from '../lib/cases';
import { COLORS, verdictColor } from './ui';

/** Restrained risk-number colour: most numbers stay ink; only high/critical pop. */
export function riskNumberColor(score?: number): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return COLORS.subdued;
  if (score >= 80) return COLORS.danger;
  if (score >= 60) return '#e2725b';
  return '#1a1c21';
}

export function fmtRisk(score?: number): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return DASH;
  return score.toFixed(2);
}

/** A tiny uppercase, letter-spaced field label (ENTITY / RISK / RULES / CREATED). */
export const MetaLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.07em',
      textTransform: 'uppercase',
      color: COLORS.subdued,
    }}
  >
    {children}
  </span>
);

/** Lifecycle status pill (open = neutral, needs_human = amber, closed = green). */
export const StatusPill: React.FC<{ status?: string }> = ({ status }) => {
  const s = (status || '').toLowerCase();
  if (s === 'open') return <EuiBadge color="hollow">Open</EuiBadge>;
  if (s === 'needs_human') return <EuiBadge color={COLORS.warning}>Needs human</EuiBadge>;
  if (s === 'closed') return <EuiBadge color={COLORS.success}>Closed</EuiBadge>;
  return <EuiBadge color="hollow">{humanizeToken(status)}</EuiBadge>;
};

const MAX_RULES = 3;

interface CaseCardProps {
  theCase: Case;
  selected?: boolean;
  onOpen: () => void;
  /** Optional drag handle (Board) rendered top-left; its own click is isolated. */
  dragHandle?: React.ReactNode;
  /** Optional corner actions (Board menu) rendered top-right; click is isolated. */
  cornerActions?: React.ReactNode;
}

export const CaseCard: React.FC<CaseCardProps> = ({
  theCase: c,
  selected,
  onOpen,
  dragHandle,
  cornerActions,
}) => {
  const band = riskBand(c.risk_score);
  const accent = riskBandHex(band);
  const rules = c.rule_ids || [];
  const shownRules = rules.slice(0, MAX_RULES);
  const extraRules = rules.length - shownRules.length;
  const hasControls = !!dragHandle || !!cornerActions;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="tlsocCard tlsocCaseCard"
      style={{
        height: '100%',
        cursor: 'pointer',
        borderLeft: `4px solid ${accent}`,
        boxShadow: selected ? `0 0 0 2px ${COLORS.primary}` : undefined,
        borderColor: selected ? COLORS.primary : undefined,
      }}
    >
      {/* Board-only control bar: drag handle (left) + actions menu (right). The
          wrapper isolates clicks so neither triggers the card's open handler. */}
      {hasControls ? (
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" gutterSize="xs" responsive={false}>
            <EuiFlexItem grow={false}>{dragHandle}</EuiFlexItem>
            <EuiFlexItem grow={false}>{cornerActions}</EuiFlexItem>
          </EuiFlexGroup>
        </div>
      ) : null}

      {/* ENTITY / RISK labels */}
      <EuiFlexGroup justifyContent="spaceBetween" responsive={false} gutterSize="s">
        <EuiFlexItem grow={false}>
          <MetaLabel>Entity</MetaLabel>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <MetaLabel>Risk</MetaLabel>
        </EuiFlexItem>
      </EuiFlexGroup>

      {/* Entity value (monospace, primary) + prominent risk number. */}
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false} gutterSize="s">
        <EuiFlexItem>
          <span
            style={{
              fontFamily: 'monospace',
              fontWeight: 600,
              fontSize: 15,
              color: COLORS.primary,
              wordBreak: 'break-all',
            }}
          >
            {c.entity ? `${c.entity.type}: ${c.entity.value}` : c.title || c.case_id}
          </span>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <span style={{ fontSize: 24, fontWeight: 700, lineHeight: 1, color: riskNumberColor(c.risk_score) }}>
            {fmtRisk(c.risk_score)}
          </span>
        </EuiFlexItem>
      </EuiFlexGroup>

      {/* Severity band + verdict chips. */}
      <div style={{ marginTop: 8 }}>
        <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false} wrap>
          {band !== 'unknown' ? (
            <EuiFlexItem grow={false}>
              <EuiBadge color={accent}>{riskBandLabel(band)}</EuiBadge>
            </EuiFlexItem>
          ) : null}
          {c.verdict ? (
            <EuiFlexItem grow={false}>
              <EuiBadge color={verdictColor(c.verdict)}>{humanizeToken(c.verdict)}</EuiBadge>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>
      </div>

      {/* Rules. */}
      <div style={{ marginTop: 12 }}>
        <MetaLabel>Rules</MetaLabel>
        <div style={{ marginTop: 4 }}>
          {shownRules.length ? (
            <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
              {shownRules.map((r) => (
                <EuiFlexItem grow={false} key={r}>
                  <EuiBadge color="hollow">{r}</EuiBadge>
                </EuiFlexItem>
              ))}
              {extraRules > 0 ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color="hollow">+{extraRules}</EuiBadge>
                </EuiFlexItem>
              ) : null}
            </EuiFlexGroup>
          ) : (
            <EuiText size="xs" color="subdued">
              <span>{DASH}</span>
            </EuiText>
          )}
        </div>
      </div>

      {/* Divider + CREATED / status. */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid #e3e8f0',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div>
          <MetaLabel>Created</MetaLabel>
          <EuiText size="s">
            <span>{formatTimestamp(c.created_at)}</span>
          </EuiText>
        </div>
        <StatusPill status={c.status} />
      </div>
    </div>
  );
};
