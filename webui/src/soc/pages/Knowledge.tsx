/**
 * Knowledge / RAG — the operator-facing window into the retrieval corpus the
 * investigator draws on. Rebuilt for the new SOC console (Tailwind + shadcn-style
 * primitives) while preserving the legacy data wiring + features verbatim:
 *
 *   - a corpus-health header (KPI tiles: total chunks, documents, embedding
 *     model, vector dimensions) + a "Corpus by source" BarList,
 *   - an Import card (paste text OR upload one-or-more .txt/.md/.json/.csv files,
 *     read client-side via FileReader, queued + indexed in sequence; the title is
 *     auto-filled from the filename) + tags + a soft size guard,
 *   - a "Try a retrieval" card that runs GET /api/rag/search and shows the exact,
 *     score-bearing chunks RAG would return for a query, ranked highest-first,
 *   - an indexed-documents DataTable with search, a source facet, sort, a density
 *     toggle, per-row view (a drill-in Sheet of the document's CHUNKS) + delete
 *     (guarded seed sources force-delete after a confirm),
 *   - an UNTRUSTED footer note.
 *
 * Security: indexed / retrieved / source / model text is UNTRUSTED — always
 * rendered as PLAIN text or inside <CodeBlock>/<InlineCode>, never as markup.
 * Secrets are never shown.
 */
import * as React from 'react';
import {
  AlertCircle,
  BarChart3,
  Boxes,
  CheckCircle2,
  Cpu,
  FileText,
  Gauge,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

import type { Navigate } from '@/soc/router';
import { api, ApiError } from '@/lib/api';
import type {
  RagChunk,
  RagDocument,
  RagStats,
} from '@/lib/types';
import { DASH, fmtNumber, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';
import { toast } from 'sonner';

import { PageHeader } from '@/soc/components/PageHeader';
import { Can, useCan } from '@/soc/components/Can';
import { KpiTile, type KpiAccent } from '@/soc/components/KpiTile';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import {
  DataTable,
  type DataTableColumn,
  type SortState,
} from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { Stagger } from '@/soc/components/Stagger';

import { Button } from '@/ui/button';
import { Badge, type BadgeProps } from '@/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/ui/card';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Skeleton } from '@/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Progress } from '@/ui/progress';
import { Separator } from '@/ui/separator';
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
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';

/* ------------------------------------------------------------- constants ----- */

/** Soft per-import size guard (mirrors the backend's oversized-document 400). */
const MAX_IMPORT_BYTES = 256 * 1024; // ~256 KB
const MAX_IMPORT_KB = Math.round(MAX_IMPORT_BYTES / 1024);
const IMPORT_ACCEPT = '.txt,.md,.json,.csv,text/*';

const TOP_K_DEFAULT = 5;
/** Display-only similarity floor (the backend owns the real retrieval floor). */
const MIN_SIMILARITY_HINT = '0.70';

const DENSITY_LS_KEY = 'tlsoc.knowledge.density';

type Density = 'normal' | 'compact';
type SortField = 'title' | 'source' | 'chunk_count' | 'added_at';

/* ------------------------------------------------------------- helpers -------- */

/** Map a corpus source label → a semantic badge variant (stable per kind). */
function sourceBadgeVariant(source?: string): BadgeProps['variant'] {
  const s = (source || '').toLowerCase();
  if (s.includes('runbook') || s.includes('playbook')) return 'info';
  if (s.includes('case') || s.includes('resolved')) return 'success';
  if (s.includes('mitre')) return 'critical';
  if (s.includes('threat')) return 'critical';
  if (s.includes('import') || s.includes('manual') || s.includes('upload'))
    return 'default';
  if (s.includes('suppression')) return 'warning';
  return 'secondary';
}

/** A bar color token class for a corpus source (used by the BarList). */
function sourceBarColor(source?: string): string {
  const s = (source || '').toLowerCase();
  if (s.includes('runbook') || s.includes('playbook')) return 'bg-info';
  if (s.includes('case') || s.includes('resolved')) return 'bg-success';
  if (s.includes('mitre') || s.includes('threat')) return 'bg-critical';
  if (s.includes('suppression')) return 'bg-warning';
  return 'bg-accent-bar';
}

/** Heuristic: which corpus sources are guarded seed material (force-delete only). */
function isSeedSource(source?: string): boolean {
  const s = (source || '').toLowerCase();
  return (
    s.includes('runbook') ||
    s.includes('playbook') ||
    s.includes('mitre') ||
    s.includes('suppression') ||
    s.includes('resolved')
  );
}

/** A score → semantic variant (relevance strength). */
function scoreVariant(score: number): BadgeProps['variant'] {
  if (score >= 0.66) return 'success';
  if (score >= 0.33) return 'warning';
  return 'secondary';
}

function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_LS_KEY) === 'compact' ? 'compact' : 'normal';
  } catch {
    return 'normal';
  }
}

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

/** A soft tinted icon chip for card headers (matches PageHeader/KpiTile calm look). */
const CardIcon: React.FC<{ icon: LucideIcon }> = ({ icon: Icon }) => (
  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
    <Icon className="size-4" aria-hidden />
  </span>
);

/* ------------------------------------------------------------- badges --------- */

