/**
 * The case detail, presented as a right-side flyout that opens over any surface.
 *
 * Click a case anywhere (Investigate / Automated Scans / Case Board) and this
 * slides in: a header (entity + verdict/status/risk badges), tabs
 * (Overview · Agent trace · History · Ask), and a sticky footer with the
 * contextual lifecycle actions. Re-fetches the stored case by id; lifecycle
 * actions re-fetch and notify the parent (`onChanged`) so the grids stay in sync.
 */
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
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutFooter,
  EuiFlyoutHeader,
  EuiLoadingSpinner,
  EuiSpacer,
  EuiTab,
  EuiTabs,
  EuiText,
  EuiTextArea,
  EuiTitle,
} from '@elastic/eui';
import type { Case, Entity } from '../../common';
import type { TlsocApi } from '../lib/api';
import type { OpenInDiscover } from '../lib/discover';
import { formatTimestamp } from '../lib/format';
import { ConfidenceBadge, RiskBadge, StatusBadge, VerdictBadge } from './ui';
import { TriggerReasonCallout } from './trigger_reason_callout';
import { AgentTrace } from './agent_trace';
import { CaseTimeline } from './case_timeline';
import { Chat } from './chat';

type LifecycleAction = 'close' | 'confirm_fp' | 'escalate' | 'reopen';
type TabId = 'overview' | 'trace' | 'history' | 'chat';

interface HttpFetchErrorLike {
  body?: { statusCode?: number; message?: string; error?: string; detail?: string };
  response?: { status?: number };
  message?: string;
}

function errorDetail(err: unknown): string {
  const e = err as HttpFetchErrorLike;
  return e?.body?.detail ?? e?.body?.message ?? e?.message ?? 'Request failed';
}

function isNoEventsError(err: unknown): boolean {
  const e = err as HttpFetchErrorLike;
  const status = e?.body?.statusCode ?? e?.response?.status;
  if (status === 400) return true;
  return errorDetail(err).toLowerCase().includes('no events');
}

function entityLabel(entity?: Entity): string {
  return entity ? `${entity.type}: ${entity.value}` : '—';
}

interface CaseDetailFlyoutProps {
  api: TlsocApi;
  caseId: string;
  openInDiscover: OpenInDiscover;
  onClose: () => void;
  /** Called after any change (lifecycle/investigate) so list surfaces can refresh. */
  onChanged?: () => void;
}

const CONFIRM_COPY: Record<LifecycleAction, { title: string; body: string; confirm: string }> = {
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
  reopen: { title: 'Reopen this case?', body: 'This moves the case back to open.', confirm: 'Reopen' },
};

