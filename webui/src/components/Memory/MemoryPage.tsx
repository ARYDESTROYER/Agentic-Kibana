/**
 * Memory — operator-managed durable facts the agents always know.
 *
 * Memory is a small, curated set of facts (internal IP ranges, known scanners,
 * naming conventions, standing exceptions) that are injected into every
 * investigation + chat turn as a DISTINCT TRUSTED operator block. It is the
 * Claude.ai-style "memory" for the SOC: a human can add/edit/retire facts here,
 * or speak them conversationally in Chat ("remember: …" / "forget …"), which the
 * chat engine reflects back as a `memory_action`.
 *
 * This page lets a human SEE and curate that set:
 *   - a compact stats header (total / active / operator-vs-agent split),
 *   - search + filter (text/category/tags) and a source facet, plus a sort
 *     control (newest / updated / active-first / category),
 *   - optional grouping by category, with inline edit, active/inactive toggle and
 *     delete-with-confirm per fact.
 *
 * Agent-authored memories carry a `source: 'agent'` badge; the text is rendered
 * as plain text (never as markup) since it can be source-influenced. Memory never
 * overrides the deterministic case decision — it only informs the LLM.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonGroup,
  EuiButtonIcon,
  EuiCallOut,
  EuiComboBox,
  EuiConfirmModal,
  EuiFieldSearch,
  EuiFieldText,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiGlobalToastList,
  EuiHorizontalRule,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTextArea,
  EuiToolTip,
} from '@elastic/eui';
import type {
  EuiComboBoxOptionOption,
  EuiGlobalToastListToast as Toast,
} from '@elastic/eui';
import type { MemoryEntry } from '../../lib/types';
import { api } from '../../lib/api';
import type { MemoryPatch } from '../../lib/api';
import { COLORS, tint } from '../../lib/theme';
import { DASH, fmtNumber, formatTimestamp, humanizeAge, humanizeToken } from '../../lib/format';
import { Card, EmptyState, ErrorCallout, PageHeader, SectionHeader, Skeleton, StatTile } from '../common/ui';

/** A small source pill — human (operator) vs agent (conversationally added). */
const SourceBadge: React.FC<{ source?: string; author?: string }> = ({ source, author }) => {
  const isAgent = (source || '').toLowerCase() === 'agent';
  const accent = isAgent ? COLORS.accent : COLORS.primary;
  return (
    <EuiToolTip
      content={
        isAgent
          ? 'Authored by an agent (conversationally, in Chat). Treated as untrusted text.'
          : 'Authored by a human operator.'
      }
    >
      <EuiBadge
        color={tint(accent, 0.16)}
        style={{ color: accent }}
        iconType={isAgent ? 'compute' : 'user'}
      >
        {isAgent ? 'Agent' : 'Operator'}
        {author ? ` · ${author}` : ''}
      </EuiBadge>
    </EuiToolTip>
  );
};

const tagOptions = (tags?: string[]): Array<EuiComboBoxOptionOption<string>> =>
  (tags || []).map((t) => ({ label: t }));

/** Uncategorised facts collect under this stable bucket label. */
const UNCATEGORISED = 'Uncategorised';

/* --------------------------------------------------------------- add memory -- */

