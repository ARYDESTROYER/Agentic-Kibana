/**
 * Knowledge / RAG — the operator-facing window into the retrieval corpus the
 * investigator draws on. The agents retrieve from this index every investigation;
 * this page lets a human SEE and curate it:
 *
 *   - a corpus-health header (total chunks, document count, embedding model/dim,
 *     and a by-source breakdown),
 *   - an Import card to index a pasted document OR an uploaded .txt/.md/.json/.csv
 *     file (read client-side via FileReader → fills the title from the filename),
 *   - a documents table with a drill-in flyout that shows the document's CHUNKS
 *     (the exact units RAG retrieves), and per-row delete (guarded seed sources
 *     can be force-deleted after a confirm),
 *   - a search box that runs `GET /api/rag/search` and shows what RAG would return
 *     for a query, so the operator can watch the index actually working.
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
  EuiCallOut,
  EuiCodeBlock,
  EuiComboBox,
  EuiConfirmModal,
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
  EuiHorizontalRule,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTextArea,
  EuiTitle,
} from '@elastic/eui';
import type {
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
const ChunkBlock: React.FC<{ chunk: RagChunk; index: number }> = ({ chunk, index }) => (
  <Card variant="flat" paddingSize="m">
    <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
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
          <EuiBadge color={tint(COLORS.success, 0.16)} style={{ color: COLORS.success }} iconType="visGauge">
            score {chunk.score.toFixed(3)}
          </EuiBadge>
        </EuiFlexItem>
      ) : null}
    </EuiFlexGroup>
    <EuiSpacer size="xs" />
    <EuiCodeBlock language="text" fontSize="s" paddingSize="s" isCopyable whiteSpace="pre-wrap">
      {chunk.text || ''}
    </EuiCodeBlock>
  </Card>
);

/* ----------------------------------------------------------- document drill -- */

const DocumentFlyout: React.FC<{ documentId: string; onClose: () => void }> = ({
  documentId,
  onClose,
}) => {
  const [doc, setDoc] = useState<RagDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
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
            <EuiSpacer size="m" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {chunks.map((ch, i) => (
                <ChunkBlock key={i} chunk={ch} index={i} />
              ))}
            </div>
          </>
        )}
      </EuiFlyoutBody>
    </EuiFlyout>
  );
};

/* ------------------------------------------------------------------- import -- */

const ImportCard: React.FC<{ onImported: (msg: string) => void; onError: (e: unknown) => void }> = ({
  onImported,
  onError,
}) => {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [tags, setTags] = useState<Array<EuiComboBoxOptionOption<string>>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // EuiFilePicker is uncontrolled — bump this key to reset its label after a read.
  const [pickerKey, setPickerKey] = useState(0);

  const bytes = useMemo(() => new Blob([text]).size, [text]);
  const tooBig = bytes > MAX_IMPORT_BYTES;
  const canSubmit = title.trim().length > 0 && text.trim().length > 0 && !tooBig && !submitting;

  const onPick = useCallback(
    (files: FileList | null) => {
      setFileError(null);
      const file = files && files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const content = String(reader.result || '');
        setText(content);
        // Fill the title from the filename (sans extension) only if empty.
        setTitle((prev) => prev.trim() || file.name.replace(/\.[^.]+$/, ''));
      };
      reader.onerror = () => setFileError('Could not read the file.');
      reader.readAsText(file);
    },
    [],
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await api.ragImport({
        title: title.trim(),
        text,
        source: source.trim() || undefined,
        tags: tags.map((t) => (t.label || '').trim()).filter(Boolean),
      });
      onImported(`Indexed “${res.title}” (${fmtNumber(res.chunk_count)} chunk${res.chunk_count === 1 ? '' : 's'}).`);
      setTitle('');
      setText('');
      setSource('');
      setTags([]);
      setPickerKey((k) => k + 1);
    } catch (e) {
      onError(e);
    } finally {
      setSubmitting(false);
    }
  }, [title, text, source, tags, onImported, onError]);

  return (
    <Card title="Import knowledge" icon="importAction" accent={COLORS.primary}>
      <EuiText size="xs" color="subdued">
        <span>
          Index a document into the retrieval corpus. Paste text or upload a .txt / .md / .json /
          .csv file; the investigator can then retrieve it during triage.
        </span>
      </EuiText>
      <EuiSpacer size="m" />

      <EuiFlexGroup gutterSize="m" wrap>
        <EuiFlexItem>
          <EuiFormRow label="Title" fullWidth>
            <EuiFieldText
              fullWidth
              icon="article"
              placeholder="e.g. Internal IP allocation guide"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiFormRow label="Source (optional)" helpText="A label that groups this in the corpus." fullWidth>
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
        helpText={`${fmtNumber(bytes)} bytes`}
        fullWidth
        isInvalid={tooBig}
        error={tooBig ? `Too large — keep documents under ${Math.round(MAX_IMPORT_BYTES / 1024)} KB.` : undefined}
      >
        <EuiTextArea
          fullWidth
          rows={6}
          placeholder="Paste the document text here, or upload a file below…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          isInvalid={tooBig}
        />
      </EuiFormRow>

      <EuiSpacer size="s" />
      <EuiFormRow
        label="…or upload a file"
        fullWidth
        isInvalid={!!fileError}
        error={fileError || undefined}
      >
        <EuiFilePicker
          key={pickerKey}
          fullWidth
          compressed
          initialPromptText="Select a .txt, .md, .json or .csv file"
          accept={IMPORT_ACCEPT}
          onChange={onPick}
          display="default"
        />
      </EuiFormRow>

      <EuiSpacer size="s" />
      <EuiFormRow label="Tags (optional)" helpText="Type and press enter to add." fullWidth>
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

      <EuiSpacer size="m" />
      <EuiFlexGroup justifyContent="flexEnd" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiButton
            fill
            size="s"
            iconType="plusInCircle"
            onClick={() => void submit()}
            isLoading={submitting}
            isDisabled={!canSubmit}
          >
            Index document
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
    </Card>
  );
};

