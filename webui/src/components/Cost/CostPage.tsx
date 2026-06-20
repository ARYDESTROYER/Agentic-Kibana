/**
 * Cost (preview) — fetches GET /api/usage/summary and renders headline KPIs plus
 * a by-model breakdown table. Minimal port.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { EuiBasicTable, EuiButton, EuiFlexGroup, EuiFlexItem, EuiSpacer } from '@elastic/eui';
import type { UsageSummary } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS } from '../../lib/theme';
import { fmtMoney, fmtNumber, fmtTokens } from '../../lib/format';
import { ErrorCallout, Loading, PreviewPill, SectionHeader, StatTile } from '../common/ui';

export const CostPage: React.FC = () => {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.usageSummary(24));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byModel = data?.by_model || [];

  return (
    <div>
      <SectionHeader
        icon="visLine"
        title="Cost & usage"
        description="LLM spend metered through the single gateway."
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
        <Loading label="Loading usage…" />
      ) : (
        <>
          <EuiFlexGroup gutterSize="m">
            <EuiFlexItem>
              <StatTile label="Total cost (24h)" value={fmtMoney(data?.total_cost, data?.currency)} icon="currency" accent={COLORS.primary} />
            </EuiFlexItem>
            <EuiFlexItem>
              <StatTile label="Total tokens" value={fmtTokens(data?.total_tokens)} icon="visGauge" accent={COLORS.accent} />
            </EuiFlexItem>
            <EuiFlexItem>
              <StatTile label="LLM calls" value={fmtNumber(data?.call_count)} icon="compute" accent={COLORS.success} />
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="l" />
          {byModel.length ? (
            <EuiBasicTable
              items={byModel}
              columns={[
                { field: 'key', name: 'Model' },
                { field: 'cost', name: 'Cost', render: (v: number) => fmtMoney(v, data?.currency) },
                { field: 'tokens', name: 'Tokens', render: (v: number) => fmtTokens(v) },
                { field: 'calls', name: 'Calls', render: (v: number) => fmtNumber(v) },
              ]}
            />
          ) : null}
        </>
      )}
    </div>
  );
};
