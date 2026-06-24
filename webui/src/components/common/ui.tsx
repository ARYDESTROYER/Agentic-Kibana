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
import { DASH, fmtPercent, humanizeAge, humanizeToken } from '../../lib/format';
import {
  COLORS,
  RADIUS,
  riskBand,
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

export const ConfidenceBadge: React.FC<{
  confidence?: number;
  /** Optional auto-close confidence bar (0..1) for a calibration-aware tooltip. */
  threshold?: number;
  /** Optional extra note appended to the tooltip. */
  note?: string;
}> = ({ confidence, threshold, note }) => {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return null;
  }
  let content: React.ReactNode = 'Agent confidence in the verdict';
  if (typeof threshold === 'number' && !Number.isNaN(threshold)) {
    const rel = confidence >= threshold ? 'above' : 'below';
    content = `Confidence ${confidence.toFixed(2)} — ${rel} the ${threshold.toFixed(2)} auto-close bar`;
  }
  if (note) {
    content = (
      <span>
        {content}
        <br />
        {note}
      </span>
    );
  }
  return (
    <EuiToolTip content={content}>
      <EuiBadge color="hollow" iconType="visGauge">
        {fmtPercent(confidence)} conf
      </EuiBadge>
    </EuiToolTip>
  );
};

/* --------------------------------------------------------- posture badge --- */

const POSTURE_META: Record<
  'auto_closed' | 'needs_human' | 'awaiting_approval' | 'open' | 'closed',
  { label: string; color: string }
> = {
  auto_closed: { label: 'Auto-closed by policy', color: COLORS.success },
  needs_human: { label: 'Held for human', color: COLORS.warning },
  awaiting_approval: { label: 'Awaiting approval', color: COLORS.accent },
  open: { label: 'Open', color: COLORS.primary },
  closed: { label: 'Closed', color: COLORS.subdued },
};

/**
 * A small badge describing a case's AUTONOMY posture (how it got where it is),
 * distinct from lifecycle status. Fixed human labels; semantic colour from theme.
 */
export const PostureBadge: React.FC<{
  posture: 'auto_closed' | 'needs_human' | 'awaiting_approval' | 'open' | 'closed';
  label?: string;
}> = ({ posture, label }) => {
  const meta = POSTURE_META[posture] || POSTURE_META.open;
  return <EuiBadge color={meta.color}>{label || meta.label}</EuiBadge>;
};

/* ------------------------------------------------------------ MITRE list --- */

/** ~40 common ATT&CK techniques (id → name). UNTRUSTED-safe (plain text). */
export const MITRE_TECHNIQUES: Record<string, string> = {
  T1003: 'OS Credential Dumping',
  T1005: 'Data from Local System',
  T1010: 'Application Window Discovery',
  T1016: 'System Network Configuration Discovery',
  T1018: 'Remote System Discovery',
  T1021: 'Remote Services',
  T1027: 'Obfuscated Files or Information',
  T1033: 'System Owner/User Discovery',
  T1036: 'Masquerading',
  T1041: 'Exfiltration Over C2 Channel',
  T1046: 'Network Service Scanning',
  T1047: 'Windows Management Instrumentation',
  T1053: 'Scheduled Task/Job',
  T1055: 'Process Injection',
  T1056: 'Input Capture',
  T1057: 'Process Discovery',
  T1059: 'Command & Scripting Interpreter',
  T1068: 'Exploitation for Privilege Escalation',
  T1070: 'Indicator Removal',
  T1071: 'Application Layer Protocol',
  T1078: 'Valid Accounts',
  T1082: 'System Information Discovery',
  T1083: 'File and Directory Discovery',
  T1087: 'Account Discovery',
  T1090: 'Proxy',
  T1098: 'Account Manipulation',
  T1105: 'Ingress Tool Transfer',
  T1110: 'Brute Force',
  T1112: 'Modify Registry',
  T1133: 'External Remote Services',
  T1136: 'Create Account',
  T1190: 'Exploit Public-Facing Application',
  T1203: 'Exploitation for Client Execution',
  T1204: 'User Execution',
  T1486: 'Data Encrypted for Impact',
  T1490: 'Inhibit System Recovery',
  T1496: 'Resource Hijacking',
  T1498: 'Network Denial of Service',
  T1505: 'Server Software Component',
  T1543: 'Create or Modify System Process',
  T1547: 'Boot or Logon Autostart Execution',
  T1548: 'Abuse Elevation Control Mechanism',
  T1562: 'Impair Defenses',
  T1566: 'Phishing',
  T1567: 'Exfiltration Over Web Service',
  T1571: 'Non-Standard Port',
  T1573: 'Encrypted Channel',
};

/**
 * Render MITRE ATT&CK technique ids as hollow badge chips `Txxxx · Name`.
 * Unknown ids render the id alone. `max` truncates with a "+N" chip. Ids are
 * UNTRUSTED (may be arbitrary) → rendered as plain text only.
 */
