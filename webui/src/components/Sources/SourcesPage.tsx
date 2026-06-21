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
import type { ConnectorManifest, SourceInstance } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS } from '../../lib/theme';
import { humanizeToken } from '../../lib/format';
import { EmptyState, ErrorCallout, IconChip, Loading, SectionHeader } from '../common/ui';
import { SourceEditor } from '../common/SourceEditor';

export const SourcesPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [connectors, setConnectors] = useState<ConnectorManifest[]>([]);
  const [sources, setSources] = useState<SourceInstance[]>([]);
  const [editor, setEditor] = useState<{ mode: 'add' } | { mode: 'edit'; source: SourceInstance } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
    }
  };

  return (
    <div>
      <SectionHeader
        icon="logstashQueue"
        title="Sources"
        description="Connect and manage the systems the agent reads security events from."
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
          return (
            <EuiPanel key={s.id} hasBorder paddingSize="m" style={{ marginBottom: 12 }}>
              <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false} wrap>
                <EuiFlexItem grow={false}>
                  <IconChip icon="logstashQueue" accent={s.is_primary ? COLORS.primary : COLORS.subdued} />
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
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiFlexGroup gutterSize="s" responsive={false}>
                    {!s.is_primary ? (
                      <EuiFlexItem grow={false}>
                        <EuiButtonEmpty
                          size="s"
                          iconType="starFilled"
                          onClick={() => setPrimary(s)}
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
                        onClick={() => remove(s)}
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
    </div>
  );
};