export const CaseDetailFlyout: React.FC<CaseDetailFlyoutProps> = ({
  api,
  caseId,
  openInDiscover,
  onClose,
  onChanged,
}) => {
  const [theCase, setTheCase] = useState<Case | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [pendingAction, setPendingAction] = useState<LifecycleAction | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [investigating, setInvestigating] = useState(false);
  const [investigateNotice, setInvestigateNotice] = useState<string | null>(null);
  const [traceKey, setTraceKey] = useState(0);
  const [tab, setTab] = useState<TabId>('overview');

  const fetchCase = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await api.get<Case>('cases/' + caseId);
      setTheCase(fetched);
    } catch (e) {
      setError(errorDetail(e));
      setTheCase(null);
    } finally {
      setLoading(false);
    }
  }, [api, caseId]);

  // Re-fetch + reset to the Overview tab whenever a different case is opened.
  useEffect(() => {
    setTab('overview');
    setInvestigateNotice(null);
    fetchCase();
  }, [fetchCase]);

  const runAction = async (action: LifecycleAction) => {
    setActing(true);
    setError(null);
    try {
      const updated = await api.post<Case>('cases/' + caseId + '/action', {
        action,
        note: actionNote.trim(),
        analyst: 'analyst',
      });
      setTheCase(updated);
      onChanged?.();
    } catch (e) {
      setError(errorDetail(e));
    } finally {
      setActing(false);
      setPendingAction(null);
      setActionNote('');
    }
  };

  const runInvestigate = async () => {
    setInvestigating(true);
    setError(null);
    setInvestigateNotice(null);
    try {
      const updated = await api.post<Case>('cases/' + caseId + '/investigate', {});
      setTheCase(updated);
      setTraceKey((k) => k + 1);
      onChanged?.();
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

  const c = theCase;
  const status = (c?.status || '').toLowerCase();
  const isCandidate = !!c && !c.verdict;
  const titleId = 'tlsocCaseFlyoutTitle';

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'trace', label: 'Agent trace' },
    { id: 'history', label: 'History' },
    { id: 'chat', label: 'Ask' },
  ];

  return (
    <EuiFlyout onClose={onClose} size="l" ownFocus aria-labelledby={titleId}>
      <EuiFlyoutHeader hasBorder>
        {loading && !c ? (
          <EuiTitle size="m">
            <h2 id={titleId}>Loading case…</h2>
          </EuiTitle>
        ) : c ? (
          <>
            <EuiTitle size="m">
              <h2 id={titleId} style={{ fontFamily: c.entity ? 'monospace' : undefined }}>
                {c.entity ? entityLabel(c.entity) : c.title || `Case ${c.case_id}`}
              </h2>
            </EuiTitle>
            <EuiSpacer size="s" />
            <EuiFlexGroup gutterSize="s" wrap responsive={false} alignItems="center">
              <EuiFlexItem grow={false}>
                <VerdictBadge verdict={c.verdict} />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <StatusBadge status={c.status} />
              </EuiFlexItem>
              {typeof c.risk_score === 'number' ? (
                <EuiFlexItem grow={false}>
                  <RiskBadge score={c.risk_score} />
                </EuiFlexItem>
              ) : null}
              {typeof c.confidence === 'number' ? (
                <EuiFlexItem grow={false}>
                  <ConfidenceBadge confidence={c.confidence} />
                </EuiFlexItem>
              ) : null}
            </EuiFlexGroup>
            <EuiSpacer size="s" />
            <EuiTabs bottomBorder={false}>
              {tabs.map((t) => (
                <EuiTab key={t.id} isSelected={t.id === tab} onClick={() => setTab(t.id)}>
                  {t.label}
                </EuiTab>
              ))}
            </EuiTabs>
          </>
        ) : (
          <EuiTitle size="m">
            <h2 id={titleId}>Case</h2>
          </EuiTitle>
        )}
      </EuiFlyoutHeader>

      <EuiFlyoutBody>
        {loading && !c ? (
          <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiLoadingSpinner size="l" />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="s">Loading case {caseId}…</EuiText>
            </EuiFlexItem>
          </EuiFlexGroup>
        ) : !c ? (
          <EuiCallOut color="danger" size="s" title={`Could not load case: ${error || 'unknown error'}`}>
            <EuiButton size="s" onClick={fetchCase} isLoading={loading}>
              Retry
            </EuiButton>
          </EuiCallOut>
        ) : (
          <>
            {error ? (
              <>
                <EuiCallOut color="danger" size="s" title={error} />
                <EuiSpacer size="m" />
              </>
            ) : null}
            {investigateNotice ? (
              <>
                <EuiCallOut color="primary" size="s" iconType="iInCircle" title="Nothing to investigate">
                  <p>{investigateNotice}</p>
                </EuiCallOut>
                <EuiSpacer size="m" />
              </>
            ) : null}

            {tab === 'overview' ? (
              <>
                <EuiDescriptionList
                  type="column"
                  compressed
                  listItems={[
                    { title: 'Entity', description: entityLabel(c.entity) },
                    {
                      title: 'Rules',
                      description: c.rule_ids && c.rule_ids.length ? c.rule_ids.join(', ') : '—',
                    },
                    { title: 'Source', description: c.origin_surface || c.source_surface || '—' },
                    { title: 'Created', description: formatTimestamp(c.created_at) },
                    { title: 'Updated', description: formatTimestamp(c.updated_at) },
                  ]}
                />

                {c.summary ? (
                  <>
                    <EuiSpacer size="m" />
                    <EuiText size="s">
                      <p>{c.summary}</p>
                    </EuiText>
                  </>
                ) : null}

                {c.trigger_reason ? (
                  <>
                    <EuiSpacer size="m" />
                    <TriggerReasonCallout triggerReason={c.trigger_reason} />
                  </>
                ) : null}

                {isCandidate ? (
                  <>
                    <EuiSpacer size="m" />
                    <EuiText size="xs" color="subdued">
                      <p>Candidate awaiting investigation by the agent.</p>
                    </EuiText>
                  </>
                ) : null}

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
                    <EuiSpacer size="m" />
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
              </>
            ) : null}

            {tab === 'trace' ? <AgentTrace api={api} caseId={caseId} refreshKey={traceKey} /> : null}

            {tab === 'history' ? <CaseTimeline theCase={c} /> : null}

            {tab === 'chat' ? (
              <Chat
                api={api}
                openInDiscover={openInDiscover}
                caseId={caseId}
                placeholder="Ask a follow-up about this case..."
              />
            ) : null}
          </>
        )}
      </EuiFlyoutBody>

      <EuiFlyoutFooter>
        <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false} wrap gutterSize="s">
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty iconType="cross" onClick={onClose} flush="left">
              Close
            </EuiButtonEmpty>
          </EuiFlexItem>
          {c ? (
            <EuiFlexItem grow={false}>
              <EuiFlexGroup gutterSize="s" wrap responsive={false} justifyContent="flexEnd">
                <EuiFlexItem grow={false}>
                  <EuiButton
                    size="s"
                    iconType="play"
                    isLoading={investigating}
                    isDisabled={investigating || acting}
                    onClick={runInvestigate}
                  >
                    {isCandidate ? 'Investigate' : 'Re-investigate'}
                  </EuiButton>
                </EuiFlexItem>
                {status === 'open' || status === 'needs_human' ? (
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
                {status === 'open' ? (
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
                {status === 'open' || status === 'needs_human' ? (
                  <EuiFlexItem grow={false}>
                    <EuiButton
                      size="s"
                      fill
                      color="success"
                      iconType="check"
                      isDisabled={acting}
                      onClick={() => setPendingAction('close')}
                    >
                      Close case
                    </EuiButton>
                  </EuiFlexItem>
                ) : null}
                {status === 'closed' ? (
                  <EuiFlexItem grow={false}>
                    <EuiButton size="s" iconType="refresh" isDisabled={acting} onClick={() => setPendingAction('reopen')}>
                      Reopen
                    </EuiButton>
                  </EuiFlexItem>
                ) : null}
              </EuiFlexGroup>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>
      </EuiFlyoutFooter>

      {pendingAction ? (
        <EuiConfirmModal
          title={CONFIRM_COPY[pendingAction].title}
          onCancel={() => {
            setPendingAction(null);
            setActionNote('');
          }}
          onConfirm={() => runAction(pendingAction)}
          cancelButtonText="Cancel"
          confirmButtonText={CONFIRM_COPY[pendingAction].confirm}
          buttonColor={pendingAction === 'escalate' ? 'warning' : 'primary'}
          isLoading={acting}
        >
          <EuiText size="s">
            <p>{CONFIRM_COPY[pendingAction].body}</p>
          </EuiText>
          <EuiSpacer size="s" />
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
            fullWidth
            placeholder="Why are you taking this action?"
            value={actionNote}
            onChange={(e) => setActionNote(e.target.value)}
            aria-label="Optional note for this action"
          />
        </EuiConfirmModal>
      ) : null}
    </EuiFlyout>
  );
};
