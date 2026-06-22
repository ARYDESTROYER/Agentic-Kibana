import React, { useEffect, useState } from 'react';
import {
  EuiButton,
  EuiButtonIcon,
  EuiCallOut,
  EuiConfirmModal,
  EuiContextMenuItem,
  EuiContextMenuPanel,
  EuiDragDropContext,
  EuiDraggable,
  EuiDroppable,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiLoadingSpinner,
  EuiNotificationBadge,
  EuiPanel,
  EuiPopover,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  type DropResult,
} from '@elastic/eui';
import type { Case } from '../../common';
import type { TlsocApi } from '../lib/api';
import { humanizeToken } from '../lib/format';
import { CaseCard } from './case_card';
import { EmptyState, SectionHeader, statusHex } from './ui';

interface BoardProps {
  api: TlsocApi;
  /** Open the stored case (GET by id) in the app-level detail flyout. */
  onOpenCase: (caseId: string) => void;
  /** Bumped by the app shell to force a re-fetch (e.g. after a flyout edit). */
  refreshSignal?: number;
}

/**
 * C3-2 — Kanban board of cases over the three real `CaseStatus` values. There is
 * no separate "escalated" status: `needs_human` IS the escalated lane. Each
 * column is fetched independently from the cases list (filtered by status), and
 * drag-between-columns maps to a lifecycle action on the case action endpoint.
 *
 * Interaction model (addresses the "can't move the items" complaint): every card
 * carries a VISIBLE grab handle (drag) AND a per-card actions menu (a reliable,
 * click-only fallback). Both routes funnel into the same confirm flow, so the
 * lifecycle action is identical no matter how the analyst initiates the move.
 * Opening a card no longer switches tabs — it raises the global detail flyout via
 * `onOpenCase`, and the shared `CaseCard` renders the uniform card body.
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

interface PendingMove {
  caseId: string;
  from: ColumnId;
  to: ColumnId;
  action: 'close' | 'reopen' | 'escalate';
}

/**
 * The lifecycle moves the actions menu offers for a card, keyed by the column it
 * currently lives in. These mirror the cross-column drops the board allows:
 * open → Close / Escalate; needs_human → Close; closed → Reopen.
 */
const MENU_MOVES: Record<ColumnId, ColumnId[]> = {
  open: ['closed', 'needs_human'],
  needs_human: ['closed'],
  closed: ['open'],
};

/**
 * The per-card actions menu rendered as the card's `cornerActions`. It owns its
 * own open/close state so each card's popover is independent. The card body now
 * lives in the shared `CaseCard`; this is only the reliable, click-only move path
 * (plus an explicit "Open case"). Every move funnels into `onRequestMove`, which
 * the Board routes through the same confirm flow as a cross-column drop.
 */
const CardMenu: React.FC<{
  column: ColumnId;
  onOpen: () => void;
  onRequestMove: (to: ColumnId) => void;
}> = ({ column, onOpen, onRequestMove }) => {
  const [menuOpen, setMenuOpen] = useState(false);

  const menuItems = [
    <EuiContextMenuItem
      key="open"
      icon="inspect"
      onClick={() => {
        setMenuOpen(false);
        onOpen();
      }}
    >
      Open case
    </EuiContextMenuItem>,
    ...MENU_MOVES[column].map((to) => (
      <EuiContextMenuItem
        key={to}
        icon={COLUMN_ACTION[to] === 'escalate' ? 'alert' : COLUMN_ACTION[to] === 'close' ? 'check' : 'refresh'}
        onClick={() => {
          setMenuOpen(false);
          onRequestMove(to);
        }}
      >
        {ACTION_LABEL[COLUMN_ACTION[to]]}
      </EuiContextMenuItem>
    )),
  ];

  return (
    <EuiPopover
      isOpen={menuOpen}
      closePopover={() => setMenuOpen(false)}
      anchorPosition="downRight"
      panelPaddingSize="none"
      button={
        <EuiButtonIcon
          iconType="boxesVertical"
          aria-label="Case actions"
          color="text"
          onClick={() => setMenuOpen((o) => !o)}
        />
      }
    >
      <EuiContextMenuPanel items={menuItems} />
    </EuiPopover>
  );
};

