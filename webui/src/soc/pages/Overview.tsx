/**
 * Overview — the Security Command Center (default landing surface).
 *
 * A classy, Prisma-Cloud-style operational dashboard laid out top → bottom:
 *
 *   ┌ MASTHEAD ─── a PLAIN, dense <PageHeader> (no card / no glow — the big title sits
 *   │             flush on the page background, like the Sources page) carrying the
 *   │             <TimeRangePicker> + auto-refresh + a manual refresh pulse + a "Last
 *   │             updated" stamp in its `actions` slot, and an optional SLA chip in `meta`.
 *   ├ KPI STRIP ── a flat, un-nested responsive grid of 5 alert/case signal KpiTiles.
 *   ├ ZONE A ───── the HERO ROW (3 equal cards): the Active Risk Index (#1 — the ONE risk
 *   │             instrument), a "Cases resolved" donut snapshot (center count + trend
 *   │             delta + severity legend), and an "Open cases" donut snapshot.
 *   ├ ZONE B ───── the wide Noise-Suppression ribbon (ingested → clustered → cases →
 *   │             auto_cleared → escalated → closed) — the value-prop headline.
 *   ├ ZONE C ───── three columns: a Cases-burndown (opened vs resolved), a Mean-time-to-
 *   │             detect/respond card (MTTD + first-response p50 + a detect/respond trend
 *   │             with an average reference line), and a Top-open-cases work list.
 *   └ DEEPER ───── a COLLAPSED "Deeper analytics" group folding the secondary bands
 *                  (spend tripwire, full response timing, autonomy split, connectors,
 *                  case-volume, workload, top signatures/entities).
 *
 * Data: `usePosture(hours, 'prev')` is the AUTHORITATIVE server-side lifecycle rollup
 * (MTTA/MTTR/dwell/MTTD p50 + SLA + quality rates + period-over-period deltas).
 * `listCases` (current + previous window), `getMetrics` (burndown + timing_trend +
 * by_status), `usageSummary`, and `noiseReduction` are fetched with allSettled so one
 * failing call degrades a single widget, never the page. `noiseReduction` is typeof-
 * guarded so a minimal test/mock surface simply omits the funnel.
 *
 * Security (#9): every label/value here is a humanized enum, a formatted number, or
 * backend-derived text rendered as PLAIN text. No untrusted string is injected as markup.
 *
 * Advisory (#3): NOTHING on this dashboard feeds `decide()` — it reads the outcome of
 * triage; it never influences close/escalate.
 */
import * as React from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Gauge,
  Inbox,
  Percent,
  Plug,
  Radar,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import { useNavigateOptional, type Navigate } from '@/soc/router';
import { api } from '@/lib/api';
import type { Case, Metrics, NoiseReduction, UsageSummary } from '@/lib/types';
import {
  DASH,
  fmtMoney,
  fmtNumber,
  fmtTokens,
  humanizeAge,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import {
  TimeRangePicker,
  DEFAULT_RANGE,
  resolveRange,
  type TimeRange,
  type RefreshValue,
} from '@/soc/components/TimeRangePicker';
import { DashboardGroup } from '@/soc/components/DashboardGroup';
import { KpiTile, type KpiAccent, type KpiDelta } from '@/soc/components/KpiTile';
import { ActiveRiskIndex } from '@/soc/components/ActiveRiskIndex';
import { NoiseFunnel } from '@/soc/components/NoiseFunnel';
import { Reveal } from '@/soc/components/Reveal';
import { CountUp } from '@/soc/components/CountUp';
import { Stagger } from '@/soc/components/Stagger';
import { DonutChart, TrendArea, type DonutSegment } from '@/soc/components/charts';
import { BurnDownChart, MultiSeriesTrend } from '@/soc/components/charts-soc';
import { token, VERDICT_COLOR } from '@/soc/components/palette';
import { isAutoClosedByAI, severityBand, severityBandFromNumber } from '@/soc/components/badges';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { AutomationNudge } from './AutomationNudge';
import { usePosture } from '@/soc/hooks/usePosture';
import { Card, CardContent } from '@/ui/card';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';

import {
  humanizeMinutes as humanizeMins,
  ratioPct,
  deltaView,
  LIFECYCLE_METRICS,
  type LifecycleMetricKey,
} from './posture.format';
import type { StatBlock } from './Metrics.posture.api';

/**
 * The Overview hero title — the app's white-screen boot guard anchors on it (the
 * smoke test asserts the whole console boots to this string). Exported as a single
 * constant so the title can be reworded here WITHOUT breaking the tests that check
 * "the app booted" (they import this constant rather than hardcoding the copy).
 */
export const PAGE_TITLE = 'Security Command Center';

interface OverviewProps {
  /**
   * Optional drill-through navigation. When omitted (App renders it without a nav
   * prop), it resolves from the router context via `useNavigateOptional()`.
   */
  onNavigate?: Navigate;
}

const OPEN_STATUSES = new Set(['open', 'investigating', 'in_progress', 'new', 'on_hold']);
const CLOSED_STATUSES = new Set(['closed', 'resolved']);

/** Per-browser dismissal flag for the recommended-automation nudge (onboarding). */
const NUDGE_KEY = 'tlsoc.overview.automationNudge';
/** Per-browser hide flag for the Noise-Reduction funnel band (the per-user hide toggle). */
const NOISE_HIDE_KEY = 'tlsoc.overview.noiseFunnelHidden';

/** Format an integer count for a count-up tile (thousands-separated). */
const fmtInt = (n: number): string => fmtNumber(n);

/**
 * Adapt a `deltaView()` result to the KpiTile `delta` prop. Only render a delta when a
 * real comparison exists; the "new growth" case carries a 0 so the tile draws a neutral
 * marker with the "new" label.
 */
function toKpiDelta(dv: ReturnType<typeof deltaView>): KpiDelta | undefined {
  return dv.show ? { value: dv.value ?? 0, label: dv.label } : undefined;
}

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
type SevCounts = Record<SevKey, number>;
const SEV_LABEL: Record<SevKey, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Informational',
};

