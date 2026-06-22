/**
 * Settings — the full Preferences, sectioned with an EuiSideNav (mirroring the
 * former plugin settings), plus secret status (configured ✓ + update fields), a
 * model section, and a "Re-run setup wizard" button.
 *
 * Edits are buffered locally and saved with PUT /api/settings; secrets are pushed
 * with POST /api/setup/secrets.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiCallOut,
  EuiComboBox,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiIcon,
  EuiPanel,
  EuiSideNav,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type {
  ConfiguredStatus,
  ModelConfig,
  ModelsResponse,
  Preferences,
} from '../../lib/types';
import { MODEL_ROLES } from '../../lib/types';
import { api } from '../../lib/api';
import { ErrorCallout, Loading, SectionHeader } from '../common/ui';
import { ModelPicker } from '../common/ModelPicker';
import { SecretInput } from '../common/SecretInput';
import { BrandingSection } from './BrandingSection';
import { humanizeToken } from '../../lib/format';

type SectionId =
  | 'data'
  | 'polling'
  | 'models'
  | 'keys'
  | 'correlation'
  | 'enrichment'
  | 'rag'
  | 'standup'
  | 'safety'
  | 'branding';

const SECTIONS: Array<{ id: SectionId; name: string; icon?: string }> = [
  { id: 'data', name: 'Data scope' },
  { id: 'polling', name: 'Polling' },
  { id: 'models', name: 'Models' },
  { id: 'keys', name: 'Secret keys' },
  { id: 'correlation', name: 'Correlation & risk' },
  { id: 'enrichment', name: 'Enrichment' },
  { id: 'rag', name: 'RAG' },
  { id: 'standup', name: 'Standup' },
  { id: 'safety', name: 'Automation & safety' },
  { id: 'branding', name: 'Branding', icon: 'brush' },
];

const ROLE_PREF_KEY: Record<string, keyof Preferences> = {
  router: 'router_model',
  investigator: 'investigator_model',
  formatter: 'formatter_model',
  standup: 'standup_model',
  chat: 'chat_model',
  overview: 'overview_model',
  embedding: 'embedding_model',
};

interface SettingsPageProps {
  onRerunWizard: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ onRerunWizard }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [configured, setConfigured] = useState<ConfiguredStatus>({});
  const [readOnly, setReadOnly] = useState(false);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [section, setSection] = useState<SectionId>('data');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // buffered secret entries (write-only)
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [savingSecrets, setSavingSecrets] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, mdl] = await Promise.all([
        api.getSettings(),
        api.getModels().catch(() => null),
      ]);
      setPrefs(settings.prefs);
      setConfigured(settings.configured);
      setReadOnly(settings.read_only);
      setModels(mdl);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (patch: Partial<Preferences>) =>
    setPrefs((p) => (p ? { ...p, ...patch } : p));

  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const { sources, setup_complete, ...patch } = prefs;
      void sources;
      void setup_complete;
      const res = await api.putSettings(patch as Partial<Preferences>);
      setPrefs(res.prefs);
      setNote('Settings saved.');
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const saveSecrets = async () => {
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(secretDraft)) if (v) body[k] = v;
    if (!Object.keys(body).length) {
      setNote('No new secret values entered.');
      return;
    }
    setSavingSecrets(true);
    setError(null);
    try {
      const res = await api.updateSecrets(body);
      setConfigured(res.configured);
      setSecretDraft({});
      setNote('Secret keys updated.');
    } catch (e) {
      setError(e);
    } finally {
      setSavingSecrets(false);
    }
  };

  const sideNav = useMemo(
    () => [
      {
        name: 'Settings',
        id: 'root',
        items: SECTIONS.map((s) => ({
          id: s.id,
          name: s.name,
          icon: s.icon ? <EuiIcon type={s.icon} /> : undefined,
          isSelected: section === s.id,
          onClick: () => setSection(s.id),
        })),
      },
    ],
    [section],
  );

  if (loading) return <Loading label="Loading settings…" />;
  if (!prefs) return <ErrorCallout error={error || new Error('No settings loaded')} />;

  return (
    <div>
      <SectionHeader
        icon="gear"
        title="Settings"
        description="Tune every preference the agent uses. Secrets are write-only."
        actions={
          <EuiFlexGroup gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButton iconType="wrench" onClick={onRerunWizard}>
                Re-run setup wizard
              </EuiButton>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton fill iconType="save" onClick={save} isLoading={saving} isDisabled={readOnly}>
                Save settings
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        }
      />

      {readOnly ? (
        <>
          <EuiCallOut size="s" color="warning" iconType="lock" title="Read-only mode" />
          <EuiSpacer size="m" />
        </>
      ) : null}
      {note ? (
        <>
          <EuiCallOut size="s" color="success" iconType="check" title={note} />
          <EuiSpacer size="m" />
        </>
      ) : null}
      {error ? (
        <>
          <ErrorCallout error={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      <EuiFlexGroup gutterSize="l" alignItems="flexStart">
        <EuiFlexItem grow={false} style={{ minWidth: 200 }}>
          <EuiSideNav items={sideNav} />
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel hasBorder paddingSize="l">
            {section === 'data' ? (
              <DataSection prefs={prefs} update={update} />
            ) : section === 'polling' ? (
              <PollingSection prefs={prefs} update={update} />
            ) : section === 'models' ? (
              <ModelsSection prefs={prefs} models={models} update={update} />
            ) : section === 'keys' ? (
              <KeysSection
                configured={configured}
                draft={secretDraft}
                setDraft={setSecretDraft}
                onSave={saveSecrets}
                saving={savingSecrets}
              />
            ) : section === 'correlation' ? (
              <CorrelationSection prefs={prefs} update={update} />
            ) : section === 'enrichment' ? (
              <EnrichmentSection prefs={prefs} update={update} />
            ) : section === 'rag' ? (
              <RagSection prefs={prefs} update={update} />
            ) : section === 'standup' ? (
              <StandupSection prefs={prefs} update={update} />
            ) : section === 'safety' ? (
              <SafetySection prefs={prefs} update={update} />
            ) : (
              <BrandingSection readOnly={readOnly} />
            )}
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>
    </div>
  );
};

/* ------------------------------------------------------------- sub-sections - */

