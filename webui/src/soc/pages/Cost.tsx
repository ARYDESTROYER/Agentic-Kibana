/**
 * Cost & usage — the LLM spend dashboard (new SOC console surface).
 *
 * Every model call goes through the single gateway and lands in the cost ledger;
 * this surface reads GET /api/usage/summary (api.usageSummary) and turns the ONE
 * call into trend KPIs, a spend-over-time TrendArea, ranked breakdowns by
 * model / role / surface, the top individual cost drivers, a labelled cost
 * composition donut (with an "Other" roll-up), and a sortable, currency-aware
 * detailed ledger DataTable across a switchable dimension (cost, % of total,
 * tokens, calls, avg cost/call, cost per 1K tokens). Everything is recomputed
 * client-side — no extra backend round-trips.
 *
 * Security: model ids / driver keys are technical, attacker-influenceable
 * identifiers and render via <InlineCode> (UNTRUSTED-safe). Role / surface labels
 * are humanized enum text rendered plain. No untrusted string is injected as markup.
 */
import * as React from 'react';
import {
  CircleDollarSign,
  Coins,
  Cpu,
  Gauge,
  LayoutGrid,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';

import type { Navigate } from '@/soc/router';
import { api } from '@/lib/api';
import { useDemo } from '@/soc/demo';
import type { UsageSummary } from '@/lib/types';
import {
  DASH,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTokens,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { PageHeader } from '@/soc/components/PageHeader';
import { KpiTile, type KpiAccent } from '@/soc/components/KpiTile';
import { StatCard, type StatAccent } from '@/soc/components/StatCard';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { DonutChart, TrendArea, type DonutSegment } from '@/soc/components/charts';
import { DataTable, type DataTableColumn, type SortState } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { Stagger } from '@/soc/components/Stagger';
import { categorical } from '@/soc/components/palette';
import { InlineCode } from '@/soc/components/CodeBlock';

import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Button } from '@/ui/button';
import { Skeleton, SkeletonCard } from '@/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';

// --------------------------------------------------------------------------- //
// Local types + constants
// --------------------------------------------------------------------------- //
type UsageRow = { key: string; cost: number; tokens: number; calls: number };

/** Metric the breakdowns + ledger rank/value by. */
type Metric = 'cost' | 'tokens' | 'calls';

/** The dimension shown in the detailed ledger + composition donut. */
type Dimension = 'model' | 'role' | 'surface' | 'drivers';

/** A ledger row enriched with the client-side derived efficiency columns. */
interface LedgerRow extends UsageRow {
  /** Fraction 0..1 of total cost this row accounts for. */
  share: number;
  /** Mean cost per LLM call (NaN when no calls). */
  avgCost: number;
  /** Cost per 1,000 tokens (NaN when no tokens). */
  costPerKTok: number;
}

type WindowKey = '24h' | '7d' | '30d';
const WINDOWS: { key: WindowKey; label: string; hours: number }[] = [
  { key: '24h', label: '24h', hours: 24 },
  { key: '7d', label: '7d', hours: 24 * 7 },
  { key: '30d', label: '30d', hours: 24 * 30 },
];

const METRICS: { id: Metric; label: string }[] = [
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'calls', label: 'Calls' },
];

const DIMENSIONS: { id: Dimension; label: string; verbatim: boolean }[] = [
  { id: 'model', label: 'Model', verbatim: true },
  { id: 'role', label: 'Role', verbatim: false },
  { id: 'surface', label: 'Surface', verbatim: false },
  { id: 'drivers', label: 'Top drivers', verbatim: true },
];

/** Donuts with more than this many slices roll the tail into "Other". */
const MAX_DONUT_SLICES = 6;

// --------------------------------------------------------------------------- //
// Pure helpers (mirrors the legacy CostPage logic)
// --------------------------------------------------------------------------- //
/** Coerce a possibly-missing numeric field to a finite number (0 fallback). */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Descending sort of ledger rows by the chosen metric (returns a copy). */
function sortRows(rows: UsageRow[] | undefined, by: Metric): UsageRow[] {
  if (!Array.isArray(rows)) return [];
  return [...rows].sort((a, b) => num(b?.[by]) - num(a?.[by]));
}

/**
 * Best-effort percentage change of the most-recent half of the spend series vs
 * the earlier half — a proxy for "this window vs the previous window" when the
 * backend gives only a single time series. Undefined when there aren't enough
 * buckets, or the baseline is zero, to make the delta meaningful.
 */
