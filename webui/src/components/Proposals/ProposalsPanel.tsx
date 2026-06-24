/**
 * Approvals — the human-in-the-loop queue for agent-drafted proposals.
 *
 * When the agent confirms a false positive (or otherwise learns something durable)
 * it does NOT change anything itself. Instead it DRAFTS a recommendation — a
 * candidate suppression rule, or a durable memory fact — and parks it here for a
 * human to approve. Approving is the ONLY thing that makes a suppression rule live
 * or saves a memory; nothing on this page is applied automatically. This keeps the
 * deterministic, operator-controlled spine intact: the agent recommends, the human
 * decides.
 *
 * Approve is a privileged action and is enforced server-side (admin-gated). The
 * panel surfaces a 403 (and 404/409) inline rather than guessing the user's role.
 *
 * UNTRUSTED-safe: a proposal's `payload` (field / value / text) and its `rationale`
 * derive from log events, so they are rendered as plain text / `EuiCode` — never as
 * markup.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonGroup,
  EuiCallOut,
  EuiCheckbox,
  EuiCode,
  EuiFlexGroup,
  EuiFlexItem,
  EuiGlobalToastList,
  EuiHorizontalRule,
  EuiIconTip,
  EuiPanel,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import type { EuiGlobalToastListToast as Toast } from '@elastic/eui';
import type {
  MemoryPayload,
  Proposal,
  SuppressionPayload,
} from '../../lib/types';
import { ApiError, api } from '../../lib/api';
import { COLORS, tint } from '../../lib/theme';
import { DASH, fmtNumber, fmtPercent, formatTimestamp, humanizeAge, humanizeToken } from '../../lib/format';
import { Card, EmptyState, ErrorCallout, PageHeader, SectionHeader, Skeleton } from '../common/ui';

/* --------------------------------------------------------------- kind badge -- */

const KIND_META: Record<string, { label: string; icon: string; accent: string }> = {
  suppression: { label: 'Suppression', icon: 'lockOpen', accent: COLORS.warning },
  memory: { label: 'Memory', icon: 'memory', accent: COLORS.accent },
};

function kindMeta(kind?: string): { label: string; icon: string; accent: string } {
  return (
    KIND_META[(kind || '').toLowerCase()] || {
      label: kind ? humanizeToken(kind) : 'Proposal',
      icon: 'flag',
      accent: COLORS.primary,
    }
  );
}

const KindBadge: React.FC<{ kind?: string }> = ({ kind }) => {
  const meta = kindMeta(kind);
  return (
    <EuiBadge color={tint(meta.accent, 0.16)} style={{ color: meta.accent }} iconType={meta.icon}>
      {meta.label}
    </EuiBadge>
  );
};

/* -------------------------------------------------------- confidence badge --- */

const ConfidencePill: React.FC<{ confidence?: number }> = ({ confidence }) => {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  // Higher confidence reads greener; a low-confidence draft warrants a closer look.
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  const color = pct >= 80 ? COLORS.success : pct >= 50 ? COLORS.warning : COLORS.danger;
  return (
    <EuiToolTip content="The agent's confidence in this recommendation">
      <EuiBadge color={tint(color, 0.16)} style={{ color }} iconType="visGauge">
        {fmtPercent(confidence)} conf
      </EuiBadge>
    </EuiToolTip>
  );
};

/* --------------------------------------------------------------- safe coerce -- */

/** Render any source-controlled scalar as a readable, plain string. */
function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** A stable "source / rule" group label for a proposal (UNTRUSTED-safe plain text). */
function groupKeyOf(p: Proposal): string {
  const sup = (p.payload || {}) as SuppressionPayload;
  if ((p.kind || '').toLowerCase() === 'suppression' && sup.field) {
    return `${asText(sup.field)} == ${asText(sup.value) || '∗'}`;
  }
  const mem = (p.payload || {}) as MemoryPayload;
  if ((p.kind || '').toLowerCase() === 'memory' && mem.category) {
    return humanizeToken(asText(mem.category));
  }
  return kindMeta(p.kind).label;
}

/* --------------------------------------------------------------- proposal --- */

