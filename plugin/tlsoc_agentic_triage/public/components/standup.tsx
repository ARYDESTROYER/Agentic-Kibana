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

/**
 * BUG-3 guard: a small error boundary so a future server-shape mismatch shows a
 * message instead of blanking the entire tab (React throws "Objects are not
 * valid as a React child" when a non-primitive leaks into JSX). Class component
 * because componentDidCatch has no hooks equivalent.
 */
interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('Standup render error', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <EuiCallOut color="danger" size="s" title="Could not render standup">
          <EuiText size="s">
            <p>The standup data could not be displayed. Try reloading the standup.</p>
          </EuiText>
        </EuiCallOut>
      );
    }
    return this.props.children;
  }
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

/**
 * BUG-3: render a `Record<string, number>` (e.g. cases.by_verdict / by_status)
 * as a small key/count table by normalising it to the `{key, count}[]` shape the
 * existing `keyCountTable` helper expects.
 */
function recordCountTable(title: string, record?: Record<string, number>) {
  if (!record) {
    return null;
  }
  const items = Object.entries(record).map(([key, count]) => ({
    key,
    count: typeof count === 'number' ? count : Number(count) || 0,
  }));
  return keyCountTable(title, items);
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

      <ErrorBoundary>
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
                      <EuiStat
                        title={agg.total_events ?? 0}
                        description="Total events"
                        titleSize="m"
                      />
                    </EuiPanel>
                  </EuiFlexItem>
                  <EuiFlexItem>
                    <EuiPanel hasBorder paddingSize="s">
                      <EuiStat title={agg.unique_ips ?? 0} description="Unique IPs" titleSize="m" />
                    </EuiPanel>
                  </EuiFlexItem>
                  <EuiFlexItem>
                    <EuiPanel hasBorder paddingSize="s">
                      {/* BUG-3: `cases` is an OBJECT — render the scalar `opened` count. */}
                      <EuiStat
                        title={agg.cases?.opened ?? 0}
                        description="Cases opened"
                        titleSize="m"
                      />
                    </EuiPanel>
                  </EuiFlexItem>
                </EuiFlexGroup>

                <EuiSpacer size="m" />
                <EuiFlexGroup wrap>
                  {keyCountTable('Top rules', agg.by_rule)}
                  {keyCountTable('Top source IPs', agg.top_source_ips)}
                  {keyCountTable('Top users', agg.top_users)}
                  {keyCountTable('Top hosts', agg.top_hosts)}
                  {/* BUG-3: render the case breakdowns as key/count tables. */}
                  {recordCountTable('Cases by verdict', agg.cases?.by_verdict)}
                  {recordCountTable('Cases by status', agg.cases?.by_status)}
                </EuiFlexGroup>
              </>
            ) : null}
          </>
        ) : (
          <EuiText color="subdued">
            <p>Load the standup to see the prose summary and aggregates.</p>
          </EuiText>
        )}
      </ErrorBoundary>
    </div>
  );
};
