/**
 * CaseDetail — the core analyst workflow surface (new command-center UI).
 *
 * Opened with a `caseId`, it fetches the full case (`api.getCase`) and presents a
 * WIDE right-side Sheet modeled on the reference "case report" page:
 *   - a header (title, created/updated, action buttons: reinvestigate / refresh /
 *     chat / history / export / close),
 *   - a top run-meta strip (started / completed / trigger / profile),
 *   - colored Verdict / Severity / Impact / Priority / Confidence panels,
 *   - an Incident Digest, Affected Assets (KV) + IOC Indicators (CodeBlock),
 *     Evidence Findings cards (category tag + Subject / Evidence / Conclusion),
 *   - tabs: Overview / Why (rationale) / Trace (decision-path) / Notes & feedback /
 *     Chat,
 *   - lifecycle actions (close / confirm FP / escalate / reopen / acknowledge),
 *     each gated behind a small confirm-with-note dialog.
 *
 * Contract: `CaseDetail({ caseId, onClose, onNavigate? })` — `caseId` null/empty
 * renders nothing (closed). Cases / Scans / Investigate open it by holding an
 * openCaseId state.
 *
 * SECURITY: every case-derived value (title, summary, entity, IPs, rules, queries,
 * evidence, tool output, comments, tags, model keys, enrichment) is UNTRUSTED — it
 * is rendered as plain text or inside <CodeBlock>/<InlineCode>, never as markup.
 */
import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownCircle,
  Bell,
  BookOpen,
  Brain,
  Check,
  CheckCircle2,
  Clock,
  Crosshair,
  Download,
  Eye,
  FileText,
  Gauge,
  GitBranch,
  Globe,
  History,
  Info,
  Link2,
  Lock,
  MessageSquare,
  PauseCircle,
  Play,
  PlayCircle,
  RefreshCw,
  Save,
  Search,
  Send,
  Shield,
  Star,
  Tag,
  Target,
  Terminal,
  User,
  Users,
  Wrench,
  X,
  Zap,
} from 'lucide-react';

import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { CaseFeedbackInput } from '@/lib/api';
import type {
  Case,
  CaseActionInput,
  CaseRationale,
  ModelsResponse,
  Playbook,
  ThreatContextPanel,
} from '@/lib/types';
import {
  DASH,
  fmtMoney,
  formatTimestamp,
  humanizeAge,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
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
import { Slider } from '@/ui/slider';
import { Separator } from '@/ui/separator';
import { Avatar, AvatarFallback } from '@/ui/avatar';

import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { CodeBlock } from '@/soc/components/CodeBlock';
import {
  VerdictBadge,
  StatusBadge,
  DispositionBadge,
  RiskBadge,
  ConfidenceBadge,
} from '@/soc/components/badges';
import { DemoBadge, isDemoCase } from '@/soc/components/DemoBadge';
import { Can, useCan } from '@/soc/components/Can';
import { useAuth } from '@/soc/auth';

import { CaseTriageHeader } from '@/soc/components/CaseTriageHeader';
import { TraceTimeline } from '@/soc/components/TraceTimeline';
import { CaseThread } from '@/soc/components/CaseThread';
import { CaseTasks } from '@/soc/components/CaseTasks';
import { CaseActivityFeed } from '@/soc/components/CaseActivityFeed';
import {
  getTriage,
  getTimeline,
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
  type CaseMessage as ThreadMessage,
  type CaseTask as CaseTaskItem,
  type CaseActivityItem,
  type PickableUser,
  type TaskStatus,
} from '@/soc/pages/CaseDetail.api';

import type { Navigate } from '@/soc/router';

/* --------------------------------------------------------------- contracts -- */

/** One selectable notification channel in the Notify dialog. */
interface NotifyChannelOption {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
}

type ActionKind =
  | 'close'
  | 'confirm_fp'
  | 'escalate'
  | 'deescalate'
  | 'reopen'
  | 'acknowledge'
  | 'hold'
  | 'resume'
  | 'resolve'
  | 'set_disposition';
type ActionField = 'resolution' | 'tags' | 'assignee' | 'priority' | 'disposition' | 'reason';

/** The RBAC grant an action needs: close-class moves need cases:close, the rest
 *  cases:write. The footer gates each button with <Can> using this. */
const ACTION_PERMISSION: Record<ActionKind, { resource: 'cases'; action: 'close' | 'write' }> = {
  close: { resource: 'cases', action: 'close' },
  confirm_fp: { resource: 'cases', action: 'close' },
  resolve: { resource: 'cases', action: 'close' },
  reopen: { resource: 'cases', action: 'close' },
  escalate: { resource: 'cases', action: 'write' },
  deescalate: { resource: 'cases', action: 'write' },
  acknowledge: { resource: 'cases', action: 'write' },
  hold: { resource: 'cases', action: 'write' },
  resume: { resource: 'cases', action: 'write' },
  set_disposition: { resource: 'cases', action: 'write' },
};

/** Disposition options for the set_disposition picker (mirrors the backend enum). */
const DISPOSITION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: 'true_positive', text: 'True positive' },
  { value: 'false_positive', text: 'False positive' },
  { value: 'benign', text: 'Benign' },
  { value: 'suspicious', text: 'Suspicious' },
  { value: 'duplicate', text: 'Duplicate' },
  { value: 'undetermined', text: 'Undetermined' },
];

interface ActionDef {
  key: ActionKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Button variant for the footer + confirm dialog. */
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
  /** Whether this is the primary action of the current state (filled). */
  fill?: boolean;
  confirmTitle: string;
  confirmBody: string;
  help: string;
  fields: ActionField[];
}

const ALL_ACTIONS: Record<ActionKind, ActionDef> = {
  close: {
    key: 'close',
    label: 'Close case',
    icon: Check,
    variant: 'default',
    confirmTitle: 'Close this case?',
    confirmBody: 'Mark this case as CLOSED — triaged and handled.',
    help: 'Mark this case as CLOSED — triaged / handled.',
    fields: ['resolution', 'tags'],
  },
  confirm_fp: {
    key: 'confirm_fp',
    label: 'Confirm false positive',
    icon: CheckCircle2,
    variant: 'secondary',
    confirmTitle: 'Confirm false positive?',
    confirmBody:
      'Close the case as a FALSE POSITIVE. The resolved case is fed into the RAG baseline memory so future triage learns from it.',
    help: 'Close as FALSE_POSITIVE; also feeds the resolved case into RAG baseline memory.',
    fields: ['resolution', 'tags'],
  },
  escalate: {
    key: 'escalate',
    label: 'Escalate',
    icon: Bell,
    variant: 'default',
    confirmTitle: 'Escalate to a human?',
    confirmBody:
      'Set this case to NEEDS_HUMAN — route it to a human / senior analyst for review.',
    help: 'Set NEEDS_HUMAN — route to a human / senior analyst.',
    fields: ['assignee', 'priority'],
  },
  reopen: {
    key: 'reopen',
    label: 'Reopen',
    icon: RefreshCw,
    variant: 'default',
    confirmTitle: 'Reopen this case?',
    confirmBody: 'Reopen a closed case and return it to the open queue.',
    help: 'Reopen a closed case.',
    fields: [],
  },
  acknowledge: {
    key: 'acknowledge',
    label: 'Acknowledge',
    icon: Eye,
    variant: 'outline',
    confirmTitle: 'Acknowledge this case?',
    confirmBody: 'Mark this case as seen / being worked, without closing it.',
    help: 'Mark as seen / being worked, without closing.',
    fields: [],
  },
  hold: {
    key: 'hold',
    label: 'Put on hold',
    icon: PauseCircle,
    variant: 'outline',
    confirmTitle: 'Put this case on hold?',
    confirmBody: 'Pause the case (awaiting info / a maintenance window / a third party).',
    help: 'Pause — awaiting info / maintenance / third party.',
    fields: ['reason'],
  },
  resume: {
    key: 'resume',
    label: 'Resume',
    icon: PlayCircle,
    variant: 'outline',
    confirmTitle: 'Resume this case?',
    confirmBody: 'Return a held case to the open queue.',
    help: 'Return a held case to the open queue.',
    fields: [],
  },
  resolve: {
    key: 'resolve',
    label: 'Mark resolved',
    icon: CheckCircle2,
    variant: 'default',
    confirmTitle: 'Mark this case resolved?',
    confirmBody: 'Mark the case RESOLVED — worked to completion, pending final close / audit.',
    help: 'RESOLVED — worked to completion, pending final close.',
    fields: ['reason', 'tags'],
  },
  deescalate: {
    key: 'deescalate',
    label: 'De-escalate',
    icon: ArrowDownCircle,
    variant: 'outline',
    confirmTitle: 'De-escalate this case?',
    confirmBody: 'Clear the escalation and return the case to the open queue.',
    help: 'Clear the escalation; return to the open queue.',
    fields: ['reason'],
  },
  set_disposition: {
    key: 'set_disposition',
    label: 'Set disposition',
    icon: Tag,
    variant: 'outline',
    confirmTitle: 'Set the investigative disposition',
    confirmBody:
      'Record the investigative OUTCOME (true/false positive, benign, suspicious, …). This does not change the lifecycle status.',
    help: 'Record the investigative outcome (true/false positive, benign, …).',
    fields: ['disposition', 'reason'],
  },
};

const RESOLUTION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: 'handled', text: 'Handled' },
  { value: 'benign', text: 'Benign' },
  { value: 'duplicate', text: 'Duplicate' },
  { value: 'no_action', text: 'No action needed' },
  { value: 'other', text: 'Other' },
];

const PRIORITY_OPTIONS: Array<{ value: string; text: string }> = [
  { value: 'low', text: 'Low' },
  { value: 'medium', text: 'Medium' },
  { value: 'high', text: 'High' },
  { value: 'critical', text: 'Critical' },
];

/** Lifecycle buttons appropriate to the current status (left→right priority).
 *  Extended for the F8 taxonomy — hold/resume/resolve/de-escalate/set-disposition
 *  surface contextually; close-class moves only from non-terminal states. */
