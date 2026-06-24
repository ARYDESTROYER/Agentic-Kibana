/**
 * Overview — the at-a-glance SOC dashboard (default landing surface).
 *
 * Pulls recent cases (counts + verdict/risk breakdowns), 24h LLM spend, the
 * configured sources, and the approval queue depth, and renders them as KPI
 * tiles + an autonomy-posture strip + charts + a recent-cases feed. Everything
 * degrades gracefully when a backend call fails.
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
  ProposalsResponse,
  RagStats,
  SourceInstance,
  UsageSummary,
} from '../../lib/types';
import type { Navigate } from '../Shell/Shell';
import { api } from '../../lib/api';
import { COLORS, riskBand, riskBandColor } from '../../lib/theme';
import { fmtMoney, fmtNumber, fmtTokens, humanizeAge, humanizeToken } from '../../lib/format';
import {
  Card,
  ErrorCallout,
  NavTile,
  PageHeader,
  PostureBadge,
  RiskBadge,
  SectionHeader,
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
  /** Drill-through navigation (widened to the shell's Navigate so we can pass
   *  a status filter to the cases list — back-compatible with `(p)=>void`). */
  onNavigate?: Navigate;
}

/** True when a closed case was closed automatically by policy (vs by a human). */
function isAutoClosed(c: Case): boolean {
  if ((c.status || '').toLowerCase() !== 'closed') return false;
  const by = (c.decision_by || '').toLowerCase();
  return by.includes('auto') || by.includes('policy') || by.includes('case_manager');
}

/** True when `ts` falls within the last `hours` hours. */
function withinHours(ts?: string, hours = 24): boolean {
  if (!ts) return false;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= hours * 3_600_000;
}