const AddMemoryCard: React.FC<{
  onAdded: (e: MemoryEntry) => void;
  onError: (e: unknown) => void;
  categories: string[];
}> = ({ onAdded, onError, categories }) => {
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState<Array<EuiComboBoxOptionOption<string>>>([]);
  const [submitting, setSubmitting] = useState(false);

  // Suggest existing categories so facts cluster instead of fragmenting.
  const categoryOptions = useMemo(
    () => categories.map((c) => ({ label: humanizeToken(c), value: c })),
    [categories],
  );
  const selectedCategory: Array<EuiComboBoxOptionOption<string>> = category
    ? [{ label: humanizeToken(category), value: category }]
    : [];

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
          <EuiFormRow label="Category (optional)" helpText="Pick an existing one or type a new label." fullWidth>
            <EuiComboBox
              fullWidth
              singleSelection={{ asPlainText: true }}
              placeholder="e.g. network, scanners, policy"
              options={categoryOptions}
              selectedOptions={selectedCategory}
              onCreateOption={(v) => setCategory(v.trim())}
              onChange={(sel) => setCategory((sel[0]?.value ?? sel[0]?.label ?? '') as string)}
              isClearable
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
                  icon="folderClosed"
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
          <EuiFlexItem grow={false}>
            <span
              style={{
                display: 'inline-block',
                width: 4,
                alignSelf: 'stretch',
                minHeight: 22,
                borderRadius: 3,
                background: entry.active ? COLORS.success : COLORS.subdued,
                opacity: entry.active ? 0.85 : 0.4,
              }}
              aria-hidden
            />
          </EuiFlexItem>
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
                <EuiToolTip content="Edit this fact">
                  <EuiButtonIcon
                    iconType="pencil"
                    aria-label="Edit memory"
                    color="text"
                    onClick={() => setEditing(true)}
                    isDisabled={busy}
                  />
                </EuiToolTip>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiToolTip content="Delete this fact">
                  <EuiButtonIcon
                    iconType="trash"
                    aria-label="Delete memory"
                    color="danger"
                    onClick={() => onDelete(entry)}
                    isDisabled={busy}
                  />
                </EuiToolTip>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiFlexItem>
        </EuiFlexGroup>
      )}
    </Card>
  );
};

/* ------------------------------------------------------------- filter bar --- */

type SortKey = 'updated' | 'created' | 'active' | 'category';

const SORT_OPTIONS: Array<{ value: SortKey; text: string }> = [
  { value: 'updated', text: 'Recently updated' },
  { value: 'created', text: 'Newest first' },
  { value: 'active', text: 'Active first' },
  { value: 'category', text: 'By category' },
];

const SOURCE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'human', label: 'Operator' },
  { id: 'agent', label: 'Agent' },
];

const ACTIVE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
];

/* -------------------------------------------------------------------- page --- */

