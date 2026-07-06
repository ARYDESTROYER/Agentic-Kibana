/**
 * Overview — the Security Command Center (default landing surface).
 *
 * Round-5 Dash-A/Dash-B rework + Round-7 W1.A command-center integration: a DENSE,
 * three-zone operational dashboard that uses ultrawide real estate instead of a
 * marketing hero over a crammed nested grid.
 *
 *   ┌ MASTHEAD ─ a PLAIN, dense <PageHeader> (no card / no glow — the big title sits flush
 *   │           on the page background, like the Sources page, #7) on the left, carrying the
 *   │           <TimeRangePicker> (relative ES date-math) + auto-refresh (default Off,
 *   │           cost-metered) + a manual refresh pulse in its `actions` slot; the Active Risk
 *   │           Index (#1 — the ONE risk instrument, in its OWN bordered card, gauge size
 *   │           128) is pinned top-right. There is NO second control band.
 *   ├ KPI STRIP ─── a flat, un-nested responsive grid of ~5 signal + spend KpiTiles, each
 *   │               with the correct `goodDirection`, a count-up on the integer tiles, and
 *   │               a period-over-period delta wired from the server `posture.compare`.
 *   └ WIDGET GRID ─ the wide Noise-Reduction ribbon on top (the value-prop headline), then
 *                   the leading bands (severity mix, attention queue) open, with the rest
 *                   (autonomous-vs-human split [#3 trust surface], timing, case-volume trend,
 *                   connector health, workload, top signatures/entities) folded into ONE
 *                   "Deeper analytics" <DashboardGroup> COLLAPSED by default (#4 — an
 *                   inverted-pyramid landing view).
 *
 * Data: `usePosture(hours, 'prev')` is the AUTHORITATIVE server-side lifecycle rollup
 * (MTTA/MTTR/dwell p50 + SLA + quality rates + period-over-period `compare` deltas). The
 * old ~120 lines of client-side timing math that shadowed it are GONE. `listCases` /
 * `getMetrics` / `usageSummary` / `noiseReduction` are fetched with allSettled so one
 * failing call degrades a single widget, never the page. `noiseReduction` is typeof-guarded
 * so a minimal test/mock surface simply omits the funnel.
 *
 * Security (#9): every label/value here is a humanized enum, a formatted number, or
 * backend-derived text rendered as PLAIN text (BarList labels, source/signature/entity
 * names). No untrusted string is ever injected as markup.
 *
 * Advisory (#3): NOTHING on this dashboard feeds `decide()` — it reads the outcome of
 * triage; it never influences close/escalate.
 */
import * as React from 'react';
import {
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
  Timer,
  Workflow,
} from 'lucide-react';

import { useNavigateOptional, type Navigate } from '@/soc/router';
import { api } from '@/lib/api';
import type {
  Case,
  Metrics,
  NoiseReduction,
  UsageSummary,
} from '@/lib/types';
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
import { DonutChart, TrendArea, type DonutSegment } from '@/soc/components/charts';
import { token, VERDICT_COLOR } from '@/soc/components/palette';
import { isAutoClosedByAI, severityBand, severityBandFromNumber } from '@/soc/components/badges';
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

import {
  humanizeMinutes as humanizeMins,
  ratioPct,
  deltaView,
  LIFECYCLE_METRICS,
  type LifecycleMetricKey,
} from './posture.format';

/**
 * The Overview hero title — the app's white-screen boot guard anchors on it (the
 * smoke test asserts the whole console boots to this string). Exported as a single
 * constant so the title can be reworded here WITHOUT breaking the tests that check
 * "the app booted" (they import this constant rather than hardcoding the copy).
 */
export const PAGE_TITLE = 'Security Command Center';

