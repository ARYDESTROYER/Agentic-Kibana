/**
 * Overview — the Security Posture Dashboard (default landing surface).
 *
 * A calm, OpenSearch/AdSense-clean view of triage posture: a subtle hero with a
 * window toggle (24h / 7d / 30d) + refresh, an Active Risk Index gauge, an
 * AdSense-style KPI tile row (each drill-through to the cases list), MTTD/MTTA/MTTR
 * timing StatCards, and three ranked signal cards (source signals, severity
 * pressure, case workload state). Generous whitespace, hairline borders, accent
 * color reserved for severity/status — no decorative glow.
 *
 * Data: api.getMetrics, listCases, usageSummary, ragStats — fetched with
 * allSettled so a single failing call degrades one widget, never the page.
 *
 * Security: every label/value rendered here is a humanized enum, a formatted
 * number, or backend-derived text rendered as PLAIN text (BarList labels, source
 * names). No untrusted string is ever injected as markup.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Boxes,
  CircleDollarSign,
  Clock3,
  Database,
  Gauge,
  Inbox,
  LayoutDashboard,
  Radar,
  RefreshCw,
  ShieldAlert,
  Workflow,
} from 'lucide-react';

import type { Navigate } from '@/soc/router';
import { api } from '@/lib/api';
import type {
  Case,
  Metrics,
  RagStats,
  UsageSummary,
} from '@/lib/types';
import {
  DASH,
  fmtMoney,
  fmtNumber,
  formatTimestamp,
  fmtTokens,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { HeroPanel } from '@/soc/components/HeroPanel';
import { KpiTile, type KpiAccent } from '@/soc/components/KpiTile';
import { StatCard, type StatAccent } from '@/soc/components/StatCard';
import { RiskGauge } from '@/soc/components/RiskGauge';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { Stagger } from '@/soc/components/Stagger';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/ui/card';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';

// --------------------------------------------------------------------------- //
// Window toggle
// --------------------------------------------------------------------------- //
type WindowKey = '24h' | '7d' | '30d';
const WINDOWS: { key: WindowKey; label: string; hours: number }[] = [
  { key: '24h', label: '24h', hours: 24 },
  { key: '7d', label: '7d', hours: 24 * 7 },
  { key: '30d', label: '30d', hours: 24 * 30 },
];

interface OverviewProps {
  /** Drill-through navigation (KPI / workload rows seed a status filter). */
  onNavigate?: Navigate;
}

const OPEN_STATUSES = new Set(['open', 'investigating', 'in_progress']);
const CLOSED_STATUSES = new Set(['closed', 'resolved', 'auto_closed']);

/** Parse an ISO ts to epoch ms, or null when missing / unparseable. */
function ts(v?: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Mean of a list, or null when empty. */
function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Humanize a minutes duration into "Nh Nm" / "Nd Nh" / "Nm". */
function fmtDuration(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
    return DASH;
  }
  if (minutes < 1) return '<1m';
  const totalMin = Math.round(minutes);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Severity-band color tokens for the Severity Pressure bars + dots. */
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
type SevKey = (typeof SEV_ORDER)[number];
const SEV_BAR: Record<SevKey, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
};
const SEV_DOT: Record<SevKey, string> = {
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
  info: 'text-info',
};
const SEV_LABEL: Record<SevKey, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Informational',
};

/** Normalise a case risk_score into a severity band (matches RiskBadge bands). */
function bandOf(score?: number): SevKey {
  const s = typeof score === 'number' && Number.isFinite(score) ? score : 0;
  if (s >= 80) return 'critical';
  if (s >= 60) return 'high';
  if (s >= 35) return 'medium';
  if (s >= 15) return 'low';
  return 'info';
}

/** Workload-status → bar color token. */
function statusBar(status: string): string {
  const t = status.toLowerCase();
  if (OPEN_STATUSES.has(t)) return 'bg-info';
  if (t === 'needs_human' || t === 'escalated') return 'bg-high';
  if (CLOSED_STATUSES.has(t)) return 'bg-success';
  if (t === 'reopened') return 'bg-warning';
  return 'bg-accent-bar';
}

