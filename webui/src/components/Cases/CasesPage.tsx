/**
 * Cases / dashboard — the default landing surface. Lists recent cases from
 * GET /api/cases with headline counts. Minimal but functional.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { EuiBasicTable, EuiButton, EuiFlexGroup, EuiFlexItem, EuiSpacer } from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS } from '../../lib/theme';
import { humanizeAge } from '../../lib/format';
import {
  EmptyState,
  ErrorCallout,
  Loading,
  RiskBadge,
  SectionHeader,
  StatTile,
  StatusBadge,
  VerdictBadge,
} from '../common/ui';

export const CasesPage: React.FC = () => {
  const [cases, setCases] = useState<Case[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCases({ limit: 50 });
      setCases(res.cases);
      setTotal(res.total);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    let open = 0;
    let needsHuman = 0;
    let truePositive = 0;
    for (const c of cases) {
      if (c.status === 'open') open += 1;
      if (c.status === 'needs_human') needsHuman += 1;
      if ((c.verdict || '').toUpperCase().includes('TRUE')) truePositive += 1;
    }
    return { open, needsHuman, truePositive };
  }, [cases]);

  const columns = [
    { field: 'title', name: 'Title', render: (_: unknown, c: Case) => c.title || c.case_id },
    { field: 'entity', name: 'Entity', render: (_: unknown, c: Case) => (c.entity ? `${c.entity.type}:${c.entity.value}` : '—') },
    { field: 'verdict', name: 'Verdict', render: (_: unknown, c: Case) => <VerdictBadge verdict={c.verdict} /> },
    { field: 'risk_score', name: 'Risk', render: (_: unknown, c: Case) => <RiskBadge score={c.risk_score} /> },
    { field: 'status', name: 'Status', render: (_: unknown, c: Case) => <StatusBadge status={c.status} /> },
    { field: 'updated_at', name: 'Updated', render: (_: unknown, c: Case) => humanizeAge(c.updated_at || c.created_at) },
  ];

  return (
    <div>
      <SectionHeader
        icon="securityApp"
        title="Cases"
        description="Audited, human-reviewable triage cases."
        actions={<EuiButton size="s" iconType="refresh" onClick={load}>Refresh</EuiButton>}
      />

      <EuiFlexGroup gutterSize="m">
        <EuiFlexItem>
          <StatTile label="Total cases" value={total} icon="documents" accent={COLORS.primary} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="Open" value={counts.open} icon="dot" accent={COLORS.primary} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="Needs human" value={counts.needsHuman} icon="alert" accent={COLORS.warning} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="True positives" value={counts.truePositive} icon="bug" accent={COLORS.danger} />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      {error ? (
        <>
          <ErrorCallout error={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}
      {loading ? (
        <Loading label="Loading cases…" />
      ) : cases.length === 0 ? (
        <EmptyState
          iconType="securityApp"
          title="No cases yet"
          body="Run an investigation or enable background scans to start triaging."
        />
      ) : (
        <EuiBasicTable items={cases} columns={columns} rowHeader="title" />
      )}
    </div>
  );
};
