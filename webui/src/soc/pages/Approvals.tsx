/**
 * Approvals — the human-in-the-loop queue for agent-drafted proposals.
 *
 * When the agent confirms a false positive (or otherwise learns something
 * durable) it does NOT change anything itself. It DRAFTS a recommendation — a
 * candidate suppression rule, or a durable memory fact — and parks it here for a
 * human to approve. Approving is the ONLY action that makes a suppression rule
 * live or saves a memory; nothing on this page is applied automatically. The
 * deterministic, operator-controlled spine stays intact: the agent recommends,
 * the human decides. Approve is privileged and enforced server-side; we surface
 * a 403 (and 404/409) inline rather than guessing the user's role.
 *
 * UNTRUSTED-safe: a proposal's `payload` (field / value / text) and `rationale`
 * derive from log events, so they render as plain text / <CodeBlock> /
 * <InlineCode> — never as markup.
 */
import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Flag,
  FolderClosed,
  Gauge,
  Info,
  Layers,
  Link2,
  Lock,
  MemoryStick,
  RefreshCw,
  ShieldOff,
  X,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import type {
  MemoryPayload,
  Proposal,
  SuppressionPayload,
} from '@/lib/types';
import {
  DASH,
  fmtNumber,
  fmtPercent,
  formatTimestamp,
  humanizeAge,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';
import { toast } from 'sonner';

import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Checkbox } from '@/ui/checkbox';
import { Switch } from '@/ui/switch';
import { Skeleton } from '@/ui/skeleton';
import { Separator } from '@/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { InlineCode } from '@/soc/components/CodeBlock';
import type { Navigate } from '@/soc/router';
import type { LucideIcon } from 'lucide-react';

/* ----------------------------------------------------------------- helpers -- */

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

type KindBand = 'suppression' | 'memory' | 'other';

interface KindMeta {
  label: string;
  icon: LucideIcon;
  /** Badge variant for the kind chip. */
  variant: 'warning' | 'info' | 'secondary';
}

function kindBand(kind?: string): KindBand {
  const t = (kind || '').toLowerCase();
  if (t === 'suppression') return 'suppression';
  if (t === 'memory') return 'memory';
  return 'other';
}

function kindMeta(kind?: string): KindMeta {
  switch (kindBand(kind)) {
    case 'suppression':
      return { label: 'Suppression', icon: ShieldOff, variant: 'warning' };
    case 'memory':
      return { label: 'Memory', icon: MemoryStick, variant: 'info' };
    default:
      return { label: kind ? humanizeToken(kind) : 'Proposal', icon: Flag, variant: 'secondary' };
  }
}

/** A stable "source / rule" group label for a proposal (UNTRUSTED-safe plain text). */
function groupKeyOf(p: Proposal): string {
  if (kindBand(p.kind) === 'suppression') {
    const sup = (p.payload || {}) as SuppressionPayload;
    if (sup.field) return `${asText(sup.field)} == ${asText(sup.value) || '∗'}`;
  }
  if (kindBand(p.kind) === 'memory') {
    const mem = (p.payload || {}) as MemoryPayload;
    if (mem.category) return humanizeToken(asText(mem.category));
  }
  return kindMeta(p.kind).label;
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'Approving requires admin access — you are not authorised.';
    if (e.status === 404) return 'This proposal no longer exists (it may have been decided already).';
    if (e.status === 409) return 'This proposal was already decided. Refresh to see its current state.';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Action failed.';
}

/* ------------------------------------------------------------ small badges -- */

function ConfidencePill({ confidence }: { confidence?: number }) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  const variant: 'success' | 'warning' | 'low' =
    pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'low';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant}>
          <Gauge className="h-3 w-3" aria-hidden />
          {fmtPercent(confidence)} conf
        </Badge>
      </TooltipTrigger>
      <TooltipContent>The agent&apos;s confidence in this recommendation</TooltipContent>
    </Tooltip>
  );
}