const emptySev = (): SevCounts => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

/** Normalise a CASE into a severity band, using the SAME preference order as the Cases
 *  severity FILTER: prefer the source-asserted advisory `severity_band`, then fall back
 *  to the deterministic `risk_score` on the ONE SEVERITY authority (badges.ts). */
function bandOfCase(k: Case): SevKey {
  const explicit = severityBand(k.severity_band);
  if (explicit) return explicit;
  const s = typeof k.risk_score === 'number' && Number.isFinite(k.risk_score) ? k.risk_score : 0;
  return severityBandFromNumber(s);
}

/** Severity-band donut segments (highest → lowest), coloured from the severity axis. */
function sevSegments(counts: SevCounts): DonutSegment[] {
  return SEV_ORDER.map((s) => ({ label: SEV_LABEL[s], value: counts[s], color: token(s) })).filter(
    (seg) => seg.value > 0,
  );
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

/** A compact, honest label for the selected window ("24 hours" / "7 days"). */
function windowLabel(hours: number): string {
  if (hours % 24 === 0) {
    const d = hours / 24;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** A period-over-period percent delta from two raw counts, or null when there is no
 *  honest baseline (no previous window, prev == 0, or an exactly-flat move). */
function countDelta(cur: number, prev: number | null): { value: number; label: string } | null {
  if (prev == null || prev <= 0) return null;
  const rounded = Math.round(((cur - prev) / prev) * 1000) / 10;
  if (rounded === 0) return null;
  const sign = rounded > 0 ? '+' : '';
  return { value: rounded, label: `${sign}${rounded}%` };
}

/** One KPI-strip tile descriptor (built in a memo, rendered as a <KpiTile>). */
interface KpiItem {
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon: LucideIcon;
  accent: KpiAccent;
  goodDirection: 'up' | 'down' | 'none';
  onClick?: () => void;
  delta?: KpiDelta;
  countTo?: number;
  format?: (n: number) => string;
}

/* ------------------------------------------------------------------------- */
/* Small presentation helpers (module-level, pure).                           */
/* ------------------------------------------------------------------------- */

/** A signed trend chip: the ARROW follows the true direction of change, the COLOR
 *  follows judgement (`goodDirection`). Plain text; the accessible label announces both. */
function TrendChip({
  delta,
  goodDirection,
}: {
  delta: { value: number; label: string } | null;
  goodDirection: 'up' | 'down';
}) {
  if (!delta) return null;
  const rising = delta.value >= 0;
  const improved = goodDirection === 'up' ? rising : !rising;
  const Arrow = rising ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      role="img"
      aria-label={`changed ${rising ? 'up' : 'down'} by ${delta.label}, ${
        improved ? 'improved' : 'worse'
      }`}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-2xs font-semibold tabular-nums',
        improved
          ? 'border-success/30 bg-success/10 text-success-text'
          : 'border-critical/30 bg-critical/10 text-critical-text',
      )}
    >
      <Arrow className="h-3 w-3" aria-hidden />
      <span aria-hidden>{delta.label}</span>
    </span>
  );
}

/**
 * A hero DONUT snapshot card: a big center count + a period-over-period trend chip and a
 * per-severity legend beside a refined ring. The section heading is an `<h2>` (the hero
 * cards carry the first headings under the page `<h1>`, so the outline stays valid).
 */