type SecProps = { prefs: Preferences; update: (p: Partial<Preferences>) => void };

const SectionTitle: React.FC<{ title: string; sub?: string }> = ({ title, sub }) => (
  <>
    <EuiTitle size="xs">
      <h3>{title}</h3>
    </EuiTitle>
    {sub ? (
      <EuiText size="xs" color="subdued">
        <p>{sub}</p>
      </EuiText>
    ) : null}
    <EuiSpacer size="m" />
  </>
);

const TextPref: React.FC<{ label: string; value?: string; help?: string; onChange: (v: string) => void }> = ({
  label,
  value,
  help,
  onChange,
}) => (
  <EuiFormRow label={label} helpText={help} fullWidth>
    <EuiFieldText value={value ?? ''} onChange={(e) => onChange(e.target.value)} fullWidth />
  </EuiFormRow>
);

const NumPref: React.FC<{ label: string; value?: number; help?: string; step?: number; onChange: (v: number) => void }> = ({
  label,
  value,
  help,
  step,
  onChange,
}) => (
  <EuiFormRow label={label} helpText={help} fullWidth>
    <EuiFieldNumber value={value ?? 0} step={step} onChange={(e) => onChange(Number(e.target.value))} fullWidth />
  </EuiFormRow>
);

const DataSection: React.FC<SecProps> = ({ prefs, update }) => (
  <div>
    <SectionTitle title="Data scope" sub="Index pattern and the fields the agent maps entities from." />
    <TextPref label="Log index pattern" value={prefs.data_view_pattern} onChange={(v) => update({ data_view_pattern: v })} />
    <TextPref label="Timestamp field" value={prefs.time_field} onChange={(v) => update({ time_field: v })} />
    <TextPref label="Source IP field" value={prefs.source_ip_field} onChange={(v) => update({ source_ip_field: v })} />
    <TextPref label="User field" value={prefs.user_field} onChange={(v) => update({ user_field: v })} />
    <TextPref label="Host field" value={prefs.host_field} onChange={(v) => update({ host_field: v })} />
    <TextPref label="Rule / module field" value={prefs.rule_field} onChange={(v) => update({ rule_field: v })} />
    <TextPref label="Rule name field" value={prefs.rule_name_field} onChange={(v) => update({ rule_name_field: v })} />
    <TextPref label="Severity field" value={prefs.severity_field} onChange={(v) => update({ severity_field: v })} />
    <NumPref label="Severity threshold" value={prefs.severity_threshold} step={0.5} onChange={(v) => update({ severity_threshold: v })} />
    <TextPref label="Investigate lookback" value={prefs.investigate_lookback} help='Starting window for manual entity investigation, e.g. "now-24h".' onChange={(v) => update({ investigate_lookback: v })} />
  </div>
);

