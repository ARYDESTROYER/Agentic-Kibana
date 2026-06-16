import React, { useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiCallOut,
  EuiConfirmModal,
  EuiDragDropContext,
  EuiDraggable,
  EuiDroppable,
  EuiFlexGroup,
  EuiFlexItem,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  EuiTitle,
  type DropResult,
} from '@elastic/eui';
import type { Case } from '../../common';
import type { TlsocApi } from '../lib/api';

interface BoardProps {
  api: TlsocApi;
  /** Open the stored case (GET by id) in the Investigate detail view. */
  onOpenCase?: (caseId: string) => void;
}

/**
 * C3-2 — Kanban board of cases over the three real `CaseStatus` values. There is
 * no separate "escalated" status: `needs_human` IS the escalated lane. Each
 * column is fetched independently from the cases list (filtered by status), and
 * drag-between-columns maps to a lifecycle action on the case action endpoint.
 */
type ColumnId = 'open' | 'needs_human' | 'closed';

const COLUMNS: Array<{ id: ColumnId; title: string }> = [
  { id: 'open', title: 'Open' },
  { id: 'needs_human', title: 'Needs human (escalated)' },
  { id: 'closed', title: 'Closed' },
];

// Dropping a card into a column maps to the lifecycle action that produces that
// status. Backend mapping (routes.py): close→CLOSED, reopen→OPEN, escalate→NEEDS_HUMAN.
const COLUMN_ACTION: Record<ColumnId, 'close' | 'reopen' | 'escalate'> = {
  closed: 'close',
  open: 'reopen',
  needs_human: 'escalate',
};

const ACTION_LABEL: Record<'close' | 'reopen' | 'escalate', string> = {
  close: 'Close',
  reopen: 'Reopen',
  escalate: 'Escalate',
};

type ColumnState = Record<ColumnId, Case[]>;

const emptyColumns: ColumnState = { open: [], needs_human: [], closed: [] };

function verdictColor(verdict?: string): 'danger' | 'success' | 'warning' | 'default' {
  const v = (verdict || '').toUpperCase();
  if (v.includes('TRUE')) return 'danger';
  if (v.includes('FALSE')) return 'success';
  if (v.includes('INCONCLUSIVE') || v.includes('UNKNOWN') || v.includes('NEEDS_HUMAN')) {
    return 'warning';
  }
  return 'default';
}

