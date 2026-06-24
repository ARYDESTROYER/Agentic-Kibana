/**
 * Sources manager — list configured sources, add/edit via the dynamic
 * ConnectorForm (through SourceEditor), test, delete, set primary. Reuses the
 * exact same form the wizard uses.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCode,
  EuiConfirmModal,
  EuiFlexGroup,
  EuiFlexItem,
  EuiModal,
  EuiModalBody,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiPanel,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type {
  ConnectorManifest,
  EntityStrategy,
  IndexPattern,
  SourceConfigExtras,
  SourceInstance,
} from '../../lib/types';
import { api } from '../../lib/api';
import { categoryMeta, COLORS } from '../../lib/theme';
import { humanizeToken } from '../../lib/format';
import { EmptyState, ErrorCallout, IconChip, Loading, PageHeader } from '../common/ui';
import { SourceEditor } from '../common/SourceEditor';
import { SourceLogsFlyout } from './SourceLogsFlyout';

/** Human label for an entity strategy (matches the editor's choices). */
const ENTITY_LABELS: Record<string, string> = {
  auto: 'Auto entity',
  ip: 'Entity: IP',
  host: 'Entity: Host',
  user: 'Entity: User',
  rule: 'Entity: Rule',
};

/**
 * The index patterns + roles a source reads, derived for the at-a-glance summary.
 * Prefers `config.index_patterns`; falls back to the legacy comma-separated
 * `data_view_pattern` (treated as `events`).
 */
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

