/**
 * Step 2 — Add your first source. Pick a connector, render its dynamic form,
 * test the connection, save. Multiple sources can be added; one is marked
 * primary (the surface the agent reads from).
 */
import React, { useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { ConnectorManifest, SourceInstance } from '../../../lib/types';
import { api } from '../../../lib/api';
import { COLORS } from '../../../lib/theme';
import { EmptyState, ErrorCallout, IconChip } from '../../common/ui';
import { SourceEditor } from '../../common/SourceEditor';
import { humanizeToken } from '../../../lib/format';

interface SourcesStepProps {
  connectors: ConnectorManifest[];
  sources: SourceInstance[];
  onChanged: () => Promise<void> | void;
  demoMode: boolean;
}

export const SourcesStep: React.FC<SourcesStepProps> = ({
  connectors,
  sources,
  onChanged,
  demoMode,
}) => {
  const [adding, setAdding] = useState(sources.length === 0);
  const [editing, setEditing] = useState<SourceInstance | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = async () => {
    setAdding(false);
    setEditing(null);
    await onChanged();
  };

  const setPrimary = async (s: SourceInstance) => {
    setBusyId(s.id);
    setError(null);
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
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (s: SourceInstance) => {
    setBusyId(s.id);
    setError(null);
    try {
      await api.deleteSource(s.id);
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <EuiTitle size="m">
        <h2>Connect your log sources</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      <EuiText color="subdued">
        <p>
          Add at least one source so the agent has events to triage. You can add several
          (an Elasticsearch, a Splunk, a webhook receiver…) and mark one as primary.
        </p>
      </EuiText>

      {demoMode ? (
        <>
          <EuiSpacer size="m" />
          <EuiCallOut size="s" color="primary" iconType="beaker" title="Demo mode">
            <p>Adding a source is optional in demo mode — you can skip ahead.</p>
          </EuiCallOut>
        </>
      ) : null}

      <EuiSpacer size="l" />

      {error ? (
        <>
          <ErrorCallout error={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* Configured sources list */}
      {sources.length > 0 && !adding && !editing ? (
        <>
          {sources.map((s) => {
            const meta = connectors.find((c) => c.source_type === s.source_type);
            return (
              <EuiPanel key={s.id} hasBorder paddingSize="m" style={{ marginBottom: 12 }}>
                <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <IconChip icon="logstashQueue" accent={COLORS.primary} />
                  </EuiFlexItem>
                  <EuiFlexItem>
                    <EuiText>
                      <strong>{s.display_name || meta?.display_name || s.source_type}</strong>{' '}
                      {s.is_primary ? <EuiBadge color={COLORS.primary}>Primary</EuiBadge> : null}{' '}
                      {s.enabled ? null : <EuiBadge color="hollow">Disabled</EuiBadge>}
                    </EuiText>
                    <EuiText size="xs" color="subdued">
                      <span>
                        {humanizeToken(s.source_type)} · {humanizeToken(s.ingest_mode)}
                        {s.configured_secrets?.length
                          ? ` · ${s.configured_secrets.length} secret(s) set`
                          : ''}
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
                        <EuiButtonEmpty size="s" iconType="pencil" onClick={() => setEditing(s)}>
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
          })}
          <EuiSpacer size="m" />
          <EuiButton iconType="plusInCircle" onClick={() => setAdding(true)}>
            Add another source
          </EuiButton>
        </>
      ) : null}

      {sources.length === 0 && !adding ? (
        <EmptyState
          iconType="plusInCircle"
          title="No sources yet"
          body="Add your first source to give the agent events to triage."
          actions={
            <EuiButton fill iconType="plusInCircle" onClick={() => setAdding(true)}>
              Add a source
            </EuiButton>
          }
        />
      ) : null}

      {(adding || editing) ? (
        <EuiPanel hasBorder paddingSize="l">
          <SourceEditor
            connectors={connectors}
            existing={editing || undefined}
            defaultPrimary={sources.length === 0}
            onSaved={reload}
            onCancel={sources.length > 0 ? () => reload() : undefined}
          />
        </EuiPanel>
      ) : null}
    </div>
  );
};