export const MemoryPage: React.FC = () => {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemoryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ---- view controls ----
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'human' | 'agent'>('all');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [categories, setCategories] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>('updated');
  const [grouped, setGrouped] = useState(true);

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

  // ---- derived summary + facets ----
  const stats = useMemo(() => {
    let active = 0;
    let operator = 0;
    let agent = 0;
    for (const e of entries) {
      if (e.active) active += 1;
      if ((e.source || '').toLowerCase() === 'agent') agent += 1;
      else operator += 1;
    }
    return { total: entries.length, active, operator, agent };
  }, [entries]);

  const categoryFacet = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.category) set.add(e.category);
    return Array.from(set).sort();
  }, [entries]);

  // Drop any selected category that no longer exists so the list can't silently empty.
  useEffect(() => {
    setCategories((prev) => prev.filter((c) => categoryFacet.includes(c)));
  }, [categoryFacet]);

  const filteredSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = entries.filter((e) => {
      const isAgent = (e.source || '').toLowerCase() === 'agent';
      if (sourceFilter === 'agent' && !isAgent) return false;
      if (sourceFilter === 'human' && isAgent) return false;
      if (activeFilter === 'active' && !e.active) return false;
      if (activeFilter === 'inactive' && e.active) return false;
      if (categories.length && !(e.category && categories.includes(e.category))) return false;
      if (!q) return true;
      const hay = `${e.text} ${e.category || ''} ${(e.tags || []).join(' ')} ${e.author || ''}`.toLowerCase();
      return hay.includes(q);
    });
    const byTime = (e: MemoryEntry, useUpdated: boolean) =>
      (useUpdated ? e.updated_at || e.created_at : e.created_at) || '';
    return [...rows].sort((a, b) => {
      switch (sort) {
        case 'created':
          return byTime(b, false).localeCompare(byTime(a, false));
        case 'active':
          // Active first, then most-recently updated within each band.
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
  }, [entries, search, sourceFilter, activeFilter, categories, sort]);

  // Group the filtered set by category when grouping is on.
  const groups = useMemo(() => {
    if (!grouped) return null;
    const map = new Map<string, MemoryEntry[]>();
    for (const e of filteredSorted) {
      const key = e.category ? humanizeToken(e.category) : UNCATEGORISED;
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    // Uncategorised last; everything else alphabetical.
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === UNCATEGORISED) return 1;
      if (b[0] === UNCATEGORISED) return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [filteredSorted, grouped]);

  const toOpts = (vals: string[]): Array<EuiComboBoxOptionOption<string>> =>
    vals.map((v) => ({ label: humanizeToken(v), value: v }));
  const fromOpts = (sel: Array<EuiComboBoxOptionOption<string>>): string[] =>
    sel.map((o) => (o.value ?? o.label) as string);

  const anyFilter =
    search.trim().length > 0 ||
    sourceFilter !== 'all' ||
    activeFilter !== 'all' ||
    categories.length > 0;

  const clearFilters = useCallback(() => {
    setSearch('');
    setSourceFilter('all');
    setActiveFilter('all');
    setCategories([]);
  }, []);

  const renderRow = (entry: MemoryEntry) => (
    <MemoryRow
      key={entry.id}
      entry={entry}
      onSave={onSave}
      onToggleActive={(e) => void onToggleActive(e)}
      onDelete={(e) => setPendingDelete(e)}
      busy={busyId === entry.id}
    />
  );

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="memory"
        accent={COLORS.primary}
        eyebrow="Platform"
        title="Memory"
        description="Durable facts the agents always know — injected into every investigation and chat turn as trusted operator context."
        actions={
          <EuiButtonEmpty size="s" iconType="refresh" onClick={() => void load()} isLoading={loading}>
            Refresh
          </EuiButtonEmpty>
        }
      />

      <EuiCallOut title="What is memory?" color="primary" iconType="iInCircle" size="s">
        <p>
          Memory is a curated set of durable facts the agents always know — internal IP ranges,
          known scanners, naming conventions, standing exceptions. Active facts are injected into
          investigations and chat as a <strong>trusted operator block</strong>; they inform the LLM
          but <strong>never override the deterministic close/escalate decision</strong>. You can
          also say <strong>“remember: …”</strong> or <strong>“forget …”</strong> in Chat and the
          agent will manage memory for you.
        </p>
      </EuiCallOut>

      <EuiSpacer size="l" />

      {/* ---- summary tiles ---- */}
      {loading && entries.length === 0 ? (
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
            <StatTile label="Total facts" value={fmtNumber(stats.total)} icon="memory" accent={COLORS.primary} />
          </EuiFlexItem>
          <EuiFlexItem>
            <StatTile
              label="Active"
              value={fmtNumber(stats.active)}
              icon="check"
              accent={COLORS.success}
              sub={stats.total > 0 ? `${fmtNumber(stats.total - stats.active)} inactive` : undefined}
            />
          </EuiFlexItem>
          <EuiFlexItem>
            <StatTile label="Operator-authored" value={fmtNumber(stats.operator)} icon="user" accent={COLORS.primary} />
          </EuiFlexItem>
          <EuiFlexItem>
            <StatTile label="Agent-authored" value={fmtNumber(stats.agent)} icon="compute" accent={COLORS.accent} />
          </EuiFlexItem>
        </EuiFlexGrid>
      )}

      <EuiSpacer size="l" />

      <AddMemoryCard
        onAdded={onAdded}
        onError={(e) => addToast(e instanceof Error ? e.message : 'Could not save memory.', 'danger')}
        categories={categoryFacet}
      />

      <EuiSpacer size="l" />

      <SectionHeader
        icon="memory"
        accent={COLORS.accent}
        title="Saved memories"
        description={
          loading
            ? 'Loading…'
            : `${fmtNumber(filteredSorted.length)} of ${fmtNumber(stats.total)} shown · ${fmtNumber(
                stats.active,
              )} active`
        }
        actions={
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiToolTip content="Group facts under their category">
                <EuiSwitch
                  compressed
                  label="Group by category"
                  checked={grouped}
                  onChange={(e) => setGrouped(e.target.checked)}
                />
              </EuiToolTip>
            </EuiFlexItem>
            <EuiFlexItem grow={false} style={{ minWidth: 180 }}>
              <EuiSelect
                compressed
                aria-label="Sort memories"
                prepend="Sort"
                options={SORT_OPTIONS}
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
              />
            </EuiFlexItem>
          </EuiFlexGroup>
        }
      />

      {/* ---- filter toolbar ---- */}
      {!error && entries.length > 0 ? (
        <>
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false} style={{ minWidth: 220 }}>
              <EuiFieldSearch
                compressed
                fullWidth
                placeholder="Search facts, category, tags…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                isClearable
                aria-label="Search memories"
              />
            </EuiFlexItem>
            {categoryFacet.length > 0 ? (
              <EuiFlexItem grow={false} style={{ minWidth: 180, maxWidth: 300 }}>
                <EuiComboBox
                  compressed
                  placeholder="Category"
                  aria-label="Filter by category"
                  options={toOpts(categoryFacet)}
                  selectedOptions={toOpts(categories)}
                  onChange={(sel) => setCategories(fromOpts(sel))}
                  isClearable
                />
              </EuiFlexItem>
            ) : null}
            <EuiFlexItem grow={false}>
              <EuiButtonGroup
                legend="Filter by author"
                options={SOURCE_FILTERS}
                idSelected={sourceFilter}
                onChange={(id) => setSourceFilter(id as 'all' | 'human' | 'agent')}
                buttonSize="compressed"
              />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonGroup
                legend="Filter by active state"
                options={ACTIVE_FILTERS}
                idSelected={activeFilter}
                onChange={(id) => setActiveFilter(id as 'all' | 'active' | 'inactive')}
                buttonSize="compressed"
              />
            </EuiFlexItem>
            {anyFilter ? (
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty size="s" iconType="cross" onClick={clearFilters}>
                  Clear
                </EuiButtonEmpty>
              </EuiFlexItem>
            ) : null}
          </EuiFlexGroup>
          <EuiSpacer size="m" />
        </>
      ) : null}

      {error ? (
        <ErrorCallout error={error} title="Could not load memory" />
      ) : loading && entries.length === 0 ? (
        <EuiPanel hasBorder paddingSize="m">
          <Skeleton rows={4} height={44} />
        </EuiPanel>
      ) : entries.length === 0 ? (
        <EmptyState
          iconType="memory"
          title="No memories yet"
          body="Add a durable fact above, or teach the agent one conversationally in Chat with “remember: …”."
        />
      ) : filteredSorted.length === 0 ? (
        <EmptyState
          iconType="search"
          title="No memories match"
          body="No facts match the current filters. Clear them to see all memories."
          actions={
            <EuiButton size="s" iconType="cross" onClick={clearFilters}>
              Clear filters
            </EuiButton>
          }
        />
      ) : groups ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {groups.map(([label, rows]) => (
            <div key={label}>
              <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
                <EuiFlexItem grow={false}>
                  <EuiBadge
                    color={label === UNCATEGORISED ? 'hollow' : tint(COLORS.accent, 0.16)}
                    style={label === UNCATEGORISED ? undefined : { color: COLORS.accent }}
                    iconType="folderClosed"
                  >
                    {label}
                  </EuiBadge>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiText size="xs" color="subdued">
                    <span>
                      {fmtNumber(rows.length)} fact{rows.length === 1 ? '' : 's'}
                    </span>
                  </EuiText>
                </EuiFlexItem>
              </EuiFlexGroup>
              <EuiSpacer size="s" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {rows.map(renderRow)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filteredSorted.map(renderRow)}
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
            <p>
              The agents will no longer know this fact. To retire it without deleting, toggle{' '}
              <strong>Active</strong> off instead.
            </p>
          </EuiText>
        </EuiConfirmModal>
      ) : null}

      <EuiHorizontalRule margin="l" />
      <EuiText size="xs" color="subdued">
        <p>
          Inactive memories are retained but not injected into prompts — toggle{' '}
          <strong>Active</strong> off to retire a fact without deleting it. Agent-authored facts are
          treated as untrusted text and rendered as plain text. {DASH}
        </p>
      </EuiText>

      <EuiGlobalToastList toasts={toasts} dismissToast={removeToast} toastLifeTimeMs={5000} />
    </div>
  );
};
