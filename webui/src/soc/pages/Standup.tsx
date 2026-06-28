/**
 * Standup — the daily shift digest (new "command center" surface).
 *
 * Fetches `GET /api/standup` (which always returns HTTP 200) and renders the
 * model-generated prose summary in a gradient hero, followed by defensively-parsed
 * aggregate KPIs (events / unique IPs / cases opened+closed), a case-outcomes
 * donut, an event-activity sparkline, and ranked top-N BarList cards
 * (rules / source IPs / users / hosts / severity). A window toggle (24h / 7d) +
 * refresh + copy-summary + copy-digest live in the hero.
 *
 * The endpoint has three shapes, all handled gracefully:
 *   - disabled  → `enabled:false`            (friendly empty state, not an error)
 *   - happy     → `enabled:true, degraded:false`
 *   - degraded  → `degraded:true, error:"…"` (warning callout + whatever exists)
 *
 * Security: the `summary` is model-generated prose and every aggregate label is
 * log-derived — ALL of it is UNTRUSTED and rendered strictly as PLAIN text
 * (`whitespace-pre-wrap`) or via BarList/donut SVG text. Never as HTML.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Check,
  Clipboard,
  ClipboardCheck,
  Clock3,
  FileText,
  FolderOpen,
  Globe,
  Hash,
  PieChart as PieIcon,
  RefreshCw,
  Server,
  ShieldAlert,
  TrendingUp,
  User,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { StandupResponse } from '@/lib/types';
import {
  fmtMoney,
  fmtNumber,
  humanizeAge,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { HeroPanel } from '@/soc/components/HeroPanel';
import { KpiTile } from '@/soc/components/KpiTile';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { DonutChart, Sparkline } from '@/soc/components/charts';
import { EmptyState } from '@/soc/components/EmptyState';
import { Stagger } from '@/soc/components/Stagger';
import { semanticColor, categorical } from '@/soc/components/palette';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/ui/card';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

/* ----------------------------------------------------- defensive readers --- */

/**
 * Widened local view of the standup response. `types.ts` declares only the
 * stable subset; the hardened backend adds `degraded` / `error` / `cost` /
 * `cases`, which we read here without editing the shared type.
 */
type Standup = StandupResponse & {
  degraded?: boolean;
  error?: string;
  cost?: unknown;
  cases?: unknown;
};

/** A ranked, colored chart/bar segment. */
interface Segment {
  label: string;
  value: number;
  color?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
}

/**
 * Coerce a bucket-list-ish value into ranked chart segments. Handles the
 * canonical `[{key, count}]` shape but also tolerates `{value}`/`{doc_count}`.
 */
function toSegments(v: unknown, palette = false): Segment[] {
  if (!Array.isArray(v)) return [];
  const out: Segment[] = [];
  v.forEach((raw, i) => {
    const b = asRecord(raw);
    const key = b.key ?? b.label ?? b.name;
    const value =
      asNumber(b.count) ?? asNumber(b.value) ?? asNumber(b.doc_count) ?? asNumber(b.cost);
    if (key === undefined || key === null || value === undefined) return;
    out.push({
      label: String(key),
      value,
      color: palette ? categorical(i) : undefined,
    });
  });
  return out;
}

/**
 * Coerce an events-over-time bucket list into a plain numeric series for the
 * sparkline. Accepts `[{count}]` / `[{value}]` / `[{doc_count}]` or `number[]`.
 */
function toSeries(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((raw) => {
      if (typeof raw === 'number') return Number.isNaN(raw) ? 0 : raw;
      const b = asRecord(raw);
      return asNumber(b.count) ?? asNumber(b.value) ?? asNumber(b.doc_count) ?? 0;
    })
    .filter((n): n is number => typeof n === 'number');
}

