/**
 * Overview — the at-a-glance SOC dashboard (default landing surface).
 *
 * Pulls recent cases (counts + verdict/risk breakdowns), 24h LLM spend, and the
 * configured sources, and renders them as KPI tiles + charts + a recent-cases
 * feed. Everything degrades gracefully when a backend call fails.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiButton,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiText,
} from '@elastic/eui';
import type {
  Case,
  MemoryResponse,
  RagStats,
  SourceInstance,
  UsageSummary,
} from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, riskBand } from '../../lib/theme';
import { fmtMoney, fmtNumber, fmtTokens, humanizeAge, humanizeToken } from '../../lib/format';
import {
  Card,
  ErrorCallout,
  RiskBadge,
  Skeleton,
  StatTile,
  StatusBadge,
  TrendStat,
  VerdictBadge,
  WidgetEmptyState,
} from '../common/ui';
import { BarList, DonutWithLegend, MiniBars, StackedHistogram } from '../common/charts';
import type { HistogramBin } from '../common/charts';
import { CaseDetailFlyout } from '../Cases/CaseDetailFlyout';
import { CaseHoverCard } from '../Cases/CaseHoverCard';

interface OverviewProps {
  onNavigate?: (p: 'cases' | 'sources' | 'knowledge' | 'memory') => void;
}

/** A StatTile that navigates on click/Enter — used for the knowledge/memory
 *  at-a-glance tiles. Keyboard-accessible, matching the recent-cases anchors. */
const NavTile: React.FC<{
  label: string;
  value: React.ReactNode;
  icon: string;
  accent: string;
  onNavigate: () => void;
}> = ({ label, value, icon, accent, onNavigate }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onNavigate}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onNavigate();
      }
    }}
    aria-label={`Open ${label}`}
    className="socCard--clickable"
    style={{ cursor: 'pointer', borderRadius: 8, outline: 'none' }}
  >
    <StatTile label={label} value={value} icon={icon} accent={accent} />
  </div>
);