/** A corpus source badge (UNTRUSTED label → humanized plain text). */
const SourceBadge: React.FC<{ source?: string; className?: string }> = ({
  source,
  className,
}) => {
  if (!source)
    return (
      <Badge variant="outline" className={className}>
        {DASH}
      </Badge>
    );
  return (
    <Badge variant={sourceBadgeVariant(source)} className={className}>
      <Tag className="size-3" aria-hidden />
      {humanizeToken(source)}
    </Badge>
  );
};

/** A retrieval-score badge whose color reflects relevance strength. */
const ScoreBadge: React.FC<{ score: number }> = ({ score }) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant={scoreVariant(score)}>
            <Gauge className="size-3" aria-hidden />
            score {score.toFixed(3)}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Hybrid retrieval relevance score (higher is a closer match)
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

/* ----------------------------------------------------------- chunk view ------- */

/** Render a single retrieval chunk — text is UNTRUSTED, always fenced. */
const ChunkBlock: React.FC<{ chunk: RagChunk; index: number; rank?: number }> = ({
  chunk,
  index,
  rank,
}) => {
  const chunkIdx = typeof chunk.chunk_index === 'number' ? chunk.chunk_index : index;
  return (
    <div className="rounded-md border border-border bg-surface p-3.5">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        {typeof rank === 'number' ? (
          <Badge variant="default">#{rank}</Badge>
        ) : null}
        <Badge variant="outline">
          <Layers className="size-3" aria-hidden />
          chunk {chunkIdx}
        </Badge>
        <SourceBadge source={chunk.source} />
        {typeof chunk.score === 'number' ? <ScoreBadge score={chunk.score} /> : null}
      </div>
      <CodeBlock value={chunk.text || ''} wrap copyable />
    </div>
  );
};

/* ----------------------------------------------------------- document drill --- */