function actionsForStatus(status?: string): ActionDef[] {
  const s = (status || '').toLowerCase();
  // Terminal states: only reopen (and re-classify) is legal.
  if (s === 'closed' || s === 'auto_closed') {
    return [{ ...ALL_ACTIONS.reopen, fill: true }, ALL_ACTIONS.set_disposition];
  }
  if (s === 'resolved') {
    return [
      { ...ALL_ACTIONS.close, fill: true },
      ALL_ACTIONS.reopen,
      ALL_ACTIONS.set_disposition,
    ];
  }
  if (s === 'on_hold') {
    return [
      { ...ALL_ACTIONS.resume, fill: true },
      ALL_ACTIONS.resolve,
      ALL_ACTIONS.close,
      ALL_ACTIONS.set_disposition,
    ];
  }
  if (s === 'escalated') {
    return [
      { ...ALL_ACTIONS.resolve, fill: true },
      ALL_ACTIONS.deescalate,
      ALL_ACTIONS.close,
      ALL_ACTIONS.confirm_fp,
      ALL_ACTIONS.hold,
      ALL_ACTIONS.set_disposition,
    ];
  }
  // Open-ish states (new / open / needs_human / investigating).
  return [
    { ...ALL_ACTIONS.escalate, fill: true },
    ALL_ACTIONS.resolve,
    ALL_ACTIONS.close,
    ALL_ACTIONS.confirm_fp,
    ALL_ACTIONS.hold,
    ALL_ACTIONS.set_disposition,
    ALL_ACTIONS.acknowledge,
  ];
}

/* ------------------------------------------------------------------ helpers -- */

/** Best-effort epoch for sorting mixed history entries (ts is ISO). */
function tsValue(ts?: string): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

type FpPolicy = {
  enabled?: boolean;
  min_confidence?: number;
  max_risk_score?: number;
} | null;

/** Derive the ConfidenceBadge threshold/note from the FP auto-close policy. */
function confidenceCalibration(
  policy: FpPolicy,
  verdict?: string,
): { threshold?: number; note?: string } {
  if (!policy || typeof policy.min_confidence !== 'number') return {};
  const v = (verdict || '').toLowerCase();
  const isFp = v.includes('false') || v === 'fp' || v.includes('benign');
  const note = policy.enabled
    ? isFp
      ? 'FP auto-close enabled at this bar'
      : 'bar governs FP only'
    : 'auto-close off';
  return { threshold: policy.min_confidence, note };
}

/** Map a severity-ish value to a token text-color class for the headline panels. */
type ScoreTone = 'critical' | 'high' | 'medium' | 'low' | 'info';

const TONE_TEXT: Record<ScoreTone, string> = {
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
  info: 'text-info',
};
const TONE_BORDER: Record<ScoreTone, string> = {
  critical: 'border-critical/30 bg-critical/5',
  high: 'border-high/30 bg-high/5',
  medium: 'border-medium/30 bg-medium/5',
  low: 'border-low/30 bg-low/5',
  info: 'border-info/30 bg-info/5',
};

/** A quiet top-accent bar tone for the calmer headline panels. */
const TONE_ACCENT: Record<ScoreTone, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
};

/** Headline label for a verdict (Suspicious / Malicious / Benign / …). */
function verdictHeadline(verdict?: string): { label: string; tone: ScoreTone } {
  const t = (verdict || '').trim().toLowerCase();
  if (!t || t === 'none') return { label: 'Unverdicted', tone: 'info' };
  if (t === 'true_positive') return { label: 'Malicious', tone: 'critical' };
  if (t === 'false_positive' || t === 'benign') return { label: 'Benign', tone: 'low' };
  if (t === 'needs_human') return { label: 'Needs human', tone: 'high' };
  if (t === 'suspicious') return { label: 'Suspicious', tone: 'high' };
  return { label: humanizeToken(verdict), tone: 'medium' };
}

/** Confidence headline (Low / Medium / High) from a 0..1 (or 0..100) score. */
function confidenceHeadline(conf?: number): { label: string; tone: ScoreTone } {
  if (typeof conf !== 'number' || Number.isNaN(conf)) {
    return { label: DASH, tone: 'info' };
  }
  const pct = conf <= 1 ? conf * 100 : conf;
  if (pct >= 75) return { label: 'High', tone: 'low' };
  if (pct >= 50) return { label: 'Medium', tone: 'medium' };
  return { label: 'Low', tone: 'high' };
}

/* ----------------------------------------------------------- headline panel -- */

const HeadlinePanel: React.FC<{
  label: string;
  value: string;
  tone: ScoreTone;
}> = ({ label, value, tone }) => (
  <div className="relative flex flex-col items-center justify-center overflow-hidden rounded-lg border border-border bg-card px-4 py-3.5 text-center">
    <span
      aria-hidden="true"
      className={cn('absolute inset-x-0 top-0 h-0.5', TONE_ACCENT[tone])}
    />
    <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
      {label}
    </span>
    <span
      className={cn(
        'mt-1.5 text-base font-semibold tracking-tight tabular-nums',
        TONE_TEXT[tone],
      )}
    >
      {value}
    </span>
  </div>
);

/* ------------------------------------------------------------- meta item --- */

/** One quiet label/value pair for the run-meta strip. `value` is UNTRUSTED. */
const MetaItem: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-[0.625rem] font-semibold uppercase tracking-widest text-muted-foreground">
      {label}
    </span>
    <span className="font-mono text-xs text-foreground">{value}</span>
  </div>
);

/* --------------------------------------------------------- section heading -- */

const SectionHeading: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  tone?: ScoreTone;
  actions?: React.ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
}> = ({ icon: Icon, children, tone: _tone = 'info', actions }) => (
  <div className="mb-4 flex items-center justify-between gap-3">
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h3 className="text-[0.8125rem] font-semibold tracking-tight text-foreground">
        {children}
      </h3>
    </div>
    {actions}
  </div>
);

/* --------------------------------------------------------------- component -- */

export interface CaseDetailProps {
  caseId: string | null | undefined;
  onClose: () => void;
  onNavigate?: Navigate;
}

