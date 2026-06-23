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
  EuiSpacer,
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
    <div className="socPageEnter" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: '#1A1C21' }}>Overview</h1>
          <p style={{ margin: '5px 0 0', fontSize: 13, color: '#69707D' }}>Live triage posture across all sources.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: '#98A2B3' }}>Last updated: just now</span>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: 7, height: 34, padding: '0 14px', border: '1px solid #006BB4', background: '#fff', color: '#006BB4', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#006BB4" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <>
          <ErrorCallout error={error} title="Could not load the dashboard" />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {loading ? (
        <>
          <EuiFlexGroup gutterSize="m" wrap>
            {Array.from({ length: 4 }).map((_, i) => (
              <EuiFlexItem key={i}>
                <Skeleton height={84} radius={10} />
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
          <EuiSpacer size="l" />
          <EuiFlexGrid columns={2} gutterSize="l">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={180} radius={10} />
            ))}
          </EuiFlexGrid>
        </>
      ) : (
        <>
          <div style={{ background: '#fff', border: '1px solid #D3DAE6', borderRadius: 6, padding: '16px 0', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, padding: '0 16px' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#1A1C21' }}>Alerts over time</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {histRanges.map(r => (
                  <button
                    key={r}
                    onClick={() => setHistRange(r)}
                    style={{
                      height: 28, padding: '0 12px',
                      border: `1px solid ${histRange === r ? '#006BB4' : '#D3DAE6'}`,
                      background: histRange === r ? '#006BB4' : '#fff',
                      color: histRange === r ? '#fff' : '#343741',
                      borderRadius: 6, fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <StackedHistogram data={histData} />
            <div style={{ display: 'flex', gap: 24, justifyContent: 'center', marginTop: 10, padding: '0 16px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#69707D' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: '#00BFB3', flex: 'none' }}></span>False positive
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#69707D' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: '#F5A623', flex: 'none' }}></span>Needs human
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#69707D' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: '#BD271E', flex: 'none' }}></span>True positive
              </span>
            </div>
          </div>

          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem>
              <TrendStat label="Open cases" value={stats.open} icon="folderOpen" accent={COLORS.primary} />
            </EuiFlexItem>
            <EuiFlexItem>
              <TrendStat label="Needs human" value={stats.needsHuman} icon="alert" accent={COLORS.warning} />
            </EuiFlexItem>
            <EuiFlexItem>
              <TrendStat label="True positives" value={stats.truePositive} icon="bug" accent={COLORS.danger} />
            </EuiFlexItem>
            <EuiFlexItem>
              <TrendStat
                label="LLM spend (24h)"
                value={fmtMoney(usage?.total_cost, usage?.currency)}
                sub={`${fmtTokens(usage?.total_tokens)} tokens`}
                icon="currency"
                accent={COLORS.accent}
                spark={costSeries}
              />
            </EuiFlexItem>
          </EuiFlexGroup>

          {hasKnowledge ? (
            <>
              <EuiSpacer size="l" />
              <EuiFlexGroup gutterSize="m" wrap>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <NavTile
                    label="RAG documents"
                    value={fmtNumber(rag?.document_count)}
                    icon="documents"
                    accent={COLORS.primary}
                    onNavigate={() => onNavigate?.('knowledge')}
                  />
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <NavTile
                    label="RAG chunks"
                    value={fmtNumber(rag?.total_chunks)}
                    icon="visText"
                    accent={COLORS.accent}
                    onNavigate={() => onNavigate?.('knowledge')}
                  />
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <NavTile
                    label="Memory facts"
                    value={fmtNumber(memory?.count)}
                    icon="bell"
                    accent={COLORS.warning}
                    onNavigate={() => onNavigate?.('memory')}
                  />
                </EuiFlexItem>
              </EuiFlexGroup>
            </>
          ) : null}

          <EuiSpacer size="l" />

          <EuiFlexGrid columns={2} gutterSize="l">
            <Card title="Verdict breakdown" icon="visPie" accent={COLORS.primary}>
              {verdictSegments.length ? (
                <DonutWithLegend
                  segments={verdictSegments}
                  centerValue={cases.length}
                  centerLabel="cases"
                />
              ) : (
                <EuiText size="s" color="subdued"><span>No cases yet.</span></EuiText>
              )}
            </Card>

            <Card title="Risk distribution" icon="visBarVertical" accent="#e2725b">
              <BarList items={riskItems} />
            </Card>

            <Card
              title="LLM spend (24h)"
              icon="visLine"
              accent={COLORS.accent}
              actions={<EuiText size="xs" color="subdued"><span>{fmtMoney(usage?.total_cost, usage?.currency)}</span></EuiText>}
            >
              {costSeries.length > 1 ? <MiniBars values={costSeries} color={COLORS.accent} height={56} /> : null}
              <EuiSpacer size="m" />
              {modelItems.length ? (
                <BarList items={modelItems} format={(v) => fmtMoney(v, usage?.currency)} />
              ) : (
                <EuiText size="s" color="subdued"><span>No spend recorded in the last 24h.</span></EuiText>
              )}
            </Card>

            <Card
              title="Sources"
              icon="logstashQueue"
              accent={COLORS.success}
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
                        <EuiHealth color={s.is_primary ? COLORS.primary : COLORS.success}>
                          {s.is_primary ? 'Primary' : 'Enabled'}
                        </EuiHealth>
                      </EuiFlexItem>
                    </EuiFlexGroup>
                  ))}
                </div>
              ) : (
                <EuiText size="s" color="subdued"><span>No sources configured — add one to start ingesting.</span></EuiText>
              )}
            </Card>
          </EuiFlexGrid>

          <EuiSpacer size="l" />

          <Card
            title="Recent cases"
            icon="securityApp"
            actions={<EuiButton size="s" iconType="list" onClick={() => onNavigate?.('cases')}>View all</EuiButton>}
          >
            {recent.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                          borderRadius: 8,
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
              <EuiText size="s" color="subdued"><span>No cases yet.</span></EuiText>
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
