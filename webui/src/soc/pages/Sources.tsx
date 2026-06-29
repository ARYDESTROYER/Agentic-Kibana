/**
 * Sources — manage the systems the agent reads security events from.
 *
 * Lists configured sources as cards (primary/enabled badges, connector type, at-a-
 * glance triage config: index patterns + roles, entity strategy, message field),
 * with per-source actions: browse Logs (a right Sheet), make primary (confirm),
 * edit, and remove (confirm). "Add source" / "Edit" open the SourceEditor inside a
 * Dialog — the same dynamic, manifest-driven form the wizard uses.
 *
 * Security: connector/source text is operator- or backend-provided and rendered as
 * plain text; secrets are never shown (only `N secret(s)` counts). Log values in
 * the Logs sheet are UNTRUSTED and fenced there.
 */
import * as React from 'react';
import {
  Database,
  Plus,
  Pencil,
  Trash2,
  Star,
  Telescope,
  Tags,
  ShieldAlert,
  KeyRound,
  AlertTriangle,
  Loader2,
  Plug,
  Link2,
} from 'lucide-react';
import type { Navigate } from '@/soc/router';
import { api } from '@/lib/api';
import type {
  ConnectorManifest,
  EntityStrategy,
  IndexPattern,
  SourceConfigExtras,
  SourceInstance,
} from '@/lib/types';
import { humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';
import { toast } from 'sonner';

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { Stagger } from '@/soc/components/Stagger';
import { SourceEditor } from '@/soc/components/SourceEditor';
import { SourceLogsSheet } from '@/soc/components/SourceLogsSheet';
import { categoryMeta } from '@/soc/components/ConnectorPicker';
import { Can } from '@/soc/components/Can';
import { HelpTip } from '@/soc/components/HelpTip';

import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Badge } from '@/ui/badge';
import { SkeletonCard } from '@/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';

/** Human label for an entity strategy (matches the editor's choices). */
const ENTITY_LABELS: Record<string, string> = {
  auto: 'Auto entity',
  ip: 'Entity: IP',
  host: 'Entity: Host',
  user: 'Entity: User',
  rule: 'Entity: Rule',
};

/** Derive the index patterns + roles a source reads (for the at-a-glance summary). */
function summarisePatterns(cfg: Record<string, unknown> | undefined): IndexPattern[] {
  if (!cfg) return [];
  const ip = cfg.index_patterns;
  if (Array.isArray(ip) && ip.length) {
    return ip
      .filter((p): p is IndexPattern => !!p && typeof (p as IndexPattern).pattern === 'string')
      .map((p) => ({ pattern: String(p.pattern), role: p.role === 'alerts' ? 'alerts' : 'events' }));
  }
  const single = cfg.data_view_pattern;
  if (typeof single === 'string' && single.trim()) {
    return single
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((pattern): IndexPattern => ({ pattern, role: 'events' }));
  }
  return [];
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || 'Something went wrong.';
  return 'Something went wrong.';
}

type EditorState = { mode: 'add' } | { mode: 'edit'; source: SourceInstance } | null;

export interface SourcesProps {
  onNavigate?: Navigate;
}

