/**
 * Cost & usage — the LLM spend dashboard. Every model call goes through the single
 * gateway and lands in the cost ledger; this surface reads GET /api/usage/summary
 * and turns it into trend KPIs, a spend-over-time series, and ranked breakdowns by
 * model / role / surface plus the top individual cost drivers.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonGroup,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import type { UsageSummary } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, chartColor, TYPE } from '../../lib/theme';
import { DASH, fmtMoney, fmtNumber, fmtTokens, humanizeToken } from '../../lib/format';
import { BarList, DonutWithLegend, MiniBars, Sparkline } from '../common/charts';
import type { Segment } from '../common/charts';
import {
  Card,
  EmptyState,
  ErrorCallout,
  IconChip,
  PageHeader,
  Skeleton,
  TrendStat,
} from '../common/ui';

type UsageRow = { key: string; cost: number; tokens: number; calls: number };

const WINDOWS = [
  { id: '24', label: '24h', hours: 24 },
  { id: '168', label: '7d', hours: 168 },
  { id: '720', label: '30d', hours: 720 },
] as const;

/**
 * Best-effort percentage change of the most-recent half of the spend series vs
 * the earlier half — a proxy for "this window vs the previous window" when the
 * backend gives us only a single time series. Returns undefined when there
 * aren't enough buckets, or the baseline is zero, to make the delta meaningful.
 */
function trendDelta(series: number[]): number | undefined {
  if (!Array.isArray(series) || series.length < 4) return undefined;
  const mid = Math.floor(series.length / 2);
  const prev = series.slice(0, mid).reduce((s, v) => s + v, 0);
  const curr = series.slice(mid).reduce((s, v) => s + v, 0);
  if (prev <= 0) return undefined;
  return Math.round(((curr - prev) / prev) * 100);
}

/** Map ledger `by_*` rows to cost-valued chart segments. */
function costSegments(rows: UsageRow[] | undefined, palette = false): Segment[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.cost === 'number')
    .map((r, i) => ({
      label: humanizeToken(r.key) ?? r.key,
      value: r.cost,
      color: palette ? chartColor(i) : undefined,
    }));
}

