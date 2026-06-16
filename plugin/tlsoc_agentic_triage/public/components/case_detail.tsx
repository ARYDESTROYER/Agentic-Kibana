import React, { useCallback, useEffect, useState } from 'react';
import {
  EuiAccordion,
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingSpinner,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  EuiTitle,
} from '@elastic/eui';
import type { Case, Entity } from '../../common';
import type { TlsocApi } from '../lib/api';
import type { OpenInDiscover } from '../lib/discover';
import { TriggerReasonCallout } from './trigger_reason_callout';
import { AgentTrace } from './agent_trace';
import { CaseTimeline } from './case_timeline';

type LifecycleAction = 'close' | 'confirm_fp' | 'escalate' | 'reopen';

/** Shape of a Kibana HttpFetchError; we read `body` (the backend's JSON detail)
 * and `response.status` to distinguish a NEUTRAL 400 (e.g. "No events found")
 * from a real 5xx / unexpected failure. */
interface HttpFetchErrorLike {
  body?: { statusCode?: number; message?: string; error?: string; detail?: string };
  response?: { status?: number };
  message?: string;
}

/** Extracts the most specific human-readable detail from a fetch error,
 * preferring the backend's JSON body detail/message over the generic message. */
function errorDetail(err: unknown): string {
  const e = err as HttpFetchErrorLike;
  return e?.body?.detail ?? e?.body?.message ?? e?.message ?? 'Request failed';
}

/** True when the error represents a NEUTRAL "nothing to investigate" 400 — the
 * cluster aged out / no events found — which should render as an info empty
 * state, NOT a red danger error. */
function isNoEventsError(err: unknown): boolean {
  const e = err as HttpFetchErrorLike;
  const status = e?.body?.statusCode ?? e?.response?.status;
  if (status === 400) return true;
  return errorDetail(err).toLowerCase().includes('no events');
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
  // C3-5: the analyst note captured in the lifecycle confirm modal.
  const [actionNote, setActionNote] = useState('');
  // C3-4: human-triggered (re-)investigation state.
  const [investigating, setInvestigating] = useState(false);
  // NEUTRAL no-events outcome of an investigate attempt (info, not danger).
  const [investigateNotice, setInvestigateNotice] = useState<string | null>(null);
  // Bumped after a successful (re-)investigation so the trace re-fetches.
  const [traceKey, setTraceKey] = useState(0);

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
      setError(errorDetail(e));
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
        // C3-5: pass the analyst note; the backend indexes close/confirm_fp
        // notes into RAG memory, so the note matters.
        note: actionNote.trim(),
        analyst: 'analyst',
      });
      // Re-fetch from the backend so we render the canonical stored case.
      setTheCase(updated);
      if (onCaseUpdated) {
        onCaseUpdated(updated);
      }
    } catch (e) {
      setError(errorDetail(e));
    } finally {
      setActing(false);
      setPendingAction(null);
      setActionNote('');
    }
  };

  // C3-4: human-triggered (re-)investigation. Refetches the case + trace on
  // success so the verdict + timeline update. A NEUTRAL 400 (the cluster aged
  // out of the retained window) renders as an info notice, NOT a red error.
  const runInvestigate = async () => {
    setInvestigating(true);
    setError(null);
    setInvestigateNotice(null);
    try {
      const updated = await api.post<Case>('cases/' + caseId + '/investigate', {});
      setTheCase(updated);
      setTraceKey((k) => k + 1);
      if (onCaseUpdated) {
        onCaseUpdated(updated);
      }
    } catch (e) {
      if (isNoEventsError(e)) {
        setInvestigateNotice(errorDetail(e));
      } else {
        setError(errorDetail(e));
      }
    } finally {
      setInvestigating(false);
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
  // A case with no verdict yet is a deterministic candidate awaiting the agent.
  const isCandidate = !c.verdict;

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

      {/* BUG-2 / C3-4: a NEUTRAL no-events outcome is an info state, not an error. */}
      {investigateNotice ? (
        <>
          <EuiCallOut color="primary" size="s" iconType="iInCircle" title="Nothing to investigate">
            <p>{investigateNotice}</p>
          </EuiCallOut>
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

        {/* Feature 3: deterministic "why was this triggered" explanation. */}
        {c.trigger_reason ? (
          <>
            <EuiSpacer size="s" />
            <TriggerReasonCallout triggerReason={c.trigger_reason} />
          </>
        ) : null}

        {/* C3-4: human-triggered (re-)investigation by the agent. */}
        <EuiSpacer size="m" />
        {isCandidate ? (
          <EuiText size="xs" color="subdued">
            <p>Candidate awaiting investigation by the agent.</p>
          </EuiText>
        ) : null}
        <EuiSpacer size="xs" />
        <EuiButton
          fill
          size="s"
          iconType="play"
          isLoading={investigating}
          isDisabled={investigating || acting}
          onClick={runInvestigate}
        >
          {isCandidate ? 'Investigate' : 'Re-investigate (LLM)'}
        </EuiButton>

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

        {/* C3-3: agent-pipeline trace, collapsed by default. */}
        <EuiSpacer size="m" />
        <EuiAccordion
          id={`agent-trace-${c.case_id}`}
          buttonContent="Agent trace"
          paddingSize="s"
        >
          <AgentTrace api={api} caseId={caseId} refreshKey={traceKey} />
        </EuiAccordion>

        {/* C3-7: merged + deduped chronological history timeline. */}
        <EuiSpacer size="m" />
        <EuiTitle size="xs">
          <h4>History</h4>
        </EuiTitle>
        <EuiSpacer size="xs" />
        <CaseTimeline theCase={c} />
      </EuiPanel>

      {/* C3-5: lifecycle confirm modal with an analyst note (indexed into RAG
          memory for close / confirm_fp). */}
      {pendingAction ? (
        <EuiModal onClose={() => setPendingAction(null)} initialFocus="[name=analyst-note]">
          <EuiModalHeader>
            <EuiModalHeaderTitle>{confirmCopy[pendingAction].title}</EuiModalHeaderTitle>
          </EuiModalHeader>
          <EuiModalBody>
            <EuiText size="s">
              <p>{confirmCopy[pendingAction].body}</p>
            </EuiText>
            <EuiSpacer size="m" />
            <EuiText size="xs" color="subdued">
              <p>
                Note (optional)
                {pendingAction === 'close' || pendingAction === 'confirm_fp'
                  ? ' — saved to agent memory to inform future investigations.'
                  : ''}
              </p>
            </EuiText>
            <EuiSpacer size="xs" />
            <EuiTextArea
              name="analyst-note"
              fullWidth
              placeholder="Why are you taking this action?"
              value={actionNote}
              onChange={(e) => setActionNote(e.target.value)}
            />
          </EuiModalBody>
          <EuiModalFooter>
            <EuiButtonEmpty onClick={() => setPendingAction(null)} isDisabled={acting}>
              Cancel
            </EuiButtonEmpty>
            <EuiButton
              fill
              color={pendingAction === 'escalate' ? 'warning' : 'primary'}
              onClick={() => runAction(pendingAction)}
              isLoading={acting}
            >
              {confirmCopy[pendingAction].confirm}
            </EuiButton>
          </EuiModalFooter>
        </EuiModal>
      ) : null}
    </div>
  );
};
