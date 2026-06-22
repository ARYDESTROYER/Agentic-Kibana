/**
 * Memory — operator-managed durable facts the agents always know.
 *
 * Memory is a small, curated set of facts (internal IP ranges, known scanners,
 * naming conventions, standing exceptions) that are injected into every
 * investigation + chat turn. It is the Claude.ai-style "memory" for the SOC: a
 * human can add/edit/retire facts here, or speak them conversationally in Chat
 * ("remember: …" / "forget …"), which the chat engine reflects back as a
 * `memory_action`.
 *
 * Agent-authored memories carry a `source: 'agent'` badge; the text is rendered
 * as plain text (never as markup) since it can be source-influenced.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCallOut,
  EuiComboBox,
  EuiConfirmModal,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiGlobalToastList,
  EuiHorizontalRule,
  EuiPanel,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTextArea,
} from '@elastic/eui';
import type {
  EuiComboBoxOptionOption,
  EuiGlobalToastListToast as Toast,
} from '@elastic/eui';
import type { MemoryEntry } from '../../lib/types';
import { api } from '../../lib/api';
import type { MemoryPatch } from '../../lib/api';
import { COLORS, tint } from '../../lib/theme';
import { DASH, formatTimestamp, humanizeAge, humanizeToken } from '../../lib/format';
import { Card, EmptyState, ErrorCallout, PageHeader, SectionHeader, Skeleton } from '../common/ui';

/** A small source pill — human (operator) vs agent (conversationally added). */
const SourceBadge: React.FC<{ source?: string; author?: string }> = ({ source, author }) => {
  const isAgent = (source || '').toLowerCase() === 'agent';
  const accent = isAgent ? COLORS.accent : COLORS.primary;
  return (
    <EuiBadge
      color={tint(accent, 0.16)}
      style={{ color: accent }}
      iconType={isAgent ? 'compute' : 'user'}
      title={author ? `By ${author}` : undefined}
    >
      {isAgent ? 'Agent' : 'Operator'}
      {author ? ` · ${author}` : ''}
    </EuiBadge>
  );
};

const tagOptions = (tags?: string[]): Array<EuiComboBoxOptionOption<string>> =>
  (tags || []).map((t) => ({ label: t }));

/* --------------------------------------------------------------- add memory -- */

const AddMemoryCard: React.FC<{ onAdded: (e: MemoryEntry) => void; onError: (e: unknown) => void }> = ({
  onAdded,
  onError,
}) => {
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState<Array<EuiComboBoxOptionOption<string>>>([]);
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(async () => {
    const body = text.trim();
    if (!body) return;
    setSubmitting(true);
    try {
      const entry = await api.addMemory({
        text: body,
        category: category.trim() || undefined,
        tags: tags.map((t) => (t.label || '').trim()).filter(Boolean),
      });
      onAdded(entry);
      setText('');
      setCategory('');
      setTags([]);
    } catch (e) {
      onError(e);
    } finally {
      setSubmitting(false);
    }
  }, [text, category, tags, onAdded, onError]);

  return (
    <Card title="Add a memory" icon="plusInCircle" accent={COLORS.primary}>
      <EuiFormRow label="Fact" helpText="A durable fact the agents should always know." fullWidth>
        <EuiTextArea
          fullWidth
          rows={2}
          placeholder="e.g. 10.20.0.0/16 is our internal corp network — never treat it as external."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </EuiFormRow>
      <EuiSpacer size="s" />
      <EuiFlexGroup gutterSize="m" wrap>
        <EuiFlexItem>
          <EuiFormRow label="Category (optional)" fullWidth>
            <EuiFieldText
              fullWidth
              icon="tag"
              placeholder="e.g. network, scanners, policy"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem>
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
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      <EuiFlexGroup justifyContent="flexEnd" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiButton
            fill
            size="s"
            iconType="plusInCircle"
            onClick={() => void submit()}
            isLoading={submitting}
            isDisabled={!text.trim() || submitting}
          >
            Save memory
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
    </Card>
  );
};

/* ----------------------------------------------------------- memory row ----- */

