import React, { useEffect, useState } from 'react';
import {
  EuiBasicTable,
  EuiBasicTableColumn,
  EuiButton,
  EuiCallOut,
  EuiConfirmModal,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSelect,
  EuiSpacer,
  EuiTitle,
  EuiPanel,
  EuiBadge,
} from '@elastic/eui';
import type { Case, Entity } from '../../common';
import type { TlsocApi } from '../lib/api';
import type { OpenInDiscover } from '../lib/discover';
import { CaseDetail } from './case_detail';
import { Chat } from './chat';

interface InvestigateProps {
  api: TlsocApi;
  openInDiscover: OpenInDiscover;
  /** Selected case id, lifted to app-level state so it survives tab switches. */
  selectedCaseId: string | null;
  /** Open the stored case (GET by id) — does NOT re-investigate. */
  onSelectCase: (caseId: string | null) => void;
}

export const Investigate: React.FC<InvestigateProps> = ({
  api,
  openInDiscover,
  selectedCaseId,
  onSelectCase,
}) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [investigating, setInvestigating] = useState(false);

  // manual investigation inputs
  const [manualType, setManualType] = useState<Entity['type']>('ip');
  const [manualValue, setManualValue] = useState('');

  // explicit paid re-investigation confirm target
  const [reinvestigateTarget, setReinvestigateTarget] = useState<Case | null>(null);

  const loadCases = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<{ cases: Case[]; total: number }>('cases', { limit: 100 });
      setCases(resp.cases || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * PAID investigation. Only call on an explicit user action (the manual entry
   * or the clearly-labelled "Re-investigate (LLM)" row action). Selecting the
   * resulting case opens its stored detail view.
   */
  const investigate = async (entity: Entity, group_by: Entity['type']) => {
    setInvestigating(true);
    setError(null);
    try {
      const theCase = await api.post<Case>('investigate', {
        entity,
        group_by,
        source_surface: 'investigate',
      });
      // Refresh the list and open the (now stored) case by id.
      await loadCases();
      if (theCase && theCase.case_id) {
        onSelectCase(theCase.case_id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInvestigating(false);
    }
  };

  const columns: Array<EuiBasicTableColumn<Case>> = [
    {
      field: 'entity',
      name: 'Entity',
      render: (entity: Entity | undefined) =>
        entity ? `${entity.type}: ${entity.value}` : '-',
    },
    {
      field: 'rule_ids',
      name: 'Rules',
      render: (rules: string[] | undefined) => (rules && rules.length ? rules.join(', ') : '-'),
    },
    { field: 'risk_score', name: 'Risk' },
    { field: 'status', name: 'Status', render: (s: string) => <EuiBadge>{s || '-'}</EuiBadge> },
    {
      field: 'verdict',
      name: 'Verdict',
      render: (v: string) => (v ? <EuiBadge color="hollow">{v}</EuiBadge> : '-'),
    },
    { field: 'created_at', name: 'Created' },
    {
      name: 'Actions',
      actions: [
        {
          name: 'Open',
          description: 'Open the stored case (no LLM cost)',
          icon: 'eye',
          type: 'icon' as const,
          // Open the saved case by id — this does NOT re-run a paid investigation.
          onClick: (item: Case) => {
            if (item.case_id) {
              onSelectCase(item.case_id);
            }
          },
        },
        {
          name: 'Re-investigate (LLM)',
          description: 'Re-run a PAID LLM investigation for this entity',
          icon: 'inspect',
          type: 'icon' as const,
          color: 'warning' as const,
          available: (item: Case) => !!item.entity,
          // Explicit paid re-run — gated behind a confirm.
          onClick: (item: Case) => {
            if (item.entity) {
              setReinvestigateTarget(item);
            }
          },
        },
      ],
    },
  ];

  // The row click opens the stored case detail view.
  const onRowClick = (item: Case) => {
    if (item.case_id) {
      onSelectCase(item.case_id);
    }
  };

  return (
    <div>
      <EuiTitle size="s">
        <h2>Alerts / Investigate</h2>
      </EuiTitle>
      <EuiSpacer size="s" />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="s" />
        </>
      ) : null}

      <EuiPanel hasBorder>
        <EuiTitle size="xs">
          <h3>Investigate by IP / user / host</h3>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiFlexGroup gutterSize="s" alignItems="flexEnd">
          <EuiFlexItem grow={false} style={{ width: 140 }}>
            <EuiSelect
              value={manualType}
              onChange={(e) => setManualType(e.target.value as Entity['type'])}
              options={[
                { value: 'ip', text: 'IP' },
                { value: 'user', text: 'User' },
                { value: 'host', text: 'Host' },
              ]}
            />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFieldText
              placeholder="e.g. 10.0.0.5 / alice / web-01"
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
            />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton
              fill
              isLoading={investigating}
              isDisabled={!manualValue.trim()}
              onClick={() =>
                investigate({ type: manualType, value: manualValue.trim() }, manualType)
              }
            >
              Investigate
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>

      <EuiSpacer size="m" />

      {selectedCaseId ? (
        <>
          <CaseDetail
            api={api}
            caseId={selectedCaseId}
            openInDiscover={openInDiscover}
            onBack={() => onSelectCase(null)}
            onCaseUpdated={(updated) => {
              // Keep the cases list row in sync with the latest stored case.
              setCases((prev) =>
                prev.map((c) => (c.case_id === updated.case_id ? updated : c))
              );
            }}
          />
          <EuiSpacer size="m" />
          <EuiPanel hasBorder>
            <EuiTitle size="xs">
              <h3>Follow-up on this case</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <Chat
              api={api}
              openInDiscover={openInDiscover}
              caseId={selectedCaseId}
              placeholder="Ask a follow-up about this case..."
            />
          </EuiPanel>
          <EuiSpacer size="m" />
        </>
      ) : null}

      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="xs">
            <h3>Cases</h3>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton size="s" iconType="refresh" onClick={loadCases} isLoading={loading}>
            Refresh
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="s" />
      <EuiBasicTable
        items={cases}
        columns={columns}
        loading={loading}
        tableLayout="auto"
        noItemsMessage="No cases yet."
        rowProps={(item: Case) => ({
          onClick: () => onRowClick(item),
          style: { cursor: 'pointer' },
        })}
      />

      {reinvestigateTarget && reinvestigateTarget.entity ? (
        <EuiConfirmModal
          title="Re-run a paid LLM investigation?"
          onCancel={() => setReinvestigateTarget(null)}
          onConfirm={() => {
            const target = reinvestigateTarget;
            setReinvestigateTarget(null);
            if (target && target.entity) {
              investigate(target.entity, target.entity.type);
            }
          }}
          cancelButtonText="Cancel"
          confirmButtonText="Re-investigate (LLM)"
          buttonColor="warning"
          isLoading={investigating}
        >
          <p>
            This starts a NEW paid LLM investigation for{' '}
            <strong>
              {reinvestigateTarget.entity.type}: {reinvestigateTarget.entity.value}
            </strong>
            . To just review the existing analysis at no cost, use the &quot;Open&quot; action
            instead.
          </p>
        </EuiConfirmModal>
      ) : null}
    </div>
  );
};
