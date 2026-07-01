/**
 * CaseDetail — Collaboration panel (Coupling-D split).
 *
 * The full collaboration surface for a case (#4): the discussion thread (AI is a
 * first-class author but can only RECOMMEND), an assignee picker, a task checklist,
 * and the activity feed — all over the Round-3 collaboration endpoints. Writes are
 * gated by `canComment` / `canWrite` (the caller passes the resolved RBAC booleans).
 *
 * SECURITY (#9): thread bodies, task titles, assignee ids, activity summaries are all
 * UNTRUSTED — rendered plain text inside the child components. #3-safe: nothing here
 * changes the case decision (the backend enforces this).
 */
import * as React from 'react';
import { AlertTriangle, History, MessageSquare, RefreshCw, Save, Users } from 'lucide-react';

import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { Case } from '@/lib/types';

import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';

import { CaseThread, visibleMessageCount } from '@/soc/components/CaseThread';
import { CaseTasks } from '@/soc/components/CaseTasks';
import { CaseActivityFeed } from '@/soc/components/CaseActivityFeed';
import type {
  CaseMessage as ThreadMessage,
  CaseTask as CaseTaskItem,
  CaseActivityItem,
  PickableUser,
  TaskStatus,
} from '@/soc/pages/CaseDetail.api';

import { PanelCard, SectionHeading } from './shared';

/** An assignee picker over the known users (with a free-text fallback when the user
 *  store is empty / auth is off). Saves via api.caseAssign + bubbles the updated case
 *  through `onAssigned`. The assignee string is UNTRUSTED → rendered plain. */
