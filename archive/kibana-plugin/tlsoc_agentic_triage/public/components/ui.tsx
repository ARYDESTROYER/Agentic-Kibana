/**
 * Shared visual language for the TLSOC surfaces.
 *
 * This module is the single source of truth for the suite's colour scheme, status
 * / verdict / risk semantics, and the small reusable presentational primitives
 * (section headers, KPI tiles, badges, empty states) that every tab composes. It
 * is built ONLY from `@elastic/eui` + monorepo packages — no new dependencies —
 * so it builds for both 8.12.2 and 8.19.12.
 *
 * Design intent: a calm, consistent SOC console. One accent per semantic meaning,
 * generous whitespace, soft elevation, and colour used to encode risk/verdict at
 * a glance rather than for decoration.
 */
import React from 'react';
import {
  EuiBadge,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiIcon,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import { DASH, fmtPercent, humanizeToken } from '../lib/format';

/* ------------------------------------------------------------------ palette - */

/**
 * Semantic colour tokens. Hexes chosen to read well on Kibana's light chrome and
 * to match EUI's Amsterdam intent (primary blue, teal success, amber warning,
 * red danger, violet accent). Used for accents/borders/icon chips; EUI badges and
 * health dots accept these directly.
 */
export const COLORS = {
  primary: '#1c66e0',
  success: '#00a38c',
  warning: '#e9a200',
  danger: '#c4341c',
  accent: '#8a55c9',
  subdued: '#69707d',
  // Soft surface tints used for panel/section backgrounds.
  surface: '#f7f9fc',
} as const;

/** Translucent tint of a hex colour, used for icon chips / soft fills. */
export function tint(hex: string, alpha = 0.12): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ------------------------------------------------------------- semantics ---- */

/** Named EUI badge colour for a verdict (TRUE_POSITIVE/FALSE_POSITIVE/...). */
export function verdictColor(verdict?: string): 'danger' | 'success' | 'warning' | 'default' {
  const v = (verdict || '').toUpperCase();
  if (v.includes('TRUE')) return 'danger';
  if (v.includes('FALSE')) return 'success';
  if (v.includes('INCONCLUSIVE') || v.includes('UNKNOWN') || v.includes('NEEDS_HUMAN')) {
    return 'warning';
  }
  return 'default';
}

/** Hex accent for a verdict (for left borders / icon chips). */
export function verdictHex(verdict?: string): string {
  switch (verdictColor(verdict)) {
    case 'danger':
      return COLORS.danger;
    case 'success':
      return COLORS.success;
    case 'warning':
      return COLORS.warning;
    default:
      return COLORS.subdued;
  }
}

/** Hex accent for a case lifecycle status. */
export function statusHex(status?: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'closed') return COLORS.success;
  if (s === 'needs_human') return COLORS.warning;
  if (s === 'open') return COLORS.primary;
  return COLORS.subdued;
}

/**
 * Risk colour scale over the normalised 0..100 risk score: low (teal) → moderate
 * (amber) → elevated (orange) → high (red).
 */
export function riskHex(score?: number): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return COLORS.subdued;
  if (score < 30) return COLORS.success;
  if (score < 60) return COLORS.warning;
  if (score < 80) return '#e2725b';
  return COLORS.danger;
}

/* --------------------------------------------------------------- badges ----- */

/** Risk score badge, coloured by the risk scale. */
export const RiskBadge: React.FC<{ score?: number }> = ({ score }) => {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return <EuiBadge color="hollow">risk {DASH}</EuiBadge>;
  }
  return (
    <EuiToolTip content={`Normalised risk score (0–100): ${score}`}>
      <EuiBadge color={riskHex(score)}>Risk {Math.round(score)}</EuiBadge>
    </EuiToolTip>
  );
};

/** Verdict badge, coloured by verdict semantics. */
export const VerdictBadge: React.FC<{ verdict?: string }> = ({ verdict }) => {
  if (!verdict) {
    return (
      <EuiBadge color="hollow" iconType="dot">
        Unverdicted
      </EuiBadge>
    );
  }
  return <EuiBadge color={verdictColor(verdict)}>{humanizeToken(verdict)}</EuiBadge>;
};

/** Lifecycle status as a coloured health dot + label. */
export const StatusBadge: React.FC<{ status?: string }> = ({ status }) => (
  <EuiHealth color={statusHex(status)}>{humanizeToken(status)}</EuiHealth>
);