const DocumentSheet: React.FC<{
  documentId: string | null;
  onClose: () => void;
}> = ({ documentId, onClose }) => {
  const [doc, setDoc] = React.useState<RagDocument | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [filter, setFilter] = React.useState('');

  React.useEffect(() => {
    if (!documentId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setDoc(null);
    setFilter('');
    void (async () => {
      try {
        const res = await api.ragDocument(documentId);
        if (alive) setDoc(res);
      } catch (e) {
        if (alive) setError(e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [documentId]);

  const chunks = doc?.chunks ?? [];
  const shownChunks = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return chunks;
    return chunks.filter((c) => (c.text || '').toLowerCase().includes(q));
  }, [chunks, filter]);

  const chunkCount = doc?.chunk_count ?? chunks.length;

  return (
    <Sheet open={!!documentId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" size="lg" className="overflow-y-auto p-0">
        <SheetHeader>
          {/* Title is UNTRUSTED — plain text. */}
          <SheetTitle className="pr-8 break-words">
            {doc?.title || 'Document'}
          </SheetTitle>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <SourceBadge source={doc?.source} />
            <Badge variant="outline">
              <FileText className="size-3" aria-hidden />
              {fmtNumber(chunkCount)} chunk{chunkCount === 1 ? '' : 's'}
            </Badge>
            {doc?.embedding_model ? (
              <Badge variant="outline">
                <Cpu className="size-3" aria-hidden />
                {doc.embedding_model}
                {typeof doc.dim === 'number' ? ` · ${doc.dim}d` : ''}
              </Badge>
            ) : null}
            {isSeedSource(doc?.source) ? (
              <Badge variant="warning">
                <Lock className="size-3" aria-hidden />
                Seed source
              </Badge>
            ) : null}
            {doc?.added_at ? (
              <span className="text-xs text-muted-foreground">
                added {humanizeAge(doc.added_at)}
              </span>
            ) : null}
          </div>
          {doc?.tags && doc.tags.length ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {doc.tags.map((t) => (
                <Badge key={t} variant="outline">
                  <Tag className="size-3" aria-hidden />
                  {t}
                </Badge>
              ))}
            </div>
          ) : null}
        </SheetHeader>

        <div className="flex-1 space-y-3 p-6">
          {error ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>Could not load document</AlertTitle>
              <AlertDescription>{errMessage(error, 'Request failed.')}</AlertDescription>
            </Alert>
          ) : loading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : chunks.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No chunks"
              description="This document produced no retrievable chunks."
            />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                These are the exact units the retriever returns. The investigator sees
                the highest-scoring chunks for a query — text is treated as untrusted
                evidence.
              </p>
              {chunks.length > 4 ? (
                <div className="space-y-1.5">
                  <Input
                    placeholder="Filter chunks by text…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter chunks"
                  />
                  <p className="text-xs text-muted-foreground">
                    {fmtNumber(shownChunks.length)} of {fmtNumber(chunks.length)} chunks
                  </p>
                </div>
              ) : null}
              <div className="flex flex-col gap-3">
                {shownChunks.map((ch, i) => (
                  <ChunkBlock
                    key={i}
                    chunk={ch}
                    index={ch.chunk_index ?? i}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};

/* ------------------------------------------------------------------- import --- */

/** One queued file waiting to be (or being) indexed. */
interface QueuedFile {
  name: string;
  text: string;
  bytes: number;
  tooBig: boolean;
}

const ImportCard: React.FC<{ onImported: () => void }> = ({ onImported }) => {
  const [title, setTitle] = React.useState('');
  const [text, setText] = React.useState('');
  const [source, setSource] = React.useState('');
  const [tagInput, setTagInput] = React.useState('');
  const [tags, setTags] = React.useState<string[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(
    null,
  );
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [queue, setQueue] = React.useState<QueuedFile[]>([]);
  // The file <input> is uncontrolled — bump this key to reset its value after a read.
  const [pickerKey, setPickerKey] = React.useState(0);

  const bytes = React.useMemo(() => new Blob([text]).size, [text]);
  const tooBig = bytes > MAX_IMPORT_BYTES;
  const hasPasted = title.trim().length > 0 && text.trim().length > 0;
  const queueValid = queue.length > 0 && queue.every((q) => !q.tooBig);
  const batching = queue.length > 0;
  const canSubmit = (hasPasted ? !tooBig : queueValid) && !submitting;

  const readFile = (file: File): Promise<QueuedFile> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const content = String(reader.result || '');
        const b = new Blob([content]).size;
        resolve({ name: file.name, text: content, bytes: b, tooBig: b > MAX_IMPORT_BYTES });
      };
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsText(file);
    });

  const onPick = React.useCallback(
    async (files: FileList | null) => {
      setFileError(null);
      const list = files ? Array.from(files) : [];
      if (list.length === 0) {
        setQueue([]);
        return;
      }
      // Single file + empty paste area → fill the paste fields inline (legacy flow).
      // Multiple files → queue them for sequential indexing.
      if (list.length === 1 && !text.trim()) {
        try {
          const qf = await readFile(list[0]);
          if (qf.tooBig) {
            setFileError(
              `"${qf.name}" is ${fmtNumber(qf.bytes)} bytes — keep documents under ${MAX_IMPORT_KB} KB.`,
            );
            return;
          }
          setText(qf.text);
          setTitle((prev) => prev.trim() || list[0].name.replace(/\.[^.]+$/, ''));
          setQueue([]);
        } catch (e) {
          setFileError(errMessage(e, 'Could not read file.'));
        }
        return;
      }
      try {
        const read = await Promise.all(list.map(readFile));
        setQueue(read);
      } catch (e) {
        setFileError(errMessage(e, 'Could not read files.'));
      }
    },
    [text],
  );

  const addTag = React.useCallback((raw: string) => {
    const label = raw.trim();
    if (!label) return;
    setTags((prev) => (prev.includes(label) ? prev : [...prev, label]));
    setTagInput('');
  }, []);

  const reset = React.useCallback(() => {
    setTitle('');
    setText('');
    setSource('');
    setTagInput('');
    setTags([]);
    setQueue([]);
    setFileError(null);
    setPickerKey((k) => k + 1);
  }, []);

  const submit = React.useCallback(async () => {
    const tagList = tags.map((t) => t.trim()).filter(Boolean);
    const src = source.trim() || undefined;
    setSubmitting(true);
    try {
      if (queue.length > 0) {
        let totalChunks = 0;
        setProgress({ done: 0, total: queue.length });
        for (let i = 0; i < queue.length; i += 1) {
          const qf = queue[i];
          const res = await api.ragImport({
            title: qf.name.replace(/\.[^.]+$/, ''),
            text: qf.text,
            source: src,
            tags: tagList,
          });
          totalChunks += res.chunk_count ?? 0;
          setProgress({ done: i + 1, total: queue.length });
        }
        toast.success(
          `Indexed ${fmtNumber(queue.length)} document${queue.length === 1 ? '' : 's'} (${fmtNumber(
            totalChunks,
          )} chunk${totalChunks === 1 ? '' : 's'}).`,
        );
      } else {
        const res = await api.ragImport({
          title: title.trim(),
          text,
          source: src,
          tags: tagList,
        });
        toast.success(
          `Indexed "${res.title}" (${fmtNumber(res.chunk_count)} chunk${
            res.chunk_count === 1 ? '' : 's'
          }).`,
        );
      }
      reset();
      onImported();
    } catch (e) {
      toast.error(errMessage(e, 'Import failed.'));
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }, [title, text, source, tags, queue, reset, onImported]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardIcon icon={Upload} />
          <CardTitle>Import knowledge</CardTitle>
        </div>
        <CardDescription className="pt-1">
          Index documents into the retrieval corpus. Paste text, or upload one or more
          .txt / .md / .json / .csv files (each becomes its own document); the
          investigator can then retrieve them during triage.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rag-title">Title</Label>
            <Input
              id="rag-title"
              placeholder={batching ? 'From each filename' : 'e.g. Internal IP allocation guide'}
              value={batching ? '' : title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={batching}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rag-source">Source (optional)</Label>
            <Input
              id="rag-source"
              placeholder="manual"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A label that groups these in the corpus.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="rag-text">Document text</Label>
          <Textarea
            id="rag-text"
            rows={6}
            placeholder="Paste the document text here, or upload files below…"
            value={batching ? '' : text}
            onChange={(e) => setText(e.target.value)}
            disabled={batching}
            className={cn(tooBig && 'border-critical focus-visible:ring-critical')}
          />
          <p className={cn('text-xs', tooBig ? 'text-critical' : 'text-muted-foreground')}>
            {batching
              ? 'Disabled while files are queued.'
              : tooBig
                ? `Too large — keep documents under ${MAX_IMPORT_KB} KB.`
                : `${fmtNumber(bytes)} bytes`}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="rag-files">…or upload files</Label>
          <Input
            id="rag-files"
            key={pickerKey}
            type="file"
            multiple
            accept={IMPORT_ACCEPT}
            onChange={(e) => void onPick(e.target.files)}
            className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border file:border-border file:bg-muted file:px-2 file:py-0.5"
          />
          <p className={cn('text-xs', fileError ? 'text-critical' : 'text-muted-foreground')}>
            {fileError ?? 'Select one file to fill the editor, or several to batch-index them.'}
          </p>
        </div>

        {batching ? (
          <div className="rounded-md border border-border bg-surface p-3.5">
            <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {fmtNumber(queue.length)} file{queue.length === 1 ? '' : 's'} queued
            </p>
            <ul className="flex flex-col gap-1.5">
              {queue.map((q, i) => (
                <li key={`${q.name}-${i}`} className="flex items-center gap-2 text-xs">
                  <Badge variant={q.tooBig ? 'critical' : 'success'}>
                    {q.tooBig ? 'too big' : 'ready'}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono break-all">
                    {q.name}
                  </span>
                  <span className={cn(q.tooBig ? 'text-critical' : 'text-muted-foreground')}>
                    {fmtNumber(q.bytes)} B
                  </span>
                </li>
              ))}
            </ul>
            {!queueValid ? (
              <p className="mt-2 text-xs text-critical">
                Some files exceed {MAX_IMPORT_KB} KB — remove them and re-select.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="rag-tags">Tags (optional)</Label>
          <Input
            id="rag-tags"
            placeholder="Type a tag and press enter…"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag(tagInput);
              }
            }}
          />
          {tags.length ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {tags.map((t) => (
                <Badge key={t} variant="secondary" className="gap-1">
                  {t}
                  <button
                    type="button"
                    onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                    className="rounded-sm hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label={`Remove tag ${t}`}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Applied to every imported document.
            </p>
          )}
        </div>

        {progress ? (
          <div className="space-y-1">
            <Progress
              value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
            />
            <p className="text-xs text-muted-foreground">
              Indexing {progress.done} / {progress.total}
            </p>
          </div>
        ) : null}

        <div className="mt-auto flex items-center justify-end gap-2 pt-2">
          {hasPasted || batching ? (
            <Button variant="ghost" size="sm" onClick={reset} disabled={submitting}>
              <X aria-hidden />
              Clear
            </Button>
          ) : null}
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            <Plus aria-hidden />
            {batching
              ? `Index ${fmtNumber(queue.length)} document${queue.length === 1 ? '' : 's'}`
              : 'Index document'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

/* --------------------------------------------------------- threat-intel import */

/**
 * Import a threat-intel note into the RAG corpus as source="threat_context". It is
 * retrieved + injected into investigations as a clearly-labelled TRUSTED fenced
 * block (the content itself is UNTRUSTED corpus material). Gated by rag:manage.
 */
const ThreatIntelImportCard: React.FC<{ onImported: () => void }> = ({ onImported }) => {
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  const [tagInput, setTagInput] = React.useState('');
  const [tags, setTags] = React.useState<string[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  const bytes = React.useMemo(() => new Blob([content]).size, [content]);
  const tooBig = bytes > MAX_IMPORT_BYTES;
  const canSubmit = title.trim().length > 0 && content.trim().length > 0 && !tooBig && !submitting;

  const addTag = React.useCallback((raw: string) => {
    const label = raw.trim();
    if (!label) return;
    setTags((prev) => (prev.includes(label) ? prev : [...prev, label]));
    setTagInput('');
  }, []);

  const submit = React.useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await api.threatContext.import({
        title: title.trim(),
        content,
        tags: tags.map((t) => t.trim()).filter(Boolean),
      });
      toast.success(
        `Indexed threat intel "${res.title}" (${fmtNumber(res.chunk_count)} chunk${
          res.chunk_count === 1 ? '' : 's'
        }).`,
      );
      setTitle('');
      setContent('');
      setTags([]);
      setTagInput('');
      onImported();
    } catch (e) {
      toast.error(errMessage(e, 'Threat-intel import failed.'));
    } finally {
      setSubmitting(false);
    }
  }, [title, content, tags, onImported]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardIcon icon={ShieldAlert} />
          <CardTitle>Import threat intel</CardTitle>
        </div>
        <CardDescription className="pt-1">
          Add a threat-intel note (actor TTPs, IOC writeups, advisories). It is indexed as{' '}
          <code className="font-mono text-xs">threat_context</code> and injected into
          investigations as a clearly-labelled TRUSTED fenced block — the content is treated as
          untrusted evidence, never executed as instructions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="ti-title">Title</Label>
          <Input
            id="ti-title"
            placeholder="e.g. APT-XX credential-stuffing advisory"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ti-content">Content</Label>
          <Textarea
            id="ti-content"
            rows={6}
            placeholder="Paste the threat-intel writeup, IOC list, or advisory text…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className={cn(tooBig && 'border-critical focus-visible:ring-critical')}
          />
          <p className={cn('text-xs', tooBig ? 'text-critical' : 'text-muted-foreground')}>
            {tooBig ? `Too large — keep notes under ${MAX_IMPORT_KB} KB.` : `${fmtNumber(bytes)} bytes`}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ti-tags">Tags (optional)</Label>
          <Input
            id="ti-tags"
            placeholder="Type a tag and press enter…"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag(tagInput);
              }
            }}
          />
          {tags.length ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {tags.map((t) => (
                <Badge key={t} variant="secondary" className="gap-1">
                  {t}
                  <button
                    type="button"
                    onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                    className="rounded-sm hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label={`Remove tag ${t}`}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
        <div className="mt-auto flex items-center justify-end gap-2 pt-2">
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            <Plus aria-hidden />
            Index threat intel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

/* ----------------------------------------------- threat-intel / resolved lists */

/** A compact, filtered list of corpus documents for one source kind. */
const CorpusSourceSection: React.FC<{
  icon: LucideIcon;
  title: string;
  description: string;
  match: (source?: string) => boolean;
  documents: RagDocument[];
  loading: boolean;
  emptyHint: string;
  onOpen: (id: string) => void;
}> = ({ icon: Icon, title, description, match, documents, loading, emptyHint, onOpen }) => {
  const rows = React.useMemo(
    () => documents.filter((d) => match(d.source)),
    [documents, match],
  );
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-3">
          <CardIcon icon={Icon} />
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription className="mt-0.5">{description}</CardDescription>
          </div>
        </div>
        <Badge variant="outline">
          {fmtNumber(rows.length)} doc{rows.length === 1 ? '' : 's'}
        </Badge>
      </CardHeader>
      <CardContent>
        {loading && documents.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Icon} compact title="Nothing here yet" description={emptyHint} />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((d) => (
              <li
                key={d.document_id}
                className="flex flex-wrap items-center gap-2 py-2.5 first:pt-0 last:pb-0"
              >
                <button
                  type="button"
                  onClick={() => onOpen(d.document_id)}
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  title={d.title || d.document_id}
                >
                  {/* UNTRUSTED title → plain text. */}
                  {d.title || d.document_id}
                </button>
                <Badge variant="outline" className="shrink-0">
                  <Layers className="size-3" aria-hidden />
                  {fmtNumber(d.chunk_count)} chunk{d.chunk_count === 1 ? '' : 's'}
                </Badge>
                {d.added_at ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {humanizeAge(d.added_at)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};

const isThreatContextSource = (s?: string): boolean =>
  (s || '').toLowerCase().includes('threat_context') ||
  (s || '').toLowerCase().includes('threat-context') ||
  (s || '').toLowerCase() === 'threat_intel';
const isResolvedCaseSource = (s?: string): boolean =>
  (s || '').toLowerCase().includes('resolved_case') ||
  (s || '').toLowerCase().includes('resolved-case');

/* ------------------------------------------------------------------- search --- */

const SearchCard: React.FC = () => {
  const [q, setQ] = React.useState('');
  const [lastQuery, setLastQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [results, setResults] = React.useState<RagChunk[] | null>(null);
  const [topK, setTopK] = React.useState(TOP_K_DEFAULT);

  const run = React.useCallback(async () => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    setLastQuery(query);
    try {
      const res = await api.ragSearch(query, topK);
      setResults(res.chunks ?? []);
    } catch (e) {
      setError(e);
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, [q, topK]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardIcon icon={Search} />
          <CardTitle>Try a retrieval</CardTitle>
        </div>
        <CardDescription className="pt-1">
          See exactly what RAG would return for a query — the same chunks the
          investigator gets, ranked by relevance.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="rag-query">Query</Label>
            <Input
              id="rag-query"
              placeholder="e.g. brute force from a known scanner"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void run();
                }
              }}
              aria-label="Retrieval query"
            />
          </div>
          <Button
            size="sm"
            onClick={() => void run()}
            disabled={!q.trim() || loading}
          >
            <Search aria-hidden />
            Run
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="rag-topk">Top-K results</Label>
            <Input
              id="rag-topk"
              type="number"
              min={1}
              max={20}
              value={topK}
              onChange={(e) => {
                const n = Number(e.target.value);
                setTopK(
                  Number.isFinite(n)
                    ? Math.min(20, Math.max(1, Math.round(n)))
                    : TOP_K_DEFAULT,
                );
              }}
              aria-label="Top-K results"
            />
            <p className="text-xs text-muted-foreground">
              How many ranked chunks to return.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rag-minsim">Min. similarity</Label>
            <Input id="rag-minsim" value={MIN_SIMILARITY_HINT} disabled aria-label="Minimum similarity" />
            <p className="text-xs text-muted-foreground">
              Retrieval floor (set on the backend).
            </p>
          </div>
        </div>

        <div className="flex-1">
          {error ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>Search failed</AlertTitle>
              <AlertDescription>{errMessage(error, 'Request failed.')}</AlertDescription>
            </Alert>
          ) : loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : results === null ? (
            <p className="text-xs text-muted-foreground">
              Run a query to preview the retrieved chunks.
            </p>
          ) : results.length === 0 ? (
            <EmptyState
              icon={Search}
              compact
              title="No matches"
              description="Nothing in the corpus scored above the retrieval floor for this query."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="default">
                  <Search className="size-3" aria-hidden />
                  {fmtNumber(results.length)} hit{results.length === 1 ? '' : 's'}
                </Badge>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  for "{lastQuery}", ranked highest-first
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {results.map((ch, i) => (
                  <ChunkBlock key={i} chunk={ch} index={i} rank={i + 1} />
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

/* -------------------------------------------------------------- documents ----- */

const DocumentsSection: React.FC<{
  documents: RagDocument[];
  loading: boolean;
  onOpen: (id: string) => void;
  onDelete: (doc: RagDocument) => void;
}> = ({ documents, loading, onOpen, onDelete }) => {
  const [search, setSearch] = React.useState('');
  const [sourceFilter, setSourceFilter] = React.useState<string>('all');
  const [sort, setSort] = React.useState<SortState>({ id: 'added_at', dir: 'desc' });
  const [density, setDensity] = React.useState<Density>(readDensity);

  const changeDensity = React.useCallback((id: Density) => {
    setDensity(id);
    try {
      localStorage.setItem(DENSITY_LS_KEY, id);
    } catch {
      /* private mode / quota — density is non-critical, ignore */
    }
  }, []);

  const sourceFacet = React.useMemo(() => {
    const set = new Set<string>();
    for (const d of documents) if (d.source) set.add(d.source);
    return Array.from(set).sort();
  }, [documents]);

  // Drop a selected source that no longer exists so the list can't silently empty.
  React.useEffect(() => {
    if (sourceFilter !== 'all' && !sourceFacet.includes(sourceFilter)) {
      setSourceFilter('all');
    }
  }, [sourceFacet, sourceFilter]);

  const filteredSorted = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = documents.filter((d) => {
      if (sourceFilter !== 'all' && d.source !== sourceFilter) return false;
      if (!q) return true;
      const hay =
        `${d.title} ${d.source} ${(d.tags || []).join(' ')} ${d.document_id}`.toLowerCase();
      return hay.includes(q);
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    const field = sort.id as SortField;
    return [...rows].sort((a, b) => {
      switch (field) {
        case 'title':
          return (a.title || a.document_id).localeCompare(b.title || b.document_id) * dir;
        case 'source':
          return (a.source || '').localeCompare(b.source || '') * dir;
        case 'chunk_count':
          return ((a.chunk_count ?? 0) - (b.chunk_count ?? 0)) * dir;
        case 'added_at':
        default:
          return (a.added_at || '').localeCompare(b.added_at || '') * dir;
      }
    });
  }, [documents, search, sourceFilter, sort]);

  const compact = density === 'compact';
  const anyFilter = search.trim().length > 0 || sourceFilter !== 'all';

  const clearFilters = React.useCallback(() => {
    setSearch('');
    setSourceFilter('all');
  }, []);

  const columns = React.useMemo<DataTableColumn<RagDocument>[]>(() => {
    const cols: DataTableColumn<RagDocument>[] = [
      {
        id: 'title',
        header: 'Title',
        sortable: true,
        cell: (d) => (
          <div className="min-w-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(d.document_id);
              }}
              className="text-left font-semibold text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              {/* UNTRUSTED title → plain text. */}
              {d.title || d.document_id}
            </button>
            {!compact && d.tags && d.tags.length ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {d.tags.slice(0, 4).map((t) => (
                  <Badge key={t} variant="outline">
                    <Tag className="size-3" aria-hidden />
                    {t}
                  </Badge>
                ))}
                {d.tags.length > 4 ? (
                  <Badge variant="outline">+{d.tags.length - 4}</Badge>
                ) : null}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'source',
        header: 'Source',
        sortable: true,
        width: '12rem',
        cell: (d) => (
          <div className="flex items-center gap-1.5">
            <SourceBadge source={d.source} />
            {isSeedSource(d.source) ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex text-warning">
                      <Lock className="size-3.5" aria-hidden />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Guarded seed corpus — delete requires force-confirm.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
        ),
      },
      {
        id: 'chunk_count',
        header: 'Chunks',
        sortable: true,
        width: '6rem',
        align: 'right',
        cell: (d) => (
          <span className="font-mono tabular-nums">{fmtNumber(d.chunk_count)}</span>
        ),
      },
    ];

    if (!compact) {
      cols.push({
        id: 'embedding_model',
        header: 'Model',
        cell: (d) =>
          d.embedding_model ? (
            <span className="font-mono text-xs">
              {d.embedding_model}
              {typeof d.dim === 'number' ? ` · ${d.dim}d` : ''}
            </span>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          ),
      });
    }

    cols.push(
      {
        id: 'added_at',
        header: 'Added',
        sortable: true,
        width: '7rem',
        cell: (d) => (
          <span className="text-muted-foreground">{humanizeAge(d.added_at)}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        width: '6rem',
        align: 'right',
        cell: (d) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(d.document_id);
              }}
              aria-label="View document chunks"
            >
              <Search className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-critical hover:text-critical"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(d);
              }}
              aria-label="Delete from the corpus"
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        ),
      },
    );

    return cols;
  }, [compact, onOpen, onDelete]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <CardIcon icon={FileText} />
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              Indexed documents
            </h2>
            <p className="text-xs text-muted-foreground">
              {loading
                ? 'Loading…'
                : `${fmtNumber(filteredSorted.length)} of ${fmtNumber(documents.length)} shown`}
            </p>
          </div>
        </div>
        {/* density toggle */}
        <div
          role="group"
          aria-label="Table density"
          className="inline-flex shrink-0 rounded-md border border-border bg-surface p-0.5"
        >
          {(['normal', 'compact'] as Density[]).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => changeDensity(d)}
              aria-pressed={density === d}
              className={cn(
                'rounded-sm px-3 py-1 text-xs font-medium transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                density === d
                  ? 'bg-card text-foreground shadow-elev1'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {d === 'normal' ? 'Comfortable' : 'Compact'}
            </button>
          ))}
        </div>
      </div>

      {/* filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            placeholder="Search title, source, tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
            aria-label="Search documents"
          />
        </div>
        {sourceFacet.length > 1 ? (
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[12rem]" aria-label="Filter by source">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {sourceFacet.map((s) => (
                <SelectItem key={s} value={s}>
                  {humanizeToken(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {anyFilter ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X aria-hidden />
            Clear
          </Button>
        ) : null}
      </div>

      {!loading && documents.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileText}
            title="The corpus is empty"
            description="Import a document above, or seed the backend's runbooks/playbooks to populate retrieval knowledge."
          />
        </Card>
      ) : !loading && filteredSorted.length === 0 ? (
        <Card>
          <EmptyState
            icon={Search}
            title="No documents match"
            description="No indexed documents match the current filters. Clear them to see all documents."
            action={
              <Button size="sm" variant="outline" onClick={clearFilters}>
                <X aria-hidden />
                Clear filters
              </Button>
            }
          />
        </Card>
      ) : (
        <DataTable<RagDocument>
          columns={columns}
          rows={filteredSorted}
          getRowId={(d) => d.document_id}
          sort={sort}
          onSortChange={setSort}
          onRowClick={(d) => onOpen(d.document_id)}
          loading={loading && documents.length === 0}
          density={density}
          ariaLabel="Indexed RAG documents"
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------- delete dialog -- */

interface PendingDelete {
  doc: RagDocument;
  force: boolean;
  guard: string | null;
}

const DeleteDialog: React.FC<{
  pending: PendingDelete | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ pending, deleting, onCancel, onConfirm }) => {
  if (!pending) return null;
  const { doc, force, guard } = pending;
  const seed = isSeedSource(doc.source);
  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          {/* UNTRUSTED title → plain text. */}
          <DialogTitle className="break-words">Delete "{doc.title}"?</DialogTitle>
          <DialogDescription>
            Remove this document and its {fmtNumber(doc.chunk_count)} chunk
            {doc.chunk_count === 1 ? '' : 's'} from the retrieval corpus. The agents will
            no longer retrieve it.
          </DialogDescription>
        </DialogHeader>

        {force && !guard && seed ? (
          <Alert variant="warning">
            <Lock aria-hidden />
            <AlertTitle>Guarded seed source</AlertTitle>
            <AlertDescription>
              This is built-in seed knowledge ({humanizeToken(doc.source)}). Deleting it
              force-removes it from the corpus until the backend re-seeds.
            </AlertDescription>
          </Alert>
        ) : null}
        {guard ? (
          <Alert variant="warning">
            <Lock aria-hidden />
            <AlertTitle>Guarded source</AlertTitle>
            <AlertDescription>
              {/* guard message is backend-derived → plain text */}
              <p>{guard}</p>
              <p>Confirm again to force-delete it anyway.</p>
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            <Trash2 aria-hidden />
            {force ? 'Force delete' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* -------------------------------------------------------------------- page ---- */

export interface KnowledgeProps {
  onNavigate?: Navigate;
  /**
   * When hosted as a tab inside the Intelligence scaffold (Round-2 W4 consolidation),
   * suppress the page's own PageHeader and surface only the Refresh action so the
   * host owns the title (no duplicate headers).
   */
  embedded?: boolean;
}

const KPI_ACCENTS: Record<string, KpiAccent> = {
  chunks: 'primary',
  docs: 'info',
  model: 'success',
  dim: 'medium',
};

export default function Knowledge({ embedded = false }: KnowledgeProps = {}) {
  const [stats, setStats] = React.useState<RagStats | null>(null);
  const [documents, setDocuments] = React.useState<RagDocument[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const [selectedDoc, setSelectedDoc] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, d] = await Promise.all([api.ragStats(), api.ragDocuments()]);
      setStats(s);
      setDocuments(d.documents ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const requestDelete = React.useCallback((doc: RagDocument) => {
    setPending({ doc, force: isSeedSource(doc.source), guard: null });
  }, []);

  const runDelete = React.useCallback(async () => {
    if (!pending) return;
    const { doc, force } = pending;
    setDeleting(true);
    try {
      await api.ragDeleteDocument(doc.document_id, force);
      toast.success(`Deleted "${doc.title}".`);
      setPending(null);
      void load();
    } catch (e) {
      // A 400 on a guarded seed source: keep the dialog open and offer a force retry.
      if (e instanceof ApiError && e.status === 400 && !force) {
        setPending({
          doc,
          force: true,
          guard: e.message || 'This document is a guarded seed source.',
        });
      } else {
        toast.error(errMessage(e, 'Delete failed.'));
        setPending(null);
      }
    } finally {
      setDeleting(false);
    }
  }, [pending, load]);

  /* ---- derived ---- */
  const bySourceItems = React.useMemo<BarListItem[]>(() => {
    const by = stats?.by_source ?? {};
    return Object.entries(by)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({
        label: humanizeToken(label),
        value,
        color: sourceBarColor(label),
      }));
  }, [stats]);

  const totalDocs = stats?.document_count ?? documents.length;
  const totalChunks = stats?.total_chunks ?? 0;
  const avgChunks = totalDocs > 0 ? Math.round(totalChunks / totalDocs) : 0;
  const corpusTotalChunks = React.useMemo(
    () => bySourceItems.reduce((s, x) => s + Math.max(0, x.value), 0) || totalChunks,
    [bySourceItems, totalChunks],
  );

  const showHealthSkeleton = loading && !stats;
  const canManageRag = useCan('rag', 'manage');

  const refreshAction = (
    <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
      <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden />
      Refresh
    </Button>
  );

  return (
    <div className="space-y-8">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-end gap-2">{refreshAction}</div>
      ) : (
        <PageHeader
          icon={Boxes}
          eyebrow="Knowledge"
          title="Knowledge & RAG"
          description="The retrieval corpus the investigator draws on. Import, inspect and search the index — see exactly what the agents know."
          actions={refreshAction}
        />
      )}

      {error ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load the knowledge corpus</AlertTitle>
          <AlertDescription>{errMessage(error, 'Request failed.')}</AlertDescription>
        </Alert>
      ) : null}

      {/* ---- corpus health KPIs ---- */}
      {showHealthSkeleton ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <Stagger
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          itemClassName="h-full"
        >
          <KpiTile
            label="Total chunks"
            value={fmtNumber(totalChunks)}
            sub={avgChunks > 0 ? `≈ ${fmtNumber(avgChunks)} per document` : undefined}
            icon={Layers}
            accent={KPI_ACCENTS.chunks}
          />
          <KpiTile
            label="Documents"
            value={fmtNumber(totalDocs)}
            sub={
              bySourceItems.length
                ? `${fmtNumber(bySourceItems.length)} source${bySourceItems.length === 1 ? '' : 's'}`
                : undefined
            }
            icon={FileText}
            accent={KPI_ACCENTS.docs}
          />
          <KpiTile
            label="Embedding model"
            value={
              <span className="text-base font-mono">{stats?.embedding_model || DASH}</span>
            }
            icon={Cpu}
            accent={KPI_ACCENTS.model}
          />
          <KpiTile
            label="Vector dimensions"
            value={typeof stats?.dim === 'number' ? fmtNumber(stats.dim) : DASH}
            icon={Gauge}
            accent={KPI_ACCENTS.dim}
          />
        </Stagger>
      )}

      {/* ---- corpus by source ---- */}
      {bySourceItems.length ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-3">
              <CardIcon icon={BarChart3} />
              <div>
                <CardTitle>Corpus by source</CardTitle>
                <CardDescription className="mt-0.5">
                  How retrievable knowledge is distributed across corpus sources.
                </CardDescription>
              </div>
            </div>
            <Badge variant="outline">
              {fmtNumber(corpusTotalChunks)} total chunk
              {corpusTotalChunks === 1 ? '' : 's'}
            </Badge>
          </CardHeader>
          <CardContent>
            <BarList
              items={bySourceItems}
              showPercent
              format={(n) => fmtNumber(n)}
            />
          </CardContent>
        </Card>
      ) : null}

      {/* ---- threat intel + resolved cases (F11) ---- */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <CorpusSourceSection
          icon={ShieldAlert}
          title="Threat intel"
          description="Imported threat-intel notes (source: threat_context) the investigator can retrieve."
          match={isThreatContextSource}
          documents={documents}
          loading={loading}
          emptyHint="Import a threat-intel note below to seed this corpus."
          onOpen={setSelectedDoc}
        />
        <CorpusSourceSection
          icon={CheckCircle2}
          title="Resolved cases"
          description="Closed/resolved cases auto-indexed (source: resolved_case) so future triage learns from them."
          match={isResolvedCaseSource}
          documents={documents}
          loading={loading}
          emptyHint="Resolved cases are indexed automatically when a case closes."
          onOpen={setSelectedDoc}
        />
      </div>

      {/* ---- import + search ---- */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ImportCard onImported={load} />
        <SearchCard />
      </div>

      {/* ---- threat-intel import (rag:manage) ---- */}
      {canManageRag ? (
        <Can resource="rag" action="manage">
          <ThreatIntelImportCard onImported={load} />
        </Can>
      ) : null}

      {/* ---- documents table ---- */}
      <DocumentsSection
        documents={documents}
        loading={loading}
        onOpen={setSelectedDoc}
        onDelete={requestDelete}
      />

      <Separator />
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p>
          Retrieved text is treated as untrusted evidence — it is fenced when shown to the
          investigator and never executed as instructions.
        </p>
      </div>

      <DocumentSheet documentId={selectedDoc} onClose={() => setSelectedDoc(null)} />
      <DeleteDialog
        pending={pending}
        deleting={deleting}
        onCancel={() => setPending(null)}
        onConfirm={() => void runDelete()}
      />
    </div>
  );
}