const PollingSection: React.FC<SecProps> = ({ prefs, update }) => (
  <div>
    <SectionTitle title="Polling" sub="How the durable poller pulls new events." />
    <EuiSwitch label="Polling enabled" checked={Boolean(prefs.polling_enabled)} onChange={(e) => update({ polling_enabled: e.target.checked })} />
    <EuiSpacer size="m" />
    <NumPref label="Poll interval (seconds)" value={prefs.poll_interval_seconds} onChange={(v) => update({ poll_interval_seconds: v })} />
    <NumPref label="Poll batch size" value={prefs.poll_batch_size} onChange={(v) => update({ poll_batch_size: v })} />
    <NumPref label="Cold-start lookback (minutes)" value={prefs.cold_start_lookback_minutes} onChange={(v) => update({ cold_start_lookback_minutes: v })} />
  </div>
);

const ModelsSection: React.FC<SecProps & { models: ModelsResponse | null }> = ({ prefs, update, models }) => (
  <div>
    <SectionTitle title="Per-role models" sub="The model used for each task." />
    <EuiFlexGroup wrap gutterSize="l">
      {MODEL_ROLES.map((role) => (
        <EuiFlexItem key={role} style={{ minWidth: 300 }}>
          <ModelPicker
            role={role}
            models={models}
            value={prefs[ROLE_PREF_KEY[role]] as ModelConfig | undefined}
            onChange={(m) => update({ [ROLE_PREF_KEY[role]]: m } as Partial<Preferences>)}
          />
        </EuiFlexItem>
      ))}
    </EuiFlexGroup>
  </div>
);

const KeysSection: React.FC<{
  configured: ConfiguredStatus;
  draft: Record<string, string>;
  setDraft: (d: Record<string, string>) => void;
  onSave: () => void;
  saving: boolean;
}> = ({ configured, draft, setDraft, onSave, saving }) => {
  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v });
  const KEYS: Array<{ key: string; label: string; help: string }> = [
    { key: 'es_api_key', label: 'Elasticsearch read-only API key', help: 'Scoped, read-only key for the log indices.' },
    { key: 'es_mgmt_api_key', label: 'Elasticsearch management API key', help: 'Scoped to tlsoc-agent-* bookkeeping indices.' },
    { key: 'anthropic_api_key', label: 'Anthropic API key', help: 'For Claude models.' },
    { key: 'openai_api_key', label: 'OpenAI API key', help: 'For GPT models / embeddings.' },
    { key: 'embedding_api_key', label: 'Embedding API key', help: 'Defaults to the OpenAI key when blank.' },
    { key: 'abuseipdb_api_key', label: 'AbuseIPDB API key', help: 'IP reputation enrichment (optional).' },
    { key: 'virustotal_api_key', label: 'VirusTotal API key', help: 'File/URL/IP reputation (optional).' },
  ];
  return (
    <div>
      <SectionTitle title="Secret keys" sub="Write-only. The console only ever sees whether a key is configured." />
      {KEYS.map((k) => (
        <SecretInput
          key={k.key}
          label={k.label}
          secretKey={k.key}
          configured={configured[k.key]}
          value={draft[k.key] || ''}
          onChange={(v) => set(k.key, v)}
          help={k.help}
        />
      ))}
      <EuiSpacer size="m" />
      <EuiButton iconType="save" onClick={onSave} isLoading={saving}>
        Update keys
      </EuiButton>
    </div>
  );
};

