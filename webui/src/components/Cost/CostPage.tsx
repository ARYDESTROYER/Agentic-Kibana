/**
 * Cost & usage — the LLM spend dashboard. Every model call goes through the single
 * gateway and lands in the cost ledger; this surface reads GET /api/usage/summary
 * and turns it into trend KPIs, a spend-over-time series, and ranked breakdowns by
 * model / role / surface plus the top individual cost drivers.
 *
 * Beyond the headline ranked views it offers a "further breakdown of costs": a
 * sortable, currency-aware detailed ledger table (cost, % of total, tokens, calls,
 * avg cost/call, cost per 1K tokens) across a switchable dimension; a labelled cost
 * composition donut with an "Other" roll-up; spend-over-time stats (peak / average /
 * total per bucket); and a row of efficiency tiles. Everything is recomputed
 * client-side from the ONE summary call — no new backend round-trips.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiBasicTable,
  EuiButton,
  EuiButtonGroup,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import type { Criteria, EuiBasicTableColumn } from '@elastic/eui';
import type { UsageSummary } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, chartColor, RADIUS, TYPE } from '../../lib/theme';
import {
  DASH,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTokens,
  humanizeToken,
} from '../../lib/format';
import { BarList, DonutWithLegend, MiniBars, Sparkline } from '../common/charts';
import type { Segment } from '../common/charts';
import {
  Card,
  EmptyState,
  ErrorCallout,
  IconChip,
  PageHeader,
  Skeleton,
  StatTile,
  TrendStat,
} from '../common/ui';

type UsageRow = { key: string; cost: number; tokens: number; calls: number };

type SortKey = 'cost' | 'tokens' | 'calls';

/** The dimension shown in the detailed ledger table + composition donut. */
type Dimension = 'model' | 'role' | 'surface' | 'drivers';

/** A ledger row enriched with the client-side derived efficiency columns. */
type LedgerRow = UsageRow & {
  /** Fraction 0..1 of total cost this row accounts for. */
  share: number;
  /** Mean cost per LLM call (NaN when no calls). */
  avgCost: number;
  /** Cost per 1,000 tokens (NaN when no tokens). */
  costPerKTok: number;
};

/** Sortable fields of the detailed ledger table. */
type LedgerSortField = 'key' | 'cost' | 'share' | 'tokens' | 'calls' | 'avgCost' | 'costPerKTok';

const WINDOWS = [
  { id: '24', label: '24h', hours: 24 },
  { id: '168', label: '7d', hours: 168 },
  { id: '720', label: '30d', hours: 720 },
] as const;

const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'calls', label: 'Calls' },
];

const DIMENSIONS: Array<{ id: Dimension; label: string; icon: string; accent: string }> = [
  { id: 'model', label: 'Model', icon: 'machineLearningApp', accent: COLORS.accent },
  { id: 'role', label: 'Role', icon: 'users', accent: COLORS.warning },
  { id: 'surface', label: 'Surface', icon: 'visPie', accent: COLORS.success },
  { id: 'drivers', label: 'Top drivers', icon: 'sortDown', accent: COLORS.danger },
];

/** Donuts with more than this many slices roll the tail into an "Other" bucket. */
const MAX_DONUT_SLICES = 6;

/** Descending sort of ledger rows by the chosen metric (returns a copy). */
function sortRows(rows: UsageRow[] | undefined, by: SortKey): UsageRow[] {
  if (!Array.isArray(rows)) return [];
  return [...rows].sort((a, b) => (Number(b?.[by]) || 0) - (Number(a?.[by]) || 0));
}

/** Coerce a possibly-missing numeric field to a finite number (0 fallback). */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Best-effort percentage change of the most-recent half of the spend series vs
 * the earlier half — a proxy for "this window vs the previous window" when the
 * backend gives us only a single time series. Returns undefined when there
 * aren't enough buckets, or the baseline is zero, to make the delta meaningful.
 */
function trendDelta(series: number[]): number | undefined {
  if (!Array.isArray(series) || series.length < 4) return undefined;
  const mid = Math.floor(series.length / 2);
  const prev = series.slice(0, mid).reduce((s, v) => s + v, 0);
  const curr = series.slice(mid).reduce((s, v) => s + v, 0);
  if (prev <= 0) return undefined;
  return Math.round(((curr - prev) / prev) * 100);
}

