import React, { useEffect, useState } from 'react';
import {
  EuiBasicTable,
  EuiButton,
  EuiCallOut,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSelect,
  EuiSpacer,
  EuiTitle,
  EuiText,
  EuiPanel,
  EuiBadge,
} from '@elastic/eui';
import type { Case, Entity } from '../../common';
import type { TlsocApi } from '../lib/api';
import type { OpenInDiscover } from '../lib/discover';
import { VerdictCard } from './verdict_card';
import { Chat } from './chat';

interface InvestigateProps {
  api: TlsocApi;
  openInDiscover: OpenInDiscover;
}

export const Investigate: React.FC<InvestigateProps> = ({ api, openInDiscover }) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCase, setActiveCase] = useState<Case | null>(null);
  const [investigating, setInvestigating] = useState(false);

  // manual investigation inputs
  const [manualType, setManualType] = useState<Entity['type']>('ip');
  const [manualValue, setManualValue] = useState('');

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

  const investigate = async (entity: Entity) => {
    setInvestigating(true);
    setError(null);
    try {
      const theCase = await api.post<Case>('investigate', {
        entity,
        source_surface: 'investigate',
      });
      setActiveCase(theCase);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInvestigating(false);
    }
  };

  const columns = [
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
          name: 'Investigate',
          description: 'Investigate this entity',
          icon: 'inspect',
          type: 'icon' as const,
          onClick: (item: Case) => {
            if (item.entity) {
              investigate(item.entity);
            }
          },
        },
      ],
    },
  ];

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
              onClick={() => investigate({ type: manualType, value: manualValue.trim() })}
            >
              Investigate
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>

      <EuiSpacer size="m" />

      {activeCase ? (
        <>
          <VerdictCard theCase={activeCase} openInDiscover={openInDiscover} />
          <EuiSpacer size="m" />
          <EuiPanel hasBorder>
            <EuiTitle size="xs">
              <h3>Follow-up on this case</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <Chat
              api={api}
              openInDiscover={openInDiscover}
              caseId={activeCase.case_id}
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
      />
    </div>
  );
};
