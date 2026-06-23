/**
 * SourceEditor — pick a connector, fill its dynamic form, configure advanced
 * triage behaviour (N index patterns + roles, entity strategy, the message
 * field), test the connection, and save. The reusable unit shared by the
 * wizard's "Add source" step and the Sources manager's add/edit flow.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCallOut,
  EuiCode,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiHorizontalRule,
  EuiSelect,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type {
  ConnectorManifest,
  EntityStrategy,
  IndexPattern,
  SourceConfigExtras,
  SourceInstance,
} from '../../lib/types';
import { api, ApiError } from '../../lib/api';
import { saveSource, slugify } from '../../lib/connectors';
import { COLORS } from '../../lib/theme';
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

/** Roles a pattern can carry (matches the backend's canonical IndexPattern.role). */
const ROLE_OPTIONS: Array<{ value: IndexPattern['role']; text: string }> = [
  { value: 'events', text: 'Events — correlate, then triage' },
  { value: 'alerts', text: 'Alerts — investigate every match' },
];

/** Entity-strategy choices (matches the backend's canonical EntityStrategy). */
const ENTITY_OPTIONS: Array<{ value: EntityStrategy; text: string }> = [
  { value: 'auto', text: 'Auto (IP → host → user → rule)' },
  { value: 'ip', text: 'Source IP' },
  { value: 'host', text: 'Host' },
  { value: 'user', text: 'User' },
  { value: 'rule', text: 'Rule' },
];