/** Map ledger `by_*` rows to chart segments, valued + ordered by `by`. */
function metricSegments(
  rows: UsageRow[] | undefined,
  by: SortKey,
  palette = false,
): Segment[] {
  return sortRows(rows, by)
    .filter((r) => r && typeof r[by] === 'number')
    .map((r, i) => ({
      label: humanizeToken(r.key) ?? r.key,
      value: Number(r[by]) || 0,
      color: palette ? chartColor(i) : undefined,
    }));
}

/**
 * Roll a long tail of small segments into a single "Other" slice so the donut
 * stays legible. Keeps the top `keep` segments by value (already sorted) and sums
 * the rest. A no-op when there are `keep` or fewer segments.
 */
function withOtherBucket(segments: Segment[], keep = MAX_DONUT_SLICES): Segment[] {
  if (segments.length <= keep) return segments;
  const head = segments.slice(0, keep - 1);
  const tail = segments.slice(keep - 1);
  const otherValue = tail.reduce((s, x) => s + Math.max(0, x.value), 0);
  return [
    ...head,
    { label: `Other (${tail.length})`, value: otherValue, color: COLORS.subdued },
  ];
}

/**
 * Enrich + (initially cost-)order ledger rows with the derived efficiency columns.
 * `totalCost` is the denominator for the share column (guarded against zero).
 */
function toLedger(rows: UsageRow[], totalCost: number, by: SortKey): LedgerRow[] {
  const denom = totalCost > 0 ? totalCost : 0;
  return sortRows(rows, by).map((r) => {
    const cost = num(r.cost);
    const tokens = num(r.tokens);
    const calls = num(r.calls);
    return {
      key: r.key,
      cost,
      tokens,
      calls,
      share: denom > 0 ? cost / denom : 0,
      avgCost: calls > 0 ? cost / calls : NaN,
      costPerKTok: tokens > 0 ? (cost / tokens) * 1000 : NaN,
    };
  });
}

/** Compact per-bucket stats for the spend-over-time series. */
function seriesStats(series: number[]): {
  total: number;
  avg: number;
  peak: number;
  peakIndex: number;
} {
  if (!series.length) return { total: 0, avg: 0, peak: 0, peakIndex: -1 };
  let total = 0;
  let peak = -Infinity;
  let peakIndex = 0;
  series.forEach((v, i) => {
    total += v;
    if (v > peak) {
      peak = v;
      peakIndex = i;
    }
  });
  return { total, avg: total / series.length, peak: peak < 0 ? 0 : peak, peakIndex };
}

