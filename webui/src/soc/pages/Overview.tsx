/**
 * Overview — the Security Posture Dashboard (default landing surface).
 *
 * Round-5 Dash-A/Dash-B rework (DESIGN_STANDARD §4.2/§4.3): a DENSE, three-zone
 * operational dashboard that uses ultrawide real estate instead of a marketing hero
 * over a crammed nested grid.
 *
 *   ┌ HERO ──── compact <PageHeader variant="hero"> (~64px), not a tall band.
 *   ├ CONTROL BAR ─ <TimeRangePicker> (relative ES date-math) + auto-refresh (default
 *   │               Off, cost-metered) + a last-refresh stamp.
 *   ├ KPI STRIP ─── a flat, un-nested responsive grid of drill-down KpiTiles, each with
 *   │               the correct `goodDirection` (lower-is-better for open/FP/MTTA/…).
 *   └ WIDGET GRID ─ named collapsible <DashboardGroup> bands (severity, attention queue,
 *                   autonomous-vs-human split [#3 trust surface], timing, cost/budget,
 *                   connector health, MITRE below the fold).
 *
 * Data: `usePosture(hours)` is the AUTHORITATIVE server-side lifecycle rollup (MTTA/MTTR/
 * dwell p50 + SLA, with honest labelled DASH) — the old ~120 lines of client-side timing
 * math that shadowed it are GONE. `listCases`/`getMetrics`/`usageSummary`/`ragStats` are
 * fetched with allSettled so one failing call degrades a single widget, never the page.
 *
 * Security (#9): every label/value here is a humanized enum, a formatted number, or
 * backend-derived text rendered as PLAIN text (BarList labels, source names). No untrusted
 * string is ever injected as markup.
 *
 * Advisory (#3): NOTHING on this dashboard feeds `decide()` — it reads the outcome of
 * triage; it never influences close/escalate.
 */
import * as React from 'react';
import {
  Boxes,
  CircleDollarSign,
  Clock3,
  Database,
  Gauge,
  Inbox,
  LayoutDashboard,
  Plug,
  Radar,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Workflow,
} from 'lucide-react';

import { useNavigateOptional, type Navigate } from '@/soc/router';
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
  fmtTokens,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { ControlBar } from '@/soc/components/ControlBar';
import {
  TimeRangePicker,
  DEFAULT_RANGE,
  resolveRange,
  type TimeRange,
  type RefreshValue,
} from '@/soc/components/TimeRangePicker';
import { DashboardGroup } from '@/soc/components/DashboardGroup';
import { KpiTile, type KpiAccent } from '@/soc/components/KpiTile';
import { RiskGauge } from '@/soc/components/RiskGauge';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { Stagger } from '@/soc/components/Stagger';
import { AutomationNudge } from './AutomationNudge';
import { usePosture } from '@/soc/hooks/usePosture';
import {
  Card,
  CardContent,
} from '@/ui/card';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';

import { humanizeMinutes as humanizeMins, ratioPct } from './posture.format';

/**
 * The Overview hero title — the app's white-screen boot guard anchors on it (the
 * smoke test asserts the whole console boots to this string). Exported as a single
 * constant so the title can be reworded here WITHOUT breaking the tests that check
 * "the app booted" (they import this constant rather than hardcoding the copy).
 */
export const PAGE_TITLE = 'Security Posture Dashboard';

interface OverviewProps {
  /**
   * Optional drill-through navigation (KPI / workload rows seed a status filter + the
   * window). When omitted (App renders it without a nav prop), it resolves from the
   * router context via `useNavigateOptional()` — no prop-drilling (Round-5 Coupling-A).
   */
  onNavigate?: Navigate;
}

const OPEN_STATUSES = new Set(['open', 'investigating', 'in_progress', 'new', 'on_hold']);
const CLOSED_STATUSES = new Set(['closed', 'resolved', 'auto_closed']);

/** Per-browser dismissal flag for the recommended-automation nudge (onboarding). */
const NUDGE_KEY = 'tlsoc.overview.automationNudge';

