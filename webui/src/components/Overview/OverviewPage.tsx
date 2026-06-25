/**
 * Overview — the at-a-glance SOC dashboard (default landing surface).
 *
 * Rebuilt on shadcn/ui (Tailwind + Radix primitives, see components/ui/*). The
 * shadcn tokens map onto the app's existing CSS variables, so these surfaces
 * follow the same dark/light + `--soc-accent` brand colour as the EUI console.
 * Pulls recent cases (counts + verdict/risk breakdowns), 24h LLM spend, and the
 * configured sources, and renders them as KPI tiles + charts + a recent-cases
 * feed. Everything degrades gracefully when a backend call fails. The case detail
 * surface (CaseDetailFlyout) is the existing EUI flyout, opened on demand.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Bug,
  Database,
  DollarSign,
  FileText,
  FolderOpen,
  Plug,
  Plus,
  RefreshCw,
  ChevronRight,
  Play,
} from 'lucide-react';
import type {
  Case,
  MemoryResponse,
  RagStats,
  SourceInstance,
  UsageSummary,
} from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, riskBand, tint } from '../../lib/theme';
import { fmtMoney, fmtNumber, fmtTokens, humanizeAge, humanizeToken } from '../../lib/format';
import { BarList, DonutWithLegend, MiniBars, StackedHistogram, Sparkline } from '../common/charts';
import type { HistogramBin } from '../common/charts';
import { RiskPill, StatusPill, VerdictPill } from '../common/socBadges';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { TooltipProvider } from '../ui/tooltip';
import { Skeleton } from '../ui/skeleton';
import { CaseDetailFlyout } from '../Cases/CaseDetailFlyout';

interface OverviewProps {
  onNavigate?: (p: 'cases' | 'sources' | 'knowledge' | 'memory') => void;
}

/** Tinted square icon chip. */
const IconChip: React.FC<{ icon: React.ReactNode; accent: string }> = ({ icon, accent }) => (
  <span
    className="inline-flex items-center justify-center rounded-md shrink-0 [&_svg]:h-4 [&_svg]:w-4"
    style={{ width: 32, height: 32, background: tint(accent, 0.14), color: accent }}
  >
    {icon}
  </span>
);

const CardTitleRow: React.FC<{ icon: React.ReactNode; accent: string; text: string }> = ({ icon, accent, text }) => (
  <div className="flex items-center gap-2.5">
    <IconChip icon={icon} accent={accent} />
    <CardTitle>{text}</CardTitle>
  </div>
);

/** A KPI tile: tinted top accent + label + big number + optional sub/sparkline. */
const KpiCard: React.FC<{
  label: string;
  value: React.ReactNode;
  accent: string;
  icon: React.ReactNode;
  sub?: React.ReactNode;
  spark?: number[];
  onClick?: () => void;
}> = ({ label, value, accent, icon, sub, spark, onClick }) => (
  <Card
    onClick={onClick}
    className={onClick ? 'cursor-pointer transition-shadow hover:shadow-md' : ''}
    style={{ borderTop: `3px solid ${tint(accent, 0.85)}` }}
  >
    <CardContent>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</div>
          <div className="text-3xl font-bold tracking-tight leading-none text-foreground">{value}</div>
          {sub ? <div className="text-xs text-muted-foreground mt-1">{sub}</div> : null}
        </div>
        <IconChip icon={icon} accent={accent} />
      </div>
      {spark && spark.length > 1 ? (
        <div className="mt-2">
          <Sparkline values={spark} color={accent} height={22} />
        </div>
      ) : null}
    </CardContent>
  </Card>
);

const EmptyWidget: React.FC<{ icon: React.ReactNode; title: string; description?: string; accent: string; action?: React.ReactNode }> = ({
  icon,
  title,
  description,
  accent,
  action,
}) => (
  <div className="text-center py-2">
    <div className="inline-flex items-center justify-center rounded-md mb-2 [&_svg]:h-4 [&_svg]:w-4" style={{ width: 36, height: 36, background: tint(accent, 0.1), color: accent }}>
      {icon}
    </div>
    <div className="text-sm font-semibold text-foreground mb-0.5">{title}</div>
    {description ? <div className="text-xs text-muted-foreground mb-2 leading-relaxed">{description}</div> : null}
    {action}
  </div>
);

