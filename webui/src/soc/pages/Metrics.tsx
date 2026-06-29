/**
 * Metrics — the triage analytics dashboard (new "command center" UI).
 *
 * Reads GET /api/metrics (windowed) and turns it into KPI tiles, a verdict donut,
 * persona/playbook bar lists, a cases-per-day trend, an analyst-feedback quality
 * panel, and a compact LLM-cost summary. RAG corpus + operator-memory health are
 * loaded alongside as point-in-time (NON-windowed) extras and are non-fatal: a
 * failure there leaves them null and the rest of the page still renders.
 *
 * Built entirely from the shared SOC primitives (ui/* + soc/components/*) + tokens,
 * so both the light and dark themes are first-class with no hardcoded hex. Every
 * label/value that is backend-derived is rendered as PLAIN text (UNTRUSTED-safe).
 */
import * as React from 'react';
import {
  BarChart3,
  Bot,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  Gauge,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  Timer,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { Metrics, MemoryResponse, RagStats } from '@/lib/types';
import {
  DASH,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTokens,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Button } from '@/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';
import { Separator } from '@/ui/separator';

import { PageHeader } from '@/soc/components/PageHeader';
import { KpiTile, type KpiAccent } from '@/soc/components/KpiTile';
import { StatCard } from '@/soc/components/StatCard';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { Stagger } from '@/soc/components/Stagger';
import { InlineCode } from '@/soc/components/CodeBlock';
import {
  DonutChart,
  MiniBars,
  TrendArea,
  type DonutSegment,
} from '@/soc/components/charts';
import { semanticColor, token } from '@/soc/components/palette';

import type { Navigate } from '@/soc/router';

// --------------------------------------------------------------------------- //
// Constants + helpers
// --------------------------------------------------------------------------- //
const WINDOWS = [
  { id: '24', label: '24h', hours: 24 },
  { id: '168', label: '7d', hours: 168 },
  { id: '720', label: '30d', hours: 720 },
] as const;

type WindowId = (typeof WINDOWS)[number]['id'];
type RankSort = 'count' | 'alpha';

/** Humanize a minutes value to a compact "Xd Yh" / "Xh Ym" / "Xm" string. */
function humanizeMinutes(mins?: number | null): string {
  if (typeof mins !== 'number' || Number.isNaN(mins) || mins <= 0) return DASH;
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  const rem = m % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

/** Map a humanized verdict-legend label to a Cases status filter for drill-through.
 *  Only "Needs human" maps to a real status queue; the other verdict classes have
 *  no 1:1 status, so they have no drill target. */
function verdictStatus(label: string): string | undefined {
  return label.toLowerCase().includes('needs human') ? 'needs_human' : undefined;
}

/** Turn a {label→count} record into colored bar-list items, ordered by count
 *  (default) or alphabetically. Labels are backend-derived → humanized plain text. */
function recordItems(
  rec: Record<string, number> | undefined,
  sort: RankSort = 'count',
): BarListItem[] {
  if (!rec) return [];
  const rows = Object.entries(rec).filter(
    ([, v]) => typeof v === 'number' && v > 0,
  );
  rows.sort((a, b) =>
    sort === 'alpha'
      ? humanizeToken(a[0]).localeCompare(humanizeToken(b[0]))
      : b[1] - a[1],
  );
  return rows.map(([k, v]) => ({
    label: humanizeToken(k),
    value: v,
    // Default gradient bar (`bg-accent-bar`) — keeps ranked lists visually consistent.
  }));
}

// --------------------------------------------------------------------------- //
// Loading skeleton
// --------------------------------------------------------------------------- //
const MetricsSkeleton: React.FC = () => (
  <div className="space-y-6">
    <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-[112px] w-full rounded-lg" />
      ))}
    </div>
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-[260px] w-full rounded-lg" />
      ))}
    </div>
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {Array.from({ length: 2 }).map((_, i) => (
        <Skeleton key={i} className="h-[240px] w-full rounded-lg" />
      ))}
    </div>
  </div>
);

// --------------------------------------------------------------------------- //
// Small section card with an icon + title.
// --------------------------------------------------------------------------- //
interface ChartCardProps {
  title: string;
  icon: LucideIcon;
  accentClass?: string;
  children: React.ReactNode;
  className?: string;
}