/** Read a `{key,count}`-ish bucket list into a `{key: count}` map (lowercased). */
function bucketMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(v)) return out;
  v.forEach((raw) => {
    const b = asRecord(raw);
    const key = b.key;
    const count = asNumber(b.count) ?? asNumber(b.value) ?? asNumber(b.doc_count);
    if (key === undefined || key === null || count === undefined) return;
    out[String(key).toLowerCase()] = count;
  });
  return out;
}

const WINDOWS = [
  { id: '24', label: '24h', hours: 24 },
  { id: '168', label: '7d', hours: 168 },
] as const;

/** Pick the closest preset window id for a configured `window_hours`. */
function seedWindowId(hours?: number): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return '24';
  let best: { id: string; hours: number } = WINDOWS[0];
  for (const w of WINDOWS) {
    if (Math.abs(w.hours - hours) < Math.abs(best.hours - hours)) best = w;
  }
  return best.id;
}

/* -------------------------------------------------------- copy button hook - */

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = React.useCallback((text: string) => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clip?.writeText) return;
    clip
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard denied — silently no-op */
      });
  }, []);
  return [copied, copy];
}

/* ----------------------------------------------------------------- props --- */

interface StandupProps {
  // Standup has no drill-through; prop kept for shell uniformity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNavigate?: (...args: any[]) => void;
}

/* ============================================================== component == */

