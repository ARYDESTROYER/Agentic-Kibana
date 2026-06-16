import React, { useCallback, useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiConfirmModal,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { Case, Entity } from '../../common';
import type { TlsocApi } from '../lib/api';
import type { OpenInDiscover } from '../lib/discover';

type LifecycleAction = 'close' | 'confirm_fp' | 'escalate' | 'reopen';

interface HistoryEntry {
  ts?: string;
  event?: string;
  action?: string;
  analyst?: string;
  note?: string;
  [k: string]: unknown;
}

interface CaseDetailProps {
  api: TlsocApi;
  caseId: string;
  openInDiscover: OpenInDiscover;
  /** Called with the freshly-fetched case after load / lifecycle actions so the
   *  parent (e.g. the cases list) can stay in sync. */
  onCaseUpdated?: (updated: Case) => void;
  /** Optional "back to list" affordance. */
  onBack?: () => void;
}

function verdictColor(verdict?: string): 'danger' | 'success' | 'warning' | 'default' {
  const v = (verdict || '').toUpperCase();
  if (v.includes('TRUE')) return 'danger';
  if (v.includes('FALSE')) return 'success';
  if (v.includes('INCONCLUSIVE') || v.includes('UNKNOWN') || v.includes('NEEDS_HUMAN')) {
    return 'warning';
  }
  return 'default';
}

function statusColor(status?: string): 'danger' | 'success' | 'warning' | 'default' {
  const s = (status || '').toLowerCase();
  if (s === 'closed') return 'success';
  if (s === 'needs_human') return 'warning';
  if (s === 'open') return 'danger';
  return 'default';
}

function entityLabel(entity?: Entity): string {
  return entity ? `${entity.type}: ${entity.value}` : '-';
}

/**
 * Reusable case-detail view. Given a `caseId`, fetches the stored case via
 * `GET /cases/{id}` on mount / when the id changes, shows a loading state, then
 * renders the full case. Lifecycle actions re-fetch the case so the UI reflects
 * the new status, and notify the parent via `onCaseUpdated`.
 */
export const CaseDetail: React.FC<CaseDetailProps> = ({
  api,
  caseId,
  openInDiscover,
  onCaseUpdated,
  onBack,
}) => {
  const [theCase, setTheCase] = useState<Case | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [pendingAction, setPendingAction] = useState<LifecycleAction | null>(null);

  const fetchCase = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await api.get<Case>('cases/' + caseId);
      setTheCase(fetched);
      if (onCaseUpdated) {
        onCaseUpdated(fetched);
      }
    } catch (e) {
      setError((e as Error).message);
      setTheCase(null);
    } finally {
      setLoading(false);
    }
    // onCaseUpdated intentionally omitted to avoid refetch loops on identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, caseId]);

  // Re-fetch the stored case whenever the selected id changes.
  useEffect(() => {
    fetchCase();
  }, [fetchCase]);

  const runAction = async (action: LifecycleAction) => {
    setActing(true);
    setError(null);
    try {
      const updated = await api.post<Case>('cases/' + caseId + '/action', {
        action,
        note: '',
        analyst: 'analyst',
      });
      // Re-fetch from the backend so we render the canonical stored case.
      setTheCase(updated);
      if (onCaseUpdated) {
        onCaseUpdated(updated);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
      setPendingAction(null);
    }
  };

  if (loading) {
    return (
      <EuiPanel hasBorder>
        <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiLoadingSpinner size="l" />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiText size="s">Loading case {caseId}...</EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>
    );
  }

  if (error && !theCase) {
    return (
      <>
        {onBack ? (
          <>
            <EuiButtonEmpty size="s" iconType="arrowLeft" onClick={onBack}>
              Back to cases
            </EuiButtonEmpty>
            <EuiSpacer size="s" />
          </>
        ) : null}
        <EuiCallOut color="danger" size="s" title={`Could not load case: ${error}`}>
          <EuiButton size="s" onClick={fetchCase} isLoading={loading}>
            Retry
          </EuiButton>
        </EuiCallOut>
      </>
    );
  }

  if (!theCase) {
    return null;
  }

  const c = theCase;
  const status = (c.status || '').toLowerCase();
  const history = (c.history as HistoryEntry[] | undefined) || [];

  // Contextualize lifecycle buttons by current status.
  const canClose = status === 'open' || status === 'needs_human';
  const canConfirmFp = status === 'open' || status === 'needs_human';
  const canEscalate = status === 'open';
  const canReopen = status === 'closed';

  const confirmCopy: Record<LifecycleAction, { title: string; body: string; confirm: string }> = {
    close: {
      title: 'Close this case?',
      body: 'Closing marks the case resolved. You can reopen it later if needed.',
      confirm: 'Close case',
    },
    confirm_fp: {
      title: 'Confirm false positive?',
      body: 'This closes the case as a confirmed false positive.',
      confirm: 'Confirm FP',
    },
    escalate: {
      title: 'Escalate this case?',
      body: 'This routes the case for human review (needs_human).',
      confirm: 'Escalate',
    },
    reopen: {
      title: 'Reopen this case?',
      body: 'This moves the case back to open.',
      confirm: 'Reopen',
    },
  };

  return (
    <div>
      {onBack ? (
        <>
          <EuiButtonEmpty size="s" iconType="arrowLeft" onClick={onBack}>
            Back to cases
          </EuiButtonEmpty>
          <EuiSpacer size="s" />
        </>
      ) : null}

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="s" />
        </>
      ) : null}

      <EuiPanel hasBorder>
        <EuiFlexGroup alignItems="center" gutterSize="m" wrap>
          <EuiFlexItem grow={false}>
            <EuiTitle size="s">
              <h3>{c.title || `Case ${c.case_id}`}</h3>
            </EuiTitle>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiBadge color={verdictColor(c.verdict)}>{c.verdict || 'UNKNOWN'}</EuiBadge>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiBadge color={statusColor(c.status)}>status: {c.status || 'unknown'}</EuiBadge>
          </EuiFlexItem>
          {typeof c.confidence === 'number' ? (
            <EuiFlexItem grow={false}>
              <EuiBadge color="hollow">confidence {(c.confidence * 100).toFixed(0)}%</EuiBadge>
            </EuiFlexItem>
          ) : null}
          {typeof c.risk_score === 'number' ? (
            <EuiFlexItem grow={false}>
              <EuiBadge color="hollow">risk {c.risk_score}</EuiBadge>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>

        <EuiSpacer size="s" />
        <EuiDescriptionList
          type="column"
          compressed
          listItems={[
            { title: 'Entity', description: entityLabel(c.entity) },
            {
              title: 'Rules',
              description: c.rule_ids && c.rule_ids.length ? c.rule_ids.join(', ') : '-',
            },
            { title: 'Source', description: c.source_surface || '-' },
            { title: 'Created', description: c.created_at || '-' },
            { title: 'Updated', description: c.updated_at || '-' },
          ]}
        />

        {c.summary ? (
          <>
            <EuiSpacer size="s" />
            <EuiText size="s">
              <p>{c.summary}</p>
            </EuiText>
          </>
        ) : null}

        {/* Lifecycle controls — contextualized by current status */}
        <EuiSpacer size="m" />
        <EuiTitle size="xxs">
          <h4>Lifecycle</h4>
        </EuiTitle>
        <EuiSpacer size="xs" />
        <EuiFlexGroup gutterSize="s" wrap responsive={false}>
          {canClose ? (
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                color="success"
                iconType="check"
                isDisabled={acting}
                onClick={() => setPendingAction('close')}
              >
                Close
              </EuiButton>
            </EuiFlexItem>
          ) : null}
          {canConfirmFp ? (
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                color="success"
                iconType="checkInCircleFilled"
                isDisabled={acting}
                onClick={() => setPendingAction('confirm_fp')}
              >
                Confirm FP
              </EuiButton>
            </EuiFlexItem>
          ) : null}
          {canEscalate ? (
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                color="warning"
                iconType="alert"
                isDisabled={acting}
                onClick={() => setPendingAction('escalate')}
              >
                Escalate
              </EuiButton>
            </EuiFlexItem>
          ) : null}
          {canReopen ? (
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                iconType="refresh"
                isDisabled={acting}
                onClick={() => setPendingAction('reopen')}
              >
                Reopen
              </EuiButton>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>

        {c.evidence && c.evidence.length > 0 ? (
          <>
            <EuiSpacer size="m" />
            <EuiTitle size="xs">
              <h4>Evidence</h4>
            </EuiTitle>
            <EuiSpacer size="xs" />
            <ul>
              {c.evidence.map((ev, i) => (
                <li key={i}>
                  <EuiText size="s">
                    <p>{ev.summary}</p>
                  </EuiText>
                  {ev.query ? (
                    <EuiButtonEmpty
                      size="xs"
                      iconType="discoverApp"
                      onClick={() => openInDiscover(ev.query as string)}
                    >
                      Open evidence query in Discover
                    </EuiButtonEmpty>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {c.mitre && c.mitre.length > 0 ? (
          <>
            <EuiSpacer size="s" />
            <EuiTitle size="xs">
              <h4>MITRE ATT&CK</h4>
            </EuiTitle>
            <EuiSpacer size="xs" />
            <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
              {c.mitre.map((m, i) => (
                <EuiFlexItem grow={false} key={i}>
                  <EuiBadge color="accent">{m}</EuiBadge>
                </EuiFlexItem>
              ))}
            </EuiFlexGroup>
          </>
        ) : null}

        {c.recommended_action ? (
          <>
            <EuiSpacer size="m" />
            <EuiDescriptionList
              type="column"
              compressed
              listItems={[{ title: 'Recommended action', description: c.recommended_action }]}
            />
          </>
        ) : null}

        {c.reproduce_query ? (
          <>
            <EuiSpacer size="m" />
            <EuiButton
              size="s"
              iconType="discoverApp"
              onClick={() => openInDiscover(c.reproduce_query as string)}
            >
              Reproduce in Discover
            </EuiButton>
          </>
        ) : null}

        {history.length > 0 ? (
          <>
            <EuiSpacer size="m" />
            <EuiTitle size="xs">
              <h4>History</h4>
            </EuiTitle>
            <EuiSpacer size="xs" />
            <ul>
              {history.map((h, i) => (
                <li key={i}>
                  <EuiText size="xs" color="subdued">
                    <p>
                      {h.ts ? `${h.ts} — ` : ''}
                      {h.event || 'event'}
                      {h.action ? ` (${h.action})` : ''}
                      {h.analyst ? ` by ${h.analyst}` : ''}
                      {h.note ? `: ${h.note}` : ''}
                    </p>
                  </EuiText>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </EuiPanel>

      {pendingAction ? (
        <EuiConfirmModal
          title={confirmCopy[pendingAction].title}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => runAction(pendingAction)}
          cancelButtonText="Cancel"
          confirmButtonText={confirmCopy[pendingAction].confirm}
          buttonColor={pendingAction === 'escalate' ? 'warning' : 'primary'}
          isLoading={acting}
        >
          <p>{confirmCopy[pendingAction].body}</p>
        </EuiConfirmModal>
      ) : null}
    </div>
  );
};