export const Board: React.FC<BoardProps> = ({ api, onOpenCase, refreshSignal }) => {
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

  // Drive the initial load AND every re-fetch off `refreshSignal`, so the board
  // re-syncs whenever a case is changed elsewhere (e.g. in the global flyout).
  useEffect(() => {
    loadBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

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

  /** Queue a cross-column move (from either a drop or the actions menu). */
  const requestMove = (caseId: string, from: ColumnId, to: ColumnId) => {
    if (from === to) {
      return;
    }
    setNote('');
    setPending({ caseId, from, to, action: COLUMN_ACTION[to] });
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
    requestMove(draggableId, from, to);
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

  const isEmpty =
    columns.open.length + columns.needs_human.length + columns.closed.length === 0;

  return (
    <div>
      <SectionHeader
        icon="apps"
        title="Case Board"
        description="Triage queue across the case lifecycle. Drag a card or use its menu to move it."
        actions={
          <EuiButton size="s" iconType="refresh" onClick={loadBoard} isLoading={loading}>
            Refresh
          </EuiButton>
        }
      />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="s" />
        </>
      ) : null}

      {loading && isEmpty ? (
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
          {/* Horizontal lane (scss flex container) so columns never get cramped. */}
          <div className="tlsocBoard__scroll">
            {COLUMNS.map((col) => (
              <div className="tlsocBoard__column" key={col.id}>
                <EuiPanel hasBorder color="subdued" paddingSize="s">
                  {/* Coloured column header: status dot · title · count badge. */}
                  <EuiFlexGroup
                    justifyContent="spaceBetween"
                    alignItems="center"
                    gutterSize="s"
                    responsive={false}
                  >
                    <EuiFlexItem grow={false}>
                      <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
                        <EuiFlexItem grow={false}>
                          <span
                            aria-hidden
                            style={{
                              display: 'inline-block',
                              width: 10,
                              height: 10,
                              borderRadius: '50%',
                              background: statusHex(col.id),
                            }}
                          />
                        </EuiFlexItem>
                        <EuiFlexItem grow={false}>
                          <EuiText size="s">
                            <strong>{humanizeToken(col.id)}</strong>
                          </EuiText>
                        </EuiFlexItem>
                      </EuiFlexGroup>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiNotificationBadge color="subdued">
                        {columns[col.id].length}
                      </EuiNotificationBadge>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <EuiSpacer size="s" />
                  <EuiDroppable
                    droppableId={col.id}
                    spacing="s"
                    className="tlsocBoard__dropZone"
                  >
                    {columns[col.id].length === 0 ? (
                      <EmptyState
                        iconType="inspect"
                        title="No cases"
                        body="Nothing in this lane right now."
                      />
                    ) : (
                      columns[col.id].map((c, idx) => (
                        <EuiDraggable
                          key={c.case_id}
                          index={idx}
                          draggableId={c.case_id}
                          spacing="s"
                          customDragHandle
                          hasInteractiveChildren
                        >
                          {(provided, state) => (
                            // The shared card owns hover/elevation; we only nudge
                            // opacity while dragging for a subtle lift cue.
                            <div style={state.isDragging ? { opacity: 0.9 } : undefined}>
                              <CaseCard
                                theCase={c}
                                onOpen={() => c.case_id && onOpenCase(c.case_id)}
                                dragHandle={
                                  <span
                                    className="tlsocCard__handle"
                                    aria-label="Drag to move case"
                                    {...(provided.dragHandleProps ?? undefined)}
                                  >
                                    <EuiIcon type="grab" />
                                  </span>
                                }
                                cornerActions={
                                  <CardMenu
                                    column={col.id}
                                    onOpen={() => c.case_id && onOpenCase(c.case_id)}
                                    onRequestMove={(to) => requestMove(c.case_id, col.id, to)}
                                  />
                                }
                              />
                            </div>
                          )}
                        </EuiDraggable>
                      ))
                    )}
                  </EuiDroppable>
                </EuiPanel>
              </div>
            ))}
          </div>
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