export const OverviewPage: React.FC<OverviewProps> = ({ onNavigate }) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [sources, setSources] = useState<SourceInstance[]>([]);
  // Point-in-time knowledge-base + memory health for the at-a-glance tiles.
  const [rag, setRag] = useState<RagStats | null>(null);
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [histRange, setHistRange] = useState<string>('24h');

  /** Page-level cache shared by every CaseHoverCard so hovers never re-fetch. */
  const caseCache = useRef<Map<string, Case>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // allSettled keeps every call independent — a failing RAG/memory fetch
      // (or any non-cases call) leaves its tile blank but never blanks the page.
      const [c, u, s, r, m] = await Promise.allSettled([
        api.listCases({ limit: 200 }),
        api.usageSummary(24),
        api.listSources(),
        api.ragStats(),
        api.getMemory(),
      ]);
      if (c.status === 'fulfilled') {
        setCases(c.value.cases);
        for (const k of c.value.cases) {
          if (!caseCache.current.has(k.case_id)) caseCache.current.set(k.case_id, k);
        }
      }
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

  const costSeries = useMemo(
    () => (usage?.cost_over_time || []).map((p) => p.cost),
    [usage],
  );
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

  const histRanges = ['24h', '7d', '30d'];

  const recent = useMemo(
    () => [...cases].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 6),
    [cases],
  );
  const enabledSources = sources.filter((s) => s.enabled);
  // Show the knowledge/memory tiles once at least one of the two calls returned.
  const hasKnowledge = rag !== null || memory !== null;

  return (
    <div className="socPageEnter" style={{ padding: '12px 24px 16px' }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>Overview</h1>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>Live triage posture across all sources.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Last updated: just now</span>
          <button
            onClick={load}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px',
              border: '1px solid var(--border-input)', background: 'var(--bg-card)', color: 'var(--text-primary)',
              borderRadius: 6, fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <>
          <ErrorCallout error={error} title="Could not load the dashboard" />
          <div style={{ height: 16 }} />
        </>
      ) : null}

      {loading ? (
        <>
          <div className="socKpiGrid" style={{ marginBottom: 12 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={90} radius={12} />
            ))}
          </div>
          <Skeleton height={170} radius={12} />
          <div style={{ height: 12 }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={140} radius={12} />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="socWireframeCard" style={{ padding: '6px 14px 8px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Alerts over time</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {histRanges.map(r => (
                  <button
                    key={r}
                    onClick={() => setHistRange(r)}
                    style={{
                      height: 26, padding: '0 10px',
                      border: `1px solid ${histRange === r ? 'var(--soc-accent)' : 'var(--border-input)'}`,
                      background: histRange === r ? 'var(--soc-accent)' : 'var(--bg-card)',
                      color: histRange === r ? '#fff' : 'var(--text-primary)',
                      borderRadius: 4, fontFamily: 'inherit', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <StackedHistogram data={histData} />
            <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 6 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.semantic.safe, flex: 'none' }}></span>False positive
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.semantic.needsReview, flex: 'none' }}></span>Needs human
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.semantic.threat, flex: 'none' }}></span>True positive
              </span>
            </div>
          </div>

          <div className="socKpiGrid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
            <TrendStat label="Open cases" value={stats.open} icon="folderOpen" accent={COLORS.semantic.operational} />
            <TrendStat label="Needs human" value={stats.needsHuman} icon="alert" accent={COLORS.semantic.needsReview} />
            <TrendStat label="True positives" value={stats.truePositive} icon="bug" accent={COLORS.semantic.threat} />
            <TrendStat
              label="LLM spend (24h)"
              value={fmtMoney(usage?.total_cost, usage?.currency)}
              sub={`${fmtTokens(usage?.total_tokens)} tokens`}
              icon="currency"
              accent={COLORS.semantic.ai}
              spark={costSeries}
            />
          </div>

          {hasKnowledge ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
              <NavTile
                label="RAG documents"
                value={fmtNumber(rag?.document_count)}
                icon="documents"
                accent="#E8ECF1"
                onNavigate={() => onNavigate?.('knowledge')}
              />
              <NavTile
                label="RAG chunks"
                value={fmtNumber(rag?.total_chunks)}
                icon="visText"
                accent="#E8ECF1"
                onNavigate={() => onNavigate?.('knowledge')}
              />
              <NavTile
                label="Memory facts"
                value={fmtNumber(memory?.count)}
                icon="bell"
                accent="#E8ECF1"
                onNavigate={() => onNavigate?.('memory')}
              />
            </div>
          ) : null}

          <EuiFlexGrid columns={2} gutterSize="s">
            <Card title="Verdict breakdown" icon="visPie" accent={COLORS.semantic.operational}>
              {verdictSegments.length ? (
                <DonutWithLegend
                  segments={verdictSegments}
                  centerValue={cases.length}
                  centerLabel="cases"
                />
              ) : (
                <WidgetEmptyState
                  icon="visPie"
                  title="No verdict data yet"
                  description="Start ingesting alerts to build verdict analytics."
                  accent={COLORS.semantic.operational}
                />
              )}
            </Card>

            <Card title="Risk distribution" icon="visBarVertical" accent={COLORS.semantic.threat}>
              {riskItems.some(r => r.value > 0) ? (
                <BarList items={riskItems} />
              ) : (
                <WidgetEmptyState
                  icon="visBarVertical"
                  title="No risk data yet"
                  description="Risk scores will populate after case analysis."
                  accent={COLORS.semantic.threat}
                />
              )}
            </Card>

            <Card
              title="LLM spend (24h)"
              icon="visLine"
              accent={COLORS.semantic.ai}
              actions={<EuiText size="xs" color="subdued"><span>{fmtMoney(usage?.total_cost, usage?.currency)}</span></EuiText>}
            >
              {costSeries.length > 1 ? <MiniBars values={costSeries} color={COLORS.semantic.ai} height={40} /> : null}
              {modelItems.length ? (
                <BarList items={modelItems} format={(v) => fmtMoney(v, usage?.currency)} />
              ) : (
                <WidgetEmptyState
                  icon="visLine"
                  title="No spend in the last 24h"
                  description="LLM costs will appear after agent runs."
                  accent={COLORS.semantic.ai}
                />
              )}
            </Card>

            <Card
              title="Sources"
              icon="logstashQueue"
              accent={COLORS.semantic.safe}
              actions={<EuiButton size="s" iconType="plusInCircle" onClick={() => onNavigate?.('sources')}>Manage</EuiButton>}
            >
              {enabledSources.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {enabledSources.slice(0, 6).map((s) => (
                    <EuiFlexGroup key={s.id} alignItems="center" gutterSize="s" responsive={false}>
                      <EuiFlexItem>
                        <EuiText size="s">
                          <strong>{s.display_name || s.id}</strong>{' '}
                          <EuiText size="xs" color="subdued" component="span">
                            {humanizeToken(s.source_type)}
                          </EuiText>
                        </EuiText>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiHealth color={s.is_primary ? COLORS.semantic.operational : COLORS.semantic.safe}>
                          {s.is_primary ? 'Primary' : 'Enabled'}
                        </EuiHealth>
                      </EuiFlexItem>
                    </EuiFlexGroup>
                  ))}
                </div>
              ) : (
                <WidgetEmptyState
                  icon="logstashQueue"
                  title="No sources configured"
                  description="Connect Elasticsearch, OpenSearch, Wazuh or custom webhook source."
                  accent={COLORS.semantic.safe}
                  action={<EuiButton size="s" iconType="plusInCircle" onClick={() => onNavigate?.('sources')}>Add Source</EuiButton>}
                />
              )}
            </Card>
          </EuiFlexGrid>

          <div style={{ height: 12 }} />

          <Card
            title="Recent cases"
            icon="securityApp"
            actions={<EuiButton size="s" iconType="list" onClick={() => onNavigate?.('cases')}>View all</EuiButton>}
          >
            {recent.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {recent.map((c) => (
                  <CaseHoverCard
                    key={c.case_id}
                    caseId={c.case_id}
                    preloaded={c}
                    cache={caseCache}
                    display="block"
                    anchor={
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedCaseId(c.case_id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedCaseId(c.case_id);
                          }
                        }}
                        aria-label={`Open case ${c.title || c.case_id}`}
                        className="socCard--clickable"
                        style={{
                          cursor: 'pointer',
                          borderRadius: 12,
                          padding: '6px 8px',
                          outline: 'none',
                        }}
                      >
                        <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false} wrap>
                          <EuiFlexItem>
                            <EuiText size="s"><strong>{c.title || c.case_id}</strong></EuiText>
                            <EuiText size="xs" color="subdued">
                              <span>{c.entity ? `${c.entity.type}:${c.entity.value}` : '—'} · {humanizeAge(c.updated_at || c.created_at)}</span>
                            </EuiText>
                          </EuiFlexItem>
                          <EuiFlexItem grow={false}><RiskBadge score={c.risk_score} /></EuiFlexItem>
                          <EuiFlexItem grow={false}><VerdictBadge verdict={c.verdict} /></EuiFlexItem>
                          <EuiFlexItem grow={false}><StatusBadge status={c.status} /></EuiFlexItem>
                        </EuiFlexGroup>
                      </div>
                    }
                  />
                ))}
              </div>
            ) : (
              <div style={{ padding: '4px 0' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px 80px 100px', gap: 0, padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <span>Case ID</span>
                  <span>Severity</span>
                  <span>Source</span>
                  <span>Status</span>
                  <span>Created</span>
                </div>
                <div style={{ padding: '20px 0', textAlign: 'center' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>No cases yet</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>Cases will appear as alerts are triaged.</div>
                  <EuiButton size="s" iconType="play" onClick={() => onNavigate?.('cases')}>Run Test Scan</EuiButton>
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      {selectedCaseId ? (
        <CaseDetailFlyout
          caseId={selectedCaseId}
          onClose={() => setSelectedCaseId(null)}
          onChanged={load}
        />
      ) : null}
    </div>
  );
};