function trendDelta(series: number[]): number | undefined {
  if (!Array.isArray(series) || series.length < 4) return undefined;
  const mid = Math.floor(series.length / 2);
  const prev = series.slice(0, mid).reduce((s, v) => s + v, 0);
  const curr = series.slice(mid).reduce((s, v) => s + v, 0);
  if (prev <= 0) return undefined;
  return Math.round(((curr - prev) / prev) * 100);
}

/** Compact per-bucket stats for the spend-over-time series. */
function seriesStats(series: number[]): { total: number; avg: number; peak: number } {
  if (!series.length) return { total: 0, avg: 0, peak: 0 };
  let total = 0;
  let peak = -Infinity;
  series.forEach((v) => {
    total += v;
    if (v > peak) peak = v;
  });
  return { total, avg: total / series.length, peak: peak < 0 ? 0 : peak };
}

/**
 * Map ledger `by_*` rows to donut segments, valued + ordered by `by`. `verbatim`
 * keeps the raw key (model ids / drivers are technical identifiers shown
 * literally); otherwise the key is humanized for display.
 */
function metricSegments(
  rows: UsageRow[] | undefined,
  by: Metric,
  verbatim = false,
): DonutSegment[] {
  return sortRows(rows, by)
    .filter((r) => r && typeof r[by] === 'number')
    .map((r, i) => ({
      label: verbatim ? r.key : (humanizeToken(r.key) ?? r.key),
      value: num(r[by]),
      color: categorical(i),
    }));
}

/**
 * Roll a long tail of small segments into a single "Other" slice so the donut
 * stays legible. Keeps the top `keep` segments by value (already sorted).
 */
function withOtherBucket(segments: DonutSegment[], keep = MAX_DONUT_SLICES): DonutSegment[] {
  if (segments.length <= keep) return segments;
  const head = segments.slice(0, keep - 1);
  const tail = segments.slice(keep - 1);
  const otherValue = tail.reduce((s, x) => s + Math.max(0, x.value), 0);
  return [...head, { label: `Other (${tail.length})`, value: otherValue, color: categorical(keep) }];
}