const CorrelationSection: React.FC<SecProps> = ({ prefs, update }) => {
  const corr = prefs.default_correlation || {};
  const weights = prefs.risk_weights || {};
  return (
    <div>
      <SectionTitle title="Correlation & risk" sub="Clustering thresholds and the deterministic risk weights." />
      <EuiFlexGroup wrap gutterSize="l">
        <EuiFlexItem style={{ minWidth: 160 }}>
          <NumPref label="Threshold (N)" value={corr.n} onChange={(v) => update({ default_correlation: { ...corr, n: v } })} />
        </EuiFlexItem>
        <EuiFlexItem style={{ minWidth: 180 }}>
          <NumPref label="Window (seconds)" value={corr.window_seconds} onChange={(v) => update({ default_correlation: { ...corr, window_seconds: v } })} />
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="s" />
      <EuiText size="xs" color="subdued">
        <p>Risk weights (auto-normalised to 0–100):</p>
      </EuiText>
      <EuiFlexGroup wrap gutterSize="l">
        {(['volume', 'velocity', 'reputation', 'diversity', 'asset_criticality'] as const).map((k) => (
          <EuiFlexItem key={k} style={{ minWidth: 160 }}>
            <NumPref
              label={humanizeToken(k)}
              value={weights[k]}
              step={0.05}
              onChange={(v) => update({ risk_weights: { ...weights, [k]: v } })}
            />
          </EuiFlexItem>
        ))}
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      <NumPref label="Escalation confidence" value={prefs.escalation_confidence} step={0.05} onChange={(v) => update({ escalation_confidence: v })} />
      <NumPref label="Critical severity" value={prefs.critical_severity} step={0.5} onChange={(v) => update({ critical_severity: v })} />
    </div>
  );
};

const EnrichmentSection: React.FC<SecProps> = ({ prefs, update }) => {
  const e = prefs.enrichment || {};
  const set = (patch: Partial<typeof e>) => update({ enrichment: { ...e, ...patch } });
  return (
    <div>
      <SectionTitle title="Enrichment" sub="Threat-intel lookups (cached in Redis)." />
      <EuiSwitch label="Enrichment enabled" checked={e.enabled ?? true} onChange={(ev) => set({ enabled: ev.target.checked })} />
      <EuiSpacer size="s" />
      <EuiSwitch label="Use AbuseIPDB" checked={e.use_abuseipdb ?? true} onChange={(ev) => set({ use_abuseipdb: ev.target.checked })} />
      <EuiSpacer size="s" />
      <EuiSwitch label="Use VirusTotal" checked={e.use_virustotal ?? true} onChange={(ev) => set({ use_virustotal: ev.target.checked })} />
      <EuiSpacer size="s" />
      <EuiSwitch label="Use GeoIP" checked={e.use_geoip ?? true} onChange={(ev) => set({ use_geoip: ev.target.checked })} />
      <EuiSpacer size="m" />
      <NumPref label="Cache TTL (seconds)" value={e.cache_ttl_seconds} onChange={(v) => set({ cache_ttl_seconds: v })} />
    </div>
  );
};