const ProposalCard: React.FC<{
  proposal: Proposal;
  busy: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onApprove: (p: Proposal) => void;
  onReject: (p: Proposal) => void;
  onOpenCase?: (caseId: string) => void;
}> = ({ proposal, busy, selected, onToggleSelect, onApprove, onReject, onOpenCase }) => {
  const meta = kindMeta(proposal.kind);
  const isSuppression = (proposal.kind || '').toLowerCase() === 'suppression';
  const isMemory = (proposal.kind || '').toLowerCase() === 'memory';
  const sup = (proposal.payload || {}) as SuppressionPayload;
  const mem = (proposal.payload || {}) as MemoryPayload;
  const cases = proposal.source_case_ids || [];

  return (
    <Card icon={meta.icon} accent={meta.accent} accentLeft={meta.accent} paddingSize="m">
      {/* header row: select + kind + confidence + age */}
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
        <EuiFlexItem grow={false}>
          <EuiCheckbox
            id={`prop-select-${proposal.id}`}
            checked={selected}
            onChange={() => onToggleSelect(proposal.id)}
            aria-label="Select this proposal for a bulk action"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <KindBadge kind={proposal.kind} />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <ConfidencePill confidence={proposal.confidence} />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            <span title={formatTimestamp(proposal.created_at)}>
              drafted {humanizeAge(proposal.created_at)}
              {proposal.created_by ? ` · by ${proposal.created_by}` : ''}
            </span>
          </EuiText>
        </EuiFlexItem>
        {proposal.expires_at ? (
          <EuiFlexItem grow={false}>
            <EuiToolTip content={`Expires ${formatTimestamp(proposal.expires_at)}`}>
              <EuiBadge color="hollow" iconType="clock">
                expires {humanizeAge(proposal.expires_at)}
              </EuiBadge>
            </EuiToolTip>
          </EuiFlexItem>
        ) : null}
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      {/* the candidate rule / fact (UNTRUSTED → EuiCode / plain text) */}
      {isSuppression ? (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.subdued, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Candidate suppression rule
          </div>
          <EuiSpacer size="xs" />
          <EuiCode>
            {asText(sup.field) || '(field)'} == {asText(sup.value) || '(value)'}
          </EuiCode>
          {sup.reason ? (
            <>
              <EuiSpacer size="xs" />
              <EuiText size="s">
                <span style={{ color: COLORS.subdued }}>Reason: </span>
                <span style={{ whiteSpace: 'pre-wrap' }}>{asText(sup.reason)}</span>
              </EuiText>
            </>
          ) : null}
        </div>
      ) : isMemory ? (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.subdued, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Candidate memory
          </div>
          <EuiSpacer size="xs" />
          <EuiText size="s">
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{asText(mem.text)}</p>
          </EuiText>
          {mem.category ? (
            <>
              <EuiSpacer size="xs" />
              <EuiBadge color="hollow" iconType="folderClosed">
                {humanizeToken(asText(mem.category))}
              </EuiBadge>
            </>
          ) : null}
        </div>
      ) : (
        // Unknown kind: render the payload defensively as plain text so we never
        // drop a proposal (and never inject markup).
        <EuiText size="s">
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{asText(proposal.payload)}</p>
        </EuiText>
      )}

      {/* rationale (UNTRUSTED → plain text) */}
      {proposal.rationale ? (
        <>
          <EuiSpacer size="m" />
          <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.subdued, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Why the agent drafted this
          </div>
          <EuiSpacer size="xs" />
          <EuiText size="s" color="subdued">
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{asText(proposal.rationale)}</p>
          </EuiText>
        </>
      ) : null}

      {/* linked source case(s) */}
      {cases.length ? (
        <>
          <EuiSpacer size="m" />
          <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                <span>Source {cases.length === 1 ? 'case' : 'cases'}:</span>
              </EuiText>
            </EuiFlexItem>
            {cases.map((cid) => (
              <EuiFlexItem grow={false} key={cid}>
                {onOpenCase ? (
                  <EuiBadge
                    color="hollow"
                    iconType="link"
                    onClick={() => onOpenCase(cid)}
                    onClickAriaLabel={`Open case ${cid}`}
                  >
                    {cid}
                  </EuiBadge>
                ) : (
                  <EuiBadge color="hollow" iconType="link">
                    {cid}
                  </EuiBadge>
                )}
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        </>
      ) : null}

      <EuiHorizontalRule margin="m" />

      {/* actions */}
      <EuiFlexGroup gutterSize="s" alignItems="center" justifyContent="flexEnd" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiIconTip
            type="lock"
            color="subdued"
            content={
              isSuppression
                ? 'Approving makes this suppression rule LIVE. This is a privileged action — the server enforces admin access.'
                : 'Approving saves this as a durable memory the agents will know. This is a privileged action — the server enforces admin access.'
            }
            aria-label="Approve requires admin"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButtonEmpty
            size="s"
            color="danger"
            iconType="cross"
            onClick={() => onReject(proposal)}
            isDisabled={busy}
          >
            Reject
          </EuiButtonEmpty>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton
            fill
            size="s"
            iconType="checkInCircleFilled"
            onClick={() => onApprove(proposal)}
            isLoading={busy}
            isDisabled={busy}
          >
            Approve
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
    </Card>
  );
};

/* --------------------------------------------------------------- filter bar -- */

const STATUS_FILTERS = [
  { id: 'pending', label: 'Pending' },
  { id: 'all', label: 'All' },
];

/* -------------------------------------------------------------------- page --- */

interface ProposalsPanelProps {
  /** Optional: open a case from a source-case chip (wires through to the Cases surface). */
  onOpenCase?: (caseId: string) => void;
}

export const ProposalsPanel: React.FC<ProposalsPanelProps> = ({ onOpenCase }) => {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');
  // Per-proposal in-flight guard (prevents double-submit of approve/reject).
  const [busyId, setBusyId] = useState<string | null>(null);
  // An inline, per-card error (esp. 403/409) shown above the list.
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  // Bulk selection + group-by-source/rule controls.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const addToast = useCallback((title: string, color: Toast['color'] = 'success') => {
    toastId.current += 1;
    setToasts((prev) => [...prev, { id: `prop-toast-${toastId.current}`, title, color }]);
  }, []);
  const removeToast = useCallback((t: Toast) => {
    setToasts((prev) => prev.filter((x) => x.id !== t.id));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // When 'all', send no status filter so the backend returns every proposal.
      const res = await api.listProposals(statusFilter === 'all' ? undefined : 'pending');
      setProposals(res.proposals ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // The count badge tracks pending proposals regardless of the active filter.
  const pendingCount = useMemo(
    () => proposals.filter((p) => (p.status || '').toLowerCase() === 'pending').length,
    [proposals],
  );

  const removeLocal = useCallback((id: string) => {
    setProposals((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const upsertLocal = useCallback((next: Proposal) => {
    setProposals((prev) => {
      const i = prev.findIndex((p) => p.id === next.id);
      if (i === -1) return prev;
      const copy = prev.slice();
      copy[i] = next;
      return copy;
    });
  }, []);

  const describeError = useCallback((e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.status === 403) return 'Approving requires admin access — you are not authorised.';
      if (e.status === 404) return 'This proposal no longer exists (it may have been decided already).';
      if (e.status === 409) return 'This proposal was already decided. Refresh to see its current state.';
      return e.message;
    }
    return e instanceof Error ? e.message : 'Action failed.';
  }, []);

  const decide = useCallback(
    async (proposal: Proposal, kind: 'approve' | 'reject') => {
      if (busyId) return; // guard against a second in-flight decision
      setBusyId(proposal.id);
      setActionError(null);
      try {
        const updated =
          kind === 'approve'
            ? await api.approveProposal(proposal.id)
            : await api.rejectProposal(proposal.id);
        // On the 'pending' view, a decided proposal leaves the queue. On 'all',
        // keep it but reflect its new status if the backend returned the updated
        // proposal (it may instead return a bare {ok:true}).
        if (statusFilter === 'pending') {
          removeLocal(proposal.id);
        } else if (updated && typeof updated === 'object' && (updated as Proposal).id) {
          upsertLocal(updated as Proposal);
        } else {
          // Fallback: stamp the local status so the row reflects the decision.
          upsertLocal({ ...proposal, status: kind === 'approve' ? 'approved' : 'rejected' });
        }
        const meta = kindMeta(proposal.kind);
        addToast(
          kind === 'approve'
            ? `${meta.label} approved — it is now live.`
            : `${meta.label} proposal rejected.`,
          kind === 'approve' ? 'success' : 'primary',
        );
      } catch (e) {
        const message = describeError(e);
        setActionError({ id: proposal.id, message });
        addToast(message, 'danger');
        // A 404/409 means the queue is stale — refresh to resync.
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
          void load();
        }
      } finally {
        setBusyId(null);
      }
    },
    [busyId, statusFilter, removeLocal, upsertLocal, addToast, describeError, load],
  );

  // Keep the selection in sync with the currently-loaded proposals.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(proposals.map((p) => p.id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (ids.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [proposals]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Decide every selected proposal sequentially (each call is still individually
  // guarded server-side; nothing here bypasses the per-proposal approval).
  const decideSelected = useCallback(
    async (kind: 'approve' | 'reject') => {
      const targets = proposals.filter((p) => selected.has(p.id));
      if (!targets.length || bulkBusy) return;
      setBulkBusy(true);
      setActionError(null);
      let ok = 0;
      let failed = 0;
      for (const p of targets) {
        try {
          const updated =
            kind === 'approve' ? await api.approveProposal(p.id) : await api.rejectProposal(p.id);
          if (statusFilter === 'pending') {
            removeLocal(p.id);
          } else if (updated && typeof updated === 'object' && (updated as Proposal).id) {
            upsertLocal(updated as Proposal);
          } else {
            upsertLocal({ ...p, status: kind === 'approve' ? 'approved' : 'rejected' });
          }
          ok += 1;
        } catch (e) {
          failed += 1;
          setActionError({ id: p.id, message: describeError(e) });
        }
      }
      clearSelection();
      setBulkBusy(false);
      if (ok) {
        addToast(
          `${ok} proposal${ok === 1 ? '' : 's'} ${kind === 'approve' ? 'approved' : 'rejected'}${
            failed ? ` · ${failed} failed` : ''
          }.`,
          failed ? 'warning' : kind === 'approve' ? 'success' : 'primary',
        );
      } else if (failed) {
        addToast(`All ${failed} action${failed === 1 ? '' : 's'} failed.`, 'danger');
      }
      if (failed) void load();
    },
    [
      proposals,
      selected,
      bulkBusy,
      statusFilter,
      removeLocal,
      upsertLocal,
      clearSelection,
      addToast,
      describeError,
      load,
    ],
  );

  // Group the visible proposals by source/rule when group-by is on.
  const groups = useMemo(() => {
    if (!groupBy) return null;
    const map = new Map<string, Proposal[]>();
    for (const p of proposals) {
      const key = groupKeyOf(p);
      const arr = map.get(key);
      if (arr) arr.push(p);
      else map.set(key, [p]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [proposals, groupBy]);

  const renderCard = (p: Proposal) => (
    <ProposalCard
      key={p.id}
      proposal={p}
      busy={busyId === p.id}
      selected={selected.has(p.id)}
      onToggleSelect={toggleSelect}
      onApprove={(pr) => void decide(pr, 'approve')}
      onReject={(pr) => void decide(pr, 'reject')}
      onOpenCase={onOpenCase}
    />
  );

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="flag"
        accent={COLORS.primary}
        eyebrow="Automation"
        title="Approvals"
        description="Agent-drafted recommendations awaiting human approval — suppression rules and durable memories."
        actions={
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
            {pendingCount > 0 ? (
              <EuiFlexItem grow={false}>
                <EuiToolTip content="Pending proposals awaiting a decision">
                  <EuiBadge color={tint(COLORS.warning, 0.16)} style={{ color: COLORS.warning }} iconType="flag">
                    {fmtNumber(pendingCount)} pending
                  </EuiBadge>
                </EuiToolTip>
              </EuiFlexItem>
            ) : null}
            <EuiFlexItem grow={false}>
              <EuiButtonGroup
                legend="Filter by status"
                options={STATUS_FILTERS}
                idSelected={statusFilter}
                onChange={(id) => setStatusFilter(id as 'pending' | 'all')}
                buttonSize="compressed"
              />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty size="s" iconType="refresh" onClick={() => void load()} isLoading={loading}>
                Refresh
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
        }
      />

      <EuiCallOut title="Nothing here is applied automatically" color="primary" iconType="iInCircle" size="s">
        <p>
          These are <strong>AI-drafted recommendations</strong>. Approving is the only thing that
          makes a rule live — nothing here is applied automatically. The agent recommends; you
          decide. Approving is a <strong>privileged action</strong> (the server enforces admin
          access), and the deterministic close/escalate logic is never changed by what you approve
          here.
        </p>
      </EuiCallOut>

      <EuiSpacer size="l" />

      <SectionHeader
        icon="flag"
        accent={COLORS.accent}
        title={statusFilter === 'pending' ? 'Pending proposals' : 'All proposals'}
        description={loading ? 'Loading…' : `${fmtNumber(proposals.length)} shown`}
        actions={
          proposals.length > 0 ? (
            <EuiToolTip content="Group proposals by their suppression field/value or memory category">
              <EuiSwitch
                compressed
                label="Group by source / rule"
                checked={groupBy}
                onChange={(e) => setGroupBy(e.target.checked)}
              />
            </EuiToolTip>
          ) : undefined
        }
      />

      {/* Sticky bulk-action bar — appears once one or more proposals are selected. */}
      {selected.size > 0 ? (
        <EuiPanel
          hasBorder
          paddingSize="s"
          style={{ position: 'sticky', top: 8, zIndex: 2, marginBottom: 12 }}
        >
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiBadge color={tint(COLORS.primary, 0.16)} style={{ color: COLORS.primary }}>
                {fmtNumber(selected.size)} selected
              </EuiBadge>
            </EuiFlexItem>
            <EuiFlexItem />
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty size="s" onClick={clearSelection} isDisabled={bulkBusy}>
                Clear
              </EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                size="s"
                color="danger"
                iconType="cross"
                onClick={() => void decideSelected('reject')}
                isDisabled={bulkBusy}
              >
                Reject selected
              </EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                fill
                size="s"
                iconType="checkInCircleFilled"
                onClick={() => void decideSelected('approve')}
                isLoading={bulkBusy}
                isDisabled={bulkBusy}
              >
                Approve selected
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiPanel>
      ) : null}

      {actionError ? (
        <>
          <EuiCallOut
            title="Could not complete that action"
            color="danger"
            iconType="alert"
            size="s"
          >
            <p>{actionError.message}</p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      ) : null}

      {error ? (
        <ErrorCallout error={error} title="Could not load proposals" />
      ) : loading && proposals.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[0, 1, 2].map((i) => (
            <EuiPanel hasBorder paddingSize="m" key={i}>
              <Skeleton rows={4} height={20} />
            </EuiPanel>
          ))}
        </div>
      ) : proposals.length === 0 ? (
        <EmptyState
          iconType="flag"
          title={statusFilter === 'pending' ? 'No pending proposals' : 'No proposals yet'}
          body={
            statusFilter === 'pending'
              ? 'No pending proposals — the agent drafts these when you confirm a false positive.'
              : 'No proposals have been drafted yet. The agent drafts these when it confirms a false positive or learns a durable fact.'
          }
        />
      ) : groups ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {groups.map(([label, rows]) => (
            <div key={label}>
              <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                <EuiFlexItem grow={false}>
                  <EuiBadge color={tint(COLORS.accent, 0.16)} style={{ color: COLORS.accent }} iconType="layers">
                    {label}
                  </EuiBadge>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiText size="xs" color="subdued">
                    <span>
                      {fmtNumber(rows.length)} proposal{rows.length === 1 ? '' : 's'}
                    </span>
                  </EuiText>
                </EuiFlexItem>
              </EuiFlexGroup>
              <EuiSpacer size="s" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {rows.map(renderCard)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {proposals.map(renderCard)}
        </div>
      )}

      <EuiHorizontalRule margin="l" />
      <EuiText size="xs" color="subdued">
        <p>
          A suppression rule only suppresses future matching alerts once approved; a memory is only
          saved once approved. Rejected proposals are discarded. Proposal fields, values and
          rationale derive from log events and are rendered as plain text. {DASH}
        </p>
      </EuiText>

      <EuiGlobalToastList toasts={toasts} dismissToast={removeToast} toastLifeTimeMs={5000} />
    </div>
  );
};
