/**
 * Overview — the at-a-glance SOC dashboard (default landing surface).
 *
 * Pulls recent cases (counts + verdict/risk breakdowns), 24h LLM spend, and the
 * configured sources, and renders them as KPI tiles + charts + a recent-cases
 * feed. Everything degrades gracefully when a backend call fails.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { Case, SourceInstance, UsageSummary } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, riskBand } from '../../lib/theme';
import { fmtMoney, fmtTokens, humanizeAge, humanizeToken } from '../../lib/format';
import {
  Card,
  ErrorCallout,
  Loading,
  RiskBadge,
  SectionHeader,
  StatusBadge,
  TrendStat,
  VerdictBadge,
} from '../common/ui';
import { BarList, DonutWithLegend, MiniBars } from '../common/charts';

interface OverviewProps {
  onNavigate?: (p: 'cases' | 'sources') => void;
}

export const OverviewPage: React.FC<OverviewProps> = ({ onNavigate }) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [sources, setSources] = useState<SourceInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, u, s] = await Promise.allSettled([
        api.listCases({ limit: 200 }),
        api.usageSummary(24),
        api.listSources(),
      ]);
      if (c.status === 'fulfilled') setCases(c.value.cases);
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
  const modelItems = useMemo(
    () => (usage?.by_model || []).slice(0, 5).map((m) => ({ label: m.key, value: m.cost })),
    [usage],
  );
  const recent = useMemo(
    () => [...cases].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 6),
    [cases],
  );
  const enabledSources = sources.filter((s) => s.enabled);

  return (
    <div>
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
        <Loading label="Loading dashboard…" />
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {recent.map((c) => (
                  <EuiFlexGroup key={c.case_id} alignItems="center" gutterSize="m" responsive={false} wrap>
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
                ))}
              </div>
            ) : (
              <EuiText size="s" color="subdued"><span>No cases yet.</span></EuiText>
            )}
          </Card>
        </>
      )}
    </div>
  );
};