export const CaseDetail: React.FC<CaseDetailProps> = ({ caseId, onClose, onNavigate }) => {
  const open = Boolean(caseId && caseId.trim());
  const id = caseId || '';

  const [c, setC] = React.useState<Case | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [tab, setTab] = React.useState<
    'overview' | 'why' | 'threat' | 'trace' | 'thread' | 'collab' | 'chat'
  >('overview');

  // Round 3 — triage chips (#12), eager so the overview header is honest on open.
  const [triage, setTriage] = React.useState<TriageChips | null>(null);
  const [triageLoading, setTriageLoading] = React.useState(false);

  // Round 3 — typed ReAct timeline (#12), lazy on the Trace tab.
  const [timeline, setTimeline] = React.useState<TimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = React.useState(false);
  const [timelineError, setTimelineError] = React.useState<unknown>(null);

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

  const { username: currentUser } = useAuth();
  const canComment = useCan('cases', 'comment');
  const canWriteCase = useCan('cases', 'write');

  const [rationale, setRationale] = React.useState<CaseRationale | null>(null);
  const [rationaleLoading, setRationaleLoading] = React.useState(false);
  const [rationaleError, setRationaleError] = React.useState<unknown>(null);

  // Threat context (F11) — lazy.
  const [threat, setThreat] = React.useState<ThreatContextPanel | null>(null);
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
      setC(res);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
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
    setThread(null);
    setThreadError(null);
    setThreadBusyId(null);
    setTasks(null);
    setTasksBusyId(null);
    setActivity(null);
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
      setTriage(res.chips || null);
    } catch {
      setTriage(null);
    } finally {
      setTriageLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && id) void loadTriage();
  }, [open, id, loadTriage]);

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
      setTimeline(res);
    } catch (e) {
      setTimelineError(e);
    } finally {
      setTimelineLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && tab === 'trace' && timeline === null && !timelineLoading) {
      void loadTimeline();
    }
  }, [open, tab, timeline, timelineLoading, loadTimeline]);

  // ---- Collaboration: thread + tasks + activity (#4) -------------------- //
  const loadThread = React.useCallback(async () => {
    if (!id) return;
    setThreadLoading(true);
    setThreadError(null);
    try {
      const res = await getThread(id);
      setThread(res.messages || []);
    } catch (e) {
      setThreadError(e);
    } finally {
      setThreadLoading(false);
    }
  }, [id]);

  const loadTasks = React.useCallback(async () => {
    if (!id) return;
    try {
      const res = await getTasks(id);
      setTasks(res.tasks || []);
    } catch {
      setTasks([]);
    }
  }, [id]);

  const loadActivity = React.useCallback(async () => {
    if (!id) return;
    setActivityLoading(true);
    try {
      const res = await getActivity(id);
      setActivity(res.activity || []);
    } catch {
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && tab === 'thread') {
      if (thread === null && !threadLoading) void loadThread();
      if (tasks === null) void loadTasks();
      if (activity === null && !activityLoading) void loadActivity();
    }
  }, [
    open,
    tab,
    thread,
    threadLoading,
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
      setRationale(res);
    } catch (e) {
      setRationaleError(e);
    } finally {
      setRationaleLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && tab === 'why' && rationale === null && !rationaleLoading) {
      void loadRationale();
    }
  }, [open, tab, rationale, rationaleLoading, loadRationale]);

  const loadThreat = React.useCallback(async () => {
    if (!id) return;
    setThreatLoading(true);
    setThreatError(null);
    try {
      const res = await api.cases.threatContext(id);
      setThreat(res);
    } catch (e) {
      setThreatError(e);
    } finally {
      setThreatLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && tab === 'threat' && threat === null && !threatLoading) {
      void loadThreat();
    }
  }, [open, tab, threat, threatLoading, loadThreat]);

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
      const input: CaseActionInput = { action: pending.key };
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
      // A lifecycle action re-derives the chips + leaves an activity row.
      void loadTriage();
      if (activity !== null) void loadActivity();
    } catch (e) {
      setError(e);
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
      void loadTriage();
    } catch (e) {
      setError(e);
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
        setError(e);
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

  const headerActions = actionsForStatus(c?.status);

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
                      <DemoBadge show={isDemoCase(c)} className="text-[10px]" />
                    </div>
                    <h2 className="mt-0.5 truncate text-lg font-bold tracking-tight text-foreground">
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
                          <SelectTrigger className="h-8 text-xs">
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
                              <SelectTrigger className="h-8 text-xs">
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
                      <TabsTrigger value="why" className="gap-1.5 text-xs">
                        <Brain className="h-3.5 w-3.5" /> Why
                      </TabsTrigger>
                      <TabsTrigger value="threat" className="gap-1.5 text-xs">
                        <Globe className="h-3.5 w-3.5" /> Threat context
                      </TabsTrigger>
                      <TabsTrigger value="trace" className="gap-1.5 text-xs">
                        <GitBranch className="h-3.5 w-3.5" /> Trace
                      </TabsTrigger>
                      <TabsTrigger value="thread" className="gap-1.5 text-xs">
                        <Users className="h-3.5 w-3.5" /> Collaboration
                      </TabsTrigger>
                      <TabsTrigger value="collab" className="gap-1.5 text-xs">
                        <Star className="h-3.5 w-3.5" /> Feedback
                      </TabsTrigger>
                      <TabsTrigger value="chat" className="gap-1.5 text-xs">
                        <MessageSquare className="h-3.5 w-3.5" /> Chat
                      </TabsTrigger>
                    </TabsList>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <TabsContent value="overview" className="mt-0 animate-fade-in">
                      <OverviewTab
                        c={c}
                        fpPolicy={fpPolicy}
                        triage={triage}
                        triageLoading={triageLoading}
                        onNavigate={onNavigate}
                      />
                    </TabsContent>
                    <TabsContent value="why" className="mt-0 animate-fade-in">
                      <WhyTab
                        c={c}
                        rationale={rationale}
                        loading={rationaleLoading}
                        error={rationaleError}
                        onRetry={loadRationale}
                      />
                    </TabsContent>
                    <TabsContent value="threat" className="mt-0 animate-fade-in">
                      <ThreatContextTab
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
                    <TabsContent value="thread" className="mt-0 animate-fade-in">
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
                      />
                    </TabsContent>
                    <TabsContent value="collab" className="mt-0 animate-fade-in">
                      <CollaborationTab c={c} onUpdated={(next) => setC(next)} />
                    </TabsContent>
                    <TabsContent value="chat" className="mt-0 animate-fade-in">
                      <ChatTab c={c} onNavigate={onNavigate} onClose={onClose} />
                    </TabsContent>
                  </div>
                </Tabs>
              )}
            </div>

            {/* ----------------------------------------------------- footer */}
            {c ? (
              <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-6 py-3">
                <Button variant="ghost" size="sm" onClick={onClose}>
                  <X className="h-4 w-4" /> Dismiss
                </Button>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {headerActions.map((a) => {
                    const Icon = a.icon;
                    const perm = ACTION_PERMISSION[a.key];
                    return (
                      <Can key={a.key} resource={perm.resource} action={perm.action}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant={a.fill ? a.variant : 'outline'}
                              disabled={loading || acting}
                              onClick={() => openAction(a)}
                              aria-label={`${a.label} — ${a.help}`}
                            >
                              <Icon className="h-4 w-4" />
                              {a.label}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{a.help}</TooltipContent>
                        </Tooltip>
                      </Can>
                    );
                  })}
                </div>
              </footer>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      {/* ----------------------------------------------- confirm action dialog */}
      <Dialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o && !acting) closeAction();
        }}
      >
        {pending ? (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <pending.icon className="h-5 w-5" />
                {pending.confirmTitle}
              </DialogTitle>
              <DialogDescription>{pending.confirmBody}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {pending.fields.includes('resolution') ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Resolution (optional)</Label>
                  <Select
                    value={resolution || '__none__'}
                    onValueChange={(v) => setResolution(v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="— No resolution —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— No resolution —</SelectItem>
                      {RESOLUTION_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.text}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              {pending.fields.includes('tags') ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Tags (optional)</Label>
                  <TagInput
                    tags={actionTags}
                    draft={actionTagDraft}
                    onDraftChange={setActionTagDraft}
                    onTagsChange={setActionTags}
                  />
                </div>
              ) : null}

              {pending.fields.includes('assignee') ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Assign to (optional)</Label>
                  <Input
                    placeholder="e.g. tier-2 or jdoe"
                    value={actionAssignee}
                    onChange={(e) => setActionAssignee(e.target.value)}
                  />
                </div>
              ) : null}

              {pending.fields.includes('priority') ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Priority (optional)</Label>
                  <Select
                    value={priority || '__none__'}
                    onValueChange={(v) => setPriority(v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="— No priority —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— No priority —</SelectItem>
                      {PRIORITY_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.text}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              {pending.fields.includes('disposition') ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Disposition</Label>
                  <Select value={actionDisposition} onValueChange={setActionDisposition}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select an outcome…" />
                    </SelectTrigger>
                    <SelectContent>
                      {DISPOSITION_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.text}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              {pending.fields.includes('reason') ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Reason (optional)</Label>
                  <Input
                    placeholder="Why — e.g. awaiting vendor reply, confirmed benign…"
                    value={actionReason}
                    onChange={(e) => setActionReason(e.target.value)}
                  />
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label className="text-xs">Analyst note (optional)</Label>
                <Textarea
                  rows={3}
                  placeholder="Add context for the next analyst…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={closeAction} disabled={acting}>
                Cancel
              </Button>
              <Button
                variant={pending.variant === 'outline' ? 'default' : pending.variant}
                onClick={() => void runAction()}
                disabled={
                  acting ||
                  (pending.fields.includes('disposition') && !actionDisposition)
                }
              >
                {acting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <pending.icon className="h-4 w-4" />}
                {pending.label}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

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

/* --------------------------------------------------------------- TagInput == */

/** A dependency-free chips input (enter/comma adds, ✕ removes). UNTRUSTED text. */
const TagInput: React.FC<{
  tags: string[];
  draft: string;
  onDraftChange: (v: string) => void;
  onTagsChange: (tags: string[]) => void;
}> = ({ tags, draft, onDraftChange, onTagsChange }) => {
  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (!tags.includes(v)) onTagsChange([...tags, v]);
    onDraftChange('');
  };
  return (
    <div className="rounded-md border border-border bg-background p-1.5">
      {tags.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1">
              {/* UNTRUSTED tag — plain text node. */}
              <span className="max-w-[10rem] truncate">{t}</span>
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                className="rounded-sm opacity-70 hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
                onClick={() => onTagsChange(tags.filter((x) => x !== t))}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      <Input
        className="h-7 border-0 px-1 shadow-none focus-visible:ring-0"
        placeholder="Add a tag…"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && tags.length) {
            onTagsChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
      />
    </div>
  );
};

/* ================================================================ Overview == */

const RULED_OUT_RE =
  /\b(no\s+(match|evidence|sign|indicat|hit|result)|not\s+(malicious|found|present|observed)|ruled\s+out|clean|benign|negative|nothing\s+(found|suspicious)|false\s+positive|cleared)\b/i;

function isRuledOut(summary?: string): boolean {
  return !!summary && RULED_OUT_RE.test(summary);
}

/* ------------------------------------------------------- status timeline -- */

/** Append-only lifecycle transition trail (F8). `by`/`reason` are operator/agent
 *  text — rendered as plain text (#9). Renders nothing when empty. */
const StatusTimeline: React.FC<{
  history?: Case['status_history'];
  statusReason?: string;
}> = ({ history, statusReason }) => {
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length && !statusReason) return null;
  // Newest last (chronological), reversed for newest-first display.
  const ordered = [...entries].reverse();
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <SectionHeading icon={History} tone="info">
        Status timeline
      </SectionHeading>
      {statusReason ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {/* UNTRUSTED status reason — plain text. */}
          Current reason: <span className="text-foreground/90">{statusReason}</span>
        </p>
      ) : null}
      {ordered.length ? (
        <ol className="relative space-y-4 border-l border-border pl-5">
          {ordered.map((e, i) => (
            <li key={`${e.at}-${i}`} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[1.4rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-card bg-primary"
              />
              <div className="flex flex-wrap items-center gap-2">
                {e.from_status ? <StatusBadge status={e.from_status} /> : null}
                <span className="text-xs text-muted-foreground">{DASH}</span>
                <StatusBadge status={e.to_status} />
                <span className="text-xs text-muted-foreground">
                  {e.at ? humanizeAge(e.at) : ''}
                  {e.by ? <> · {humanizeToken(e.by)}</> : null}
                </span>
              </div>
              {e.reason ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {/* UNTRUSTED — plain text. */}
                  {e.reason}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No lifecycle transitions recorded yet.</p>
      )}
    </div>
  );
};

/* ----------------------------------------- related cases + source breakdown */

/**
 * Cross-source linkage panel (F6). Renders RELATED cases (never merged) + a source
 * breakdown when present. Related-case titles are fetched best-effort for nicer
 * labels; all case-derived text is UNTRUSTED → plain text. Renders nothing when no
 * cross-source data is present, so it is fully additive to the overview.
 */
const RelatedCrossSource: React.FC<{ c: Case; onNavigate?: Navigate }> = ({ c, onNavigate }) => {
  const relatedIds = React.useMemo(
    () =>
      (Array.isArray(c.related_case_ids) ? c.related_case_ids : []).filter(
        (rid): rid is string => typeof rid === 'string' && !!rid && rid !== c.case_id,
      ),
    [c.related_case_ids, c.case_id],
  );
  const breakdown = React.useMemo(() => {
    const b = c.source_breakdown;
    if (!b || typeof b !== 'object') return [] as Array<[string, number]>;
    return Object.entries(b)
      .filter(([, v]) => typeof v === 'number')
      .sort((a, bb) => bb[1] - a[1]);
  }, [c.source_breakdown]);

  // Best-effort titles for the related case ids (fetch the recent list, map by id).
  const [titles, setTitles] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!relatedIds.length) return;
    let cancelled = false;
    void api
      .listCases({ limit: 200 })
      .then((res) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const rc of res.cases) {
          if (relatedIds.includes(rc.case_id)) {
            map[rc.case_id] = rc.title || rc.case_number || rc.case_id;
          }
        }
        setTitles(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [relatedIds]);

  if (!relatedIds.length && !breakdown.length && !c.cross_source_cluster_id) return null;

  const openRelated = (rid: string) => {
    if (onNavigate) onNavigate('cases', { caseId: rid });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={GitBranch} tone="info">
          Related cases
        </SectionHeading>
        {relatedIds.length ? (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              Grouped by a shared entity across sources within the cross-source window. These are
              RELATED — they are never merged into this case.
            </p>
            <ul className="space-y-2">
              {relatedIds.map((rid) => (
                <li key={rid} className="flex items-center gap-2">
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <button
                    type="button"
                    onClick={() => openRelated(rid)}
                    disabled={!onNavigate}
                    className={cn(
                      'truncate rounded-sm text-left text-sm',
                      onNavigate
                        ? 'text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                        : 'cursor-default text-foreground',
                    )}
                    title={titles[rid] || rid}
                  >
                    {/* UNTRUSTED title / id — plain text. */}
                    {titles[rid] || rid}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No related cases.</p>
        )}
        {c.cross_source_cluster_id ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Cross-source group{' '}
            {/* UNTRUSTED id — plain text, mono. */}
            <span className="font-mono text-foreground/80">{c.cross_source_cluster_id}</span>
          </p>
        ) : null}
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={Globe} tone="info">
          Source breakdown
        </SectionHeading>
        {breakdown.length ? (
          <dl className="divide-y divide-border">
            {breakdown.map(([sid, count]) => (
              <div
                key={sid}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                {/* UNTRUSTED source id — plain text, truncated. */}
                <dt className="truncate font-mono text-xs text-foreground" title={sid}>
                  {sid}
                </dt>
                <dd className="shrink-0">
                  <Badge variant="outline" className="tabular-nums">
                    {count}
                  </Badge>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Single source.</p>
        )}
      </div>
    </div>
  );
};

/* ----------------------------------------------- threshold automation (F10) */

/** Map an automation action verb → label + icon + tone. */
const AUTOMATION_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: ScoreTone }
> = {
  tag: { label: 'Tagged', icon: Tag, tone: 'info' },
  recommend: { label: 'Recommendation', icon: Info, tone: 'medium' },
  notify: { label: 'Notified', icon: Bell, tone: 'info' },
  run_playbook: { label: 'Queued playbook', icon: BookOpen, tone: 'low' },
  request_approval: { label: 'Proposed (needs approval)', icon: Lock, tone: 'high' },
};

/**
 * Shows the SAFE actions threshold automation applied to this case (F10). Renders
 * nothing when none ran. These are non-binding: automation can tag / recommend /
 * notify / queue a re-investigation / draft a Proposal, but NEVER sets the case
 * status or auto-closes — the close/escalate decision is always deterministic. All
 * detail text is operator/agent-authored → plain text (#9).
 */
const AutomationApplied: React.FC<{ c: Case }> = ({ c }) => {
  const actions = Array.isArray(c.automation_actions) ? c.automation_actions : [];
  if (!actions.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <SectionHeading icon={Zap} tone="info">
        Automation applied
      </SectionHeading>
      <p className="mb-3 text-xs text-muted-foreground">
        Threshold-automation actions taken after the deterministic decision. These are
        non-binding — automation can tag, recommend, notify, queue a re-investigation, or draft a
        proposal, but it never changes the lifecycle status or auto-closes a case.
      </p>
      <ul className="space-y-2">
        {actions.map((a, i) => {
          const meta = AUTOMATION_META[String(a.action || '')] || {
            label: humanizeToken(String(a.action || 'Action')),
            icon: Zap,
            tone: 'info' as ScoreTone,
          };
          const Icon = meta.icon;
          return (
            <li
              key={`${a.rule_id || a.action || i}-${i}`}
              className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm"
            >
              <Badge variant={meta.tone === 'low' ? 'success' : meta.tone} className="shrink-0 gap-1">
                <Icon className="h-3 w-3" />
                {meta.label}
              </Badge>
              <div className="min-w-0 flex-1">
                {a.detail ? (
                  /* UNTRUSTED — plain text. */
                  <p className="whitespace-pre-wrap text-foreground/90">{a.detail}</p>
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {a.rule_id ? <span className="font-mono">rule {a.rule_id}</span> : null}
                  {a.proposal_id ? (
                    <span className="font-mono">proposal {a.proposal_id}</span>
                  ) : null}
                  {a.at ? <span>{humanizeAge(a.at)}</span> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const OverviewTab: React.FC<{
  c: Case;
  fpPolicy: FpPolicy;
  triage: TriageChips | null;
  triageLoading: boolean;
  onNavigate?: Navigate;
}> = ({ c, fpPolicy, triage, triageLoading, onNavigate }) => {
  const trigger = c.trigger_reason as { sentence?: string } | undefined;
  const triggerSentence = trigger?.sentence;
  const allEvidence = c.evidence || [];
  const ruledOut = allEvidence.filter((e) => isRuledOut(e.summary));
  const evidence = allEvidence.filter((e) => !isRuledOut(e.summary));
  const mitre = c.mitre || [];

  const ruleIds = (c.rule_ids || []).filter((r) => typeof r === 'string' && r.trim());

  // Verdict + confidence headline panels (kept). Severity / impact / priority are now
  // the four-chip CaseTriageHeader (#12) — honestly distinct, no longer all = risk.
  const verdictH = verdictHeadline(c.verdict);
  const confH = confidenceHeadline(c.confidence);

  // Affected assets (entity + enrichment KV).
  const caseEnrichment =
    c.enrichment && typeof c.enrichment === 'object'
      ? (c.enrichment as Record<string, unknown>)
      : null;
  const entityType = c.entity?.type || c.entity_type || null;

  // Run-meta strip values (best-effort, UNTRUSTED).
  const startedAt = c.created_at;
  const completedAt = c.updated_at;
  const profile = c.playbook_id || (c.agent_persona && c.agent_persona !== 'generalist'
    ? humanizeToken(c.agent_persona)
    : null);

  // Auto-close explanation line.
  const autoCloseLine = ((): string | null => {
    if (!fpPolicy || typeof fpPolicy.min_confidence !== 'number') return null;
    const v = (c.verdict || '').toLowerCase();
    const isFp = v.includes('false') || v === 'fp' || v.includes('benign');
    if (!fpPolicy.enabled) {
      return 'False-positive auto-close is disabled — this case was held for a human regardless of confidence.';
    }
    if (!isFp) {
      return 'NEEDS_HUMAN and true-positive verdicts never auto-close — the auto-close bar applies to false positives only.';
    }
    const conf = typeof c.confidence === 'number' ? c.confidence : null;
    const risk = typeof c.risk_score === 'number' ? c.risk_score : null;
    const confOk = conf !== null && conf >= fpPolicy.min_confidence;
    const riskOk =
      typeof fpPolicy.max_risk_score !== 'number' ||
      (risk !== null && risk <= fpPolicy.max_risk_score);
    const bar = fpPolicy.min_confidence.toFixed(2);
    if (confOk && riskOk) {
      return `Eligible for auto-close: confidence is at/above the ${bar} bar and risk is within the policy ceiling.`;
    }
    if (!confOk) return `Below the ${bar} auto-close confidence bar — held for a human.`;
    return 'Above the confidence bar but risk exceeds the auto-close ceiling — held for a human.';
  })();

  const rb = c.risk_breakdown as
    | {
        volume?: number;
        velocity?: number;
        reputation?: number;
        diversity?: number;
        asset_criticality?: number;
        total?: number;
      }
    | undefined;

  const riskItems = React.useMemo<BarListItem[]>(() => {
    if (!rb) return [];
    const comps: Array<{ label: string; value: number }> = [
      { label: 'Volume', value: rb.volume ?? 0 },
      { label: 'Velocity', value: rb.velocity ?? 0 },
      { label: 'Reputation', value: rb.reputation ?? 0 },
      { label: 'Diversity', value: rb.diversity ?? 0 },
      { label: 'Asset criticality', value: rb.asset_criticality ?? 0 },
    ];
    const barColor = (n: number) =>
      n >= 80 ? 'bg-critical' : n >= 60 ? 'bg-high' : n >= 35 ? 'bg-medium' : 'bg-low';
    return comps.map((x) => ({ ...x, color: barColor(x.value) }));
  }, [rb]);

  // Affected-asset KV rows (hostname/user from entity + enrichment scalars).
  const assetRows: Array<{ k: string; v: string }> = [];
  if (c.entity) {
    assetRows.push({
      k: entityType === 'host' ? 'Hostname' : entityType === 'user' ? 'User Name' : entityType === 'ip' ? 'IP Address' : humanizeToken(entityType || 'Entity'),
      v: c.entity.value,
    });
  }
  if (caseEnrichment) {
    for (const [k, v] of Object.entries(caseEnrichment)) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      assetRows.push({ k: humanizeToken(k), v: String(v) });
    }
  }

  return (
    <div className="space-y-7 p-6">
      {/* ----------------------------------------------- run-meta strip */}
      <div className="flex flex-wrap items-center gap-x-10 gap-y-3 rounded-lg border border-border bg-muted/30 px-5 py-3.5">
        <MetaItem label="Started" value={startedAt ? formatTimestamp(startedAt) : DASH} />
        <MetaItem label="Completed" value={completedAt ? formatTimestamp(completedAt) : DASH} />
        {ruleIds.length ? <MetaItem label="Trigger" value={ruleIds[0]} /> : null}
        {profile ? <MetaItem label="Profile" value={profile} /> : null}
      </div>

      {/* ------------------------------- the four honest triage chips (#12) */}
      <CaseTriageHeader chips={triage} loading={triageLoading} />

      {/* verdict + confidence headline (kept; severity/impact/priority moved into
          the four-chip header above so each signal is honestly distinct). */}
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <HeadlinePanel label="Verdict" value={verdictH.label} tone={verdictH.tone} />
        <HeadlinePanel label="Confidence" value={confH.label} tone={confH.tone} />
      </div>

      {/* secondary badge row (precise values) */}
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={c.verdict} />
        <StatusBadge status={c.status} />
        <DispositionBadge disposition={c.disposition ?? null} />
        {typeof c.escalation_level === 'number' && c.escalation_level > 0 ? (
          <Badge variant="critical" className="gap-1">
            <Bell className="h-3 w-3" />
            Escalation L{c.escalation_level}
          </Badge>
        ) : null}
        <RiskBadge score={c.risk_score} />
        <ConfidenceBadge
          confidence={c.confidence}
          {...confidenceCalibration(fpPolicy, c.verdict)}
        />
        {c.source_name || c.source_id ? (
          <Badge variant="outline" className="gap-1">
            <Globe className="h-3 w-3" />
            {/* UNTRUSTED source name — plain text node. */}
            <span className="max-w-[12rem] truncate">{c.source_name || c.source_id}</span>
          </Badge>
        ) : null}
        {c.agent_persona && c.agent_persona !== 'generalist' ? (
          <Badge variant="outline" className="gap-1">
            <User className="h-3 w-3" />
            {humanizeToken(c.agent_persona)}
          </Badge>
        ) : null}
      </div>

      {/* ----------------------------------------------- incident digest */}
      {c.summary || triggerSentence ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={FileText} tone="info">
            Incident Digest
          </SectionHeading>
          {triggerSentence ? (
            <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
              {/* UNTRUSTED — plain text. */}
              {triggerSentence}
            </p>
          ) : null}
          {c.summary ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {/* UNTRUSTED — plain text. */}
              {c.summary}
            </p>
          ) : null}
        </div>
      ) : null}

      {autoCloseLine ? (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>Auto-close policy</AlertTitle>
          <AlertDescription>{autoCloseLine}</AlertDescription>
        </Alert>
      ) : null}

      {/* ------------------------------- affected assets + IOC indicators */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={Crosshair} tone="info">
            Affected Assets
          </SectionHeading>
          {assetRows.length ? (
            <dl className="divide-y divide-border">
              {assetRows.map((row, i) => (
                <div
                  key={`${row.k}-${i}`}
                  className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {row.k}
                  </dt>
                  {/* UNTRUSTED value — plain text node, mono. */}
                  <dd className="truncate text-right font-mono text-sm text-foreground">
                    {row.v}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No assets recorded.</p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={Target} tone="critical">
            IOC Indicators
          </SectionHeading>
          {evidence.some((e) => e.query) || c.reproduce_query ? (
            <div className="space-y-3">
              {evidence
                .filter((e) => e.query)
                .map((e, i) => (
                  <div key={i} className="space-y-1.5">
                    <Badge variant="outline" className="font-mono">
                      Command Line
                    </Badge>
                    {/* UNTRUSTED query — inside CodeBlock fence. */}
                    <CodeBlock value={e.query} copyable wrap maxHeightClassName="max-h-40" />
                    {e.summary ? (
                      <p className="text-xs text-muted-foreground">{e.summary}</p>
                    ) : null}
                  </div>
                ))}
              {c.reproduce_query ? (
                <div className="space-y-1.5">
                  <Badge variant="outline" className="font-mono">
                    Reproduce query
                  </Badge>
                  <CodeBlock
                    value={c.reproduce_query}
                    caption="read-only"
                    wrap
                    maxHeightClassName="max-h-40"
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No indicators recorded.</p>
          )}
        </div>
      </div>

      {/* ------------------------------------------- evidence findings */}
      <div>
        <SectionHeading icon={Search} tone="info">
          Evidence Findings
        </SectionHeading>
        {evidence.length === 0 ? (
          <EmptyState
            icon={Search}
            compact
            title="No positive findings"
            description={
              ruledOut.length
                ? 'All evidence was checked and cleared (see "Checked & clean" below).'
                : 'No evidence recorded for this case.'
            }
          />
        ) : (
          <div className="space-y-3">
            {evidence.map((ev, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-6">
                <div className="mb-3 flex items-start justify-between gap-3">
                  {/* UNTRUSTED summary as the finding subject — plain text. */}
                  <h4 className="text-sm font-semibold text-foreground">
                    {ev.summary ? ev.summary.split('.')[0] : `Evidence ${i + 1}`}
                  </h4>
                  <Badge variant="info" className="shrink-0">
                    {ev.event_ids && ev.event_ids.length
                      ? `${ev.event_ids.length} event${ev.event_ids.length === 1 ? '' : 's'}`
                      : 'Finding'}
                  </Badge>
                </div>
                <dl className="space-y-2 text-sm">
                  {c.entity?.value ? (
                    <div className="grid grid-cols-[7rem_1fr] gap-2">
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Subject
                      </dt>
                      {/* UNTRUSTED — plain text. */}
                      <dd className="font-mono text-foreground">{c.entity.value}</dd>
                    </div>
                  ) : null}
                  {ev.query ? (
                    <div className="grid grid-cols-[7rem_1fr] gap-2">
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Evidence
                      </dt>
                      <dd>
                        <CodeBlock value={ev.query} copyable wrap maxHeightClassName="max-h-32" />
                      </dd>
                    </div>
                  ) : null}
                  {ev.summary ? (
                    <div className="grid grid-cols-[7rem_1fr] gap-2">
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Conclusion
                      </dt>
                      {/* UNTRUSTED — plain text. */}
                      <dd className="whitespace-pre-wrap text-muted-foreground">{ev.summary}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------- ruled out / clean */}
      {ruledOut.length ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={CheckCircle2} tone="low">
            Ruled out / Checked &amp; clean
          </SectionHeading>
          <p className="mb-3 text-xs text-muted-foreground">
            Negative findings — what the investigation checked and cleared.
          </p>
          <ul className="space-y-2">
            {ruledOut.map((ev, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                {/* UNTRUSTED — plain text. */}
                <span className="whitespace-pre-wrap text-foreground/90">
                  {ev.summary || `Checked item ${i + 1}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ------------------------------- recommended action + risk breakdown */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={Activity} tone="info">
            Recommended action
          </SectionHeading>
          {/* UNTRUSTED — plain text. */}
          <p className="whitespace-pre-wrap text-sm text-foreground/90">
            {c.recommended_action || DASH}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={Gauge} tone="critical">
            Risk breakdown
          </SectionHeading>
          {riskItems.length ? (
            <BarList items={riskItems} format={(n) => String(Math.round(n))} showPercent />
          ) : (
            <p className="text-sm text-muted-foreground">No risk breakdown recorded.</p>
          )}
          {rb && typeof rb.total === 'number' ? (
            <>
              <Separator className="my-3" />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Total</span>
                <RiskBadge score={rb.total} label="" />
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* ------------------------------------------- MITRE */}
      {mitre.length ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={Shield} tone="medium">
            MITRE ATT&amp;CK techniques
          </SectionHeading>
          <div className="flex flex-wrap gap-2">
            {mitre.map((m, i) => (
              <Badge key={`${m}-${i}`} variant="outline" className="font-mono">
                {m}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {/* --------------------------- related cases + source breakdown (F6) */}
      <RelatedCrossSource c={c} onNavigate={onNavigate} />

      {/* ------------------------------- threshold automation (F10) */}
      <AutomationApplied c={c} />

      {/* ------------------------------------------- status timeline */}
      <StatusTimeline history={c.status_history} statusReason={c.status_reason} />

      {/* ------------------------------------------- footer meta */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>Created {formatTimestamp(c.created_at)}</span>
        <span>Token cost {fmtMoney(c.token_cost)}</span>
        {c.decision_by ? <span>Decided by {humanizeToken(c.decision_by)}</span> : null}
      </div>

      {c.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Investigation error</AlertTitle>
          {/* UNTRUSTED — plain text. */}
          <AlertDescription className="whitespace-pre-wrap">{c.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};

/* ===================================================================== Why == */

function decisionByLabel(decisionBy?: string): { text: string; isHuman: boolean } {
  const d = (decisionBy || '').toLowerCase();
  const isHuman = d.includes('human') || d.includes('analyst') || d.includes('operator');
  return { text: decisionBy ? humanizeToken(decisionBy) : 'Automated pipeline', isHuman };
}

const WhyTab: React.FC<{
  c: Case;
  rationale: CaseRationale | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}> = ({ c, rationale, loading, error, onRetry }) => {
  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load decision rationale</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'Something went wrong.'}
          </AlertDescription>
        </Alert>
        <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> Retry
        </Button>
      </div>
    );
  }
  if (!rationale) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Brain}
          title="No rationale recorded yet"
          description="The decision rationale appears after an investigation runs. It shows the agent's reasoning, the knowledge it retrieved, and the deterministic close / escalate decision."
        />
      </div>
    );
  }

  const r = rationale;
  const verdict = r.verdict ?? c.verdict;
  const confidence = typeof r.confidence === 'number' ? r.confidence : c.confidence;
  const status = r.status ?? c.status;
  const persona = r.persona ?? c.agent_persona;
  const decision = decisionByLabel(r.decision_by ?? c.decision_by);

  const knowledge = r.knowledge || [];
  const tools = r.tools || [];
  const memory = (r.memory_used || []).filter((m) => (m || '').trim());
  const mitre = r.mitre || [];
  const enr = r.enrichment || null;
  const playbook = r.playbook || null;

  return (
    <div className="space-y-7 p-6">
      {/* ------------------------------------------- decision summary */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={Brain} tone="info">
          Decision
        </SectionHeading>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={verdict} />
          <StatusBadge status={status} />
          {typeof confidence === 'number' ? (
            <ConfidenceBadge confidence={confidence} />
          ) : null}
          <Badge variant={decision.isHuman ? 'success' : 'info'} className="gap-1">
            {decision.isHuman ? <User className="h-3 w-3" /> : <Brain className="h-3 w-3" />}
            Decided by {decision.text}
          </Badge>
          {persona && persona !== 'generalist' ? (
            <Badge variant="outline" className="gap-1">
              <User className="h-3 w-3" />
              {humanizeToken(persona)}
            </Badge>
          ) : null}
        </div>
        <Alert>
          <GitBranch className="h-4 w-4" />
          <AlertTitle>Deterministic decision</AlertTitle>
          {/* UNTRUSTED — plain text. */}
          <AlertDescription className="whitespace-pre-wrap">
            {r.decision_rationale
              ? r.decision_rationale
              : 'The close / escalate decision is made by deterministic code against the operator-configured auto-close policy — never by raw model output. No rationale string was recorded for this case.'}
          </AlertDescription>
        </Alert>
      </div>

      {/* ------------------------------------------- agent reasoning */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={Activity} tone="info">
          Agent reasoning
        </SectionHeading>
        {r.reasoning && r.reasoning.trim() ? (
          /* UNTRUSTED — plain text. */
          <p className="whitespace-pre-wrap text-sm text-foreground/90">{r.reasoning}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No reasoning excerpt was recorded for this investigation.
          </p>
        )}
      </div>

      {/* ------------------------------------------- knowledge used */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={BookOpen} tone="low">
          Knowledge used
        </SectionHeading>
        <p className="mb-3 text-xs text-muted-foreground">
          Retrieved RAG / runbook / playbook context the investigation drew on.
        </p>
        {knowledge.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            compact
            title="No knowledge retrieved"
            description="The investigation did not pull any RAG / runbook / playbook snippets."
          />
        ) : (
          <div className="space-y-3">
            {knowledge.map((k, i) => (
              <div key={i} className="rounded-md border border-border bg-muted/30 p-3">
                <Badge variant="info" className="mb-2 gap-1">
                  <BookOpen className="h-3 w-3" />
                  {humanizeToken(k.source) || 'Knowledge'}
                </Badge>
                {k.snippet ? (
                  /* UNTRUSTED — inside CodeBlock fence. */
                  <CodeBlock value={k.snippet} wrap copyable maxHeightClassName="max-h-40" />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------- commands the agent ran */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={Terminal} tone="info">
          Commands the agent ran
        </SectionHeading>
        <p className="mb-3 text-xs text-muted-foreground">
          The tools / read-only queries the investigator invoked to gather evidence.
        </p>
        {tools.length === 0 ? (
          <EmptyState
            icon={Terminal}
            compact
            title="No tools were invoked"
            description="This case reached its verdict without running any investigation tools."
          />
        ) : (
          <div className="space-y-3">
            {tools.map((t, i) => (
              <div key={i} className="rounded-md border border-border bg-muted/30 p-3">
                <Badge variant="info" className="mb-2 gap-1">
                  <Wrench className="h-3 w-3" />
                  {t.tool || `Tool ${i + 1}`}
                </Badge>
                {t.query ? (
                  <CodeBlock value={t.query} wrap copyable maxHeightClassName="max-h-40" />
                ) : null}
                {t.summary ? (
                  /* UNTRUSTED — plain text. */
                  <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                    {t.summary}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------- operator memory */}
      {memory.length ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={Brain} tone="medium">
            Operator memory applied
          </SectionHeading>
          <p className="mb-3 text-xs text-muted-foreground">
            Durable operator facts the investigation was told to honour.
          </p>
          <ul className="space-y-2">
            {memory.map((m, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Badge variant="medium" className="shrink-0 gap-1">
                  <Brain className="h-3 w-3" /> Memory
                </Badge>
                {/* UNTRUSTED — plain text. */}
                <span className="whitespace-pre-wrap text-foreground/90">{m}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ------------------------------- enrichment + playbook */}
      {enr || (playbook && playbook.id) ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {enr ? (
            <div className="rounded-lg border border-border bg-card p-6">
              <SectionHeading icon={Globe} tone="critical">
                Enrichment
              </SectionHeading>
              <div className="grid grid-cols-2 gap-3">
                {typeof enr.reputation_score === 'number' ? (
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="text-xs text-muted-foreground">Reputation score</div>
                    <div className="mt-1 text-xl font-bold text-foreground">
                      {Math.round(enr.reputation_score)}
                    </div>
                  </div>
                ) : null}
                {typeof enr.is_malicious === 'boolean' ? (
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="text-xs text-muted-foreground">Threat verdict</div>
                    <div
                      className={cn(
                        'mt-1 text-xl font-bold',
                        enr.is_malicious ? 'text-critical' : 'text-success',
                      )}
                    >
                      {enr.is_malicious ? 'Malicious' : 'Clean'}
                    </div>
                  </div>
                ) : null}
                {enr.country ? (
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="text-xs text-muted-foreground">Country</div>
                    {/* UNTRUSTED — plain text. */}
                    <div className="mt-1 text-xl font-bold text-foreground">{enr.country}</div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {playbook && playbook.id ? (
            <div className="rounded-lg border border-border bg-card p-6">
              <SectionHeading icon={BookOpen} tone="low">
                Playbook
              </SectionHeading>
              <Badge variant="info" className="font-mono">
                {playbook.id}
              </Badge>
              {playbook.reason ? (
                /* UNTRUSTED — plain text. */
                <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {playbook.reason}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------- MITRE */}
      {mitre.length ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={Shield} tone="medium">
            MITRE ATT&amp;CK techniques
          </SectionHeading>
          <div className="flex flex-wrap gap-2">
            {mitre.map((m, i) => (
              <Badge key={`${m}-${i}`} variant="outline" className="font-mono">
                {m}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

/* ========================================================== Threat context == */

/** Canonical MITRE ATT&CK technique URL (id like "T1110" or "T1110.001"). */
function mitreUrl(id: string, fallback?: string): string {
  if (fallback && /^https?:\/\//i.test(fallback)) return fallback;
  const clean = (id || '').trim().toUpperCase();
  const m = /^T(\d{4})(?:\.(\d{3}))?$/.exec(clean);
  if (!m) return 'https://attack.mitre.org/techniques/';
  return m[2]
    ? `https://attack.mitre.org/techniques/T${m[1]}/${m[2]}/`
    : `https://attack.mitre.org/techniques/T${m[1]}/`;
}

const ThreatContextTab: React.FC<{
  c: Case;
  panel: ThreatContextPanel | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onNavigate?: Navigate;
}> = ({ c, panel, loading, error, onRetry, onNavigate }) => {
  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load threat context</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'Something went wrong.'}
          </AlertDescription>
        </Alert>
        <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> Retry
        </Button>
      </div>
    );
  }
  if (panel?.disabled) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Globe}
          title="Threat context is disabled"
          description="Enable the threat-context panel under Settings → Threat context to assemble IOC reputation, MITRE techniques, related cases and asset context for each case."
        />
      </div>
    );
  }
  if (!panel) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Globe}
          title="No threat context"
          description="No threat context could be assembled for this case yet."
        />
      </div>
    );
  }

  const iocs = (panel.ioc_reputation || []).filter((x) => x && x.indicator);
  const techniques = (panel.mitre_techniques || []).filter((t) => t && t.id);
  const related = (panel.related_cases || []).filter((r) => r && r.case_id);
  const asset = panel.asset_context || null;
  const assetAttrs =
    asset && asset.attributes && typeof asset.attributes === 'object'
      ? Object.entries(asset.attributes).filter(
          ([, v]) => v !== null && v !== undefined && typeof v !== 'object',
        )
      : [];
  const evidence = (panel.evidence || []).filter((e) => e && (e.summary || e.query));
  const anySection =
    !!panel.summary ||
    iocs.length > 0 ||
    techniques.length > 0 ||
    related.length > 0 ||
    !!asset ||
    evidence.length > 0;

  const openRelated = (rid: string) => {
    if (onNavigate) onNavigate('cases', { caseId: rid });
  };

  return (
    <div className="space-y-7 p-6">
      {/* ---------------------------------------------- threat banner */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={Shield} tone="critical">
          Threat summary
        </SectionHeading>
        {panel.summary ? (
          /* UNTRUSTED — plain text. */
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {panel.summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No threat summary was assembled for this case.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={c.verdict} />
          <RiskBadge score={c.risk_score} />
          {iocs.some((i) => i.is_malicious) ? (
            <Badge variant="critical" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              Malicious indicator present
            </Badge>
          ) : null}
          {panel.generated_at ? (
            <span className="ml-auto text-xs text-muted-foreground">
              assembled {humanizeAge(panel.generated_at)}
            </span>
          ) : null}
        </div>
      </div>

      {/* ---------------------------------------------- IOC reputation */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={Target} tone="critical">
          IOC reputation
        </SectionHeading>
        {iocs.length === 0 ? (
          <EmptyState
            icon={Target}
            compact
            title="No indicator reputation"
            description="No IOC reputation was available — enrichment may be off, uncached, or the indicators are internal."
          />
        ) : (
          <div className="space-y-2.5">
            {iocs.map((ioc, i) => (
              <div
                key={`${ioc.indicator}-${i}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3"
              >
                {/* UNTRUSTED indicator — plain text, mono. */}
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                  {ioc.indicator}
                </span>
                {ioc.type ? <Badge variant="outline">{humanizeToken(ioc.type)}</Badge> : null}
                {typeof ioc.reputation_score === 'number' ? (
                  <Badge variant={ioc.reputation_score >= 50 ? 'critical' : 'secondary'}>
                    <Gauge className="h-3 w-3" />
                    score {Math.round(ioc.reputation_score)}
                  </Badge>
                ) : null}
                {typeof ioc.is_malicious === 'boolean' ? (
                  <Badge variant={ioc.is_malicious ? 'critical' : 'success'}>
                    {ioc.is_malicious ? 'Malicious' : 'Clean'}
                  </Badge>
                ) : null}
                {ioc.country ? (
                  /* UNTRUSTED — plain text. */
                  <Badge variant="outline" className="gap-1">
                    <Globe className="h-3 w-3" />
                    <span className="max-w-[10rem] truncate">{ioc.country}</span>
                  </Badge>
                ) : null}
                {ioc.source ? (
                  <span className="text-xs text-muted-foreground">{humanizeToken(ioc.source)}</span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------------------------------------------- MITRE techniques */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={Shield} tone="medium">
          MITRE ATT&amp;CK techniques
        </SectionHeading>
        {techniques.length === 0 ? (
          <EmptyState
            icon={Shield}
            compact
            title="No techniques mapped"
            description="No MITRE ATT&CK techniques were resolved for this case."
          />
        ) : (
          <div className="space-y-2.5">
            {techniques.map((t, i) => (
              <div key={`${t.id}-${i}`} className="rounded-md border border-border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {t.id}
                  </Badge>
                  {/* Name is from the curated MITRE corpus (TRUSTED) — still a plain text node. */}
                  <span className="text-sm font-semibold text-foreground">
                    {t.name || 'Unknown technique'}
                  </span>
                  <a
                    href={mitreUrl(t.id, t.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Link2 className="h-3 w-3" /> MITRE
                  </a>
                </div>
                {t.tactics && t.tactics.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {t.tactics.map((tac, j) => (
                      <Badge key={`${tac}-${j}`} variant="medium">
                        {humanizeToken(tac)}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {t.description ? (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {t.description}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------------------------------------------- related cases */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={GitBranch} tone="info">
          Related cases
        </SectionHeading>
        {related.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            compact
            title="No related cases"
            description="No prior or cross-source cases were linked to this one."
          />
        ) : (
          <ul className="space-y-2">
            {related.map((r) => (
              <li
                key={r.case_id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3"
              >
                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <button
                  type="button"
                  onClick={() => openRelated(r.case_id)}
                  disabled={!onNavigate}
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-sm',
                    onNavigate
                      ? 'text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                      : 'cursor-default text-foreground',
                  )}
                  title={r.title || r.case_number || r.case_id}
                >
                  {/* UNTRUSTED — plain text. */}
                  {r.title || r.case_number || r.case_id}
                </button>
                {r.verdict ? <VerdictBadge verdict={r.verdict} /> : null}
                {r.status ? <StatusBadge status={r.status} /> : null}
                {typeof r.risk_score === 'number' ? <RiskBadge score={r.risk_score} /> : null}
                {r.reason ? (
                  <span className="w-full text-xs text-muted-foreground">{r.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---------------------------------------------- asset context */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={Crosshair} tone="info">
          Asset context
        </SectionHeading>
        {!asset || (!asset.entity && assetAttrs.length === 0) ? (
          <EmptyState
            icon={Crosshair}
            compact
            title="No asset context"
            description="No additional context was recorded for the case's primary entity."
          />
        ) : (
          <dl className="divide-y divide-border">
            {asset.entity ? (
              <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {humanizeToken(asset.entity_type || 'Entity')}
                </dt>
                {/* UNTRUSTED — plain text, mono. */}
                <dd className="truncate text-right font-mono text-sm text-foreground">
                  {asset.entity}
                </dd>
              </div>
            ) : null}
            {asset.criticality ? (
              <div className="flex items-center justify-between gap-3 py-2.5">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Criticality
                </dt>
                <dd className="text-right text-sm text-foreground">
                  {humanizeToken(asset.criticality)}
                </dd>
              </div>
            ) : null}
            {assetAttrs.map(([k, v], i) => (
              <div
                key={`${k}-${i}`}
                className="flex items-center justify-between gap-3 py-2.5 last:pb-0"
              >
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {humanizeToken(k)}
                </dt>
                {/* UNTRUSTED — plain text. */}
                <dd className="truncate text-right font-mono text-sm text-foreground">
                  {String(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {/* ---------------------------------------------- evidence */}
      {evidence.length ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading icon={Search} tone="info">
            Evidence
          </SectionHeading>
          <div className="space-y-3">
            {evidence.map((ev, i) => (
              <div key={i} className="rounded-md border border-border bg-muted/30 p-3">
                {ev.summary ? (
                  /* UNTRUSTED — plain text. */
                  <p className="whitespace-pre-wrap text-sm text-foreground/90">{ev.summary}</p>
                ) : null}
                {ev.query ? (
                  <CodeBlock
                    value={ev.query}
                    wrap
                    copyable
                    maxHeightClassName="max-h-40"
                    className="mt-2"
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!anySection ? (
        <p className="text-xs text-muted-foreground">
          Threat context is enabled but produced no sections for this case.
        </p>
      ) : null}
    </div>
  );
};

/* ================================================= Collaboration thread (#4) == */

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

/**
 * The full collaboration surface for a case (#4): the thread (AI is a first-class
 * author), an assignee picker, a task checklist, and the activity feed — all over the
 * Round-3 collaboration endpoints. Writes are gated by `canComment` / `canWrite`
 * (the caller passes the resolved RBAC booleans). #3-safe: nothing here changes the
 * case decision.
 */
const CollaborationThreadTab: React.FC<{
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
}) => {
  return (
    <div className="grid gap-6 p-6 lg:grid-cols-[1fr_20rem]">
      {/* -------------------------------------------------- main: the thread */}
      <div className="min-w-0 space-y-5">
        <div className="rounded-lg border border-border bg-card p-6">
          <SectionHeading
            icon={MessageSquare}
            tone="info"
            actions={
              thread && thread.length ? (
                <Badge variant="info">
                  {thread.length} message{thread.length === 1 ? '' : 's'}
                </Badge>
              ) : undefined
            }
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
            />
          )}
        </div>
      </div>

      {/* -------------------------------------------------- aside: ownership */}
      <aside className="space-y-6">
        <div className="rounded-lg border border-border bg-card p-5">
          <SectionHeading icon={Users} tone="info">
            Ownership
          </SectionHeading>
          <Label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">
            Assignee
          </Label>
          <AssigneePicker c={c} users={users} canWrite={canWrite} onAssigned={onAssigned} />
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <CaseTasks
            tasks={tasks || []}
            canWrite={canWrite}
            busyId={tasksBusyId}
            onAdd={onAddTask}
            onStatus={onTaskStatus}
            onLog={onTaskLog}
          />
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <SectionHeading icon={History} tone="info">
            Activity
          </SectionHeading>
          <CaseActivityFeed items={activity || []} loading={activityLoading && activity === null} />
        </div>
      </aside>
    </div>
  );
};

/* ============================================================ Collaboration == */

const ASSESSMENTS: Array<{
  key: 'agree' | 'partial' | 'disagree';
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: ScoreTone;
}> = [
  { key: 'agree', label: 'Agree', icon: CheckCircle2, tone: 'low' },
  { key: 'partial', label: 'Partially', icon: Info, tone: 'medium' },
  { key: 'disagree', label: 'Disagree', icon: X, tone: 'critical' },
];

const OUTCOME_OPTIONS: Array<{ value: string; text: string }> = [
  { value: 'true_positive', text: 'True positive' },
  { value: 'false_positive', text: 'False positive' },
  { value: 'true_negative', text: 'True negative' },
  { value: 'false_negative', text: 'False negative' },
];

function assessmentMeta(key?: string) {
  return ASSESSMENTS.find((a) => a.key === key);
}

const StarRating: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
}> = ({ label, value, onChange }) => (
  <div className="flex items-center gap-3">
    <span className="flex-1 text-sm text-foreground">{label}</span>
    <div className="flex items-center">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${label}: ${n} of 5`}
          className="rounded p-0.5 focus:outline-none focus:ring-2 focus:ring-ring"
          onClick={() => onChange(n === value ? 0 : n)}
        >
          <Star
            className={cn(
              'h-4 w-4',
              n <= value ? 'fill-warning text-warning' : 'text-muted-foreground',
            )}
          />
        </button>
      ))}
    </div>
    <span className="w-8 text-right text-xs text-muted-foreground">
      {value ? `${value}/5` : DASH}
    </span>
  </div>
);

function starsToScore(n: number): number | undefined {
  if (!n || n < 1) return undefined;
  return Math.max(0, Math.min(1, n / 5));
}

/** One comment in the thread — avatar + author + time over a body card. UNTRUSTED. */
const CommentRow: React.FC<{ author?: string; ts?: string; body?: string }> = ({
  author,
  ts,
  body,
}) => {
  const name = (author || '').trim() || 'Analyst';
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');
  return (
    <div className="flex items-start gap-3">
      <Avatar className="h-8 w-8">
        <AvatarFallback>{initials || 'A'}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 rounded-lg border border-border bg-card p-3">
        <div className="flex items-baseline justify-between gap-2">
          {/* UNTRUSTED — plain text. */}
          <span className="truncate text-sm font-semibold text-foreground">{name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {ts ? humanizeAge(ts) : DASH}
          </span>
        </div>
        {/* UNTRUSTED — plain text, preserve newlines. */}
        <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/90">{body || DASH}</p>
      </div>
    </div>
  );
};

const CollaborationTab: React.FC<{
  c: Case;
  onUpdated: (next: Case) => void;
}> = ({ c, onUpdated }) => {
  const caseId = c.case_id;

  /* ------------------------------------------------ AI-decision grading */
  const [assessment, setAssessment] = React.useState<'agree' | 'partial' | 'disagree'>('agree');
  const [accuracy, setAccuracy] = React.useState(0);
  const [reasoning, setReasoning] = React.useState(0);
  const [appropriateness, setAppropriateness] = React.useState(0);
  const [outcome, setOutcome] = React.useState('');
  const [timeSaved, setTimeSaved] = React.useState(0);
  const [fbAnalyst, setFbAnalyst] = React.useState('');
  const [fbComment, setFbComment] = React.useState('');
  const [submittingFb, setSubmittingFb] = React.useState(false);
  const [fbError, setFbError] = React.useState<unknown>(null);

  const submitFeedback = React.useCallback(async () => {
    setSubmittingFb(true);
    setFbError(null);
    try {
      const body: CaseFeedbackInput = { assessment };
      const a = starsToScore(accuracy);
      const r = starsToScore(reasoning);
      const ap = starsToScore(appropriateness);
      if (a !== undefined) body.accuracy = a;
      if (r !== undefined) body.reasoning_quality = r;
      if (ap !== undefined) body.action_appropriateness = ap;
      if (outcome) body.actual_outcome = outcome;
      if (timeSaved > 0) body.time_saved_minutes = timeSaved;
      if (fbAnalyst.trim()) body.analyst = fbAnalyst.trim();
      if (fbComment.trim()) body.comment = fbComment.trim();
      const next = await api.caseFeedback(caseId, body);
      onUpdated(next);
      setAccuracy(0);
      setReasoning(0);
      setAppropriateness(0);
      setOutcome('');
      setTimeSaved(0);
      setFbComment('');
    } catch (e) {
      setFbError(e);
    } finally {
      setSubmittingFb(false);
    }
  }, [
    assessment,
    accuracy,
    reasoning,
    appropriateness,
    outcome,
    timeSaved,
    fbAnalyst,
    fbComment,
    caseId,
    onUpdated,
  ]);

  const priorFeedback = React.useMemo(
    () => [...(c.feedback || [])].sort((x, y) => tsValue(y.ts) - tsValue(x.ts)),
    [c.feedback],
  );

  /* ------------------------------------------------------------ comments */
  const [commentAuthor, setCommentAuthor] = React.useState('');
  const [commentBody, setCommentBody] = React.useState('');
  const [submittingComment, setSubmittingComment] = React.useState(false);
  const [commentError, setCommentError] = React.useState<unknown>(null);

  const submitComment = React.useCallback(async () => {
    const body = commentBody.trim();
    if (!body) return;
    setSubmittingComment(true);
    setCommentError(null);
    try {
      const next = await api.caseComment(caseId, {
        author: commentAuthor.trim() || undefined,
        body,
      });
      onUpdated(next);
      setCommentBody('');
    } catch (e) {
      setCommentError(e);
    } finally {
      setSubmittingComment(false);
    }
  }, [commentBody, commentAuthor, caseId, onUpdated]);

  const comments = React.useMemo(
    () => [...(c.comments || [])].sort((x, y) => tsValue(x.ts) - tsValue(y.ts)),
    [c.comments],
  );

  /* ---------------------------------------------------------------- tags */
  const [tags, setTags] = React.useState<string[]>(c.tags || []);
  const [tagDraft, setTagDraft] = React.useState('');
  const [savingTags, setSavingTags] = React.useState(false);
  const [tagsError, setTagsError] = React.useState<unknown>(null);

  React.useEffect(() => {
    setTags(c.tags || []);
  }, [c.tags]);

  const persistTags = React.useCallback(
    async (next: string[]) => {
      const clean = Array.from(new Set(next.map((t) => t.trim()).filter(Boolean)));
      setTags(clean);
      setSavingTags(true);
      setTagsError(null);
      try {
        const updated = await api.caseTags(caseId, clean);
        onUpdated(updated);
      } catch (e) {
        setTagsError(e);
      } finally {
        setSavingTags(false);
      }
    },
    [caseId, onUpdated],
  );

  /* ------------------------------------------------------------ assignee */
  const [assignee, setAssignee] = React.useState(c.assignee || '');
  const [savingAssignee, setSavingAssignee] = React.useState(false);
  const [assigneeError, setAssigneeError] = React.useState<unknown>(null);

  React.useEffect(() => {
    setAssignee(c.assignee || '');
  }, [c.assignee]);

  const saveAssignee = React.useCallback(async () => {
    setSavingAssignee(true);
    setAssigneeError(null);
    try {
      const next = await api.caseAssign(caseId, assignee.trim());
      onUpdated(next);
    } catch (e) {
      setAssigneeError(e);
    } finally {
      setSavingAssignee(false);
    }
  }, [caseId, assignee, onUpdated]);

  const assigneeDirty = assignee.trim() !== (c.assignee || '').trim();

  const gradingDirty =
    accuracy > 0 ||
    reasoning > 0 ||
    appropriateness > 0 ||
    !!outcome ||
    timeSaved > 0 ||
    !!fbComment.trim();

  return (
    <div className="space-y-7 p-6">
      {/* ------------------------------------------- ownership */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading icon={Users} tone="info">
          Ownership
        </SectionHeading>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Owning analyst
            </Label>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Unassigned — type to assign…"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && assigneeDirty) void saveAssignee();
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!assigneeDirty || savingAssignee}
                onClick={() => void saveAssignee()}
              >
                {savingAssignee ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </Button>
            </div>
            {assigneeError ? (
              <p className="text-xs text-critical">Could not save assignee.</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Tags {savingTags ? <span className="text-muted-foreground">· saving…</span> : null}
            </Label>
            <TagInput
              tags={tags}
              draft={tagDraft}
              onDraftChange={setTagDraft}
              onTagsChange={(next) => void persistTags(next)}
            />
            <p className="text-xs text-muted-foreground">
              {tagsError
                ? 'Could not save tags.'
                : 'Press enter to add a tag · click ✕ to remove. Saved automatically.'}
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------------------- AI-decision feedback */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading
          icon={Brain}
          tone="medium"
          actions={
            priorFeedback.length ? (
              <Badge variant="medium">
                {priorFeedback.length} grading{priorFeedback.length === 1 ? '' : 's'}
              </Badge>
            ) : undefined
          }
        >
          Rate the AI decision
        </SectionHeading>
        <p className="mb-4 text-xs text-muted-foreground">
          Calibrate the agent: do you agree with the verdict, and how good were the reasoning
          and recommended action?
        </p>

        <div className="grid grid-cols-3 gap-2">
          {ASSESSMENTS.map((a) => {
            const Icon = a.icon;
            const active = assessment === a.key;
            return (
              <button
                key={a.key}
                type="button"
                aria-pressed={active}
                onClick={() => setAssessment(a.key)}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-ring',
                  active
                    ? TONE_BORDER[a.tone] + ' ' + TONE_TEXT[a.tone]
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                <Icon className="h-4 w-4" />
                {a.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 rounded-md border border-border bg-muted/30 p-4">
          <div className="mb-3 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Quality (optional)
          </div>
          <div className="space-y-2">
            <StarRating label="Accuracy" value={accuracy} onChange={setAccuracy} />
            <StarRating label="Reasoning quality" value={reasoning} onChange={setReasoning} />
            <StarRating
              label="Action appropriateness"
              value={appropriateness}
              onChange={setAppropriateness}
            />
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Actual outcome</Label>
            <Select
              value={outcome || '__unknown__'}
              onValueChange={(v) => setOutcome(v === '__unknown__' ? '' : v)}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Unknown" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unknown__">Unknown</SelectItem>
                {OUTCOME_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Analyst id (optional)</Label>
            <Input
              placeholder="e.g. jdoe"
              value={fbAnalyst}
              onChange={(e) => setFbAnalyst(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 space-y-1.5">
          <Label className="text-xs">Analyst time saved: {timeSaved} min</Label>
          <Slider
            min={0}
            max={120}
            step={5}
            value={[timeSaved]}
            onValueChange={(v) => setTimeSaved(v[0] ?? 0)}
          />
        </div>

        <div className="mt-4 space-y-1.5">
          <Label className="text-xs">Comment (optional)</Label>
          <Textarea
            rows={2}
            placeholder="Anything the agent missed or got right?"
            value={fbComment}
            onChange={(e) => setFbComment(e.target.value)}
          />
        </div>

        {fbError ? (
          <Alert variant="destructive" className="mt-4">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not submit feedback</AlertTitle>
          </Alert>
        ) : null}

        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            disabled={submittingFb || !gradingDirty}
            onClick={() => void submitFeedback()}
          >
            {submittingFb ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Submit grading
          </Button>
        </div>

        {priorFeedback.length ? (
          <>
            <Separator className="my-4" />
            <div className="mb-3 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
              Previous gradings
            </div>
            <div className="space-y-2">
              {priorFeedback.map((f, i) => {
                const meta = assessmentMeta(f.assessment);
                const Icon = meta?.icon;
                return (
                  <div key={i} className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={meta ? (meta.tone === 'low' ? 'success' : meta.tone) : 'outline'} className="gap-1">
                        {Icon ? <Icon className="h-3 w-3" /> : null}
                        {meta?.label || humanizeToken(f.assessment) || 'Graded'}
                      </Badge>
                      {f.actual_outcome ? (
                        <Badge variant="outline">{humanizeToken(f.actual_outcome)}</Badge>
                      ) : null}
                      {typeof f.time_saved_minutes === 'number' && f.time_saved_minutes > 0 ? (
                        <Badge variant="outline" className="gap-1">
                          <Clock className="h-3 w-3" />
                          {f.time_saved_minutes} min saved
                        </Badge>
                      ) : null}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {f.analyst ? `${f.analyst} · ` : ''}
                        {f.ts ? humanizeAge(f.ts) : DASH}
                      </span>
                    </div>
                    {f.comment ? (
                      /* UNTRUSTED — plain text. */
                      <p className="mt-2 whitespace-pre-wrap text-xs text-foreground/90">
                        {f.comment}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>

      {/* ------------------------------------------- comment thread */}
      <div className="rounded-lg border border-border bg-card p-6">
        <SectionHeading
          icon={MessageSquare}
          tone="info"
          actions={
            comments.length ? (
              <Badge variant="info">
                {comments.length} note{comments.length === 1 ? '' : 's'}
              </Badge>
            ) : undefined
          }
        >
          Notes
        </SectionHeading>
        {comments.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            compact
            title="No notes yet"
            description="Leave a hand-off note for the next analyst on this case."
          />
        ) : (
          <div className="space-y-3">
            {comments.map((cm, i) => (
              <CommentRow key={i} author={cm.author} ts={cm.ts} body={cm.body} />
            ))}
          </div>
        )}

        {/* composer */}
        <div className="mt-4 rounded-md border border-border bg-muted/30 p-4">
          <Input
            className="mb-2"
            placeholder="Your name (optional)"
            value={commentAuthor}
            onChange={(e) => setCommentAuthor(e.target.value)}
          />
          <Textarea
            rows={3}
            placeholder="Share context, findings, or a hand-off note…"
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
          />
          {commentError ? (
            <Alert variant="destructive" className="mt-2">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Could not post comment</AlertTitle>
            </Alert>
          ) : null}
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              disabled={submittingComment || !commentBody.trim()}
              onClick={() => void submitComment()}
            >
              {submittingComment ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <MessageSquare className="h-4 w-4" />
              )}
              Add note
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* =================================================================== Chat == */

/**
 * Lightweight per-case chat. The full ChatPanel lives on the Chat page; here we
 * offer a focused composer + transcript scoped to this case (`api.chat` with the
 * case id), plus a deep-link to the full Chat surface. UNTRUSTED-safe rendering.
 */
const ChatTab: React.FC<{
  c: Case;
  onNavigate?: Navigate;
  onClose: () => void;
}> = ({ c, onNavigate, onClose }) => {
  const [history, setHistory] = React.useState<Array<{ role: 'user' | 'assistant'; content: string }>>(
    [],
  );
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [err, setErr] = React.useState<unknown>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const starters = [
    'Summarize this case',
    'Why was this flagged?',
    'What should I check next?',
    'Is this a known false positive?',
  ];

  const send = React.useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending) return;
      setErr(null);
      const nextHistory = [...history, { role: 'user' as const, content: message }];
      setHistory(nextHistory);
      setDraft('');
      setSending(true);
      try {
        const res = await api.chat(message, history, c.case_id);
        setHistory([...nextHistory, { role: 'assistant', content: res.answer || '' }]);
      } catch (e) {
        setErr(e);
      } finally {
        setSending(false);
      }
    },
    [history, sending, c.case_id],
  );

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, sending]);

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <SectionHeading icon={MessageSquare} tone="info">
          Ask about this case
        </SectionHeading>
        {onNavigate ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onClose();
              onNavigate('chat', { caseId: c.case_id });
            }}
          >
            <MessageSquare className="h-4 w-4" /> Open full chat
          </Button>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="min-h-[16rem] flex-1 space-y-3 overflow-y-auto rounded-lg border border-border bg-muted/20 p-4"
      >
        {history.length === 0 ? (
          <div className="flex flex-wrap gap-2">
            {starters.map((s) => (
              <Button key={s} size="sm" variant="outline" onClick={() => void send(s)}>
                {s}
              </Button>
            ))}
          </div>
        ) : (
          history.map((m, i) => (
            <div
              key={i}
              className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-lg px-3 py-2 text-sm',
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border bg-card text-foreground',
                )}
              >
                {/* UNTRUSTED — plain text, preserve newlines. */}
                <p className="whitespace-pre-wrap break-words">{m.content}</p>
              </div>
            </div>
          ))
        )}
        {sending ? (
          <div className="flex justify-start">
            <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              <RefreshCw className="inline h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          </div>
        ) : null}
      </div>

      {err ? (
        <Alert variant="destructive" className="mt-3">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not reach the assistant</AlertTitle>
        </Alert>
      ) : null}

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <Textarea
          rows={2}
          className="flex-1 resize-none"
          placeholder="Ask about this case…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <Button type="submit" disabled={sending || !draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
};
