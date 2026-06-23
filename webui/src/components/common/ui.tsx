/**
 * Reusable presentational primitives shared by every surface. Adapted from the
 * former Kibana plugin's `ui.tsx`, rebuilt on plain EUI (no `@kbn/*`).
 */
import React from 'react';
import {
  EuiBadge,
  EuiCallOut,
  EuiEmptyPrompt,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiIcon,
  EuiLoadingSpinner,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import { DASH, fmtPercent, humanizeToken } from '../../lib/format';
import { COLORS, riskHex, statusHex, tint, TYPE, verdictColor } from '../../lib/theme';
import { Sparkline } from './charts';

/* ------------------------------------------------------------- skeleton ---- */

/**
 * A shimmering placeholder. Render a single block by default, or `rows` stacked
 * lines (the last row is shortened, mimicking text). Honours
 * `prefers-reduced-motion` via the `.socSkeleton` CSS.
 */
export const Skeleton: React.FC<{
  /** Block height (px) — used in single-block mode. */
  height?: number;
  /** Block / row width (CSS length). */
  width?: string | number;
  /** When set, renders this many text-like rows instead of one block. */
  rows?: number;
  /** Border radius (px). */
  radius?: number;
  style?: React.CSSProperties;
}> = ({ height = 16, width = '100%', rows, radius = 6, style }) => {
  if (rows && rows > 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="socSkeleton"
            style={{
              height,
              width: i === rows - 1 ? '60%' : '100%',
              borderRadius: radius,
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      className="socSkeleton"
      style={{ height, width, borderRadius: radius, ...style }}
    />
  );
};

/* ------------------------------------------------------------ page header -- */

interface PageHeaderProps {
  /** Small uppercase eyebrow above the title. */
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  icon?: string;
  accent?: string;
  /** Right-aligned actions (window selectors, refresh, etc.). */
  actions?: React.ReactNode;
}

/**
 * The page-level header — an eyebrow + large title + optional right-aligned
 * actions, built on the same icon-chip language as `SectionHeader`. Use this at
 * the top of a page; use `SectionHeader` for sub-sections within a page.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  eyebrow,
  title,
  description,
  icon,
  accent = COLORS.primary,
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
              <IconChip icon={icon} accent={accent} large />
            </EuiFlexItem>
          ) : null}
          <EuiFlexItem grow={false}>
            {eyebrow ? (
              <div
                style={{
                  fontSize: TYPE.label,
                  letterSpacing: 0.6,
                  textTransform: 'uppercase',
                  fontWeight: 700,
                  color: accent,
                }}
              >
                {eyebrow}
              </div>
            ) : null}
            <div style={{ fontSize: TYPE.h1, fontWeight: 700, lineHeight: 1.15 }}>{title}</div>
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

/** A coloured ▲/▼ delta chip used by KPI tiles. Positive = `up` semantics. */
const DeltaChip: React.FC<{ delta: number; goodWhenUp?: boolean }> = ({
  delta,
  goodWhenUp = true,
}) => {
  if (typeof delta !== 'number' || Number.isNaN(delta) || delta === 0) return null;
  const up = delta > 0;
  const good = up === goodWhenUp;
  const color = good ? COLORS.success : COLORS.danger;
  return (
    <span style={{ color, fontSize: TYPE.label, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {up ? '▲' : '▼'} {Math.abs(delta)}
      {'%'}
    </span>
  );
};

/* ----------------------------------------------------------------- badges -- */

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

export const StatusBadge: React.FC<{ status?: string }> = ({ status }) => (
  <EuiHealth color={statusHex(status)}>{humanizeToken(status)}</EuiHealth>
);

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

/* ---------------------------------------------------------- icon chip ------ */

export const IconChip: React.FC<{ icon: string; accent?: string; large?: boolean }> = ({
  icon,
  accent = COLORS.primary,
  large,
}) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: large ? 48 : 36,
      height: large ? 48 : 36,
      borderRadius: 10,
      background: tint(accent, 0.14),
      color: accent,
    }}
  >
    <EuiIcon type={icon} size={large ? 'l' : 'm'} />
  </span>
);

/* ----------------------------------------------------------- section ------- */

interface SectionHeaderProps {
  icon?: string;
  accent?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}

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
              <IconChip icon={icon} accent={accent} />
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

/* ------------------------------------------------------------- stat tile --- */

interface StatTileProps {
  label: string;
  value: React.ReactNode;
  icon?: string;
  accent?: string;
  sub?: React.ReactNode;
  /** Optional percentage delta vs the previous period (▲/▼ coloured). */
  delta?: number;
  /** Whether an UP delta should read as good (green). Defaults true. */
  deltaGoodWhenUp?: boolean;
}

export const StatTile: React.FC<StatTileProps> = ({
  label,
  value,
  icon: _icon,
  accent = COLORS.primary,
  sub,
  delta,
  deltaGoodWhenUp,
}) => (
  <div style={{ background: '#fff', border: '1px solid #D3DAE6', borderTop: `3px solid ${accent}`, borderRadius: 6, padding: 16 }}>
    <div style={{ fontSize: 11, color: '#98A2B3', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>{label}</div>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <div style={{ fontSize: TYPE.kpi, fontWeight: 600, color: '#1A1C21', letterSpacing: '-0.01em', lineHeight: 1 }}>{value}</div>
      {typeof delta === 'number' ? (
        <DeltaChip delta={delta} goodWhenUp={deltaGoodWhenUp} />
      ) : null}
    </div>
    {sub ? <div style={{ fontSize: 12, color: '#69707D', marginTop: 4 }}>{sub}</div> : null}
  </div>
);

/* ----------------------------------------------------------- empty state --- */

export const EmptyState: React.FC<{ iconType?: string; title: string; body?: React.ReactNode; actions?: React.ReactNode }> = ({
  iconType = 'inspect',
  title,
  body,
  actions,
}) => (
  <EuiEmptyPrompt
    iconType={iconType}
    color="subdued"
    title={<h3>{title}</h3>}
    body={body ? <p>{body}</p> : undefined}
    actions={actions}
  />
);

/* ----------------------------------------------------- loading / error ----- */

export const Loading: React.FC<{ label?: string }> = ({ label = 'Loading…' }) => (
  <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false} style={{ padding: 24 }}>
    <EuiFlexItem grow={false}>
      <EuiLoadingSpinner size="m" />
    </EuiFlexItem>
    <EuiFlexItem grow={false}>
      <EuiText size="s" color="subdued">
        {label}
      </EuiText>
    </EuiFlexItem>
  </EuiFlexGroup>
);

export const ErrorCallout: React.FC<{ error: unknown; title?: string }> = ({
  error,
  title = 'Something went wrong',
}) => {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  return (
    <EuiCallOut title={title} color="danger" iconType="alert">
      <p>{message}</p>
    </EuiCallOut>
  );
};

/** A small "preview" pill for the not-yet-fully-ported analytics surfaces. */
export const PreviewPill: React.FC = () => (
  <EuiBadge color={COLORS.accent} iconType="beaker">
    Preview
  </EuiBadge>
);

/* ---------------------------------------------------------------- card ----- */

interface CardProps {
  title?: React.ReactNode;
  icon?: string;
  accent?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  clickable?: boolean;
  onClick?: () => void;
  accentLeft?: string;
  paddingSize?: 'm' | 'l';
  /** 'flat' drops the border (and gets a soft surface tint) — for nested cards. */
  variant?: 'flat';
}

/** A titled panel with an optional icon chip + actions row — the workhorse
 *  container for dashboard widgets and case/source cards. Pass `variant="flat"`
 *  for a borderless nested card (no double-border when placed inside a Card). */
export const Card: React.FC<CardProps> = ({
  title,
  icon,
  accent = COLORS.primary,
  actions,
  children,
  clickable,
  onClick,
  accentLeft,
  paddingSize = 'm',
  variant,
}) => (
  <div
    className={`socCard${clickable ? ' socCard--clickable' : ''}${accentLeft ? ' socAccentLeft' : ''}`}
    onClick={onClick}
    style={{
      background: '#fff',
      border: variant === 'flat' ? 'none' : '1px solid #D3DAE6',
      borderRadius: 6,
      padding: paddingSize === 'l' ? 24 : 16,
      cursor: clickable ? 'pointer' : undefined,
      ...(accentLeft ? { borderLeft: `4px solid ${accentLeft}` } : {}),
    }}
  >
    {(title || actions) && (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          {icon ? (
            <span style={{ flex: 'none', display: 'inline-flex' }}>
              <IconChip icon={icon} accent={accent} />
            </span>
          ) : null}
          <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: '#1A1C21' }}>
            {title}
          </div>
          {actions ? <div style={{ flex: 'none' }}>{actions}</div> : null}
        </div>
      </>
    )}
    {children}
  </div>
);

/* ------------------------------------------------------------- trend stat -- */

interface TrendStatProps {
  label: string;
  value: React.ReactNode;
  icon?: string;
  accent?: string;
  sub?: React.ReactNode;
  spark?: number[];
  /** Optional percentage delta vs the previous period (▲/▼ coloured). */
  delta?: number;
  /** Whether an UP delta should read as good (green). Defaults true. */
  deltaGoodWhenUp?: boolean;
}

/** A KPI tile with an optional sparkline footer. */
export const TrendStat: React.FC<TrendStatProps> = ({
  label,
  value,
  icon: _icon,
  accent = COLORS.primary,
  sub,
  spark,
  delta,
  deltaGoodWhenUp,
}) => (
  <div className="socStat" style={{ background: '#fff', border: '1px solid #D3DAE6', borderTop: `3px solid ${accent}`, borderRadius: 6, padding: 16 }}>
    <div style={{ fontSize: 11, color: '#98A2B3', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>{label}</div>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <div style={{ fontSize: TYPE.kpi, fontWeight: 600, color: '#1A1C21', letterSpacing: '-0.01em', lineHeight: 1 }}>{value}</div>
      {typeof delta === 'number' ? (
        <DeltaChip delta={delta} goodWhenUp={deltaGoodWhenUp} />
      ) : null}
    </div>
    {sub ? <div style={{ fontSize: 12, color: '#69707D', marginTop: 4 }}>{sub}</div> : null}
    {spark && spark.length > 1 ? (
      <div style={{ marginTop: 8 }}>
        <Sparkline values={spark} color={accent} height={36} />
      </div>
    ) : null}
  </div>
);
