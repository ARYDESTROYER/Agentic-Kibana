/**
 * Knowledge / RAG — the operator-facing window into the retrieval corpus the
 * investigator draws on. The agents retrieve from this index every investigation;
 * this page lets a human SEE and curate it:
 *
 *   - a corpus-health header (total chunks, document count, embedding model/dim,
 *     and a by-source breakdown with per-source chip filters),
 *   - an Import card to index a pasted document OR one-or-more uploaded
 *     .txt/.md/.json/.csv files (read client-side via FileReader, queued and
 *     indexed in sequence; the title is auto-filled from the filename),
 *   - a documents table with sorting (title/source/chunks/added), a search box,
 *     a source facet and a density toggle, plus a drill-in flyout showing the
 *     document's CHUNKS (the exact units RAG retrieves), and per-row delete
 *     (guarded seed sources can be force-deleted after a confirm),
 *   - a search box that runs `GET /api/rag/search` and shows what RAG would return
 *     for a query as a ranked, score-bearing chunk list, so the operator can watch
 *     the index actually working.
 *
 * Indexed/retrieved text is UNTRUSTED source content — it is always rendered as
 * plain text inside code blocks / panels, never interpolated as markup.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonGroup,
  EuiCallOut,
  EuiCodeBlock,
  EuiComboBox,
  EuiConfirmModal,
  EuiFieldNumber,
  EuiFieldSearch,
  EuiFieldText,
  EuiFilePicker,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiFormRow,
  EuiGlobalToastList,
  EuiHealth,
  EuiHorizontalRule,
  EuiPanel,
  EuiProgress,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  EuiTitle,
  EuiToolTip,
} from '@elastic/eui';
import type {
  Criteria,
  EuiBasicTableColumn,
  EuiComboBoxOptionOption,
  EuiGlobalToastListToast as Toast,
} from '@elastic/eui';
import type { RagChunk, RagDocument, RagStats } from '../../lib/types';
import { api, ApiError } from '../../lib/api';
import { COLORS, chartColor, tint } from '../../lib/theme';
import { DASH, fmtNumber, humanizeAge, humanizeToken } from '../../lib/format';
import {
  Card,
  EmptyState,
  ErrorCallout,
  PageHeader,
  SectionHeader,
  Skeleton,
  StatTile,
} from '../common/ui';
import { BarList } from '../common/charts';

/** Soft per-import size guard (mirrors the backend's oversized-document 400). */
const MAX_IMPORT_BYTES = 256 * 1024; // ~256 KB
const IMPORT_ACCEPT = '.txt,.md,.json,.csv,text/*';