/* ------------------------------------------------------------------- search -- */

const SearchCard: React.FC = () => {
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [results, setResults] = useState<RagChunk[] | null>(null);

  const run = useCallback(async () => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.ragSearch(query, 8);
      setResults(res.chunks ?? []);
    } catch (e) {
      setError(e);
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, [q]);

  return (
    <Card title="Try a retrieval" icon="search" accent={COLORS.accent}>
      <EuiText size="xs" color="subdued">
        <span>See exactly what RAG would return for a query — the same chunks the investigator gets.</span>
      </EuiText>
      <EuiSpacer size="m" />
      <EuiFieldSearch
        fullWidth
        placeholder="e.g. brute force from a known scanner"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onSearch={() => void run()}
        isLoading={loading}
        incremental={false}
      />
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {results.map((ch, i) => (
            <ChunkBlock key={i} chunk={ch} index={i} />
          ))}
        </div>
      )}
    </Card>
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
    setDeleteForce(false);
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

  const columns: Array<EuiBasicTableColumn<RagDocument>> = useMemo(
    () => [
      {
        field: 'title',
        name: 'Title',
        sortable: true,
        render: (_: unknown, d: RagDocument) => (
          <button
            type="button"
            className="euiLink euiLink--primary"
            style={{ fontWeight: 600, textAlign: 'left', background: 'none', border: 0, cursor: 'pointer', padding: 0, color: COLORS.primary }}
            onClick={() => setSelectedDoc(d.document_id)}
          >
            {d.title || d.document_id}
          </button>
        ),
      },
      {
        field: 'source',
        name: 'Source',
        sortable: true,
        render: (_: unknown, d: RagDocument) => <SourceBadge source={d.source} />,
      },
      {
        field: 'chunk_count',
        name: 'Chunks',
        sortable: true,
        width: '90px',
        render: (n: number) => fmtNumber(n),
      },
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
      {
        field: 'added_at',
        name: 'Added',
        sortable: true,
        width: '110px',
        render: (_: unknown, d: RagDocument) => humanizeAge(d.added_at),
      },
      {
        name: '',
        width: '88px',
        actions: [
          {
            name: 'View',
            description: 'View document chunks',
            icon: 'expand',
            type: 'icon',
            onClick: (d: RagDocument) => setSelectedDoc(d.document_id),
          },
          {
            name: 'Delete',
            description: 'Delete from the corpus',
            icon: 'trash',
            type: 'icon',
            color: 'danger',
            onClick: (d: RagDocument) => requestDelete(d),
          },
        ],
      },
    ],
    [requestDelete],
  );

  const bySourceItems = useMemo(() => {
    const by = stats?.by_source ?? {};
    return Object.entries(by)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label: humanizeToken(label), value, color: sourceAccent(label, i) }));
  }, [stats]);

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
            <StatTile label="Total chunks" value={fmtNumber(stats?.total_chunks ?? 0)} icon="layers" accent={COLORS.primary} />
          </EuiFlexItem>
          <EuiFlexItem>
            <StatTile label="Documents" value={fmtNumber(stats?.document_count ?? documents.length)} icon="documents" accent={COLORS.accent} />
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
          <Card title="Corpus by source" icon="visBarVertical" accent={COLORS.accent}>
            <BarList items={bySourceItems} format={(n) => fmtNumber(n)} />
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
      <SectionHeader
        icon="documents"
        accent={COLORS.primary}
        title="Indexed documents"
        description={`${fmtNumber(documents.length)} document${documents.length === 1 ? '' : 's'} in the corpus.`}
      />
      <EuiPanel hasBorder paddingSize="m">
        {loading && documents.length === 0 ? (
          <Skeleton rows={5} height={28} />
        ) : documents.length === 0 ? (
          <EmptyState
            iconType="documents"
            title="The corpus is empty"
            body="Import a document above, or seed the backend's runbooks/playbooks to populate retrieval knowledge."
          />
        ) : (
          <EuiBasicTable<RagDocument>
            items={documents}
            columns={columns}
            rowHeader="title"
            tableLayout="auto"
          />
        )}
      </EuiPanel>

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