const RagSection: React.FC<SecProps> = ({ prefs, update }) => {
  const r = prefs.rag || {};
  const set = (patch: Partial<typeof r>) => update({ rag: { ...r, ...patch } });
  return (
    <div>
      <SectionTitle title="RAG" sub="Retrieval-augmented context for investigations." />
      <EuiSwitch label="RAG enabled" checked={r.enabled ?? true} onChange={(e) => set({ enabled: e.target.checked })} />
      <EuiSpacer size="m" />
      <NumPref label="Top K" value={r.top_k} onChange={(v) => set({ top_k: v })} />
      <NumPref label="Minimum score" value={r.min_score} step={0.05} onChange={(v) => set({ min_score: v })} />
      <EuiSpacer size="s" />
      <EuiSwitch label="Use runbooks" checked={r.use_runbooks ?? true} onChange={(e) => set({ use_runbooks: e.target.checked })} />
      <EuiSpacer size="s" />
      <EuiSwitch label="Use MITRE" checked={r.use_mitre ?? true} onChange={(e) => set({ use_mitre: e.target.checked })} />
      <EuiSpacer size="s" />
      <EuiSwitch label="Use resolved cases" checked={r.use_resolved_cases ?? true} onChange={(e) => set({ use_resolved_cases: e.target.checked })} />
    </div>
  );
};

const StandupSection: React.FC<SecProps> = ({ prefs, update }) => {
  const s = prefs.standup || {};
  const set = (patch: Partial<typeof s>) => update({ standup: { ...s, ...patch } });
  return (
    <div>
      <SectionTitle title="Standup" sub="Daily aggregate summary." />
      <EuiSwitch label="Standup enabled" checked={s.enabled ?? true} onChange={(e) => set({ enabled: e.target.checked })} />
      <EuiSpacer size="m" />
      <NumPref label="Window (hours)" value={s.window_hours} onChange={(v) => set({ window_hours: v })} />
      <NumPref label="Interval (seconds)" value={s.interval_seconds} onChange={(v) => set({ interval_seconds: v })} />
    </div>
  );
};

const SafetySection: React.FC<SecProps> = ({ prefs, update }) => {
  const caps = prefs.caps || {};
  const setCaps = (patch: Partial<typeof caps>) => update({ caps: { ...caps, ...patch } });
  return (
    <div>
      <SectionTitle title="Automation & safety" sub="Caps, the auto-forward allowlist, and the kill switch." />
      <EuiSwitch
        label="Background automated scans"
        checked={Boolean(prefs.background_scan_enabled)}
        onChange={(e) => update({ background_scan_enabled: e.target.checked })}
      />
      <EuiSpacer size="m" />
      <EuiFormRow label="Auto-forward allowlist" helpText="Rule values that auto-forward to investigation." fullWidth>
        <EuiComboBox
          noSuggestions
          selectedOptions={(prefs.auto_forward_allowlist || []).map((r) => ({ label: r }))}
          onCreateOption={(v) => update({ auto_forward_allowlist: [...(prefs.auto_forward_allowlist || []), v] })}
          onChange={(opts) => update({ auto_forward_allowlist: opts.map((o) => o.label) })}
          fullWidth
        />
      </EuiFormRow>
      <EuiSpacer size="m" />
      <NumPref label="Max tool calls / case" value={caps.max_tool_calls} onChange={(v) => setCaps({ max_tool_calls: v })} />
      <NumPref label="Max tokens / case" value={caps.max_tokens} onChange={(v) => setCaps({ max_tokens: v })} />
      <NumPref label="Timeout (seconds)" value={caps.timeout_seconds} onChange={(v) => setCaps({ timeout_seconds: v })} />
      <EuiSpacer size="m" />
      <EuiSwitch label="Kill switch (stop all investigations)" checked={Boolean(caps.kill_switch)} onChange={(e) => setCaps({ kill_switch: e.target.checked })} />
    </div>
  );
};
