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
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import { DASH, fmtPercent, humanizeToken } from '../../lib/format';
import {
  COLORS,
  RADIUS,
  riskHex,
  statusHex,
  tint,
  TYPE,
  verdictColor,
  WEIGHT,
} from '../../lib/theme';
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
  <div className="socPageHeader">
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
                  letterSpacing: 0.7,
                  textTransform: 'uppercase',
                  fontWeight: WEIGHT.bold,
                  color: accent,
                  marginBottom: 1,
                }}
              >
                {eyebrow}
              </div>
            ) : null}
            <div style={{ fontSize: TYPE.h1, fontWeight: WEIGHT.bold, lineHeight: 1.15, letterSpacing: -0.2 }}>
              {title}
            </div>
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
    <EuiSpacer size="m" />
  </div>
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
    className="socIconChip"
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      width: large ? 44 : 34,
      height: large ? 44 : 34,
      borderRadius: large ? RADIUS.lg : RADIUS.chip,
      background: tint(accent, 0.13),
      boxShadow: `inset 0 0 0 1px ${tint(accent, 0.22)}`,
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
            <div style={{ fontSize: TYPE.h2, fontWeight: WEIGHT.bold, lineHeight: 1.2, letterSpacing: -0.1 }}>
              {title}
            </div>
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
    <EuiSpacer size="m" />
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
  icon,
  accent = COLORS.primary,
  sub,
  delta,
  deltaGoodWhenUp,
}) => (
  <EuiPanel
    hasBorder
    paddingSize="m"
    className="socStat socTile"
    style={{ borderTop: `3px solid ${accent}`, borderRadius: RADIUS.lg }}
  >
    <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
      {icon ? (
        <EuiFlexItem grow={false}>
          <IconChip icon={icon} accent={accent} />
        </EuiFlexItem>
      ) : null}
      <EuiFlexItem>
        <div className="socTile__label">{label}</div>
        <EuiFlexGroup gutterSize="s" alignItems="baseline" responsive={false} wrap={false}>
          <EuiFlexItem grow={false}>
            <div style={{ fontSize: TYPE.kpi, fontWeight: WEIGHT.bold, lineHeight: 1.15, letterSpacing: -0.3 }}>
              {value}
            </div>
          </EuiFlexItem>
          {typeof delta === 'number' ? (
            <EuiFlexItem grow={false}>
              <DeltaChip delta={delta} goodWhenUp={deltaGoodWhenUp} />
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>
        {sub ? (
          <EuiText size="xs" color="subdued">
            <span>{sub}</span>
          </EuiText>
        ) : null}
      </EuiFlexItem>
    </EuiFlexGroup>
  </EuiPanel>
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
  <EuiPanel
    hasBorder={variant !== 'flat'}
    {...(variant === 'flat' ? { hasShadow: false, color: 'subdued' as const } : {})}
    paddingSize={paddingSize}
    className={`socCard${clickable ? ' socCard--clickable' : ''}${accentLeft ? ' socAccentLeft' : ''}`}
    style={{
      borderRadius: RADIUS.lg,
      ...(accentLeft ? { borderLeftColor: accentLeft } : {}),
    }}
    onClick={onClick}
  >
    {(title || actions) && (
      <>
        <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
          {icon ? (
            <EuiFlexItem grow={false}>
              <IconChip icon={icon} accent={accent} />
            </EuiFlexItem>
          ) : null}
          <EuiFlexItem>
            <div style={{ fontSize: '13px', fontWeight: WEIGHT.semibold, lineHeight: 1.25 }}>
              {title}
            </div>
          </EuiFlexItem>
          {actions ? <EuiFlexItem grow={false}>{actions}</EuiFlexItem> : null}
        </EuiFlexGroup>
        <EuiSpacer size="s" />
      </>
    )}
    {children}
  </EuiPanel>
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
  icon,
  accent = COLORS.primary,
  sub,
  spark,
  delta,
  deltaGoodWhenUp,
}) => (
  <EuiPanel
    hasBorder
    paddingSize="m"
    className="socStat socTile"
    style={{ borderTop: `3px solid ${accent}`, borderRadius: RADIUS.lg }}
  >
    <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
      {icon ? (
        <EuiFlexItem grow={false}>
          <IconChip icon={icon} accent={accent} />
        </EuiFlexItem>
      ) : null}
      <EuiFlexItem>
        <div className="socTile__label">{label}</div>
        <EuiFlexGroup gutterSize="s" alignItems="baseline" responsive={false} wrap={false}>
          <EuiFlexItem grow={false}>
            <div style={{ fontSize: TYPE.kpi, fontWeight: WEIGHT.bold, lineHeight: 1.15, letterSpacing: -0.3 }}>
              {value}
            </div>
          </EuiFlexItem>
          {typeof delta === 'number' ? (
            <EuiFlexItem grow={false}>
              <DeltaChip delta={delta} goodWhenUp={deltaGoodWhenUp} />
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>
        {sub ? <EuiText size="xs" color="subdued"><span>{sub}</span></EuiText> : null}
      </EuiFlexItem>
    </EuiFlexGroup>
    {spark && spark.length > 1 ? (
      <div style={{ marginTop: 10 }}>
        <Sparkline values={spark} color={accent} height={36} />
      </div>
    ) : null}
  </EuiPanel>
);