/** A stable accent for a corpus source label. */
function sourceAccent(source: string, index = 0): string {
  const s = (source || '').toLowerCase();
  if (s.includes('runbook') || s.includes('playbook')) return COLORS.accent;
  if (s.includes('case') || s.includes('resolved')) return COLORS.success;
  if (s.includes('mitre')) return COLORS.danger;
  if (s.includes('import') || s.includes('manual') || s.includes('upload')) return COLORS.primary;
  return chartColor(index);
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

const SourceBadge: React.FC<{ source?: string; index?: number }> = ({ source, index = 0 }) => {
  if (!source) return <EuiBadge color="hollow">{DASH}</EuiBadge>;
  const accent = sourceAccent(source, index);
  return (
    <EuiBadge color={tint(accent, 0.16)} style={{ color: accent }} iconType="tag">
      {humanizeToken(source)}
    </EuiBadge>
  );
};

/* ------------------------------------------------------------- chunk view --- */

/** Render a single retrieval chunk — text is UNTRUSTED, always fenced. */
const ChunkBlock: React.FC<{ chunk: RagChunk; index: number; rank?: number }> = ({
  chunk,
  index,
  rank,
}) => (
  <Card variant="flat" paddingSize="m">
    <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
      {typeof rank === 'number' ? (
        <EuiFlexItem grow={false}>
          <EuiBadge color={tint(COLORS.primary, 0.16)} style={{ color: COLORS.primary }}>
            #{rank}
          </EuiBadge>
        </EuiFlexItem>
      ) : null}
      <EuiFlexItem grow={false}>
        <EuiBadge color="hollow" iconType="number">
          chunk {typeof chunk.chunk_index === 'number' ? chunk.chunk_index : index}
        </EuiBadge>
      </EuiFlexItem>
      <EuiFlexItem grow={false}>
        <SourceBadge source={chunk.source} index={index} />
      </EuiFlexItem>
      {typeof chunk.score === 'number' ? (
        <EuiFlexItem grow={false}>
          <ScoreBadge score={chunk.score} />
        </EuiFlexItem>
      ) : null}
    </EuiFlexGroup>
    <EuiSpacer size="xs" />
    <EuiCodeBlock language="text" fontSize="s" paddingSize="s" isCopyable whiteSpace="pre-wrap">
      {chunk.text || ''}
    </EuiCodeBlock>
  </Card>
);

/** A retrieval-score badge whose colour reflects relevance strength. */
const ScoreBadge: React.FC<{ score: number }> = ({ score }) => {
  const accent = score >= 0.66 ? COLORS.success : score >= 0.33 ? COLORS.warning : COLORS.subdued;
  return (
    <EuiToolTip content="Hybrid retrieval relevance score (higher is a closer match)">
      <EuiBadge color={tint(accent, 0.16)} style={{ color: accent }} iconType="visGauge">
        score {score.toFixed(3)}
      </EuiBadge>
    </EuiToolTip>
  );
};

/* ----------------------------------------------------------- document drill -- */

const DocumentFlyout: React.FC<{ documentId: string; onClose: () => void }> = ({
  documentId,
  onClose,
}) => {
  const [doc, setDoc] = useState<RagDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState('');
  const titleId = `ragDoc-${documentId}`;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
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
  const shownChunks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return chunks;
    return chunks.filter((c) => (c.text || '').toLowerCase().includes(q));
  }, [chunks, filter]);

  return (
    <EuiFlyout onClose={onClose} size="m" aria-labelledby={titleId} ownFocus>
      <EuiFlyoutHeader hasBorder>
        <EuiTitle size="m">
          <h2 id={titleId}>{doc?.title || 'Document'}</h2>
        </EuiTitle>
        <EuiSpacer size="xs" />
        <EuiFlexGroup gutterSize="s" wrap responsive={false} alignItems="center">
          <EuiFlexItem grow={false}>
            <SourceBadge source={doc?.source} />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiBadge color="hollow" iconType="documents">
              {fmtNumber(doc?.chunk_count ?? chunks.length)} chunk
              {(doc?.chunk_count ?? chunks.length) === 1 ? '' : 's'}
            </EuiBadge>
          </EuiFlexItem>
          {doc?.embedding_model ? (
            <EuiFlexItem grow={false}>
              <EuiBadge color="hollow" iconType="compute">
                {doc.embedding_model}
                {typeof doc.dim === 'number' ? ` · ${doc.dim}d` : ''}
              </EuiBadge>
            </EuiFlexItem>
          ) : null}
          {isSeedSource(doc?.source) ? (
            <EuiFlexItem grow={false}>
              <EuiBadge color={tint(COLORS.warning, 0.16)} style={{ color: COLORS.warning }} iconType="lock">
                Seed source
              </EuiBadge>
            </EuiFlexItem>
          ) : null}
          {doc?.added_at ? (
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                <span>added {humanizeAge(doc.added_at)}</span>
              </EuiText>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>
        {doc?.tags && doc.tags.length ? (
          <>
            <EuiSpacer size="xs" />
            <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
              {doc.tags.map((t) => (
                <EuiFlexItem grow={false} key={t}>
                  <EuiBadge color="hollow" iconType="tag">
                    {t}
                  </EuiBadge>
                </EuiFlexItem>
              ))}
            </EuiFlexGroup>
          </>
        ) : null}
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        {error ? (
          <ErrorCallout error={error} title="Could not load document" />
        ) : loading ? (
          <Skeleton rows={6} height={40} />
        ) : chunks.length === 0 ? (
          <EmptyState
            iconType="documents"
            title="No chunks"
            body="This document produced no retrievable chunks."
          />
        ) : (
          <>
            <EuiText size="xs" color="subdued">
              <p>
                These are the exact units the retriever returns. The investigator sees the
                highest-scoring chunks for a query — text is treated as untrusted evidence.
              </p>
            </EuiText>
            <EuiSpacer size="s" />
            {chunks.length > 4 ? (
              <>
                <EuiFieldSearch
                  fullWidth
                  compressed
                  placeholder="Filter chunks by text…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  isClearable
                  aria-label="Filter chunks"
                />
                <EuiSpacer size="xs" />
                <EuiText size="xs" color="subdued">
                  <span>
                    {fmtNumber(shownChunks.length)} of {fmtNumber(chunks.length)} chunks
                  </span>
                </EuiText>
                <EuiSpacer size="s" />
              </>
            ) : (
              <EuiSpacer size="s" />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {shownChunks.map((ch, i) => (
                <ChunkBlock key={i} chunk={ch} index={ch.chunk_index ?? i} />
              ))}
            </div>
          </>
        )}
      </EuiFlyoutBody>
    </EuiFlyout>
  );
};

/* ------------------------------------------------------------------- import -- */

/** One queued file waiting to be (or being) indexed. */
interface QueuedFile {
  name: string;
  text: string;
  bytes: number;
  tooBig: boolean;
}

const ImportCard: React.FC<{ onImported: (msg: string) => void; onError: (e: unknown) => void }> = ({
  onImported,
  onError,
}) => {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [tags, setTags] = useState<Array<EuiComboBoxOptionOption<string>>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // Queued multi-file uploads (each indexed as its own document).
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  // EuiFilePicker is uncontrolled — bump this key to reset its label after a read.
  const [pickerKey, setPickerKey] = useState(0);

  const bytes = useMemo(() => new Blob([text]).size, [text]);
  const tooBig = bytes > MAX_IMPORT_BYTES;
  const hasPasted = title.trim().length > 0 && text.trim().length > 0;
  const queueValid = queue.length > 0 && queue.every((q) => !q.tooBig);
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

  const onPick = useCallback(
    async (files: FileList | null) => {
      setFileError(null);
      const list = files ? Array.from(files) : [];
      if (list.length === 0) {
        setQueue([]);
        return;
      }
      // Single file with an empty paste area → fill the paste fields inline so the
      // existing "paste then tweak" flow is unchanged. Multiple files → queue them.
      if (list.length === 1 && !text.trim()) {
        try {
          const qf = await readFile(list[0]);
          if (qf.tooBig) {
            setFileError(
              `“${qf.name}” is ${fmtNumber(qf.bytes)} bytes — keep documents under ${Math.round(
                MAX_IMPORT_BYTES / 1024,
              )} KB.`,
            );
            return;
          }
          setText(qf.text);
          setTitle((prev) => prev.trim() || list[0].name.replace(/\.[^.]+$/, ''));
          setQueue([]);
        } catch (e) {
          setFileError((e as Error).message);
        }
        return;
      }
      try {
        const read = await Promise.all(list.map(readFile));
        setQueue(read);
      } catch (e) {
        setFileError((e as Error).message);
      }
    },
    [text],
  );

  const reset = useCallback(() => {
    setTitle('');
    setText('');
    setSource('');
    setTags([]);
    setQueue([]);
    setPickerKey((k) => k + 1);
  }, []);

  const submit = useCallback(async () => {
    const tagList = tags.map((t) => (t.label || '').trim()).filter(Boolean);
    const src = source.trim() || undefined;
    setSubmitting(true);
    try {
      if (queue.length > 0) {
        // Batch: index each queued file as its own document, in sequence.
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
        onImported(
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
        onImported(
          `Indexed “${res.title}” (${fmtNumber(res.chunk_count)} chunk${
            res.chunk_count === 1 ? '' : 's'
          }).`,
        );
      }
      reset();
    } catch (e) {
      onError(e);
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }, [title, text, source, tags, queue, onImported, onError, reset]);

  const batching = queue.length > 0;

  return (
    <Card title="Import knowledge" icon="importAction" accent={COLORS.primary}>
      <EuiText size="xs" color="subdued">
        <span>
          Index documents into the retrieval corpus. Paste text, or upload one or more
          .txt / .md / .json / .csv files (each becomes its own document); the investigator
          can then retrieve them during triage.
        </span>
      </EuiText>
      <EuiSpacer size="m" />

      <EuiFlexGroup gutterSize="m" wrap>
        <EuiFlexItem>
          <EuiFormRow label="Title" fullWidth isDisabled={batching}>
            <EuiFieldText
              fullWidth
              icon="article"
              placeholder={batching ? 'From each filename' : 'e.g. Internal IP allocation guide'}
              value={batching ? '' : title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={batching}
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiFormRow label="Source (optional)" helpText="A label that groups these in the corpus." fullWidth>
            <EuiFieldText
              fullWidth
              icon="tag"
              placeholder="manual"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </EuiFormRow>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="s" />
      <EuiFormRow
        label="Document text"
        helpText={batching ? 'Disabled while files are queued.' : `${fmtNumber(bytes)} bytes`}
        fullWidth
        isInvalid={tooBig}
        error={tooBig ? `Too large — keep documents under ${Math.round(MAX_IMPORT_BYTES / 1024)} KB.` : undefined}
      >
        <EuiTextArea
          fullWidth
          rows={6}
          placeholder="Paste the document text here, or upload files below…"
          value={batching ? '' : text}
          onChange={(e) => setText(e.target.value)}
          isInvalid={tooBig}
          disabled={batching}
        />
      </EuiFormRow>

      <EuiSpacer size="s" />
      <EuiFormRow
        label="…or upload files"
        helpText="Select one file to fill the editor, or several to batch-index them."
        fullWidth
        isInvalid={!!fileError}
        error={fileError || undefined}
      >
        <EuiFilePicker
          key={pickerKey}
          fullWidth
          compressed
          multiple
          initialPromptText="Select one or more .txt, .md, .json or .csv files"
          accept={IMPORT_ACCEPT}
          onChange={(files) => void onPick(files)}
          display="default"
        />
      </EuiFormRow>

      {batching ? (
        <>
          <EuiSpacer size="s" />
          <Card variant="flat" paddingSize="m">
            <EuiText size="xs" color="subdued">
              <strong>
                {fmtNumber(queue.length)} file{queue.length === 1 ? '' : 's'} queued
              </strong>
            </EuiText>
            <EuiSpacer size="xs" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {queue.map((q, i) => (
                <EuiFlexGroup key={`${q.name}-${i}`} gutterSize="s" alignItems="center" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <QueueStatusDot ok={!q.tooBig} />
                  </EuiFlexItem>
                  <EuiFlexItem>
                    <EuiText size="xs">
                      <span className="socMono" style={{ wordBreak: 'break-all' }}>
                        {q.name}
                      </span>
                    </EuiText>
                  </EuiFlexItem>
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color={q.tooBig ? 'danger' : 'subdued'}>
                      <span>{fmtNumber(q.bytes)} B</span>
                    </EuiText>
                  </EuiFlexItem>
                </EuiFlexGroup>
              ))}
            </div>
            {!queueValid ? (
              <>
                <EuiSpacer size="s" />
                <EuiText size="xs" color="danger">
                  <span>
                    Some files exceed {Math.round(MAX_IMPORT_BYTES / 1024)} KB — remove them and re-select.
                  </span>
                </EuiText>
              </>
            ) : null}
          </Card>
        </>
      ) : null}

      <EuiSpacer size="s" />
      <EuiFormRow label="Tags (optional)" helpText="Type and press enter to add — applied to every imported document." fullWidth>
        <EuiComboBox
          fullWidth
          noSuggestions
          placeholder="Add a tag…"
          selectedOptions={tags}
          onCreateOption={(v) => {
            const label = v.trim();
            if (label) setTags((prev) => [...prev, { label }]);
          }}
          onChange={(sel) => setTags(sel)}
          isClearable
        />
      </EuiFormRow>

      {progress ? (
        <>
          <EuiSpacer size="m" />
          <EuiProgress
            value={progress.done}
            max={progress.total}
            size="s"
            color="primary"
            label={`Indexing ${progress.done} / ${progress.total}`}
            valueText
          />
        </>
      ) : null}

      <EuiSpacer size="m" />
      <EuiFlexGroup justifyContent="flexEnd" gutterSize="s" responsive={false}>
        {hasPasted || batching ? (
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty size="s" iconType="cross" onClick={reset} isDisabled={submitting}>
              Clear
            </EuiButtonEmpty>
          </EuiFlexItem>
        ) : null}
        <EuiFlexItem grow={false}>
          <EuiButton
            fill
            size="s"
            iconType="plusInCircle"
            onClick={() => void submit()}
            isLoading={submitting}
            isDisabled={!canSubmit}
          >
            {batching
              ? `Index ${fmtNumber(queue.length)} document${queue.length === 1 ? '' : 's'}`
              : 'Index document'}
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
    </Card>
  );
};

/** A tiny ok/error status dot for the upload queue. */
const QueueStatusDot: React.FC<{ ok: boolean }> = ({ ok }) => (
  <EuiHealth color={ok ? COLORS.success : COLORS.danger}>
    <span style={{ fontSize: 11 }}>{ok ? 'ready' : 'too big'}</span>
  </EuiHealth>
);

/* ------------------------------------------------------------------- search -- */

const TOP_K_DEFAULT = 5;
/** Display-only similarity floor (the backend owns the real retrieval floor). */
const MIN_SIMILARITY_HINT = '0.70';

const SearchCard: React.FC = () => {
  const [q, setQ] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [results, setResults] = useState<RagChunk[] | null>(null);
  const [topK, setTopK] = useState(TOP_K_DEFAULT);

  const run = useCallback(async () => {
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
    <Card title="Try a retrieval" icon="search" accent={COLORS.accent}>
      <EuiText size="xs" color="subdued">
        <span>See exactly what RAG would return for a query — the same chunks the investigator gets, ranked by relevance.</span>
      </EuiText>
      <EuiSpacer size="m" />
      <EuiFlexGroup gutterSize="s" alignItems="flexEnd" responsive={false} wrap>
        <EuiFlexItem>
          <EuiFieldSearch
            fullWidth
            placeholder="e.g. brute force from a known scanner"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onSearch={() => void run()}
            isLoading={loading}
            incremental={false}
            aria-label="Retrieval query"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton size="s" iconType="search" onClick={() => void run()} isLoading={loading} isDisabled={!q.trim()}>
            Run
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      <EuiFlexGroup gutterSize="m" responsive={false} wrap>
        <EuiFlexItem>
          <EuiFormRow label="Top-K results" helpText="How many ranked chunks to return.">
            <EuiFieldNumber
              compressed
              min={1}
              max={20}
              value={topK}
              onChange={(e) => {
                const n = Number(e.target.value);
                setTopK(Number.isFinite(n) ? Math.min(20, Math.max(1, Math.round(n))) : TOP_K_DEFAULT);
              }}
              aria-label="Top-K results"
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiFormRow label="Min. similarity" helpText="Retrieval floor (set on the backend).">
            <EuiFieldText compressed disabled value={MIN_SIMILARITY_HINT} aria-label="Minimum similarity" />
          </EuiFormRow>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      {error ? (
        <ErrorCallout error={error} title="Search failed" />
      ) : loading ? (
        <Skeleton rows={3} height={48} />
      ) : results === null ? (
        <EuiText size="xs" color="subdued">
          <span>Run a query to preview the retrieved chunks.</span>
        </EuiText>
      ) : results.length === 0 ? (
        <EmptyState
          iconType="search"
          title="No matches"
          body="Nothing in the corpus scored above the retrieval floor for this query."
        />
      ) : (
        <>
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiBadge color={tint(COLORS.accent, 0.16)} style={{ color: COLORS.accent }} iconType="search">
                {fmtNumber(results.length)} hit{results.length === 1 ? '' : 's'}
              </EuiBadge>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                <span>for “{lastQuery}”, ranked highest-first</span>
              </EuiText>
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="s" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {results.map((ch, i) => (
              <ChunkBlock key={i} chunk={ch} index={i} rank={i + 1} />
            ))}
          </div>
        </>
      )}
    </Card>
  );
};

/* -------------------------------------------------------------- documents --- */

type SortField = 'title' | 'source' | 'chunk_count' | 'added_at';

const DENSITY_OPTIONS = [
  { id: 'comfortable', label: 'Comfortable', iconType: 'tableDensityNormal' },
  { id: 'compact', label: 'Compact', iconType: 'tableDensityCompact' },
];

const DENSITY_LS_KEY = 'tlsoc.knowledge.density';

function readDensity(): 'comfortable' | 'compact' {
  try {
    return localStorage.getItem(DENSITY_LS_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

const toOpts = (vals: string[]): Array<EuiComboBoxOptionOption<string>> =>
  vals.map((v) => ({ label: humanizeToken(v), value: v }));
const fromOpts = (sel: Array<EuiComboBoxOptionOption<string>>): string[] =>
  sel.map((o) => (o.value ?? o.label) as string);

const DocumentsSection: React.FC<{
  documents: RagDocument[];
  loading: boolean;
  onOpen: (id: string) => void;
  onDelete: (doc: RagDocument) => void;
}> = ({ documents, loading, onOpen, onDelete }) => {
  const [search, setSearch] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [sortField, setSortField] = useState<SortField>('added_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [density, setDensity] = useState<'comfortable' | 'compact'>(readDensity);

  const changeDensity = useCallback((id: 'comfortable' | 'compact') => {
    setDensity(id);
    try {
      localStorage.setItem(DENSITY_LS_KEY, id);
    } catch {
      /* private mode / quota — density is non-critical, ignore */
    }
  }, []);

  const sourceFacet = useMemo(() => {
    const set = new Set<string>();
    for (const d of documents) if (d.source) set.add(d.source);
    return Array.from(set).sort();
  }, [documents]);

  // Drop any selected source that no longer exists so the list can't silently empty.
  useEffect(() => {
    setSources((prev) => prev.filter((s) => sourceFacet.includes(s)));
  }, [sourceFacet]);

  const filteredSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = documents.filter((d) => {
      if (sources.length && !sources.includes(d.source)) return false;
      if (!q) return true;
      const hay = `${d.title} ${d.source} ${(d.tags || []).join(' ')} ${d.document_id}`.toLowerCase();
      return hay.includes(q);
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sortField) {
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
  }, [documents, search, sources, sortField, sortDir]);

  const onTableChange = useCallback(({ sort }: Criteria<RagDocument>) => {
    if (sort) {
      setSortField(sort.field as SortField);
      setSortDir(sort.direction);
    }
  }, []);

  const compact = density === 'compact';

  const columns: Array<EuiBasicTableColumn<RagDocument>> = useMemo(
    () => [
      {
        field: 'title',
        name: 'Title',
        sortable: true,
        render: (_: unknown, d: RagDocument) => (
          <div>
            <button
              type="button"
              className="euiLink euiLink--primary"
              style={{
                fontWeight: 600,
                textAlign: 'left',
                background: 'none',
                border: 0,
                cursor: 'pointer',
                padding: 0,
                color: COLORS.primary,
              }}
              onClick={() => onOpen(d.document_id)}
            >
              {d.title || d.document_id}
            </button>
            {!compact && d.tags && d.tags.length ? (
              <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {d.tags.slice(0, 4).map((t) => (
                  <EuiBadge key={t} color="hollow" iconType="tag">
                    {t}
                  </EuiBadge>
                ))}
                {d.tags.length > 4 ? (
                  <EuiBadge color="hollow">+{d.tags.length - 4}</EuiBadge>
                ) : null}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        field: 'source',
        name: 'Source',
        sortable: true,
        width: '170px',
        render: (_: unknown, d: RagDocument) => (
          <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <SourceBadge source={d.source} />
            </EuiFlexItem>
            {isSeedSource(d.source) ? (
              <EuiFlexItem grow={false}>
                <EuiToolTip content="Guarded seed corpus — delete requires force-confirm.">
                  <EuiBadge color={tint(COLORS.warning, 0.16)} style={{ color: COLORS.warning }} iconType="lock" />
                </EuiToolTip>
              </EuiFlexItem>
            ) : null}
          </EuiFlexGroup>
        ),
      },
      {
        field: 'chunk_count',
        name: 'Chunks',
        sortable: true,
        width: '90px',
        align: 'right',
        render: (n: number) => fmtNumber(n),
      },
      ...(compact
        ? []
        : ([
            {
              field: 'embedding_model',
              name: 'Model',
              render: (_: unknown, d: RagDocument) =>
                d.embedding_model ? (
                  <span className="socMono" style={{ fontSize: 12 }}>
                    {d.embedding_model}
                    {typeof d.dim === 'number' ? ` · ${d.dim}d` : ''}
                  </span>
                ) : (
                  <span style={{ color: COLORS.subdued }}>{DASH}</span>
                ),
            },
          ] as Array<EuiBasicTableColumn<RagDocument>>)),
      {
        field: 'added_at',
        name: 'Added',
        sortable: true,
        width: '110px',
        render: (_: unknown, d: RagDocument) => humanizeAge(d.added_at),
      },
      {
        name: 'Actions',
        width: '88px',
        actions: [
          {
            name: 'View',
            description: 'View document chunks',
            icon: 'expand',
            type: 'icon',
            onClick: (d: RagDocument) => onOpen(d.document_id),
          },
          {
            name: 'Delete',
            description: 'Delete from the corpus',
            icon: 'trash',
            type: 'icon',
            color: 'danger',
            onClick: (d: RagDocument) => onDelete(d),
          },
        ],
      },
    ],
    [compact, onOpen, onDelete],
  );

  const anyFilter = search.trim().length > 0 || sources.length > 0;

  return (
    <>
      <SectionHeader
        icon="documents"
        accent={COLORS.primary}
        title="Indexed documents"
        description={
          loading
            ? 'Loading…'
            : `${fmtNumber(filteredSorted.length)} of ${fmtNumber(documents.length)} document${
                documents.length === 1 ? '' : 's'
              } shown.`
        }
        actions={
          <EuiButtonGroup
            legend="Table density"
            options={DENSITY_OPTIONS}
            idSelected={density}
            onChange={(id) => changeDensity(id as 'comfortable' | 'compact')}
            buttonSize="compressed"
          />
        }
      />

      <EuiPanel hasBorder paddingSize="m">
        {/* ---- filter toolbar ---- */}
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
          <EuiFlexItem grow={false} style={{ minWidth: 220 }}>
            <EuiFieldSearch
              compressed
              fullWidth
              placeholder="Search title, source, tags…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              isClearable
              aria-label="Search documents"
            />
          </EuiFlexItem>
          {sourceFacet.length > 1 ? (
            <EuiFlexItem grow={false} style={{ minWidth: 200, maxWidth: 320 }}>
              <EuiComboBox
                compressed
                placeholder="Source"
                aria-label="Filter by source"
                options={toOpts(sourceFacet)}
                selectedOptions={toOpts(sources)}
                onChange={(sel) => setSources(fromOpts(sel))}
                isClearable
              />
            </EuiFlexItem>
          ) : null}
          {anyFilter ? (
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                size="s"
                iconType="cross"
                onClick={() => {
                  setSearch('');
                  setSources([]);
                }}
              >
                Clear
              </EuiButtonEmpty>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>

        <EuiSpacer size="m" />

        {loading && documents.length === 0 ? (
          <Skeleton rows={5} height={28} />
        ) : documents.length === 0 ? (
          <EmptyState
            iconType="documents"
            title="The corpus is empty"
            body="Import a document above, or seed the backend's runbooks/playbooks to populate retrieval knowledge."
          />
        ) : filteredSorted.length === 0 ? (
          <EmptyState
            iconType="search"
            title="No documents match"
            body="No indexed documents match the current filters. Clear them to see all documents."
            actions={
              <EuiButton
                size="s"
                iconType="cross"
                onClick={() => {
                  setSearch('');
                  setSources([]);
                }}
              >
                Clear filters
              </EuiButton>
            }
          />
        ) : (
          <EuiBasicTable<RagDocument>
            items={filteredSorted}
            columns={columns}
            rowHeader="title"
            tableLayout="auto"
            compressed={compact}
            sorting={{ sort: { field: sortField, direction: sortDir } }}
            onChange={onTableChange}
          />
        )}
      </EuiPanel>
    </>
  );
};

/* -------------------------------------------------------------------- page --- */

export const KnowledgePage: React.FC = () => {
  const [stats, setStats] = useState<RagStats | null>(null);
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  // Pending delete (drives the confirm modal). `force` flips on after a guard 400.
  const [pendingDelete, setPendingDelete] = useState<RagDocument | null>(null);
  const [deleteForce, setDeleteForce] = useState(false);
  const [deleteGuard, setDeleteGuard] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const addToast = useCallback((title: string, color: Toast['color'] = 'success') => {
    toastId.current += 1;
    const id = `rag-toast-${toastId.current}`;
    setToasts((prev) => [...prev, { id, title, color }]);
  }, []);
  const removeToast = useCallback((t: Toast) => {
    setToasts((prev) => prev.filter((x) => x.id !== t.id));
  }, []);

  const load = useCallback(async () => {
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

  useEffect(() => {
    void load();
  }, [load]);

  const onImported = useCallback(
    (msg: string) => {
      addToast(msg, 'success');
      void load();
    },
    [addToast, load],
  );

  const requestDelete = useCallback((doc: RagDocument) => {
    setPendingDelete(doc);
    // Pre-arm force for known guarded seed sources so the confirm reads correctly.
    setDeleteForce(isSeedSource(doc.source));
    setDeleteGuard(null);
  }, []);

  const runDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.ragDeleteDocument(pendingDelete.document_id, deleteForce);
      addToast(`Deleted “${pendingDelete.title}”.`, 'success');
      setPendingDelete(null);
      setDeleteForce(false);
      setDeleteGuard(null);
      void load();
    } catch (e) {
      // A 400 on a guarded seed source: keep the modal open and offer a force retry.
      if (e instanceof ApiError && e.status === 400 && !deleteForce) {
        setDeleteGuard(e.message || 'This document is a guarded seed source.');
        setDeleteForce(true);
      } else {
        addToast(e instanceof Error ? e.message : 'Delete failed.', 'danger');
        setPendingDelete(null);
      }
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, deleteForce, addToast, load]);

  const bySourceItems = useMemo(() => {
    const by = stats?.by_source ?? {};
    return Object.entries(by)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({
        label: humanizeToken(label),
        value,
        color: sourceAccent(label, i),
      }));
  }, [stats]);

  const totalDocs = stats?.document_count ?? documents.length;
  const avgChunks =
    totalDocs > 0 ? Math.round((stats?.total_chunks ?? 0) / totalDocs) : 0;
  // The bar total — used for the "N total chunks" header badge and per-source %.
  const corpusTotalChunks = useMemo(
    () => bySourceItems.reduce((s, x) => s + Math.max(0, x.value), 0) || stats?.total_chunks || 0,
    [bySourceItems, stats],
  );

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="indexMapping"
        accent={COLORS.primary}
        eyebrow="Knowledge"
        title="Knowledge & RAG"
        description="The retrieval corpus the investigator draws on. Import, inspect and search the index — see exactly what the agents know."
        actions={
          <EuiButtonEmpty size="s" iconType="refresh" onClick={() => void load()} isLoading={loading}>
            Refresh
          </EuiButtonEmpty>
        }
      />

      {error ? (
        <>
          <ErrorCallout error={error} title="Could not load the knowledge corpus" />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* ---- corpus health header ---- */}
      {loading && !stats ? (
        <EuiFlexGrid columns={4} gutterSize="m">
          {[0, 1, 2, 3].map((i) => (
            <EuiFlexItem key={i}>
              <EuiPanel hasBorder paddingSize="m">
                <Skeleton rows={2} height={20} />
              </EuiPanel>
            </EuiFlexItem>
          ))}
        </EuiFlexGrid>
      ) : (
        <EuiFlexGrid columns={4} gutterSize="m">
          <EuiFlexItem>
            <StatTile
              label="Total chunks"
              value={fmtNumber(stats?.total_chunks ?? 0)}
              icon="layers"
              accent={COLORS.primary}
              sub={avgChunks > 0 ? `≈ ${fmtNumber(avgChunks)} per document` : undefined}
            />
          </EuiFlexItem>
          <EuiFlexItem>
            <StatTile
              label="Documents"
              value={fmtNumber(totalDocs)}
              icon="documents"
              accent={COLORS.accent}
              sub={bySourceItems.length ? `${fmtNumber(bySourceItems.length)} source${bySourceItems.length === 1 ? '' : 's'}` : undefined}
            />
          </EuiFlexItem>
          <EuiFlexItem>
            <StatTile
              label="Embedding model"
              value={<span style={{ fontSize: 15 }}>{stats?.embedding_model || DASH}</span>}
              icon="compute"
              accent={COLORS.success}
            />
          </EuiFlexItem>
          <EuiFlexItem>
            <StatTile
              label="Vector dimensions"
              value={typeof stats?.dim === 'number' ? fmtNumber(stats.dim) : DASH}
              icon="visGauge"
              accent={COLORS.warning}
            />
          </EuiFlexItem>
        </EuiFlexGrid>
      )}

      <EuiSpacer size="m" />

      {bySourceItems.length ? (
        <>
          <Card
            title="Corpus by source"
            icon="visBarVertical"
            accent={COLORS.accent}
            actions={
              <EuiBadge color="hollow">
                {fmtNumber(corpusTotalChunks)} total chunk{corpusTotalChunks === 1 ? '' : 's'}
              </EuiBadge>
            }
          >
            <EuiText size="xs" color="subdued">
              <span>How retrievable knowledge is distributed across corpus sources.</span>
            </EuiText>
            <EuiSpacer size="s" />
            <BarList
              items={bySourceItems}
              title="Corpus chunks by source"
              format={(n) => {
                const pct = corpusTotalChunks > 0 ? n / corpusTotalChunks : 0;
                const pctLabel = pct > 0 && pct < 0.01 ? '<1%' : `${Math.round(pct * 100)}%`;
                return `${fmtNumber(n)} · ${pctLabel}`;
              }}
            />
          </Card>
          <EuiSpacer size="l" />
        </>
      ) : null}

      {/* ---- import + search side by side on wide screens ---- */}
      <EuiFlexGroup gutterSize="l" wrap>
        <EuiFlexItem style={{ minWidth: 360 }}>
          <ImportCard onImported={onImported} onError={(e) => addToast(e instanceof Error ? e.message : 'Import failed.', 'danger')} />
        </EuiFlexItem>
        <EuiFlexItem style={{ minWidth: 360 }}>
          <SearchCard />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      {/* ---- documents table ---- */}
      <DocumentsSection
        documents={documents}
        loading={loading}
        onOpen={setSelectedDoc}
        onDelete={requestDelete}
      />

      {selectedDoc ? (
        <DocumentFlyout documentId={selectedDoc} onClose={() => setSelectedDoc(null)} />
      ) : null}

      {pendingDelete ? (
        <EuiConfirmModal
          title={`Delete “${pendingDelete.title}”?`}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteForce(false);
            setDeleteGuard(null);
          }}
          onConfirm={() => void runDelete()}
          cancelButtonText="Cancel"
          confirmButtonText={deleteForce ? 'Force delete' : 'Delete'}
          buttonColor="danger"
          isLoading={deleting}
        >
          <EuiText size="s">
            <p>
              Remove this document and its {fmtNumber(pendingDelete.chunk_count)} chunk
              {pendingDelete.chunk_count === 1 ? '' : 's'} from the retrieval corpus. The agents will
              no longer retrieve it.
            </p>
          </EuiText>
          {deleteForce && !deleteGuard && isSeedSource(pendingDelete.source) ? (
            <>
              <EuiSpacer size="s" />
              <EuiCallOut title="Guarded seed source" color="warning" iconType="lock" size="s">
                <p>
                  This is built-in seed knowledge ({humanizeToken(pendingDelete.source)}). Deleting it
                  force-removes it from the corpus until the backend re-seeds.
                </p>
              </EuiCallOut>
            </>
          ) : null}
          {deleteGuard ? (
            <>
              <EuiSpacer size="s" />
              <EuiCallOut title="Guarded source" color="warning" iconType="lock" size="s">
                <p>{deleteGuard}</p>
                <p>Confirm again to force-delete it anyway.</p>
              </EuiCallOut>
            </>
          ) : null}
        </EuiConfirmModal>
      ) : null}

      <EuiHorizontalRule margin="l" />
      <EuiText size="xs" color="subdued">
        <p>
          Retrieved text is treated as untrusted evidence — it is fenced when shown to the
          investigator and never executed as instructions.
        </p>
      </EuiText>

      <EuiGlobalToastList toasts={toasts} dismissToast={removeToast} toastLifeTimeMs={5000} />
    </div>
  );
};
