/**
 * Automated Scans (preview) — lists scan-derived cases from GET /api/scans in a
 * basic table. Minimal port; the full board lands later.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { EuiBasicTable, EuiButton, EuiSpacer } from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { humanizeAge } from '../../lib/format';
import { EmptyState, ErrorCallout, Loading, PreviewPill, RiskBadge, SectionHeader, StatusBadge, VerdictBadge } from '../common/ui';

export const ScansPage: React.FC = () => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.scans(50);
      setCases(res.cases);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = [
    { field: 'title', name: 'Title', render: (_: unknown, c: Case) => c.title || c.case_id },
    { field: 'entity', name: 'Entity', render: (_: unknown, c: Case) => (c.entity ? `${c.entity.type}:${c.entity.value}` : '—') },
    { field: 'verdict', name: 'Verdict', render: (_: unknown, c: Case) => <VerdictBadge verdict={c.verdict} /> },
    { field: 'risk_score', name: 'Risk', render: (_: unknown, c: Case) => <RiskBadge score={c.risk_score} /> },
    { field: 'status', name: 'Status', render: (_: unknown, c: Case) => <StatusBadge status={c.status} /> },
    { field: 'created_at', name: 'Created', render: (_: unknown, c: Case) => humanizeAge(c.created_at) },
  ];

  return (
    <div>
      <SectionHeader
        icon="reportingApp"
        title="Automated scans"
        description="Cases the agent opened from background scanning."
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
        <Loading label="Loading scans…" />
      ) : cases.length === 0 ? (
        <EmptyState iconType="reportingApp" title="No scan cases yet" body="Enable background scans in Settings to populate this board." />
      ) : (
        <EuiBasicTable items={cases} columns={columns} rowHeader="title" />
      )}
    </div>
  );
};
