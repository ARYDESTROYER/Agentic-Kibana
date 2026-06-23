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
  EuiButtonGroup,
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
  PageHeader,
  RiskBadge,
  Skeleton,
  StatTile,
  StatusBadge,
  TrendStat,
  VerdictBadge,
} from '../common/ui';
import { BarList, DonutWithLegend, MiniBars } from '../common/charts';
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
  /** Sort for the recent-cases feed: by recency (default) or by risk. */
  const [recentSort, setRecentSort] = useState<'recent' | 'risk'>('recent');

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
  const recent = useMemo(() => {
    const sorted = [...cases].sort((a, b) =>
      recentSort === 'risk'
        ? (b.risk_score ?? -1) - (a.risk_score ?? -1)
        : (b.updated_at || '').localeCompare(a.updated_at || ''),
    );
    return sorted.slice(0, 6);
  }, [cases, recentSort]);
  // Primary source first, then alphabetical — a stable, scannable ordering.
  const enabledSources = useMemo(
    () =>
      sources
        .filter((s) => s.enabled)
        .sort((a, b) => {
          if (!!a.is_primary !== !!b.is_primary) return a.is_primary ? -1 : 1;
          return (a.display_name || a.id).localeCompare(b.display_name || b.id);
        }),
    [sources],
  );
  // Show the knowledge/memory tiles once at least one of the two calls returned.
  const hasKnowledge = rag !== null || memory !== null;

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="dashboardApp"
        eyebrow="Dashboard"
        title="Overview"
        description="Live triage posture across all sources."
        actions={<EuiButton size="s" iconType="refresh" onClick={load}>Refresh</EuiButton>}
      />

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
          <EuiSpacer size="m" />
          <EuiFlexGrid columns={2} gutterSize="m">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={180} radius={12} />
            ))}
          </EuiFlexGrid>
        </>
      ) : (
        <>
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
              <EuiSpacer size="m" />
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

          <EuiSpacer size="m" />

          <EuiFlexGrid columns={2} gutterSize="m">
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

          <EuiSpacer size="m" />

          <Card
            title="Recent cases"
            icon="securityApp"
            actions={
              <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                <EuiFlexItem grow={false}>
                  <EuiButtonGroup
                    legend="Sort recent cases"
                    buttonSize="compressed"
                    options={[
                      { id: 'recent', label: 'Recent' },
                      { id: 'risk', label: 'Risk' },
                    ]}
                    idSelected={recentSort}
                    onChange={(id) => setRecentSort(id as 'recent' | 'risk')}
                  />
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiButton size="s" iconType="list" onClick={() => onNavigate?.('cases')}>
                    View all
                  </EuiButton>
                </EuiFlexItem>
              </EuiFlexGroup>
            }
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