function KindBadge({ kind }: { kind?: string }) {
  const meta = kindMeta(kind);
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

/* ------------------------------------------------------------ proposal card -- */

interface ProposalCardProps {
  proposal: Proposal;
  busy: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onApprove: (p: Proposal) => void;
  onReject: (p: Proposal) => void;
  onOpenCase?: (caseId: string) => void;
}

function ProposalCard({
  proposal,
  busy,
  selected,
  onToggleSelect,
  onApprove,
  onReject,
  onOpenCase,
}: ProposalCardProps) {
  const band = kindBand(proposal.kind);
  const sup = (proposal.payload || {}) as SuppressionPayload;
  const mem = (proposal.payload || {}) as MemoryPayload;
  const cases = proposal.source_case_ids || [];
  const decided = (proposal.status || '').toLowerCase() !== 'pending';

  const accentClass =
    band === 'suppression'
      ? 'before:bg-warning'
      : band === 'memory'
      ? 'before:bg-info'
      : 'before:bg-primary';

  const approveTip =
    band === 'suppression'
      ? 'Approving makes this suppression rule LIVE. Privileged action — the server enforces admin access.'
      : 'Approving saves this as a durable memory the agents will know. Privileged action — the server enforces admin access.';

  return (
    <Card
      className={cn(
        'relative overflow-hidden p-5 transition-shadow hover:shadow-elev2',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[""]',
        accentClass,
        selected && 'ring-1 ring-primary',
      )}
    >
      {/* header row */}
      <div className="flex flex-wrap items-center gap-2 pl-3">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(proposal.id)}
          aria-label="Select this proposal for a bulk action"
          disabled={busy}
        />
        <KindBadge kind={proposal.kind} />
        <ConfidencePill confidence={proposal.confidence} />
        {decided ? (
          <Badge variant={proposal.status?.toLowerCase() === 'approved' ? 'success' : 'secondary'}>
            {humanizeToken(proposal.status)}
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground" title={formatTimestamp(proposal.created_at)}>
          drafted {humanizeAge(proposal.created_at)}
          {proposal.created_by ? ` · by ${proposal.created_by}` : ''}
        </span>
        {proposal.expires_at ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline">
                <Clock className="h-3 w-3" aria-hidden />
                expires {humanizeAge(proposal.expires_at)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Expires {formatTimestamp(proposal.expires_at)}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {/* the candidate rule / fact (UNTRUSTED → InlineCode / plain text) */}
      <div className="mt-5 pl-3">
        {band === 'suppression' ? (
          <div>
            <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Candidate suppression rule
            </div>
            <div className="mt-1.5">
              <InlineCode>
                {asText(sup.field) || '(field)'} == {asText(sup.value) || '(value)'}
              </InlineCode>
            </div>
            {sup.reason ? (
              <p className="mt-2.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                <span className="text-muted-foreground">Reason: </span>
                {asText(sup.reason)}
              </p>
            ) : null}
          </div>
        ) : band === 'memory' ? (
          <div>
            <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Candidate memory
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {asText(mem.text)}
            </p>
            {mem.category ? (
              <Badge variant="outline" className="mt-2.5">
                <FolderClosed className="h-3 w-3" aria-hidden />
                {humanizeToken(asText(mem.category))}
              </Badge>
            ) : null}
          </div>
        ) : (
          // Unknown kind: render the payload defensively as plain text so we never
          // drop a proposal (and never inject markup).
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {asText(proposal.payload)}
          </p>
        )}
      </div>

      {/* rationale (UNTRUSTED → plain text) */}
      {proposal.rationale ? (
        <div className="mt-5 pl-3">
          <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Why the agent drafted this
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {asText(proposal.rationale)}
          </p>
        </div>
      ) : null}

      {/* linked source case(s) */}
      {cases.length ? (
        <div className="mt-5 flex flex-wrap items-center gap-2 pl-3">
          <span className="text-xs text-muted-foreground">
            Source {cases.length === 1 ? 'case' : 'cases'}:
          </span>
          {cases.map((cid) =>
            onOpenCase ? (
              <button
                key={cid}
                type="button"
                onClick={() => onOpenCase(cid)}
                className="rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open case ${cid}`}
              >
                <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                  <Link2 className="h-3 w-3" aria-hidden />
                  {cid}
                </Badge>
              </button>
            ) : (
              <Badge variant="outline" key={cid}>
                <Link2 className="h-3 w-3" aria-hidden />
                {cid}
              </Badge>
            ),
          )}
        </div>
      ) : null}

      <Separator className="my-5" />

      {/* actions */}
      <div className="flex flex-wrap items-center justify-end gap-2 pl-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground"
              tabIndex={0}
              aria-label="Approve requires admin"
            >
              <Lock className="h-4 w-4" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{approveTip}</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          className="text-critical hover:bg-critical/10 hover:text-critical"
          onClick={() => onReject(proposal)}
          disabled={busy || decided}
        >
          <X className="h-4 w-4" aria-hidden />
          Reject
        </Button>
        <Button size="sm" onClick={() => onApprove(proposal)} disabled={busy || decided}>
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          {busy ? 'Working…' : 'Approve'}
        </Button>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------- page -- */

type StatusFilter = 'pending' | 'all';

export interface ApprovalsProps {
  onNavigate?: Navigate;
}

export default function Approvals({ onNavigate }: ApprovalsProps) {
  const [proposals, setProposals] = React.useState<Proposal[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('pending');
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);

  const openCase = React.useCallback(
    (caseId: string) => onNavigate?.('cases', { caseId }),
    [onNavigate],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listProposals(statusFilter === 'all' ? undefined : 'pending');
      setProposals(res.proposals ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // The count badge tracks pending proposals regardless of the active filter.
  const pendingCount = React.useMemo(
    () => proposals.filter((p) => (p.status || '').toLowerCase() === 'pending').length,
    [proposals],
  );

  const removeLocal = React.useCallback((id: string) => {
    setProposals((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const upsertLocal = React.useCallback((next: Proposal) => {
    setProposals((prev) => {
      const i = prev.findIndex((p) => p.id === next.id);
      if (i === -1) return prev;
      const copy = prev.slice();
      copy[i] = next;
      return copy;
    });
  }, []);

  // Keep selection in sync with the currently-loaded proposals.
  React.useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(proposals.map((p) => p.id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (ids.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [proposals]);

  const toggleSelect = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = React.useCallback(() => setSelected(new Set()), []);

  /** Apply a backend decision result to local state. */
  const applyDecision = React.useCallback(
    (p: Proposal, kind: 'approve' | 'reject', updated: Proposal | unknown) => {
      if (statusFilter === 'pending') {
        removeLocal(p.id);
      } else if (updated && typeof updated === 'object' && (updated as Proposal).id) {
        upsertLocal(updated as Proposal);
      } else {
        upsertLocal({ ...p, status: kind === 'approve' ? 'approved' : 'rejected' });
      }
    },
    [statusFilter, removeLocal, upsertLocal],
  );

  const decide = React.useCallback(
    async (proposal: Proposal, kind: 'approve' | 'reject') => {
      if (busyId) return;
      setBusyId(proposal.id);
      setActionError(null);
      try {
        const updated =
          kind === 'approve'
            ? await api.approveProposal(proposal.id)
            : await api.rejectProposal(proposal.id);
        applyDecision(proposal, kind, updated);
        const meta = kindMeta(proposal.kind);
        if (kind === 'approve') toast.success(`${meta.label} approved — it is now live.`);
        else toast.success(`${meta.label} proposal rejected.`);
      } catch (e) {
        const message = describeError(e);
        setActionError(message);
        toast.error(message);
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) void load();
      } finally {
        setBusyId(null);
      }
    },
    [busyId, applyDecision, load],
  );

  // Decide every selected proposal sequentially — each call is still individually
  // guarded server-side; nothing here bypasses the per-proposal approval.
  const decideSelected = React.useCallback(
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
          applyDecision(p, kind, updated);
          ok += 1;
        } catch (e) {
          failed += 1;
          setActionError(describeError(e));
        }
      }
      clearSelection();
      setBulkBusy(false);
      const verb = kind === 'approve' ? 'approved' : 'rejected';
      if (ok) {
        const msg = `${ok} proposal${ok === 1 ? '' : 's'} ${verb}${failed ? ` · ${failed} failed` : ''}.`;
        if (failed) toast.warning(msg);
        else toast.success(msg);
      } else if (failed) {
        toast.error(`All ${failed} action${failed === 1 ? '' : 's'} failed.`);
      }
      if (failed) void load();
    },
    [proposals, selected, bulkBusy, applyDecision, clearSelection, load],
  );

  // Group the visible proposals by source/rule when group-by is on.
  const groups = React.useMemo(() => {
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
      busy={busyId === p.id || bulkBusy}
      selected={selected.has(p.id)}
      onToggleSelect={toggleSelect}
      onApprove={(pr) => void decide(pr, 'approve')}
      onReject={(pr) => void decide(pr, 'reject')}
      onOpenCase={onNavigate ? openCase : undefined}
    />
  );

  /* ---- filter / refresh toolbar ---- */
  const headerActions = (
    <>
      {pendingCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="warning">
              <Flag className="h-3 w-3" aria-hidden />
              {fmtNumber(pendingCount)} pending
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Pending proposals awaiting a decision</TooltipContent>
        </Tooltip>
      ) : null}
      <SegmentedControl<StatusFilter>
        aria-label="Filter by status"
        size="sm"
        value={statusFilter}
        onValueChange={setStatusFilter}
        options={[
          { value: 'pending', label: 'Pending' },
          { value: 'all', label: 'All' },
        ]}
      />
      <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
        <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
        Refresh
      </Button>
    </>
  );

  /* ---- body ---- */
  let body: React.ReactNode;
  if (error) {
    body = (
      <Alert variant="destructive">
        <AlertTriangle aria-hidden />
        <AlertTitle>Could not load proposals</AlertTitle>
        <AlertDescription>{describeError(error)}</AlertDescription>
      </Alert>
    );
  } else if (loading && proposals.length === 0) {
    body = (
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="flex flex-col gap-3 p-5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-8 w-40 self-end" />
          </Card>
        ))}
      </div>
    );
  } else if (proposals.length === 0) {
    body = (
      <EmptyState
        icon={Flag}
        title={statusFilter === 'pending' ? 'No pending proposals' : 'No proposals yet'}
        description={
          statusFilter === 'pending'
            ? 'The agent drafts these when you confirm a false positive — there is nothing awaiting a decision right now.'
            : 'No proposals have been drafted yet. The agent drafts these when it confirms a false positive or learns a durable fact.'
        }
      />
    );
  } else if (groups) {
    body = (
      <div className="flex flex-col gap-8">
        {groups.map(([label, rows]) => (
          <div key={label}>
            <div className="mb-3 flex items-center gap-2">
              <Badge variant="info">
                <Layers className="h-3 w-3" aria-hidden />
                {label}
              </Badge>
              <span className="text-xs tabular-nums text-muted-foreground">
                {fmtNumber(rows.length)} proposal{rows.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex flex-col gap-4">{rows.map(renderCard)}</div>
          </div>
        ))}
      </div>
    );
  } else {
    body = <div className="flex flex-col gap-4">{proposals.map(renderCard)}</div>;
  }

  return (
    <div className="animate-fade-in space-y-8">
      <PageHeader
        icon={Flag}
        eyebrow="Automation"
        title="Approvals"
        description="Agent-drafted recommendations awaiting human approval — suppression rules and durable memories."
        actions={headerActions}
      />

      <Alert>
        <Info aria-hidden />
        <AlertTitle>Nothing here is applied automatically</AlertTitle>
        <AlertDescription>
          <p className="leading-relaxed">
            These are <strong>AI-drafted recommendations</strong>. Approving is the only thing that
            makes a rule live or saves a memory — nothing here is applied automatically. The agent
            recommends; you decide. Approving is a <strong>privileged action</strong> (the server
            enforces admin access), and the deterministic close/escalate logic is never changed by
            what you approve here.
          </p>
        </AlertDescription>
      </Alert>

      {/* section header + group toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            {statusFilter === 'pending' ? 'Pending proposals' : 'All proposals'}
          </h2>
          <span className="text-sm tabular-nums text-muted-foreground">
            {loading ? 'Loading…' : `${fmtNumber(proposals.length)} shown`}
          </span>
        </div>
        {proposals.length > 0 ? (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={groupBy} onCheckedChange={setGroupBy} aria-label="Group by source or rule" />
            Group by source / rule
          </label>
        ) : null}
      </div>

      {/* sticky bulk-action bar */}
      {selected.size > 0 ? (
        <div className="sticky top-2 z-10">
          <Card className="flex flex-wrap items-center gap-2 border-primary/30 bg-surface p-3 shadow-elev2">
            <span className="text-sm font-medium text-foreground">
              <span className="tabular-nums">{fmtNumber(selected.size)}</span> selected
            </span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={clearSelection} disabled={bulkBusy}>
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-critical hover:bg-critical/10 hover:text-critical"
              onClick={() => void decideSelected('reject')}
              disabled={bulkBusy}
            >
              <X className="h-4 w-4" aria-hidden />
              Reject selected
            </Button>
            <Button size="sm" onClick={() => void decideSelected('approve')} disabled={bulkBusy}>
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              {bulkBusy ? 'Working…' : 'Approve selected'}
            </Button>
          </Card>
        </div>
      ) : null}

      {actionError ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>Could not complete that action</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {body}

      <Separator />
      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        A suppression rule only suppresses future matching alerts once approved; a memory is only
        saved once approved. Rejected proposals are discarded. Proposal fields, values and rationale
        derive from log events and are rendered as plain text. {DASH}
      </p>
    </div>
  );
}