function SnapshotCard({
  title,
  caption,
  total,
  delta,
  goodDirection,
  counts,
  ariaLabel,
  ctaLabel,
  onClick,
}: {
  title: string;
  caption: string;
  total: number;
  delta: { value: number; label: string } | null;
  goodDirection: 'up' | 'down';
  counts: SevCounts;
  ariaLabel: string;
  ctaLabel: string;
  onClick?: () => void;
}) {
  const segments = sevSegments(counts);
  const legend = SEV_ORDER.map((s) => ({ key: s, value: counts[s] })).filter((r) => r.value > 0);
  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2 px-5 pt-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="text-2xs text-muted-foreground">{caption}</p>
        </div>
        <TrendChip delta={delta} goodDirection={goodDirection} />
      </div>
      <CardContent className="flex flex-1 flex-col items-center gap-4 px-5 py-4 sm:flex-row">
        {segments.length ? (
          <DonutChart
            segments={segments}
            height={136}
            thickness={0.44}
            className="w-full shrink-0 sm:w-36"
            ariaLabel={ariaLabel}
            center={
              <>
                <CountUp
                  value={total}
                  format={fmtInt}
                  className="font-mono text-3xl font-semibold tabular-nums text-foreground"
                />
                <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                  {title}
                </span>
              </>
            }
          />
        ) : (
          <div
            role="img"
            aria-label={`${ariaLabel} (none)`}
            className="flex h-[136px] w-full flex-col items-center justify-center gap-0.5 sm:w-36"
          >
            <span className="font-mono text-3xl font-semibold tabular-nums text-muted-foreground">
              0
            </span>
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">{title}</span>
          </div>
        )}
        <ul className="w-full space-y-1.5">
          {legend.length ? (
            legend.map((r) => {
              const pct = total > 0 ? Math.round((r.value / total) * 100) : 0;
              return (
                <li key={r.key} className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: token(r.key) }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {SEV_LABEL[r.key]}
                  </span>
                  <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                    {fmtNumber(r.value)}
                  </span>
                  <span className="w-8 text-right font-mono text-2xs tabular-nums text-muted-foreground">
                    {pct}%
                  </span>
                </li>
              );
            })
          ) : (
            <li className="text-xs text-muted-foreground">No cases in this window.</li>
          )}
        </ul>
      </CardContent>
      {onClick ? (
        <div className="px-5 pb-4">
          <Button variant="outline" size="sm" className="w-full" onClick={onClick}>
            {ctaLabel}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** One p50 lifecycle-timing stat block: value or an honest "not measured" DASH + reason. */
function TimingStat({
  label,
  sub,
  block,
  dotClass,
  help,
}: {
  label: string;
  sub: string;
  block: StatBlock | undefined;
  dotClass: string;
  help?: string;
}) {
  const available = block?.available === true;
  const value = available ? humanizeMins(block!.p50) : DASH;
  const detail = available
    ? `p50 · ${fmtNumber(block!.count)} sample${block!.count === 1 ? '' : 's'}`
    : block?.reason || 'not measured (n/a)';
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5" title={help}>
      <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} aria-hidden />
        {label}
      </div>
      <div className="mt-1 font-mono text-2xl font-semibold leading-none tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1 text-2xs text-muted-foreground">{sub}</div>
      <div className="text-2xs text-muted-foreground/80">{detail}</div>
    </div>
  );
}

