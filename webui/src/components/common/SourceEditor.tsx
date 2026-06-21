/**
 * SourceEditor — pick a connector, fill its dynamic form, test the connection,
 * and save. The reusable unit shared by the wizard's "Add source" step and the
 * Sources manager's add/edit flow.
 */
import React, { useEffect, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiHorizontalRule,
  EuiSpacer,
  EuiSwitch,
  EuiText,
} from '@elastic/eui';
import type { ConnectorManifest, SourceInstance } from '../../lib/types';
import { api, ApiError } from '../../lib/api';
import { saveSource, slugify } from '../../lib/connectors';
import { ConnectorForm, ConnectorFormValue, missingRequired } from './ConnectorForm';
import { ConnectorPicker } from './ConnectorPicker';
import { ErrorCallout, Loading } from './ui';

interface SourceEditorProps {
  connectors: ConnectorManifest[];
  /** An existing source to edit (config pre-filled); omit to add a new one. */
  existing?: SourceInstance;
  /** Default to primary on first save (e.g. the wizard's first source). */
  defaultPrimary?: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}

export const SourceEditor: React.FC<SourceEditorProps> = ({
  connectors,
  existing,
  defaultPrimary,
  onSaved,
  onCancel,
}) => {
  const editing = Boolean(existing);
  const [manifest, setManifest] = useState<ConnectorManifest | null>(
    existing ? connectors.find((c) => c.source_type === existing.source_type) || null : null,
  );
  const [value, setValue] = useState<ConnectorFormValue>({
    config: (existing?.config as Record<string, unknown>) || {},
    secrets: {},
  });
  const [displayName, setDisplayName] = useState(existing?.display_name || '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [isPrimary, setIsPrimary] = useState(existing?.is_primary ?? defaultPrimary ?? false);
  const [showValidation, setShowValidation] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; sample?: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    // Prefill display name from manifest when picking a fresh connector.
    if (manifest && !displayName && !editing) {
      setDisplayName(manifest.display_name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  const configuredSecrets = existing?.configured_secrets || [];

  const pickConnector = (m: ConnectorManifest) => {
    setManifest(m);
    setValue({ config: {}, secrets: {} });
    setTestResult(null);
    setError(null);
  };

  const onTest = async () => {
    if (!manifest) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      // The backend tests the wired primary source. For the most reliable result,
      // save first (when this is the primary), then test; otherwise call test directly.
      const res = await api.testConnector(manifest.source_type);
      setTestResult({ ok: res.ok, message: res.message || (res.ok ? 'OK' : 'Failed'), sample: res.sample_count });
    } catch (e) {
      setError(e);
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    if (!manifest) return;
    const missing = missingRequired(manifest, value, configuredSecrets);
    if (missing.length) {
      setShowValidation(true);
      setError(new Error(`Please complete required fields: ${missing.map((m) => m.label).join(', ')}`));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const id = existing?.id || slugify(displayName || manifest.source_type) + '-' + Date.now().toString(36).slice(-4);
      await saveSource(manifest, value, {
        id,
        displayName: displayName || manifest.display_name,
        enabled,
        isPrimary,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e : new Error(String(e)));
    } finally {
      setSaving(false);
    }
  };

  if (!connectors.length) {
    return <Loading label="Loading connectors…" />;
  }

  if (!manifest) {
    return (
      <div>
        <EuiText size="s" color="subdued">
          <p>Choose the system you want the agent to read security events from.</p>
        </EuiText>
        <EuiSpacer size="m" />
        <ConnectorPicker connectors={connectors} onSelect={pickConnector} />
        {onCancel ? (
          <EuiButtonEmpty onClick={onCancel} iconType="cross">
            Cancel
          </EuiButtonEmpty>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiText>
            <strong>{manifest.display_name}</strong>{' '}
            <EuiText size="xs" color="subdued" component="span">
              ({manifest.source_type})
            </EuiText>
          </EuiText>
        </EuiFlexItem>
        {!editing ? (
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty size="s" iconType="arrowLeft" onClick={() => setManifest(null)}>
              Choose a different connector
            </EuiButtonEmpty>
          </EuiFlexItem>
        ) : null}
      </EuiFlexGroup>
      <EuiSpacer size="m" />

      <EuiFormRow label="Display name" helpText="A friendly name shown across the console." fullWidth>
        <EuiFieldText
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={manifest.display_name}
          fullWidth
        />
      </EuiFormRow>
      <EuiFlexGroup gutterSize="l" responsive={false} wrap>
        <EuiFlexItem grow={false}>
          <EuiFormRow hasEmptyLabelSpace>
            <EuiSwitch label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFormRow hasEmptyLabelSpace>
            <EuiSwitch
              label="Primary (the agent reads from this)"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />
          </EuiFormRow>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiHorizontalRule margin="m" />

      <ConnectorForm
        manifest={manifest}
        value={value}
        onChange={setValue}
        configuredSecrets={configuredSecrets}
        showValidation={showValidation}
      />

      <EuiSpacer size="l" />

      {testResult ? (
        <>
          <EuiCallOut
            size="s"
            color={testResult.ok ? 'success' : 'danger'}
            iconType={testResult.ok ? 'check' : 'alert'}
            title={testResult.ok ? 'Connection succeeded' : 'Connection failed'}
          >
            <p>
              {testResult.message}
              {typeof testResult.sample === 'number'
                ? ` — sampled ${testResult.sample} event(s).`
                : ''}
            </p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      ) : null}

      {error ? (
        <>
          <ErrorCallout error={error} title="Could not save / test" />
          <EuiSpacer size="m" />
        </>
      ) : null}

      <EuiFlexGroup justifyContent="flexEnd" gutterSize="s" responsive={false}>
        {onCancel ? (
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty onClick={onCancel}>Cancel</EuiButtonEmpty>
          </EuiFlexItem>
        ) : null}
        <EuiFlexItem grow={false}>
          <EuiButton iconType="beaker" onClick={onTest} isLoading={testing} color="text">
            Test connection
          </EuiButton>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton iconType="save" fill onClick={onSave} isLoading={saving}>
            {editing ? 'Save changes' : 'Add source'}
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
    </div>
  );
};