const MemoryRow: React.FC<{
  entry: MemoryEntry;
  onSave: (id: string, patch: MemoryPatch) => Promise<void>;
  onToggleActive: (entry: MemoryEntry) => void;
  onDelete: (entry: MemoryEntry) => void;
  busy: boolean;
}> = ({ entry, onSave, onToggleActive, onDelete, busy }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  const [category, setCategory] = useState(entry.category || '');
  const [tags, setTags] = useState<Array<EuiComboBoxOptionOption<string>>>(tagOptions(entry.tags));
  const [saving, setSaving] = useState(false);

  // Re-seed local edit buffers when the underlying entry changes (e.g. refresh).
  useEffect(() => {
    if (!editing) {
      setText(entry.text);
      setCategory(entry.category || '');
      setTags(tagOptions(entry.tags));
    }
  }, [entry, editing]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(entry.id, {
        text: text.trim(),
        category: category.trim(),
        tags: tags.map((t) => (t.label || '').trim()).filter(Boolean),
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [entry.id, text, category, tags, onSave]);

  const dim = !entry.active;

  return (
    <Card variant="flat" paddingSize="m">
      {editing ? (
        <>
          <EuiTextArea
            fullWidth
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Edit memory text"
          />
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem>
              <EuiFormRow label="Category" fullWidth>
                <EuiFieldText
                  fullWidth
                  icon="tag"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow label="Tags" fullWidth>
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
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="s" />
          <EuiFlexGroup justifyContent="flexEnd" gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                size="s"
                onClick={() => {
                  setEditing(false);
                  setText(entry.text);
                  setCategory(entry.category || '');
                  setTags(tagOptions(entry.tags));
                }}
              >
                Cancel
              </EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                fill
                size="s"
                iconType="save"
                onClick={() => void save()}
                isLoading={saving}
                isDisabled={!text.trim()}
              >
                Save
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ) : (
        <EuiFlexGroup gutterSize="m" alignItems="flexStart" responsive={false}>
          <EuiFlexItem>
            <EuiText size="s" style={dim ? { opacity: 0.55 } : undefined}>
              <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{entry.text}</p>
            </EuiText>
            <EuiSpacer size="xs" />
            <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
              <EuiFlexItem grow={false}>
                <SourceBadge source={entry.source} author={entry.author} />
              </EuiFlexItem>
              {entry.category ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color="hollow" iconType="folderClosed">
                    {humanizeToken(entry.category)}
                  </EuiBadge>
                </EuiFlexItem>
              ) : null}
              {(entry.tags || []).map((t) => (
                <EuiFlexItem grow={false} key={t}>
                  <EuiBadge color="hollow" iconType="tag">
                    {t}
                  </EuiBadge>
                </EuiFlexItem>
              ))}
              {!entry.active ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color={tint(COLORS.subdued, 0.18)} style={{ color: COLORS.subdued }} iconType="eyeClosed">
                    Inactive
                  </EuiBadge>
                </EuiFlexItem>
              ) : null}
              <EuiFlexItem grow={false}>
                <EuiText size="xs" color="subdued">
                  <span title={formatTimestamp(entry.updated_at || entry.created_at)}>
                    updated {humanizeAge(entry.updated_at || entry.created_at)}
                  </span>
                </EuiText>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
              <EuiFlexItem grow={false}>
                <EuiSwitch
                  compressed
                  label="Active"
                  checked={entry.active}
                  onChange={() => onToggleActive(entry)}
                  disabled={busy}
                />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonIcon
                  iconType="pencil"
                  aria-label="Edit memory"
                  color="text"
                  onClick={() => setEditing(true)}
                  isDisabled={busy}
                />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonIcon
                  iconType="trash"
                  aria-label="Delete memory"
                  color="danger"
                  onClick={() => onDelete(entry)}
                  isDisabled={busy}
                />
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiFlexItem>
        </EuiFlexGroup>
      )}
    </Card>
  );
};

/* -------------------------------------------------------------------- page --- */

