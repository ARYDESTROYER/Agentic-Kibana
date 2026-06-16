import React, { useState } from 'react';
import {
  EuiBasicTable,
  EuiButton,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiStat,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { StandupResponse } from '../../common';
import type { TlsocApi } from '../lib/api';

interface StandupProps {
  api: TlsocApi;
}

function keyCountTable(title: string, items?: Array<{ key: string; count: number }>) {
  if (!items || items.length === 0) {
    return null;
  }
  return (
    <EuiFlexItem>
      <EuiPanel hasBorder paddingSize="s">
        <EuiTitle size="xxs">
          <h4>{title}</h4>
        </EuiTitle>
        <EuiSpacer size="xs" />
        <EuiBasicTable
          items={items.map((i, idx) => ({ id: idx, ...i }))}
          columns={[
            { field: 'key', name: 'Key', truncateText: true },
            { field: 'count', name: 'Count', width: '90px' },
          ]}
          tableLayout="auto"
        />
      </EuiPanel>
    </EuiFlexItem>
  );
}

export const Standup: React.FC<StandupProps> = ({ api }) => {
  const [data, setData] = useState<StandupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<StandupResponse>('standup', { window_hours: 24 });
      setData(resp);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const agg = data?.aggregate;

  return (
    <div>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="s">
            <h2>Daily Standup</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton fill iconType="play" onClick={load} isLoading={loading}>
            Load standup
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
          {data.summary ? (
            <EuiPanel hasBorder>
              <EuiTitle size="xs">
                <h3>Summary</h3>
              </EuiTitle>
              <EuiSpacer size="s" />
              <EuiText size="s">
                <p style={{ whiteSpace: 'pre-wrap' }}>{data.summary}</p>
              </EuiText>
            </EuiPanel>
          ) : null}

          {agg ? (
            <>
              <EuiSpacer size="m" />
              <EuiFlexGroup>
                <EuiFlexItem>
                  <EuiPanel hasBorder paddingSize="s">
                    <EuiStat title={agg.total_events ?? 0} description="Total events" titleSize="m" />
                  </EuiPanel>
                </EuiFlexItem>
                <EuiFlexItem>
                  <EuiPanel hasBorder paddingSize="s">
                    <EuiStat title={agg.unique_ips ?? 0} description="Unique IPs" titleSize="m" />
                  </EuiPanel>
                </EuiFlexItem>
                <EuiFlexItem>
                  <EuiPanel hasBorder paddingSize="s">
                    <EuiStat title={agg.cases ?? 0} description="Cases" titleSize="m" />
                  </EuiPanel>
                </EuiFlexItem>
              </EuiFlexGroup>

              <EuiSpacer size="m" />
              <EuiFlexGroup wrap>
                {keyCountTable('Top rules', agg.by_rule)}
                {keyCountTable('Top source IPs', agg.top_source_ips)}
                {keyCountTable('Top users', agg.top_users)}
                {keyCountTable('Top hosts', agg.top_hosts)}
              </EuiFlexGroup>
            </>
          ) : null}
        </>
      ) : (
        <EuiText color="subdued">
          <p>Load the standup to see the prose summary and aggregates.</p>
        </EuiText>
      )}
    </div>
  );
};
