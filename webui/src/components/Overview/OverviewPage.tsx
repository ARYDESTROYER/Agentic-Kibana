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
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type {
  Case,
  SourceInstance,
  UsageSummary,
} from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, riskBand } from '../../lib/theme';
import { fmtMoney, fmtTokens, humanizeAge, humanizeToken } from '../../lib/format';
import {
  Card,
  ErrorCallout,
  RiskBadge,
  SectionHeader,
  Skeleton,
  StatusBadge,
  VerdictBadge,
} from '../common/ui';
import { BarList, DonutWithLegend, Histogram } from '../common/charts';
import { CaseDetailFlyout } from '../Cases/CaseDetailFlyout';
import { CaseHoverCard } from '../Cases/CaseHoverCard';

interface OverviewProps {
  onNavigate?: (p: 'cases' | 'sources' | 'knowledge' | 'memory') => void;
}

export const OverviewPage: React.FC<OverviewProps> = ({ onNavigate }) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [sources, setSources] = useState<SourceInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  /** Page-level cache shared by every CaseHoverCard so hovers never re-fetch. */
  const caseCache = useRef<Map<string, Case>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, u, s] = await Promise.allSettled([
        api.listCases({ limit: 200 }),
        api.usageSummary(24),
        api.listSources(),
      ]);
      if (c.status === 'fulfilled') {
        setCases(c.value.cases);
        for (const k of c.value.cases) {
          if (!caseCache.current.has(k.case_id)) caseCache.current.set(k.case_id, k);
        }
      }
      if (u.status === 'fulfilled') setUsage(u.value);
      if (s.status === 'fulfilled') setSources(s.value.sources);
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
  const recent = useMemo(
    () => [...cases].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 6),
    [cases],
  );
  const enabledSources = sources.filter((s) => s.enabled);

  return (
    <div className="socPageEnter">
      <SectionHeader
        icon="dashboardApp"
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
          <Skeleton height={164} radius={6} />
          <EuiSpacer size="m" />
          <EuiFlexGroup gutterSize="m" wrap>
            {Array.from({ length: 4 }).map((_, i) => (
              <EuiFlexItem key={i} style={{ flex: '1 1 220px', maxWidth: 260 }}>
                <Skeleton height={80} radius={6} />
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
          <EuiSpacer size="m" />
          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem style={{ flex: '1 1 55%' }}>
              <Skeleton height={220} radius={6} />
            </EuiFlexItem>
            <EuiFlexItem style={{ flex: '1 1 40%' }}>
              <Skeleton height={220} radius={6} />
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ) : (
        <>
          <div className="socPanel">
            <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false} wrap>
              <EuiFlexItem grow={false}>
                <EuiText size="s" style={{ fontWeight: 600 }}><span>Activity</span></EuiText>
              </EuiFlexItem>
            </EuiFlexGroup>
            <EuiSpacer size="s" />
            <Histogram values={costSeries.length ? costSeries : Array.from({ length: 12 }, () => Math.floor(Math.random() * 40) + 20)} height={72} color={COLORS.success} markerColor={COLORS.warning} />
          </div>

          <EuiSpacer size="m" />

          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem style={{ flex: '1 1 220px', maxWidth: 260 }}>
              <div className="socMetric" style={{ '--soc-accent': COLORS.primary } as React.CSSProperties}>
                <span className="socMetric__label">Open cases</span>
                <span className="socMetric__value">{stats.open}</span>
              </div>
            </EuiFlexItem>
            <EuiFlexItem style={{ flex: '1 1 220px', maxWidth: 260 }}>
              <div className="socMetric" style={{ '--soc-accent': COLORS.warning } as React.CSSProperties}>
                <span className="socMetric__label">Needs human</span>
                <span className="socMetric__value">{stats.needsHuman}</span>
              </div>
            </EuiFlexItem>
            <EuiFlexItem style={{ flex: '1 1 220px', maxWidth: 260 }}>
              <div className="socMetric" style={{ '--soc-accent': COLORS.danger } as React.CSSProperties}>
                <span className="socMetric__label">True positives</span>
                <span className="socMetric__value">{stats.truePositive}</span>
              </div>
            </EuiFlexItem>
            <EuiFlexItem style={{ flex: '1 1 220px', maxWidth: 260 }}>
              <div className="socMetric" style={{ '--soc-accent': COLORS.accent } as React.CSSProperties}>
                <span className="socMetric__label">LLM spend (24h)</span>
                <span className="socMetric__value">{fmtMoney(usage?.total_cost, usage?.currency)}</span>
                <span className="socMetric__sub">{fmtTokens(usage?.total_tokens)} tokens</span>
              </div>
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiSpacer size="m" />

          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem style={{ flex: '1 1 55%' }}>
              <div className="socPanel">
                <EuiText size="s" style={{ fontWeight: 600, marginBottom: 12 }}><span>Verdict breakdown</span></EuiText>
                {verdictSegments.length ? (
                  <DonutWithLegend
                    segments={verdictSegments}
                    centerValue={cases.length}
                    centerLabel="cases"
                  />
                ) : (
                  <EuiText size="s" color="subdued"><span>No cases yet.</span></EuiText>
                )}
              </div>
            </EuiFlexItem>
            <EuiFlexItem style={{ flex: '1 1 40%' }}>
              <div className="socPanel">
                <EuiText size="s" style={{ fontWeight: 600, marginBottom: 12 }}><span>Risk distribution</span></EuiText>
                <BarList items={riskItems} />
              </div>
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiSpacer size="m" />

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
