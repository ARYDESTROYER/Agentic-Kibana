/**
 * Catalog — "Playbooks & Agents".
 *
 * A catalog of the two declarative knowledge surfaces the triage spine
 * uses:
 *   - Agent personas (`GET /api/personas`): the specialist the router can
 *     specialise the single investigator into, with its focus tools + trigger
 *     keywords.
 *   - Playbooks (`GET /api/playbooks`): the plain-text runbooks, with their match
 *     criteria, suggested tools and the RAG queries they inject.
 *
 * Personas are reference-only. Playbooks expose a permission-gated operator
 * workflow: browse/open every procedure, and create/edit operator-owned Markdown;
 * packaged reference procedures remain protected.
 *
 * SECURITY: persona/playbook fields (labels, descriptions, keywords, rule ids,
 * MITRE ids, tags, tool names, RAG queries) are backend-config-derived and are
 * rendered as PLAIN text / <Badge> children / <CodeBlock> only — never via
 * dangerouslySetInnerHTML.
 */
import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  Bug,
  CheckCircle2,
  Crosshair,
  Database,
  FileText,
  Globe,
  Hash,
  Key,
  Library,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Package,
  Save,
  ScrollText,
  Search,
  Tag,
  TestTube2,
  User,
  Users,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import type {
  AgentPersona,
  EntityTypeFull,
  Playbook,
  PlaybookCoverageResponse,
  PlaybookDetail,
  PlaybookDryRunResponse,
  PlaybookMatch,
  SchedulerHealthResponse,
} from '@/lib/types';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { formatTimestamp, humanizeToken } from '@/lib/format';

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { Stagger } from '@/soc/components/Stagger';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { useCan } from '@/soc/components/Can';
import { LoadingState } from '@/design-system';

import { Card, CardContent, CardHeader } from '@/ui/card';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Progress } from '@/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Textarea } from '@/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

/** Max badges shown inline before collapsing the remainder into a "+N" pill. */
const BADGE_CAP = 8;

/* ------------------------------------------------------------- persona style -- */

/**
 * Semantic icon per known specialist persona, so the catalog reads like one
 * glyph per specialty. Unknown persona ids fall back to a stable default.
 */
const PERSONA_ICON: Record<string, LucideIcon> = {
  identity_access: Key,
  web_application: Globe,
  network_recon: Crosshair,
  malware: Bug,
  threat_intel: Search,
  generalist: Users,
};

function personaIcon(id: string): LucideIcon {
  return PERSONA_ICON[id] ?? Users;
}

/* ------------------------------------------------------------------ badges --- */

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'info'
  | 'success'
  | 'warning'
  | 'critical'
  | 'low';

/**
 * A labelled, capped row of badges. UNTRUSTED values render as plain <Badge>
 * children. Overflow collapses into a "+N" pill with a tooltip of the rest.
 */
const BadgeRow: React.FC<{
  label: string;
  values?: (string | number)[];
  variant?: BadgeVariant;
  icon?: LucideIcon;
  empty?: string;
  cap?: number;
}> = ({ label, values, variant = 'outline', icon: Icon, empty, cap = BADGE_CAP }) => {
  const items = (values ?? []).map((v) => String(v)).filter(Boolean);
  if (!items.length && !empty) return null;
  const shown = items.slice(0, cap);
  const overflow = items.slice(cap);

  return (
    <div className="mt-4">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {items.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {shown.map((v, i) => (
            <Badge key={`${v}-${i}`} variant={variant} className="max-w-full">
              {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
              <span className="truncate">{v}</span>
            </Badge>
          ))}
          {overflow.length ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" tabIndex={0} className="cursor-default">
                  +{overflow.length}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <span className="break-words">{overflow.join(', ')}</span>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{empty}</p>
      )}
    </div>
  );
};

/* ----------------------------------------------------------- shared states --- */

const CatalogLoading: React.FC<{ label: string }> = ({ label }) => (
  <LoadingState
    layout="panel"
    shape="panel"
    label={label}
    description="Preparing the catalog and its operator controls."
  />
);

/** Calm explanatory note above each catalog grid. */
const CatalogNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="mb-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">{children}</p>
);

/* ---------------------------------------------------------------- personas --- */