export default function Standup(_props: StandupProps) {
  const [windowId, setWindowId] = React.useState<string>('24');
  const [windowSeeded, setWindowSeeded] = React.useState(false);
  const [data, setData] = React.useState<Standup | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const [summaryCopied, copySummary] = useCopy();
  const [digestCopied, copyDigest] = useCopy();

  const requestedHours = React.useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.hours ?? 24,
    [windowId],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData((await api.standup(requestedHours)) as Standup);
    } catch (e) {
      // The backend always returns 200; this only fires for transport-level
      // failures (backend unreachable). Surface it as a real error.
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [requestedHours]);

  // Seed the window from prefs.standup.window_hours once, before first load.
  React.useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const hrs = (s as any)?.prefs?.standup?.window_hours;
        if (typeof hrs === 'number') setWindowId(seedWindowId(hrs));
      })
      .catch(() => {
        /* prefs are advisory here; keep the default window. */
      })
      .finally(() => {
        if (!cancelled) setWindowSeeded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Defer the first fetch until the window has been seeded.
  React.useEffect(() => {
    if (windowSeeded) void load();
  }, [load, windowSeeded]);

  const agg = React.useMemo(() => asRecord(data?.aggregate), [data]);

  const totalEvents = asNumber(agg.total_events);
  const uniqueIps = asNumber(agg.unique_ips);
  // `cases` may sit at the top level OR inside `aggregate` — try both.
  const cases = React.useMemo(
    () => ({ ...asRecord(agg.cases), ...asRecord(data?.cases) }),
    [agg, data],
  );
  const casesOpened = asNumber(cases.opened);
  // The backend never emits `cases.closed`; derive it from by_status.
  const statusMap = React.useMemo(() => bucketMap(cases.by_status), [cases]);
  const casesClosed = React.useMemo(() => {
    if (typeof cases.closed === 'number') return cases.closed as number;
    const keys = Object.keys(statusMap);
    if (!keys.length) return undefined;
    return statusMap.closed ?? 0;
  }, [cases, statusMap]);

  // Case outcomes (verdict mix) for the donut, from cases.by_verdict.
  const outcomes = React.useMemo<Segment[]>(() => {
    const m = bucketMap(cases.by_verdict);
    return Object.entries(m)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ label: humanizeToken(k), value: v, color: semanticColor(k) }))
      .sort((a, b) => b.value - a.value);
  }, [cases]);
  const outcomesTotal = React.useMemo(
    () => outcomes.reduce((s, o) => s + o.value, 0),
    [outcomes],
  );

  const byRule = React.useMemo(() => toSegments(agg.by_rule, true), [agg]);
  const topIps = React.useMemo(() => toSegments(agg.top_source_ips), [agg]);
  const topUsers = React.useMemo(() => toSegments(agg.top_users), [agg]);
  const topHosts = React.useMemo(() => toSegments(agg.top_hosts), [agg]);
  const bySeverity = React.useMemo(() => toSegments(agg.by_severity, true), [agg]);
  const series = React.useMemo(() => toSeries(agg.events_over_time), [agg]);

  const windowHours = asNumber(data?.window_hours) ?? requestedHours;
  const windowLabel = windowHours >= 168 ? `${Math.round(windowHours / 24)}d` : `${windowHours}h`;

  const disabled = data?.enabled === false;
  const degraded = data?.degraded === true;
  const degradedNote =
    (typeof data?.error === 'string' && data.error.trim()) || 'Running on limited data.';

  const cost = asNumber(data?.cost);

  const hasAggregate =
    totalEvents !== undefined ||
    byRule.length > 0 ||
    topIps.length > 0 ||
    topUsers.length > 0 ||
    topHosts.length > 0 ||
    bySeverity.length > 0;

  const summaryText = data?.summary?.trim() ?? '';
  const hasSummary = summaryText.length > 0;

  // A standup with a `generated_at` is a cached artifact; re-fetch reads "Refresh".
  const isCached = typeof data?.generated_at === 'string' && data.generated_at.length > 0;
  const refreshLabel = isCached ? 'Refresh' : 'Regenerate';

  /**
   * Markdown rendering of the digest for "Copy digest" — the prose summary plus
   * headline aggregate facts and top-N breakdowns. All values are log-derived but
   * copied as plain Markdown text (never executed).
   */
  const digestMarkdown = React.useMemo(() => {
    const lines: string[] = [];
    lines.push(`# Standup — last ${windowLabel}`);
    if (data?.generated_at) lines.push(`_Generated ${humanizeAge(data.generated_at)}_`);
    lines.push('');
    if (summaryText) {
      lines.push(summaryText);
      lines.push('');
    }
    const facts: string[] = [];
    if (totalEvents !== undefined) facts.push(`- Events: ${fmtNumber(totalEvents)}`);
    if (uniqueIps !== undefined) facts.push(`- Unique source IPs: ${fmtNumber(uniqueIps)}`);
    if (casesOpened !== undefined) facts.push(`- Cases opened: ${fmtNumber(casesOpened)}`);
    if (casesClosed !== undefined) facts.push(`- Cases closed: ${fmtNumber(casesClosed)}`);
    if (cost !== undefined && cost > 0) facts.push(`- LLM cost: ${fmtMoney(cost)}`);
    if (facts.length) {
      lines.push('## Headline');
      lines.push(...facts);
      lines.push('');
    }
    const section = (title: string, segs: Segment[]) => {
      if (!segs.length) return;
      lines.push(`## ${title}`);
      segs.slice(0, 8).forEach((s) => lines.push(`- ${s.label}: ${fmtNumber(s.value)}`));
      lines.push('');
    };
    section('Case outcomes', outcomes);
    section('Top rules', byRule);
    section('Top source IPs', topIps);
    section('Top users', topUsers);
    section('Top hosts', topHosts);
    return lines.join('\n').trim();
  }, [
    windowLabel,
    data,
    summaryText,
    totalEvents,
    uniqueIps,
    casesOpened,
    casesClosed,
    cost,
    outcomes,
    byRule,
    topIps,
    topUsers,
    topHosts,
  ]);

  // --------------------------------------------------------------- actions -- //
  const actions = (
    <>
      <Select value={windowId} onValueChange={setWindowId} disabled={loading}>
        <SelectTrigger className="h-9 w-[120px]" aria-label="Digest window">
          <Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WINDOWS.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasSummary ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => copySummary(summaryText)}
          aria-label="Copy summary"
        >
          {summaryCopied ? (
            <ClipboardCheck className="h-4 w-4 text-success" aria-hidden />
          ) : (
            <Clipboard className="h-4 w-4" aria-hidden />
          )}
          {summaryCopied ? 'Copied' : 'Copy summary'}
        </Button>
      ) : null}

      {digestMarkdown ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => copyDigest(digestMarkdown)}
          aria-label="Copy the full digest as Markdown"
        >
          {digestCopied ? (
            <Check className="h-4 w-4 text-success" aria-hidden />
          ) : (
            <FileText className="h-4 w-4" aria-hidden />
          )}
          {digestCopied ? 'Copied' : 'Copy digest'}
        </Button>
      ) : null}

      <Button size="sm" onClick={() => void load()} disabled={loading}>
        <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
        {refreshLabel}
      </Button>
    </>
  );

  const heroMeta = (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 py-0.5 text-primary">
        <Clock3 className="h-3.5 w-3.5" aria-hidden />
        {windowLabel} window
      </span>
      {data?.generated_at ? <span>generated {humanizeAge(data.generated_at)}</span> : null}
      {cost !== undefined && cost > 0 ? <span>LLM cost {fmtMoney(cost)}</span> : null}
    </div>
  );

  // ------------------------------------------------------------------ body -- //
  return (
    <div className="animate-fade-in space-y-6">
      <HeroPanel
        eyebrow="Daily digest"
        title="Standup"
        description="The daily aggregate digest, summarised from recent log activity."
        icon={FileText}
        meta={heroMeta}
        actions={<div className="flex flex-wrap items-center gap-2">{actions}</div>}
      >
        {/* Transport-level failure — the only real error path. */}
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden />
            <AlertTitle>Could not reach the standup service</AlertTitle>
            <AlertDescription>
              The backend may be unreachable. Try refreshing in a moment.
            </AlertDescription>
          </Alert>
        ) : loading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : disabled ? null : (
          <div className="space-y-3">
            {degraded ? (
              <Alert variant="warning">
                <AlertTriangle aria-hidden />
                <AlertTitle>Generated from limited data</AlertTitle>
                <AlertDescription>{degradedNote}</AlertDescription>
              </Alert>
            ) : null}
            {hasSummary ? (
              // Model-generated prose — rendered strictly as plain text.
              <p className="max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {summaryText}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No summary is available for this window yet. Try regenerating, or widen the window.
              </p>
            )}
          </div>
        )}
      </HeroPanel>

      {/* Disabled state — friendly, outside the hero. */}
      {!loading && !error && disabled ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={FileText}
              title="Standup is turned off"
              description="The daily digest is disabled. Enable it under Settings → Standup to start generating a summary of recent log activity."
            />
          </CardContent>
        </Card>
      ) : null}

      {/* Loading skeleton tiles. */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[108px]" />
          ))}
        </div>
      ) : null}

      {/* Populated content. */}
      {!loading && !error && !disabled ? (
        <>
          {/* Headline KPI tiles. */}
          {hasAggregate ? (
            <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiTile
                label="Events"
                value={totalEvents !== undefined ? fmtNumber(totalEvents) : '—'}
                sub={`last ${windowLabel}`}
                icon={Hash}
                accent="primary"
              />
              <KpiTile
                label="Unique source IPs"
                value={uniqueIps !== undefined ? fmtNumber(uniqueIps) : '—'}
                icon={Globe}
                accent="info"
              />
              <KpiTile
                label="Cases opened"
                value={casesOpened !== undefined ? fmtNumber(casesOpened) : '—'}
                icon={FolderOpen}
                accent="high"
              />
              <KpiTile
                label="Cases closed"
                value={casesClosed !== undefined ? fmtNumber(casesClosed) : '—'}
                icon={Check}
                accent="success"
              />
            </Stagger>
          ) : null}

          {/* Case outcomes donut + event activity sparkline. */}
          {outcomes.length || series.length > 1 ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {outcomes.length ? (
                <Card className="lg:col-span-1">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <PieIcon className="h-4 w-4 text-primary" aria-hidden />
                      Case outcomes
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Verdict mix of the {fmtNumber(outcomesTotal)} cases opened this window
                    </p>
                  </CardHeader>
                  <CardContent>
                    <DonutChart
                      segments={outcomes}
                      format={fmtNumber}
                      ariaLabel="Case outcomes by verdict"
                      center={
                        <>
                          <span className="text-2xl font-bold tabular-nums text-foreground">
                            {fmtNumber(outcomesTotal)}
                          </span>
                          <span className="text-xs text-muted-foreground">cases</span>
                        </>
                      }
                    />
                    <ul className="mt-3 flex flex-col gap-1.5">
                      {outcomes.map((o, i) => (
                        <li key={`${o.label}-${i}`} className="flex items-center gap-2 text-sm">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: o.color }}
                            aria-hidden
                          />
                          <span className="truncate text-foreground">{o.label}</span>
                          <span className="ml-auto font-mono tabular-nums text-muted-foreground">
                            {fmtNumber(o.value)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : null}

              {series.length > 1 ? (
                <Card className={cn(outcomes.length ? 'lg:col-span-2' : 'lg:col-span-3')}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-primary" aria-hidden />
                      Event activity
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Events over the {windowLabel} window
                    </p>
                  </CardHeader>
                  <CardContent>
                    <Sparkline
                      data={series}
                      height={120}
                      colorToken="primary"
                      ariaLabel={`Event activity over the ${windowLabel} window`}
                    />
                  </CardContent>
                </Card>
              ) : null}
            </div>
          ) : null}

          {/* Ranked top-N breakdowns. */}
          {hasAggregate ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {byRule.length ? (
                <BarCard icon={Hash} accent="text-high" title="Top rules" items={byRule.slice(0, 8)} />
              ) : null}
              {topIps.length ? (
                <BarCard icon={Globe} accent="text-primary" title="Top source IPs" items={topIps.slice(0, 8)} />
              ) : null}
              {topUsers.length ? (
                <BarCard icon={User} accent="text-info" title="Top users" items={topUsers.slice(0, 8)} />
              ) : null}
              {topHosts.length ? (
                <BarCard icon={Server} accent="text-success" title="Top hosts" items={topHosts.slice(0, 8)} />
              ) : null}
              {bySeverity.length ? (
                <BarCard
                  icon={ShieldAlert}
                  accent="text-critical"
                  title="By severity"
                  items={bySeverity.map((s) => ({
                    label: humanizeToken(s.label),
                    value: s.value,
                    color: severityBar(s.label),
                  }))}
                />
              ) : null}
            </div>
          ) : (
            <Card>
              <CardContent className="p-0">
                <EmptyState
                  icon={TrendingUp}
                  title="No activity in this window"
                  description={
                    degraded
                      ? 'The standup ran on limited data and could not break down any aggregate activity.'
                      : 'The standup ran but found no aggregated log activity to break down for this window.'
                  }
                />
              </CardContent>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- small helpers --- */

/** Map a severity label onto a bar color token class. */
function severityBar(label: string): string | undefined {
  switch (label.trim().toLowerCase()) {
    case 'critical':
      return 'bg-critical';
    case 'high':
      return 'bg-high';
    case 'medium':
    case 'moderate':
      return 'bg-medium';
    case 'low':
      return 'bg-low';
    case 'info':
    case 'informational':
      return 'bg-info';
    default:
      return undefined;
  }
}

interface BarCardProps {
  icon: typeof Hash;
  accent: string;
  title: string;
  items: BarListItem[];
}

/** A titled card wrapping a ranked BarList — the dashboard breakdown look. */
function BarCard({ icon: Icon, accent, title, items }: BarCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className={cn('h-4 w-4', accent)} aria-hidden />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <BarList items={items} format={fmtNumber} showPercent />
      </CardContent>
    </Card>
  );
}
