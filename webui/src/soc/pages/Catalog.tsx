/**
 * Catalog — "Playbooks & Agents".
 *
 * A read-only catalog of the two declarative knowledge surfaces the triage spine
 * uses:
 *   - Agent personas (`GET /api/personas`): the specialist the router can
 *     specialise the single investigator into, with its focus tools + trigger
 *     keywords.
 *   - Playbooks (`GET /api/playbooks`): the plain-text runbooks, with their match
 *     criteria, suggested tools and the RAG queries they inject.
 *
 * Both are showcase, non-editable views. Each catalog degrades gracefully to an
 * empty/disabled state when the backend reports the feature off.
 *
 * SECURITY: persona/playbook fields (labels, descriptions, keywords, rule ids,
 * MITRE ids, tags, tool names, RAG queries) are backend-config-derived and are
 * rendered as PLAIN text / <Badge> children / <CodeBlock> only — never via
 * dangerouslySetInnerHTML.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Bug,
  Crosshair,
  FileText,
  Globe,
  Hash,
  Key,
  Library,
  RefreshCw,
  ScrollText,
  Search,
  Tag,
  User,
  Users,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { AgentPersona, Playbook, PlaybookMatch } from '@/lib/types';
import { api } from '@/lib/api';
import { humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { Stagger } from '@/soc/components/Stagger';
import { CodeBlock } from '@/soc/components/CodeBlock';

import { Card, CardContent, CardHeader } from '@/ui/card';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

/** Max badges shown inline before collapsing the remainder into a "+N" pill. */
const BADGE_CAP = 8;

/** Coerce an unknown caught value into a readable message. */
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return 'Unknown error';
  }
}

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
    <div className="mt-3">
      <div className="text-xs font-semibold text-muted-foreground">{label}</div>
      {items.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
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
        <p className="mt-1 text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
};

/* ----------------------------------------------------------- shared states --- */

const GridSkeleton: React.FC = () => (
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
    {Array.from({ length: 4 }).map((_, i) => (
      <Card key={i}>
        <CardHeader className="gap-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-6 w-2/3" />
        </CardContent>
      </Card>
    ))}
  </div>
);

const LoadError: React.FC<{ error: unknown; title: string; onRetry: () => void }> = ({
  error,
  title,
  onRetry,
}) => (
  <Alert variant="destructive">
    <AlertTriangle aria-hidden />
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="space-y-2">
      <p className="break-words">{errMessage(error)}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw aria-hidden />
        Retry
      </Button>
    </AlertDescription>
  </Alert>
);

/** Small italic note above each catalog grid. */
const CatalogNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="mb-4 max-w-3xl text-xs text-muted-foreground">{children}</p>
);

/* ---------------------------------------------------------------- personas --- */

const PersonaCard: React.FC<{ persona: AgentPersona }> = ({ persona }) => {
  const Icon = personaIcon(persona.id);
  return (
    <Card className="flex h-full flex-col transition-shadow hover:shadow-elev2">
      <CardHeader className="gap-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-card text-primary shadow-elev1">
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
        <p className="text-sm text-foreground/90">
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

  if (loading) return <GridSkeleton />;
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
      <Stagger className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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

const MatchCriteria: React.FC<{ match: PlaybookMatch }> = ({ match }) => {
  const m = match || EMPTY_MATCH;
  const hasAny =
    Boolean(m.rule_ids?.length) ||
    Boolean(m.entity_types?.length) ||
    Boolean(m.mitre?.length) ||
    Boolean(m.any_tags?.length) ||
    typeof m.min_event_count === 'number';

  return (
    <div className="mt-3">
      <div className="text-xs font-semibold text-muted-foreground">Match criteria</div>
      {hasAny ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
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
        <p className="mt-1 text-xs text-muted-foreground">Matches any cluster (catch-all).</p>
      )}
    </div>
  );
};

const PlaybookCard: React.FC<{ playbook: Playbook }> = ({ playbook }) => {
  const ragQueries = playbook.rag_queries ?? [];
  return (
    <Card className="flex h-full flex-col transition-shadow hover:shadow-elev2">
      <CardHeader className="gap-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-card text-primary shadow-elev1">
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
          {typeof playbook.priority === 'number' ? (
            <Badge variant="warning">priority {playbook.priority}</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex-1 pt-0">
        {playbook.description ? (
          <p className="text-sm text-foreground/90">{playbook.description}</p>
        ) : null}

        <MatchCriteria match={playbook.match} />

        <BadgeRow
          label="Suggested tools"
          values={playbook.suggested_tools}
          variant="info"
          icon={Wrench}
        />

        {ragQueries.length ? (
          <div className="mt-3">
            <div className="mb-1.5 text-xs font-semibold text-muted-foreground">RAG queries</div>
            <CodeBlock
              value={ragQueries.join('\n')}
              copyable={false}
              wrap
              maxHeightClassName="max-h-48"
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

const PlaybooksCatalog: React.FC = () => {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [enabled, setEnabled] = React.useState(true);
  const [playbooks, setPlaybooks] = React.useState<Playbook[]>([]);

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
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <GridSkeleton />;
  if (error) return <LoadError error={error} title="Could not load playbooks" onRetry={load} />;
  if (!enabled) {
    return (
      <EmptyState
        icon={ScrollText}
        title="Playbooks are disabled"
        description="Enable the plain-text runbook loader on the backend to inject TRUSTED playbook guidance into investigations."
      />
    );
  }
  if (!playbooks.length) {
    return (
      <EmptyState
        icon={ScrollText}
        title="No playbooks loaded"
        description="Drop Markdown runbooks into the backend's runbooks directory to populate this catalog."
      />
    );
  }

  return (
    <>
      <CatalogNote>
        Plain-text runbooks selected by match criteria and injected as TRUSTED guidance into the
        investigator (and indexed into RAG). Higher priority wins ties.
      </CatalogNote>
      <Stagger className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {playbooks.map((p) => (
          <PlaybookCard key={p.id} playbook={p} />
        ))}
      </Stagger>
    </>
  );
};

/* ------------------------------------------------------------------- page ---- */

export interface CatalogProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNavigate?: (page: any, opts?: any) => void;
}

export default function Catalog(_props: CatalogProps) {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Library}
        eyebrow="Knowledge"
        title="Playbooks & Agents"
        description="The declarative knowledge the triage spine uses — specialist personas and plain-text runbooks. Read-only."
      />

      <Tabs defaultValue="personas">
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

        <TabsContent value="personas" className={cn('mt-6')}>
          <PersonasCatalog />
        </TabsContent>
        <TabsContent value="playbooks" className={cn('mt-6')}>
          <PlaybooksCatalog />
        </TabsContent>
      </Tabs>
    </div>
  );
}
