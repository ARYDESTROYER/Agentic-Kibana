/**
 * CaseDetail — the core analyst workflow surface (thin orchestrator).
 *
 * Opened with a `caseId`, it fetches the full case (`api.getCase`) and presents a
 * WIDE right-side Sheet modeled on the reference "case report" page:
 *   - a header (title, created/updated, action buttons: reinvestigate / run-playbook /
 *     refresh / chat / history / export / notify),
 *   - the tabbed body — one lazy panel per tab (Overview / Why / Threat context /
 *     Trace / Collaboration / Feedback / Chat),
 *   - a footer with ONE context-dependent primary CTA, ONE unified Close-with-
 *     disposition secondary, and an overflow "More" menu,
 *   - the shared confirm-action dialog (every lifecycle action) + a Notify dialog.
 *
 * COUPLING-D SPLIT: the conceptual panels now live in `soc/pages/casedetail/*`
 * (OverviewPanel · WhyPanel · ThreatContextPanel · CollaborationPanel · FeedbackPanel ·
 * CaseChatPanel), the lifecycle action model + small building blocks in `./shared`,
 * and the close-with-disposition dialog in `./ConfirmActionDialog`. This file is the
 * ORCHESTRATOR: it owns the fetch/lazy-load/mutation state and wires it to the panels.
 *
 * Contract (FROZEN): `CaseDetail({ caseId, onClose, onNavigate? })` — `caseId`
 * null/empty renders nothing (closed). Cases / Scans / Investigate open it by holding
 * an openCaseId state.
 *
 * SECURITY (#9): every case-derived value (title, summary, entity, IPs, rules,
 * queries, evidence, tool output, comments, tags, model keys, enrichment) is UNTRUSTED
 * — it is rendered as plain text or inside <CodeBlock>/<InlineCode>, never as markup.
 * #3: the unified Close-with-disposition still POSTs the EXISTING `close` verb (via
 * `wireAction`) so the backend runs the real decide()/apply() — this file never
 * invents a verb or makes a close/escalate decision itself.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Bell,
  BookOpen,
  Brain,
  Check,
  Download,
  FileText,
  GitBranch,
  ListTree,
  Globe,
  History,
  MessageSquare,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Send,
  Shield,
  Star,
  Users,
  X,
  Zap,
} from 'lucide-react';

import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  Case,
  CaseActionInput,
  CaseRationale,
  ModelsResponse,
  Playbook,
  ThreatContextPanel as ThreatContextPanelData,
} from '@/lib/types';
import { fmtMoney, humanizeAge } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Sheet, SheetContent } from '@/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/ui/popover';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/ui/dropdown-menu';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/ui/tooltip';
import { Skeleton, SkeletonCard } from '@/ui/skeleton';

import { StatusBadge, DispositionBadge } from '@/soc/components/badges';
import { DemoBadge, isDemoCase } from '@/soc/components/DemoBadge';
import { Can, useCan } from '@/soc/components/Can';
import { useAuth } from '@/soc/auth';

import { TraceTimeline } from '@/soc/components/TraceTimeline';
import { StageTimeline } from './casedetail/StageTimeline';
import {
  getTriage,
  getTimeline,
  getCaseStages,
  getThread,
  postThread,
  editThreadMessage,
  deleteThreadMessage,
  reactThreadMessage,
  getTasks,
  addTask,
  patchTask,
  logTask,
  getActivity,
  listPickableUsers,
  type TriageChips,
  type TimelineResponse,
  type TimelineStagesResponse,
  type CaseMessage as ThreadMessage,
  type CaseTask as CaseTaskItem,
  type CaseActivityItem,
  type PickableUser,
  type TaskStatus,
} from '@/soc/pages/CaseDetail.api';

import type { Navigate } from '@/soc/router';

import { campaignsApi, type Campaign } from '@/soc/pages/Campaigns.api';
import { CampaignChip } from '@/soc/pages/Campaigns';

import {
  type ActionDef,
  type FpPolicy,
  type NotifyChannelOption,
  ACTION_PERMISSION,
  actionPlanForStatus,
} from './casedetail/shared';
import { OverviewPanel } from './casedetail/OverviewPanel';
import { WhyPanel } from './casedetail/WhyPanel';
import { ThreatContextPanel } from './casedetail/ThreatContextPanel';
import { CollaborationThreadTab } from './casedetail/CollaborationPanel';
import { FeedbackTab } from './casedetail/FeedbackPanel';
import { ChatTab } from './casedetail/CaseChatPanel';
import { ConfirmActionDialog } from './casedetail/ConfirmActionDialog';

// Re-export the co-located API types so existing importers keep working.
export type { ThreadMessage };

/* --------------------------------------------------------------- component -- */

export interface CaseDetailProps {
  caseId: string | null | undefined;
  onClose: () => void;
  onNavigate?: Navigate;
}