const AssigneePicker: React.FC<{
  c: Case;
  users: PickableUser[];
  canWrite: boolean;
  onAssigned: (next: Case) => void;
}> = ({ c, users, canWrite, onAssigned }) => {
  const current = (c.assignee || '').trim();
  const [free, setFree] = React.useState(current);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => setFree(c.assignee || ''), [c.assignee]);

  const save = React.useCallback(
    async (value: string) => {
      setSaving(true);
      try {
        const next = await api.caseAssign(c.case_id, value.trim());
        onAssigned(next);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save the assignee.');
      } finally {
        setSaving(false);
      }
    },
    [c.case_id, onAssigned],
  );

  // When we have a user list, use a Select; otherwise a free-text input + Save.
  if (users.length) {
    const known = users.some((u) => u.username.toLowerCase() === current.toLowerCase());
    return (
      <div className="flex items-center gap-2">
        <Select
          value={current && known ? current : '__unassigned__'}
          disabled={!canWrite || saving}
          onValueChange={(v) => void save(v === '__unassigned__' ? '' : v)}
        >
          <SelectTrigger className="h-9 w-full" aria-label="Assignee">
            <SelectValue placeholder="Unassigned" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__unassigned__">Unassigned</SelectItem>
            {/* If the current assignee is a free-text id not in the user list, keep it
                selectable so it isn't silently lost. UNTRUSTED → plain text. */}
            {current && !known ? <SelectItem value={current}>{current}</SelectItem> : null}
            {users.map((u) => (
              <SelectItem key={u.username} value={u.username}>
                {/* UNTRUSTED username — plain text. */}
                {u.username}
                {u.role ? ` · ${u.role}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {saving ? <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>
    );
  }

  const dirty = free.trim() !== current;
  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder="Unassigned — type to assign…"
        value={free}
        disabled={!canWrite}
        onChange={(e) => setFree(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && dirty) void save(free);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!canWrite || !dirty || saving}
        onClick={() => void save(free)}
      >
        {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save
      </Button>
    </div>
  );
};

export const CollaborationThreadTab: React.FC<{
  c: Case;
  thread: ThreadMessage[] | null;
  threadLoading: boolean;
  threadError: unknown;
  threadBusyId: string | null;
  tasks: CaseTaskItem[] | null;
  tasksBusyId: string | null;
  activity: CaseActivityItem[] | null;
  activityLoading: boolean;
  users: PickableUser[];
  currentUser: string | null;
  canComment: boolean;
  canWrite: boolean;
  onRetryThread: () => void;
  onPost: (text: string) => void;
  onReply: (parentId: string, text: string) => void;
  onEdit: (msgId: string, text: string) => void;
  onDelete: (msgId: string) => void;
  onReact: (msgId: string, emoji: string, remove: boolean) => void;
  onAddTask: (title: string) => void;
  onTaskStatus: (taskId: string, status: TaskStatus) => void;
  onTaskLog: (taskId: string, note: string) => void;
  onAssigned: (next: Case) => void;
  /**
   * Optional LIVE wiring (Wave 4): when set, the thread + activity feed subscribe to
   * the per-case SSE room and nudge the caller to refetch on a `case.activity` frame
   * (realtime is still default-OFF on the backend → polling fallback otherwise).
   */
  liveCaseId?: string;
  onLiveThread?: () => void;
  onLiveActivity?: () => void;
}> = ({
  c,
  thread,
  threadLoading,
  threadError,
  threadBusyId,
  tasks,
  tasksBusyId,
  activity,
  activityLoading,
  users,
  currentUser,
  canComment,
  canWrite,
  onRetryThread,
  onPost,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onAddTask,
  onTaskStatus,
  onTaskLog,
  onAssigned,
  liveCaseId,
  onLiveThread,
  onLiveActivity,
}) => {
  return (
    <div className="grid gap-6 p-6 lg:grid-cols-[1fr_20rem]">
      {/* -------------------------------------------------- main: the thread */}
      <div className="min-w-0 space-y-6">
        <PanelCard>
          <SectionHeading
            icon={MessageSquare}
            actions={(() => {
              // Count the SAME set CaseThread renders (drop tombstoned roots with no
              // replies) so the badge can never over-count vs the visible list.
              const visible = thread ? visibleMessageCount(thread) : 0;
              return visible ? (
                <Badge variant="info">
                  {visible} message{visible === 1 ? '' : 's'}
                </Badge>
              ) : undefined;
            })()}
          >
            Discussion
          </SectionHeading>
          {threadLoading && thread === null ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : threadError ? (
            <div>
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Could not load the thread</AlertTitle>
                <AlertDescription>
                  {threadError instanceof Error ? threadError.message : 'Something went wrong.'}
                </AlertDescription>
              </Alert>
              <Button className="mt-3" size="sm" variant="outline" onClick={onRetryThread}>
                <RefreshCw className="h-4 w-4" /> Retry
              </Button>
            </div>
          ) : (
            <CaseThread
              messages={thread || []}
              users={users}
              currentUser={currentUser}
              canComment={canComment}
              busyId={threadBusyId}
              onPost={onPost}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onReact={onReact}
              liveCaseId={liveCaseId}
              onLiveActivity={onLiveThread}
            />
          )}
        </PanelCard>
      </div>

      {/* -------------------------------------------------- aside: ownership */}
      <aside className="space-y-6">
        <PanelCard className="p-4">
          <SectionHeading icon={Users}>
            Ownership
          </SectionHeading>
          <Label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">
            Assignee
          </Label>
          <AssigneePicker c={c} users={users} canWrite={canWrite} onAssigned={onAssigned} />
        </PanelCard>

        <PanelCard className="p-4">
          <CaseTasks
            tasks={tasks || []}
            canWrite={canWrite}
            busyId={tasksBusyId}
            onAdd={onAddTask}
            onStatus={onTaskStatus}
            onLog={onTaskLog}
          />
        </PanelCard>

        <PanelCard className="p-4">
          <SectionHeading icon={History}>
            Activity
          </SectionHeading>
          <CaseActivityFeed
            items={activity || []}
            loading={activityLoading && activity === null}
            liveCaseId={liveCaseId}
            onLiveActivity={onLiveActivity}
          />
        </PanelCard>
      </aside>
    </div>
  );
};

export default CollaborationThreadTab;
