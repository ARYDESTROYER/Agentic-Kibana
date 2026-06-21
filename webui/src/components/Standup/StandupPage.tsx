/**
 * Standup (preview) — fetches GET /api/standup and renders the generated summary
 * plus the headline aggregate counts. Minimal port.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { EuiButton, EuiCallOut, EuiPanel, EuiSpacer, EuiText } from '@elastic/eui';
import type { StandupResponse } from '../../lib/types';
import { api } from '../../lib/api';
import { ErrorCallout, Loading, PreviewPill, SectionHeader } from '../common/ui';
import { fmtNumber } from '../../lib/format';

export const StandupPage: React.FC = () => {
  const [data, setData] = useState<StandupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.standup());
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agg = (data?.aggregate || {}) as Record<string, unknown>;
  const totalEvents = typeof agg.total_events === 'number' ? agg.total_events : undefined;

  return (
    <div>
      <SectionHeader
        icon="visText"
        title="Standup"
        description="The daily aggregate summary."
        actions={
          <>
            <PreviewPill /> <EuiButton size="s" iconType="refresh" onClick={load}>Refresh</EuiButton>
          </>
        }
      />
      {error ? (
        <>
          <ErrorCallout error={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}
      {loading ? (
        <Loading label="Generating standup…" />
      ) : data?.enabled === false ? (
        <EuiCallOut color="primary" iconType="iInCircle" title="Standup is disabled">
          <p>Enable it in Settings → Standup.</p>
        </EuiCallOut>
      ) : (
        <>
          <EuiPanel hasBorder paddingSize="l">
            <EuiText>
              <p style={{ whiteSpace: 'pre-wrap' }}>{data?.summary || 'No summary available.'}</p>
            </EuiText>
          </EuiPanel>
          {typeof totalEvents === 'number' ? (
            <>
              <EuiSpacer size="m" />
              <EuiText size="s" color="subdued">
                <span>
                  Window: {data?.window_hours ?? 24}h · {fmtNumber(totalEvents)} events
                </span>
              </EuiText>
            </>
          ) : null}
        </>
      )}
    </div>
  );
};
