import React, { useState } from 'react';
import {
  EuiBasicTable,
  EuiButton,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { StandupResponse } from '../../common';
import { fmtNumber } from '../lib/format';
import type { TlsocApi } from '../lib/api';
import { COLORS, EmptyState, SectionHeader, StatTile, tint } from './ui';

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

function keyCountTable(
  title: string,
  items?: Array<{ key: string; count: number }>,
  icon = 'list'
) {
  if (!items || items.length === 0) {
    return null;
  }
  return (
    <EuiFlexItem style={{ minWidth: 280 }}>
      <EuiPanel hasBorder paddingSize="m" className="tlsocCard" style={{ height: '100%' }}>
        {/* Card header: accented icon chip + title (matches the shared rhythm). */}
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
          <EuiFlexItem grow={false}>
            <span
              className="tlsocIconChip"
              style={{ background: tint(COLORS.primary, 0.14), color: COLORS.primary }}
            >
              <EuiIcon type={icon} size="m" />
            </span>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiTitle size="xxs">
              <h3>{title}</h3>
            </EuiTitle>
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiSpacer size="s" />
        <EuiBasicTable
          items={items.map((i, idx) => ({ id: idx, ...i }))}
          columns={[
            {
              field: 'key',
              name: 'Key',
              truncateText: true,
              // Subtle styling so the dimension value reads as the primary cell.
              render: (key: string) => <strong title={key}>{key}</strong>,
            },
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
function recordCountTable(title: string, record?: Record<string, number>, icon = 'list') {
  if (!record) {
    return null;
  }
  const items = Object.entries(record).map(([key, count]) => ({
    key,
    count: typeof count === 'number' ? count : Number(count) || 0,
  }));
  return keyCountTable(title, items, icon);
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
      <SectionHeader
        icon="reportingApp"
        title="Daily Standup"
        description="An aggregate-then-summarise brief of the last 24h — no raw logs are sent to the model."
        actions={
          <EuiButton fill iconType="play" onClick={load} isLoading={loading}>
            Load standup
          </EuiButton>
        }
      />

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
              <EuiPanel hasBorder paddingSize="m" className="tlsocCard">
                {/* Panel header: accented icon chip + title (shared rhythm). */}
                <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <span
                      className="tlsocIconChip"
                      style={{ background: tint(COLORS.primary, 0.14), color: COLORS.primary }}
                    >
                      <EuiIcon type="documentEdit" size="m" />
                    </span>
                  </EuiFlexItem>
                  <EuiFlexItem grow={false}>
                    <EuiTitle size="xxs">
                      <h3>Summary</h3>
                    </EuiTitle>
                  </EuiFlexItem>
                </EuiFlexGroup>
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
                    <StatTile
                      label="Total events"
                      value={fmtNumber(agg.total_events ?? 0)}
                      icon="visBarVerticalStacked"
                      accent={COLORS.primary}
                    />
                  </EuiFlexItem>
                  <EuiFlexItem>
                    <StatTile
                      label="Unique IPs"
                      value={fmtNumber(agg.unique_ips ?? 0)}
                      icon="globe"
                      accent={COLORS.accent}
                    />
                  </EuiFlexItem>
                  <EuiFlexItem>
                    {/* BUG-3: `cases` is an OBJECT — render the scalar `opened` count. */}
                    <StatTile
                      label="Cases opened"
                      value={fmtNumber(agg.cases?.opened ?? 0)}
                      icon="folderOpen"
                      accent={COLORS.success}
                    />
                  </EuiFlexItem>
                </EuiFlexGroup>

                <EuiSpacer size="m" />
                <EuiFlexGroup wrap>
                  {keyCountTable('Top rules', agg.by_rule, 'inspect')}
                  {keyCountTable('Top source IPs', agg.top_source_ips, 'globe')}
                  {keyCountTable('Top users', agg.top_users, 'user')}
                  {keyCountTable('Top hosts', agg.top_hosts, 'storage')}
                  {/* BUG-3: render the case breakdowns as key/count tables. */}
                  {recordCountTable('Cases by verdict', agg.cases?.by_verdict, 'tag')}
                  {recordCountTable('Cases by status', agg.cases?.by_status, 'folderOpen')}
                </EuiFlexGroup>
              </>
            ) : null}
          </>
        ) : (
          <EmptyState
            iconType="reportingApp"
            title="No standup loaded"
            body="Load the standup to see the prose summary and aggregates."
          />
        )}
      </ErrorBoundary>
    </div>
  );
};
