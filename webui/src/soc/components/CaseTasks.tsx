/**
 * CaseTasks — a per-case checklist with status + an append-only log trail (#4).
 *
 * Backed by `GET/POST /api/cases/{id}/tasks`, `PATCH .../{tid}`, and
 * `POST .../{tid}/log`. A task is advisory work-tracking: its status
 * (open / in_progress / done / blocked) is NOT a case status and never touches the
 * deterministic decision (#3 — enforced backend-side).
 *
 * SECURITY (#9): every task `title`, `assignee`, and log `note` is operator-authored
 * UNTRUSTED text — rendered EXCLUSIVELY as plain text nodes, never markup. Writes are
 * gated by the caller (the add/edit controls are only shown when `canWrite`).
 */
import * as React from 'react';
import {
  Ban,
  Check,
  CircleDot,
  Clock,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Plus,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, humanizeAge } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import { Popover, PopoverTrigger, PopoverContent } from '@/ui/popover';
import { EmptyState } from '@/soc/components/EmptyState';
import { IconButton } from '@/soc/components/IconButton';
import { SectionHeading } from '@/soc/pages/casedetail/shared';

import type { CaseTask, TaskStatus } from '@/soc/pages/CaseDetail.api';

/* ----------------------------------------------------------------- status -- */

interface StatusMeta {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge: 'secondary' | 'info' | 'success' | 'high';
  done: boolean;
}

const STATUS_META: Record<string, StatusMeta> = {
  open: { label: 'Open', icon: CircleDot, badge: 'secondary', done: false },
  in_progress: { label: 'In progress', icon: Clock, badge: 'info', done: false },
  done: { label: 'Done', icon: Check, badge: 'success', done: true },
  blocked: { label: 'Blocked', icon: Ban, badge: 'high', done: false },
};

const STATUS_OPTIONS: Array<{ value: TaskStatus; text: string }> = [
  { value: 'open', text: 'Open' },
  { value: 'in_progress', text: 'In progress' },
  { value: 'done', text: 'Done' },
  { value: 'blocked', text: 'Blocked' },
];

function statusMeta(status: string): StatusMeta {
  return STATUS_META[(status || '').toLowerCase()] || STATUS_META.open;
}

/**
 * Normalise an arbitrary status to the canonical Select value. The status <Select>
 * options are the lowercase canonical set, but `task.status` is typed to allow any
 * string (and the backend may return "Done"/"OPEN"/unknown). `statusMeta()` already
 * lowercases + defaults for the BADGE; mirror that here so the dropdown trigger never
 * renders blank while the badge shows a value.
 */
export function canonicalStatus(status: string): TaskStatus {
  const s = (status || '').toLowerCase();
  return (STATUS_META[s] ? s : 'open') as TaskStatus;
}

/* --------------------------------------------------------------- task row -- */

interface TaskRowProps {
  task: CaseTask;
  canWrite: boolean;
  busy: boolean;
  onStatus: (status: TaskStatus) => void;
  onLog: (note: string) => void;
}