export const MemoryPage: React.FC = () => {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemoryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const addToast = useCallback((title: string, color: Toast['color'] = 'success') => {
    toastId.current += 1;
    setToasts((prev) => [...prev, { id: `mem-toast-${toastId.current}`, title, color }]);
  }, []);
  const removeToast = useCallback((t: Toast) => {
    setToasts((prev) => prev.filter((x) => x.id !== t.id));
  }, []);

  const load = useCallback(async () => {
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

  useEffect(() => {
    void load();
  }, [load]);

  const upsertLocal = useCallback((next: MemoryEntry) => {
    setEntries((prev) => {
      const i = prev.findIndex((e) => e.id === next.id);
      if (i === -1) return [next, ...prev];
      const copy = prev.slice();
      copy[i] = next;
      return copy;
    });
  }, []);

  const onAdded = useCallback(
    (entry: MemoryEntry) => {
      upsertLocal(entry);
      addToast('Memory saved.', 'success');
    },
    [upsertLocal, addToast],
  );

  const onSave = useCallback(
    async (id: string, patch: MemoryPatch) => {
      setBusyId(id);
      try {
        const next = await api.updateMemory(id, patch);
        upsertLocal(next);
        addToast('Memory updated.', 'success');
      } catch (e) {
        addToast(e instanceof Error ? e.message : 'Could not update memory.', 'danger');
        throw e;
      } finally {
        setBusyId(null);
      }
    },
    [upsertLocal, addToast],
  );

  const onToggleActive = useCallback(
    async (entry: MemoryEntry) => {
      setBusyId(entry.id);
      try {
        const next = await api.updateMemory(entry.id, { active: !entry.active });
        upsertLocal(next);
      } catch (e) {
        addToast(e instanceof Error ? e.message : 'Could not update memory.', 'danger');
      } finally {
        setBusyId(null);
      }
    },
    [upsertLocal, addToast],
  );

  const runDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteMemory(pendingDelete.id);
      setEntries((prev) => prev.filter((e) => e.id !== pendingDelete.id));
      addToast('Memory deleted.', 'success');
      setPendingDelete(null);
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not delete memory.', 'danger');
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, addToast]);

  const activeCount = useMemo(() => entries.filter((e) => e.active).length, [entries]);

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="bell"
        accent={COLORS.primary}
        eyebrow="Knowledge"
        title="Memory"
        description="Durable facts the agents always know — used in every investigation and chat turn."
        actions={
          <EuiButtonEmpty size="s" iconType="refresh" onClick={() => void load()} isLoading={loading}>
            Refresh
          </EuiButtonEmpty>
        }
      />

      <EuiCallOut
        title="What is memory?"
        color="primary"
        iconType="iInCircle"
        size="s"
      >
        <p>
          Memory is a curated set of durable facts the agents always know — internal IP ranges,
          known scanners, naming conventions, standing exceptions. They are injected into
          investigations and chat. You can also say <strong>“remember: …”</strong> or{' '}
          <strong>“forget …”</strong> in Chat and the agent will manage memory for you.
        </p>
      </EuiCallOut>

      <EuiSpacer size="l" />

      <AddMemoryCard
        onAdded={onAdded}
        onError={(e) => addToast(e instanceof Error ? e.message : 'Could not save memory.', 'danger')}
      />

      <EuiSpacer size="l" />

      <SectionHeader
        icon="bell"
        accent={COLORS.accent}
        title="Saved memories"
        description={
          loading
            ? 'Loading…'
            : `${entries.length} total · ${activeCount} active`
        }
      />

      {error ? (
        <ErrorCallout error={error} title="Could not load memory" />
      ) : loading && entries.length === 0 ? (
        <EuiPanel hasBorder paddingSize="m">
          <Skeleton rows={4} height={44} />
        </EuiPanel>
      ) : entries.length === 0 ? (
        <EmptyState
          iconType="bell"
          title="No memories yet"
          body="Add a durable fact above, or teach the agent one conversationally in Chat with “remember: …”."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {entries.map((entry) => (
            <MemoryRow
              key={entry.id}
              entry={entry}
              onSave={onSave}
              onToggleActive={(e) => void onToggleActive(e)}
              onDelete={(e) => setPendingDelete(e)}
              busy={busyId === entry.id}
            />
          ))}
        </div>
      )}

      {pendingDelete ? (
        <EuiConfirmModal
          title="Delete this memory?"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void runDelete()}
          cancelButtonText="Cancel"
          confirmButtonText="Delete"
          buttonColor="danger"
          isLoading={deleting}
        >
          <EuiText size="s">
            <p style={{ whiteSpace: 'pre-wrap' }}>“{pendingDelete.text}”</p>
            <p>The agents will no longer know this fact.</p>
          </EuiText>
        </EuiConfirmModal>
      ) : null}

      <EuiHorizontalRule margin="l" />
      <EuiText size="xs" color="subdued">
        <p>
          Inactive memories are retained but not injected into prompts — toggle{' '}
          <strong>Active</strong> off to retire a fact without deleting it. {DASH}
        </p>
      </EuiText>

      <EuiGlobalToastList toasts={toasts} dismissToast={removeToast} toastLifeTimeMs={5000} />
    </div>
  );
};