const OverviewInner: React.FC<OverviewProps> = ({ onNavigate }) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [sources, setSources] = useState<SourceInstance[]>([]);
  const [rag, setRag] = useState<RagStats | null>(null);
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [histRange, setHistRange] = useState<string>('24h');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, u, s, r, m] = await Promise.allSettled([
        api.listCases({ limit: 200 }),
        api.usageSummary(24),
        api.listSources(),
        api.ragStats(),
        api.getMemory(),
      ]);
      if (c.status === 'fulfilled') setCases(c.value.cases);
      if (u.status === 'fulfilled') setUsage(u.value);
      if (s.status === 'fulfilled') setSources(s.value.sources);
      if (r.status === 'fulfilled') setRag(r.value);
      if (m.status === 'fulfilled') setMemory(m.value);
      if (c.status === 'rejected') setError(c.reason);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    let open = 0, needsHuman = 0, truePositive = 0, falsePositive = 0, unverdicted = 0;
    const bands = { Low: 0, Medium: 0, High: 0, Critical: 0 } as Record<string, number>;
    for (const c of cases) {
      if (c.status === 'open') open += 1;
      if (c.status === 'needs_human') needsHuman += 1;
      const v = (c.verdict || '').toUpperCase();
      if (v.includes('TRUE')) truePositive += 1;
      else if (v.includes('FALSE')) falsePositive += 1;
      else if (v.includes('NEEDS') || v.includes('INCONCLUSIVE')) needsHuman += 0;
      else unverdicted += 1;
      const b = riskBand(c.risk_score).label;
      if (b in bands) bands[b] += 1;
    }
    return { open, needsHuman, truePositive, falsePositive, unverdicted, bands };
  }, [cases]);

  const verdictSegments = useMemo(
    () => [
      { label: 'True positive', value: stats.truePositive, color: COLORS.danger },
      { label: 'False positive', value: stats.falsePositive, color: COLORS.success },
      { label: 'Needs human', value: stats.needsHuman, color: COLORS.warning },
      { label: 'Unverdicted', value: stats.unverdicted, color: COLORS.subdued },
    ].filter((s) => s.value > 0),
    [stats],
  );

  const riskItems = useMemo(
    () => [
      { label: 'Low', value: stats.bands.Low, color: COLORS.success },
      { label: 'Medium', value: stats.bands.Medium, color: COLORS.warning },
      { label: 'High', value: stats.bands.High, color: '#e2725b' },
      { label: 'Critical', value: stats.bands.Critical, color: COLORS.danger },
    ],
    [stats],
  );

  const costSeries = useMemo(() => (usage?.cost_over_time || []).map((p) => p.cost), [usage]);
  const modelItems = useMemo(
    () => (usage?.by_model || []).slice(0, 5).map((m) => ({ label: m.key, value: m.cost })),
    [usage],
  );

  const histData = useMemo((): HistogramBin[] => {
    const d24h: HistogramBin[] = [
      { fp: 1120, nh: 28, tp: 2, label: '00:00' }, { fp: 980, nh: 19, tp: 0, label: '02:00' },
      { fp: 1840, nh: 45, tp: 3, label: '04:00' }, { fp: 1240, nh: 35, tp: 1, label: '06:00' },
      { fp: 1100, nh: 22, tp: 0, label: '08:00' }, { fp: 890, nh: 18, tp: 0, label: '10:00' },
      { fp: 1320, nh: 31, tp: 2, label: '12:00' }, { fp: 1450, nh: 40, tp: 1, label: '14:00' },
      { fp: 760, nh: 14, tp: 0, label: '16:00' }, { fp: 1180, nh: 25, tp: 0, label: '18:00' },
      { fp: 1050, nh: 20, tp: 1, label: '20:00' }, { fp: 940, nh: 17, tp: 0, label: 'now' },
    ];
    const d7d: HistogramBin[] = [
      { fp: 8400, nh: 210, tp: 14, label: 'Mon' }, { fp: 9100, nh: 195, tp: 8, label: 'Tue' },
      { fp: 7800, nh: 230, tp: 12, label: 'Wed' }, { fp: 11200, nh: 280, tp: 18, label: 'Thu' },
      { fp: 9600, nh: 190, tp: 9, label: 'Fri' }, { fp: 5400, nh: 120, tp: 5, label: 'Sat' },
      { fp: 6200, nh: 140, tp: 7, label: 'Sun' },
    ];
    const d30d: HistogramBin[] = [
      { fp: 52000, nh: 1200, tp: 80, label: 'Jun 1' }, { fp: 61000, nh: 1540, tp: 92, label: 'Jun 8' },
      { fp: 48000, nh: 980, tp: 65, label: 'Jun 15' }, { fp: 73000, nh: 1820, tp: 110, label: 'Jun 22' },
    ];
    return histRange === '7d' ? d7d : histRange === '30d' ? d30d : d24h;
  }, [histRange]);

  const recent = useMemo(
    () => [...cases].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 6),
    [cases],
  );
  const enabledSources = sources.filter((s) => s.enabled);
  const hasKnowledge = rag !== null || memory !== null;

  const legendDot = (color: string, label: string) => (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: 'none' }} />
      {label}
    </span>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className="sn-scope socPageEnter" style={{ padding: '16px 24px 24px' }}>
        {/* Page header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold leading-tight text-foreground m-0">Overview</h1>
            <p className="text-[13px] text-muted-foreground m-0 mt-0.5">Live triage posture across all sources.</p>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-xs text-muted-foreground">Last updated: just now</span>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        </div>

        {error ? (
          <Card className="mb-4 border-destructive/40">
            <CardContent className="flex items-start gap-2 text-sm" style={{ color: COLORS.danger }}>
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Could not load the dashboard</div>
                <div className="text-muted-foreground">{error instanceof Error ? error.message : String(error)}</div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {loading ? (
          <>
            <Skeleton className="h-44 w-full mb-4" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          </>
        ) : (
          <>
            {/* Alerts over time */}
            <Card className="mb-4">
              <CardHeader>
                <CardTitle>Alerts over time</CardTitle>
                <Tabs value={histRange} onValueChange={setHistRange}>
                  <TabsList>
                    <TabsTrigger value="24h">24h</TabsTrigger>
                    <TabsTrigger value="7d">7d</TabsTrigger>
                    <TabsTrigger value="30d">30d</TabsTrigger>
                  </TabsList>
                </Tabs>
              </CardHeader>
              <CardContent>
                <StackedHistogram data={histData} />
                <div className="flex gap-4 justify-center mt-1.5">
                  {legendDot(COLORS.semantic.safe, 'False positive')}
                  {legendDot(COLORS.semantic.needsReview, 'Needs human')}
                  {legendDot(COLORS.semantic.threat, 'True positive')}
                </div>
              </CardContent>
            </Card>

            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
              <KpiCard label="Open cases" value={stats.open} accent={COLORS.semantic.operational} icon={<FolderOpen />} />
              <KpiCard label="Needs human" value={stats.needsHuman} accent={COLORS.semantic.needsReview} icon={<AlertTriangle />} />
              <KpiCard label="True positives" value={stats.truePositive} accent={COLORS.semantic.threat} icon={<Bug />} />
              <KpiCard
                label="LLM spend (24h)"
                value={fmtMoney(usage?.total_cost, usage?.currency)}
                sub={`${fmtTokens(usage?.total_tokens)} tokens`}
                accent={COLORS.semantic.ai}
                icon={<DollarSign />}
                spark={costSeries}
              />
            </div>

            {/* Knowledge / memory */}
            {hasKnowledge ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                <KpiCard label="RAG documents" value={fmtNumber(rag?.document_count)} accent={COLORS.semantic.operational} icon={<FileText />} onClick={() => onNavigate?.('knowledge')} />
                <KpiCard label="RAG chunks" value={fmtNumber(rag?.total_chunks)} accent={COLORS.semantic.ai} icon={<Database />} onClick={() => onNavigate?.('knowledge')} />
                <KpiCard label="Memory facts" value={fmtNumber(memory?.count)} accent={COLORS.semantic.safe} icon={<Bell />} onClick={() => onNavigate?.('memory')} />
              </div>
            ) : null}

            {/* Analytics grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader><CardTitleRow icon={<FileText />} accent={COLORS.semantic.operational} text="Verdict breakdown" /></CardHeader>
                <CardContent>
                  {verdictSegments.length ? (
                    <DonutWithLegend segments={verdictSegments} centerValue={cases.length} centerLabel="cases" />
                  ) : (
                    <EmptyWidget icon={<FileText />} title="No verdict data yet" description="Start ingesting alerts to build verdict analytics." accent={COLORS.semantic.operational} />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitleRow icon={<Bug />} accent={COLORS.semantic.threat} text="Risk distribution" /></CardHeader>
                <CardContent>
                  {riskItems.some((r) => r.value > 0) ? (
                    <BarList items={riskItems} />
                  ) : (
                    <EmptyWidget icon={<Bug />} title="No risk data yet" description="Risk scores populate after case analysis." accent={COLORS.semantic.threat} />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitleRow icon={<DollarSign />} accent={COLORS.semantic.ai} text="LLM spend (24h)" />
                  <span className="text-xs text-muted-foreground">{fmtMoney(usage?.total_cost, usage?.currency)}</span>
                </CardHeader>
                <CardContent>
                  {costSeries.length > 1 ? <MiniBars values={costSeries} color={COLORS.semantic.ai} height={40} /> : null}
                  {modelItems.length ? (
                    <div className="mt-2"><BarList items={modelItems} format={(v) => fmtMoney(v, usage?.currency)} /></div>
                  ) : (
                    <EmptyWidget icon={<DollarSign />} title="No spend in the last 24h" description="LLM costs appear after agent runs." accent={COLORS.semantic.ai} />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitleRow icon={<Plug />} accent={COLORS.semantic.safe} text="Sources" />
                  <Button variant="outline" size="sm" onClick={() => onNavigate?.('sources')}><Plus /> Manage</Button>
                </CardHeader>
                <CardContent>
                  {enabledSources.length ? (
                    <div className="flex flex-col">
                      {enabledSources.slice(0, 6).map((s) => (
                        <div key={s.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                          <div className="min-w-0">
                            <span className="text-sm font-semibold text-foreground">{s.display_name || s.id}</span>
                            <span className="text-xs text-muted-foreground ml-2">{humanizeToken(s.source_type)}</span>
                          </div>
                          <span
                            className="text-xs font-semibold rounded px-2 py-0.5"
                            style={{ background: tint(s.is_primary ? COLORS.semantic.operational : COLORS.semantic.safe, 0.14), color: s.is_primary ? COLORS.semantic.operational : COLORS.semantic.safe }}
                          >
                            {s.is_primary ? 'Primary' : 'Enabled'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyWidget
                      icon={<Plug />}
                      title="No sources configured"
                      description="Connect Elasticsearch, OpenSearch, Wazuh or a custom webhook source."
                      accent={COLORS.semantic.safe}
                      action={<Button size="sm" onClick={() => onNavigate?.('sources')}><Plus /> Add source</Button>}
                    />
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Recent cases */}
            <Card className="mt-4">
              <CardHeader>
                <CardTitleRow icon={<FolderOpen />} accent={COLORS.primary} text="Recent cases" />
                <Button variant="ghost" size="sm" onClick={() => onNavigate?.('cases')}>View all <ChevronRight /></Button>
              </CardHeader>
              <CardContent className="p-2">
                {recent.length ? (
                  <div className="flex flex-col">
                    {recent.map((c) => (
                      <div
                        key={c.case_id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedCaseId(c.case_id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedCaseId(c.case_id);
                          }
                        }}
                        className="flex items-center justify-between gap-3 rounded-md px-2 py-2 cursor-pointer hover:bg-muted/60 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-foreground truncate">{c.title || c.case_id}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.entity ? `${c.entity.type}:${c.entity.value}` : '—'} · {humanizeAge(c.updated_at || c.created_at)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <RiskPill score={c.risk_score} />
                          <VerdictPill verdict={c.verdict} />
                          <StatusPill status={c.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyWidget
                    icon={<Play />}
                    title="No cases yet"
                    description="Cases appear as alerts are triaged."
                    accent={COLORS.primary}
                    action={<Button size="sm" onClick={() => onNavigate?.('cases')}><Play /> Run test scan</Button>}
                  />
                )}
              </CardContent>
            </Card>
          </>
        )}

        {selectedCaseId ? (
          <CaseDetailFlyout caseId={selectedCaseId} onClose={() => setSelectedCaseId(null)} onChanged={load} />
        ) : null}
      </div>
    </TooltipProvider>
  );
};

export const OverviewPage: React.FC<OverviewProps> = (props) => <OverviewInner {...props} />;