/** Enrich + cost-order ledger rows with the derived efficiency columns. */
function toLedger(rows: UsageRow[], totalCost: number): LedgerRow[] {
  const denom = totalCost > 0 ? totalCost : 0;
  return sortRows(rows, 'cost').map((r) => {
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

// --------------------------------------------------------------------------- //
// Small UI helpers
// --------------------------------------------------------------------------- //
/** Segmented pill toggle (calm OpenSearch-style filter control). */
function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5"
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            aria-pressed={active}
            className={cn(
              'rounded-[5px] px-3 py-1 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-card text-foreground shadow-elev1'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A quiet, consistent card section title — muted lucide icon + plain label,
 * with an optional right-aligned meta slot. Calmer than a colored icon per card.
 */
function SectionTitle({
  icon: Icon,
  children,
  meta,
}: {
  icon: typeof Coins;
  children: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <CardTitle className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        {children}
      </CardTitle>
      {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
    </div>
  );
}

/** A tiny inline "% of total" bar used inside the ledger table cell. */
function ShareBar({ share, colorIndex }: { share: number; colorIndex: number }) {
  const pct = Math.max(0, Math.min(100, share * 100));
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-1.5 min-w-[36px] flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full opacity-80"
          style={{ width: `${Math.max(pct > 0 ? 2 : 0, pct)}%`, background: categorical(colorIndex) }}
        />
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {fmtPercent(share)}
      </span>
    </div>
  );
}

interface CostProps {
  /** Drill-through navigation (unused today, kept for shell parity). */
  onNavigate?: Navigate;
  /**
   * When hosted as a tab inside another page (Round-2 W4 consolidation), suppress
   * the page's own PageHeader/title block and surface only the action controls so
   * the host's single header owns the title (no duplicate headers).
   */
  embedded?: boolean;
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
export default function Cost({ embedded = false }: CostProps = {}) {
  // While demo mode is active, the cost ledger is fed by the deterministic $0 mock
  // LLM with plausible synthetic figures — suffix the money tiles "(simulated)" so a
  // viewer never reads demo spend as real spend.
  const { active: demoActive } = useDemo();
  const [windowKey, setWindowKey] = React.useState<WindowKey>('24h');
  const [metric, setMetric] = React.useState<Metric>('cost');
  const [dimension, setDimension] = React.useState<Dimension>('model');
  const [ledgerSort, setLedgerSort] = React.useState<SortState>({ id: 'cost', dir: 'desc' });

  const [data, setData] = React.useState<UsageSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const hours = WINDOWS.find((w) => w.key === windowKey)?.hours ?? 24;
  const windowLabel = WINDOWS.find((w) => w.key === windowKey)?.label ?? '24h';

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.usageSummary(hours));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage.');
    } finally {
      setLoading(false);
    }
  }, [hours]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const currency = data?.currency;
  const totalCost = num(data?.total_cost);
  const totalTokens = num(data?.total_tokens);
  const callCount = num(data?.call_count);

  // Spend-over-time series (bare numbers).
  const series = React.useMemo(
    () =>
      Array.isArray(data?.cost_over_time)
        ? data!.cost_over_time!
            .filter((p) => p && typeof p.cost === 'number')
            .map((p) => num(p.cost))
        : [],
    [data],
  );
  const spendDelta = React.useMemo(() => trendDelta(series), [series]);
  const spend = React.useMemo(() => seriesStats(series), [series]);

  /** Trend points for the area chart (bucket index as the x category). */
  const trendData = React.useMemo(
    () => series.map((y, i) => ({ x: String(i + 1), y })),
    [series],
  );

  // Ranked breakdown bar lists.
  const fmtMetric = React.useCallback(
    (n: number): string =>
      metric === 'cost' ? fmtMoney(n, currency) : metric === 'tokens' ? fmtTokens(n) : fmtNumber(n),
    [metric, currency],
  );

  const barItems = React.useCallback(
    (rows: UsageRow[] | undefined, verbatim: boolean): BarListItem[] =>
      // Bars use the shared accent gradient; categorical color is conveyed by the donut.
      metricSegments(rows, metric, verbatim).map((s) => ({ label: s.label, value: s.value })),
    [metric],
  );

  const byModel = React.useMemo(
    () => barItems(data?.by_model as UsageRow[], true),
    [barItems, data],
  );
  const byRole = React.useMemo(
    () => barItems(data?.by_role as UsageRow[], false),
    [barItems, data],
  );
  const bySurface = React.useMemo(
    () => barItems(data?.by_surface as UsageRow[], false),
    [barItems, data],
  );

  // Top drivers (raw rows for the dedicated list).
  const topDrivers = React.useMemo(
    () => sortRows(data?.top_cost_drivers as UsageRow[], metric).slice(0, 10),
    [data, metric],
  );

  // ----- Active-dimension data (ledger + composition donut) -------------- //
  const dimMeta = React.useMemo(
    () => DIMENSIONS.find((d) => d.id === dimension) ?? DIMENSIONS[0],
    [dimension],
  );

  const dimensionRows = React.useMemo<UsageRow[]>(() => {
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

  /** Enriched ledger rows, re-sorted by the table's own sort state. */
  const ledger = React.useMemo<LedgerRow[]>(() => {
    const rows = toLedger(dimensionRows, totalCost);
    const dir = ledgerSort.dir === 'asc' ? 1 : -1;
    const f = ledgerSort.id as keyof LedgerRow;
    return [...rows].sort((a, b) => {
      if (f === 'key') {
        return (humanizeToken(a.key) ?? a.key).localeCompare(humanizeToken(b.key) ?? b.key) * dir;
      }
      // NaN efficiency values sort to the bottom regardless of direction.
      const av = a[f] as number;
      const bv = b[f] as number;
      const an = Number.isFinite(av) ? av : -Infinity;
      const bn = Number.isFinite(bv) ? bv : -Infinity;
      return (an - bn) * dir;
    });
  }, [dimensionRows, totalCost, ledgerSort]);

  /** Composition donut segments for the active dimension, with "Other" roll-up. */
  const compositionSegments = React.useMemo(
    () => withOtherBucket(metricSegments(dimensionRows, 'cost', dimMeta.verbatim)),
    [dimensionRows, dimMeta.verbatim],
  );

  // ----- Efficiency aggregates ------------------------------------------- //
  const overallAvgCost = callCount > 0 ? totalCost / callCount : NaN;
  const overallCostPerKTok = totalTokens > 0 ? (totalCost / totalTokens) * 1000 : NaN;
  const overallTokensPerCall = callCount > 0 ? totalTokens / callCount : NaN;

  // ----- Ledger columns -------------------------------------------------- //
  const columns = React.useMemo<DataTableColumn<LedgerRow>[]>(
    () => [
      {
        id: 'key',
        header: dimMeta.label,
        sortable: true,
        cell: (r) => (
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ background: categorical(ledger.indexOf(r)) }}
              aria-hidden
            />
            {dimMeta.verbatim ? (
              <InlineCode className="truncate">{r.key}</InlineCode>
            ) : (
              <span className="truncate text-sm text-foreground">{humanizeToken(r.key) ?? r.key}</span>
            )}
          </div>
        ),
      },
      {
        id: 'cost',
        header: 'Cost',
        sortable: true,
        align: 'right',
        width: '7rem',
        cell: (r) => (
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {fmtMoney(r.cost, currency)}
          </span>
        ),
      },
      {
        id: 'share',
        header: '% of total',
        sortable: true,
        width: '11rem',
        cell: (r) => <ShareBar share={r.share} colorIndex={ledger.indexOf(r)} />,
      },
      {
        id: 'tokens',
        header: 'Tokens',
        sortable: true,
        align: 'right',
        width: '6rem',
        cell: (r) => (
          <span className="font-mono tabular-nums text-muted-foreground">{fmtTokens(r.tokens)}</span>
        ),
      },
      {
        id: 'calls',
        header: 'Calls',
        sortable: true,
        align: 'right',
        width: '5.5rem',
        cell: (r) => (
          <span className="font-mono tabular-nums text-muted-foreground">{fmtNumber(r.calls)}</span>
        ),
      },
      {
        id: 'avgCost',
        header: 'Avg / call',
        sortable: true,
        align: 'right',
        width: '7rem',
        cell: (r) =>
          Number.isFinite(r.avgCost) ? (
            <span className="font-mono tabular-nums text-foreground">{fmtMoney(r.avgCost, currency)}</span>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          ),
      },
      {
        id: 'costPerKTok',
        header: 'Cost / 1K tok',
        sortable: true,
        align: 'right',
        width: '7.5rem',
        cell: (r) =>
          Number.isFinite(r.costPerKTok) ? (
            <span className="font-mono tabular-nums text-foreground">
              {fmtMoney(r.costPerKTok, currency)}
            </span>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          ),
      },
    ],
    [currency, dimMeta.label, dimMeta.verbatim, ledger],
  );

  const hasAny =
    callCount > 0 || totalCost > 0 || byModel.length > 0 || series.length > 0;

  // ----- KPI tiles ------------------------------------------------------- //
  const kpis: {
    label: string;
    value: React.ReactNode;
    sub?: string;
    icon: typeof Coins;
    accent: KpiAccent;
    delta?: { value: number; label: string };
  }[] = React.useMemo(
    () => [
      {
        label: `Total cost (${windowLabel})`,
        value: fmtMoney(totalCost, currency),
        sub: `${fmtTokens(totalTokens)} tokens · ${fmtNumber(callCount)} calls${
          demoActive ? ' · simulated' : ''
        }`,
        icon: CircleDollarSign,
        accent: 'primary',
        delta:
          typeof spendDelta === 'number'
            ? { value: -spendDelta, label: `${Math.abs(spendDelta)}%` }
            : undefined,
      },
      {
        label: 'Total tokens',
        value: fmtTokens(totalTokens),
        sub: `across ${fmtNumber(callCount)} calls`,
        icon: Gauge,
        accent: 'info',
      },
      {
        label: 'LLM calls',
        value: fmtNumber(callCount),
        sub: 'metered through the gateway',
        icon: Cpu,
        accent: 'success',
      },
      {
        label: "Today's cost",
        value: fmtMoney(num(data?.today_cost), currency),
        sub: demoActive ? 'simulated spend' : 'spend so far today',
        icon: Coins,
        accent: 'medium',
      },
    ],
    [windowLabel, totalCost, totalTokens, callCount, currency, spendDelta, data, demoActive],
  );

  // ----- Efficiency StatCards -------------------------------------------- //
  const efficiency: { label: string; value: React.ReactNode; sub?: string; accent: StatAccent }[] =
    React.useMemo(
      () => [
        {
          label: 'Avg cost / call',
          value: Number.isFinite(overallAvgCost) ? fmtMoney(overallAvgCost, currency) : DASH,
          sub: `${fmtNumber(callCount)} calls`,
          accent: 'primary',
        },
        {
          label: 'Cost / 1K tokens',
          value: Number.isFinite(overallCostPerKTok) ? fmtMoney(overallCostPerKTok, currency) : DASH,
          sub: `${fmtTokens(totalTokens)} tokens`,
          accent: 'info',
        },
        {
          label: 'Tokens / call',
          value: Number.isFinite(overallTokensPerCall) ? fmtTokens(overallTokensPerCall) : DASH,
          sub: 'average prompt + completion',
          accent: 'success',
        },
      ],
      [overallAvgCost, overallCostPerKTok, overallTokensPerCall, currency, callCount, totalTokens],
    );

  // ----- Header actions -------------------------------------------------- //
  const headerActions = (
    <>
      <SegmentedToggle
        value={windowKey}
        options={WINDOWS.map((w) => ({ id: w.key, label: w.label }))}
        onChange={setWindowKey}
        ariaLabel="Time window"
      />
      <SegmentedToggle
        value={metric}
        options={METRICS}
        onChange={setMetric}
        ariaLabel="Rank breakdowns by"
      />
      <Button
        variant="outline"
        size="icon"
        onClick={() => void load()}
        disabled={loading}
        aria-label="Refresh usage"
        title="Refresh"
      >
        <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
      </Button>
    </>
  );

  const header = embedded ? (
    <div className="flex flex-wrap items-center justify-end gap-2">{headerActions}</div>
  ) : (
    <PageHeader
      eyebrow="Spend"
      icon={CircleDollarSign}
      title="Cost & usage"
      description="LLM spend metered through the single gateway cost ledger."
      actions={headerActions}
    />
  );

  // ----- States ---------------------------------------------------------- //
  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading cost data">
        {header}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} lines={1} />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} lines={5} />
          ))}
        </div>
        <Skeleton className="h-80 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load usage</AlertTitle>
          <AlertDescription>
            {error}{' '}
            <button
              type="button"
              onClick={() => void load()}
              className="font-semibold underline underline-offset-2"
            >
              Retry
            </button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!hasAny ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              icon={CircleDollarSign}
              title="No LLM spend recorded yet"
              description={`Nothing went through the gateway in the last ${windowLabel}. As the agent triages cases, cost and token usage will appear here.`}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPI tiles */}
          <Stagger
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
            itemClassName="h-full"
          >
            {kpis.map((k) => (
              <KpiTile
                key={k.label}
                label={k.label}
                value={k.value}
                sub={k.sub}
                icon={k.icon}
                accent={k.accent}
                delta={k.delta}
              />
            ))}
          </Stagger>

          {/* Spend over time */}
          <Card>
            <CardHeader className="pb-3">
              <SectionTitle
                icon={spendDelta != null && spendDelta > 0 ? TrendingUp : TrendingDown}
                meta={`${series.length} bucket${series.length === 1 ? '' : 's'} · last ${windowLabel}`}
              >
                Spend over time
              </SectionTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {series.length > 1 ? (
                <>
                  <TrendArea
                    data={trendData}
                    height={200}
                    colorToken="primary"
                    format={(n) => fmtMoney(n, currency)}
                    showXAxis={false}
                    ariaLabel={`Spend over time — ${series.length} buckets over the last ${windowLabel}`}
                  />
                  <div className="grid grid-cols-3 gap-4 border-t border-border pt-4">
                    {[
                      { k: 'Window total', v: fmtMoney(spend.total, currency) },
                      { k: 'Avg / bucket', v: fmtMoney(spend.avg, currency) },
                      { k: 'Peak bucket', v: fmtMoney(spend.peak, currency) },
                    ].map((s) => (
                      <div key={s.k}>
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {s.k}
                        </div>
                        <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-foreground">
                          {s.v}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <EmptyState
                  compact
                  icon={Gauge}
                  title="Not enough data points"
                  description="A spend trend will chart once there are at least two time buckets."
                />
              )}
            </CardContent>
          </Card>

          {/* Efficiency StatCards */}
          <div className="grid gap-4 md:grid-cols-3">
            {efficiency.map((s) => (
              <StatCard key={s.label} label={s.label} value={s.value} sub={s.sub} accent={s.accent} />
            ))}
          </div>

          {/* Ranked breakdowns */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <SectionTitle icon={Cpu}>By model</SectionTitle>
              </CardHeader>
              <CardContent>
                {byModel.length ? (
                  <BarList items={byModel.slice(0, 8)} format={fmtMetric} showPercent />
                ) : (
                  <EmptyState compact icon={Cpu} title="No model spend" />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <SectionTitle icon={Users}>By role</SectionTitle>
              </CardHeader>
              <CardContent>
                {byRole.length ? (
                  <BarList items={byRole.slice(0, 8)} format={fmtMetric} showPercent />
                ) : (
                  <EmptyState compact icon={Users} title="No role spend" />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <SectionTitle icon={LayoutGrid}>By surface</SectionTitle>
              </CardHeader>
              <CardContent>
                {bySurface.length ? (
                  <BarList items={bySurface.slice(0, 8)} format={fmtMetric} showPercent />
                ) : (
                  <EmptyState compact icon={LayoutGrid} title="No surface spend" />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Detailed ledger + composition donut */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="flex-col items-stretch gap-3 space-y-0 pb-3 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Coins className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Detailed cost ledger
                </CardTitle>
                <SegmentedToggle
                  value={dimension}
                  options={DIMENSIONS.map((d) => ({ id: d.id, label: d.label }))}
                  onChange={setDimension}
                  ariaLabel="Breakdown dimension"
                />
              </CardHeader>
              <CardContent>
                <DataTable<LedgerRow>
                  columns={columns}
                  rows={ledger}
                  getRowId={(r, i) => `${r.key}-${i}`}
                  sort={ledgerSort}
                  onSortChange={setLedgerSort}
                  density="compact"
                  ariaLabel={`Detailed cost ledger by ${dimMeta.label.toLowerCase()}`}
                  empty={
                    <EmptyState
                      compact
                      icon={Coins}
                      title="Nothing to break down"
                      description={`No ${dimMeta.label.toLowerCase()} spend recorded in the last ${windowLabel}.`}
                    />
                  }
                />
              </CardContent>
            </Card>

            <Card className="lg:col-span-1">
              <CardHeader className="pb-3">
                <SectionTitle icon={Gauge}>Cost composition</SectionTitle>
              </CardHeader>
              <CardContent>
                {compositionSegments.length ? (
                  <>
                    <DonutChart
                      segments={compositionSegments}
                      height={200}
                      format={(n) => fmtMoney(n, currency)}
                      ariaLabel={`Cost composition by ${dimMeta.label.toLowerCase()}`}
                      center={
                        <div>
                          <div className="font-mono text-lg font-bold tabular-nums text-foreground">
                            {fmtMoney(totalCost, currency)}
                          </div>
                          <div className="text-xs text-muted-foreground">total cost</div>
                        </div>
                      }
                    />
                    <ul className="mt-5 space-y-2.5 border-t border-border pt-4">
                      {compositionSegments.map((s, i) => (
                        <li key={`${s.label}-${i}`} className="flex items-center gap-2 text-sm">
                          <span
                            className="size-2.5 shrink-0 rounded-sm"
                            style={{ background: s.color ?? categorical(i) }}
                            aria-hidden
                          />
                          {dimMeta.verbatim && !s.label.startsWith('Other (') ? (
                            <InlineCode className="truncate">{s.label}</InlineCode>
                          ) : (
                            <span className="truncate text-foreground">{s.label}</span>
                          )}
                          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                            {totalCost > 0 ? fmtPercent(s.value / totalCost) : fmtMoney(s.value, currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <EmptyState
                    compact
                    icon={Gauge}
                    title="No cost for this dimension"
                  />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Top cost drivers */}
          {topDrivers.length ? (
            <Card>
              <CardHeader className="pb-3">
                <SectionTitle icon={TrendingUp} meta={`by ${metric}`}>
                  Top cost drivers
                </SectionTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col divide-y divide-border">
                  {topDrivers.map((d, i) => (
                    <li
                      key={`${d.key}-${i}`}
                      className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <span
                        className="size-2 shrink-0 rounded-sm"
                        style={{ background: categorical(i) }}
                        aria-hidden
                      />
                      <InlineCode className="min-w-0 max-w-full flex-1 truncate">{d.key}</InlineCode>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {fmtTokens(d.tokens)} tok
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {fmtNumber(d.calls)} calls
                      </span>
                      <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-foreground">
                        {fmtMoney(d.cost, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