export const CostPage: React.FC = () => {
  const [windowId, setWindowId] = useState<string>('24');
  const [sortBy, setSortBy] = useState<SortKey>('cost');
  const [dimension, setDimension] = useState<Dimension>('model');
  const [ledgerSort, setLedgerSort] = useState<{ field: LedgerSortField; direction: 'asc' | 'desc' }>(
    { field: 'cost', direction: 'desc' },
  );
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const hours = useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.hours ?? 24,
    [windowId],
  );
  const windowLabel = useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.label ?? '24h',
    [windowId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.usageSummary(hours));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void load();
  }, [load]);

  const currency = data?.currency;
  const series = useMemo(
    () =>
      Array.isArray(data?.cost_over_time)
        ? data!.cost_over_time!
            .filter((p) => p && typeof p.cost === 'number')
            .map((p) => p.cost)
        : [],
    [data],
  );

  const spendDelta = useMemo(() => trendDelta(series), [series]);
  const spend = useMemo(() => seriesStats(series), [series]);

  const byModel = useMemo(
    () => metricSegments(data?.by_model as UsageRow[], sortBy),
    [data, sortBy],
  );
  const byRole = useMemo(
    () => metricSegments(data?.by_role as UsageRow[], sortBy),
    [data, sortBy],
  );
  const bySurface = useMemo(
    () => metricSegments(data?.by_surface as UsageRow[], sortBy, true),
    [data, sortBy],
  );
  const topDrivers = useMemo(
    () => sortRows(data?.top_cost_drivers as UsageRow[], sortBy),
    [data, sortBy],
  );

  /** The raw rows for the active detailed-ledger dimension. */
  const dimensionRows = useMemo<UsageRow[]>(() => {
    const pick = (v: unknown): UsageRow[] => (Array.isArray(v) ? (v as UsageRow[]) : []);
    switch (dimension) {
      case 'role':
        return pick(data?.by_role);
      case 'surface':
        return pick(data?.by_surface);
      case 'drivers':
        return pick(data?.top_cost_drivers);
      case 'model':
      default:
        return pick(data?.by_model);
    }
  }, [data, dimension]);

  const dimensionMeta = useMemo(
    () => DIMENSIONS.find((d) => d.id === dimension) ?? DIMENSIONS[0],
    [dimension],
  );

  const totalCost = num(data?.total_cost);

  /** Enriched ledger rows, then re-sorted by the table's own sort state. */
  const ledger = useMemo<LedgerRow[]>(() => {
    const rows = toLedger(dimensionRows, totalCost, sortBy);
    const dir = ledgerSort.direction === 'asc' ? 1 : -1;
    const f = ledgerSort.field;
    return [...rows].sort((a, b) => {
      if (f === 'key') {
        return (humanizeToken(a.key) ?? a.key).localeCompare(humanizeToken(b.key) ?? b.key) * dir;
      }
      // NaN efficiency values sort to the bottom regardless of direction.
      const av = a[f];
      const bv = b[f];
      const an = Number.isFinite(av) ? av : -Infinity;
      const bn = Number.isFinite(bv) ? bv : -Infinity;
      return (an - bn) * dir;
    });
  }, [dimensionRows, totalCost, sortBy, ledgerSort]);

  /** Composition segments for the active dimension, with an "Other" roll-up. */
  const compositionSegments = useMemo(
    () => withOtherBucket(metricSegments(dimensionRows, 'cost', true)),
    [dimensionRows],
  );

  /** Format a segment value for the active sort metric. */
  const fmtMetric = useCallback(
    (n: number): React.ReactNode =>
      sortBy === 'cost'
        ? fmtMoney(n, currency)
        : sortBy === 'tokens'
          ? fmtTokens(n)
          : fmtNumber(n),
    [sortBy, currency],
  );

  /** A tiny inline "% of total" bar used inside the ledger table cell. */
  const ShareBar: React.FC<{ share: number; color: string }> = ({ share, color }) => {
    const pct = Math.max(0, Math.min(100, share * 100));
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            flex: 1,
            minWidth: 36,
            height: 6,
            borderRadius: RADIUS.sm,
            background: 'rgba(105,112,125,0.14)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.max(pct > 0 ? 2 : 0, pct)}%`,
              height: '100%',
              borderRadius: RADIUS.sm,
              background: color,
            }}
          />
        </div>
        <span style={{ fontSize: 12, color: COLORS.subdued, minWidth: 34, textAlign: 'right' }}>
          {fmtPercent(share)}
        </span>
      </div>
    );
  };

  const onLedgerChange = useCallback(({ sort }: Criteria<LedgerRow>) => {
    if (sort) {
      setLedgerSort({ field: sort.field as LedgerSortField, direction: sort.direction });
    }
  }, []);

  const ledgerColumns = useMemo<Array<EuiBasicTableColumn<LedgerRow>>>(
    () => [
      {
        field: 'key',
        name: dimensionMeta.label,
        sortable: true,
        truncateText: true,
        render: (_: unknown, r: LedgerRow) => (
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap={false}>
            <EuiFlexItem grow={false}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 3,
                  background: chartColor(ledger.indexOf(r)),
                  display: 'inline-block',
                  flex: '0 0 auto',
                }}
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <span style={{ wordBreak: 'break-word' }}>{humanizeToken(r.key) ?? r.key}</span>
            </EuiFlexItem>
          </EuiFlexGroup>
        ),
      },
      {
        field: 'cost',
        name: 'Cost',
        sortable: true,
        width: '110px',
        align: 'right',
        render: (n: number) => <strong>{fmtMoney(n, currency)}</strong>,
      },
      {
        field: 'share',
        name: '% of total',
        sortable: true,
        width: '170px',
        render: (_: unknown, r: LedgerRow) => (
          <ShareBar share={r.share} color={chartColor(ledger.indexOf(r))} />
        ),
      },
      {
        field: 'tokens',
        name: 'Tokens',
        sortable: true,
        width: '90px',
        align: 'right',
        render: (n: number) => fmtTokens(n),
      },
      {
        field: 'calls',
        name: 'Calls',
        sortable: true,
        width: '80px',
        align: 'right',
        render: (n: number) => fmtNumber(n),
      },
      {
        field: 'avgCost',
        name: 'Avg / call',
        sortable: true,
        width: '105px',
        align: 'right',
        render: (n: number) =>
          Number.isFinite(n) ? (
            fmtMoney(n, currency)
          ) : (
            <span style={{ color: COLORS.subdued }}>{DASH}</span>
          ),
      },
      {
        field: 'costPerKTok',
        name: 'Cost / 1K tok',
        sortable: true,
        width: '110px',
        align: 'right',
        render: (n: number) =>
          Number.isFinite(n) ? (
            fmtMoney(n, currency)
          ) : (
            <span style={{ color: COLORS.subdued }}>{DASH}</span>
          ),
      },
    ],
    // ShareBar + ledger.indexOf depend on the current ledger ordering + currency.
    [currency, dimensionMeta.label, ledger],
  );

  // ---- Efficiency aggregates (overall + single most-expensive per dimension). --
  const totalTokens = num(data?.total_tokens);
  const callCount = num(data?.call_count);
  const overallAvgCost = callCount > 0 ? totalCost / callCount : NaN;
  const overallCostPerKTok = totalTokens > 0 ? (totalCost / totalTokens) * 1000 : NaN;
  const overallTokensPerCall = callCount > 0 ? totalTokens / callCount : NaN;

  const topModel = useMemo(() => sortRows(data?.by_model as UsageRow[], 'cost')[0], [data]);
  const topRole = useMemo(() => sortRows(data?.by_role as UsageRow[], 'cost')[0], [data]);
  const topSurface = useMemo(() => sortRows(data?.by_surface as UsageRow[], 'cost')[0], [data]);

  /** The single most-expensive {model|role|surface}, labelled for the tile. */
  const priciest = useMemo(() => {
    const candidates: Array<{ scope: string; row?: UsageRow }> = [
      { scope: 'model', row: topModel },
      { scope: 'role', row: topRole },
      { scope: 'surface', row: topSurface },
    ];
    const best = candidates
      .filter((c) => c.row && num(c.row.cost) > 0)
      .sort((a, b) => num(b.row!.cost) - num(a.row!.cost))[0];
    return best?.row
      ? { scope: best.scope, label: humanizeToken(best.row.key) ?? best.row.key, cost: num(best.row.cost) }
      : null;
  }, [topModel, topRole, topSurface]);

  const hasAny =
    (data?.call_count ?? 0) > 0 ||
    (data?.total_cost ?? 0) > 0 ||
    byModel.length > 0 ||
    series.length > 0;

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="visLine"
        eyebrow="Spend"
        title="Cost & usage"
        description="LLM spend metered through the single gateway cost ledger."
        actions={
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiButtonGroup
                legend="Time window"
                buttonSize="s"
                options={WINDOWS.map((w) => ({ id: w.id, label: w.label }))}
                idSelected={windowId}
                onChange={(id) => setWindowId(id)}
              />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <span className="socHeaderDivider" />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiToolTip content="Rank the breakdowns by this metric">
                <EuiButtonGroup
                  legend="Sort breakdowns by"
                  buttonSize="s"
                  options={SORTS.map((s) => ({ id: s.id, label: s.label }))}
                  idSelected={sortBy}
                  onChange={(id) => setSortBy(id as SortKey)}
                />
              </EuiToolTip>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton size="s" iconType="refresh" onClick={() => void load()} isLoading={loading}>
                Refresh
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        }
      />

      {error ? (
        <>
          <ErrorCallout error={error} title="Could not load usage" />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {loading ? (
        <>
          <EuiFlexGroup gutterSize="m" wrap responsive={false}>
            {[0, 1, 2, 3].map((i) => (
              <EuiFlexItem key={i} style={{ minWidth: 220 }}>
                <Skeleton height={96} radius={12} />
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
          <EuiSpacer size="m" />
          <div className="socGrid">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={200} radius={12} />
            ))}
          </div>
        </>
      ) : !hasAny ? (
        <EmptyState
          iconType="visLine"
          title="No LLM spend recorded yet"
          body={`Nothing went through the gateway in the last ${windowLabel}. As the agent triages cases, cost and token usage will appear here.`}
        />
      ) : (
        <>
          {/* Hero — total spend for the window. */}
          <EuiPanel
            hasBorder
            paddingSize="l"
            className="socCard"
            style={{ borderTop: `3px solid ${COLORS.primary}` }}
          >
            <EuiFlexGroup gutterSize="l" alignItems="center" responsive={false} wrap>
              <EuiFlexItem grow={false}>
                <IconChip icon="currency" accent={COLORS.primary} large />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  <span>Total spend · last {windowLabel}</span>
                </EuiText>
                <EuiFlexGroup gutterSize="s" alignItems="baseline" responsive={false} wrap={false}>
                  <EuiFlexItem grow={false}>
                    <div
                      style={{
                        fontSize: TYPE.kpiLg,
                        fontWeight: 700,
                        lineHeight: 1.1,
                        color: COLORS.primary,
                      }}
                    >
                      {fmtMoney(data?.total_cost, currency)}
                    </div>
                  </EuiFlexItem>
                  {typeof spendDelta === 'number' ? (
                    <EuiFlexItem grow={false}>
                      <EuiToolTip content="Change vs the earlier half of this window">
                        <span
                          style={{
                            color: spendDelta > 0 ? COLORS.danger : COLORS.success,
                            fontSize: TYPE.label,
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {spendDelta > 0 ? '▲' : '▼'} {Math.abs(spendDelta)}%
                        </span>
                      </EuiToolTip>
                    </EuiFlexItem>
                  ) : null}
                </EuiFlexGroup>
                <EuiText size="xs" color="subdued">
                  <span>
                    {fmtTokens(data?.total_tokens)} tokens · {fmtNumber(data?.call_count)} calls
                  </span>
                </EuiText>
              </EuiFlexItem>
              {series.length > 1 ? (
                <EuiFlexItem style={{ minWidth: 180 }}>
                  <Sparkline values={series} color={COLORS.primary} height={56} />
                </EuiFlexItem>
              ) : null}
            </EuiFlexGroup>
          </EuiPanel>

          <EuiSpacer size="m" />

          {/* KPI row */}
          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label={`Total cost (${windowLabel})`}
                value={fmtMoney(data?.total_cost, currency)}
                icon="currency"
                accent={COLORS.primary}
                spark={series.length > 1 ? series : undefined}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="Total tokens"
                value={fmtTokens(data?.total_tokens)}
                icon="visGauge"
                accent={COLORS.accent}
                sub={`across ${fmtNumber(data?.call_count)} calls`}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="LLM calls"
                value={fmtNumber(data?.call_count)}
                icon="compute"
                accent={COLORS.success}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="Today's cost"
                value={fmtMoney(data?.today_cost, currency)}
                icon="clock"
                accent={COLORS.warning}
              />
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiSpacer size="m" />

          {/* Efficiency tiles — cost per unit of work + the single priciest scope. */}
          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <StatTile
                label="Avg cost / call"
                value={Number.isFinite(overallAvgCost) ? fmtMoney(overallAvgCost, currency) : DASH}
                icon="visGauge"
                accent={COLORS.primary}
                sub={`${fmtNumber(data?.call_count)} calls`}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <StatTile
                label="Cost / 1K tokens"
                value={
                  Number.isFinite(overallCostPerKTok) ? fmtMoney(overallCostPerKTok, currency) : DASH
                }
                icon="currency"
                accent={COLORS.accent}
                sub={`${fmtTokens(data?.total_tokens)} tokens`}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <StatTile
                label="Tokens / call"
                value={Number.isFinite(overallTokensPerCall) ? fmtTokens(overallTokensPerCall) : DASH}
                icon="visGauge"
                accent={COLORS.success}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <StatTile
                label="Priciest scope"
                value={priciest ? priciest.label : DASH}
                icon="sortDown"
                accent={COLORS.danger}
                sub={
                  priciest
                    ? `${humanizeToken(priciest.scope)} · ${fmtMoney(priciest.cost, currency)}`
                    : 'No spend yet'
                }
              />
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiSpacer size="m" />

          {/* Charts grid */}
          <div className="socGrid">
            <Card title="Spend over time" icon="visArea" accent={COLORS.primary}>
              {series.length > 1 ? (
                <>
                  <MiniBars values={series} color={COLORS.primary} height={120} />
                  <EuiSpacer size="s" />
                  {/* Per-bucket spend stats alongside the bars. */}
                  <EuiFlexGroup gutterSize="m" responsive={false} wrap>
                    <EuiFlexItem grow={false}>
                      <EuiText size="xs" color="subdued"><span>Window total</span></EuiText>
                      <EuiText size="s"><strong>{fmtMoney(spend.total, currency)}</strong></EuiText>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiText size="xs" color="subdued"><span>Avg / bucket</span></EuiText>
                      <EuiText size="s"><strong>{fmtMoney(spend.avg, currency)}</strong></EuiText>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiText size="xs" color="subdued"><span>Peak bucket</span></EuiText>
                      <EuiText size="s"><strong>{fmtMoney(spend.peak, currency)}</strong></EuiText>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <EuiSpacer size="xs" />
                  <EuiText size="xs" color="subdued">
                    <span>{`${series.length} buckets over the last ${windowLabel}`}</span>
                  </EuiText>
                </>
              ) : (
                <EuiText size="s" color="subdued">
                  <span>Not enough data points to chart a trend.</span>
                </EuiText>
              )}
            </Card>

            <Card title="By model" icon="machineLearningApp" accent={COLORS.accent}>
              {byModel.length ? (
                <BarList items={byModel} format={fmtMetric} />
              ) : (
                <EuiText size="s" color="subdued">
                  <span>{DASH}</span>
                </EuiText>
              )}
            </Card>

            <Card title="By role" icon="users" accent={COLORS.warning}>
              {byRole.length ? (
                <BarList items={byRole} format={fmtMetric} />
              ) : (
                <EuiText size="s" color="subdued">
                  <span>{DASH}</span>
                </EuiText>
              )}
            </Card>

            <Card title="By surface" icon="visPie" accent={COLORS.success}>
              {bySurface.length ? (
                <DonutWithLegend
                  segments={bySurface}
                  centerValue={fmtMoney(data?.total_cost, currency)}
                  centerLabel="total"
                />
              ) : (
                <EuiText size="s" color="subdued">
                  <span>{DASH}</span>
                </EuiText>
              )}
            </Card>
          </div>

          <EuiSpacer size="m" />

          {/* Cost composition — labelled donut of the active dimension, "Other"-rolled. */}
          <Card
            title={`Cost composition · by ${dimensionMeta.label.toLowerCase()}`}
            icon="visPie"
            accent={dimensionMeta.accent}
          >
            {compositionSegments.length ? (
              <DonutWithLegend
                segments={compositionSegments.map((s) => ({
                  ...s,
                  label:
                    totalCost > 0
                      ? `${s.label} · ${fmtPercent(s.value / totalCost)}`
                      : s.label,
                }))}
                centerValue={fmtMoney(totalCost, currency)}
                centerLabel="total cost"
              />
            ) : (
              <EuiText size="s" color="subdued">
                <span>No cost recorded for this dimension.</span>
              </EuiText>
            )}
          </Card>

          <EuiSpacer size="m" />

          {/* Detailed, sortable ledger across a switchable dimension. */}
          <Card
            title="Detailed cost ledger"
            icon="tableDensityNormal"
            accent={dimensionMeta.accent}
            actions={
              <EuiButtonGroup
                legend="Breakdown dimension"
                buttonSize="s"
                options={DIMENSIONS.map((d) => ({ id: d.id, label: d.label }))}
                idSelected={dimension}
                onChange={(id) => setDimension(id as Dimension)}
              />
            }
          >
            {ledger.length ? (
              <EuiBasicTable<LedgerRow>
                items={ledger}
                columns={ledgerColumns}
                tableLayout="auto"
                compressed
                sorting={{ sort: { field: ledgerSort.field, direction: ledgerSort.direction } }}
                onChange={onLedgerChange}
                rowProps={{ style: { verticalAlign: 'middle' } }}
              />
            ) : (
              <EmptyState
                iconType="tableDensityNormal"
                title="Nothing to break down"
                body={`No ${dimensionMeta.label.toLowerCase()} spend recorded in the last ${windowLabel}.`}
              />
            )}
          </Card>

          {topDrivers.length ? (
            <>
              <EuiSpacer size="m" />
              <Card
                title={`Top drivers · by ${sortBy}`}
                icon="sortDown"
                accent={COLORS.danger}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {topDrivers.slice(0, 10).map((d, i) => (
                    <EuiFlexGroup
                      key={`${d.key}-${i}`}
                      gutterSize="m"
                      alignItems="center"
                      responsive={false}
                    >
                      <EuiFlexItem grow={false}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 3,
                            background: chartColor(i),
                            display: 'inline-block',
                          }}
                        />
                      </EuiFlexItem>
                      <EuiFlexItem>
                        <EuiText size="s">
                          <span style={{ wordBreak: 'break-word' }}>
                            {humanizeToken(d.key) ?? d.key}
                          </span>
                        </EuiText>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiText size="xs" color="subdued">
                          <span>{fmtTokens(d.tokens)} tok</span>
                        </EuiText>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiText size="xs" color="subdued">
                          <span>{fmtNumber(d.calls)} calls</span>
                        </EuiText>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiText size="s">
                          <strong>{fmtMoney(d.cost, currency)}</strong>
                        </EuiText>
                      </EuiFlexItem>
                    </EuiFlexGroup>
                  ))}
                </div>
              </Card>
            </>
          ) : null}
        </>
      )}
    </div>
  );
};
