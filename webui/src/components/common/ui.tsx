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
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import { DASH, fmtPercent, humanizeToken } from '../../lib/format';
import { COLORS, riskHex, statusHex, tint, verdictColor } from '../../lib/theme';
import { Sparkline } from './charts';

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
}

export const StatTile: React.FC<StatTileProps> = ({
  label,
  value,
  icon,
  accent = COLORS.primary,
  sub,
}) => (
  <EuiPanel hasBorder paddingSize="m" style={{ borderTop: `3px solid ${accent}` }}>
    <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
      {icon ? (
        <EuiFlexItem grow={false}>
          <IconChip icon={icon} accent={accent} />
        </EuiFlexItem>
      ) : null}
      <EuiFlexItem>
        <EuiText size="xs" color="subdued">
          <span>{label}</span>
        </EuiText>
        <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
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
}

/** A titled panel with an optional icon chip + actions row — the workhorse
 *  container for dashboard widgets and case/source cards. */
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
}) => (
  <EuiPanel
    hasBorder
    paddingSize={paddingSize}
    className={`socCard${clickable ? ' socCard--clickable' : ''}${accentLeft ? ' socAccentLeft' : ''}`}
    style={accentLeft ? { borderLeftColor: accentLeft } : undefined}
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
            <EuiTitle size="xxs">
              <h3>{title}</h3>
            </EuiTitle>
          </EuiFlexItem>
          {actions ? <EuiFlexItem grow={false}>{actions}</EuiFlexItem> : null}
        </EuiFlexGroup>
        <EuiSpacer size="m" />
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
}

/** A KPI tile with an optional sparkline footer. */
export const TrendStat: React.FC<TrendStatProps> = ({
  label,
  value,
  icon,
  accent = COLORS.primary,
  sub,
  spark,
}) => (
  <EuiPanel hasBorder paddingSize="m" className="socStat" style={{ borderTop: `3px solid ${accent}` }}>
    <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
      {icon ? (
        <EuiFlexItem grow={false}>
          <IconChip icon={icon} accent={accent} />
        </EuiFlexItem>
      ) : null}
      <EuiFlexItem>
        <EuiText size="xs" color="subdued"><span>{label}</span></EuiText>
        <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
        {sub ? <EuiText size="xs" color="subdued"><span>{sub}</span></EuiText> : null}
      </EuiFlexItem>
    </EuiFlexGroup>
    {spark && spark.length > 1 ? (
      <div style={{ marginTop: 8 }}>
        <Sparkline values={spark} color={accent} height={36} />
      </div>
    ) : null}
  </EuiPanel>
);
