/**
 * Memory — operator-managed durable facts the agents always know (NEW UI).
 *
 * Memory is a curated set of durable facts (internal IP ranges, known scanners,
 * naming conventions, standing exceptions) injected into every investigation and
 * chat turn as a DISTINCT TRUSTED operator block. A human can add / inline-edit /
 * retire facts here, or teach them conversationally in Chat ("remember: …" /
 * "forget …"), which the chat engine reflects back as a `memory_action`.
 *
 * Security: agent-authored facts (`source: 'agent'`) are source-influenceable, so
 * ALL memory text is rendered as PLAIN text (never markup). Memory NEVER overrides
 * the deterministic close/escalate decision — it only informs the LLM.
 *
 * Mirrors the legacy MemoryPage data wiring: api.getMemory / addMemory /
 * updateMemory / deleteMemory, optimistic local upsert, toasts, filters (search /
 * source / active / category), sort, group-by-category, inline edit + delete-confirm.
 */
import * as React from 'react';
import {
  Bot,
  CircleCheck,
  Folder,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Tag,
  Trash2,
  User,
  X,
  Brain,
} from 'lucide-react';
import { toast } from 'sonner';

import { api, type MemoryPatch } from '@/lib/api';
import type { MemoryEntry } from '@/lib/types';
import { DASH, fmtNumber, formatTimestamp, humanizeAge, humanizeToken } from '@/lib/format';
import { errorMessage } from '@/lib/errorMessage';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';
import { Card, CardContent } from '@/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';

import { PageHeader } from '@/soc/components/PageHeader';
import { KpiTile } from '@/soc/components/KpiTile';
import { EmptyState } from '@/soc/components/EmptyState';

/** Uncategorised facts collect under this stable bucket label. */
const UNCATEGORISED = 'Uncategorised';

/** Sentinel for the "any" option in single-select filters (Radix forbids ""). */
const ANY = '__any__';

type SortKey = 'updated' | 'created' | 'active' | 'category';
type SourceFilter = 'all' | 'human' | 'agent';
type ActiveFilter = 'all' | 'active' | 'inactive';

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Newest first' },
  { value: 'active', label: 'Active first' },
  { value: 'category', label: 'By category' },
];

const SOURCE_OPTIONS: Array<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: 'All authors' },
  { value: 'human', label: 'Operator' },
  { value: 'agent', label: 'Agent' },
];