const TaskRow: React.FC<TaskRowProps> = ({ task, canWrite, busy, onStatus, onLog }) => {
  const meta = statusMeta(task.status);
  const [logOpen, setLogOpen] = React.useState(false);
  const [note, setNote] = React.useState('');
  const logs = Array.isArray(task.logs) ? task.logs : [];

  // The primary toggle cycles open ↔ done (the common checklist gesture). The full
  // status menu offers in_progress / blocked.
  const toggleDone = () => onStatus(meta.done ? 'open' : 'done');

  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-3">
        <IconButton
          label={meta.done ? 'Mark task not done' : 'Mark task done'}
          tooltip={false}
          size="sm"
          disabled={!canWrite || busy}
          onClick={toggleDone}
          aria-pressed={meta.done}
          className={cn(
            'mt-0.5 rounded-md border [&_svg]:size-3.5',
            meta.done
              ? 'border-success bg-success/20 text-success'
              : 'border-border text-transparent hover:border-primary hover:bg-transparent',
            (!canWrite || busy) && 'cursor-default opacity-70',
          )}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> : <Check className="h-3.5 w-3.5" />}
        </IconButton>

        <div className="min-w-0 flex-1">
          {/* UNTRUSTED title — plain text. */}
          <p
            className={cn(
              'break-words text-sm text-foreground',
              meta.done && 'text-muted-foreground line-through',
            )}
          >
            {task.title || DASH}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge variant={meta.badge} className="gap-1 px-1.5 py-0">
              <meta.icon className="h-3 w-3" />
              {meta.label}
            </Badge>
            {task.assignee ? (
              /* UNTRUSTED assignee — plain text. */
              <span className="truncate">@{task.assignee}</span>
            ) : null}
            {task.created_at ? <span>· {humanizeAge(task.created_at)}</span> : null}
            {logs.length ? (
              <button
                type="button"
                onClick={() => setLogOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground"
              >
                <MessageSquarePlus className="h-3 w-3" />
                {logs.length} note{logs.length === 1 ? '' : 's'}
              </button>
            ) : null}
          </div>
        </div>

        {canWrite ? (
          <div className="flex shrink-0 items-center gap-1">
            <Select
              value={canonicalStatus(task.status)}
              onValueChange={(v) => onStatus(v as TaskStatus)}
              disabled={busy}
            >
              <SelectTrigger className="h-7 w-[7.5rem] text-xs" aria-label="Task status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Popover open={logOpen} onOpenChange={setLogOpen}>
              <PopoverTrigger asChild>
                <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Add a log note">
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 space-y-2">
                <p className="text-xs font-semibold text-foreground">Task log</p>
                {logs.length ? (
                  <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                    {logs.map((l, i) => (
                      <li key={i} className="rounded border border-border bg-muted/30 p-2 text-xs">
                        {/* UNTRUSTED note — plain text. */}
                        <p className="whitespace-pre-wrap break-words text-foreground/90">
                          {String(l?.note ?? '')}
                        </p>
                        <p className="mt-0.5 text-2xs text-muted-foreground">
                          {l?.by ? `${String(l.by)} · ` : ''}
                          {l?.ts ? humanizeAge(String(l.ts)) : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No log entries yet.</p>
                )}
                <Input
                  placeholder="Add a note…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && note.trim()) {
                      onLog(note.trim());
                      setNote('');
                    }
                  }}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!note.trim() || busy}
                    onClick={() => {
                      if (note.trim()) {
                        onLog(note.trim());
                        setNote('');
                      }
                    }}
                  >
                    Add note
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        ) : null}
      </div>

      {/* inline log view (toggled from the count) */}
      {logOpen && logs.length && !canWrite ? (
        <ul className="mt-2 space-y-1.5 border-t border-border pt-2">
          {logs.map((l, i) => (
            <li key={i} className="text-xs">
              <p className="whitespace-pre-wrap break-words text-foreground/90">
                {String(l?.note ?? '')}
              </p>
              <p className="text-2xs text-muted-foreground">
                {l?.by ? `${String(l.by)} · ` : ''}
                {l?.ts ? humanizeAge(String(l.ts)) : ''}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
};

/* --------------------------------------------------------------- component -- */

export interface CaseTasksProps {
  tasks: CaseTask[];
  canWrite: boolean;
  /** A task id currently mutating (disables its controls). */
  busyId?: string | null;
  onAdd: (title: string) => void;
  onStatus: (taskId: string, status: TaskStatus) => void;
  onLog: (taskId: string, note: string) => void;
  className?: string;
}

/**
 * The case task checklist. Sorted by manual order then creation; a progress count
 * header; an inline add composer when the caller can write.
 */
export const CaseTasks: React.FC<CaseTasksProps> = ({
  tasks,
  canWrite,
  busyId = null,
  onAdd,
  onStatus,
  onLog,
  className,
}) => {
  const [draft, setDraft] = React.useState('');

  const ordered = React.useMemo(
    () =>
      [...tasks].sort(
        (a, b) =>
          (a.order ?? 0) - (b.order ?? 0) ||
          Date.parse(a.created_at || '') - Date.parse(b.created_at || ''),
      ),
    [tasks],
  );
  const doneCount = ordered.filter((t) => statusMeta(t.status).done).length;

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft('');
  };

  return (
    <div className={cn('space-y-3', className)}>
      <SectionHeading
        icon={ListChecks}
        actions={
          ordered.length ? (
            <Badge variant="outline" className="tabular-nums">
              {doneCount}/{ordered.length} done
            </Badge>
          ) : undefined
        }
      >
        Tasks
      </SectionHeading>

      {ordered.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          compact
          title="No tasks yet"
          description={
            canWrite
              ? 'Break the response into a checklist so nothing is missed on hand-off.'
              : 'No follow-up tasks have been added to this case.'
          }
        />
      ) : (
        <ul className="space-y-2">
          {ordered.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              canWrite={canWrite}
              busy={busyId === t.id}
              onStatus={(status) => onStatus(t.id, status)}
              onLog={(note) => onLog(t.id, note)}
            />
          ))}
        </ul>
      )}

      {canWrite ? (
        <div className="flex items-center gap-2">
          <Input
            placeholder="Add a task…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button
            size="sm"
            onClick={submit}
            disabled={!draft.trim() || busyId === '__add__'}
          >
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      ) : null}
    </div>
  );
};

export default CaseTasks;