interface OverviewProps {
  /**
   * Optional drill-through navigation (KPI / workload rows seed a status filter + the
   * window). When omitted (App renders it without a nav prop), it resolves from the
   * router context via `useNavigateOptional()` — no prop-drilling (Round-5 Coupling-A).
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
 * real comparison exists; the "new growth" case (value undefined) carries a 0 so the
 * tile draws a neutral (non-misleading) marker with the "new" label.
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

/** Normalise a CASE into a severity band, using the SAME preference order as the Cases
 *  severity FILTER (`Cases.tsx caseSeverityBand`): prefer the source-asserted advisory
 *  `severity_band`, then fall back to the deterministic `risk_score` on the ONE SEVERITY
 *  authority (`badges.ts` — severityBand/severityBandFromNumber, the 74/48/22/8 ladder).
 *
 *  Bucketing here MUST agree with that filter so the "Open cases by severity" widget
 *  count reconciles with the drilled Cases list even for source_asserted cases where
 *  `severity_band` disagrees with `bandOf(risk_score)` (Round-7 QA drill regression). The
 *  risk-band fallback keeps the exact prior behaviour for cases with no `severity_band`. */
function bandOfCase(k: Case): SevKey {
  const explicit = severityBand(k.severity_band);
  if (explicit) return explicit;
  const s = typeof k.risk_score === 'number' && Number.isFinite(k.risk_score) ? k.risk_score : 0;
  return severityBandFromNumber(s);
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

/** One KPI-strip tile descriptor (built in a memo, rendered as a <KpiTile>). */
interface KpiItem {
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon: typeof Inbox;
  accent: KpiAccent;
  goodDirection: 'up' | 'down' | 'none';
  onClick?: () => void;
  delta?: KpiDelta;
  /** When set, the value rolls to this integer via <CountUp>. Integers only. */
  countTo?: number;
  format?: (n: number) => string;
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
  // (open/severity/signatures/entities/connector-health/workload) reflects the
  // TimeRangePicker, alongside `usageSummary` (cost ledger) + `usePosture` (which already
  // did). `getMetrics` supplies the by-status workload, the cases-per-day trend, and the
  // all-time `total_cases` used only to distinguish the empty state.
  const [cases, setCases] = React.useState<Case[]>([]);
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
      // The Noise-Reduction funnel is a Round-7 feature; typeof-guard the call so a
      // minimal test/mock surface (no `noiseReduction`) simply resolves null and the
      // funnel band self-omits (mirrors the AutomationNudge guard below).
      const noiseP: Promise<NoiseReduction | null> =
        typeof api.noiseReduction === 'function'
          ? api.noiseReduction(hours)
          : Promise.resolve(null);
      const [c, m, u, n] = await Promise.allSettled([
        // #37: window the case sample by created-at so the case-derived widgets honour
        // the range. Backend caps at 200 by created-desc, so this is the most-recent
        // slice within the window (what the KPI/severity/health widgets summarise).
        api.listCases({ limit: 200, from: `now-${hours}h` }),
        api.getMetrics(hours),
        api.usageSummary(hours),
        noiseP,
      ]);
      if (c.status === 'fulfilled') setCases(c.value.cases ?? []);
      if (m.status === 'fulfilled') setMetrics(m.value);
      if (u.status === 'fulfilled') setUsage(u.value);
      if (n.status === 'fulfilled') setNoise(n.value ?? null);
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
  // dwell p50 with an honest labelled DASH) + SLA + quality rates. `'prev'` also asks
  // for the period-over-period `compare` block that wires the KPI-strip deltas. This
  // REPLACES the deleted ~120 lines of client-side timing derivation.
  const { data: posture, reload: reloadPosture } = usePosture(hours, 'prev');

  /** One refresh pulse for the whole dashboard (control-bar button + auto-refresh tick). */
  const refreshAll = React.useCallback(() => {
    void load();
    void reloadPosture();
  }, [load, reloadPosture]);

  // ----- Noise-Reduction funnel: per-user hide toggle (persisted) --------- //
  // Persisted per-browser (localStorage) rather than the server UserPrefsStore because
  // Overview is rendered provider-less in unit tests + the AutomationNudge precedent
  // already uses localStorage. Satisfies the "per-user hide toggle" requirement.
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
  // Only what the server posture rollup does NOT provide: open-by-severity, per-source
  // signal, and the status workload. All pure counts over the case sample — no timing
  // math (that lives on the server now).
  const derived = React.useMemo(() => {
    let open = 0;
    let critical = 0;
    let criticalHighAlerts = 0;
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

      const band = bandOfCase(k);
      sevCounts[band] += 1;
      if (band === 'critical') critical += 1;
      if (band === 'critical' || band === 'high') criticalHighAlerts += 1;

      // Product / category signal = the originating source (plain backend text).
      const product = k.source_name || k.source_id || 'Unattributed';
      productCounts[product] = (productCounts[product] ?? 0) + 1;
    }

    return {
      open,
      critical,
      criticalHighAlerts,
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
      // #11: "auto-closed by AI" = a terminal case whose recorded close decision came
      // from the agent actor (there is no `auto_closed` status / `auto` decider in the
      // backend). Shares the ONE predicate with AutoClosedBadge so the two never drift.
      else if (isAutoClosedByAI(k.status, k.decision_by)) autoClosed += 1;
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
  // #4: honest labels + (?) help — the SINGLE `LIFECYCLE_METRICS` copy source gives
  // Dwell / MTTA / MTTR their real labels + the exact-formula HelpTip text (no invented
  // "MTTD"; Dwell is time-to-first-response, not time-to-detect). Values still come
  // straight from the server posture rollup.
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
      block('dwell', 'dwell_minutes', 'info'),
      block('mtta', 'mtta_minutes', 'medium'),
      block('mttr', 'mttr_minutes', 'success'),
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

  // ----- Active Risk Index (#1) — the ONE Command-Center risk instrument -- //
  // Canonical value = the mean deterministic `risk_score` over the currently OPEN
  // (non-terminal) cases, computed server-side (`Metrics.active_risk_index`). When the
  // backend has not populated it we fall back to the mean over the OPEN cases in the
  // loaded sample, then to the all-case average — never a fabricated 0 (ActiveRiskIndex
  // degrades to an honest DASH when there are no open cases). Advisory only (#3): the
  // index is ranking presentation and was never fed to the deterministic decide().
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

  // Top signatures — the most-frequent detections (case title / cluster signature /
  // rule). Labels are UNTRUSTED → BarList renders them as plain text (#9).
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
      .map(([label, value]) => ({
        label,
        value,
        sub: `${Math.round((value / total) * 100)}% of cases`,
      }));
  }, [cases]);

  // Top entities — the most-implicated assets (ip/host/user/…). Entity value is
  // UNTRUSTED → plain text (#9); the sub carries the humanized entity type.
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

  // ----- Attention queue — the newest OPEN cases needing eyes ------------- //
  // A real work list (not just a count): the most-recently-created still-open cases,
  // each a drill-through into its case. Titles/entities are UNTRUSTED → plain text (#9).
  const attentionCases = React.useMemo(() => {
    return cases
      .filter((k) => OPEN_STATUSES.has((k.status || '').toLowerCase()))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 6);
  }, [cases]);

  // ----- Case outcomes (verdict mix) — the agent's disposition of the load -- //
  // Server `by_verdict` (TP / FP / needs-human / unverdicted); colour by the VERDICT
  // semantic axis. Falls back to a tally over the loaded case sample when absent.
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
          const key = v === 'TRUE_POSITIVE' || v === 'FALSE_POSITIVE' || v === 'NEEDS_HUMAN' ? v : 'none';
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

  // Case-volume trend — server `cases_per_day` mapped to the TrendArea point shape.
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
    return source
      .sort((a, b) => b[1] - a[1])
      .map(([status, value]) => ({ status, value }));
  }, [metrics, cases]);

  // ----- KPI strip — 5 alert/case-centric signal tiles (spend demoted, Task 4) --- //
  // Integer tiles roll via <CountUp> (`countTo`); the % tile renders a formatted string.
  // A period-over-period delta from `posture.compare` is attached ONLY when the tile's
  // displayed value and the compare metric share the SAME UNIT — so the False-Positive
  // RATE tile carries `false_positive_rate`, but the COUNT tiles (Open / Escalated /
  // Auto-Resolved) carry no delta rather than a rate/total delta that could contradict
  // the number. The comparison window is stated once under the strip. Every tile drills
  // through to a filtered destination. (LLM spend is no longer a hero tile — see below.)
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
        goodDirection: 'down', // fewer open cases is better
        // No delta: this tile shows the OPEN count, but the only case-count compare
        // metric is `case_count` (TOTAL cases) — a unit mismatch whose arrow/colour
        // could contradict the shown number. Show no delta rather than a misleading one.
        onClick: navigate
          ? () => navigate('cases', { status: 'open', window: navWindow })
          : undefined,
      },
      {
        // #38: deep-links to a severity-filtered Cases view. The tile aggregates TWO
        // bands (critical + high) but the Cases severity facet is single-band, so we
        // drill to the WORST non-empty band — critical when any exist, else high.
        label: 'Critical / High',
        value: fmtNumber(derived.criticalHighAlerts),
        countTo: derived.criticalHighAlerts,
        format: fmtInt,
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
        value: fmtNumber(escalated),
        countTo: escalated,
        format: fmtInt,
        sub: 'Awaiting analyst review',
        icon: Workflow,
        accent: 'low',
        goodDirection: 'down',
        // No delta: this tile shows a COUNT but the only escalation compare metric is
        // `escalation_rate` (a RATE) — a unit mismatch whose delta could contradict the
        // count. Show no delta rather than a misleading one.
        onClick: navigate
          ? () => navigate('cases', { status: 'needs_human', window: navWindow })
          : undefined,
      },
      {
        // NEW (Round-7): the agent's precision signal — the server-computed share of
        // cases closed as false positives. A rate → formatted string, no count-up.
        label: 'False Positive Rate',
        value: ratioPct(fpRate),
        sub: 'Cases closed as false positives',
        icon: Percent,
        accent: 'medium',
        goodDirection: 'down', // a lower FP rate is better
        delta: toKpiDelta(deltaView(compare?.false_positive_rate)),
        onClick: navigate ? () => navigate('metrics', { tab: 'posture' }) : undefined,
      },
      {
        // NEW (Round-7): how much the agent resolved on its own (the #3 payoff).
        label: 'Auto-Resolved',
        value: fmtNumber(autoResolved),
        countTo: autoResolved,
        format: fmtInt,
        sub: 'Closed autonomously by the agent',
        icon: ShieldCheck,
        accent: 'success',
        goodDirection: 'up', // more autonomous resolution is better
        // No delta: this tile shows a COUNT but the only automation compare metric is
        // `automation_rate` (a RATE) — a unit mismatch whose delta could contradict the
        // count. Show no delta rather than a misleading one.
        onClick: navigate
          ? () => navigate('cases', { status: 'closed', window: navWindow })
          : undefined,
      },
      // NOTE (Round-8 Task 4): LLM SPEND was DEMOTED off the hero. Cost is an
      // executive/periodic KPI — none of the SOC leaders (Sentinel / Splunk ES / QRadar /
      // Chronicle / XSIAM) hero $ on the operational overview; it belongs on the Cost page.
      // The hero row answers "is anything on fire + what does a human still have to do",
      // not "how is the machine performing". Spend now lives as a quiet health tile inside
      // the collapsed "Deeper analytics" group (a runaway-spend tripwire), not the hero.
    ];
  }, [derived, metrics, cases.length, navWindow, autonomy.escalated, autonomy.autoClosed, posture, navigate]);

  // ----- Noise-Reduction funnel drill-through ----------------------------- //
  // Each stage deep-links into the pre-filtered Cases list (only NavOpts-valid keys —
  // status/window; the pre-case + true-positive stages carry the window only).
  const onStageClick = React.useCallback(
    (key: string) => {
      if (!navigate) return;
      switch (key) {
        case 'needs_human':
          navigate('cases', { status: 'needs_human', window: navWindow });
          break;
        case 'escalated':
          navigate('cases', { status: 'escalated', window: navWindow });
          break;
        case 'auto_cleared':
          navigate('cases', { status: 'closed', window: navWindow });
          break;
        default:
          navigate('cases', { window: navWindow });
      }
    },
    [navigate, navWindow],
  );

  // ----- The header control cluster (#6 — folded into PageHeader.actions) -- //
  // Time range + auto-refresh + a manual refresh pulse. Lives in the plain header's
  // `actions` slot; the Active Risk Index is its own card top-right (#1) — there is no
  // second full-width control band under the header (DESIGN_DIRECTION header-compaction).
  const headerControls = (
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
  );

  // ----- States ----------------------------------------------------------- //
  // Loading skeleton mirrors the FINAL dense layout in LOCKSTEP so nothing shifts on load:
  // the masthead (plain header + the Active Risk Index card top-right), the 5-tile KPI strip,
  // the 4-tile Response-timing row, a reserved full-width Noise-Reduction band, the work+mix
  // row, and the collapsed "Deeper analytics" group header (its content stays hidden — #4).
  if (loading && !cases.length && !metrics) {
    return (
      <PageContainer variant="wide">
        <div className="space-y-4" aria-busy="true" aria-label="Loading dashboard">
          {/* masthead — plain header (left) + the Active Risk Index card (right) */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <Skeleton className="h-16 flex-1 rounded-lg" />
            <Skeleton className="h-48 w-full rounded-lg lg:w-72" />
          </div>
          {/* KPI strip — 5 tiles, same responsive grid as the real strip */}
          <div
            data-testid="kpi-strip-skeleton"
            className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-lg" />
            ))}
          </div>
          {/* Response-timing row — 4 compact tiles (now on the MAIN dashboard) */}
          <div data-testid="timing-skeleton-row" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[88px] rounded-lg" />
            ))}
          </div>
          {/* reserved Noise-Reduction band (full width) */}
          <Skeleton data-testid="noise-skeleton-row" className="h-56 w-full rounded-lg" />
          {/* work + mix row — attention queue · severity · verdict mix (open by default) */}
          <div data-testid="work-skeleton-row" className="grid gap-4 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-64 rounded-lg" />
            ))}
          </div>
          {/* collapsed "Deeper analytics" group header (content hidden until expanded). */}
          <Skeleton data-testid="deeper-analytics-skeleton" className="h-9 w-64 rounded-md" />
        </div>
      </PageContainer>
    );
  }

  const empty = !loading && !error && cases.length === 0 && !metrics?.total_cases;

  // Severity slice for the KPI-adjacent "open by severity" widget.
  const totalCases = cases.length || 1;

  return (
    <PageContainer variant="wide" className="space-y-4">
      {/* ---- ZONE 1: masthead — a PLAIN, dense header (#7, like the Sources page: no
             card, no glow wash; the big title sits flush on the page background) on the
             left with the time-range + refresh controls in its `actions` slot, and the ONE
             risk instrument (#1, its own bordered card) pinned top-right. No second band. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <PageHeader
          className="flex-1"
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
        {/* #1: the ONE risk instrument — mean deterministic risk over the open cases, in
            its OWN bordered card top-right. Task 4: a bigger, more prominent card (gauge
            size 180 + a critical-boundary notch at 74). */}
        <ActiveRiskIndex
          score={activeRisk.score}
          count={activeRisk.count}
          size={180}
          className="w-full shrink-0 lg:w-72"
        />
      </div>

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
        <div className="animate-fade-in space-y-4">
          {/* ---- ZONE 2: KPI strip — flat, un-nested, responsive by COLUMN COUNT ---- */}
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
            {/* State the comparison window ONCE under the strip (not per tile). */}
            {posture?.compare ? (
              <p className="px-0.5 text-2xs text-muted-foreground">
                Deltas compare the previous {windowLabel(hours)}.
              </p>
            ) : null}
          </div>

          {/* ---- ZONE 3: Response timing — MTTA · MTTR · Dwell (+ an honest MTTD n/a
                 slot) on the MAIN dashboard (Task 3), NOT hidden in a fold. p50 values
                 come straight from the server posture rollup. ---- */}
          <DashboardGroup
            title="Response timing"
            description="median (p50), server-computed"
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
            <Stagger className="grid grid-cols-2 gap-3 lg:grid-cols-4" itemClassName="h-full">
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
              {/* MTTD is DELIBERATELY not fabricated — this pipeline measures nothing
                  before case creation, so we render an honest n/a with a (?) explaining why
                  rather than inventing a mean-time-to-detect number. */}
              <KpiTile
                variant="bar"
                label="MTTD"
                value={DASH}
                sub="not measured (n/a)"
                accent="low"
                icon={Timer}
                goodDirection="down"
                help="Mean time to detect (log arrival → detection) is not measured by this pipeline — timing is tracked only from case creation onward. Shown as n/a rather than a fabricated number."
              />
            </Stagger>
          </DashboardGroup>

          {/* ---- ZONE 4: Noise-Reduction ribbon — the value-prop headline, a WIDE
                 full-width band. Self-omits when the feature is off / counters unavailable. */}
          {noise ? (
            <Reveal variant="rise" delay={60}>
              <NoiseFunnel
                data={noise}
                onStageClick={onStageClick}
                hidden={noiseHidden}
                onToggleHidden={toggleNoiseHidden}
                className="w-full"
              />
            </Reveal>
          ) : null}

          {/* ---- ZONE 5: work + mix — attention queue · open-by-severity · case outcomes.
                 All OPEN by default so the default view is already rich (#4 inverted-pyramid,
                 but a much shallower fold). ---- */}
          <Reveal variant="rise" delay={90} className="grid gap-4 xl:grid-cols-3">
            {/* Attention queue — the newest OPEN cases as a real work list */}
            <DashboardGroup
              title="Attention queue"
              count={derived.open}
              description="newest open cases"
            >
              <Card>
                <CardContent className="space-y-3 py-3">
                  {attentionCases.length ? (
                    <ul className="flex flex-col divide-y divide-border">
                      {attentionCases.map((k) => {
                        const band = bandOfCase(k);
                        const displayTitle =
                          (k.title || k.cluster_signature || k.case_number || k.case_id || '').trim() ||
                          'Untitled case';
                        const src = k.source_name || k.source_id || 'Unknown source';
                        const age = humanizeAge(k.created_at);
                        const clickable = !!navigate;
                        return (
                          <li key={k.case_id}>
                            <button
                              type="button"
                              disabled={!clickable}
                              onClick={
                                clickable
                                  ? () =>
                                      navigate('cases', { caseId: k.case_id, window: navWindow })
                                  : undefined
                              }
                              className={cn(
                                'flex w-full items-center gap-2.5 rounded-md py-2 text-left',
                                clickable &&
                                  '-mx-1 px-1 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              )}
                              aria-label={clickable ? `Open case ${displayTitle}` : undefined}
                            >
                              <span
                                className={cn('mt-0.5 shrink-0 text-xs leading-none', SEV_DOT[band])}
                                aria-hidden
                              >
                                ●
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-foreground">
                                  {displayTitle}
                                </span>
                                <span className="block truncate text-2xs text-muted-foreground">
                                  {SEV_LABEL[band]} · {src}
                                  {age ? ` · ${age}` : ''}
                                </span>
                              </span>
                              {clickable ? (
                                <ChevronRight
                                  className="h-4 w-4 shrink-0 text-muted-foreground"
                                  aria-hidden
                                />
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
                      onClick={() =>
                        navigate('cases', { status: 'needs_human', window: navWindow })
                      }
                    >
                      {slaPosture && (slaPosture.breached > 0 || slaPosture.atRisk > 0)
                        ? `Review escalations · ${fmtNumber(slaPosture.breached)} breached · ${fmtNumber(slaPosture.atRisk)} at risk`
                        : 'Review escalations'}
                    </Button>
                  ) : null}
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

            {/* Case outcomes — the agent's verdict mix (a compact ring + legend) */}
            <DashboardGroup title="Case outcomes" count={verdictMix.total} description="verdict mix">
              <Card>
                <CardContent className="py-4">
                  {verdictMix.total > 0 ? (
                    <div className="flex flex-col items-center gap-4 sm:flex-row">
                      <DonutChart
                        segments={verdictMix.segments}
                        height={160}
                        className="w-full shrink-0 sm:w-40"
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
          </Reveal>

          {/* ---- ZONE 6: top contributors — signatures · entities (ranked lists), on the
                 MAIN dashboard. ---- */}
          <Reveal variant="rise" delay={120} className="grid gap-4 xl:grid-cols-2">
            <DashboardGroup
              title="Top signatures"
              count={signatureItems.length}
              description="most frequent detections"
            >
              <Card>
                <CardContent className="py-4">
                  <BarList
                    items={signatureItems}
                    showRank
                    showPercent
                    emptyLabel="No signatures yet"
                  />
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
                  <BarList
                    items={entityItems}
                    showRank
                    showPercent
                    emptyLabel="No entities yet"
                  />
                </CardContent>
              </Card>
            </DashboardGroup>
          </Reveal>

          {/* ---- Deeper analytics (#4 — a SHALLOW fold now): the default view above is
                 already dense, so only the secondary bands (autonomy split, connector
                 health, case volume, workload state, spend tripwire) are folded away. ---- */}
          <DashboardGroup
            title="Deeper analytics"
            defaultOpen={false}
            description="autonomy, cost, volume, connectors & workload"
            contentClassName="space-y-4"
          >
            {/* LLM spend — DEMOTED off the hero (Task 4): a quiet runaway-spend tripwire, not
                a SOC hero KPI. Drills through to the full cost ledger. Compact + bounded. */}
            <KpiTile
              variant="bar"
              testId="llm-spend-detail"
              label="LLM spend"
              value={fmtMoney(usage?.total_cost, usage?.currency)}
              sub={
                typeof usage?.total_tokens === 'number'
                  ? `${fmtTokens(usage.total_tokens)} tokens · ${fmtNumber(usage.call_count)} calls · past ${windowLabel(hours)}`
                  : 'No spend recorded'
              }
              icon={CircleDollarSign}
              accent="primary"
              goodDirection="down"
              className="sm:max-w-xs"
              onClick={navigate ? () => navigate('metrics', { tab: 'cost' }) : undefined}
            />

            {/* Row: autonomy split (#3) · connector health */}
            <Reveal variant="rise" className="grid gap-4 xl:grid-cols-2">
              {/* Autonomous vs human — the #3 trust surface */}
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
            </Reveal>

            {/* Row: case-volume trend · workload state */}
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

              {/* Case workload state */}
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
          </DashboardGroup>
        </div>
      )}
    </PageContainer>
  );
}