const ACTIVE_OPTIONS: Array<{ value: ActiveFilter; label: string }> = [
  { value: 'all', label: 'All states' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

function isAgentEntry(e: MemoryEntry): boolean {
  return (e.source || '').toLowerCase() === 'agent';
}

/* --------------------------------------------------------------- source badge -- */

/** A small author pill — human (operator) vs agent (conversationally added). */
function SourceBadge({ source, author }: { source?: string; author?: string }) {
  const agent = (source || '').toLowerCase() === 'agent';
  const Icon = agent ? Bot : User;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant={agent ? 'info' : 'secondary'} className="gap-1">
              <Icon className="h-3 w-3" aria-hidden />
              {agent ? 'Agent' : 'Operator'}
              {author ? ` · ${author}` : ''}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {agent
            ? 'Authored by an agent (conversationally, in Chat). Treated as untrusted text.'
            : 'Authored by a human operator.'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/* ----------------------------------------------------------- add-memory card -- */

function AddMemoryCard({
  categories,
  onAdded,
}: {
  categories: string[];
  onAdded: (e: MemoryEntry) => void;
}) {
  const [text, setText] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [tagInput, setTagInput] = React.useState('');
  const [tags, setTags] = React.useState<string[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  const addTag = React.useCallback(() => {
    const v = tagInput.trim();
    if (!v) return;
    setTags((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setTagInput('');
  }, [tagInput]);

  const submit = React.useCallback(async () => {
    const body = text.trim();
    if (!body) return;
    setSubmitting(true);
    try {
      const entry = await api.addMemory({
        text: body,
        category: category.trim() || undefined,
        tags: tags.length ? tags : undefined,
      });
      onAdded(entry);
      setText('');
      setCategory('');
      setTags([]);
      setTagInput('');
      toast.success('Memory saved.');
    } catch (e) {
      toast.error(errorMessage(e, 'Could not save memory.'));
    } finally {
      setSubmitting(false);
    }
  }, [text, category, tags, onAdded]);

  return (
    <Card>
      <CardContent className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-muted/40 text-primary">
            <Plus className="h-4 w-4" aria-hidden />
          </span>
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-foreground">Add a memory</p>
            <p className="text-xs text-muted-foreground">
              A durable fact the agents should always know.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mem-text">Fact</Label>
          <Textarea
            id="mem-text"
            rows={2}
            placeholder="e.g. 10.20.0.0/16 is our internal corp network — never treat it as external."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mem-cat">Category (optional)</Label>
            <Input
              id="mem-cat"
              list="mem-category-suggestions"
              placeholder="e.g. network, scanners, policy"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="mem-category-suggestions">
              {categories.map((c) => (
                <option key={c} value={c}>
                  {humanizeToken(c)}
                </option>
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-tags">Tags (optional)</Label>
            <Input
              id="mem-tags"
              placeholder="Type a tag and press Enter"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag();
                }
              }}
            />
            {tags.length ? (
              <div className="flex flex-wrap gap-1 pt-1">
                {tags.map((t) => (
                  <Badge key={t} variant="outline" className="gap-1">
                    <Tag className="h-3 w-3" aria-hidden />
                    {t}
                    <button
                      type="button"
                      aria-label={`Remove tag ${t}`}
                      className="ml-0.5 rounded-sm hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!text.trim() || submitting}
          >
            <Plus className="h-4 w-4" aria-hidden />
            {submitting ? 'Saving…' : 'Save memory'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------------- memory row --- */

function MemoryRow({
  entry,
  busy,
  onSave,
  onToggleActive,
  onDelete,
}: {
  entry: MemoryEntry;
  busy: boolean;
  onSave: (id: string, patch: MemoryPatch) => Promise<void>;
  onToggleActive: (entry: MemoryEntry) => void;
  onDelete: (entry: MemoryEntry) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(entry.text);
  const [category, setCategory] = React.useState(entry.category || '');
  const [tagInput, setTagInput] = React.useState('');
  const [tags, setTags] = React.useState<string[]>(entry.tags || []);
  const [saving, setSaving] = React.useState(false);

  // Re-seed local edit buffers when the underlying entry changes (e.g. refresh),
  // unless the user is actively editing.
  React.useEffect(() => {
    if (!editing) {
      setText(entry.text);
      setCategory(entry.category || '');
      setTags(entry.tags || []);
    }
  }, [entry, editing]);

  const addTag = React.useCallback(() => {
    const v = tagInput.trim();
    if (!v) return;
    setTags((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setTagInput('');
  }, [tagInput]);

  const cancel = React.useCallback(() => {
    setEditing(false);
    setText(entry.text);
    setCategory(entry.category || '');
    setTags(entry.tags || []);
    setTagInput('');
  }, [entry]);

  const save = React.useCallback(async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await onSave(entry.id, {
        text: text.trim(),
        category: category.trim(),
        tags,
      });
      setEditing(false);
    } catch {
      /* toast surfaced by caller; keep the editor open */
    } finally {
      setSaving(false);
    }
  }, [entry.id, text, category, tags, onSave]);

  if (editing) {
    return (
      <Card className="border-primary/30 ring-1 ring-primary/10">
        <CardContent className="space-y-4 p-5">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Edit memory text"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Tags</Label>
              <Input
                placeholder="Type a tag and press Enter"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
              {tags.length ? (
                <div className="flex flex-wrap gap-1 pt-1">
                  {tags.map((t) => (
                    <Badge key={t} variant="outline" className="gap-1">
                      <Tag className="h-3 w-3" aria-hidden />
                      {t}
                      <button
                        type="button"
                        aria-label={`Remove tag ${t}`}
                        className="ml-0.5 rounded-sm hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!text.trim() || saving}>
              <Save className="h-4 w-4" aria-hidden />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="transition-colors hover:border-border/80">
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          {/* active accent rail */}
          <span
            className={cn(
              'mt-0.5 w-0.5 shrink-0 self-stretch rounded-full',
              entry.active ? 'bg-success/70' : 'bg-border',
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            {/* UNTRUSTED fact text — plain, never markup */}
            <p
              className={cn(
                'whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground',
                !entry.active && 'opacity-55',
              )}
            >
              {entry.text}
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <SourceBadge source={entry.source} author={entry.author} />
              {entry.category ? (
                <Badge variant="outline" className="gap-1">
                  <Folder className="h-3 w-3" aria-hidden />
                  {humanizeToken(entry.category)}
                </Badge>
              ) : null}
              {(entry.tags || []).map((t) => (
                <Badge key={t} variant="outline" className="gap-1">
                  <Tag className="h-3 w-3" aria-hidden />
                  {t}
                </Badge>
              ))}
              {!entry.active ? (
                <Badge variant="secondary" className="text-muted-foreground">
                  Inactive
                </Badge>
              ) : null}
              <span
                className="text-xs text-muted-foreground"
                title={formatTimestamp(entry.updated_at || entry.created_at)}
              >
                updated {humanizeAge(entry.updated_at || entry.created_at)}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center">
                    <Switch
                      checked={entry.active}
                      onCheckedChange={() => onToggleActive(entry)}
                      disabled={busy}
                      aria-label={entry.active ? 'Deactivate memory' : 'Activate memory'}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {entry.active ? 'Active — injected into prompts' : 'Inactive — retained, not injected'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Edit memory"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete memory"
              disabled={busy}
              className="text-critical hover:text-critical"
              onClick={() => onDelete(entry)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------- page --- */

export interface MemoryPageProps {
  onNavigate?: (page: any, opts?: any) => void;
  /**
   * When hosted as a tab inside the Intelligence scaffold (Round-2 W4 consolidation),
   * suppress the page's own PageHeader and surface only the Refresh action so the
   * host owns the title (no duplicate headers).
   */
  embedded?: boolean;
}

export default function Memory({ embedded = false }: MemoryPageProps = {}) {
  const [entries, setEntries] = React.useState<MemoryEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<MemoryEntry | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // view controls
  const [search, setSearch] = React.useState('');
  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>('all');
  const [activeFilter, setActiveFilter] = React.useState<ActiveFilter>('all');
  const [categoryFilter, setCategoryFilter] = React.useState<string>(ANY);
  const [sort, setSort] = React.useState<SortKey>('updated');
  const [grouped, setGrouped] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getMemory();
      setEntries(res.entries ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const upsertLocal = React.useCallback((next: MemoryEntry) => {
    setEntries((prev) => {
      const i = prev.findIndex((e) => e.id === next.id);
      if (i === -1) return [next, ...prev];
      const copy = prev.slice();
      copy[i] = next;
      return copy;
    });
  }, []);

  const onAdded = React.useCallback(
    (entry: MemoryEntry) => upsertLocal(entry),
    [upsertLocal],
  );

  const onSave = React.useCallback(
    async (id: string, patch: MemoryPatch) => {
      setBusyId(id);
      try {
        const next = await api.updateMemory(id, patch);
        upsertLocal(next);
        toast.success('Memory updated.');
      } catch (e) {
        toast.error(errorMessage(e, 'Could not update memory.'));
        throw e;
      } finally {
        setBusyId(null);
      }
    },
    [upsertLocal],
  );

  const onToggleActive = React.useCallback(
    async (entry: MemoryEntry) => {
      setBusyId(entry.id);
      try {
        const next = await api.updateMemory(entry.id, { active: !entry.active });
        upsertLocal(next);
      } catch (e) {
        toast.error(errorMessage(e, 'Could not update memory.'));
      } finally {
        setBusyId(null);
      }
    },
    [upsertLocal],
  );

  const runDelete = React.useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteMemory(pendingDelete.id);
      setEntries((prev) => prev.filter((e) => e.id !== pendingDelete.id));
      toast.success('Memory deleted.');
      setPendingDelete(null);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not delete memory.'));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete]);

  // derived summary + facets
  const stats = React.useMemo(() => {
    let active = 0;
    let operator = 0;
    let agent = 0;
    for (const e of entries) {
      if (e.active) active += 1;
      if (isAgentEntry(e)) agent += 1;
      else operator += 1;
    }
    return { total: entries.length, active, operator, agent };
  }, [entries]);

  const categoryFacet = React.useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.category) set.add(e.category);
    return Array.from(set).sort();
  }, [entries]);

  // Drop a selected category that no longer exists so the list can't silently empty.
  React.useEffect(() => {
    if (categoryFilter !== ANY && !categoryFacet.includes(categoryFilter)) {
      setCategoryFilter(ANY);
    }
  }, [categoryFacet, categoryFilter]);

  const filteredSorted = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = entries.filter((e) => {
      const agent = isAgentEntry(e);
      if (sourceFilter === 'agent' && !agent) return false;
      if (sourceFilter === 'human' && agent) return false;
      if (activeFilter === 'active' && !e.active) return false;
      if (activeFilter === 'inactive' && e.active) return false;
      if (categoryFilter !== ANY && e.category !== categoryFilter) return false;
      if (!q) return true;
      const hay = `${e.text} ${e.category || ''} ${(e.tags || []).join(' ')} ${
        e.author || ''
      }`.toLowerCase();
      return hay.includes(q);
    });
    const byTime = (e: MemoryEntry, useUpdated: boolean) =>
      (useUpdated ? e.updated_at || e.created_at : e.created_at) || '';
    return [...rows].sort((a, b) => {
      switch (sort) {
        case 'created':
          return byTime(b, false).localeCompare(byTime(a, false));
        case 'active':
          if (a.active !== b.active) return a.active ? -1 : 1;
          return byTime(b, true).localeCompare(byTime(a, true));
        case 'category':
          return (
            (a.category || UNCATEGORISED).localeCompare(b.category || UNCATEGORISED) ||
            byTime(b, true).localeCompare(byTime(a, true))
          );
        case 'updated':
        default:
          return byTime(b, true).localeCompare(byTime(a, true));
      }
    });
  }, [entries, search, sourceFilter, activeFilter, categoryFilter, sort]);

  const groups = React.useMemo(() => {
    if (!grouped) return null;
    const map = new Map<string, MemoryEntry[]>();
    for (const e of filteredSorted) {
      const key = e.category ? humanizeToken(e.category) : UNCATEGORISED;
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === UNCATEGORISED) return 1;
      if (b[0] === UNCATEGORISED) return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [filteredSorted, grouped]);

  const anyFilter =
    search.trim().length > 0 ||
    sourceFilter !== 'all' ||
    activeFilter !== 'all' ||
    categoryFilter !== ANY;

  const clearFilters = React.useCallback(() => {
    setSearch('');
    setSourceFilter('all');
    setActiveFilter('all');
    setCategoryFilter(ANY);
  }, []);

  const renderRow = (entry: MemoryEntry) => (
    <MemoryRow
      key={entry.id}
      entry={entry}
      busy={busyId === entry.id}
      onSave={onSave}
      onToggleActive={(e) => void onToggleActive(e)}
      onDelete={(e) => setPendingDelete(e)}
    />
  );

  const refreshAction = (
    <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
      <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
      Refresh
    </Button>
  );

  return (
    <div className="space-y-8">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-end gap-2">{refreshAction}</div>
      ) : (
        <PageHeader
          icon={Brain}
          eyebrow="Platform"
          title="Memory"
          description="Durable facts the agents always know — injected into every investigation and chat turn as trusted operator context."
          actions={refreshAction}
        />
      )}

      <Alert>
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>What is memory?</AlertTitle>
        <AlertDescription>
          A curated set of durable facts the agents always know — internal IP ranges, known
          scanners, naming conventions, standing exceptions. Active facts are injected into
          investigations and chat as a trusted operator block; they inform the LLM but{' '}
          <strong className="font-semibold text-foreground">
            never override the deterministic close/escalate decision
          </strong>
          . You can also say <strong className="font-semibold text-foreground">“remember: …”</strong>{' '}
          or <strong className="font-semibold text-foreground">“forget …”</strong> in Chat and the
          agent will manage memory for you.
        </AlertDescription>
      </Alert>

      {/* summary tiles */}
      {loading && entries.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label="Total facts" value={fmtNumber(stats.total)} icon={Brain} accent="primary" />
          <KpiTile
            label="Active"
            value={fmtNumber(stats.active)}
            icon={CircleCheck}
            accent="success"
            sub={stats.total > 0 ? `${fmtNumber(stats.total - stats.active)} inactive` : undefined}
          />
          <KpiTile
            label="Operator-authored"
            value={fmtNumber(stats.operator)}
            icon={User}
            accent="info"
          />
          <KpiTile
            label="Agent-authored"
            value={fmtNumber(stats.agent)}
            icon={Bot}
            accent="medium"
          />
        </div>
      )}

      <AddMemoryCard categories={categoryFacet} onAdded={onAdded} />

      {/* saved memories header + controls */}
      <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-base font-semibold text-foreground">Saved memories</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {loading
              ? 'Loading…'
              : `${fmtNumber(filteredSorted.length)} of ${fmtNumber(stats.total)} shown · ${fmtNumber(
                  stats.active,
                )} active`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* A native <label> does not forward clicks to a Radix Switch (a
              <button role="switch">); the Switch is self-labeled via aria-label.
              A <div> keeps the layout/behavior identical. */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={grouped} onCheckedChange={setGrouped} aria-label="Group by category" />
            Group by category
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-[12rem]" aria-label="Sort memories">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* filter toolbar */}
      {!error && entries.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="pl-8"
              placeholder="Search facts, category, tags…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search memories"
            />
          </div>
          {categoryFacet.length > 0 ? (
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[12rem]" aria-label="Filter by category">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All categories</SelectItem>
                {categoryFacet.map((c) => (
                  <SelectItem key={c} value={c}>
                    {humanizeToken(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
            <SelectTrigger className="w-[11rem]" aria-label="Filter by author">
              <SelectValue placeholder="Author" />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={activeFilter} onValueChange={(v) => setActiveFilter(v as ActiveFilter)}>
            <SelectTrigger className="w-[10rem]" aria-label="Filter by active state">
              <SelectValue placeholder="State" />
            </SelectTrigger>
            <SelectContent>
              {ACTIVE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {anyFilter ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="h-4 w-4" aria-hidden />
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* list / states */}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load memory</AlertTitle>
          <AlertDescription>{errorMessage(error, 'An unexpected error occurred.')}</AlertDescription>
        </Alert>
      ) : loading && entries.length === 0 ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={Brain}
          title="No memories yet"
          description="Add a durable fact above, or teach the agent one conversationally in Chat with “remember: …”."
        />
      ) : filteredSorted.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No memories match"
          description="No facts match the current filters. Clear them to see all memories."
          action={
            <Button size="sm" variant="outline" onClick={clearFilters}>
              <X className="h-4 w-4" aria-hidden />
              Clear filters
            </Button>
          }
        />
      ) : groups ? (
        <div className="space-y-8">
          {groups.map(([label, rows]) => (
            <div key={label} className="space-y-3">
              <div className="flex items-center gap-2 border-b border-border pb-2">
                <Folder className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {label}
                </h3>
                <span className="text-xs tabular-nums text-muted-foreground/70">
                  {fmtNumber(rows.length)} fact{rows.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="space-y-3">{rows.map(renderRow)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">{filteredSorted.map(renderRow)}</div>
      )}

      {/* footer note */}
      <p className="border-t border-border pt-4 text-xs text-muted-foreground">
        Inactive memories are retained but not injected into prompts — toggle{' '}
        <strong className="font-semibold text-foreground">Active</strong> off to retire a fact
        without deleting it. Agent-authored facts are treated as untrusted text and rendered as
        plain text. {DASH}
      </p>

      {/* delete confirm */}
      <Dialog open={!!pendingDelete} onOpenChange={(o) => (!o ? setPendingDelete(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this memory?</DialogTitle>
            <DialogDescription>
              The agents will no longer know this fact. To retire it without deleting, toggle Active
              off instead.
            </DialogDescription>
          </DialogHeader>
          {pendingDelete ? (
            <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">
              “{pendingDelete.text}”
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void runDelete()} disabled={deleting}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