export default function Sources(_props: SourcesProps) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [connectors, setConnectors] = React.useState<ConnectorManifest[]>([]);
  const [sources, setSources] = React.useState<SourceInstance[]>([]);
  const [editor, setEditor] = React.useState<EditorState>(null);
  const [logsSource, setLogsSource] = React.useState<SourceInstance | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<SourceInstance | null>(null);
  const [pendingPrimary, setPendingPrimary] = React.useState<SourceInstance | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [conns, src] = await Promise.all([api.listConnectors(), api.listSources()]);
      setConnectors(conns.connectors);
      setSources(src.sources);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onSaved = async () => {
    setEditor(null);
    toast.success('Source saved');
    await load();
  };

  const setPrimary = async (s: SourceInstance) => {
    setBusyId(s.id);
    try {
      await api.upsertSource({
        id: s.id,
        source_type: s.source_type,
        display_name: s.display_name,
        enabled: s.enabled,
        is_primary: true,
        ingest_mode: s.ingest_mode ?? null,
        config: (s.config as Record<string, unknown>) || {},
      });
      toast.success(`${s.display_name || s.source_type} is now the primary source`);
      await load();
    } catch (e) {
      setError(e);
      toast.error('Could not change the primary source');
    } finally {
      setBusyId(null);
      setPendingPrimary(null);
    }
  };

  const remove = async (s: SourceInstance) => {
    setBusyId(s.id);
    try {
      await api.deleteSource(s.id);
      toast.success('Source removed');
      await load();
    } catch (e) {
      setError(e);
      toast.error('Could not remove the source');
    } finally {
      setBusyId(null);
      setPendingDelete(null);
    }
  };

  const description = loading
    ? 'Connect and manage the systems the agent reads security events from.'
    : `${sources.length} source${sources.length === 1 ? '' : 's'} configured — the systems the agent reads security events from.`;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Database}
        eyebrow="Platform"
        title="Sources"
        description={description}
        actions={
          <Can resource="sources" action="manage">
            <Button onClick={() => setEditor({ mode: 'add' })}>
              <Plus className="h-4 w-4" aria-hidden /> Add source
            </Button>
          </Can>
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading sources">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </div>
      ) : sources.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="Connect your first data source"
          description="The agent triages security events from the systems you connect — a SIEM/log store (Elasticsearch, OpenSearch, Wazuh) or a push receiver (webhook, syslog, a queue, an object store). Pick a connector and we'll walk you through it, with a (?) guide on every step."
          action={
            <Can
              resource="sources"
              action="manage"
              fallback={
                <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Link2 className="h-3.5 w-3.5" aria-hidden />
                  Ask a SOC administrator to connect a source.
                </p>
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <Button onClick={() => setEditor({ mode: 'add' })}>
                  <Plus className="h-4 w-4" aria-hidden /> Connect a source
                </Button>
                <HelpTip
                  label="How adding a source works"
                  text="Choose a connector (e.g. Elasticsearch), fill its form — each field has a (?) with setup help — set the index patterns the agent reads and how clusters auto-correlate, then test and save. For Elasticsearch, create a READ-ONLY scoped API key (never the elastic superuser or kibana_system)."
                />
              </span>
            </Can>
          }
        />
      ) : (
        <Stagger className="space-y-4">
          {sources.map((s) => {
            const meta = connectors.find((c) => c.source_type === s.source_type);
            const canBrowse = !!meta?.capabilities?.includes('browse');
            const cat = categoryMeta(meta?.category);
            const CatIcon = cat.icon;
            const cfg = s.config as (Record<string, unknown> & Partial<SourceConfigExtras>) | undefined;
            const patterns = summarisePatterns(cfg);
            const strategy = ((cfg?.entity_strategy as EntityStrategy | string) || 'auto') as string;
            const messageField = (cfg?.message_field as string) || '';
            const secretCount = s.configured_secrets?.length || 0;
            const busy = busyId === s.id;

            return (
              <Card key={s.id} className="p-5">
                <div className="flex flex-wrap items-start gap-4">
                  <span
                    className={cn(
                      'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border bg-surface',
                      s.is_primary ? 'border-primary text-primary' : cn('border-border', cat.tone),
                    )}
                  >
                    <CatIcon className="h-5 w-5" aria-hidden />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[0.95rem] font-semibold text-foreground">
                        {s.display_name || meta?.display_name || s.source_type}
                      </span>
                      {s.is_primary ? <Badge variant="default">Primary</Badge> : null}
                      {s.enabled ? (
                        <Badge variant="success">Enabled</Badge>
                      ) : (
                        <Badge variant="outline">Disabled</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {humanizeToken(s.source_type)} · {humanizeToken(s.ingest_mode)}
                      {secretCount ? ` · ${secretCount} secret${secretCount === 1 ? '' : 's'}` : ''}
                    </p>

                    {patterns.length || strategy !== 'auto' || messageField ? (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        {patterns.slice(0, 4).map((p, i) => (
                          <Badge
                            key={`${p.pattern}-${i}`}
                            variant={p.role === 'alerts' ? 'warning' : 'outline'}
                            className="gap-1 font-mono text-[0.7rem]"
                            title={`${p.role === 'alerts' ? 'Alerts' : 'Events'} pattern`}
                          >
                            {p.role === 'alerts' ? (
                              <ShieldAlert className="h-3 w-3" aria-hidden />
                            ) : (
                              <Database className="h-3 w-3" aria-hidden />
                            )}
                            {p.pattern}
                          </Badge>
                        ))}
                        {patterns.length > 4 ? (
                          <Badge variant="outline">+{patterns.length - 4} more</Badge>
                        ) : null}
                        {strategy !== 'auto' ? (
                          <Badge variant="secondary">
                            {ENTITY_LABELS[strategy] || `Entity: ${humanizeToken(strategy)}`}
                          </Badge>
                        ) : null}
                        {messageField ? (
                          <Badge variant="secondary" className="gap-1 font-mono text-[0.7rem]" title="Message field">
                            <Tags className="h-3 w-3" aria-hidden />
                            {messageField}
                          </Badge>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-1 sm:ml-auto">
                    {canBrowse ? (
                      <Button variant="ghost" size="sm" onClick={() => setLogsSource(s)}>
                        <Telescope className="h-4 w-4" aria-hidden /> Logs
                      </Button>
                    ) : null}
                    <Can resource="sources" action="manage">
                      {!s.is_primary ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingPrimary(s)}
                          disabled={busy}
                        >
                          <Star className="h-4 w-4" aria-hidden /> Make primary
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditor({ mode: 'edit', source: s })}
                      >
                        <Pencil className="h-4 w-4" aria-hidden /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-critical hover:text-critical"
                        onClick={() => setPendingDelete(s)}
                        disabled={busy}
                      >
                        {busy ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Trash2 className="h-4 w-4" aria-hidden />
                        )}
                        Remove
                      </Button>
                    </Can>
                  </div>
                </div>
              </Card>
            );
          })}
        </Stagger>
      )}

      {/* Add / Edit editor (Dialog hosting the dynamic SourceEditor) */}
      <Dialog open={!!editor} onOpenChange={(o) => !o && setEditor(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === 'edit'
                ? `Edit ${editor.source.display_name || editor.source.source_type}`
                : 'Add a source'}
            </DialogTitle>
            <DialogDescription>
              Configure a system for the agent to read security events from.
            </DialogDescription>
          </DialogHeader>
          {editor ? (
            <SourceEditor
              connectors={connectors}
              existing={editor.mode === 'edit' ? editor.source : undefined}
              onSaved={onSaved}
              onCancel={() => setEditor(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Per-source logs sheet */}
      <SourceLogsSheet source={logsSource} onClose={() => setLogsSource(null)} />

      {/* Make-primary confirm */}
      <Dialog open={!!pendingPrimary} onOpenChange={(o) => !o && setPendingPrimary(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Star className="h-5 w-5 text-primary" aria-hidden /> Make this the primary source?
            </DialogTitle>
            <DialogDescription>
              The agent reads new events from the primary source.
            </DialogDescription>
          </DialogHeader>
          {pendingPrimary ? (
            <p className="text-sm text-muted-foreground">
              Switching to{' '}
              <span className="font-medium text-foreground">
                {pendingPrimary.display_name || pendingPrimary.source_type}
              </span>{' '}
              repoints ingestion to it; the current primary becomes a non-primary source (it is
              not deleted).
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingPrimary(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => pendingPrimary && void setPrimary(pendingPrimary)}
              disabled={!!pendingPrimary && busyId === pendingPrimary.id}
            >
              {pendingPrimary && busyId === pendingPrimary.id ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Star className="h-4 w-4" aria-hidden />
              )}
              Make primary
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirm (destructive) */}
      <Dialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-critical" aria-hidden /> Remove this source?
            </DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          {pendingDelete ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {pendingDelete.display_name || pendingDelete.source_type}
              </span>{' '}
              will be removed and the agent will stop reading events from it. Existing cases are
              kept; its stored secrets are discarded.
            </p>
          ) : null}
          {pendingDelete?.configured_secrets?.length ? (
            <Alert variant="warning">
              <KeyRound className="h-4 w-4" aria-hidden />
              <AlertTitle>Stored secrets will be discarded</AlertTitle>
              <AlertDescription>
                {pendingDelete.configured_secrets.length} configured secret
                {pendingDelete.configured_secrets.length === 1 ? '' : 's'} for this source will be
                removed.
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && void remove(pendingDelete)}
              disabled={!!pendingDelete && busyId === pendingDelete.id}
            >
              {pendingDelete && busyId === pendingDelete.id ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden />
              )}
              Remove source
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