export default function Overview({ onNavigate }: OverviewProps) {
  const [windowKey, setWindowKey] = React.useState<WindowKey>('7d');
  const hours = WINDOWS.find((w) => w.key === windowKey)?.hours ?? 24 * 7;

  const [cases, setCases] = React.useState<Case[]>([]);
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [usage, setUsage] = React.useState<UsageSummary | null>(null);
  const [rag, setRag] = React.useState<RagStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, m, u, r] = await Promise.allSettled([
        api.listCases({ limit: 200 }),
        api.getMetrics(hours),
        api.usageSummary(hours),
        api.ragStats(),
      ]);
      if (c.status === 'fulfilled') setCases(c.value.cases ?? []);
      if (m.status === 'fulfilled') setMetrics(m.value);
      if (u.status === 'fulfilled') setUsage(u.value);
      if (r.status === 'fulfilled') setRag(r.value);
      // Only surface a page-level error if the load is wholly empty (the cases +
      // metrics calls both failed) — partial failures degrade per-widget.
      if (c.status === 'rejected' && m.status === 'rejected') {
        setError(
          c.reason instanceof Error ? c.reason.message : 'Failed to load dashboard data.',
        );
      }
      setLastRefresh(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard data.');
    } finally {
      setLoading(false);
    }
  }, [hours]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // ----- Derived posture -------------------------------------------------- //
  const derived = React.useMemo(() => {
    let open = 0;
    let critical = 0;
    let criticalHighAlerts = 0;
    const entities = new Set<string>();
    const sevCounts: Record<SevKey, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    const productCounts: Record<string, number> = {};

    // Timing samples (minutes).
    const mttdSamples: number[] = [];
    const mttaSamples: number[] = [];
    const mttrSamples: number[] = [];

    for (const k of cases) {
      const st = (k.status || '').toLowerCase();
      if (OPEN_STATUSES.has(st)) open += 1;

      const band = bandOf(k.risk_score);
      sevCounts[band] += 1;
      if (band === 'critical') critical += 1;
      if (band === 'critical' || band === 'high') criticalHighAlerts += 1;

      if (k.entity?.value) entities.add(`${k.entity.type || 'entity'}:${k.entity.value}`);

      // Product / category signal = the originating source (plain backend text).
      const product = k.source_name || k.source_id || 'Unattributed';
      productCounts[product] = (productCounts[product] ?? 0) + 1;

      // Timing — derive from whatever timestamps exist; honest "valid samples".
      const created = ts(k.created_at);
      const updated = ts(k.updated_at);
      if (created !== null) {
        // MTTD proxy: time the case has existed before first movement, when the
        // backend surfaces a detection timestamp; otherwise skip (no fabrication).
        const detectedAt = ts((k.detected_at as string | undefined) ?? null);
        if (detectedAt !== null) {
          mttdSamples.push(Math.max(0, (created - detectedAt) / 60000));
        }
        // MTTA proxy: time to first acknowledgement / verdict, when known.
        const ackAt = ts(
          (k.acknowledged_at as string | undefined) ??
            (k.first_response_at as string | undefined) ??
            null,
        );
        if (ackAt !== null) {
          mttaSamples.push(Math.max(0, (ackAt - created) / 60000));
        }
        // MTTR: created → closed, for closed cases with a known updated_at.
        if (CLOSED_STATUSES.has(st) && updated !== null) {
          mttrSamples.push(Math.max(0, (updated - created) / 60000));
        }
      }
    }

    // Prefer the backend's authoritative MTTR; fall back to local samples.
    const mttrMinutes =
      typeof metrics?.mttr_minutes === 'number' && metrics.mttr_minutes > 0
        ? metrics.mttr_minutes
        : mean(mttrSamples);

    return {
      open,
      critical,
      criticalHighAlerts,
      entities: entities.size,
      sevCounts,
      productCounts,
      mttd: mean(mttdSamples),
      mttdN: mttdSamples.length,
      mtta: mean(mttaSamples),
      mttaN: mttaSamples.length,
      mttr: mttrMinutes,
      mttrN:
        typeof metrics?.resolved_count === 'number' && metrics.resolved_count > 0
          ? metrics.resolved_count
          : mttrSamples.length,
    };
  }, [cases, metrics]);

  // Weighted risk pressure (0..100) — average risk, lifted by critical density.
  const riskIndex = React.useMemo(() => {
    const avg =
      typeof metrics?.avg_risk_score === 'number' && metrics.avg_risk_score > 0
        ? metrics.avg_risk_score
        : cases.length
          ? cases.reduce((a, k) => a + (k.risk_score ?? 0), 0) / cases.length
          : 0;
    const total = cases.length || 1;
    const criticalDensity = derived.critical / total; // 0..1
    const score = avg * 0.7 + criticalDensity * 100 * 0.3;
    return Math.max(0, Math.min(100, Math.round(score)));
  }, [metrics, cases, derived.critical]);

  // ----- BarList datasets -------------------------------------------------- //
  const productItems: BarListItem[] = React.useMemo(() => {
    const total = cases.length || 1;
    return Object.entries(derived.productCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, value]) => ({
        label,
        value,
        sub: `${Math.round((value / total) * 100)}% of case telemetry`,
      }));
  }, [derived.productCounts, cases.length]);

  const severityItems: BarListItem[] = React.useMemo(() => {
    const total = cases.length || 1;
    return SEV_ORDER.map((sev) => ({
      label: SEV_LABEL[sev],
      value: derived.sevCounts[sev],
      color: SEV_BAR[sev],
      sub: `${Math.round((derived.sevCounts[sev] / total) * 100)}% of severity telemetry`,
    }));
  }, [derived.sevCounts, cases.length]);

  const workloadItems = React.useMemo(() => {
    const byStatus = metrics?.by_status ?? {};
    const entries = Object.entries(byStatus);
    const source = entries.length
      ? entries
      : Object.entries(
          cases.reduce<Record<string, number>>((acc, k) => {
            const s = (k.status || 'unknown').toLowerCase();
            acc[s] = (acc[s] ?? 0) + 1;
            return acc;
          }, {}),
        );
    const total = source.reduce((a, [, v]) => a + v, 0) || 1;
    return source
      .sort((a, b) => b[1] - a[1])
      .map(([status, value]) => ({
        status,
        item: {
          label: humanizeToken(status),
          value,
          color: statusBar(status),
          sub: `${Math.round((value / total) * 100)}% of workload`,
        } satisfies BarListItem,
      }));
  }, [metrics, cases]);

  // ----- KPI tiles --------------------------------------------------------- //
  const kpis: {
    label: string;
    value: React.ReactNode;
    sub?: string;
    icon: typeof Inbox;
    accent: KpiAccent;
    onClick?: () => void;
  }[] = React.useMemo(
    () => [
      {
        label: 'Open Cases',
        value: fmtNumber(derived.open),
        sub: `${fmtNumber(cases.length)} cases tracked`,
        icon: Inbox,
        accent: 'critical',
        onClick: onNavigate ? () => onNavigate('cases', { status: 'open' }) : undefined,
      },
      {
        label: 'Cases In Window',
        value: fmtNumber(metrics?.total_cases ?? cases.length),
        sub: `${WINDOWS.find((w) => w.key === windowKey)?.label} operating window`,
        icon: LayoutDashboard,
        accent: 'info',
        onClick: onNavigate ? () => onNavigate('cases') : undefined,
      },
      {
        label: 'Critical / High Alerts',
        value: fmtNumber(derived.criticalHighAlerts),
        sub: `${fmtNumber(derived.critical)} critical observed`,
        icon: ShieldAlert,
        accent: 'high',
        onClick: onNavigate
          ? () => onNavigate('cases', { status: 'needs_human' })
          : undefined,
      },
      {
        label: 'Artifacts In Scope',
        value: fmtNumber(derived.entities),
        sub: 'Distinct entities linked to cases',
        icon: Boxes,
        accent: 'medium',
      },
      {
        label: 'Escalated To Human',
        value: fmtNumber(metrics?.needs_human_cases ?? 0),
        sub: 'Awaiting analyst review',
        icon: Workflow,
        accent: 'low',
        onClick: onNavigate
          ? () => onNavigate('cases', { status: 'needs_human' })
          : undefined,
      },
      {
        label: 'Knowledge Signals',
        value: fmtNumber(rag?.document_count),
        sub: `${fmtNumber(rag?.total_chunks)} indexed chunks`,
        icon: Database,
        accent: 'success',
        onClick: onNavigate ? () => onNavigate('knowledge') : undefined,
      },
      {
        label: 'LLM Spend',
        value: fmtMoney(usage?.total_cost, usage?.currency),
        sub:
          typeof usage?.total_tokens === 'number'
            ? `${fmtTokens(usage.total_tokens)} tokens · ${fmtNumber(usage.call_count)} calls`
            : 'No spend recorded',
        icon: CircleDollarSign,
        accent: 'primary',
        onClick: onNavigate ? () => onNavigate('cost') : undefined,
      },
    ],
    [derived, metrics, cases.length, rag, usage, windowKey, onNavigate],
  );

  // ----- States ----------------------------------------------------------- //
  if (loading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-32 w-full rounded-lg" />
        <div className="grid gap-5 lg:grid-cols-3">
          <Skeleton className="h-72 rounded-lg lg:col-span-1" />
          <div className="grid grid-cols-2 gap-5 lg:col-span-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </div>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-80 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const windowToggle = (
    <div
      role="group"
      aria-label="Time window"
      className="inline-flex items-center rounded-md border border-border bg-card/70 p-0.5"
    >
      {WINDOWS.map((w) => {
        const active = w.key === windowKey;
        return (
          <button
            key={w.key}
            type="button"
            onClick={() => setWindowKey(w.key)}
            aria-pressed={active}
            className={cn(
              'rounded-[5px] px-3 py-1 text-xs font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-primary text-primary-foreground shadow-elev1'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {w.label}
          </button>
        );
      })}
    </div>
  );

  const empty = !loading && !error && cases.length === 0 && !metrics?.total_cases;

  return (
    <div className="space-y-8">
      <HeroPanel
        eyebrow="Security Command Center"
        icon={Radar}
        title="Security Posture Dashboard"
        description="Live triage posture across every connected source — risk pressure, alert load, and how the agent is resolving cases."
        meta={lastRefresh ? `Last refresh ${formatTimestamp(lastRefresh)}` : undefined}
        actions={
          <>
            {windowToggle}
            <Button
              variant="outline"
              size="icon"
              onClick={() => void load()}
              aria-label="Refresh dashboard"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
            </Button>
          </>
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Could not load the dashboard</AlertTitle>
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

      {empty ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              icon={Gauge}
              title="No triage activity yet"
              description="Once sources are connected and cases start flowing, your posture, risk index, and timing metrics will appear here."
              action={
                onNavigate ? (
                  <Button onClick={() => onNavigate('sources')}>Connect a source</Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ---- Risk index + KPI tile row ---- */}
          <div className="grid gap-5 lg:grid-cols-3">
            {/* Active Risk Index */}
            <Card className="lg:col-span-1">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Active Risk Index
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-6 pb-6">
                <div className="flex w-full flex-col items-center gap-2 py-2">
                  <RiskGauge score={riskIndex} size={208} />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Weighted pressure / 100
                  </span>
                </div>
                <dl className="w-full divide-y divide-border rounded-md border border-border">
                  {[
                    { k: 'Open cases', v: derived.open },
                    { k: 'Critical cases', v: derived.critical },
                    { k: 'Critical / High alerts', v: derived.criticalHighAlerts },
                  ].map((row) => (
                    <div
                      key={row.k}
                      className="flex items-center justify-between px-3.5 py-2.5"
                    >
                      <dt className="text-sm text-muted-foreground">{row.k}</dt>
                      <dd className="font-mono text-sm font-semibold tabular-nums text-foreground">
                        {fmtNumber(row.v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>

            {/* KPI tiles */}
            <div className="lg:col-span-2">
              <Stagger className="grid h-full grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {kpis.map((kpi) => (
                  <KpiTile
                    key={kpi.label}
                    label={kpi.label}
                    value={kpi.value}
                    sub={kpi.sub}
                    icon={kpi.icon}
                    accent={kpi.accent}
                    onClick={kpi.onClick}
                  />
                ))}
              </Stagger>
            </div>
          </div>

          {/* ---- Timing StatCards ---- */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Response timing
            </h2>
            <div className="grid gap-5 md:grid-cols-3">
            {(
              [
                {
                  label: 'MTTD',
                  value: fmtDuration(derived.mttd),
                  n: derived.mttdN,
                  accent: 'info' as StatAccent,
                },
                {
                  label: 'MTTA',
                  value: fmtDuration(derived.mtta),
                  n: derived.mttaN,
                  accent: 'medium' as StatAccent,
                },
                {
                  label: 'MTTR',
                  value: fmtDuration(derived.mttr),
                  n: derived.mttrN,
                  accent: 'success' as StatAccent,
                },
              ]
            ).map((s) => (
              <StatCard
                key={s.label}
                label={s.label}
                value={s.value}
                accent={s.accent}
                icon={Clock3}
                sub={`${fmtNumber(s.n)} valid sample${s.n === 1 ? '' : 's'}`}
              />
            ))}
            </div>
          </section>

          {/* ---- BarList cards ---- */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Signal breakdown
            </h2>
            <div className="grid gap-5 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Source Signals
                </CardTitle>
              </CardHeader>
              <CardContent>
                {productItems.length ? (
                  <BarList items={productItems} showRank showPercent />
                ) : (
                  <EmptyState
                    compact
                    icon={Boxes}
                    title="No source signals"
                    description="Cases will group by their originating source here."
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Severity Pressure
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-4">
                  {SEV_ORDER.map((sev) => {
                    const item = severityItems.find((i) => i.label === SEV_LABEL[sev])!;
                    const total = cases.length || 1;
                    const pct = Math.round((item.value / total) * 100);
                    return (
                      <li key={sev}>
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                            <span
                              className={cn('text-base leading-none', SEV_DOT[sev])}
                              aria-hidden
                            >
                              ●
                            </span>
                            {SEV_LABEL[sev]}
                          </span>
                          <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                            {fmtNumber(item.value)}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn('h-full rounded-full', SEV_BAR[sev])}
                            style={{ width: `${Math.min(100, pct)}%` }}
                            role="progressbar"
                            aria-valuenow={pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`${SEV_LABEL[sev]} severity pressure`}
                          />
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {pct}% of severity telemetry
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Workflow className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Case Workload State
                </CardTitle>
              </CardHeader>
              <CardContent>
                {workloadItems.length ? (
                  <ul className="flex flex-col gap-4">
                    {workloadItems.map(({ status, item }) => {
                      const total =
                        workloadItems.reduce((a, w) => a + w.item.value, 0) || 1;
                      const pct = Math.round((item.value / total) * 100);
                      const clickable = !!onNavigate;
                      return (
                        <li key={status}>
                          <button
                            type="button"
                            disabled={!clickable}
                            onClick={
                              clickable
                                ? () => onNavigate?.('cases', { status })
                                : undefined
                            }
                            className={cn(
                              'block w-full rounded-md text-left',
                              clickable &&
                                'transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              clickable && '-mx-1 px-1 py-0.5',
                            )}
                            aria-label={
                              clickable
                                ? `View ${item.label} cases`
                                : undefined
                            }
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="truncate text-sm font-medium text-foreground">
                                {item.label}
                              </span>
                              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                                {fmtNumber(item.value)}
                              </span>
                            </div>
                            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn('h-full rounded-full', item.color)}
                                style={{ width: `${Math.min(100, pct)}%` }}
                                role="progressbar"
                                aria-valuenow={pct}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-label={item.label}
                              />
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {pct}% of workload
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <EmptyState
                    compact
                    icon={Workflow}
                    title="No workload"
                    description="Case lifecycle distribution will appear here."
                  />
                )}
              </CardContent>
            </Card>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