export const CostPage: React.FC = () => {
  const [windowId, setWindowId] = useState<string>('24');
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const hours = useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.hours ?? 24,
    [windowId],
  );
  const windowLabel = useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.label ?? '24h',
    [windowId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.usageSummary(hours));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void load();
  }, [load]);

  const currency = data?.currency;
  const series = useMemo(
    () =>
      Array.isArray(data?.cost_over_time)
        ? data!.cost_over_time!
            .filter((p) => p && typeof p.cost === 'number')
            .map((p) => p.cost)
        : [],
    [data],
  );

  const spendDelta = useMemo(() => trendDelta(series), [series]);

  const byModel = useMemo(() => costSegments(data?.by_model as UsageRow[]), [data]);
  const byRole = useMemo(() => costSegments(data?.by_role as UsageRow[]), [data]);
  const bySurface = useMemo(() => costSegments(data?.by_surface as UsageRow[], true), [data]);
  const topDrivers = (data?.top_cost_drivers as UsageRow[]) || [];

  const hasAny =
    (data?.call_count ?? 0) > 0 ||
    (data?.total_cost ?? 0) > 0 ||
    byModel.length > 0 ||
    series.length > 0;

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="visLine"
        eyebrow="Spend"
        title="Cost & usage"
        description="LLM spend metered through the single gateway cost ledger."
        actions={
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButtonGroup
                legend="Time window"
                buttonSize="s"
                options={WINDOWS.map((w) => ({ id: w.id, label: w.label }))}
                idSelected={windowId}
                onChange={(id) => setWindowId(id)}
              />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton size="s" iconType="refresh" onClick={() => void load()} isLoading={loading}>
                Refresh
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        }
      />

      {error ? (
        <>
          <ErrorCallout error={error} title="Could not load usage" />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {loading ? (
        <>
          <EuiFlexGroup gutterSize="m" wrap responsive={false}>
            {[0, 1, 2, 3].map((i) => (
              <EuiFlexItem key={i} style={{ minWidth: 220 }}>
                <Skeleton height={96} radius={8} />
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
          <EuiSpacer size="l" />
          <div className="socGrid">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={200} radius={8} />
            ))}
          </div>
        </>
      ) : !hasAny ? (
        <EmptyState
          iconType="visLine"
          title="No LLM spend recorded yet"
          body={`Nothing went through the gateway in the last ${windowLabel}. As the agent triages cases, cost and token usage will appear here.`}
        />
      ) : (
        <>
          {/* Hero — total spend for the window. */}
          <EuiPanel
            hasBorder
            paddingSize="l"
            className="socCard"
            style={{ borderTop: `3px solid ${COLORS.primary}` }}
          >
            <EuiFlexGroup gutterSize="l" alignItems="center" responsive={false} wrap>
              <EuiFlexItem grow={false}>
                <IconChip icon="currency" accent={COLORS.primary} large />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  <span>Total spend · last {windowLabel}</span>
                </EuiText>
                <EuiFlexGroup gutterSize="s" alignItems="baseline" responsive={false} wrap={false}>
                  <EuiFlexItem grow={false}>
                    <div
                      style={{
                        fontSize: TYPE.kpiLg,
                        fontWeight: 700,
                        lineHeight: 1.1,
                        color: COLORS.primary,
                      }}
                    >
                      {fmtMoney(data?.total_cost, currency)}
                    </div>
                  </EuiFlexItem>
                  {typeof spendDelta === 'number' ? (
                    <EuiFlexItem grow={false}>
                      <EuiToolTip content="Change vs the earlier half of this window">
                        <span
                          style={{
                            color: spendDelta > 0 ? COLORS.danger : COLORS.success,
                            fontSize: TYPE.label,
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {spendDelta > 0 ? '▲' : '▼'} {Math.abs(spendDelta)}%
                        </span>
                      </EuiToolTip>
                    </EuiFlexItem>
                  ) : null}
                </EuiFlexGroup>
                <EuiText size="xs" color="subdued">
                  <span>
                    {fmtTokens(data?.total_tokens)} tokens · {fmtNumber(data?.call_count)} calls
                  </span>
                </EuiText>
              </EuiFlexItem>
              {series.length > 1 ? (
                <EuiFlexItem style={{ minWidth: 180 }}>
                  <Sparkline values={series} color={COLORS.primary} height={56} />
                </EuiFlexItem>
              ) : null}
            </EuiFlexGroup>
          </EuiPanel>

          <EuiSpacer size="l" />

          {/* KPI row */}
          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label={`Total cost (${windowLabel})`}
                value={fmtMoney(data?.total_cost, currency)}
                icon="currency"
                accent={COLORS.primary}
                spark={series.length > 1 ? series : undefined}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="Total tokens"
                value={fmtTokens(data?.total_tokens)}
                icon="visGauge"
                accent={COLORS.accent}
                sub={`across ${fmtNumber(data?.call_count)} calls`}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="LLM calls"
                value={fmtNumber(data?.call_count)}
                icon="compute"
                accent={COLORS.success}
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="Today's cost"
                value={fmtMoney(data?.today_cost, currency)}
                icon="clock"
                accent={COLORS.warning}
              />
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiSpacer size="l" />

          {/* Charts grid */}
          <div className="socGrid">
            <Card title="Spend over time" icon="visArea" accent={COLORS.primary}>
              {series.length > 1 ? (
                <>
                  <MiniBars values={series} color={COLORS.primary} height={120} />
                  <EuiSpacer size="xs" />
                  <EuiText size="xs" color="subdued">
                    <span>{`${series.length} buckets over the last ${windowLabel}`}</span>
                  </EuiText>
                </>
              ) : (
                <EuiText size="s" color="subdued">
                  <span>Not enough data points to chart a trend.</span>
                </EuiText>
              )}
            </Card>

            <Card title="By model" icon="machineLearningApp" accent={COLORS.accent}>
              {byModel.length ? (
                <BarList items={byModel} format={(n) => fmtMoney(n, currency)} />
              ) : (
                <EuiText size="s" color="subdued">
                  <span>{DASH}</span>
                </EuiText>
              )}
            </Card>

            <Card title="By role" icon="users" accent={COLORS.warning}>
              {byRole.length ? (
                <BarList items={byRole} format={(n) => fmtMoney(n, currency)} />
              ) : (
                <EuiText size="s" color="subdued">
                  <span>{DASH}</span>
                </EuiText>
              )}
            </Card>

            <Card title="By surface" icon="appsApp" accent={COLORS.success}>
              {bySurface.length ? (
                <DonutWithLegend
                  segments={bySurface}
                  centerValue={fmtMoney(data?.total_cost, currency)}
                  centerLabel="total"
                />
              ) : (
                <EuiText size="s" color="subdued">
                  <span>{DASH}</span>
                </EuiText>
              )}
            </Card>
          </div>

          {topDrivers.length ? (
            <>
              <EuiSpacer size="l" />
              <Card title="Top cost drivers" icon="sortDown" accent={COLORS.danger}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {topDrivers.slice(0, 10).map((d, i) => (
                    <EuiFlexGroup
                      key={`${d.key}-${i}`}
                      gutterSize="m"
                      alignItems="center"
                      responsive={false}
                    >
                      <EuiFlexItem grow={false}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 3,
                            background: chartColor(i),
                            display: 'inline-block',
                          }}
                        />
                      </EuiFlexItem>
                      <EuiFlexItem>
                        <EuiText size="s">
                          <span style={{ wordBreak: 'break-word' }}>
                            {humanizeToken(d.key) ?? d.key}
                          </span>
                        </EuiText>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiText size="xs" color="subdued">
                          <span>{fmtTokens(d.tokens)} tok</span>
                        </EuiText>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiText size="xs" color="subdued">
                          <span>{fmtNumber(d.calls)} calls</span>
                        </EuiText>
                      </EuiFlexItem>
                      <EuiFlexItem grow={false}>
                        <EuiText size="s">
                          <strong>{fmtMoney(d.cost, currency)}</strong>
                        </EuiText>
                      </EuiFlexItem>
                    </EuiFlexGroup>
                  ))}
                </div>
              </Card>
            </>
          ) : null}
        </>
      )}
    </div>
  );
};