const PersonaCard: React.FC<{ persona: AgentPersona }> = ({ persona }) => {
  const Icon = personaIcon(persona.id);
  return (
    <Card className="flex h-full flex-col transition-colors hover:border-primary/40">
      <CardHeader className="gap-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="truncate font-semibold leading-tight text-foreground">
                {persona.label || persona.id}
              </div>
            </div>
          </div>
          <Badge variant="info" className="font-mono">
            <span className="truncate">{persona.id}</span>
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex-1 pt-0">
        <p className="text-sm leading-relaxed text-muted-foreground">
          {persona.specialization || 'General-purpose specialist.'}
        </p>
        <BadgeRow
          label="Focus tools"
          values={persona.focus_tools}
          variant="info"
          icon={Wrench}
          empty="No tool focus — uses the default toolset."
        />
        <BadgeRow
          label="Trigger keywords"
          values={persona.keywords}
          variant="outline"
          icon={Tag}
          empty="No keywords — selected as a fallback specialist."
        />
      </CardContent>
    </Card>
  );
};

const PersonasCatalog: React.FC = () => {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [enabled, setEnabled] = React.useState(true);
  const [personas, setPersonas] = React.useState<AgentPersona[]>([]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getPersonas();
      setEnabled(res.enabled);
      setPersonas(res.personas ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <CatalogLoading label="Loading agent personas" />;
  if (error) return <LoadError error={error} title="Could not load personas" onRetry={load} />;
  if (!enabled) {
    return (
      <EmptyState
        icon={Users}
        title="Multi-agent personas are disabled"
        description="The investigator runs as a single generalist. Enable the multi-agent roster on the backend to specialise it per cluster."
      />
    );
  }
  if (!personas.length) {
    return (
      <EmptyState
        icon={Users}
        title="No personas registered"
        description="No specialist personas are configured."
      />
    );
  }

  return (
    <>
      <CatalogNote>
        The router deterministically selects one specialist per cluster; it specialises the single
        investigator with the persona&apos;s focus and tool emphasis.
      </CatalogNote>
      <Stagger className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {personas.map((p) => (
          <PersonaCard key={p.id} persona={p} />
        ))}
      </Stagger>
    </>
  );
};

/* --------------------------------------------------------------- playbooks --- */

const EMPTY_MATCH: PlaybookMatch = {
  rule_ids: [],
  entity_types: [],
  mitre: [],
  min_event_count: null,
  any_tags: [],
};

const NEW_PLAYBOOK_ID = 'new_playbook';

function playbookTemplate(id = NEW_PLAYBOOK_ID): string {
  return `---
id: ${id}
name: New response playbook
version: 1
description: Describe when and why this procedure should be used.
priority: 0
match:
  rule_ids: []
  entity_types: []
  min_event_count: 1
suggested_tools: [es_query, enrich]
rag_queries: []
escalate_if: Describe the evidence that should trigger escalation.
suggested_verdict_bias: Advisory guidance only; deterministic policy still decides.
---
## Objective
State the investigation goal.

## Procedure
1. Confirm the source signal and affected entity.
2. Collect supporting evidence with the allowed tools.
3. Record a recommendation and the evidence behind it.
`;
}

function replaceFrontmatterId(content: string, id: string): string {
  const nextId = id || NEW_PLAYBOOK_ID;
  return /^id:\s*.*$/m.test(content)
    ? content.replace(/^id:\s*.*$/m, `id: ${nextId}`)
    : content;
}

type WorkspaceMode = 'view' | 'edit' | 'create';

interface PlaybookWorkspaceProps {
  open: boolean;
  mode: WorkspaceMode;
  detail: PlaybookDetail | null;
  loading: boolean;
  saving: boolean;
  draftId: string;
  draftContent: string;
  error: string;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: WorkspaceMode) => void;
  onDraftIdChange: (id: string) => void;
  onDraftContentChange: (content: string) => void;
  onSave: () => void;
}

const PlaybookWorkspace: React.FC<PlaybookWorkspaceProps> = ({
  open,
  mode,
  detail,
  loading,
  saving,
  draftId,
  draftContent,
  error,
  canManage,
  onOpenChange,
  onModeChange,
  onDraftIdChange,
  onDraftContentChange,
  onSave,
}) => {
  const creating = mode === 'create';
  const editing = mode === 'edit' || creating;
  const title = creating
    ? 'Create playbook'
    : detail?.name || detail?.id || 'Open playbook';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="xl" className="gap-0 p-0">
        <SheetHeader>
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>{title}</SheetTitle>
            {!creating && detail ? (
              <Badge variant={detail.protected ? 'secondary' : 'info'} className="gap-1">
                {detail.protected ? (
                  <Package className="h-3 w-3" aria-hidden />
                ) : (
                  <Database className="h-3 w-3" aria-hidden />
                )}
                {detail.storage === 'state' ? 'Operator · state-backed' : 'Bundled · package'}
              </Badge>
            ) : null}
            {!creating && detail ? (
              <Badge variant="outline" className="font-mono">
                revision {detail.revision}
              </Badge>
            ) : null}
          </div>
          <SheetDescription>
            {creating
              ? 'Add a plain-text investigation procedure. It can recommend; deterministic case policy still decides.'
              : editing
                ? 'Edit the operator-owned Markdown source. The id is immutable and must match its front matter.'
                : 'Plain-text source as loaded by the investigator. Packaged procedures are intentionally read-only.'}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {loading ? (
            <LoadingState
              layout="panel"
              shape="panel"
              label="Loading playbook"
              description="Opening the selected procedure."
            />
          ) : editing ? (
            <div className="space-y-4">
              {creating ? (
                <div className="max-w-md space-y-2">
                  <Label htmlFor="playbook-id">Playbook ID</Label>
                  <Input
                    id="playbook-id"
                    value={draftId}
                    onChange={(event) => onDraftIdChange(event.target.value)}
                    placeholder="credential_compromise_response"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Lowercase letters, numbers, underscores, or hyphens; up to 64 characters.
                  </p>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="playbook-markdown">Playbook Markdown</Label>
                <Textarea
                  id="playbook-markdown"
                  value={draftContent}
                  onChange={(event) => onDraftContentChange(event.target.value)}
                  className="min-h-96 resize-y font-mono text-xs leading-relaxed"
                  spellCheck={false}
                />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-critical-text">
                  {error}
                </p>
              ) : null}
            </div>
          ) : detail ? (
            <div className="space-y-4">
              <dl className="grid gap-3 border-y border-border py-3 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Durability</dt>
                  <dd className="mt-1 font-medium text-foreground">
                    {detail.storage === 'state'
                      ? 'Durable application state'
                      : 'Versioned application package'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Catalog revision</dt>
                  <dd className="mt-1 font-mono font-medium text-foreground">
                    {detail.revision}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {detail.storage === 'state' ? 'Last updated' : 'Ownership'}
                  </dt>
                  <dd className="mt-1 font-medium text-foreground">
                    {detail.storage === 'state'
                      ? `${formatTimestamp(detail.updated_at)}${detail.updated_by ? ` · ${detail.updated_by}` : ''}`
                      : 'Read-only bundled reference'}
                  </dd>
                </div>
              </dl>
              <CodeBlock value={detail.content} copyable wrap maxHeightClassName="max-h-none" />
            </div>
          ) : (
            <p role="alert" className="text-sm text-critical-text">
              {error || 'This playbook could not be opened.'}
            </p>
          )}
        </div>

        <SheetFooter className="sm:items-center sm:justify-between">
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            Playbooks are trusted operator context, not execution authority. They cannot close or
            escalate a case outside the configured deterministic policy.
          </p>
          <div className="flex shrink-0 items-center justify-end gap-2">
            {!editing && detail?.editable && canManage ? (
              <Button variant="outline" onClick={() => onModeChange('edit')}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Button>
            ) : null}
            {editing ? (
              <>
                {!creating ? (
                  <Button variant="outline" onClick={() => onModeChange('view')} disabled={saving}>
                    Cancel
                  </Button>
                ) : null}
                <Button onClick={onSave} disabled={saving || (creating && !draftId.trim())}>
                  {saving ? (
                    <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : (
                    <Save className="h-4 w-4" aria-hidden />
                  )}
                  {saving ? 'Saving…' : creating ? 'Create playbook' : 'Save changes'}
                </Button>
              </>
            ) : null}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

const MatchCriteria: React.FC<{ match: PlaybookMatch }> = ({ match }) => {
  const m = match || EMPTY_MATCH;
  const hasAny =
    Boolean(m.rule_ids?.length) ||
    Boolean(m.entity_types?.length) ||
    Boolean(m.mitre?.length) ||
    Boolean(m.any_tags?.length) ||
    typeof m.min_event_count === 'number';

  return (
    <div className="mt-4">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Match criteria
      </div>
      {hasAny ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(m.rule_ids ?? []).map((r, i) => (
            <Badge key={`rule-${i}`} variant="info" className="max-w-full">
              <Hash className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">rule: {r}</span>
            </Badge>
          ))}
          {(m.entity_types ?? []).map((e, i) => (
            <Badge key={`ent-${i}`} variant="success" className="max-w-full">
              <User className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{humanizeToken(e)}</span>
            </Badge>
          ))}
          {(m.mitre ?? []).map((t, i) => (
            <Badge key={`mitre-${i}`} variant="critical" className="max-w-full">
              <Crosshair className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{t}</span>
            </Badge>
          ))}
          {(m.any_tags ?? []).map((t, i) => (
            <Badge key={`tag-${i}`} variant="outline" className="max-w-full">
              <Tag className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{t}</span>
            </Badge>
          ))}
          {typeof m.min_event_count === 'number' ? (
            <Badge variant="secondary">
              <Hash className="h-3 w-3 shrink-0" aria-hidden />≥ {m.min_event_count} events
            </Badge>
          ) : null}
        </div>
      ) : (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Matches any cluster (catch-all).
        </p>
      )}
    </div>
  );
};

const PlaybookCard: React.FC<{
  playbook: Playbook;
  automationCount: number;
  onOpen: (playbook: Playbook) => void;
}> = ({
  playbook,
  automationCount,
  onOpen,
}) => {
  const ragQueries = playbook.rag_queries ?? [];
  return (
    <Card className="flex h-full flex-col transition-colors hover:border-primary/40">
      <CardHeader className="gap-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
              <FileText className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-semibold leading-tight text-foreground">
                  {playbook.name || playbook.id}
                </span>
                {playbook.version ? (
                  <Badge variant="outline" className="font-mono">
                    v{playbook.version}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Badge variant={playbook.protected ? 'secondary' : 'info'} className="gap-1">
              {playbook.protected ? (
                <Package className="h-3 w-3" aria-hidden />
              ) : (
                <Database className="h-3 w-3" aria-hidden />
              )}
              {playbook.storage === 'state' ? 'State-backed' : 'Package'}
            </Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" tabIndex={0} className="cursor-default font-mono">
                  rev {playbook.revision}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {playbook.storage === 'state'
                  ? 'Optimistic revision for this durable operator document.'
                  : 'Bundled package revision; this reference is read-only.'}
              </TooltipContent>
            </Tooltip>
            {typeof playbook.priority === 'number' ? (
              <Badge variant="warning">priority {playbook.priority}</Badge>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="success" tabIndex={0} className="cursor-default gap-1">
                  <Play className="h-3 w-3" aria-hidden />
                  Runnable
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Can be run from a case (Run a playbook) to re-investigate with this procedure as
                context.
              </TooltipContent>
            </Tooltip>
            {automationCount > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="info" tabIndex={0} className="cursor-default gap-1">
                    <Zap className="h-3 w-3" aria-hidden />
                    {automationCount} automation rule{automationCount === 1 ? '' : 's'}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Threshold automation rules queue this playbook. Manage them under Settings →
                  Threshold automation.
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 pt-0">
        {playbook.description ? (
          <p className="text-sm leading-relaxed text-muted-foreground">{playbook.description}</p>
        ) : null}

        <MatchCriteria match={playbook.match} />

        <BadgeRow
          label="Suggested tools"
          values={playbook.suggested_tools}
          variant="info"
          icon={Wrench}
        />

        {ragQueries.length ? (
          <div className="mt-4">
            <div className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              RAG queries
            </div>
            <CodeBlock
              value={ragQueries.join('\n')}
              copyable={false}
              wrap
              maxHeightClassName="max-h-48"
            />
          </div>
        ) : null}

        <div className="mt-5 border-t border-border pt-4">
          <Button variant="outline" size="sm" onClick={() => onOpen(playbook)}>
            <FileText className="h-4 w-4" aria-hidden />
            Open source
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

const ENTITY_TYPES: EntityTypeFull[] = ['rule', 'ip', 'user', 'host', 'domain', 'file_hash'];

function diagnosticValue(value: unknown): string {
  if (value == null || value === '') return 'none';
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : 'none';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return 'unavailable';
    }
  }
  return String(value);
}

function workerState(worker: SchedulerHealthResponse['workers'][string]): {
  label: string;
  variant: BadgeVariant;
} {
  if (worker.last_error) return { label: 'Error', variant: 'critical' };
  if (!worker.enabled) return { label: 'Disabled', variant: 'secondary' };
  if (worker.gated) {
    return {
      label: worker.cadence === 'manual' ? 'Manual' : 'Gated',
      variant: 'warning',
    };
  }
  if (worker.running) return { label: 'Running', variant: 'success' };
  return { label: 'Waiting', variant: 'secondary' };
}

interface PlaybookReadinessProps {
  coverage: PlaybookCoverageResponse | null;
  coverageError: string;
  schedulerHealth: SchedulerHealthResponse | null;
  schedulerError: string;
  showSchedulerHealth: boolean;
}

/**
 * Deterministic operational evidence for the playbook layer. The dry-run calls
 * the exact backend selector; it never investigates a case or executes a tool.
 */
const PlaybookReadiness: React.FC<PlaybookReadinessProps> = ({
  coverage,
  coverageError,
  schedulerHealth,
  schedulerError,
  showSchedulerHealth,
}) => {
  const [ruleInput, setRuleInput] = React.useState('');
  const [entityType, setEntityType] = React.useState<EntityTypeFull>('rule');
  const [eventCount, setEventCount] = React.useState('1');
  const [dryRun, setDryRun] = React.useState<PlaybookDryRunResponse | null>(null);
  const [dryRunError, setDryRunError] = React.useState('');
  const [testing, setTesting] = React.useState(false);

  const testSelection = React.useCallback(async () => {
    const parsedCount = Number.parseInt(eventCount, 10);
    if (!Number.isFinite(parsedCount) || parsedCount < 0 || parsedCount > 1_000_000) {
      setDryRunError('Event count must be between 0 and 1,000,000.');
      return;
    }
    const ruleIds = Array.from(
      new Set(
        ruleInput
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
    setTesting(true);
    setDryRunError('');
    try {
      setDryRun(
        await api.dryRunPlaybookSelection({
          rule_ids: ruleIds,
          entity_type: entityType,
          event_count: parsedCount,
        }),
      );
    } catch (e) {
      setDryRun(null);
      setDryRunError(errorMessage(e, 'Could not test playbook selection.'));
    } finally {
      setTesting(false);
    }
  }, [entityType, eventCount, ruleInput]);

  const coveragePercent = coverage?.coverage_percent;
  const workerRows = schedulerHealth ? Object.entries(schedulerHealth.workers) : [];

  return (
    <section aria-labelledby="playbook-readiness-heading" className="mb-6 border-y border-border">
      <div className="grid xl:grid-cols-2">
        <div className="p-5 xl:border-r xl:border-border">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="playbook-readiness-heading" className="font-semibold text-foreground">
                Procedure coverage
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Stored cases tested against the current exact-match registry.
              </p>
            </div>
            {coverage ? (
              <Badge variant={coverage.uncovered_cases > 0 ? 'warning' : 'success'}>
                {coveragePercent == null ? 'No case history' : `${coveragePercent}% covered`}
              </Badge>
            ) : null}
          </div>

          {coverageError ? (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              Coverage unavailable · {coverageError}
            </p>
          ) : coverage ? (
            <div className="mt-5 space-y-4">
              {coveragePercent == null ? (
                <p className="text-sm text-muted-foreground">
                  No stored cases are available yet. Coverage will appear after cases are created.
                </p>
              ) : (
                <Progress
                  value={coveragePercent}
                  variant={coverage.uncovered_cases > 0 ? 'warning' : 'success'}
                  aria-label={`Playbook coverage ${coveragePercent}%`}
                />
              )}
              <dl className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Cases checked</dt>
                  <dd className="mt-1 font-mono text-base font-semibold text-foreground">
                    {coverage.scanned_cases.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Matched</dt>
                  <dd className="mt-1 font-mono text-base font-semibold text-success-text">
                    {coverage.covered_cases.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">No match</dt>
                  <dd className="mt-1 font-mono text-base font-semibold text-warning-text">
                    {coverage.uncovered_cases.toLocaleString()}
                  </dd>
                </div>
              </dl>
              {coverage.unmatched_rule_families.length ? (
                <div>
                  <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Uncovered rule families
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {coverage.unmatched_rule_families.slice(0, 8).map((family) => (
                      <Badge key={family.rule_id} variant="warning" className="max-w-full font-mono">
                        <span className="truncate">{family.rule_id}</span>
                        <span aria-hidden>·</span>
                        <span>{family.case_count}</span>
                      </Badge>
                    ))}
                    {coverage.unmatched_rule_families.length > 8 ? (
                      <Badge variant="secondary">
                        +{coverage.unmatched_rule_families.length - 8} more
                      </Badge>
                    ) : null}
                  </div>
                </div>
              ) : coverage.scanned_cases > 0 ? (
                <p className="flex items-center gap-2 text-xs text-success-text">
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  Every scanned case has a deterministic playbook match.
                </p>
              ) : null}
              {coverage.truncated ? (
                <p className="flex items-start gap-2 text-xs leading-relaxed text-warning-text">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  Coverage is limited to the first {coverage.scan_limit.toLocaleString()} stored
                  cases; treat this as a bounded sample, not lifetime coverage.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Loading coverage…</p>
          )}
        </div>

        <div className="border-t border-border p-5 xl:border-t-0">
          <div className="flex items-start gap-3">
            <TestTube2 className="mt-0.5 h-5 w-5 text-primary" aria-hidden />
            <div>
              <h3 className="font-semibold text-foreground">Test deterministic matching</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Preview selection only. No case, tool, model, or policy action runs.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_8rem_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="playbook-test-rules">Rule IDs</Label>
              <Input
                id="playbook-test-rules"
                value={ruleInput}
                onChange={(event) => setRuleInput(event.target.value)}
                placeholder="rule-a, rule-b"
                className="font-mono"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="playbook-test-entity">Entity</Label>
              <Select value={entityType} onValueChange={(value) => setEntityType(value as EntityTypeFull)}>
                <SelectTrigger id="playbook-test-entity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENTITY_TYPES.map((entity) => (
                    <SelectItem key={entity} value={entity}>
                      {humanizeToken(entity)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="playbook-test-count">Events</Label>
              <Input
                id="playbook-test-count"
                type="number"
                min={0}
                max={1_000_000}
                value={eventCount}
                onChange={(event) => setEventCount(event.target.value)}
              />
            </div>
            <Button variant="outline" onClick={() => void testSelection()} disabled={testing}>
              {testing ? (
                <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              {testing ? 'Testing…' : 'Test match'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Separate multiple rule IDs with commas. Matching is exact after edge whitespace is removed.
          </p>

          {dryRunError ? (
            <p role="alert" className="mt-4 text-sm text-critical-text">
              {dryRunError}
            </p>
          ) : null}
          {dryRun ? (
            <div role="status" className="mt-4 border-t border-border pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={dryRun.selected_playbook_id ? 'success' : 'warning'}>
                  {dryRun.selected_playbook_id
                    ? `Selected · ${dryRun.selected_playbook_id}`
                    : 'No playbook selected'}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {dryRun.matched_count} of {dryRun.candidate_count} candidates matched
                </span>
              </div>
              <p className="mt-2 font-mono text-xs leading-relaxed text-foreground">
                {dryRun.selection_reason}
              </p>
              {dryRun.candidates.length ? (
                <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                  {dryRun.candidates.map((candidate) => (
                    <details
                      key={candidate.playbook_id}
                      open={candidate.playbook_id === dryRun.selected_playbook_id}
                      className="border-t border-border pt-2"
                    >
                      <summary className="cursor-pointer text-xs font-medium text-foreground">
                        {candidate.playbook_name || candidate.playbook_id} · priority{' '}
                        {candidate.priority} · {candidate.matched ? 'matched' : 'did not match'}
                      </summary>
                      <ul className="mt-2 space-y-2 pl-1">
                        {candidate.checks.map((check, index) => (
                          <li key={`${candidate.playbook_id}-${check.criterion}-${index}`} className="flex gap-2 text-xs">
                            {check.passed ? (
                              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                            ) : (
                              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                            )}
                            <span className="min-w-0">
                              <span className="font-medium text-foreground">
                                {humanizeToken(check.criterion)}:
                              </span>{' '}
                              <span className="text-muted-foreground">{check.reason}</span>
                              <span className="mt-0.5 block break-words font-mono text-2xs text-muted-foreground">
                                expected {diagnosticValue(check.expected)} · observed{' '}
                                {diagnosticValue(check.actual)}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {showSchedulerHealth ? (
        <div className="border-t border-border px-5 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
              <Activity className="h-4 w-4 text-primary" aria-hidden />
              Continuous-improvement workers
            </span>
            {schedulerError ? (
              <span className="text-xs text-muted-foreground">
                Health unavailable · {schedulerError}
              </span>
            ) : workerRows.length ? (
              workerRows.map(([name, worker]) => {
                const state = workerState(worker);
                return (
                  <Tooltip key={name}>
                    <TooltipTrigger asChild>
                      <Badge variant={state.variant} tabIndex={0} className="cursor-default">
                        {humanizeToken(name)} · {state.label}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm space-y-1">
                      <p>Cadence: {humanizeToken(worker.cadence)}</p>
                      <p>Last success: {formatTimestamp(worker.last_success_at)}</p>
                      <p>Last processed: {worker.processed.toLocaleString()}</p>
                      {worker.last_error ? <p>Last error: {worker.last_error}</p> : null}
                    </TooltipContent>
                  </Tooltip>
                );
              })
            ) : (
              <span className="text-xs text-muted-foreground">Loading worker health…</span>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
};

export const PlaybooksCatalog: React.FC = () => {
  const canManage = useCan('playbooks', 'manage');
  const canReadSettings = useCan('settings', 'read');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [enabled, setEnabled] = React.useState(true);
  const [playbooks, setPlaybooks] = React.useState<Playbook[]>([]);
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [workspaceMode, setWorkspaceMode] = React.useState<WorkspaceMode>('view');
  const [detail, setDetail] = React.useState<PlaybookDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [draftId, setDraftId] = React.useState('');
  const [draftContent, setDraftContent] = React.useState('');
  const [workspaceError, setWorkspaceError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [coverage, setCoverage] = React.useState<PlaybookCoverageResponse | null>(null);
  const [coverageError, setCoverageError] = React.useState('');
  const [schedulerHealth, setSchedulerHealth] = React.useState<SchedulerHealthResponse | null>(null);
  const [schedulerError, setSchedulerError] = React.useState('');
  // playbook_id → number of threshold-automation rules that queue it.
  const [automationByPlaybook, setAutomationByPlaybook] = React.useState<
    Record<string, number>
  >({});

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getPlaybooks();
      setEnabled(res.enabled);
      setPlaybooks(res.playbooks ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
    setCoverageError('');
    try {
      setCoverage(await api.getPlaybookCoverage());
    } catch (coverageFailure) {
      setCoverage(null);
      setCoverageError(errorMessage(coverageFailure, 'The coverage query failed.'));
    }
    if (canReadSettings) {
      setSchedulerError('');
      try {
        setSchedulerHealth(await api.getSchedulerHealth());
      } catch (healthFailure) {
        setSchedulerHealth(null);
        setSchedulerError(errorMessage(healthFailure, 'The health query failed.'));
      }
    } else {
      setSchedulerHealth(null);
      setSchedulerError('');
    }
    // Best-effort: count automation rules that run each playbook (may be 403 for
    // non-admins; degrade silently to no markers).
    try {
      const settings = await api.getSettings();
      const rules = settings.prefs?.threshold_automation?.rules ?? [];
      const counts: Record<string, number> = {};
      for (const r of rules) {
        if (r.action !== 'run_playbook') continue;
        const pid = typeof r.payload?.playbook_id === 'string' ? r.payload.playbook_id : '';
        if (pid) counts[pid] = (counts[pid] ?? 0) + 1;
      }
      setAutomationByPlaybook(counts);
    } catch {
      setAutomationByPlaybook({});
    }
  }, [canReadSettings]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const openPlaybook = React.useCallback(async (playbook: Playbook) => {
    setWorkspaceOpen(true);
    setWorkspaceMode('view');
    setDetail(null);
    setWorkspaceError('');
    setDetailLoading(true);
    try {
      const opened = await api.getPlaybook(playbook.id);
      setDetail(opened);
      setDraftId(opened.id);
      setDraftContent(opened.content);
    } catch (e) {
      setWorkspaceError(errorMessage(e, 'Could not open the playbook.'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const startCreate = React.useCallback(() => {
    setWorkspaceOpen(true);
    setWorkspaceMode('create');
    setDetail(null);
    setDraftId('');
    setDraftContent(playbookTemplate());
    setWorkspaceError('');
    setDetailLoading(false);
  }, []);

  const changeMode = React.useCallback(
    (mode: WorkspaceMode) => {
      if (mode === 'edit' && detail) {
        setDraftId(detail.id);
        setDraftContent(detail.content);
      }
      if (mode === 'view' && detail) {
        setDraftContent(detail.content);
      }
      setWorkspaceError('');
      setWorkspaceMode(mode);
    },
    [detail],
  );

  const changeDraftId = React.useCallback((id: string) => {
    setDraftId(id);
    setDraftContent((current) => replaceFrontmatterId(current, id));
  }, []);

  const savePlaybook = React.useCallback(async () => {
    if (workspaceMode !== 'create' && !detail) return;
    const id = workspaceMode === 'create' ? draftId.trim() : detail?.id ?? '';
    if (!id) return;
    setSaving(true);
    setWorkspaceError('');
    try {
      const result =
        workspaceMode === 'create'
          ? await api.createPlaybook({ id, content: draftContent })
          : await api.updatePlaybook(id, draftContent, detail?.revision ?? 1);
      setPlaybooks((current) => {
        const withoutSaved = current.filter((playbook) => playbook.id !== result.playbook.id);
        return [...withoutSaved, result.playbook].sort((a, b) => a.name.localeCompare(b.name));
      });
      const successMessage =
        workspaceMode === 'create' ? 'Playbook created and loaded.' : 'Playbook updated and loaded.';
      toast.success(successMessage);
      try {
        const opened = await api.getPlaybook(result.playbook.id);
        setDetail(opened);
        setDraftId(opened.id);
        setDraftContent(opened.content);
        setWorkspaceMode('view');
      } catch (openError) {
        // The mutation response is authoritative. A transient follow-up read must
        // never tell the operator that a successful create/update failed (and tempt
        // a duplicate retry); keep the saved catalog row and explain only the reopen.
        const reason = errorMessage(openError, 'The source could not be reopened.');
        const message = `Playbook saved, but could not be reopened. ${reason}`;
        setDetail(null);
        setWorkspaceMode('view');
        setWorkspaceError(message);
        toast.error(message);
      }
    } catch (e) {
      const message = errorMessage(e, 'Could not save the playbook.');
      setWorkspaceError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [detail, draftContent, draftId, workspaceMode]);

  const workspace = (
    <PlaybookWorkspace
      open={workspaceOpen}
      mode={workspaceMode}
      detail={detail}
      loading={detailLoading}
      saving={saving}
      draftId={draftId}
      draftContent={draftContent}
      error={workspaceError}
      canManage={canManage}
      onOpenChange={(open) => {
        if (!saving) setWorkspaceOpen(open);
      }}
      onModeChange={changeMode}
      onDraftIdChange={changeDraftId}
      onDraftContentChange={setDraftContent}
      onSave={() => void savePlaybook()}
    />
  );

  if (loading) return <CatalogLoading label="Loading playbooks" />;
  if (error) return <LoadError error={error} title="Could not load playbooks" onRetry={load} />;
  return (
    <>
      <div className="mb-5 flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CatalogNote>
            Plain-text procedures selected by match criteria and injected as trusted operator
            guidance. Higher priority wins ties; deterministic policy always decides the case.
          </CatalogNote>
          {!enabled ? (
            <p className="text-sm text-warning-text">
              Playbook injection is currently disabled. Catalog changes are saved, but not used by investigations.
            </p>
          ) : null}
        </div>
        {canManage ? (
          <Button onClick={startCreate} className="shrink-0">
            <Plus className="h-4 w-4" aria-hidden />
            New playbook
          </Button>
        ) : null}
      </div>
      <PlaybookReadiness
        coverage={coverage}
        coverageError={coverageError}
        schedulerHealth={schedulerHealth}
        schedulerError={schedulerError}
        showSchedulerHealth={canReadSettings}
      />
      {playbooks.length ? (
        <Stagger className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {playbooks.map((p) => (
            <PlaybookCard
              key={p.id}
              playbook={p}
              automationCount={automationByPlaybook[p.id] ?? 0}
              onOpen={openPlaybook}
            />
          ))}
        </Stagger>
      ) : (
        <EmptyState
          icon={ScrollText}
          title={enabled ? 'No playbooks loaded' : 'Playbooks are disabled'}
          description={
            enabled
              ? 'Create an operator Markdown procedure to populate this catalog.'
              : 'You can prepare operator procedures now, but they are not injected until Playbooks is enabled in Settings.'
          }
        />
      )}
      {workspace}
    </>
  );
};

/* ------------------------------------------------------------------- page ---- */

export interface CatalogProps {
  /**
   * When hosted as a tab inside the Intelligence scaffold (Round-2 W4 consolidation),
   * suppress the page's own PageHeader so the host owns the title (no duplicate
   * headers).
   */
  embedded?: boolean;
  /** Intelligence deep-links land directly on Playbooks; standalone catalog may
   * still start on the persona reference tab. */
  defaultTab?: 'personas' | 'playbooks';
}

export default function Catalog({ embedded = false, defaultTab = 'personas' }: CatalogProps = {}) {
  return (
    <div className="space-y-6">
      {embedded ? null : (
        <PageHeader
          icon={Library}
          eyebrow="Knowledge"
          title="Playbooks & Agents"
          description="Specialist personas and operator-managed plain-text investigation procedures."
        />
      )}

      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTrigger value="personas" className="gap-2">
            <Users className="h-4 w-4" aria-hidden />
            Personas
          </TabsTrigger>
          <TabsTrigger value="playbooks" className="gap-2">
            <ScrollText className="h-4 w-4" aria-hidden />
            Playbooks
          </TabsTrigger>
        </TabsList>

        <TabsContent value="personas" className="mt-6">
          <PersonasCatalog />
        </TabsContent>
        <TabsContent value="playbooks" className="mt-6">
          <PlaybooksCatalog />
        </TabsContent>
      </Tabs>
    </div>
  );
}
