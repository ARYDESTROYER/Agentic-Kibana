import React, { useEffect, useState } from 'react';
import {
  EuiBasicTable,
  EuiBasicTableColumn,
  EuiButton,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiStat,
  EuiTitle,
  EuiText,
} from '@elastic/eui';
import type { UsageSummary } from '../../common';
import type { TlsocApi } from '../lib/api';

interface CostProps {
  api: TlsocApi;
}

function fmtMoney(v: number | undefined, currency?: string): string {
  if (typeof v !== 'number') return '-';
  return `${currency || '$'}${v.toFixed(4)}`;
}

function breakdownTable(
  title: string,
  items: Array<{ key: string; cost: number; tokens: number; calls: number }> | undefined,
  currency?: string
) {
  if (!items || items.length === 0) return null;
  return (
    <EuiFlexItem>
      <EuiPanel hasBorder paddingSize="s">
        <EuiTitle size="xxs">
          <h4>{title}</h4>
        </EuiTitle>
        <EuiSpacer size="xs" />
        <EuiBasicTable
          items={items.map((i, idx) => ({ id: idx, ...i }))}
          columns={
            [
              { field: 'key', name: 'Key', truncateText: true },
              {
                field: 'cost',
                name: 'Cost',
                render: (c: number) => fmtMoney(c, currency),
                width: '110px',
              },
              { field: 'tokens', name: 'Tokens', width: '90px' },
              { field: 'calls', name: 'Calls', width: '70px' },
            ] as Array<EuiBasicTableColumn<any>>
          }
          tableLayout="auto"
        />
      </EuiPanel>
    </EuiFlexItem>
  );
}

/**
 * Simple bar representation of cost over time without pulling in @elastic/charts
 * (keeps the bundle small and the build reliable).
 */
function CostOverTime({ data, currency }: { data?: Array<{ ts: string; cost: number }>; currency?: string }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.cost), 0.0000001);
  return (
    <EuiPanel hasBorder paddingSize="s">
      <EuiTitle size="xxs">
        <h4>Cost over time</h4>
      </EuiTitle>
      <EuiSpacer size="xs" />
      {data.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ width: 160, fontSize: 11, color: '#69707D' }}>{d.ts}</div>
          <div style={{ flex: 1, background: '#F1F4FA', borderRadius: 3, marginRight: 8 }}>
            <div
              style={{
                width: `${Math.max((d.cost / max) * 100, 1)}%`,
                background: '#54B399',
                height: 14,
                borderRadius: 3,
              }}
            />
          </div>
          <div style={{ width: 90, fontSize: 11, textAlign: 'right' }}>{fmtMoney(d.cost, currency)}</div>
        </div>
      ))}
    </EuiPanel>
  );
}

export const Cost: React.FC<CostProps> = ({ api }) => {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<UsageSummary>('usage/summary', { window_hours: 24 });
      setData(resp);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currency = data?.currency;

  return (
    <div>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="s">
            <h2>Cost &amp; Tokens (24h)</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton size="s" iconType="refresh" onClick={load} isLoading={loading}>
            Refresh
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="m" />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="s" />
        </>
      ) : null}

      {data ? (
        <>
          <EuiFlexGroup>
            <EuiFlexItem>
              <EuiPanel hasBorder paddingSize="s">
                <EuiStat title={fmtMoney(data.today_cost, currency)} description="Today's spend" titleSize="m" />
              </EuiPanel>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiPanel hasBorder paddingSize="s">
                <EuiStat title={data.total_tokens ?? 0} description="Total tokens" titleSize="m" />
              </EuiPanel>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiPanel hasBorder paddingSize="s">
                <EuiStat title={data.call_count ?? 0} description="Call count" titleSize="m" />
              </EuiPanel>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiPanel hasBorder paddingSize="s">
                <EuiStat title={fmtMoney(data.total_cost, currency)} description="Total cost (window)" titleSize="m" />
              </EuiPanel>
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiSpacer size="m" />
          <EuiFlexGroup wrap>
            {breakdownTable('By model', data.by_model, currency)}
            {breakdownTable('By role', data.by_role, currency)}
            {breakdownTable('By surface', data.by_surface, currency)}
          </EuiFlexGroup>

          <EuiSpacer size="m" />
          <CostOverTime data={data.cost_over_time} currency={currency} />

          {data.top_cost_drivers && data.top_cost_drivers.length > 0 ? (
            <>
              <EuiSpacer size="m" />
              <EuiPanel hasBorder paddingSize="s">
                <EuiTitle size="xxs">
                  <h4>Top cost drivers</h4>
                </EuiTitle>
                <EuiSpacer size="xs" />
                <EuiBasicTable
                  items={data.top_cost_drivers.map((d, idx) => ({ id: idx, ...d }))}
                  columns={
                    Object.keys(data.top_cost_drivers[0] || {}).map((k) => ({
                      field: k,
                      name: k,
                      truncateText: true,
                      render: (v: any) => (v === null || v === undefined ? '' : String(v)),
                    })) as Array<EuiBasicTableColumn<any>>
                  }
                  tableLayout="auto"
                />
              </EuiPanel>
            </>
          ) : null}
        </>
      ) : (
        <EuiText color="subdued">
          <p>Loading usage summary...</p>
        </EuiText>
      )}
    </div>
  );
};
