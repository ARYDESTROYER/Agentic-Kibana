/**
 * Cost & Tokens surface.
 *
 * A polished, at-a-glance dashboard for the suite's LLM spend. Every model call
 * goes through the single gateway → cost ledger, and this tab summarises the last
 * 24h of that ledger: headline KPIs, weighted breakdowns (by model / role /
 * surface), a dependency-free cost-over-time bar list, and the top cost drivers.
 *
 * Built ONLY from `@elastic/eui` + the shared design system (`./ui`, `../lib`),
 * no new deps and no `@elastic/charts`, so it builds for 8.12.2 and 8.19.12 alike.
 */
import React, { useEffect, useState } from 'react';
import {
  EuiButton,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiLoadingSpinner,
  EuiPanel,
  EuiProgress,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { UsageSummary } from '../../common';
import type { TlsocApi } from '../lib/api';
import { DASH, fmtMoney, fmtNumber, fmtTokens, formatTimestamp } from '../lib/format';
import { COLORS, EmptyState, SectionHeader, StatTile, tint } from './ui';

interface CostProps {
  api: TlsocApi;
}

/** One row of a cost breakdown ({ key, cost, tokens, calls }). */
type BreakdownRow = { key: string; cost: number; tokens: number; calls: number };

/**
 * Map a hex accent to the nearest named EUI palette colour. `EuiProgress`'s
 * `color` prop takes named palette tokens (not arbitrary hex), so the breakdown
 * cards pass a name here while still carrying their own hex accent for chips.
 */
function progressColor(accent: string): 'primary' | 'success' | 'warning' | 'accent' {
  switch (accent) {
    case COLORS.success:
      return 'success';
    case COLORS.warning:
      return 'warning';
    case COLORS.accent:
      return 'accent';
    default:
      return 'primary';
  }
}

/**
 * Render an `ts` value that may be either an epoch-millis string ("17182…") or an
 * ISO timestamp. Pure-digit strings are converted via `Date` before formatting;
 * everything else is passed straight to the shared formatter.
 */
function formatBucketTime(ts: string): string {
  if (/^\d+$/.test(ts)) {
    const d = new Date(Number(ts));
    return Number.isNaN(d.getTime()) ? ts : formatTimestamp(d.toISOString());
  }
  return formatTimestamp(ts);
}

/* --------------------------------------------------------------- breakdown -- */

/**
 * One breakdown card (By model / By role / By surface): a titled icon-chip
 * header over a tidy list of rows. Each row shows its key, a thin proportional
 * cost bar (weight relative to the biggest spender in this breakdown), and the
 * cost / tokens / calls. Rows are sorted by cost descending.
 */
function BreakdownCard({
  title,
  icon,
  accent,
  items,
  currency,
}: {
  title: string;
  icon: string;
  accent: string;
  items?: BreakdownRow[];
  currency?: string;
}) {
  if (!items || items.length === 0) {
    return null;
  }
  const rows = [...items].sort((a, b) => (b.cost || 0) - (a.cost || 0));
  // Guard the denominator so a max of 0 doesn't divide-by-zero the bars.
  const maxCost = Math.max(...rows.map((r) => r.cost || 0), 0.0000001);

  return (
    <EuiFlexItem style={{ minWidth: 280 }}>
      <EuiPanel hasBorder paddingSize="m" className="tlsocCard" style={{ height: '100%' }}>
        {/* Card header: accented icon chip + title. */}
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <span className="tlsocIconChip" style={{ background: tint(accent, 0.14), color: accent }}>
              <EuiIcon type={icon} size="m" />
            </span>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiTitle size="xxs">
              <h3>{title}</h3>
            </EuiTitle>
          </EuiFlexItem>
        </EuiFlexGroup>

        <EuiSpacer size="m" />

        {/* Rows: key + proportional bar over a cost / tokens / calls meta line. */}
        {rows.map((r, idx) => (
          <div key={`${r.key}-${idx}`} style={{ marginBottom: idx === rows.length - 1 ? 0 : 14 }}>
            <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
              <EuiFlexItem>
                <EuiText size="s" className="eui-textTruncate">
                  <strong title={r.key}>{r.key || DASH}</strong>
                </EuiText>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiText size="s">
                  <strong>{fmtMoney(r.cost, currency)}</strong>
                </EuiText>
              </EuiFlexItem>
            </EuiFlexGroup>
            <EuiSpacer size="xs" />
            <EuiProgress
              value={r.cost || 0}
              max={maxCost}
              size="s"
              color={progressColor(accent)}
            />
            <EuiSpacer size="xs" />
            <EuiText size="xs" color="subdued">
              <span>
                {fmtTokens(r.tokens)} tokens · {fmtNumber(r.calls)} calls
              </span>
            </EuiText>
          </div>
        ))}
      </EuiPanel>
    </EuiFlexItem>
  );
}

/* ------------------------------------------------------------- over time ---- */

/**
 * Cost over time as a clean, dependency-free horizontal bar list: each bucket is
 * a row of [time label] [proportional bar] [cost]. Bars are weighted against the
 * most expensive bucket so the spend shape reads at a glance.
 */
function CostOverTime({
  data,
  currency,
}: {
  data?: Array<{ ts: string; cost: number }>;
  currency?: string;
}) {
  if (!data || data.length === 0) {
    return null;
  }
  const max = Math.max(...data.map((d) => d.cost || 0), 0.0000001);

  return (
    <EuiPanel hasBorder paddingSize="m" className="tlsocCard">
      {/* Header: accented icon chip + title. */}
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
        <EuiFlexItem grow={false}>
          <span
            className="tlsocIconChip"
            style={{ background: tint(COLORS.success, 0.14), color: COLORS.success }}
          >
            <EuiIcon type="visAreaStacked" size="m" />
          </span>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiTitle size="xxs">
            <h3>Cost over time</h3>
          </EuiTitle>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {data.map((d, i) => (
        <EuiFlexGroup
          key={i}
          gutterSize="s"
          alignItems="center"
          responsive={false}
          style={{ marginBottom: i === data.length - 1 ? 0 : 8 }}
        >
          <EuiFlexItem grow={false} style={{ width: 150 }}>
            <EuiText size="xs" color="subdued" className="eui-textTruncate">
              <span>{formatBucketTime(d.ts)}</span>
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiProgress value={d.cost || 0} max={max} size="s" color="success" />
          </EuiFlexItem>
          <EuiFlexItem grow={false} style={{ width: 90, textAlign: 'right' }}>
            <EuiText size="xs">
              <span>{fmtMoney(d.cost, currency)}</span>
            </EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>
      ))}
    </EuiPanel>
  );
}

/* --------------------------------------------------------- cost drivers ----- */

/** A human label for a cost-driver column key ("total_cost" -> "Total cost"). */
function driverLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Format a cost-driver cell. The driver rows are `Record<string, any>` with
 * arbitrary keys, so we sniff the column name to apply the right formatter and
 * otherwise fall back to a string (or a dash for empties).
 */
function driverCell(key: string, value: any, currency?: string): string {
  if (value === null || value === undefined || value === '') {
    return DASH;
  }
  const k = key.toLowerCase();
  if (typeof value === 'number') {
    if (k.includes('cost') || k.includes('spend') || k.includes('usd')) {
      return fmtMoney(value, currency);
    }
    if (k.includes('token')) {
      return fmtTokens(value);
    }
    if (k.includes('call') || k.includes('count')) {
      return fmtNumber(value);
    }
    return fmtNumber(value);
  }
  return String(value);
}

/**
 * Top cost drivers as a clean, resilient table. Columns are derived from the
 * union of keys across rows so the surface tolerates whatever the backend emits.
 */
function TopCostDrivers({
  drivers,
  currency,
}: {
  drivers?: Array<Record<string, any>>;
  currency?: string;
}) {
  if (!drivers || drivers.length === 0) {
    return null;
  }
  // Stable column order: first-seen keys across all rows.
  const columns: string[] = [];
  for (const row of drivers) {
    for (const k of Object.keys(row || {})) {
      if (!columns.includes(k)) {
        columns.push(k);
      }
    }
  }
  if (columns.length === 0) {
    return null;
  }

  return (
    <EuiPanel hasBorder paddingSize="m" className="tlsocCard">
      {/* Header: accented icon chip + title. */}
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
        <EuiFlexItem grow={false}>
          <span
            className="tlsocIconChip"
            style={{ background: tint(COLORS.danger, 0.14), color: COLORS.danger }}
          >
            <EuiIcon type="bolt" size="m" />
          </span>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiTitle size="xxs">
            <h3>Top cost drivers</h3>
          </EuiTitle>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {/* A lightweight table built from flex rows so it stays dependency-free and
          tolerant of arbitrary keys. Header row, then one row per driver. */}
      <EuiFlexGroup gutterSize="m" responsive={false} style={{ paddingBottom: 6 }}>
        {columns.map((c) => (
          <EuiFlexItem key={c}>
            <EuiText size="xs" color="subdued">
              <strong>{driverLabel(c)}</strong>
            </EuiText>
          </EuiFlexItem>
        ))}
      </EuiFlexGroup>

      {drivers.map((row, idx) => (
        <EuiFlexGroup
          key={idx}
          gutterSize="m"
          responsive={false}
          alignItems="center"
          style={{
            paddingTop: 6,
            paddingBottom: 6,
            borderTop: `1px solid ${tint(COLORS.subdued, 0.18)}`,
          }}
        >
          {columns.map((c) => (
            <EuiFlexItem key={c}>
              <EuiText size="s" className="eui-textTruncate">
                <span title={String(row[c] ?? '')}>{driverCell(c, row[c], currency)}</span>
              </EuiText>
            </EuiFlexItem>
          ))}
        </EuiFlexGroup>
      ))}
    </EuiPanel>
  );
}

/* ------------------------------------------------------------------ surface - */

export const Cost: React.FC<CostProps> = ({ api }) => {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<UsageSummary>('usage/summary', { window_hours: 24 });
      setData(resp);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currency = data?.currency;

  // "Nothing yet" detection: loaded, but no spend, no tokens, no calls, and no
  // breakdown rows anywhere. Used to swap the body for a calm empty state.
  const isEmpty =
    !!data &&
    !data.total_cost &&
    !data.total_tokens &&
    !data.call_count &&
    !(data.by_model && data.by_model.length) &&
    !(data.by_role && data.by_role.length) &&
    !(data.by_surface && data.by_surface.length) &&
    !(data.cost_over_time && data.cost_over_time.length) &&
    !(data.top_cost_drivers && data.top_cost_drivers.length);

  const refreshButton = (
    <EuiButton size="s" iconType="refresh" onClick={load} isLoading={loading}>
      Refresh
    </EuiButton>
  );

  return (
    <div>
      <SectionHeader
        icon="visGauge"
        title="Cost & Tokens"
        description="LLM spend over the last 24h — every call is metered through the single gateway."
        actions={refreshButton}
      />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* Loading: a centred spinner before the first paint of the summary. */}
      {!data ? (
        <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 200 }}>
          <EuiFlexItem grow={false}>
            <EuiLoadingSpinner size="xl" />
          </EuiFlexItem>
        </EuiFlexGroup>
      ) : isEmpty ? (
        <EmptyState
          iconType="visGauge"
          title="No usage yet"
          body="Cost and token usage will appear here after the agent makes its first LLM call."
        />
      ) : (
        <>
          {/* KPI row — the headline numbers for the window. */}
          <EuiFlexGroup gutterSize="m" responsive wrap>
            <EuiFlexItem>
              <StatTile
                label="Today's spend"
                value={fmtMoney(data.today_cost, currency)}
                icon="payment"
                accent={COLORS.primary}
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <StatTile
                label="Total cost (window)"
                value={fmtMoney(data.total_cost, currency)}
                icon="currency"
                accent={COLORS.accent}
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <StatTile
                label="Total tokens"
                value={fmtTokens(data.total_tokens)}
                sub={`${fmtNumber(data.total_tokens)} tokens`}
                icon="compute"
                accent={COLORS.success}
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <StatTile
                label="Call count"
                value={fmtNumber(data.call_count)}
                icon="visBarVerticalStacked"
                accent={COLORS.warning}
              />
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiSpacer size="l" />

          {/* Breakdowns — three weighted cards, 3-across on wide, stacking narrow. */}
          <EuiFlexGroup gutterSize="m" responsive wrap alignItems="stretch">
            <BreakdownCard
              title="By model"
              icon="compute"
              accent={COLORS.primary}
              items={data.by_model}
              currency={currency}
            />
            <BreakdownCard
              title="By role"
              icon="users"
              accent={COLORS.accent}
              items={data.by_role}
              currency={currency}
            />
            <BreakdownCard
              title="By surface"
              icon="apps"
              accent={COLORS.success}
              items={data.by_surface}
              currency={currency}
            />
          </EuiFlexGroup>

          <EuiSpacer size="l" />

          {/* Cost over time — clean horizontal bar list. */}
          <CostOverTime data={data.cost_over_time} currency={currency} />

          {/* Top cost drivers — resilient table over arbitrary keys. */}
          {data.top_cost_drivers && data.top_cost_drivers.length > 0 ? (
            <>
              <EuiSpacer size="l" />
              <TopCostDrivers drivers={data.top_cost_drivers} currency={currency} />
            </>
          ) : null}
        </>
      )}
    </div>
  );
};