/** Split a comma-separated `data_view_pattern` into trimmed, non-empty parts. */
function splitPatterns(s: unknown): string[] {
  if (typeof s !== 'string') return [];
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Derive the editable index-pattern rows from a source config.
 *
 * Prefers `config.index_patterns` when present; otherwise migrates the legacy
 * single `data_view_pattern` (which may itself be comma-separated) into one
 * `events` row per pattern. Always returns at least one (blank) row so the editor
 * is usable.
 */
function deriveIndexPatterns(cfg: Record<string, unknown>): IndexPattern[] {
  const existing = cfg.index_patterns;
  if (Array.isArray(existing) && existing.length) {
    return existing
      .filter((p): p is IndexPattern => !!p && typeof (p as IndexPattern).pattern === 'string')
      .map((p) => ({ pattern: String(p.pattern), role: p.role === 'alerts' ? 'alerts' : 'events' }));
  }
  const fromSingle = splitPatterns(cfg.data_view_pattern).map(
    (pattern): IndexPattern => ({ pattern, role: 'events' }),
  );
  return fromSingle.length ? fromSingle : [{ pattern: '', role: 'events' }];
}

/* ------------------------------------------------------------ patterns ----- */

const IndexPatternsEditor: React.FC<{
  rows: IndexPattern[];
  onChange: (rows: IndexPattern[]) => void;
}> = ({ rows, onChange }) => {
  const setRow = (i: number, patch: Partial<IndexPattern>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => onChange([...rows, { pattern: '', role: 'events' }]);
  const removeRow = (i: number) =>
    onChange(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [{ pattern: '', role: 'events' }]);

  return (
    <>
      <EuiText size="xs" color="subdued">
        <span>
          The index / data-view patterns this source reads. <strong>Alerts</strong> patterns:
          every matching event is investigated. <strong>Events</strong> patterns: correlated, then
          triaged. Add as many as you need.
        </span>
      </EuiText>
      <EuiSpacer size="s" />
      {rows.map((row, i) => (
        <EuiFlexGroup
          key={i}
          gutterSize="s"
          alignItems="flexEnd"
          responsive={false}
          style={{ marginBottom: 8 }}
        >
          <EuiFlexItem>
            <EuiFormRow
              label={i === 0 ? 'Index / data-view pattern' : undefined}
              fullWidth
            >
              <EuiFieldText
                fullWidth
                icon="indexMapping"
                placeholder="e.g. all-logs-* or wazuh-alerts-*"
                value={row.pattern}
                onChange={(e) => setRow(i, { pattern: e.target.value })}
                aria-label={`Index pattern ${i + 1}`}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem grow={false} style={{ minWidth: 260 }}>
            <EuiFormRow label={i === 0 ? 'Role' : undefined} fullWidth>
              <EuiSelect
                options={ROLE_OPTIONS}
                value={row.role}
                onChange={(e) => setRow(i, { role: e.target.value as IndexPattern['role'] })}
                aria-label={`Role for pattern ${i + 1}`}
                fullWidth
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiFormRow hasEmptyLabelSpace={i === 0}>
              <EuiButtonIcon
                iconType="trash"
                color="danger"
                aria-label={`Remove pattern ${i + 1}`}
                onClick={() => removeRow(i)}
              />
            </EuiFormRow>
          </EuiFlexItem>
        </EuiFlexGroup>
      ))}
      <EuiButtonEmpty size="s" iconType="plusInCircle" onClick={addRow}>
        Add pattern
      </EuiButtonEmpty>
    </>
  );
};

/* --------------------------------------------------------- test result ----- */

const TestResultCallout: React.FC<{
  result: {
    ok: boolean;
    message: string;
    sample?: number | null;
    mode?: string | null;
    cluster_monitor?: boolean | null;
  };
}> = ({ result }) => {
  const readOnly = result.ok && result.mode === 'read_only';
  const title = !result.ok
    ? 'Connection failed'
    : readOnly
      ? 'Read-only key verified'
      : result.mode === 'full'
        ? 'Connection verified (full access)'
        : 'Connection succeeded';

  return (
    <EuiCallOut
      size="s"
      color={result.ok ? 'success' : 'danger'}
      iconType={result.ok ? 'checkInCircleFilled' : 'alert'}
      title={title}
    >
      {/* The backend message is authoritative; render it verbatim as plain text. */}
      <p style={{ marginBottom: 0 }}>
        {result.message}
        {typeof result.sample === 'number'
          ? ` — sampled ${result.sample} event${result.sample === 1 ? '' : 's'}.`
          : ''}
      </p>
      {readOnly ? (
        <p style={{ marginTop: 8, marginBottom: 0 }}>
          The agent can read logs from this source. A <EuiCode>cluster:monitor</EuiCode> privilege
          is <strong>not</strong> required — a correctly-scoped read-only key is exactly what we
          want.
        </p>
      ) : null}
    </EuiCallOut>
  );
};

/* -------------------------------------------------------------- editor ----- */

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

  // Advanced source configuration (additive `config` keys not in the manifest).
  const [patterns, setPatterns] = useState<IndexPattern[]>(() =>
    deriveIndexPatterns((existing?.config as Record<string, unknown>) || {}),
  );
  const [entityStrategy, setEntityStrategy] = useState<string>(
    ((existing?.config as Partial<SourceConfigExtras>)?.entity_strategy as string) || 'auto',
  );
  const [messageField, setMessageField] = useState<string>(
    ((existing?.config as Partial<SourceConfigExtras>)?.message_field as string) || '',
  );

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    sample?: number | null;
    mode?: string | null;
    cluster_monitor?: boolean | null;
  } | null>(null);
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

  // Does the connector's own manifest already expose a `message_field`? If so we
  // let it render in the field-mapping group and don't add a duplicate input.
  const manifestHasMessageField = useMemo(
    () =>
      [...(manifest?.auth_fields || []), ...(manifest?.config_fields || [])].some(
        (f) => f.key === 'message_field',
      ),
    [manifest],
  );

  const pickConnector = (m: ConnectorManifest) => {
    setManifest(m);
    setValue({ config: {}, secrets: {} });
    setPatterns(deriveIndexPatterns({}));
    setEntityStrategy('auto');
    setMessageField('');
    setTestResult(null);
    setError(null);
  };

  const onTest = async () => {
    if (!manifest) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await api.testConnector(manifest.source_type);
      setTestResult({
        ok: res.ok,
        message: res.message || (res.ok ? 'OK' : 'Failed'),
        sample: res.sample_count,
        mode: res.mode ?? null,
        cluster_monitor: res.cluster_monitor ?? null,
      });
    } catch (e) {
      setError(e);
    } finally {
      setTesting(false);
    }
  };

  /**
   * Fold the advanced-config editors back into the form's `config` before save.
   * Keeps `data_view_pattern` in sync with the FIRST events pattern (back-compat
   * for the backend's single-pattern read path), and persists the full N-pattern
   * list + entity strategy + message field.
   */
  const buildConfig = (): Record<string, unknown> => {
    const cleanPatterns: IndexPattern[] = patterns
      .map((p) => ({ pattern: p.pattern.trim(), role: p.role === 'alerts' ? 'alerts' : 'events' }))
      .filter((p) => p.pattern);
    const eventsPatterns = cleanPatterns.filter((p) => p.role === 'events').map((p) => p.pattern);
    const firstPattern = (eventsPatterns[0] || cleanPatterns[0]?.pattern || '').trim();

    const cfg: Record<string, unknown> = { ...value.config };

    if (cleanPatterns.length) {
      cfg.index_patterns = cleanPatterns;
      // Mirror events patterns into the legacy single field (comma-joined) so the
      // existing backend read path stays correct even before it reads roles.
      cfg.data_view_pattern = (eventsPatterns.length ? eventsPatterns : [firstPattern]).join(',');
    } else {
      delete cfg.index_patterns;
    }

    const es = (entityStrategy || 'auto').trim();
    if (es && es !== 'auto') cfg.entity_strategy = es;
    else delete cfg.entity_strategy;

    const mf = messageField.trim();
    if (mf) cfg.message_field = mf;
    else if (!manifestHasMessageField) delete cfg.message_field;

    return cfg;
  };

  const onSave = async () => {
    if (!manifest) return;
    // Validate manifest-required fields against the merged (advanced-folded) config
    // so a pattern entered in the advanced editor satisfies `data_view_pattern`.
    const mergedValue: ConnectorFormValue = { ...value, config: buildConfig() };
    const missing = missingRequired(manifest, mergedValue, configuredSecrets);
    if (missing.length) {
      setShowValidation(true);
      setError(
        new Error(`Please complete required fields: ${missing.map((m) => m.label).join(', ')}`),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const id =
        existing?.id ||
        slugify(displayName || manifest.source_type) + '-' + Date.now().toString(36).slice(-4);
      await saveSource(manifest, mergedValue, {
        id,
        displayName: displayName || manifest.display_name,
        enabled,
        isPrimary,
        ingestMode: existing?.ingest_mode ?? null,
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

  const sectionTitle = (text: string) => (
    <EuiTitle size="xxs">
      <h4 style={{ color: COLORS.subdued, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {text}
      </h4>
    </EuiTitle>
  );

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

      {/* Connector-defined fields (Connection, Field mapping, …). */}
      <ConnectorForm
        manifest={manifest}
        value={value}
        onChange={setValue}
        configuredSecrets={configuredSecrets}
        showValidation={showValidation}
      />

      <EuiHorizontalRule margin="l" />

      {/* Advanced, source-level triage configuration (additive config keys). */}
      {sectionTitle('Index patterns')}
      <EuiSpacer size="s" />
      <IndexPatternsEditor rows={patterns} onChange={setPatterns} />

      <EuiSpacer size="l" />
      {sectionTitle('Correlation')}
      <EuiSpacer size="s" />
      <EuiFormRow
        label="Entity strategy"
        helpText="How a cluster's primary entity is chosen for correlation. Use this for sources that don't send a source IP (e.g. an audit log) so their events still form cases — pin Host, User or Rule."
        fullWidth
      >
        <EuiSelect
          options={ENTITY_OPTIONS}
          value={entityStrategy}
          onChange={(e) => setEntityStrategy(e.target.value)}
          fullWidth
        />
      </EuiFormRow>

      {/* The message field only renders here when the connector manifest doesn't
          already provide its own `message_field` input (avoids duplication). */}
      {!manifestHasMessageField ? (
        <>
          <EuiSpacer size="l" />
          {sectionTitle('Display')}
          <EuiSpacer size="s" />
          <EuiFormRow
            label="Message field"
            helpText="The field shown as the human-readable message column when browsing this source's logs and in chat (e.g. message, rule.description, event.original). Leave blank to auto-detect."
            fullWidth
          >
            <EuiFieldText
              icon="documentEdit"
              placeholder="e.g. message"
              value={messageField}
              onChange={(e) => setMessageField(e.target.value)}
              fullWidth
            />
          </EuiFormRow>
        </>
      ) : null}

      <EuiSpacer size="l" />

      {testResult ? (
        <>
          <TestResultCallout result={testResult} />
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