export default function Overview({ onNavigate }: OverviewProps) {
  // Navigation seam: an explicit prop (host/test) wins; otherwise resolve from the
  // router context (no-op when rendered provider-less in a unit test).
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;

  // ----- Time range + auto-refresh (the CONTROL BAR state) ---------------- //
  const [range, setRange] = React.useState<TimeRange>(DEFAULT_RANGE);
  const [refresh, setRefresh] = React.useState<RefreshValue>('off');
  const hours = React.useMemo(() => rangeHours(range), [range]);
  /** The `window` (hours) carried on every drill-through so the case list matches. */
  const navWindow = hours;

  // ----- Dashboard data loads --------------------------------------------- //
  const [cases, setCases] = React.useState<Case[]>([]);
  const [prevCases, setPrevCases] = React.useState<Case[] | null>(null);
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [usage, setUsage] = React.useState<UsageSummary | null>(null);
  const [noise, setNoise] = React.useState<NoiseReduction | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [lastRefreshMs, setLastRefreshMs] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The Noise-Reduction funnel is typeof-guarded so a minimal test/mock surface
      // (no `noiseReduction`) simply resolves null and the funnel band self-omits.
      const noiseP: Promise<NoiseReduction | null> =
        typeof api.noiseReduction === 'function'
          ? api.noiseReduction(hours)
          : Promise.resolve(null);
      const [c, m, u, n, pc] = await Promise.allSettled([
        // #37: window the current case sample by created-at so the case-derived widgets
        // honour the range (backend caps at 200 by created-desc).
        api.listCases({ limit: 200, from: `now-${hours}h` }),
        api.getMetrics(hours),
        api.usageSummary(hours),
        noiseP,
        // The immediately-preceding equal window — powers the honest open/resolved
        // snapshot trend deltas (omitted gracefully when the fetch fails).
        api.listCases({ limit: 200, from: `now-${2 * hours}h`, to: `now-${hours}h` }),
      ]);
      if (c.status === 'fulfilled') setCases(c.value.cases ?? []);
      if (m.status === 'fulfilled') setMetrics(m.value);
      if (u.status === 'fulfilled') setUsage(u.value);
      if (n.status === 'fulfilled') setNoise(n.value ?? null);
      setPrevCases(pc.status === 'fulfilled' ? pc.value.cases ?? [] : null);
      // Only surface a page-level error if the load is wholly empty.
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

  // Server-side posture rollup — the AUTHORITATIVE lifecycle (MTTA/MTTR/dwell/MTTD p50 +
  // SLA + quality rates). `'prev'` also asks for the period-over-period `compare` block.
  const { data: posture, reload: reloadPosture } = usePosture(hours, 'prev');

  /** One refresh pulse for the whole dashboard (control-bar button + auto-refresh tick). */
  const refreshAll = React.useCallback(() => {
    void load();
    void reloadPosture();
  }, [load, reloadPosture]);

  // ----- Noise-Reduction funnel: per-user hide toggle (persisted) --------- //
  const [noiseHidden, setNoiseHidden] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(NOISE_HIDE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleNoiseHidden = React.useCallback(() => {
    setNoiseHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem(NOISE_HIDE_KEY, next ? '1' : '0');
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  }, []);

  // ----- Recommended-automation nudge (onboarding-beginner) --------------- //
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

  // ----- Derived case-shape breakdowns ------------------------------------ //
  const derived = React.useMemo(() => {
    let open = 0;
    let resolved = 0;
    let critical = 0;
    let criticalHighAlerts = 0;
    const sevCounts = emptySev();
    const openSev = emptySev();
    const resolvedSev = emptySev();
    const productCounts: Record<string, number> = {};

    for (const k of cases) {
      const st = (k.status || '').toLowerCase();
      const isOpen = OPEN_STATUSES.has(st);
      const isClosed = CLOSED_STATUSES.has(st);
      if (isOpen) open += 1;
      if (isClosed) resolved += 1;

      const band = bandOfCase(k);
      sevCounts[band] += 1;
      if (isOpen) openSev[band] += 1;
      if (isClosed) resolvedSev[band] += 1;
      if (band === 'critical') critical += 1;
      if (band === 'critical' || band === 'high') criticalHighAlerts += 1;

      const product = k.source_name || k.source_id || 'Unattributed';
      productCounts[product] = (productCounts[product] ?? 0) + 1;
    }

    return { open, resolved, critical, criticalHighAlerts, sevCounts, openSev, resolvedSev, productCounts };
  }, [cases]);

  // Previous-window open/resolved counts (for the snapshot trend deltas). null when the
  // prev-window fetch was unavailable → the snapshots simply omit their delta chips.
  const prev = React.useMemo(() => {
    if (!prevCases) return null;
    let open = 0;
    let resolved = 0;
    for (const k of prevCases) {
      const st = (k.status || '').toLowerCase();
      if (OPEN_STATUSES.has(st)) open += 1;
      else if (CLOSED_STATUSES.has(st)) resolved += 1;
    }
    return { open, resolved };
  }, [prevCases]);

  // ----- Autonomous-vs-human split (#3 trust surface) --------------------- //
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
      };
    }
    let autoClosed = 0;
    let escalated = 0;
    for (const k of cases) {
      const st = (k.status || '').toLowerCase();
      if (st === 'needs_human' || st === 'escalated') escalated += 1;
      else if (isAutoClosedByAI(k.status, k.decision_by)) autoClosed += 1;
    }
    const total = autoClosed + escalated;
    return { autoClosed, escalated, automationPct: total ? autoClosed / total : 0 };
  }, [posture, cases]);

  // ----- Full response-timing trio (server posture) — Deeper analytics ---- //
  const timing = React.useMemo(() => {
    const life = posture?.lifecycle;
    const block = (
      metric: LifecycleMetricKey,
      statKey: 'dwell_minutes' | 'mtta_minutes' | 'mttr_minutes',
      accent: KpiAccent,
    ) => {
      const b = life?.[statKey];
      const copy = LIFECYCLE_METRICS[metric];
      return {
        label: copy.label,
        help: copy.help,
        value: b && b.available ? humanizeMins(b.p50) : DASH,
        sub:
          b && b.available
            ? `p50 · ${fmtNumber(b.count)} sample${b.count === 1 ? '' : 's'}`
            : b?.reason || 'no samples yet',
        accent,
      };
    };
    return [
      block('mtta', 'mtta_minutes', 'medium'),
      block('mttr', 'mttr_minutes', 'success'),
      block('dwell', 'dwell_minutes', 'info'),
    ];
  }, [posture]);

  // Detect / first-response headline stat blocks (the Zone-C timing card).
  const mttdBlock = posture?.lifecycle?.mttd_minutes;
  const respondBlock = posture?.lifecycle?.dwell_minutes;

  // Detect / respond trend series + the mean-respond reference line.
  const timingTrend = React.useMemo(
    () =>
      (metrics?.timing_trend ?? []).map((p) => ({
        x: p.date,
        mttd: p.mttd,
        respond: p.respond,
      })),
    [metrics],
  );
  const avgRespond = React.useMemo(() => {
    const vals = (metrics?.timing_trend ?? [])
      .map((p) => p.respond)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (!vals.length) return undefined;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [metrics]);

  // Burn-down (opened vs resolved) series for the Zone-C burndown chart.
  const burndownData = React.useMemo(
    () => (metrics?.burndown ?? []).map((p) => ({ x: p.date, open: p.opened, closed: p.resolved })),
    [metrics],
  );

  // SLA posture (server-side, advisory). null when the policy is off / unavailable.
  const slaPosture = React.useMemo(() => {
    const sla = posture?.sla;
    if (!sla || !sla.enabled) return null;
    const atRisk = (sla.response_at_risk ?? 0) + (sla.resolve_at_risk ?? 0);
    const breached = (sla.response_breached ?? 0) + (sla.resolve_breached ?? 0);
    return { atRisk, breached, attainment: sla.attainment_pct ?? 0 };
  }, [posture]);

  // ----- Active Risk Index (#1) ------------------------------------------- //
  const activeRisk = React.useMemo<{ score: number | null; count: number }>(() => {
    if (
      typeof metrics?.active_risk_index === 'number' &&
      Number.isFinite(metrics.active_risk_index)
    ) {
      return {
        score: Math.round(metrics.active_risk_index),
        count: metrics.active_risk_case_count ?? derived.open,
      };
    }
    const openCases = cases.filter((k) => OPEN_STATUSES.has((k.status || '').toLowerCase()));
    if (openCases.length) {
      const mean = openCases.reduce((a, k) => a + (k.risk_score ?? 0), 0) / openCases.length;
      return { score: Math.round(mean), count: openCases.length };
    }
    const avg = metrics?.avg_risk_score;
    return {
      score: typeof avg === 'number' && Number.isFinite(avg) ? Math.round(avg) : null,
      count: 0,
    };
  }, [metrics, cases, derived.open]);

  // ----- Top OPEN cases by priority (risk desc) — the Zone-C work list ----- //
  const topCases = React.useMemo(
    () =>
      cases
        .filter((k) => OPEN_STATUSES.has((k.status || '').toLowerCase()))
        .sort((a, b) => (b.risk_score ?? 0) - (a.risk_score ?? 0))
        .slice(0, 5),
    [cases],
  );

  // ----- BarList datasets (Deeper analytics) ------------------------------ //
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

  const signatureItems: BarListItem[] = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of cases) {
      const label =
        (k.title || k.cluster_signature || k.rule_ids?.[0] || 'Uncategorized').trim() ||
        'Uncategorized';
      counts[label] = (counts[label] ?? 0) + 1;
    }
    const total = cases.length || 1;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label, value, sub: `${Math.round((value / total) * 100)}% of cases` }));
  }, [cases]);

  const entityItems: BarListItem[] = React.useMemo(() => {
    const counts: Record<string, { value: number; type: string }> = {};
    for (const k of cases) {
      const v = k.entity?.value;
      if (!v) continue;
      const type = k.entity?.type || k.entity_type || 'entity';
      const key = String(v);
      if (!counts[key]) counts[key] = { value: 0, type };
      counts[key].value += 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1].value - a[1].value)
      .slice(0, 8)
      .map(([label, info]) => ({ label, value: info.value, sub: humanizeToken(info.type) }));
  }, [cases]);

  // ----- Case outcomes (verdict mix) — Deeper analytics ------------------- //
  const verdictMix = React.useMemo<{ segments: DonutSegment[]; total: number }>(() => {
    const bv = metrics?.by_verdict;
    const src: Record<string, number> = bv
      ? {
          TRUE_POSITIVE: bv.TRUE_POSITIVE ?? 0,
          NEEDS_HUMAN: bv.NEEDS_HUMAN ?? 0,
          FALSE_POSITIVE: bv.FALSE_POSITIVE ?? 0,
          none: bv.none ?? 0,
        }
      : cases.reduce<Record<string, number>>((acc, k) => {
          const v = (k.verdict || 'none').toUpperCase();
          const key =
            v === 'TRUE_POSITIVE' || v === 'FALSE_POSITIVE' || v === 'NEEDS_HUMAN' ? v : 'none';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {});
    const defs: Array<{ key: string; label: string; colorName: string }> = [
      { key: 'TRUE_POSITIVE', label: 'True positive', colorName: VERDICT_COLOR.true_positive },
      { key: 'NEEDS_HUMAN', label: 'Needs human', colorName: VERDICT_COLOR.needs_human },
      { key: 'FALSE_POSITIVE', label: 'False positive', colorName: VERDICT_COLOR.false_positive },
      { key: 'none', label: 'Unverdicted', colorName: 'muted' },
    ];
    const segments = defs
      .map((d) => ({ label: d.label, value: src[d.key] ?? 0, color: token(d.colorName) }))
      .filter((s) => s.value > 0);
    const total = segments.reduce((a, s) => a + s.value, 0);
    return { segments, total };
  }, [metrics, cases]);

  const caseVolume = React.useMemo(
    () => (metrics?.cases_per_day ?? []).map((d) => ({ x: d.date, y: d.count })),
    [metrics],
  );

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
    return source.sort((a, b) => b[1] - a[1]).map(([status, value]) => ({ status, value }));
  }, [metrics, cases]);

  // ----- KPI micro-strip — 5 alert/case signal tiles --------------------- //
  const kpis: KpiItem[] = React.useMemo(() => {
    const compare = posture?.compare;
    const fpRate = posture?.quality?.false_positive_rate;
    const autoResolved = posture?.quality?.auto_closed_cases ?? autonomy.autoClosed;
    const escalated = metrics?.needs_human_cases ?? autonomy.escalated;
    return [
      {
        label: 'Open Cases',
        value: fmtNumber(derived.open),
        countTo: derived.open,
        format: fmtInt,
        sub: `${fmtNumber(cases.length)} cases tracked`,
        icon: Inbox,
        accent: 'critical',
        goodDirection: 'down',
        onClick: navigate ? () => navigate('cases', { status: 'open', window: navWindow }) : undefined,
      },
      {
        label: 'Critical / High',
        value: fmtNumber(derived.criticalHighAlerts),
        countTo: derived.criticalHighAlerts,
        format: fmtInt,
        sub: `${fmtNumber(derived.critical)} critical observed`,
        icon: ShieldAlert,
        accent: 'high',
        goodDirection: 'down',
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
        value: fmtNumber(escalated),
        countTo: escalated,
        format: fmtInt,
        sub: 'Awaiting analyst review',
        icon: Workflow,
        accent: 'low',
        goodDirection: 'down',
        onClick: navigate
          ? () => navigate('cases', { status: 'needs_human', window: navWindow })
          : undefined,
      },
      {
        label: 'False Positive Rate',
        value: ratioPct(fpRate),
        sub: 'Cases closed as false positives',
        icon: Percent,
        accent: 'medium',
        goodDirection: 'down',
        delta: toKpiDelta(deltaView(compare?.false_positive_rate)),
        onClick: navigate ? () => navigate('metrics', { tab: 'posture' }) : undefined,
      },
      {
        label: 'Auto-Resolved',
        value: fmtNumber(autoResolved),
        countTo: autoResolved,
        format: fmtInt,
        sub: 'Closed autonomously by the agent',
        icon: ShieldCheck,
        accent: 'success',
        goodDirection: 'up',
        onClick: navigate
          ? () => navigate('cases', { status: 'closed', window: navWindow })
          : undefined,
      },
    ];
  }, [derived, metrics, cases.length, navWindow, autonomy.escalated, autonomy.autoClosed, posture, navigate]);

  // ----- Noise-Reduction funnel drill-through ----------------------------- //
  const onStageClick = React.useCallback(
    (key: string) => {
      if (!navigate) return;
      switch (key) {
        case 'escalated':
          navigate('cases', { status: 'escalated', window: navWindow });
          break;
        case 'auto_cleared':
        case 'closed':
          navigate('cases', { status: 'closed', window: navWindow });
          break;
        default:
          navigate('cases', { window: navWindow });
      }
    },
    [navigate, navWindow],
  );

  // ----- The header control cluster --------------------------------------- //
  const lastUpdated = lastRefreshMs ? humanizeAge(new Date(lastRefreshMs).toISOString()) : null;
  const headerControls = (
    <>
      {lastUpdated ? (
        <span className="hidden text-2xs text-muted-foreground sm:inline" data-testid="last-updated">
          Updated {lastUpdated}
        </span>
      ) : null}
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
  );

  // ----- Loading skeleton (mirrors the final dense layout in lockstep) ---- //
  if (loading && !cases.length && !metrics) {
    return (
      <PageContainer variant="wide">
        <div className="space-y-4" aria-busy="true" aria-label="Loading dashboard">
          <Skeleton className="h-14 w-full rounded-lg" />
          <div
            data-testid="kpi-strip-skeleton"
            className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-lg" />
            ))}
          </div>
          <div data-testid="hero-skeleton-row" className="grid gap-4 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-56 rounded-lg" />
            ))}
          </div>
          <Skeleton data-testid="noise-skeleton-row" className="h-56 w-full rounded-lg" />
          <div data-testid="zonec-skeleton-row" className="grid gap-4 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-72 rounded-lg" />
            ))}
          </div>
          <Skeleton data-testid="deeper-analytics-skeleton" className="h-9 w-64 rounded-md" />
        </div>
      </PageContainer>
    );
  }

  const empty = !loading && !error && cases.length === 0 && !metrics?.total_cases;

  return (
    <PageContainer variant="wide" className="space-y-4">
      {/* ---- MASTHEAD: a PLAIN, dense header (the big title sits flush on the page
             background, like the Sources page) with the time-range + refresh controls in
             its `actions` slot and an optional SLA chip in `meta`. ---- */}
      <PageHeader
        data-testid="page-hero"
        icon={Radar}
        title={PAGE_TITLE}
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
        actions={headerControls}
      />

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
        <LoadError error={error} title="Could not load the dashboard" onRetry={refreshAll} />
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
        <div className="animate-fade-in space-y-4">
          {/* ---- KPI STRIP — flat, un-nested, responsive by COLUMN COUNT ---- */}
          <div className="space-y-1.5">
            <Stagger
              data-testid="kpi-strip"
              className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
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
                  delta={kpi.delta}
                  countTo={kpi.countTo}
                  format={kpi.format}
                  onClick={kpi.onClick}
                />
              ))}
            </Stagger>
            {posture?.compare ? (
              <p className="px-0.5 text-2xs text-muted-foreground">
                Deltas compare the previous {windowLabel(hours)}.
              </p>
            ) : null}
          </div>

          {/* ---- ZONE A: HERO ROW — Active Risk Index + two donut snapshots ---- */}
          <Reveal
            variant="rise"
            delay={40}
            data-testid="hero-row"
            className="grid items-stretch gap-4 lg:grid-cols-3"
          >
            <ActiveRiskIndex
              score={activeRisk.score}
              count={activeRisk.count}
              size={160}
              className="h-full w-full"
            />
            <SnapshotCard
              title="Cases resolved"
              caption={`Closed in the last ${windowLabel(hours)}`}
              total={derived.resolved}
              delta={countDelta(derived.resolved, prev?.resolved ?? null)}
              goodDirection="up"
              counts={derived.resolvedSev}
              ariaLabel="Resolved cases by severity"
              ctaLabel="View resolved cases"
              onClick={navigate ? () => navigate('cases', { status: 'closed', window: navWindow }) : undefined}
            />
            <SnapshotCard
              title="Open cases"
              caption={`Still open from the last ${windowLabel(hours)}`}
              total={derived.open}
              delta={countDelta(derived.open, prev?.open ?? null)}
              goodDirection="down"
              counts={derived.openSev}
              ariaLabel="Open cases by severity"
              ctaLabel="View open cases"
              onClick={navigate ? () => navigate('cases', { status: 'open', window: navWindow }) : undefined}
            />
          </Reveal>

          {/* ---- ZONE B: Noise-Suppression ribbon — the value-prop headline ---- */}
          {noise ? (
            <Reveal variant="rise" delay={70}>
              <NoiseFunnel
                data={noise}
                onStageClick={onStageClick}
                hidden={noiseHidden}
                onToggleHidden={toggleNoiseHidden}
                className="w-full"
              />
            </Reveal>
          ) : null}

          {/* ---- ZONE C: burndown · detect/respond · top cases ---- */}
          <Reveal variant="rise" delay={90} className="grid gap-4 xl:grid-cols-3">
            {/* Cases burndown */}
            <DashboardGroup title="Cases burndown" description="opened vs resolved over time">
              <Card>
                <CardContent className="py-4">
                  <BurnDownChart
                    data={burndownData}
                    height={224}
                    openLabel="Opened"
                    closedLabel="Resolved"
                    format={fmtInt}
                    ariaLabel="Cases opened vs resolved over time"
                  />
                </CardContent>
              </Card>
            </DashboardGroup>

            {/* Mean time to detect / respond */}
            <DashboardGroup
              title="Mean time to detect / respond"
              description="p50 · server-computed"
              actions={
                navigate ? (
                  <Button variant="ghost" size="sm" onClick={() => navigate('metrics', { tab: 'posture' })}>
                    Detail →
                  </Button>
                ) : undefined
              }
            >
              <Card>
                <CardContent className="space-y-4 py-4">
                  <div className="grid grid-cols-2 gap-3">
                    <TimingStat
                      label="MTTD"
                      sub="Detect · log arrival → case"
                      block={mttdBlock}
                      dotClass="bg-info"
                      help="Mean time to detect: the cluster's first event → case-open. Shown as an honest n/a when no case carries a first-event instant."
                    />
                    <TimingStat
                      label="Respond"
                      sub="First human action e.g. assignment / ack"
                      block={respondBlock}
                      dotClass="bg-success"
                      help="Mean time to respond — the first active human response (investigating / escalated / assignment / ack)."
                    />
                  </div>
                  <MultiSeriesTrend
                    data={timingTrend}
                    series={[
                      { key: 'mttd', label: 'Detect' },
                      { key: 'respond', label: 'Respond' },
                    ]}
                    height={168}
                    format={humanizeMins}
                    referenceY={avgRespond}
                    referenceLabel={avgRespond != null ? `avg ${humanizeMins(avgRespond)}` : undefined}
                    ariaLabel="Detect and respond latency over time"
                  />
                </CardContent>
              </Card>
            </DashboardGroup>

            {/* Top open cases */}
            <DashboardGroup title="Top open cases" count={topCases.length} description="by risk">
              <Card>
                <CardContent className="space-y-3 py-3">
                  {topCases.length ? (
                    <ul className="flex flex-col divide-y divide-border">
                      {topCases.map((k) => {
                        const band = bandOfCase(k);
                        const displayTitle =
                          (k.title || k.cluster_signature || k.case_number || k.case_id || '').trim() ||
                          'Untitled case';
                        const src = k.source_name || k.source_id || 'Unknown source';
                        const age = humanizeAge(k.created_at);
                        const risk = Math.round(
                          typeof k.risk_score === 'number' && Number.isFinite(k.risk_score)
                            ? k.risk_score
                            : 0,
                        );
                        const statusText = humanizeToken(k.status || 'open');
                        const clickable = !!navigate;
                        return (
                          <li key={k.case_id}>
                            <button
                              type="button"
                              disabled={!clickable}
                              onClick={
                                clickable
                                  ? () => navigate('cases', { caseId: k.case_id, window: navWindow })
                                  : undefined
                              }
                              className={cn(
                                'flex w-full items-center gap-2.5 py-2 text-left',
                                clickable &&
                                  '-mx-1 rounded-md px-1 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              )}
                              aria-label={clickable ? `Open case ${displayTitle}` : undefined}
                            >
                              <span
                                className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: token(band) }}
                                aria-hidden
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-foreground">
                                  {displayTitle}
                                </span>
                                <span className="block truncate text-2xs text-muted-foreground">
                                  {SEV_LABEL[band]} · {statusText} · {src}
                                  {age ? ` · ${age}` : ''}
                                </span>
                              </span>
                              <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-foreground">
                                {risk}
                              </span>
                              {clickable ? (
                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <EmptyState
                      compact
                      icon={Inbox}
                      title="Queue clear"
                      description="No open cases in this window."
                    />
                  )}
                  {navigate ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => navigate('cases', { status: 'needs_human', window: navWindow })}
                    >
                      {slaPosture && (slaPosture.breached > 0 || slaPosture.atRisk > 0)
                        ? `Review escalations · ${fmtNumber(slaPosture.breached)} breached · ${fmtNumber(slaPosture.atRisk)} at risk`
                        : 'Review escalations'}
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            </DashboardGroup>
          </Reveal>

          {/* ---- DEEPER ANALYTICS (collapsed by default) ---- */}
          <DashboardGroup
            title="Deeper analytics"
            defaultOpen={false}
            description="timing, autonomy, cost, volume, connectors & workload"
            contentClassName="space-y-4"
          >
            {/* Full response timing (MTTA · MTTR · Dwell) + spend tripwire */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                  help={s.help}
                />
              ))}
              <KpiTile
                variant="bar"
                testId="llm-spend-detail"
                label="LLM spend"
                value={fmtMoney(usage?.total_cost, usage?.currency)}
                sub={
                  typeof usage?.total_tokens === 'number'
                    ? `${fmtTokens(usage.total_tokens)} tokens · ${fmtNumber(usage.call_count)} calls`
                    : 'No spend recorded'
                }
                icon={CircleDollarSign}
                accent="primary"
                goodDirection="down"
                onClick={navigate ? () => navigate('metrics', { tab: 'cost' }) : undefined}
              />
            </div>

            {/* Autonomy split (#3) · connector health */}
            <Reveal variant="rise" className="grid gap-4 xl:grid-cols-2">
              <DashboardGroup title="Autonomous vs human" description="how cases were resolved">
                <Card>
                  <CardContent className="space-y-4 py-4">
                    <div className="flex items-center justify-center gap-2 text-4xl font-semibold tabular-nums">
                      <ShieldCheck className="h-7 w-7 text-success" aria-hidden />
                      <span className="text-foreground">{ratioPct(autonomy.automationPct)}</span>
                    </div>
                    <p className="text-center text-xs text-muted-foreground">
                      resolved autonomously by the agent
                    </p>
                    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-success"
                        style={{
                          width: `${Math.round(
                            (autonomy.autoClosed / (autonomy.autoClosed + autonomy.escalated || 1)) * 100,
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
            </Reveal>

            {/* Case-volume trend · workload state */}
            <Reveal variant="rise" className="grid gap-4 xl:grid-cols-2">
              <DashboardGroup title="Case volume" description="cases opened over time">
                <Card>
                  <CardContent className="py-4">
                    <TrendArea
                      data={caseVolume}
                      height={180}
                      colorToken="primary"
                      format={(n) => fmtNumber(n)}
                      ariaLabel="Case volume over time"
                    />
                  </CardContent>
                </Card>
              </DashboardGroup>

              <DashboardGroup title="Case workload state" count={workloadItems.length}>
                <Card>
                  <CardContent className="py-4">
                    {workloadItems.length ? (
                      <ul className="flex flex-col gap-3.5">
                        {workloadItems.map(({ status, value }) => {
                          const total = workloadItems.reduce((a, w) => a + w.value, 0) || 1;
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
            </Reveal>

            {/* Case outcomes (verdict mix) · top signatures · top entities */}
            <Reveal variant="rise" className="grid gap-4 xl:grid-cols-3">
              <DashboardGroup title="Case outcomes" count={verdictMix.total} description="verdict mix">
                <Card>
                  <CardContent className="py-4">
                    {verdictMix.total > 0 ? (
                      <div className="flex flex-col items-center gap-4 sm:flex-row">
                        <DonutChart
                          segments={verdictMix.segments}
                          height={150}
                          className="w-full shrink-0 sm:w-36"
                          ariaLabel="Case outcomes by verdict"
                          center={
                            <>
                              <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                                {fmtNumber(verdictMix.total)}
                              </span>
                              <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                                verdicts
                              </span>
                            </>
                          }
                        />
                        <ul className="w-full space-y-2">
                          {verdictMix.segments.map((s) => {
                            const pct = Math.round((s.value / verdictMix.total) * 100);
                            return (
                              <li key={s.label} className="flex items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: s.color }}
                                  aria-hidden
                                />
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                  {s.label}
                                </span>
                                <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                                  {fmtNumber(s.value)}
                                </span>
                                <span className="w-9 text-right font-mono text-2xs tabular-nums text-muted-foreground">
                                  {pct}%
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : (
                      <EmptyState
                        compact
                        icon={ShieldCheck}
                        title="No verdicts yet"
                        description="The agent's verdict mix will appear here as cases are triaged."
                      />
                    )}
                  </CardContent>
                </Card>
              </DashboardGroup>

              <DashboardGroup
                title="Top signatures"
                count={signatureItems.length}
                description="most frequent detections"
              >
                <Card>
                  <CardContent className="py-4">
                    <BarList items={signatureItems} showRank showPercent emptyLabel="No signatures yet" />
                  </CardContent>
                </Card>
              </DashboardGroup>

              <DashboardGroup
                title="Top entities"
                count={entityItems.length}
                description="most-implicated assets"
              >
                <Card>
                  <CardContent className="py-4">
                    <BarList items={entityItems} showRank showPercent emptyLabel="No entities yet" />
                  </CardContent>
                </Card>
              </DashboardGroup>
            </Reveal>
          </DashboardGroup>
        </div>
      )}
    </PageContainer>
  );
}
