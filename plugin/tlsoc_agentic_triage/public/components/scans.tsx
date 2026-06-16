import React, { useEffect, useState } from 'react';
import {
  EuiBasicTable,
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonIcon,
  EuiBadge,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiTitle,
} from '@elastic/eui';
import type { Case } from '../../common';
import type { TlsocApi } from '../lib/api';
import type { OpenInDiscover } from '../lib/discover';
import { TriggerReasonCallout } from './trigger_reason_callout';

interface ScansProps {
  api: TlsocApi;
  openInDiscover: OpenInDiscover;
  /** Open the stored case (GET by id) in the Investigate detail view. */
  onOpenCase?: (caseId: string) => void;
}

export const Scans: React.FC<ScansProps> = ({ api, openInDiscover, onOpenCase }) => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Feature 3: per-row expansion to reveal the "why this fired" explanation.
  const [expanded, setExpanded] = useState<Record<string, React.ReactNode>>({});

  const toggleExpand = (item: Case, e?: React.MouseEvent) => {
    if (e) {
      // Don't let the expander click also trigger the row's "open case" handler.
      e.stopPropagation();
    }
    const id = item.case_id;
    if (!id) {
      return;
    }
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
      } else {
        next[id] = <TriggerReasonCallout triggerReason={item.trigger_reason} />;
      }
      return next;
    });
  };

  const loadScans = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<{ cases: Case[]; total: number }>('scans', { limit: 100 });
      setCases(resp.cases || []);
      setExpanded({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadScans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: Array<EuiBasicTableColumn<Case>> = [
    {
      field: 'entity',
      name: 'Entity',
      render: (entity: Case['entity']) => (entity ? `${entity.type}: ${entity.value}` : '-'),
    },
    {
      field: 'verdict',
      name: 'Verdict',
      render: (v: string) => (v ? <EuiBadge color="hollow">{v}</EuiBadge> : '-'),
    },
    { field: 'risk_score', name: 'Risk' },
    { field: 'status', name: 'Status', render: (s: string) => <EuiBadge>{s || '-'}</EuiBadge> },
    { field: 'created_at', name: 'Created' },
    {
      align: 'right',
      width: '40px',
      isExpander: true,
      name: '',
      render: (item: Case) =>
        item.trigger_reason ? (
          <EuiButtonIcon
            onClick={(e: React.MouseEvent) => toggleExpand(item, e)}
            aria-label={
              item.case_id && expanded[item.case_id] ? 'Collapse why this fired' : 'Why this fired'
            }
            iconType={item.case_id && expanded[item.case_id] ? 'arrowUp' : 'iInCircle'}
          />
        ) : null,
    },
    {
      name: 'Actions',
      actions: [
        {
          name: 'Open',
          description: 'Open the stored case (no LLM cost)',
          icon: 'eye',
          type: 'icon' as const,
          available: (item: Case) => !!onOpenCase && !!item.case_id,
          onClick: (item: Case) => {
            if (onOpenCase && item.case_id) {
              onOpenCase(item.case_id);
            }
          },
        },
        {
          name: 'Reproduce',
          description: 'Reproduce query in Discover',
          icon: 'discoverApp',
          type: 'icon' as const,
          available: (item: Case) => !!item.reproduce_query,
          onClick: (item: Case) => {
            if (item.reproduce_query) {
              openInDiscover(item.reproduce_query);
            }
          },
        },
      ],
    },
  ];

  return (
    <div>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="s">
            <h2>Automated Scans</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton size="s" iconType="refresh" onClick={loadScans} isLoading={loading}>
            Refresh
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="s" />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="s" />
        </>
      ) : null}

      <EuiBasicTable
        items={cases}
        columns={columns}
        loading={loading}
        tableLayout="auto"
        itemId="case_id"
        itemIdToExpandedRowMap={expanded}
        noItemsMessage="No automated scans yet."
        rowProps={
          onOpenCase
            ? (item: Case) => ({
                onClick: () => {
                  if (item.case_id) {
                    onOpenCase(item.case_id);
                  }
                },
                style: { cursor: 'pointer' },
              })
            : undefined
        }
      />
    </div>
  );
};