export const MitreList: React.FC<{ ids?: string[]; max?: number }> = ({ ids, max }) => {
  const list = (ids || []).filter((x) => typeof x === 'string' && x.trim());
  if (!list.length) return null;
  const shown = typeof max === 'number' && max > 0 ? list.slice(0, max) : list;
  const extra = list.length - shown.length;
  return (
    <EuiFlexGroup gutterSize="xs" responsive={false} wrap alignItems="center">
      {shown.map((raw, i) => {
        const id = raw.trim();
        const name = MITRE_TECHNIQUES[id.toUpperCase()];
        const text = name ? `${id} · ${name}` : id;
        return (
          <EuiFlexItem grow={false} key={`${id}-${i}`}>
            <EuiToolTip content={name || id}>
              <EuiBadge color="hollow">{text}</EuiBadge>
            </EuiToolTip>
          </EuiFlexItem>
        );
      })}
      {extra > 0 ? (
        <EuiFlexItem grow={false}>
          <EuiBadge color="hollow">{`+${extra}`}</EuiBadge>
        </EuiFlexItem>
      ) : null}
    </EuiFlexGroup>
  );
};

/* ------------------------------------------------------------ urgency pill - */

/**
 * A small urgency pill derived from case age × risk band — Fresh / Aging /
 * Overdue. Closed / auto-closed cases show no pill (nothing to triage).
 */
export const UrgencyPill: React.FC<{
  createdAt?: string;
  riskScore?: number;
  status?: string;
}> = ({ createdAt, riskScore, status }) => {
  const s = (status || '').toLowerCase();
  if (s === 'closed' || s === 'auto_closed') return null;
  if (!createdAt) return null;
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return null;
  const ageHrs = (Date.now() - ts) / 3_600_000;
  if (ageHrs < 0) return null;
  // High risk shortens the windows; low risk lengthens them.
  const r = typeof riskScore === 'number' && !Number.isNaN(riskScore) ? riskScore : 40;
  const freshMax = r >= 80 ? 1 : r >= 60 ? 4 : r >= 30 ? 12 : 24;
  const agingMax = r >= 80 ? 4 : r >= 60 ? 12 : r >= 30 ? 36 : 72;
  let label = 'Fresh';
  let color = COLORS.success;
  if (ageHrs > agingMax) {
    label = 'Overdue';
    color = COLORS.danger;
  } else if (ageHrs > freshMax) {
    label = 'Aging';
    color = COLORS.warning;
  }
  return (
    <EuiToolTip content={`Opened ${humanizeAge(createdAt)} · ${riskBand(riskScore).label.toLowerCase()} risk`}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '1px 8px',
          borderRadius: RADIUS.pill,
          fontSize: TYPE.label,
          fontWeight: WEIGHT.semibold,
          color,
          background: tint(color, 0.14),
          boxShadow: `inset 0 0 0 1px ${tint(color, 0.28)}`,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </EuiToolTip>
  );
};

/* -------------------------------------------------------------- nav tile --- */

interface NavTileProps {
  label: string;
  value: React.ReactNode;
  icon?: string;
  accent?: string;
  sub?: React.ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
}

/**
 * Visually identical to `StatTile` (coloured top border) but, when `onClick` is
 * set, becomes an accessible button: role/tabIndex, Enter/Space activation,
 * pointer cursor, focus-visible ring (from index.css), and an `aria-label`.
 */
export const NavTile: React.FC<NavTileProps> = ({
  label,
  value,
  icon,
  accent = COLORS.primary,
  sub,
  onClick,
  ariaLabel,
}) => {
  const clickable = typeof onClick === 'function';
  return (
    <EuiPanel
      hasBorder
      paddingSize="m"
      className={`socStat socTile${clickable ? ' socCard--clickable' : ''}`}
      style={{ borderTop: `3px solid ${accent}`, borderRadius: RADIUS.lg, cursor: clickable ? 'pointer' : undefined }}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? ariaLabel || label : undefined}
      onKeyDown={
        clickable
          ? (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
        {icon ? (
          <EuiFlexItem grow={false}>
            <IconChip icon={icon} accent={accent} />
          </EuiFlexItem>
        ) : null}
        <EuiFlexItem>
          <div className="socTile__label">{label}</div>
          <div style={{ fontSize: TYPE.kpi, fontWeight: WEIGHT.bold, lineHeight: 1.15, letterSpacing: -0.3 }}>
            {value}
          </div>
          {sub ? (
            <EuiText size="xs" color="subdued">
              <span>{sub}</span>
            </EuiText>
          ) : null}
        </EuiFlexItem>
      </EuiFlexGroup>
    </EuiPanel>
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

export const Loading: React.FC<{ label?: string; center?: boolean }> = ({
  label = 'Loading…',
  center,
}) => (
  <EuiFlexGroup
    className="socFadeIn"
    alignItems="center"
    justifyContent={center ? 'center' : 'flexStart'}
    gutterSize="s"
    responsive={false}
    style={center ? { padding: 48, minHeight: 220 } : { padding: 24 }}
  >
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

/**
 * A slim, indeterminate brand-gradient loading bar (CSS `.socLoadingBar`). Drop
 * it at the top of a panel/page while data is in flight — lighter-weight than a
 * full spinner block and reads as "working" without shifting layout. Reduced-
 * motion users get a static sliver (the surrounding spinner/skeleton conveys state).
 */
export const LoadingBar: React.FC<{ label?: string }> = ({ label = 'Loading' }) => (
  <div className="socLoadingBar" role="progressbar" aria-label={label} aria-busy="true" />
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