export const OverviewPage: React.FC<OverviewProps> = ({ onNavigate }) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [sources, setSources] = useState<SourceInstance[]>([]);
  // Point-in-time knowledge-base + memory health for the at-a-glance tiles.
  const [rag, setRag] = useState<RagStats | null>(null);
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  // The agent's pending approval queue (for the autonomy-posture strip).
  const [proposals, setProposals] = useState<ProposalsResponse | null>(null);
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
      // allSettled keeps every call independent — a failing RAG/memory/proposals
      // fetch leaves its tile blank but never blanks the whole page.
      const [c, u, s, r, m, p] = await Promise.allSettled([
        api.listCases({ limit: 200 }),
        api.usageSummary(24),
        api.listSources(),
        api.ragStats(),
        api.getMemory(),
        api.listProposals('pending'),
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
      if (p.status === 'fulfilled') setProposals(p.value);
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
    // Status queue depths (lifecycle) — kept SEPARATE from the verdict mix so
    // the "Needs human" KPI reflects the queue, not how many got that verdict.
    let open = 0,
      needsHumanQueue = 0,
      closed = 0;
    // Verdict-class counts (what the AI concluded) — drive the donut.
    let truePositive = 0,
      falsePositive = 0,
      needsHumanVerdict = 0,
      unverdicted = 0;
    // Autonomy posture (how cases got where they are), last 24h.
    let autoClosed24h = 0;
    // Risk bands — now including an explicit "Unknown" bucket for unscored cases.
    const bands = { Low: 0, Medium: 0, High: 0, Critical: 0, Unknown: 0 } as Record<string, number>;
    for (const c of cases) {
      const st = (c.status || '').toLowerCase();
      if (st === 'open') open += 1;
      else if (st === 'needs_human') needsHumanQueue += 1;
      else if (st === 'closed') closed += 1;

      const v = (c.verdict || '').toUpperCase();
      if (v.includes('TRUE')) truePositive += 1;
      else if (v.includes('FALSE')) falsePositive += 1;
      else if (v.includes('NEEDS') || v.includes('INCONCLUSIVE') || v.includes('UNKNOWN'))
        needsHumanVerdict += 1;
      else unverdicted += 1;

      if (isAutoClosed(c) && withinHours(c.updated_at, 24)) autoClosed24h += 1;

      const b = riskBand(c.risk_score).label; // "Unknown" for unscored
      if (b in bands) bands[b] += 1;
    }
    const awaitingApproval = proposals?.count ?? proposals?.proposals?.length ?? 0;
    return {
      open,
      needsHumanQueue,
      closed,
      truePositive,
      falsePositive,
      needsHumanVerdict,
      unverdicted,
      autoClosed24h,
      awaitingApproval,
      bands,
    };
  }, [cases, proposals]);

  // The verdict donut is driven by VERDICT-class counts (decoupled from the
  // status queue depths above).
  const verdictSegments = useMemo(
    () => [
      { label: 'True positive', value: stats.truePositive, color: COLORS.danger },
      { label: 'False positive', value: stats.falsePositive, color: COLORS.success },
      { label: 'Needs human', value: stats.needsHumanVerdict, color: COLORS.warning },
      { label: 'Unverdicted', value: stats.unverdicted, color: COLORS.subdued },
    ].filter((s) => s.value > 0),
    [stats],
  );

  const riskItems = useMemo(
    () => [
      { label: 'Low', value: stats.bands.Low, color: riskBandColor(10) },
      { label: 'Medium', value: stats.bands.Medium, color: riskBandColor(45) },
      { label: 'High', value: stats.bands.High, color: riskBandColor(70) },
      { label: 'Critical', value: stats.bands.Critical, color: riskBandColor(90) },
      // Honest "Unknown" band for unscored cases (subdued via riskBandColor()).
      { label: 'Unknown', value: stats.bands.Unknown, color: riskBandColor(undefined) },
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
              <NavTile
                label="Open cases"
                value={stats.open}
                icon="folderOpen"
                accent={COLORS.primary}
                onClick={onNavigate ? () => onNavigate('cases', { status: 'open' }) : undefined}
                ariaLabel="View open cases"
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <NavTile
                label="Needs human"
                value={stats.needsHumanQueue}
                icon="alert"
                accent={COLORS.warning}
                onClick={
                  onNavigate ? () => onNavigate('cases', { status: 'needs_human' }) : undefined
                }
                ariaLabel="View cases that need a human"
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <NavTile
                label="True positives"
                value={stats.truePositive}
                icon="bug"
                accent={COLORS.danger}
                onClick={onNavigate ? () => onNavigate('cases') : undefined}
                ariaLabel="View cases"
              />
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

          {/* ---- Agent activity & autonomy posture strip ---- */}
          <EuiSpacer size="m" />
          <SectionHeader
            icon="machineLearningApp"
            accent={COLORS.success}
            title="Agent activity & autonomy"
            description="How the spine is resolving cases — what closed itself, what it escalated, and what is waiting on you."
          />
          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem>
              <StatTile
                label="Auto-closed (24h)"
                value={stats.autoClosed24h}
                icon="checkInCircleFilled"
                accent={COLORS.success}
                sub={<PostureBadge posture="auto_closed" />}
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <NavTile
                label="Escalated to human"
                value={stats.needsHumanQueue}
                icon="warning"
                accent={COLORS.warning}
                sub={<PostureBadge posture="needs_human" />}
                onClick={
                  onNavigate ? () => onNavigate('cases', { status: 'needs_human' }) : undefined
                }
                ariaLabel="View cases that need a human"
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <NavTile
                label="Awaiting approval"
                value={stats.awaitingApproval}
                icon="flag"
                accent={COLORS.accent}
                sub={<PostureBadge posture="awaiting_approval" />}
                onClick={onNavigate ? () => onNavigate('proposals') : undefined}
                ariaLabel="Open the approval queue"
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
                    onClick={onNavigate ? () => onNavigate('knowledge') : undefined}
                    ariaLabel="Open the knowledge base"
                  />
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <NavTile
                    label="RAG chunks"
                    value={fmtNumber(rag?.total_chunks)}
                    icon="visText"
                    accent={COLORS.accent}
                    onClick={onNavigate ? () => onNavigate('knowledge') : undefined}
                    ariaLabel="Open the knowledge base"
                  />
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 200 }}>
                  <NavTile
                    label="Memory facts"
                    value={fmtNumber(memory?.count)}
                    icon="memory"
                    accent={COLORS.warning}
                    onClick={onNavigate ? () => onNavigate('memory') : undefined}
                    ariaLabel="Open agent memory"
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
                  title="Verdict breakdown"
                />
              ) : (
                <EuiText size="s" color="subdued"><span>No cases yet.</span></EuiText>
              )}
            </Card>

            <Card title="Risk distribution" icon="visBarVertical" accent={COLORS.clay}>
              <BarList items={riskItems} title="Risk distribution" />
            </Card>

            <Card
              title="LLM spend (24h)"
              icon="visLine"
              accent={COLORS.accent}
              actions={<EuiText size="xs" color="subdued"><span>{fmtMoney(usage?.total_cost, usage?.currency)}</span></EuiText>}
            >
              {costSeries.length > 1 ? <MiniBars values={costSeries} color={COLORS.accent} height={56} title="LLM spend over time (24h)" /> : null}
              <EuiSpacer size="m" />
              {modelItems.length ? (
                <BarList items={modelItems} format={(v) => fmtMoney(v, usage?.currency)} title="LLM spend by model" />
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