/** Round a resolved range down to whole hours (min 1) for the window-scoped fetches. */
function rangeHours(range: TimeRange): number {
  const { fromMs, toMs } = resolveRange(range);
  const h = Math.round((toMs - fromMs) / 3_600_000);
  return h > 0 ? h : 1;
}

// --------------------------------------------------------------------------- //
// Severity bands
// --------------------------------------------------------------------------- //
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
  // Navigation seam: an explicit prop (host/test) wins; otherwise resolve from the
  // router context (no-op when rendered provider-less in a unit test). Coupling-A.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  // ----- Time range + auto-refresh (the CONTROL BAR state) ---------------- //
  const [range, setRange] = React.useState<TimeRange>(DEFAULT_RANGE);
  const [refresh, setRefresh] = React.useState<RefreshValue>('off');
  const hours = React.useMemo(() => rangeHours(range), [range]);
  /** The `window` (hours) carried on every drill-through so the case list matches. */
  const navWindow = hours;

  // ----- Dashboard data loads --------------------------------------------- //
  // NOTE (Round-6 #37): `listCases` now honours the selected range too — it is fetched
  // with a `from=now-${hours}h` created-at window, so every case-DERIVED widget below
  // (open/severity/entities/connector-health/workload) reflects the TimeRangePicker,
  // alongside `usageSummary` (cost ledger) + `usePosture` which already did. Only
  // `getMetrics.total_cases` stays all-time (its `window_hours` scopes just the cost
  // sub-block) — surfaced honestly as "Total Cases" (all tracked), never the range.
  const [cases, setCases] = React.useState<Case[]>([]);
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [usage, setUsage] = React.useState<UsageSummary | null>(null);
  const [rag, setRag] = React.useState<RagStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [lastRefreshMs, setLastRefreshMs] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, m, u, r] = await Promise.allSettled([
        // #37: window the case sample by created-at so the case-derived widgets honour
        // the range. Backend caps at 200 by created-desc, so this is the most-recent
        // slice within the window (what the KPI/severity/health widgets summarise).
        api.listCases({ limit: 200, from: `now-${hours}h` }),
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
        setError(c.reason ?? m.reason ?? new Error('Failed to load dashboard data.'));
      }
      setLastRefreshMs(Date.now());
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Server-side posture rollup (Round 3) — the AUTHORITATIVE lifecycle (MTTA/MTTR/
  // dwell p50 with an honest labelled DASH) + SLA. This REPLACES the deleted ~120
  // lines of client-side timing derivation. `usePosture` (useAsync) reloads on `hours`.
  const { data: posture, reload: reloadPosture } = usePosture(hours);

  /** One refresh pulse for the whole dashboard (control-bar button + auto-refresh tick). */
  const refreshAll = React.useCallback(() => {
    void load();
    void reloadPosture();
  }, [load, reloadPosture]);

  // ----- Recommended-automation nudge (onboarding-beginner) --------------- //
  // Shows ONCE when a source is enabled but threshold tuning is still off (and not
  // previously dismissed). The api calls are typeof-guarded so a minimal test/mock
  // surface (no listSources/get) simply never nudges — and AutomationNudge (which reads
  // useAuth) is only mounted when this is true, so it can't run provider-less.
  const [showNudge, setShowNudge] = React.useState(false);
  React.useEffect(() => {
    const canFetch = typeof api.listSources === 'function' && typeof api.get === 'function';
    if (!canFetch) return undefined;
    try {
      if (localStorage.getItem(NUDGE_KEY) === 'dismissed') return undefined;
    } catch {
      /* no storage → treat as not dismissed */
    }
    let alive = true;
    void (async () => {
      try {
        const [srcRes, tuning] = await Promise.all([
          api.listSources(),
          api.get<{ config?: { enabled?: boolean } }>('tuning/config'),
        ]);
        const hasEnabledSource = (srcRes.sources ?? []).some((s) => s.enabled !== false);
        const tuningOff = tuning?.config?.enabled === false;
        if (alive) setShowNudge(Boolean(hasEnabledSource && tuningOff));
      } catch {
        /* best-effort — no nudge on failure */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const dismissNudge = React.useCallback(() => {
    try {
      localStorage.setItem(NUDGE_KEY, 'dismissed');
    } catch {
      /* ignore storage errors */
    }
    setShowNudge(false);
  }, []);

  // ----- Derived case-shape breakdowns (NOT lifecycle timing) ------------- //
  // Only what the server posture rollup does NOT provide: open-by-severity, distinct
  // entities, per-source signal, and the status workload. All pure counts over the
  // case sample — no timing math (that lives on the server now).
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
    }

    return {
      open,
      critical,
      criticalHighAlerts,
      entities: entities.size,
      sevCounts,
      productCounts,
    };
  }, [cases]);

  // ----- Autonomous-vs-human split (#3 trust surface) --------------------- //
  // How many cases the agent resolved on its own vs. what it escalated for a human.
  // Read from the server posture quality block when present; else derived from cases.
  const autonomy = React.useMemo(() => {
    const q = posture?.quality;
    if (q && q.terminal_cases >= 0) {
      const autoClosed = q.auto_closed_cases ?? 0;
      const escalated = (q.escalated_cases ?? 0) + (q.needs_human_cases ?? 0);
      const total = autoClosed + escalated;
      return {
        autoClosed,
        escalated,
        automationPct: q.automation_rate ?? (total ? autoClosed / total : 0),
        source: 'server' as const,
      };
    }
    let autoClosed = 0;
    let escalated = 0;
    for (const k of cases) {
      const st = (k.status || '').toLowerCase();
      if (st === 'needs_human' || st === 'escalated') escalated += 1;
      else if (st === 'auto_closed' || (CLOSED_STATUSES.has(st) && k.decision_by === 'auto')) {
        autoClosed += 1;
      }
    }
    const total = autoClosed + escalated;
    return {
      autoClosed,
      escalated,
      automationPct: total ? autoClosed / total : 0,
      source: 'local' as const,
    };
  }, [posture, cases]);

  // ----- Response-timing trio (server posture, honest DASH) --------------- //
  const timing = React.useMemo(() => {
    const life = posture?.lifecycle;
    const block = (
      label: string,
      key: 'dwell_minutes' | 'mtta_minutes' | 'mttr_minutes',
      accent: KpiAccent,
    ) => {
      const b = life?.[key];
      return {
        label,
        value: b && b.available ? humanizeMins(b.p50) : DASH,
        sub:
          b && b.available
            ? `p50 · ${fmtNumber(b.count)} sample${b.count === 1 ? '' : 's'}`
            : b?.reason || 'no samples yet',
        accent,
      };
    };
    return [
      block('MTTD (dwell)', 'dwell_minutes', 'info'),
      block('MTTA', 'mtta_minutes', 'medium'),
      block('MTTR', 'mttr_minutes', 'success'),
    ];
  }, [posture]);

  // SLA posture (server-side, advisory). null when the policy is off / unavailable.
  const slaPosture = React.useMemo(() => {
    const sla = posture?.sla;
    if (!sla || !sla.enabled) return null;
    const atRisk = (sla.response_at_risk ?? 0) + (sla.resolve_at_risk ?? 0);
    const breached = (sla.response_breached ?? 0) + (sla.resolve_breached ?? 0);
    return { atRisk, breached, attainment: sla.attainment_pct ?? 0 };
  }, [posture]);

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
      .slice(0, 8)
      .map(([label, value]) => ({
        label,
        value,
        sub: `${Math.round((value / total) * 100)}% of case telemetry`,
      }));
  }, [derived.productCounts, cases.length]);

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
    return source
      .sort((a, b) => b[1] - a[1])
      .map(([status, value]) => ({ status, value }));
  }, [metrics, cases]);

  // ----- KPI strip (4-6+ drill-down tiles) --------------------------------- //
  const kpis: {
    label: string;
    value: React.ReactNode;
    sub?: string;
    icon: typeof Inbox;
    accent: KpiAccent;
    goodDirection: 'up' | 'down' | 'none';
    onClick?: () => void;
  }[] = React.useMemo(
    () => [
      {
        label: 'Open Cases',
        value: fmtNumber(derived.open),
        sub: `${fmtNumber(cases.length)} cases tracked`,
        icon: Inbox,
        accent: 'critical',
        goodDirection: 'down', // fewer open cases is better
        onClick: navigate
          ? () => navigate('cases', { status: 'open', window: navWindow })
          : undefined,
      },
      {
        // NOT window-scoped — `total_cases` is all-time (the recent-capped total), so
        // this reads honestly as "Total Cases" rather than falsely implying the range.
        label: 'Total Cases',
        value: fmtNumber(metrics?.total_cases ?? cases.length),
        sub: 'All tracked cases',
        icon: LayoutDashboard,
        accent: 'info',
        goodDirection: 'none',
        onClick: navigate ? () => navigate('cases') : undefined,
      },
      {
        // #38: deep-links to a severity-filtered Cases view. The tile aggregates TWO
        // bands (critical + high) but the Cases severity facet is single-band, so we
        // drill to the WORST non-empty band — critical when any exist (worst-first, and
        // matching the "N critical observed" sub), else high (which then equals the whole
        // crit/high set). Carries the window so the list matches the selected range.
        label: 'Critical / High',
        value: fmtNumber(derived.criticalHighAlerts),
        sub: `${fmtNumber(derived.critical)} critical observed`,
        icon: ShieldAlert,
        accent: 'high',
        goodDirection: 'down', // fewer high-severity is better
        onClick: navigate
          ? () =>
              navigate('cases', {
                severity: derived.critical > 0 ? 'critical' : 'high',
                window: navWindow,
              })
          : undefined,
      },
      {
        label: 'Escalated To Human',
        value: fmtNumber(metrics?.needs_human_cases ?? autonomy.escalated),
        sub: 'Awaiting analyst review',
        icon: Workflow,
        accent: 'low',
        goodDirection: 'down',
        onClick: navigate
          ? () => navigate('cases', { status: 'needs_human', window: navWindow })
          : undefined,
      },
      {
        label: 'Artifacts In Scope',
        value: fmtNumber(derived.entities),
        sub: 'Distinct entities linked to cases',
        icon: Boxes,
        accent: 'medium',
        goodDirection: 'none',
      },
      {
        label: 'Knowledge Signals',
        value: fmtNumber(rag?.document_count),
        sub: `${fmtNumber(rag?.total_chunks)} indexed chunks`,
        icon: Database,
        accent: 'success',
        goodDirection: 'up',
        onClick: navigate
          ? () => navigate('intelligence', { tab: 'knowledge' })
          : undefined,
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
        goodDirection: 'down', // lower spend is better
        onClick: navigate ? () => navigate('metrics', { tab: 'cost' }) : undefined,
      },
    ],
    [derived, metrics, cases.length, rag, usage, navWindow, autonomy.escalated, navigate],
  );

  // ----- The compact control bar (shared across all three-zone dashboards) - //
  const controlBar = (
    <ControlBar
      variant="flat"
      label="Dashboard controls"
      controls={
        <>
          <TimeRangePicker
            value={range}
            onChange={setRange}
            refresh={refresh}
            onRefreshChange={setRefresh}
            onRefreshTick={refreshAll}
            lastRefreshedMs={lastRefreshMs}
            size="sm"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={refreshAll}
            aria-label="Refresh dashboard"
            title="Refresh"
            className="h-8 w-8"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
          </Button>
        </>
      }
    />
  );

  // ----- States ----------------------------------------------------------- //
  // Loading skeleton mirrors the real three-zone layout in LOCKSTEP so nothing shifts.
  if (loading && !cases.length && !metrics) {
    return (
      <PageContainer variant="wide">
        <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
          {/* hero */}
          <Skeleton className="h-16 w-full rounded-lg" />
          {/* control bar */}
          <Skeleton className="h-9 w-72 rounded-md" />
          {/* KPI strip — 7 tiles, same responsive grid as the real strip */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4 2xl:grid-cols-7">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-lg" />
            ))}
          </div>
          {/* widget grid — THREE rows in LOCKSTEP with the real layout: Row A + Row B
              are xl:grid-cols-3, Row C is xl:grid-cols-2, so nothing shifts on load. */}
          <div className="grid gap-6 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-64 rounded-lg" />
            ))}
          </div>
          <div className="grid gap-6 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-56 rounded-lg" />
            ))}
          </div>
          <div className="grid gap-6 xl:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-56 rounded-lg" />
            ))}
          </div>
        </div>
      </PageContainer>
    );
  }

  const empty = !loading && !error && cases.length === 0 && !metrics?.total_cases;

  // Severity slice for the KPI-adjacent "open by severity" widget.
  const totalCases = cases.length || 1;

  return (
    <PageContainer variant="wide" className="space-y-6">
      {/* ---- ZONE 1: compact hero (~64px) ---- */}
      <PageHeader
        variant="hero"
        className="hero-display"
        data-testid="page-hero"
        eyebrow="Security Command Center"
        icon={Radar}
        title={PAGE_TITLE}
        description="Live triage posture across every connected source — risk pressure, alert load, and how the agent is resolving cases."
        meta={
          slaPosture ? (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium tabular-nums',
                slaPosture.breached > 0
                  ? 'border-critical/40 bg-critical/10 text-critical'
                  : slaPosture.atRisk > 0
                    ? 'border-high/40 bg-high/10 text-high'
                    : 'border-success/40 bg-success/10 text-success',
              )}
              title="SLA attainment vs the per-priority response/resolve targets"
            >
              SLA {ratioPct(slaPosture.attainment / 100)}
            </span>
          ) : undefined
        }
      />

      {/* ---- ZONE 1b: control bar (time range + auto-refresh + last-refresh) ---- */}
      {controlBar}

      {/* Recommended-automation nudge — only in the non-empty state, only for a
          principal who can act (AutomationNudge self-hides otherwise). */}
      {showNudge && !empty ? (
        <AutomationNudge
          onEnabled={() => {
            setShowNudge(false);
            refreshAll();
          }}
          onReview={() => navigate?.('tuning')}
          onDismiss={dismissNudge}
        />
      ) : null}

      {error ? (
        <LoadError
          error={error}
          title="Could not load the dashboard"
          onRetry={refreshAll}
        />
      ) : null}

      {empty ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              icon={Gauge}
              title="No triage activity yet"
              description="Once sources are connected and cases start flowing, your posture, risk index, and timing metrics will appear here."
              action={
                navigate ? (
                  <Button onClick={() => navigate('sources')}>Connect a source</Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="animate-fade-in space-y-6">
          {/* ---- ZONE 2: KPI strip — flat, un-nested, responsive by COLUMN COUNT ---- */}
          <Stagger
            className="grid grid-cols-2 gap-4 md:grid-cols-4 2xl:grid-cols-7"
            itemClassName="h-full"
          >
            {kpis.map((kpi) => (
              <KpiTile
                key={kpi.label}
                label={kpi.label}
                value={kpi.value}
                sub={kpi.sub}
                icon={kpi.icon}
                accent={kpi.accent}
                goodDirection={kpi.goodDirection}
                onClick={kpi.onClick}
              />
            ))}
          </Stagger>

          {/* ---- ZONE 3: widget grid — named collapsible bands ---- */}

          {/* Row A: risk gauge · open-by-severity · attention queue */}
          <div className="grid gap-6 xl:grid-cols-3">
            {/* Active Risk Index */}
            <DashboardGroup title="Active Risk Index" description="weighted pressure">
              <Card>
                <CardContent className="flex flex-col items-center gap-3 py-5">
                  <RiskGauge score={riskIndex} size={200} label="Weighted risk pressure" />
                  <div className="grid w-full grid-cols-3 gap-2 pt-1">
                    {[
                      { k: 'Open', v: derived.open, accent: 'text-info' },
                      { k: 'Critical', v: derived.critical, accent: 'text-critical' },
                      { k: 'Crit / High', v: derived.criticalHighAlerts, accent: 'text-high' },
                    ].map((row) => (
                      <div
                        key={row.k}
                        className="rounded-md border border-border bg-surface px-2 py-2 text-center"
                      >
                        <div
                          className={cn(
                            'font-mono text-lg font-semibold tabular-nums',
                            row.accent,
                          )}
                        >
                          {fmtNumber(row.v)}
                        </div>
                        <div className="mt-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                          {row.k}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </DashboardGroup>

            {/* Open cases by severity */}
            <DashboardGroup title="Open cases by severity" count={derived.open}>
              <Card>
                <CardContent className="py-4">
                  <ul className="flex flex-col gap-3.5">
                    {SEV_ORDER.map((sev) => {
                      const value = derived.sevCounts[sev];
                      const pct = Math.round((value / totalCases) * 100);
                      const clickable = !!navigate;
                      return (
                        <li key={sev}>
                          {/* #38: each band deep-links to a severity-filtered Cases view
                              (severity-only, no status — matching this row's count, which
                              spans every status in the band). Carries the window so the
                              list matches the selected range. Mirrors the workload rows. */}
                          <button
                            type="button"
                            disabled={!clickable}
                            onClick={
                              clickable
                                ? () => navigate('cases', { severity: sev, window: navWindow })
                                : undefined
                            }
                            className={cn(
                              'block w-full rounded-md text-left',
                              clickable &&
                                '-mx-1 px-1 py-0.5 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            )}
                            aria-label={
                              clickable ? `View ${SEV_LABEL[sev]} severity cases` : undefined
                            }
                          >
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
                                {fmtNumber(value)}
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
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            </DashboardGroup>

            {/* Attention queue — escalations awaiting a human, vs SLA */}
            <DashboardGroup
              title="Attention queue"
              count={metrics?.needs_human_cases ?? autonomy.escalated}
              description="awaiting a human"
            >
              <Card>
                <CardContent className="space-y-4 py-4">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <div className="font-mono text-3xl font-semibold tabular-nums text-high">
                        {fmtNumber(metrics?.needs_human_cases ?? autonomy.escalated)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        cases escalated for review
                      </div>
                    </div>
                    <Workflow className="h-8 w-8 text-high/60" aria-hidden />
                  </div>
                  {slaPosture ? (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-md border border-critical/30 bg-critical/5 px-3 py-2">
                        <div className="font-mono text-lg font-semibold tabular-nums text-critical">
                          {fmtNumber(slaPosture.breached)}
                        </div>
                        <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                          SLA breached
                        </div>
                      </div>
                      <div className="rounded-md border border-high/30 bg-high/5 px-3 py-2">
                        <div className="font-mono text-lg font-semibold tabular-nums text-high">
                          {fmtNumber(slaPosture.atRisk)}
                        </div>
                        <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                          SLA at risk
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      SLA tracking is off — enable per-priority targets in Settings to see
                      aging vs. target here.
                    </p>
                  )}
                  {navigate ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() =>
                        navigate('cases', { status: 'needs_human', window: navWindow })
                      }
                    >
                      Review escalations
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            </DashboardGroup>
          </div>

          {/* Row B: autonomy split (#3) · timing trio · cost & budget */}
          <div className="grid gap-6 xl:grid-cols-3">
            {/* Autonomous vs human — the #3 trust surface */}
            <DashboardGroup
              title="Autonomous vs human"
              description="how cases were resolved"
            >
              <Card>
                <CardContent className="space-y-4 py-4">
                  <div className="flex items-center justify-center gap-2 text-4xl font-semibold tabular-nums">
                    <ShieldCheck className="h-7 w-7 text-success" aria-hidden />
                    <span className="text-foreground">
                      {ratioPct(autonomy.automationPct)}
                    </span>
                  </div>
                  <p className="text-center text-xs text-muted-foreground">
                    resolved autonomously by the agent
                  </p>
                  {/* split bar */}
                  <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-success"
                      style={{
                        width: `${Math.round(
                          (autonomy.autoClosed /
                            (autonomy.autoClosed + autonomy.escalated || 1)) *
                            100,
                        )}%`,
                      }}
                      aria-hidden
                    />
                    <div className="h-full flex-1 bg-high" aria-hidden />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2">
                      <div className="font-mono text-lg font-semibold tabular-nums text-success">
                        {fmtNumber(autonomy.autoClosed)}
                      </div>
                      <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                        Auto-resolved
                      </div>
                    </div>
                    <div className="rounded-md border border-high/30 bg-high/5 px-3 py-2">
                      <div className="font-mono text-lg font-semibold tabular-nums text-high">
                        {fmtNumber(autonomy.escalated)}
                      </div>
                      <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                        Sent to human
                      </div>
                    </div>
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    Advisory only — the agent recommends; the deterministic case manager
                    decides. This dashboard never influences that.
                  </p>
                </CardContent>
              </Card>
            </DashboardGroup>

            {/* Response timing trio (MTTD / MTTA / MTTR) */}
            <DashboardGroup
              title="Response timing"
              description="p50, server-computed"
              actions={
                navigate ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate('metrics', { tab: 'posture' })}
                  >
                    Detail →
                  </Button>
                ) : undefined
              }
            >
              <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
                {timing.map((s) => (
                  <KpiTile
                    key={s.label}
                    variant="bar"
                    label={s.label}
                    value={s.value}
                    sub={s.sub}
                    accent={s.accent}
                    icon={Clock3}
                    goodDirection="down"
                  />
                ))}
              </div>
            </DashboardGroup>

            {/* Cost & budget */}
            <DashboardGroup title="Cost & budget" description="LLM spend this window">
              <Card>
                <CardContent className="space-y-4 py-4">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <div className="font-mono text-3xl font-semibold tabular-nums text-foreground">
                        {fmtMoney(usage?.total_cost, usage?.currency)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {typeof usage?.total_tokens === 'number'
                          ? `${fmtTokens(usage.total_tokens)} tokens · ${fmtNumber(
                              usage.call_count,
                            )} calls`
                          : 'No spend recorded'}
                      </div>
                    </div>
                    <CircleDollarSign className="h-8 w-8 text-primary/60" aria-hidden />
                  </div>
                  {navigate ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => navigate('metrics', { tab: 'cost' })}
                    >
                      Open cost ledger
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            </DashboardGroup>
          </div>

          {/* Row C: connector health (source signals) · workload state */}
          <div className="grid gap-6 xl:grid-cols-2">
            {/* Connector / source health — per-source case telemetry */}
            <DashboardGroup
              title="Connector health"
              count={productItems.length}
              description="case telemetry by source"
            >
              <Card>
                <CardContent className="py-4">
                  {productItems.length ? (
                    <BarList items={productItems} showRank showPercent />
                  ) : (
                    <EmptyState
                      compact
                      icon={Plug}
                      title="No source signals"
                      description="Cases will group by their originating source here."
                    />
                  )}
                </CardContent>
              </Card>
            </DashboardGroup>

            {/* Case workload state */}
            <DashboardGroup title="Case workload state" count={workloadItems.length}>
              <Card>
                <CardContent className="py-4">
                  {workloadItems.length ? (
                    <ul className="flex flex-col gap-3.5">
                      {workloadItems.map(({ status, value }) => {
                        const total =
                          workloadItems.reduce((a, w) => a + w.value, 0) || 1;
                        const pct = Math.round((value / total) * 100);
                        const clickable = !!navigate;
                        return (
                          <li key={status}>
                            <button
                              type="button"
                              disabled={!clickable}
                              onClick={
                                clickable
                                  ? () => navigate?.('cases', { status, window: navWindow })
                                  : undefined
                              }
                              className={cn(
                                'block w-full rounded-md text-left',
                                clickable &&
                                  '-mx-1 px-1 py-0.5 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              )}
                              aria-label={clickable ? `View ${humanizeToken(status)} cases` : undefined}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {humanizeToken(status)}
                                </span>
                                <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                                  {fmtNumber(value)}
                                </span>
                              </div>
                              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                <div
                                  className={cn('h-full rounded-full', statusBar(status))}
                                  style={{ width: `${Math.min(100, pct)}%` }}
                                  role="progressbar"
                                  aria-valuenow={pct}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-label={humanizeToken(status)}
                                />
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
            </DashboardGroup>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