/** Humanize an ISO timestamp into a short relative age (e.g. "3h ago"). */
function humanizeAge(iso?: string): string {
  if (!iso) {
    return '-';
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '-';
  }
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

interface PendingMove {
  caseId: string;
  from: ColumnId;
  to: ColumnId;
  action: 'close' | 'reopen' | 'escalate';
}

const CaseCard: React.FC<{ theCase: Case; onOpen?: () => void }> = ({ theCase: c, onOpen }) => {
  const age = humanizeAge(c.updated_at || c.created_at);
  const source = c.origin_surface || c.source_surface;
  return (
    <EuiPanel
      hasBorder
      paddingSize="s"
      onClick={onOpen}
      style={onOpen ? { cursor: 'pointer' } : undefined}
    >
      <EuiText size="s">
        <strong>{c.entity ? `${c.entity.type}: ${c.entity.value}` : c.title || c.case_id}</strong>
      </EuiText>

      {c.rule_ids && c.rule_ids.length ? (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="subdued">
            {c.rule_ids.join(', ')}
          </EuiText>
        </>
      ) : null}

      <EuiSpacer size="xs" />
      <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
        {typeof c.risk_score === 'number' ? (
          <EuiFlexItem grow={false}>
            <EuiBadge color="hollow">risk {c.risk_score}</EuiBadge>
          </EuiFlexItem>
        ) : null}
        {c.verdict ? (
          <EuiFlexItem grow={false}>
            <EuiBadge color={verdictColor(c.verdict)}>{c.verdict}</EuiBadge>
          </EuiFlexItem>
        ) : null}
        {typeof c.confidence === 'number' ? (
          <EuiFlexItem grow={false}>
            <EuiBadge color="hollow">conf {(c.confidence * 100).toFixed(0)}%</EuiBadge>
          </EuiFlexItem>
        ) : null}
      </EuiFlexGroup>

      {c.trigger_reason?.sentence ? (
        <>
          <EuiSpacer size="xs" />
          <EuiText size="xs" color="subdued">
            {c.trigger_reason.sentence}
          </EuiText>
        </>
      ) : null}

      <EuiSpacer size="xs" />
      <EuiFlexGroup justifyContent="spaceBetween" gutterSize="xs" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            {source || 'unknown'}
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            {age}
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>
    </EuiPanel>
  );
};

export const Board: React.FC<BoardProps> = ({ api, onOpenCase }) => {
  const [columns, setColumns] = useState<ColumnState>(emptyColumns);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);

  const loadBoard = async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        COLUMNS.map((col) =>
          api.get<{ cases: Case[]; total: number }>(
            `cases?status=${col.id}&limit=50&offset=0`
          )
        )
      );
      const next: ColumnState = { open: [], needs_human: [], closed: [] };
      COLUMNS.forEach((col, idx) => {
        next[col.id] = results[idx]?.cases || [];
      });
      setColumns(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moveCard = (caseId: string, from: ColumnId, to: ColumnId, toIndex: number): ColumnState => {
    const next: ColumnState = {
      open: [...columns.open],
      needs_human: [...columns.needs_human],
      closed: [...columns.closed],
    };
    const idx = next[from].findIndex((c) => c.case_id === caseId);
    if (idx < 0) {
      return columns;
    }
    const [card] = next[from].splice(idx, 1);
    next[to].splice(Math.min(toIndex, next[to].length), 0, card);
    return next;
  };

  const onDragEnd = (result: DropResult) => {
    const { source, destination, draggableId } = result;
    if (!destination) {
      return;
    }
    const from = source.droppableId as ColumnId;
    const to = destination.droppableId as ColumnId;
    if (from === to) {
      // Same-column reorder — purely visual; persist the optimistic order.
      setColumns((prev) => {
        const list = [...prev[from]];
        const [card] = list.splice(source.index, 1);
        list.splice(destination.index, 0, card);
        return { ...prev, [from]: list };
      });
      return;
    }
    // Cross-column drop → confirm a lifecycle action.
    setNote('');
    setPending({ caseId: draggableId, from, to, action: COLUMN_ACTION[to] });
  };

  const confirmMove = async () => {
    if (!pending) {
      return;
    }
    const { caseId, from, to, action } = pending;
    const before = columns;
    // Optimistic: move the card to the destination column immediately.
    const optimistic = moveCard(caseId, from, to, 0);
    setColumns(optimistic);
    setActing(true);
    setError(null);
    try {
      await api.post<Case>(`cases/${caseId}/action`, { action, note });
      // Reload to reflect canonical stored state (status / updated_at).
      await loadBoard();
    } catch (e) {
      // Revert on error.
      setColumns(before);
      setError(
        `Could not ${ACTION_LABEL[action].toLowerCase()} case ${caseId}: ${(e as Error).message}`
      );
    } finally {
      setActing(false);
      setPending(null);
      setNote('');
    }
  };

  return (
    <div>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="s">
            <h2>Case Board</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton size="s" iconType="refresh" onClick={loadBoard} isLoading={loading}>
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

      {loading && columns.open.length + columns.needs_human.length + columns.closed.length === 0 ? (
        <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiLoadingSpinner size="l" />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiText size="s">Loading cases...</EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>
      ) : (
        <EuiDragDropContext onDragEnd={onDragEnd}>
          <EuiFlexGroup gutterSize="m" alignItems="flexStart">
            {COLUMNS.map((col) => (
              <EuiFlexItem key={col.id}>
                <EuiPanel hasBorder color="subdued" paddingSize="s">
                  <EuiFlexGroup
                    justifyContent="spaceBetween"
                    alignItems="center"
                    gutterSize="xs"
                    responsive={false}
                  >
                    <EuiFlexItem grow={false}>
                      <EuiTitle size="xxs">
                        <h3>{col.title}</h3>
                      </EuiTitle>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiBadge color="hollow">{columns[col.id].length}</EuiBadge>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <EuiSpacer size="xs" />
                  <EuiDroppable droppableId={col.id} spacing="s" style={{ minHeight: 80 }}>
                    {columns[col.id].length === 0 ? (
                      <EuiText size="xs" color="subdued">
                        <p>No cases.</p>
                      </EuiText>
                    ) : (
                      columns[col.id].map((c, idx) => (
                        <EuiDraggable
                          key={c.case_id}
                          index={idx}
                          draggableId={c.case_id}
                          spacing="s"
                        >
                          {() => (
                            <CaseCard
                              theCase={c}
                              onOpen={
                                onOpenCase && c.case_id
                                  ? () => onOpenCase(c.case_id)
                                  : undefined
                              }
                            />
                          )}
                        </EuiDraggable>
                      ))
                    )}
                  </EuiDroppable>
                </EuiPanel>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        </EuiDragDropContext>
      )}

      {pending ? (
        <EuiConfirmModal
          title={`${ACTION_LABEL[pending.action]} this case?`}
          onCancel={() => {
            setPending(null);
            setNote('');
          }}
          onConfirm={confirmMove}
          cancelButtonText="Cancel"
          confirmButtonText={ACTION_LABEL[pending.action]}
          buttonColor={pending.action === 'escalate' ? 'warning' : 'primary'}
          isLoading={acting}
        >
          <EuiText size="s">
            <p>
              Move case <strong>{pending.caseId}</strong> to{' '}
              <strong>{COLUMNS.find((c) => c.id === pending.to)?.title}</strong> (
              {ACTION_LABEL[pending.action].toLowerCase()}).
            </p>
          </EuiText>
          <EuiSpacer size="s" />
          <EuiTextArea
            fullWidth
            placeholder="Optional note (recorded on the case)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Optional note for this action"
          />
        </EuiConfirmModal>
      ) : null}
    </div>
  );
};