function ChartCard({
  title,
  icon: Icon,
  accentClass = 'text-primary',
  children,
  className,
}: ChartCardProps) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2.5 text-[0.8125rem] font-semibold">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface">
            <Icon className={cn('h-3.5 w-3.5', accentClass)} aria-hidden />
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}

/** Inline empty hint for a chart card (no data in the active window). */
function ChartEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center px-2 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
export interface MetricsProps {
  onNavigate?: Navigate;
}

export default function MetricsPage({ onNavigate }: MetricsProps) {
  const [windowId, setWindowId] = React.useState<WindowId>('168');
  const [rankSort, setRankSort] = React.useState<RankSort>('count');

  const [data, setData] = React.useState<Metrics | null>(null);
  // Point-in-time knowledge-base + memory health (NOT windowed). Non-fatal.
  const [rag, setRag] = React.useState<RagStats | null>(null);
  const [memory, setMemory] = React.useState<MemoryResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const hours = React.useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.hours ?? 168,
    [windowId],
  );
  const windowLabel = React.useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.label ?? '7d',
    [windowId],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The windowed metrics drive the page (a failure surfaces the error state).
      // RAG/memory are point-in-time extras — each wrapped so one failing never
      // blanks the dashboard.
      const [m, ragStats, mem] = await Promise.all([
        api.getMetrics(hours),
        api.ragStats().catch(() => null),
        api.getMemory().catch(() => null),
      ]);
      setData(m);
      setRag(ragStats);
      setMemory(mem);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // ---- derived series ---------------------------------------------------- //
  const verdictSegments = React.useMemo<DonutSegment[]>(() => {
    const bv = data?.by_verdict;
    if (!bv) return [];
    const entries: Array<[string, number]> = [
      ['TRUE_POSITIVE', bv.TRUE_POSITIVE ?? 0],
      ['FALSE_POSITIVE', bv.FALSE_POSITIVE ?? 0],
      ['NEEDS_HUMAN', bv.NEEDS_HUMAN ?? 0],
      ['none', bv.none ?? 0],
    ];
    return entries
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({
        label: k === 'none' ? 'Unverdicted' : humanizeToken(k),
        value: v,
        color: k === 'none' ? token('muted-foreground') : semanticColor(k),
      }));
  }, [data]);

  const personaItems = React.useMemo(
    () => recordItems(data?.persona_usage, rankSort),
    [data, rankSort],
  );
  const playbookItems = React.useMemo(
    () => recordItems(data?.playbook_usage, rankSort),
    [data, rankSort],
  );

  const perDay = React.useMemo(
    () =>
      Array.isArray(data?.cases_per_day)
        ? data!.cases_per_day.map((d) =>
            typeof d.count === 'number' ? d.count : 0,
          )
        : [],
    [data],
  );
  const perDayTotal = React.useMemo(
    () => perDay.reduce((s, x) => s + x, 0),
    [perDay],
  );

  const fb = data?.feedback;
  const cost = data?.cost;
  const currency = (cost?.currency as string | undefined) || undefined;

  const outcomeItems = React.useMemo(
    () => recordItems(fb?.outcome_distribution),
    [fb],
  );

  const costTrend = React.useMemo(() => {
    const series = cost?.cost_over_time;
    if (!Array.isArray(series)) return [];
    return series.map((p) => ({
      x: '',
      y: Number((p as { cost?: number }).cost) || 0,
    }));
  }, [cost]);

  // ---- knowledge base & memory (point-in-time) -------------------------- //
  const corpusItems = React.useMemo(
    () => recordItems(rag?.by_source, rankSort),
    [rag, rankSort],
  );

  const memoryEntries = React.useMemo(() => memory?.entries ?? [], [memory]);
  const activeMemoryCount = React.useMemo(
    () => memoryEntries.filter((e) => e.active).length,
    [memoryEntries],
  );
  const memorySegments = React.useMemo<DonutSegment[]>(() => {
    let human = 0;
    let agent = 0;
    let other = 0;
    for (const e of memoryEntries) {
      if (e.source === 'human') human += 1;
      else if (e.source === 'agent') agent += 1;
      else other += 1;
    }
    return [
      { label: 'Human', value: human, color: token('primary') },
      { label: 'Agent', value: agent, color: token('accent') },
      { label: 'Other', value: other, color: token('muted-foreground') },
    ].filter((s) => s.value > 0);
  }, [memoryEntries]);

  const hasKnowledge = rag !== null || memory !== null;
  const hasAny = (data?.total_cases ?? 0) > 0;

  // ---- header actions ---------------------------------------------------- //
  const header = (
    <PageHeader
      eyebrow="Analytics"
      icon={BarChart3}
      title="Metrics"
      description="Triage volume, verdict mix, agent routing, and analyst feedback quality."
      actions={
        <>
          {/* Time window toggle */}
          <div
            className="inline-flex rounded-md border border-border bg-surface p-1"
            role="group"
            aria-label="Time window"
          >
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setWindowId(w.id)}
                aria-pressed={windowId === w.id}
                className={cn(
                  'rounded-sm px-3 py-1 text-xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  windowId === w.id
                    ? 'bg-card text-foreground shadow-elev1'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {w.label}
              </button>
            ))}
          </div>

          {/* Rank sort toggle */}
          <div
            className="inline-flex rounded-md border border-border bg-surface p-1"
            role="group"
            aria-label="Sort ranked breakdowns"
          >
            {(
              [
                { id: 'count', label: 'Count' },
                { id: 'alpha', label: 'A–Z' },
              ] as const
            ).map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setRankSort(o.id)}
                aria-pressed={rankSort === o.id}
                className={cn(
                  'rounded-sm px-3 py-1 text-xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  rankSort === o.id
                    ? 'bg-card text-foreground shadow-elev1'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw
              className={cn('h-4 w-4', loading && 'animate-spin')}
              aria-hidden
            />
            Refresh
          </Button>
        </>
      }
    />
  );

  // ---- knowledge base & memory section ----------------------------------- //
  const knowledgeSection = hasKnowledge ? (
    <section className="space-y-5 pt-2">
      <Separator />
      <div className="flex items-start gap-3.5">
        <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-accent">
          <Database className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Knowledge base &amp; memory
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            RAG corpus and durable operator memory the agents draw on — current,
            independent of the time window above.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="RAG documents"
          value={fmtNumber(rag?.document_count)}
          icon={FileText}
          accent="primary"
        />
        <KpiTile
          label="RAG chunks"
          value={fmtNumber(rag?.total_chunks)}
          icon={Database}
          accent="info"
        />
        <KpiTile
          label="Embedding model"
          value={
            rag?.embedding_model ? (
              <InlineCode className="text-base">
                {rag.embedding_model}
              </InlineCode>
            ) : (
              DASH
            )
          }
          sub={
            typeof rag?.dim === 'number'
              ? `${fmtNumber(rag.dim)} dims`
              : undefined
          }
          icon={Sparkles}
          accent="info"
        />
        <KpiTile
          label="Memory facts"
          value={fmtNumber(memory?.count)}
          icon={Bot}
          accent="medium"
        />
        <KpiTile
          label="Active memory"
          value={memory ? fmtNumber(activeMemoryCount) : DASH}
          sub={memory ? `of ${fmtNumber(memory.count)}` : undefined}
          icon={CheckCircle2}
          accent="success"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard title="Corpus by source" icon={Database}>
          {corpusItems.length ? (
            <BarList
              items={corpusItems}
              format={(n) => fmtNumber(n)}
              showPercent
            />
          ) : (
            <ChartEmpty>
              {rag ? 'No RAG corpus indexed yet.' : 'Corpus stats unavailable.'}
            </ChartEmpty>
          )}
        </ChartCard>

        <ChartCard title="Memory by author" icon={Users} accentClass="text-medium">
          {memorySegments.length ? (
            <DonutChart
              segments={memorySegments}
              format={(n) => fmtNumber(n)}
              ariaLabel="Memory facts by author"
              center={
                <>
                  <span className="text-2xl font-bold tabular-nums text-foreground">
                    {fmtNumber(memory?.count)}
                  </span>
                  <span className="text-xs text-muted-foreground">facts</span>
                </>
              }
            />
          ) : (
            <ChartEmpty>
              {memory
                ? 'No memory facts recorded yet.'
                : 'Memory stats unavailable.'}
            </ChartEmpty>
          )}
        </ChartCard>
      </div>
    </section>
  ) : null;

  // ---- KPI definitions --------------------------------------------------- //
  interface KpiDef {
    key: string;
    label: string;
    value: React.ReactNode;
    sub?: string;
    icon: LucideIcon;
    accent: KpiAccent;
    onClick?: () => void;
  }

  const kpis: KpiDef[] = data
    ? [
        {
          key: 'total',
          label: `Total cases (${windowLabel})`,
          value: fmtNumber(data.total_cases),
          icon: ShieldCheck,
          accent: 'primary',
          onClick: onNavigate ? () => onNavigate('cases') : undefined,
        },
        {
          key: 'needs_human',
          label: 'Needs human',
          value: fmtNumber(data.needs_human_cases),
          icon: Users,
          accent: 'high',
          onClick: onNavigate
            ? () => onNavigate('cases', { status: 'needs_human' })
            : undefined,
        },
        {
          key: 'closed',
          label: 'Closed',
          value: fmtNumber(data.closed_cases),
          sub: `${fmtNumber(data.open_cases)} open`,
          icon: CheckCircle2,
          accent: 'success',
          onClick: onNavigate
            ? () => onNavigate('cases', { status: 'closed' })
            : undefined,
        },
        {
          key: 'mttr',
          label: 'MTTR',
          value: humanizeMinutes(data.mttr_minutes),
          sub: `${fmtNumber(data.resolved_count)} resolved`,
          icon: Clock,
          accent: 'info',
        },
        {
          key: 'agreement',
          label: 'Agreement rate',
          value:
            fb && fb.graded_cases > 0 ? fmtPercent(fb.agreement_rate) : DASH,
          sub: fb ? `${fmtNumber(fb.graded_cases)} graded` : undefined,
          icon: ThumbsUp,
          accent: 'success',
        },
        {
          key: 'risk',
          label: 'Avg risk',
          value:
            typeof data.avg_risk_score === 'number'
              ? Math.round(data.avg_risk_score)
              : DASH,
          icon: Gauge,
          accent: 'critical',
        },
      ]
    : [];

  return (
    <div className="animate-fade-in space-y-8">
      {header}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load metrics</AlertTitle>
          <AlertDescription>
            {error instanceof Error
              ? error.message
              : 'An unexpected error occurred while loading analytics.'}
          </AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <MetricsSkeleton />
      ) : !hasAny ? (
        <div className="space-y-8">
          <Card>
            <CardContent className="py-4">
              <EmptyState
                icon={BarChart3}
                title="No cases yet"
                description={`Nothing has been triaged in the last ${windowLabel}. As the agent processes alerts, volume, verdicts and feedback analytics will appear here.`}
              />
            </CardContent>
          </Card>
          {knowledgeSection}
        </div>
      ) : (
        <>
          {/* KPI row */}
          <Stagger
            className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6"
            step={40}
          >
            {kpis.map((k) => (
              <KpiTile
                key={k.key}
                label={k.label}
                value={k.value}
                sub={k.sub}
                icon={k.icon}
                accent={k.accent}
                onClick={k.onClick}
              />
            ))}
          </Stagger>

          {/* Charts grid */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-4">
            <ChartCard title="Verdict mix" icon={BarChart3}>
              {verdictSegments.length ? (
                <div className="space-y-3">
                  <DonutChart
                    segments={verdictSegments}
                    format={(n) => fmtNumber(n)}
                    ariaLabel="Verdict mix"
                    center={
                      <>
                        <span className="text-2xl font-bold tabular-nums text-foreground">
                          {fmtNumber(data?.total_cases)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          cases
                        </span>
                      </>
                    }
                  />
                  <ul className="flex flex-col divide-y divide-border border-t border-border">
                    {verdictSegments.map((s) => {
                      const status = verdictStatus(s.label);
                      const drillable = Boolean(status && onNavigate);
                      return (
                        <li
                          key={s.label}
                          className="flex items-center gap-2 py-1.5 text-xs"
                        >
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: s.color }}
                            aria-hidden
                          />
                          {drillable ? (
                            <button
                              type="button"
                              onClick={() =>
                                onNavigate!('cases', { status: status! })
                              }
                              className="truncate text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`View ${s.label} cases`}
                            >
                              {s.label}
                            </button>
                          ) : (
                            <span className="truncate text-muted-foreground">
                              {s.label}
                            </span>
                          )}
                          <span className="ml-auto font-mono font-semibold tabular-nums text-foreground">
                            {fmtNumber(s.value)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <ChartEmpty>No verdicts recorded in this window.</ChartEmpty>
              )}
            </ChartCard>

            <ChartCard title="Persona usage" icon={Users} accentClass="text-accent">
              {personaItems.length ? (
                <BarList
                  items={personaItems}
                  format={(n) => fmtNumber(n)}
                  showPercent
                />
              ) : (
                <ChartEmpty>No specialist routing recorded.</ChartEmpty>
              )}
            </ChartCard>

            <ChartCard
              title="Playbook usage"
              icon={FileText}
              accentClass="text-medium"
            >
              {playbookItems.length ? (
                <BarList
                  items={playbookItems}
                  format={(n) => fmtNumber(n)}
                  showPercent
                />
              ) : (
                <ChartEmpty>No playbooks selected in this window.</ChartEmpty>
              )}
            </ChartCard>

            <ChartCard
              title="Cases per day"
              icon={TrendingUp}
              accentClass="text-success"
            >
              {perDay.length > 1 ? (
                <div className="space-y-2">
                  <MiniBars
                    data={perDay}
                    colorToken="success"
                    height={140}
                    ariaLabel="Cases per day"
                  />
                  <p className="text-xs text-muted-foreground">
                    {`${perDay.length} days · ${fmtNumber(perDayTotal)} cases`}
                  </p>
                </div>
              ) : (
                <ChartEmpty>Not enough data points to chart a trend.</ChartEmpty>
              )}
            </ChartCard>
          </div>

          {/* Feedback quality + LLM cost */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ChartCard
              title="Analyst feedback quality"
              icon={ThumbsUp}
              accentClass="text-success"
            >
              {fb && fb.graded_cases > 0 ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <StatCard
                      label="Agreement"
                      value={fmtPercent(fb.agreement_rate)}
                      accent="success"
                    />
                    <StatCard
                      label="Time saved"
                      value={humanizeMinutes(fb.time_saved_minutes)}
                      accent="primary"
                    />
                  </div>
                  <BarList
                    items={[
                      {
                        label: 'Accuracy',
                        value: Math.round((fb.avg_accuracy || 0) * 100),
                        color: 'bg-success',
                      },
                      {
                        label: 'Reasoning quality',
                        value: Math.round(
                          (fb.avg_reasoning_quality || 0) * 100,
                        ),
                        color: 'bg-primary',
                      },
                      {
                        label: 'Action appropriateness',
                        value: Math.round(
                          (fb.avg_action_appropriateness || 0) * 100,
                        ),
                        color: 'bg-info',
                      },
                    ]}
                    format={(n) => `${n}%`}
                  />
                  {outcomeItems.length ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Recorded outcomes
                      </p>
                      <BarList
                        items={outcomeItems}
                        format={(n) => fmtNumber(n)}
                      />
                    </div>
                  ) : null}
                </div>
              ) : (
                <ChartEmpty>
                  No analyst feedback recorded yet. Grade closed cases to build
                  accuracy, reasoning and time-saved metrics here.
                </ChartEmpty>
              )}
            </ChartCard>

            <ChartCard
              title={`LLM cost (${windowLabel})`}
              icon={Timer}
              accentClass="text-medium"
            >
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <StatCard
                    label="Total cost"
                    value={fmtMoney(
                      cost?.total_cost as number | undefined,
                      currency,
                    )}
                    accent="medium"
                  />
                  <StatCard
                    label="Tokens"
                    value={fmtTokens(cost?.total_tokens as number | undefined)}
                    accent="info"
                  />
                  <StatCard
                    label="LLM calls"
                    value={fmtNumber(cost?.call_count as number | undefined)}
                    accent="primary"
                  />
                </div>
                {costTrend.length > 1 ? (
                  <div className="space-y-1">
                    <TrendArea
                      data={costTrend}
                      colorToken="medium"
                      height={120}
                      showXAxis={false}
                      format={(n) => fmtMoney(n, currency)}
                      ariaLabel="LLM spend over time"
                    />
                    <p className="text-xs text-muted-foreground">
                      LLM spend over the selected window.
                    </p>
                  </div>
                ) : (
                  <ChartEmpty>
                    Not enough spend data points to chart a trend.
                  </ChartEmpty>
                )}
              </div>
            </ChartCard>
          </div>

          {knowledgeSection}
        </>
      )}
    </div>
  );
}