export const CaseDetail: React.FC<CaseDetailProps> = ({ caseId, onClose, onNavigate }) => {
  const open = Boolean(caseId && caseId.trim());
  const id = caseId || '';

  // Staleness guard: the LATEST requested case id. Every id-keyed loader captures its
  // own `id` in a closure and applies its result ONLY if the case has not changed
  // mid-flight — the SAME CaseDetail instance is reused across cases (related-case
  // drill-through, reopening the sheet on a different row), so a slow response for
  // case A must never overwrite the freshly-opened case B.
  const activeIdRef = React.useRef(id);
  React.useEffect(() => {
    activeIdRef.current = id;
  }, [id]);

  const [c, setC] = React.useState<Case | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  // Campaign membership (#51) — the cross-case campaign this case belongs to, if any.
  // Advisory only (#3/#4): a campaign is a reporting grouping that never closes /
  // escalates / re-clusters the case. Best-effort — campaigns may be disabled.
  const [campaign, setCampaign] = React.useState<Campaign | null>(null);
  const [tab, setTab] = React.useState<
    'overview' | 'timeline' | 'why' | 'threat' | 'trace' | 'collab' | 'feedback' | 'chat'
  >('overview');

  // Round 3 — triage chips (#12), eager so the overview header is honest on open.
  const [triage, setTriage] = React.useState<TriageChips | null>(null);
  const [triageLoading, setTriageLoading] = React.useState(false);

  // Round 3 — typed ReAct timeline (#12), lazy on the Trace tab.
  const [timeline, setTimeline] = React.useState<TimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = React.useState(false);
  const [timelineError, setTimelineError] = React.useState<unknown>(null);

  // Six-stage narrative, lazy on the Timeline tab.
  const [stages, setStages] = React.useState<TimelineStagesResponse | null>(null);
  const [stagesLoading, setStagesLoading] = React.useState(false);
  const [stagesError, setStagesError] = React.useState<unknown>(null);

  // Round 3 — collaboration thread (#4), lazy on the Thread tab.
  const [thread, setThread] = React.useState<ThreadMessage[] | null>(null);
  const [threadLoading, setThreadLoading] = React.useState(false);
  const [threadError, setThreadError] = React.useState<unknown>(null);
  const [threadBusyId, setThreadBusyId] = React.useState<string | null>(null);

  // Round 3 — tasks + activity (#4), lazy on the Thread tab alongside the thread.
  const [tasks, setTasks] = React.useState<CaseTaskItem[] | null>(null);
  const [tasksBusyId, setTasksBusyId] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<CaseActivityItem[] | null>(null);
  const [activityLoading, setActivityLoading] = React.useState(false);

  // Users for the assignee picker + @mention autocomplete (best-effort).
  const [pickUsers, setPickUsers] = React.useState<PickableUser[]>([]);

  const { username: currentUser, hasPermission } = useAuth();
  const canComment = useCan('cases', 'comment');
  const canWriteCase = useCan('cases', 'write');

  const [rationale, setRationale] = React.useState<CaseRationale | null>(null);
  const [rationaleLoading, setRationaleLoading] = React.useState(false);
  const [rationaleError, setRationaleError] = React.useState<unknown>(null);

  // Threat context (F11) — lazy.
  const [threat, setThreat] = React.useState<ThreatContextPanelData | null>(null);
  const [threatLoading, setThreatLoading] = React.useState(false);
  const [threatError, setThreatError] = React.useState<unknown>(null);

  // Run-a-playbook (F10): the playbook catalog + a pending pick + run state.
  const [playbooks, setPlaybooks] = React.useState<Playbook[]>([]);
  const [runPlaybookOpen, setRunPlaybookOpen] = React.useState(false);
  const [runPlaybookId, setRunPlaybookId] = React.useState('');
  const [runningPlaybook, setRunningPlaybook] = React.useState(false);

  // Pending lifecycle action (confirm dialog) + optional structured fields.
  const [pending, setPending] = React.useState<ActionDef | null>(null);
  const [note, setNote] = React.useState('');
  const [resolution, setResolution] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const [actionAssignee, setActionAssignee] = React.useState('');
  const [actionTags, setActionTags] = React.useState<string[]>([]);
  const [actionTagDraft, setActionTagDraft] = React.useState('');
  const [actionDisposition, setActionDisposition] = React.useState('');
  const [actionReason, setActionReason] = React.useState('');
  const [acting, setActing] = React.useState(false);

  // Reinvestigate.
  const [reinvestOpen, setReinvestOpen] = React.useState(false);
  const [reinvestModel, setReinvestModel] = React.useState('');
  const [reinvesting, setReinvesting] = React.useState(false);
  const [models, setModels] = React.useState<ModelsResponse | null>(null);

  // Export.
  const [exporting, setExporting] = React.useState<'json' | 'md' | null>(null);

  // FP auto-close policy (best-effort).
  const [fpPolicy, setFpPolicy] = React.useState<FpPolicy>(null);

  // Notify (manual send) — F5/Wave 4. Channels come from the loaded settings.
  const [notifyOpen, setNotifyOpen] = React.useState(false);
  const [notifyChannels, setNotifyChannels] = React.useState<NotifyChannelOption[]>([]);
  const [notifyEnabled, setNotifyEnabled] = React.useState(false);
  const [notifyChannelId, setNotifyChannelId] = React.useState<string>('');
  const [notifying, setNotifying] = React.useState(false);

  const loadCase = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getCase(id);
      if (activeIdRef.current !== id) return; // a newer case is loading — drop the stale result
      setC(res);
    } catch (e) {
      if (activeIdRef.current !== id) return;
      setError(e);
    } finally {
      if (activeIdRef.current === id) setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (!open) return;
    // Reset all per-case lazy state when the case changes / opens.
    setC(null);
    setRationale(null);
    setRationaleError(null);
    setTriage(null);
    setTimeline(null);
    setTimelineError(null);
    setStages(null);
    setStagesError(null);
    setThread(null);
    setThreadError(null);
    setThreadBusyId(null);
    setTasks(null);
    setTasksBusyId(null);
    setActivity(null);
    // Threat context is lazy-loaded and guarded by `threat === null`; resetting it
    // (and its error) here is what makes the Threat tab refetch for the newly-opened
    // case instead of showing the previous case's IOC/MITRE data.
    setThreat(null);
    setThreatError(null);
    setTab('overview');
    void loadCase();
  }, [open, id, loadCase]);

  // Triage chips (#12) — eager so the overview header reflects the four honest
  // signals as soon as the case opens. Best-effort: a failure leaves the chips null
  // and the overview falls back to its legacy headline panels.
  const loadTriage = React.useCallback(async () => {
    if (!id) return;
    setTriageLoading(true);
    try {
      const res = await getTriage(id);
      if (activeIdRef.current !== id) return;
      setTriage(res.chips || null);
    } catch {
      if (activeIdRef.current === id) setTriage(null);
    } finally {
      if (activeIdRef.current === id) setTriageLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && id) void loadTriage();
  }, [open, id, loadTriage]);

  // Campaign membership (#51) — fetch the campaign this case belongs to, keyed on the
  // open case. Fail-open: a disabled/absent campaigns feature (or any error) simply
  // clears the chip. Reset to null immediately so a newly-opened case never shows the
  // previous case's campaign while the fetch is in flight. Wrapped in try/catch so a
  // synchronous stub failure is handled the same as a rejection.
  React.useEffect(() => {
    setCampaign(null);
    if (!(open && id)) return;
    let alive = true;
    void (async () => {
      try {
        const res = await campaignsApi.forCase(id);
        if (alive) setCampaign(res.campaign);
      } catch {
        if (alive) setCampaign(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, id]);

  // Users for the picker + @mention autocomplete (best-effort, once per open).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listPickableUsers().then((res) => {
      if (!cancelled) setPickUsers(res);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Typed ReAct timeline (#12) — lazy on the Trace tab.
  const loadTimeline = React.useCallback(async () => {
    if (!id) return;
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const res = await getTimeline(id);
      if (activeIdRef.current !== id) return;
      setTimeline(res);
    } catch (e) {
      if (activeIdRef.current === id) setTimelineError(e);
    } finally {
      if (activeIdRef.current === id) setTimelineLoading(false);
    }
  }, [id]);

  // Lazy on the Trace tab. `!timelineError` in the guard stops a failed fetch from
  // re-firing forever (the loading flag flips back to false on failure, which would
  // otherwise re-satisfy `timeline === null && !loading` and hammer the backend). The
  // Retry affordance still works — loadTimeline clears the error before refetching.
  React.useEffect(() => {
    if (open && tab === 'trace' && timeline === null && !timelineLoading && !timelineError) {
      void loadTimeline();
    }
  }, [open, tab, timeline, timelineLoading, timelineError, loadTimeline]);

  const loadStages = React.useCallback(async () => {
    if (!id) return;
    setStagesLoading(true);
    setStagesError(null);
    try {
      const res = await getCaseStages(id);
      if (activeIdRef.current !== id) return;
      setStages(res);
    } catch (e) {
      if (activeIdRef.current === id) setStagesError(e);
    } finally {
      if (activeIdRef.current === id) setStagesLoading(false);
    }
  }, [id]);

  // Lazy on the Timeline tab (same error-guard rationale as loadTimeline above).
  React.useEffect(() => {
    if (open && tab === 'timeline' && stages === null && !stagesLoading && !stagesError) {
      void loadStages();
    }
  }, [open, tab, stages, stagesLoading, stagesError, loadStages]);

  // ---- Collaboration: thread + tasks + activity (#4) -------------------- //
  const loadThread = React.useCallback(async () => {
    if (!id) return;
    setThreadLoading(true);
    setThreadError(null);
    try {
      const res = await getThread(id);
      if (activeIdRef.current !== id) return;
      setThread(res.messages || []);
    } catch (e) {
      if (activeIdRef.current === id) setThreadError(e);
    } finally {
      if (activeIdRef.current === id) setThreadLoading(false);
    }
  }, [id]);

  const loadTasks = React.useCallback(async () => {
    if (!id) return;
    try {
      const res = await getTasks(id);
      if (activeIdRef.current !== id) return;
      setTasks(res.tasks || []);
    } catch {
      if (activeIdRef.current === id) setTasks([]);
    }
  }, [id]);

  const loadActivity = React.useCallback(async () => {
    if (!id) return;
    setActivityLoading(true);
    try {
      const res = await getActivity(id);
      if (activeIdRef.current !== id) return;
      setActivity(res.activity || []);
    } catch {
      if (activeIdRef.current === id) setActivity([]);
    } finally {
      if (activeIdRef.current === id) setActivityLoading(false);
    }
  }, [id]);

  // LIVE (Wave 4) refetch nudges. A `case.activity` SSE frame (only while realtime is
  // enabled AND the thread tab is mounted) asks us to refetch the AUTHORITATIVE thread
  // / activity feed — the frame payload is never rendered (#9), it only triggers a
  // reload, and nothing here touches the case decision (#3). Trailing-debounced so a
  // burst of teammate/AI events collapses into one refetch instead of a fetch storm.
  const liveThreadTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveActivityTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRefreshThread = React.useCallback(() => {
    if (liveThreadTimer.current) clearTimeout(liveThreadTimer.current);
    liveThreadTimer.current = setTimeout(() => {
      void loadThread();
    }, 1200);
  }, [loadThread]);
  const liveRefreshActivity = React.useCallback(() => {
    if (liveActivityTimer.current) clearTimeout(liveActivityTimer.current);
    liveActivityTimer.current = setTimeout(() => {
      void loadActivity();
    }, 1200);
  }, [loadActivity]);
  React.useEffect(
    () => () => {
      if (liveThreadTimer.current) clearTimeout(liveThreadTimer.current);
      if (liveActivityTimer.current) clearTimeout(liveActivityTimer.current);
    },
    [],
  );

  React.useEffect(() => {
    if (open && tab === 'collab') {
      // `!threadError` stops a failed thread fetch from re-firing forever (Retry still
      // works — loadThread clears the error before refetching). tasks/activity set []
      // on failure so their `=== null` guard already self-terminates.
      if (thread === null && !threadLoading && !threadError) void loadThread();
      if (tasks === null) void loadTasks();
      if (activity === null && !activityLoading) void loadActivity();
    }
  }, [
    open,
    tab,
    thread,
    threadLoading,
    threadError,
    tasks,
    activity,
    activityLoading,
    loadThread,
    loadTasks,
    loadActivity,
  ]);

  // Thread mutation handlers — each calls the API then refreshes the thread +
  // activity (so an @mention/new event shows). #3-safe: posting never touches the
  // case decision (the backend enforces this).
  const postMessage = React.useCallback(
    async (text: string, parentId?: string) => {
      if (!id) return;
      setThreadBusyId(parentId || '__post__');
      try {
        await postThread(id, { body: text, parent_id: parentId ?? null });
        await loadThread();
        void loadActivity();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not post the message.');
      } finally {
        setThreadBusyId(null);
      }
    },
    [id, loadThread, loadActivity],
  );

  const editMessage = React.useCallback(
    async (msgId: string, text: string) => {
      if (!id) return;
      setThreadBusyId(msgId);
      try {
        await editThreadMessage(id, msgId, text);
        await loadThread();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not edit the message.');
      } finally {
        setThreadBusyId(null);
      }
    },
    [id, loadThread],
  );

  const removeMessage = React.useCallback(
    async (msgId: string) => {
      if (!id) return;
      setThreadBusyId(msgId);
      try {
        await deleteThreadMessage(id, msgId);
        await loadThread();
        void loadActivity();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not delete the message.');
      } finally {
        setThreadBusyId(null);
      }
    },
    [id, loadThread, loadActivity],
  );

  const reactMessage = React.useCallback(
    async (msgId: string, emoji: string, remove: boolean) => {
      if (!id) return;
      setThreadBusyId(msgId);
      try {
        await reactThreadMessage(id, msgId, emoji, remove);
        await loadThread();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not react.');
      } finally {
        setThreadBusyId(null);
      }
    },
    [id, loadThread],
  );

  // Task mutation handlers.
  const createTask = React.useCallback(
    async (title: string) => {
      if (!id) return;
      setTasksBusyId('__add__');
      try {
        await addTask(id, { title });
        await loadTasks();
        void loadActivity();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not add the task.');
      } finally {
        setTasksBusyId(null);
      }
    },
    [id, loadTasks, loadActivity],
  );

  const setTaskStatus = React.useCallback(
    async (taskId: string, status: TaskStatus) => {
      if (!id) return;
      setTasksBusyId(taskId);
      try {
        await patchTask(id, taskId, { status });
        await loadTasks();
        void loadActivity();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not update the task.');
      } finally {
        setTasksBusyId(null);
      }
    },
    [id, loadTasks, loadActivity],
  );

  const addTaskLog = React.useCallback(
    async (taskId: string, note: string) => {
      if (!id) return;
      setTasksBusyId(taskId);
      try {
        await logTask(id, taskId, note);
        await loadTasks();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not log the note.');
      } finally {
        setTasksBusyId(null);
      }
    },
    [id, loadTasks],
  );

  const loadRationale = React.useCallback(async () => {
    if (!id) return;
    setRationaleLoading(true);
    setRationaleError(null);
    try {
      const res = await api.caseRationale(id);
      if (activeIdRef.current !== id) return;
      setRationale(res);
    } catch (e) {
      if (activeIdRef.current === id) setRationaleError(e);
    } finally {
      if (activeIdRef.current === id) setRationaleLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && tab === 'why' && rationale === null && !rationaleLoading && !rationaleError) {
      void loadRationale();
    }
  }, [open, tab, rationale, rationaleLoading, rationaleError, loadRationale]);

  const loadThreat = React.useCallback(async () => {
    if (!id) return;
    setThreatLoading(true);
    setThreatError(null);
    try {
      const res = await api.cases.threatContext(id);
      if (activeIdRef.current !== id) return;
      setThreat(res);
    } catch (e) {
      if (activeIdRef.current === id) setThreatError(e);
    } finally {
      if (activeIdRef.current === id) setThreatLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && tab === 'threat' && threat === null && !threatLoading && !threatError) {
      void loadThreat();
    }
  }, [open, tab, threat, threatLoading, threatError, loadThreat]);

  // Playbook catalog for the run-a-playbook picker (best-effort).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .getPlaybooks()
      .then((res) => {
        if (!cancelled) setPlaybooks(res.enabled ? res.playbooks ?? [] : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const runPlaybook = React.useCallback(async () => {
    const pid = runPlaybookId.trim();
    if (!pid) return;
    setRunningPlaybook(true);
    setError(null);
    try {
      const next = await api.cases.runPlaybook(id, pid);
      setC(next);
      setRunPlaybookOpen(false);
      setRunPlaybookId('');
      // The run is a re-investigation — invalidate the lazy tab payloads.
      setRationale(null);
      setThreat(null);
      setTimeline(null);
      setStages(null);
      void loadTriage();
      toast.success('Playbook applied — the case was re-investigated with it as context.');
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Could not run the playbook.',
      );
    } finally {
      setRunningPlaybook(false);
    }
  }, [id, runPlaybookId, loadTriage]);

  // Models for the reinvestigate picker (best-effort).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .getModels()
      .then((res) => {
        if (!cancelled) setModels(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  // FP auto-close policy (best-effort).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .getSettings()
      .then((res) => {
        if (cancelled) return;
        setFpPolicy((res?.prefs?.fp_auto_close as FpPolicy) || null);
        const notif = res?.prefs?.notifications;
        setNotifyEnabled(Boolean(notif?.enabled));
        const chans = (notif?.channels || []).map((c) => ({
          id: c.id,
          type: String(c.type),
          name: c.name || c.id,
          enabled: Boolean(c.enabled),
        }));
        setNotifyChannels(chans);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const runNotify = React.useCallback(async () => {
    setNotifying(true);
    try {
      const res = await api.cases.notify(id, notifyChannelId || undefined);
      const okCount = res.sent.filter((s) => s.ok).length;
      const failCount = res.sent.length - okCount;
      if (res.sent.length === 0) {
        toast.message('No channels matched — nothing was sent.');
      } else if (failCount === 0) {
        toast.success(`Notification sent to ${okCount} channel(s).`);
      } else if (okCount === 0) {
        toast.error(`Notification failed (${res.sent[0]?.detail || 'see audit log'}).`);
      } else {
        toast.warning(`Sent to ${okCount}, ${failCount} failed.`);
      }
      setNotifyOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send notification.');
    } finally {
      setNotifying(false);
    }
  }, [id, notifyChannelId]);

  const resetActionFields = React.useCallback(() => {
    setNote('');
    setResolution('');
    setPriority('');
    setActionAssignee('');
    setActionTags([]);
    setActionTagDraft('');
    setActionDisposition('');
    setActionReason('');
  }, []);

  const openAction = React.useCallback(
    (a: ActionDef) => {
      resetActionFields();
      // Pre-seed the disposition picker with the case's current value, if any.
      if (a.fields.includes('disposition') && typeof c?.disposition === 'string') {
        setActionDisposition(c.disposition);
      }
      setPending(a);
    },
    [resetActionFields, c],
  );

  const closeAction = React.useCallback(() => {
    setPending(null);
    resetActionFields();
  }, [resetActionFields]);

  const runAction = React.useCallback(async () => {
    if (!pending) return;
    setActing(true);
    try {
      // Always POST an EXISTING backend verb: `close_disposition` maps to `close`
      // via wireAction, so the server still runs the real decide()/apply() (#3).
      const input: CaseActionInput = { action: pending.wireAction ?? pending.key };
      const trimmedNote = note.trim();
      if (trimmedNote) input.note = trimmedNote;
      if (pending.fields.includes('resolution') && resolution) input.resolution = resolution;
      if (pending.fields.includes('assignee') && actionAssignee.trim()) {
        input.assignee = actionAssignee.trim();
      }
      if (pending.fields.includes('priority') && priority) input.priority = priority;
      if (pending.fields.includes('tags')) {
        const tags = Array.from(new Set(actionTags.map((t) => t.trim()).filter(Boolean)));
        if (tags.length) input.tags = tags;
      }
      if (pending.fields.includes('disposition') && actionDisposition) {
        input.disposition = actionDisposition;
      }
      if (pending.fields.includes('reason') && actionReason.trim()) {
        input.reason = actionReason.trim();
      }
      const next = await api.caseActionExec(id, input);
      setC(next);
      setPending(null);
      resetActionFields();
      setRationale(null);
      setTimeline(null);
      setStages(null);
      // A lifecycle action re-derives the chips + leaves an activity row.
      void loadTriage();
      if (activity !== null) void loadActivity();
    } catch (e) {
      // A failed lifecycle action is a MUTATION failure, not a case-load failure — use a
      // toast (like postMessage/notify) so we never mislabel it as "Could not load case".
      toast.error(e instanceof Error ? e.message : 'The action could not be completed.');
      setPending(null);
    } finally {
      setActing(false);
    }
  }, [
    pending,
    note,
    resolution,
    priority,
    actionAssignee,
    actionTags,
    actionDisposition,
    actionReason,
    id,
    resetActionFields,
    loadTriage,
    loadActivity,
    activity,
  ]);

  const runReinvestigate = React.useCallback(async () => {
    setReinvesting(true);
    setError(null);
    try {
      const input = reinvestModel.trim() ? { model: reinvestModel.trim() } : undefined;
      const next = await api.reinvestigateCase(id, input);
      setC(next);
      setReinvestOpen(false);
      setRationale(null);
      setTimeline(null);
      setStages(null);
      void loadTriage();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The reinvestigation could not be started.');
    } finally {
      setReinvesting(false);
    }
  }, [reinvestModel, id, loadTriage]);

  const runExport = React.useCallback(
    async (fmt: 'json' | 'md') => {
      setExporting(fmt);
      try {
        const res = await api.exportCase(id, fmt);
        const blob = new Blob([res.content], {
          type: res.content_type || 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename || `case-${id}.${fmt === 'md' ? 'md' : 'json'}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'The export could not be generated.');
      } finally {
        setExporting(null);
      }
    },
    [id],
  );

  const modelOptions = React.useMemo<Array<{ value: string; text: string }>>(() => {
    const out: Array<{ value: string; text: string }> = [];
    for (const [provider, list] of Object.entries(models?.providers || {})) {
      for (const m of list || []) {
        out.push({ value: m, text: `${m}  ·  ${provider}` });
      }
    }
    return out;
  }, [models]);

  if (!open) return null;

  const actionPlan = actionPlanForStatus(c?.status);

  return (
    <TooltipProvider delayDuration={200}>
      <Sheet
        open={open}
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
      >
        <SheetContent
          side="right"
          size="full"
          className="w-full max-w-[min(96vw,1180px)] p-0"
          aria-label="Case detail"
        >
          <div className="flex h-full min-h-0 flex-col">
            {/* ----------------------------------------------------- header */}
            <header className="flex shrink-0 items-start gap-4 border-b border-border bg-card px-6 py-4">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Shield className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                {loading || !c ? (
                  <Skeleton className="h-6 w-72" />
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      {/* Human-facing display id (F7) — falls back to case_id. */}
                      <span className="shrink-0 font-mono text-xs font-semibold text-primary">
                        {c.case_number || c.case_id}
                      </span>
                      <DemoBadge show={isDemoCase(c)} className="text-2xs" />
                    </div>
                    <h2 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-foreground">
                      {/* UNTRUSTED title — plain text node. */}
                      {c.title || c.case_id}
                    </h2>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <StatusBadge status={c.status} />
                      <DispositionBadge disposition={c.disposition ?? null} />
                      {typeof c.escalation_level === 'number' && c.escalation_level > 0 ? (
                        <Badge variant="critical" className="gap-1">
                          <Bell className="h-3 w-3" /> L{c.escalation_level}
                        </Badge>
                      ) : null}
                      {/* Campaign membership (#51) — plain text (#9); clicking deep-links
                          to the Campaigns surface. Renders nothing when uncampaigned. */}
                      {campaign ? (
                        <CampaignChip
                          campaign={campaign}
                          onOpen={onNavigate ? () => onNavigate('campaigns') : undefined}
                        />
                      ) : null}
                    </div>
                  </>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {c?.created_at ? (
                    <>Created {humanizeAge(c.created_at)}</>
                  ) : (
                    'Created —'
                  )}
                  {c?.updated_at ? <> · Updated {humanizeAge(c.updated_at)}</> : null}
                </p>
              </div>

              {/* header icon actions */}
              {/* pr-8 keeps these icons clear of the built-in Sheet close X (right-4 top-4) */}
              <div className="flex shrink-0 items-center gap-1 pr-8">
                {/* Reinvestigate (popover) */}
                <Popover open={reinvestOpen} onOpenChange={setReinvestOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={reinvesting || loading}
                          aria-label="Reinvestigate"
                          onClick={() => setReinvestModel('')}
                        >
                          {reinvesting ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <Zap className="h-4 w-4" />
                          )}
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Reinvestigate</TooltipContent>
                  </Tooltip>
                  <PopoverContent align="end" className="w-80">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Search className="h-4 w-4 text-primary" />
                        <span className="text-sm font-semibold text-foreground">
                          Re-run the investigation
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Forces a fresh AI investigation. This runs the LLM pipeline and may
                        take a few seconds.
                      </p>
                      <Alert variant="warning" className="py-2">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle className="text-xs">
                          Costs tokens and overwrites the verdict
                        </AlertTitle>
                        <AlertDescription className="text-xs">
                          Last run cost {fmtMoney(c?.token_cost)}. Re-running spends more
                          tokens and replaces this case&apos;s current verdict, confidence,
                          and rationale.
                        </AlertDescription>
                      </Alert>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Model</Label>
                        <Select
                          value={reinvestModel || '__configured__'}
                          onValueChange={(v) =>
                            setReinvestModel(v === '__configured__' ? '' : v)
                          }
                          disabled={reinvesting}
                        >
                          <SelectTrigger className="h-8 text-xs" aria-label="Model">
                            <SelectValue placeholder="Use configured model" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__configured__">
                              Use configured model
                            </SelectItem>
                            {modelOptions.map((m) => (
                              <SelectItem key={m.value} value={m.value}>
                                {m.text}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setReinvestOpen(false)}
                          disabled={reinvesting}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void runReinvestigate()}
                          disabled={reinvesting}
                        >
                          {reinvesting ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                          Reinvestigate
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Run a playbook (CONTEXT-ONLY re-investigation) — gated by playbooks:run */}
                <Can resource="playbooks" action="run">
                  <Popover open={runPlaybookOpen} onOpenChange={setRunPlaybookOpen}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={runningPlaybook || loading}
                            aria-label="Run a playbook"
                            onClick={() => setRunPlaybookId('')}
                          >
                            {runningPlaybook ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                              <BookOpen className="h-4 w-4" />
                            )}
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent>Run a playbook</TooltipContent>
                    </Tooltip>
                    <PopoverContent align="end" className="w-80">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <BookOpen className="h-4 w-4 text-primary" />
                          <span className="text-sm font-semibold text-foreground">
                            Run a playbook
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Re-investigates this case with the chosen playbook injected as
                          TRUSTED operator procedure. The playbook can only{' '}
                          <span className="font-medium text-foreground">recommend</span> — the
                          close / escalate decision is still made by deterministic code.
                        </p>
                        <Alert variant="warning" className="py-2">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertTitle className="text-xs">Costs tokens</AlertTitle>
                          <AlertDescription className="text-xs">
                            This re-runs the LLM pipeline and may replace the verdict /
                            rationale. It never changes the lifecycle status on its own.
                          </AlertDescription>
                        </Alert>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Playbook</Label>
                          {playbooks.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No playbooks are loaded. Add Markdown runbooks on the backend.
                            </p>
                          ) : (
                            <Select
                              value={runPlaybookId || undefined}
                              onValueChange={setRunPlaybookId}
                              disabled={runningPlaybook}
                            >
                              <SelectTrigger className="h-8 text-xs" aria-label="Playbook">
                                <SelectValue placeholder="Select a playbook…" />
                              </SelectTrigger>
                              <SelectContent>
                                {playbooks.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {/* Operator-authored name → plain text. */}
                                    {p.name || p.id}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRunPlaybookOpen(false)}
                            disabled={runningPlaybook}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void runPlaybook()}
                            disabled={runningPlaybook || !runPlaybookId.trim()}
                          >
                            {runningPlaybook ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                            Run playbook
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </Can>

                {/* Refresh */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Refresh case"
                      disabled={loading}
                      onClick={() => void loadCase()}
                    >
                      <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh</TooltipContent>
                </Tooltip>

                {/* Ask about this case → jump to chat tab */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Ask about this case"
                      onClick={() => setTab('chat')}
                    >
                      <MessageSquare className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Ask about this case</TooltipContent>
                </Tooltip>

                {/* History → trace tab */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Decision trace"
                      onClick={() => setTab('trace')}
                    >
                      <History className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Decision trace</TooltipContent>
                </Tooltip>

                {/* Export */}
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Export case"
                          disabled={exporting !== null || loading}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Export</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void runExport('json')}>
                      <FileText className="h-4 w-4" />
                      JSON
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void runExport('md')}>
                      <FileText className="h-4 w-4" />
                      Markdown report
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Notify (manual send) — gated by cases:write */}
                <Can resource="cases" action="write">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Notify"
                        disabled={loading}
                        onClick={() => {
                          setNotifyChannelId('');
                          setNotifyOpen(true);
                        }}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Notify</TooltipContent>
                  </Tooltip>
                </Can>
                {/*
                  Panel dismiss is the built-in SheetContent close (X) at
                  right-4 top-4 — do NOT hand-roll a second header X here, or two
                  X controls stack. The labeled "Close case" lifecycle action
                  lives in the footer and is separate.
                */}
              </div>
            </header>

            {/* ----------------------------------------------------- body */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {error ? (
                <div className="px-6 pt-4">
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Could not load case</AlertTitle>
                    <AlertDescription>
                      {error instanceof Error ? error.message : 'Something went wrong.'}
                    </AlertDescription>
                  </Alert>
                </div>
              ) : null}

              {loading || !c ? (
                <div className="space-y-6 p-6" aria-busy="true" aria-label="Loading case">
                  {/* Headline panel row */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Skeleton key={i} className="h-[72px] rounded-lg" />
                    ))}
                  </div>
                  {/* Digest + assets + evidence */}
                  <SkeletonCard lines={3} />
                  <div className="grid gap-4 lg:grid-cols-2">
                    <SkeletonCard lines={4} />
                    <SkeletonCard lines={4} />
                  </div>
                  <SkeletonCard lines={5} />
                </div>
              ) : (
                <Tabs
                  value={tab}
                  onValueChange={(v) => setTab(v as typeof tab)}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <div className="shrink-0 border-b border-border px-6 pt-3">
                    <TabsList className="h-9">
                      <TabsTrigger value="overview" className="gap-1.5 text-xs">
                        <FileText className="h-3.5 w-3.5" /> Overview
                      </TabsTrigger>
                      <TabsTrigger value="timeline" className="gap-1.5 text-xs">
                        <ListTree className="h-3.5 w-3.5" /> Timeline
                      </TabsTrigger>
                      <TabsTrigger value="why" className="gap-1.5 text-xs">
                        <Brain className="h-3.5 w-3.5" /> Why
                      </TabsTrigger>
                      <TabsTrigger value="threat" className="gap-1.5 text-xs">
                        <Globe className="h-3.5 w-3.5" /> Threat context
                      </TabsTrigger>
                      <TabsTrigger value="trace" className="gap-1.5 text-xs">
                        <GitBranch className="h-3.5 w-3.5" /> Trace
                      </TabsTrigger>
                      <TabsTrigger value="collab" className="gap-1.5 text-xs">
                        <Users className="h-3.5 w-3.5" /> Collaboration
                      </TabsTrigger>
                      <TabsTrigger value="feedback" className="gap-1.5 text-xs">
                        <Star className="h-3.5 w-3.5" /> Feedback
                      </TabsTrigger>
                      <TabsTrigger value="chat" className="gap-1.5 text-xs">
                        <MessageSquare className="h-3.5 w-3.5" /> Chat
                      </TabsTrigger>
                    </TabsList>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <TabsContent value="overview" className="mt-0 animate-fade-in">
                      <OverviewPanel
                        c={c}
                        fpPolicy={fpPolicy}
                        triage={triage}
                        triageLoading={triageLoading}
                        onNavigate={onNavigate}
                      />
                    </TabsContent>
                    <TabsContent value="timeline" className="mt-0 animate-fade-in">
                      <StageTimeline
                        data={stages}
                        loading={stagesLoading}
                        error={stagesError}
                        onRetry={loadStages}
                      />
                    </TabsContent>
                    <TabsContent value="why" className="mt-0 animate-fade-in">
                      <WhyPanel
                        c={c}
                        rationale={rationale}
                        loading={rationaleLoading}
                        error={rationaleError}
                        onRetry={loadRationale}
                      />
                    </TabsContent>
                    <TabsContent value="threat" className="mt-0 animate-fade-in">
                      <ThreatContextPanel
                        c={c}
                        panel={threat}
                        loading={threatLoading}
                        error={threatError}
                        onRetry={loadThreat}
                        onNavigate={onNavigate}
                      />
                    </TabsContent>
                    <TabsContent value="trace" className="mt-0 animate-fade-in">
                      <TraceTimeline
                        data={timeline}
                        loading={timelineLoading}
                        error={timelineError}
                        onRetry={loadTimeline}
                      />
                    </TabsContent>
                    <TabsContent value="collab" className="mt-0 animate-fade-in">
                      <CollaborationThreadTab
                        c={c}
                        thread={thread}
                        threadLoading={threadLoading}
                        threadError={threadError}
                        threadBusyId={threadBusyId}
                        tasks={tasks}
                        tasksBusyId={tasksBusyId}
                        activity={activity}
                        activityLoading={activityLoading}
                        users={pickUsers}
                        currentUser={currentUser}
                        canComment={canComment}
                        canWrite={canWriteCase}
                        onRetryThread={loadThread}
                        onPost={(text) => void postMessage(text)}
                        onReply={(parentId, text) => void postMessage(text, parentId)}
                        onEdit={(msgId, text) => void editMessage(msgId, text)}
                        onDelete={(msgId) => void removeMessage(msgId)}
                        onReact={(msgId, emoji, remove) => void reactMessage(msgId, emoji, remove)}
                        onAddTask={(title) => void createTask(title)}
                        onTaskStatus={(taskId, status) => void setTaskStatus(taskId, status)}
                        onTaskLog={(taskId, note) => void addTaskLog(taskId, note)}
                        onAssigned={(next) => {
                          setC(next);
                          if (activity !== null) void loadActivity();
                        }}
                        liveCaseId={id}
                        onLiveThread={liveRefreshThread}
                        onLiveActivity={liveRefreshActivity}
                      />
                    </TabsContent>
                    <TabsContent value="feedback" className="mt-0 animate-fade-in">
                      <FeedbackTab c={c} onUpdated={(next) => setC(next)} />
                    </TabsContent>
                    <TabsContent value="chat" className="mt-0 animate-fade-in">
                      <ChatTab c={c} onNavigate={onNavigate} onClose={onClose} />
                    </TabsContent>
                  </div>
                </Tabs>
              )}
            </div>

            {/* ----------------------------------------------------- footer
                ONE clear primary CTA (context-dependent on status) + a secondary
                "Close case" (unified Close-with-disposition) + an overflow "More"
                menu for the rest — instead of a row of equally-weighted buttons.
                Every control is <Can>-gated by its action's grant. */}
            {c ? (
              <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-6 py-3">
                <Button variant="ghost" size="sm" onClick={onClose}>
                  <X className="h-4 w-4" /> Dismiss
                </Button>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {/* Overflow — the remaining contextual actions. */}
                  {(() => {
                    const overflow = actionPlan.overflow.filter((a) =>
                      hasPermission(ACTION_PERMISSION[a.key].resource, ACTION_PERMISSION[a.key].action),
                    );
                    if (overflow.length === 0) return null;
                    return (
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={loading || acting}
                                aria-label="More actions"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                                More
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent>More actions</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end" className="w-56">
                          {overflow.map((a) => {
                            const Icon = a.icon;
                            return (
                              <DropdownMenuItem
                                key={a.key}
                                disabled={loading || acting}
                                onSelect={() => openAction(a)}
                              >
                                <Icon className="h-4 w-4" />
                                <span className="flex-1">{a.label}</span>
                              </DropdownMenuItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    );
                  })()}

                  {/* Unified Close-with-disposition — secondary (unless it's the
                      primary, i.e. resolved cases, where actionPlan.close is null). */}
                  {actionPlan.close ? (
                    <Can
                      resource={ACTION_PERMISSION[actionPlan.close.key].resource}
                      action={ACTION_PERMISSION[actionPlan.close.key].action}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={loading || acting}
                            onClick={() => openAction(actionPlan.close!)}
                            aria-label={`${actionPlan.close.label} — ${actionPlan.close.help}`}
                          >
                            <Check className="h-4 w-4" />
                            {actionPlan.close.label}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{actionPlan.close.help}</TooltipContent>
                      </Tooltip>
                    </Can>
                  ) : null}

                  {/* Primary CTA — the single filled, context-dependent action. */}
                  <Can
                    resource={ACTION_PERMISSION[actionPlan.primary.key].resource}
                    action={ACTION_PERMISSION[actionPlan.primary.key].action}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant={actionPlan.primary.variant === 'outline' ? 'default' : actionPlan.primary.variant}
                          disabled={loading || acting}
                          onClick={() => openAction(actionPlan.primary)}
                          aria-label={`${actionPlan.primary.label} — ${actionPlan.primary.help}`}
                        >
                          {React.createElement(actionPlan.primary.icon, { className: 'h-4 w-4' })}
                          {actionPlan.primary.label}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{actionPlan.primary.help}</TooltipContent>
                    </Tooltip>
                  </Can>
                </div>
              </footer>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      {/* --------------------------------------- confirm / close-with-disposition */}
      <ConfirmActionDialog
        pending={pending}
        acting={acting}
        onClose={closeAction}
        onSubmit={() => void runAction()}
        note={note}
        onNoteChange={setNote}
        resolution={resolution}
        onResolutionChange={setResolution}
        priority={priority}
        onPriorityChange={setPriority}
        assignee={actionAssignee}
        onAssigneeChange={setActionAssignee}
        tags={actionTags}
        onTagsChange={setActionTags}
        tagDraft={actionTagDraft}
        onTagDraftChange={setActionTagDraft}
        disposition={actionDisposition}
        onDispositionChange={setActionDisposition}
        reason={actionReason}
        onReasonChange={setActionReason}
      />

      {/* Notify (manual send) dialog — F5/Wave 4. Picks one configured channel or
          all enabled; the send is fire-and-forget and never changes the case. */}
      <Dialog open={notifyOpen} onOpenChange={setNotifyOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              Notify
            </DialogTitle>
            <DialogDescription>
              Send this case to a notification channel. Delivery is fire-and-forget and never
              changes the case.
            </DialogDescription>
          </DialogHeader>

          {!notifyEnabled ? (
            <Alert>
              <Send className="h-4 w-4" aria-hidden />
              <AlertTitle>Notifications are off</AlertTitle>
              <AlertDescription>
                Enable alerting under Settings → Alerting &amp; notifications and configure a
                channel first.
              </AlertDescription>
            </Alert>
          ) : notifyChannels.length === 0 ? (
            <Alert>
              <Send className="h-4 w-4" aria-hidden />
              <AlertTitle>No channels configured</AlertTitle>
              <AlertDescription>
                Add a channel under Settings → Alerting &amp; notifications.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-1.5 py-1">
              <Label>Channel</Label>
              <Select value={notifyChannelId || '__all__'} onValueChange={(v) => setNotifyChannelId(v === '__all__' ? '' : v)}>
                <SelectTrigger aria-label="Channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All enabled channels</SelectItem>
                  {notifyChannels.map((c) => (
                    <SelectItem key={c.id} value={c.id} disabled={!c.enabled}>
                      {c.name} · {c.type}
                      {c.enabled ? '' : ' (disabled)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Choose a single channel, or send to every enabled channel at once.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setNotifyOpen(false)} disabled={notifying}>
              Cancel
            </Button>
            <Button
              onClick={() => void runNotify()}
              disabled={notifying || !notifyEnabled || notifyChannels.length === 0}
            >
              {notifying ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};

export default CaseDetail;