/** Confidence badge (accepts a 0..1 or 0..100 value). */
export const ConfidenceBadge: React.FC<{ confidence?: number }> = ({ confidence }) => {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return null;
  }
  return (
    <EuiToolTip content="Agent confidence in the verdict">
      <EuiBadge color="hollow" iconType="visGauge">
        {fmtPercent(confidence)} conf
      </EuiBadge>
    </EuiToolTip>
  );
};

/* --------------------------------------------------------- section header --- */

interface SectionHeaderProps {
  /** Icon shown in the title chip. */
  icon?: string;
  /** Hex accent for the icon chip (defaults to primary). */
  accent?: string;
  title: string;
  /** Optional one-line description under the title. */
  description?: React.ReactNode;
  /** Right-aligned action(s) — e.g. a Refresh button. */
  actions?: React.ReactNode;
}

/**
 * Standard surface header: an accented icon chip + title (+ optional description)
 * on the left, actions on the right. Use at the top of every tab so they share a
 * rhythm.
 */
export const SectionHeader: React.FC<SectionHeaderProps> = ({
  icon,
  accent = COLORS.primary,
  title,
  description,
  actions,
}) => (
  <>
    <EuiFlexGroup
      justifyContent="spaceBetween"
      alignItems="center"
      gutterSize="m"
      responsive={false}
      wrap
    >
      <EuiFlexItem grow={false}>
        <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
          {icon ? (
            <EuiFlexItem grow={false}>
              <span
                className="tlsocIconChip"
                style={{ background: tint(accent, 0.14), color: accent }}
              >
                <EuiIcon type={icon} size="m" />
              </span>
            </EuiFlexItem>
          ) : null}
          <EuiFlexItem grow={false}>
            <EuiTitle size="m">
              <h2>{title}</h2>
            </EuiTitle>
            {description ? (
              <EuiText size="xs" color="subdued">
                <span>{description}</span>
              </EuiText>
            ) : null}
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlexItem>
      {actions ? <EuiFlexItem grow={false}>{actions}</EuiFlexItem> : null}
    </EuiFlexGroup>
    <EuiSpacer size="l" />
  </>
);

/* ------------------------------------------------------------- stat tile ---- */

interface StatTileProps {
  label: string;
  value: React.ReactNode;
  icon?: string;
  /** Hex accent for the top border + icon chip. */
  accent?: string;
  /** Optional secondary line under the value. */
  sub?: React.ReactNode;
}

/** A KPI tile: accented top border, icon chip, big value, and a label. */
export const StatTile: React.FC<StatTileProps> = ({
  label,
  value,
  icon,
  accent = COLORS.primary,
  sub,
}) => (
  <EuiPanel hasBorder paddingSize="m" className="tlsocStatTile" style={{ borderTop: `3px solid ${accent}` }}>
    <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
      {icon ? (
        <EuiFlexItem grow={false}>
          <span className="tlsocIconChip" style={{ background: tint(accent, 0.14), color: accent }}>
            <EuiIcon type={icon} size="m" />
          </span>
        </EuiFlexItem>
      ) : null}
      <EuiFlexItem>
        <EuiText size="xs" color="subdued">
          <span>{label}</span>
        </EuiText>
        <div className="tlsocStatTile__value">{value}</div>
        {sub ? (
          <EuiText size="xs" color="subdued">
            <span>{sub}</span>
          </EuiText>
        ) : null}
      </EuiFlexItem>
    </EuiFlexGroup>
  </EuiPanel>
);

/* ----------------------------------------------------------- empty state ---- */

interface EmptyStateProps {
  iconType?: string;
  title: string;
  body?: React.ReactNode;
}

/** A centered, calm empty state for surfaces with no data yet. */
export const EmptyState: React.FC<EmptyStateProps> = ({
  iconType = 'inspect',
  title,
  body,
}) => (
  <EuiPanel color="subdued" hasShadow={false} paddingSize="l" className="tlsocEmptyState">
    <EuiFlexGroup direction="column" alignItems="center" gutterSize="s" responsive={false}>
      <EuiFlexItem grow={false}>
        <span className="tlsocIconChip tlsocIconChip--lg" style={{ background: tint(COLORS.primary, 0.12), color: COLORS.primary }}>
          <EuiIcon type={iconType} size="l" />
        </span>
      </EuiFlexItem>
      <EuiFlexItem grow={false}>
        <EuiText size="s" textAlign="center">
          <strong>{title}</strong>
        </EuiText>
      </EuiFlexItem>
      {body ? (
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued" textAlign="center">
            <span>{body}</span>
          </EuiText>
        </EuiFlexItem>
      ) : null}
    </EuiFlexGroup>
  </EuiPanel>
);