export const SourcesPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [connectors, setConnectors] = useState<ConnectorManifest[]>([]);
  const [sources, setSources] = useState<SourceInstance[]>([]);
  const [editor, setEditor] = useState<{ mode: 'add' } | { mode: 'edit'; source: SourceInstance } | null>(null);
  const [logsSource, setLogsSource] = useState<SourceInstance | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Confirm-modal targets (delete is destructive; make-primary re-points ingestion).
  const [pendingDelete, setPendingDelete] = useState<SourceInstance | null>(null);
  const [pendingPrimary, setPendingPrimary] = useState<SourceInstance | null>(null);

  const load = useCallback(async () => {
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

  useEffect(() => {
    void load();
  }, [load]);

  const onSaved = async () => {
    setEditor(null);
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
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusyId(null);
      setPendingPrimary(null);
    }
  };

  const remove = async (s: SourceInstance) => {
    setBusyId(s.id);
    try {
      await api.deleteSource(s.id);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusyId(null);
      setPendingDelete(null);
    }
  };

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="logstashQueue"
        eyebrow="Platform"
        title="Sources"
        description={
          loading
            ? 'Connect and manage the systems the agent reads security events from.'
            : `${sources.length} source${sources.length === 1 ? '' : 's'} configured — the systems the agent reads security events from.`
        }
        actions={
          <EuiButton fill iconType="plusInCircle" onClick={() => setEditor({ mode: 'add' })}>
            Add source
          </EuiButton>
        }
      />

      {error ? (
        <>
          <ErrorCallout error={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {loading ? (
        <Loading label="Loading sources…" />
      ) : sources.length === 0 ? (
        <EmptyState
          iconType="plusInCircle"
          title="No sources configured"
          body="Add a source so the agent has events to triage."
          actions={
            <EuiButton fill iconType="plusInCircle" onClick={() => setEditor({ mode: 'add' })}>
              Add a source
            </EuiButton>
          }
        />
      ) : (
        sources.map((s) => {
          const meta = connectors.find((c) => c.source_type === s.source_type);
          const canBrowse = !!meta?.capabilities?.includes('browse');
          const catMeta = categoryMeta(meta?.category);
          const cfg = s.config as (Record<string, unknown> & Partial<SourceConfigExtras>) | undefined;
          const patterns = summarisePatterns(cfg);
          const strategy = ((cfg?.entity_strategy as EntityStrategy | string) || 'auto') as string;
          const messageField = (cfg?.message_field as string) || '';
          return (
            <EuiPanel key={s.id} hasBorder paddingSize="m" style={{ marginBottom: 12 }}>
              <EuiFlexGroup alignItems="flexStart" gutterSize="m" responsive={false} wrap>
                <EuiFlexItem grow={false}>
                  <IconChip
                    icon={catMeta.icon}
                    accent={s.is_primary ? COLORS.primary : catMeta.accent}
                  />
                </EuiFlexItem>
                <EuiFlexItem>
                  <EuiText>
                    <strong>{s.display_name || meta?.display_name || s.source_type}</strong>{' '}
                    {s.is_primary ? <EuiBadge color={COLORS.primary}>Primary</EuiBadge> : null}{' '}
                    {s.enabled ? (
                      <EuiBadge color={COLORS.success}>Enabled</EuiBadge>
                    ) : (
                      <EuiBadge color="hollow">Disabled</EuiBadge>
                    )}
                  </EuiText>
                  <EuiText size="xs" color="subdued">
                    <span>
                      {humanizeToken(s.source_type)} · {humanizeToken(s.ingest_mode)}
                      {s.configured_secrets?.length ? ` · ${s.configured_secrets.length} secret(s)` : ''}
                    </span>
                  </EuiText>

                  {/* At-a-glance triage config: patterns + roles, entity strategy, message field. */}
                  {patterns.length || strategy !== 'auto' || messageField ? (
                    <>
                      <EuiSpacer size="s" />
                      <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
                        {patterns.slice(0, 4).map((p, i) => (
                          <EuiFlexItem grow={false} key={`${p.pattern}-${i}`}>
                            <EuiBadge
                              color={p.role === 'alerts' ? COLORS.warning : 'hollow'}
                              iconType={p.role === 'alerts' ? 'alert' : 'indexMapping'}
                              title={`${p.role === 'alerts' ? 'Alerts' : 'Events'} pattern`}
                            >
                              {p.pattern}
                            </EuiBadge>
                          </EuiFlexItem>
                        ))}
                        {patterns.length > 4 ? (
                          <EuiFlexItem grow={false}>
                            <EuiBadge color="hollow">+{patterns.length - 4} more</EuiBadge>
                          </EuiFlexItem>
                        ) : null}
                        {strategy !== 'auto' ? (
                          <EuiFlexItem grow={false}>
                            <EuiBadge color="hollow" iconType="cluster">
                              {ENTITY_LABELS[strategy] || `Entity: ${humanizeToken(strategy)}`}
                            </EuiBadge>
                          </EuiFlexItem>
                        ) : null}
                        {messageField ? (
                          <EuiFlexItem grow={false}>
                            <EuiBadge color="hollow" iconType="documentEdit" title="Message field">
                              {messageField}
                            </EuiBadge>
                          </EuiFlexItem>
                        ) : null}
                      </EuiFlexGroup>
                    </>
                  ) : null}
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiFlexGroup gutterSize="s" responsive={false}>
                    {canBrowse ? (
                      <EuiFlexItem grow={false}>
                        <EuiButtonEmpty
                          size="s"
                          iconType="discoverApp"
                          onClick={() => setLogsSource(s)}
                        >
                          Logs
                        </EuiButtonEmpty>
                      </EuiFlexItem>
                    ) : null}
                    {!s.is_primary ? (
                      <EuiFlexItem grow={false}>
                        <EuiButtonEmpty
                          size="s"
                          iconType="starFilled"
                          onClick={() => setPendingPrimary(s)}
                          isLoading={busyId === s.id}
                        >
                          Make primary
                        </EuiButtonEmpty>
                      </EuiFlexItem>
                    ) : null}
                    <EuiFlexItem grow={false}>
                      <EuiButtonEmpty
                        size="s"
                        iconType="pencil"
                        onClick={() => setEditor({ mode: 'edit', source: s })}
                      >
                        Edit
                      </EuiButtonEmpty>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiButtonEmpty
                        size="s"
                        color="danger"
                        iconType="trash"
                        onClick={() => setPendingDelete(s)}
                        isLoading={busyId === s.id}
                      >
                        Remove
                      </EuiButtonEmpty>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                </EuiFlexItem>
              </EuiFlexGroup>
            </EuiPanel>
          );
        })
      )}

      {editor ? (
        <EuiModal onClose={() => setEditor(null)} style={{ width: 720, maxWidth: '95vw' }}>
          <EuiModalHeader>
            <EuiModalHeaderTitle>
              {editor.mode === 'add' ? 'Add a source' : `Edit ${editor.source.display_name || editor.source.source_type}`}
            </EuiModalHeaderTitle>
          </EuiModalHeader>
          <EuiModalBody>
            <SourceEditor
              connectors={connectors}
              existing={editor.mode === 'edit' ? editor.source : undefined}
              onSaved={onSaved}
              onCancel={() => setEditor(null)}
            />
          </EuiModalBody>
        </EuiModal>
      ) : null}

      {logsSource ? (
        <SourceLogsFlyout source={logsSource} onClose={() => setLogsSource(null)} />
      ) : null}

      {pendingPrimary ? (
        <EuiConfirmModal
          title="Make this the primary source?"
          onCancel={() => setPendingPrimary(null)}
          onConfirm={() => void setPrimary(pendingPrimary)}
          cancelButtonText="Cancel"
          confirmButtonText="Make primary"
          isLoading={busyId === pendingPrimary.id}
        >
          <EuiText size="s">
            <p>
              The agent reads new events from the <strong>primary</strong> source. Switching to{' '}
              <EuiCode>{pendingPrimary.display_name || pendingPrimary.source_type}</EuiCode> repoints
              ingestion to it; the current primary becomes a non-primary source (it is not deleted).
            </p>
          </EuiText>
        </EuiConfirmModal>
      ) : null}

      {pendingDelete ? (
        <EuiConfirmModal
          title="Remove this source?"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void remove(pendingDelete)}
          cancelButtonText="Cancel"
          confirmButtonText="Remove source"
          buttonColor="danger"
          isLoading={busyId === pendingDelete.id}
        >
          <EuiText size="s">
            <p>
              <EuiCode>{pendingDelete.display_name || pendingDelete.source_type}</EuiCode> will be
              removed and the agent will stop reading events from it. Existing cases are kept; its
              stored secrets are discarded. This cannot be undone.
            </p>
          </EuiText>
        </EuiConfirmModal>
      ) : null}
    </div>
  );
};
