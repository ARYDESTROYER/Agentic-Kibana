import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiCallOut,
  EuiComboBox,
  EuiDescribedFormGroup,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiHealth,
  EuiHorizontalRule,
  EuiIcon,
  EuiIconTip,
  EuiPanel,
  EuiSelect,
  EuiSideNav,
  EuiSpacer,
  EuiSuperSelect,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';
import type { ModelsResponse, RuleDefinition, RuleMatch, SettingsResponse } from '../../common';
import { humanizeToken } from '../lib/format';
import type { TlsocApi } from '../lib/api';
// Shared visual language (frozen): palette + section-header primitive. Reused so
// Settings shares the same accent/icon-chip rhythm as the other surfaces.
import { COLORS, SectionHeader, tint } from './ui';

interface SettingsProps {
  api: TlsocApi;
  core: CoreStart;
}

type Path = Array<string | number>;

const MODEL_ROLES: Array<{ key: string; label: string }> = [
  { key: 'router_model', label: 'Router (cheap triage)' },
  { key: 'investigator_model', label: 'Investigator (strong ReAct)' },
  { key: 'formatter_model', label: 'Formatter' },
  { key: 'standup_model', label: 'Standup' },
  { key: 'chat_model', label: 'Chat' },
  { key: 'overview_model', label: 'AI overview (per-event)' },
  { key: 'embedding_model', label: 'Embedding' },
];

const CORRELATION_MODES = ['every', 'threshold', 'never'];
const ENTITY_TYPES = ['ip', 'user', 'host'];

/** Match operators a rule-catalog entry (C3-1) can use. */
const RULE_MATCH_OPS: Array<RuleMatch['op']> = ['equals', 'prefix', 'tag', 'exists'];

/**
 * Roles a per-rule model_override (C3-6) can target. These mirror the per-role
 * MODEL_ROLES keys; an unset entry falls back to the per-role model.
 */
const RULE_MODEL_ROLES: Array<{ key: string; label: string }> = [
  { key: 'router_model', label: 'Router' },
  { key: 'investigator_model', label: 'Investigator' },
  { key: 'formatter_model', label: 'Formatter' },
];

/** Which configured-secret key gates a given provider (best-effort). */
function providerKeyName(provider: string): string | null {
  if (provider === 'anthropic') return 'anthropic_api_key';
  if (provider === 'openai') return 'openai_api_key';
  return null; // mock / other never need a key
}

export const Settings: React.FC<SettingsProps> = ({ api, core }) => {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [prefs, setPrefs] = useState<Record<string, any>>({});
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Secret update form (kept entirely in component memory; never read back).
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [savingSecrets, setSavingSecrets] = useState(false);

  // Draft for the "add per-rule model override" row (component memory only).
  const [newRuleModelName, setNewRuleModelName] = useState('');

  // Left-nav selection (layout only). The data section is the default surface.
  const [activeSection, setActiveSection] = useState('sec-data');
  // Mobile side-nav open state so the section list collapses on narrow screens.
  const [isSideNavOpenOnMobile, setIsSideNavOpenOnMobile] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Seed editable state from the LIVE GET so PUTs aren't stale.
      const resp = await api.get<SettingsResponse>('settings');
      setData(resp);
      setPrefs(resp.prefs || {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadModels = useCallback(async () => {
    try {
      const m = await api.get<ModelsResponse>('models');
      setModels(m);
    } catch {
      /* model catalog is best-effort; pickers fall back to free text */
    }
  }, [api]);

  useEffect(() => {
    load();
    loadModels();
  }, [load, loadModels]);

  const readOnly = !!data?.read_only;
  const configured = data?.configured || {};
  const providers = models?.providers || {};

  const setPref = (path: Path, value: any) => {
    setPrefs((prev) => {
      const next = JSON.parse(JSON.stringify(prev ?? {}));
      let obj: any = next;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (typeof obj[key] !== 'object' || obj[key] === null) {
          obj[key] = typeof path[i + 1] === 'number' ? [] : {};
        }
        obj = obj[key];
      }
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  const getPref = (path: Path, dflt?: any) => {
    let obj: any = prefs;
    for (const p of path) {
      if (obj === null || obj === undefined) return dflt;
      obj = obj[p];
    }
    return obj === undefined || obj === null ? dflt : obj;
  };

  const toast = useMemo(() => core.notifications.toasts, [core.notifications.toasts]);

  // PUT the FULL prefs object so nothing is dropped.
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const resp = await api.put<{ ok: boolean; prefs: Record<string, any> }>('settings', prefs);
      setPrefs(resp.prefs);
      // Refresh read_only / configured view in case read-only was just toggled.
      await load();
      toast.addSuccess('Settings saved.');
    } catch (e) {
      const msg = (e as Error).message || 'Failed to save settings';
      setError(msg);
      toast.addDanger(msg);
    } finally {
      setSaving(false);
    }
  };

  const saveSecrets = async () => {
    const body: Record<string, string> = {};
    Object.entries(secretDraft).forEach(([k, v]) => {
      if (v && v.trim()) body[k] = v.trim();
    });
    if (!Object.keys(body).length) {
      toast.addWarning('No secret values entered.');
      return;
    }
    setSavingSecrets(true);
    try {
      await api.post('setup/secrets', body);
      setSecretDraft({});
      await load();
      toast.addSuccess('Keys updated (in-memory until restart).');
    } catch (e) {
      toast.addDanger((e as Error).message || 'Failed to update keys');
    } finally {
      setSavingSecrets(false);
    }
  };

  // --- small field helpers ---------------------------------------------------
  const textField = (path: Path, dflt = '') => (
    <EuiFieldText
      disabled={readOnly}
      value={String(getPref(path, dflt))}
      onChange={(e) => setPref(path, e.target.value)}
    />
  );

  const numberField = (path: Path, dflt: number, step?: number) => (
    <EuiFieldNumber
      disabled={readOnly}
      value={getPref(path, dflt)}
      step={step}
      onChange={(e) => setPref(path, e.target.value === '' ? '' : Number(e.target.value))}
    />
  );

  const switchField = (path: Path, label: string, dflt = false) => (
    <EuiSwitch
      disabled={readOnly}
      label={label}
      checked={!!getPref(path, dflt)}
      onChange={(e) => setPref(path, e.target.checked)}
    />
  );

  const csvField = (path: Path) => (
    <EuiFieldText
      disabled={readOnly}
      value={(getPref(path, []) || []).join(', ')}
      onChange={(e) =>
        setPref(
          path,
          e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
      }
    />
  );

  // --- model picker ----------------------------------------------------------
  // Core, path-based provider+model picker. Both the per-role pickers (with
  // temp/max_tokens) and the per-rule overrides (provider/model only) reuse this
  // so the provider list, model catalog, custom-model affordance, and missing-key
  // warning behave identically everywhere.
  const providerOptions = useMemo(
    () =>
      ['anthropic', 'openai', 'mock', ...Object.keys(providers)]
        .filter((p, i, arr) => arr.indexOf(p) === i)
        .map((p) => ({ value: p, inputDisplay: p })),
    [providers]
  );

  const modelPickerAt = (basePath: Path, providerDflt = 'anthropic') => {
    const provider = String(getPref([...basePath, 'provider'], providerDflt));
    const model = String(getPref([...basePath, 'model'], ''));
    const modelChoices = (providers[provider] || []).map((m) => ({ label: m }));
    const selected = model ? [{ label: model }] : [];

    const keyName = providerKeyName(provider);
    const missingKey = keyName ? !configured[keyName] : false;
    // Unpriced/custom model: a typed value that isn't in the live catalog.
    const customModel = !!model && !(providers[provider] || []).includes(model);

    return (
      <>
        <EuiFlexItem style={{ minWidth: 140 }}>
          <EuiFormRow label="Provider" display="rowCompressed">
            <EuiSuperSelect
              compressed
              disabled={readOnly}
              options={providerOptions}
              valueOfSelected={provider}
              onChange={(v) => setPref([...basePath, 'provider'], v)}
            />
          </EuiFormRow>
        </EuiFlexItem>
        <EuiFlexItem style={{ minWidth: 220 }}>
          <EuiFormRow
            label="Model"
            display="rowCompressed"
            helpText={
              missingKey ? (
                <EuiText size="xs" color="warning">
                  Provider <strong>{provider}</strong> has no configured key — calls will fail until
                  one is set.
                </EuiText>
              ) : customModel ? (
                <EuiText size="xs" color="subdued">
                  Custom model — may be unpriced in the cost ledger.
                </EuiText>
              ) : undefined
            }
            labelAppend={
              missingKey ? (
                <EuiIconTip
                  type="warning"
                  color="warning"
                  content={`No ${keyName} configured for provider "${provider}".`}
                />
              ) : customModel ? (
                <EuiIconTip
                  type="iInCircle"
                  color="subdued"
                  content={`"${model}" is not in the live catalog for "${provider}" — cost may be unpriced.`}
                />
              ) : undefined
            }
          >
            <EuiComboBox
              compressed
              isDisabled={readOnly}
              singleSelection={{ asPlainText: true }}
              options={modelChoices}
              selectedOptions={selected}
              onChange={(opts) => setPref([...basePath, 'model'], opts[0]?.label || '')}
              onCreateOption={(val) => setPref([...basePath, 'model'], val)}
              placeholder="Select or type a model"
              customOptionText="Use custom model {searchValue}"
            />
          </EuiFormRow>
        </EuiFlexItem>
      </>
    );
  };

  const modelPicker = (roleKey: string) => (
    <EuiFlexGroup gutterSize="s" responsive={false} wrap>
      {modelPickerAt([roleKey], 'anthropic')}
      <EuiFlexItem grow={false} style={{ minWidth: 110 }}>
        <EuiFormRow label="Temp" display="rowCompressed">
          <EuiFieldNumber
            compressed
            disabled={readOnly}
            step={0.1}
            value={getPref([roleKey, 'temperature'], 0.1)}
            onChange={(e) =>
              setPref([roleKey, 'temperature'], e.target.value === '' ? '' : Number(e.target.value))
            }
          />
        </EuiFormRow>
      </EuiFlexItem>
      <EuiFlexItem grow={false} style={{ minWidth: 120 }}>
        <EuiFormRow label="Max tokens" display="rowCompressed">
          <EuiFieldNumber
            compressed
            disabled={readOnly}
            value={getPref([roleKey, 'max_tokens'], 1500)}
            onChange={(e) =>
              setPref([roleKey, 'max_tokens'], e.target.value === '' ? '' : Number(e.target.value))
            }
          />
        </EuiFormRow>
      </EuiFlexItem>
    </EuiFlexGroup>
  );

  // --- correlation rule editor ----------------------------------------------
  const correlationRules: Record<string, any> = getPref(['correlation_rules'], {}) || {};
  const addCorrelationRule = () => {
    const name = `rule_${Object.keys(correlationRules).length + 1}`;
    setPref(['correlation_rules', name], {
      mode: 'threshold',
      n: 5,
      window_seconds: 120,
      group_by: 'ip',
    });
  };
  const removeCorrelationRule = (name: string) => {
    setPrefs((prev) => {
      const next = JSON.parse(JSON.stringify(prev ?? {}));
      if (next.correlation_rules) delete next.correlation_rules[name];
      return next;
    });
  };
  const renameCorrelationRule = (oldName: string, newName: string) => {
    if (!newName || newName === oldName) return;
    setPrefs((prev) => {
      const next = JSON.parse(JSON.stringify(prev ?? {}));
      const cr = next.correlation_rules || {};
      if (cr[oldName] !== undefined && cr[newName] === undefined) {
        cr[newName] = cr[oldName];
        delete cr[oldName];
        next.correlation_rules = cr;
      }
      return next;
    });
  };

  // --- asset networks editor -------------------------------------------------
  const assetNetworks: any[] = getPref(['asset_networks'], []) || [];
  const addAssetNetwork = () =>
    setPref(['asset_networks'], [...assetNetworks, { cidr: '', criticality: 0 }]);
  const removeAssetNetwork = (idx: number) =>
    setPref(
      ['asset_networks'],
      assetNetworks.filter((_, i) => i !== idx)
    );

  // --- suppression rules editor ---------------------------------------------
  const suppressionRules: any[] = getPref(['suppression_rules'], []) || [];
  const addSuppression = () =>
    setPref(['suppression_rules'], [...suppressionRules, { field: '', value: '', reason: '' }]);
  const removeSuppression = (idx: number) =>
    setPref(
      ['suppression_rules'],
      suppressionRules.filter((_, i) => i !== idx)
    );

  // --- asset_criticality map editor (entity value -> 0..100) ----------------
  const assetCriticality: Record<string, number> = getPref(['asset_criticality'], {}) || {};
  const addAssetCriticality = () => {
    const key = `entity_${Object.keys(assetCriticality).length + 1}`;
    setPref(['asset_criticality', key], 0);
  };
  const removeAssetCriticality = (key: string) => {
    setPrefs((prev) => {
      const next = JSON.parse(JSON.stringify(prev ?? {}));
      if (next.asset_criticality) delete next.asset_criticality[key];
      return next;
    });
  };
  const renameAssetCriticality = (oldKey: string, newKey: string) => {
    if (!newKey || newKey === oldKey) return;
    setPrefs((prev) => {
      const next = JSON.parse(JSON.stringify(prev ?? {}));
      const ac = next.asset_criticality || {};
      if (ac[oldKey] !== undefined && ac[newKey] === undefined) {
        ac[newKey] = ac[oldKey];
        delete ac[oldKey];
        next.asset_criticality = ac;
      }
      return next;
    });
  };

  // --- detection rule-catalog editor (C3-1) ---------------------------------
  const ruleCatalog: RuleDefinition[] = getPref(['rule_catalog'], []) || [];
  const addRule = () => {
    const idx = ruleCatalog.length + 1;
    setPref(
      ['rule_catalog'],
      [
        ...ruleCatalog,
        {
          name: `rule_${idx}`,
          enabled: true,
          description: '',
          match: { field: 'event.module', op: 'equals', value: '' },
          priority: 0,
        } as RuleDefinition,
      ]
    );
  };
  const removeRule = (idx: number) =>
    setPref(
      ['rule_catalog'],
      ruleCatalog.filter((_, i) => i !== idx)
    );
  // Toggle the optional per-rule correlation override block on/off.
  const toggleRuleCorrelation = (idx: number, on: boolean) =>
    setPref(
      ['rule_catalog', idx, 'correlation'],
      on ? { mode: 'threshold', n: 5, window_seconds: 120, group_by: 'ip' } : null
    );

  // --- per-rule model overrides table (C3-6) --------------------------------
  // A map { ruleName: { router_model: {provider, model}, ... } }. Empty/unset
  // entries fall back to the per-role model. Rows offer the catalog rule names
  // plus a free-entry row.
  const ruleModelOverride: Record<string, any> = getPref(['rule_model_override'], {}) || {};
  const ruleModelNames = Object.keys(ruleModelOverride);
  const catalogRuleNames = ruleCatalog.map((r) => r?.name).filter(Boolean) as string[];
  const addRuleModelRow = (name: string) => {
    const clean = (name || '').trim();
    if (!clean || ruleModelOverride[clean] !== undefined) return;
    setPref(['rule_model_override', clean], {});
  };
  const removeRuleModelRow = (name: string) => {
    setPrefs((prev) => {
      const next = JSON.parse(JSON.stringify(prev ?? {}));
      if (next.rule_model_override) delete next.rule_model_override[name];
      return next;
    });
  };

  // Titled settings panel. `opts.icon` renders an accented icon chip next to the
  // title (matching the SectionHeader rhythm) and `opts.accent` tints it. The
  // body renders directly (the left-nav, not an accordion, controls which panel
  // is shown). Presentation only — no behaviour change.
  const sectionPanel = (
    title: string,
    children: React.ReactNode,
    opts: { icon?: string; accent?: string } = {}
  ) => {
    const accent = opts.accent || COLORS.primary;
    return (
      <EuiPanel hasBorder paddingSize="m">
        <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
          {opts.icon ? (
            <EuiFlexItem grow={false}>
              <span
                className="tlsocIconChip"
                style={{ background: tint(accent, 0.14), color: accent }}
              >
                <EuiIcon type={opts.icon} size="m" />
              </span>
            </EuiFlexItem>
          ) : null}
          <EuiFlexItem grow={false}>
            <EuiTitle size="xs">
              <h3>{title}</h3>
            </EuiTitle>
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiSpacer size="m" />
        {children}
      </EuiPanel>
    );
  };

  // Consistent small subsection label (replaces ad-hoc <EuiText><strong>…</strong>).
  // Optional `hint` is rendered subdued next to the label. Textual + cheap.
  const subLabel = (label: React.ReactNode, hint?: React.ReactNode) => (
    <EuiText size="s">
      <strong>{label}</strong>
      {hint ? (
        <span style={{ color: COLORS.subdued, fontWeight: 400 }}> {hint}</span>
      ) : null}
    </EuiText>
  );

  // Section descriptors drive both the left-nav list and the right-hand content
  // panel. Each `content` block is moved verbatim from the previous accordion
  // call sites — no field, path, handler, or default is altered. The ids/titles/
  // icons/accents match the original sections one-for-one.
  const sections: Array<{
    id: string;
    title: string;
    icon: string;
    accent: string;
    content: React.ReactNode;
  }> = [
    {
      id: 'sec-data',
      title: 'Data scope, entity mapping & rules',
      icon: 'indexSettings',
      accent: COLORS.primary,
      content: (
        <>
          <EuiDescribedFormGroup
            title={<h4>Data scope</h4>}
            description="Which logs the agent reads and the time field used."
          >
            <EuiFormRow label="Data view pattern">{textField(['data_view_pattern'], 'all-logs-*')}</EuiFormRow>
            <EuiFormRow label="Time field">{textField(['time_field'], '@timestamp')}</EuiFormRow>
          </EuiDescribedFormGroup>
          <EuiDescribedFormGroup
            title={<h4>Entity mapping</h4>}
            description="Field names that hold the source IP, user, and host."
          >
            <EuiFormRow label="Source IP field">{textField(['source_ip_field'], 'source.ip')}</EuiFormRow>
            <EuiFormRow label="User field">{textField(['user_field'], 'user.name')}</EuiFormRow>
            <EuiFormRow label="Host field">{textField(['host_field'], 'host.name')}</EuiFormRow>
          </EuiDescribedFormGroup>
          <EuiDescribedFormGroup
            title={<h4>Severity & rules</h4>}
            description="How rules and severity are identified; which rules are in/out of scope."
          >
            <EuiFormRow label="Rule field">{textField(['rule_field'], 'event.module')}</EuiFormRow>
            <EuiFormRow label="Rule name field">{textField(['rule_name_field'], 'rule.name')}</EuiFormRow>
            <EuiFormRow label="Severity field">{textField(['severity_field'], 'event.severity')}</EuiFormRow>
            <EuiFormRow label="Severity threshold">{numberField(['severity_threshold'], 0, 0.1)}</EuiFormRow>
            <EuiFormRow label="In-scope rules (comma separated; empty = all)">{csvField(['in_scope_rules'])}</EuiFormRow>
            <EuiFormRow label="Excluded rules (comma separated)">{csvField(['excluded_rules'])}</EuiFormRow>
          </EuiDescribedFormGroup>
        </>
      ),
    },
    {
      id: 'sec-polling',
      title: 'Polling',
      icon: 'timeRefresh',
      accent: COLORS.primary,
      content: (
        <EuiFlexGroup wrap>
          <EuiFlexItem>
            <EuiFormRow label="Poll interval (seconds)">{numberField(['poll_interval_seconds'], 30)}</EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow label="Poll batch size">{numberField(['poll_batch_size'], 500)}</EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow label="Cold-start lookback (minutes)">
              {numberField(['cold_start_lookback_minutes'], 60)}
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiFormRow label="Enabled" hasEmptyLabelSpace>
              {switchField(['polling_enabled'], 'Polling enabled', true)}
            </EuiFormRow>
          </EuiFlexItem>
        </EuiFlexGroup>
      ),
    },
    {
      id: 'sec-models',
      title: 'Per-role models',
      icon: 'machineLearningApp',
      accent: COLORS.accent,
      content: (
        <>
          <EuiText size="xs" color="subdued">
            <p>Each role routes through the single cost-metered gateway. Models populate from the live catalog; you may also type a custom model.</p>
          </EuiText>
          <EuiSpacer size="s" />
          {MODEL_ROLES.map((r, i) => (
            <React.Fragment key={r.key}>
              {i > 0 ? <EuiHorizontalRule margin="s" /> : null}
              {subLabel(r.label)}
              <EuiSpacer size="xs" />
              {modelPicker(r.key)}
            </React.Fragment>
          ))}
        </>
      ),
    },
    {
      id: 'sec-thresholds',
      title: 'Decision thresholds',
      icon: 'controlsHorizontal',
      accent: COLORS.primary,
      content: (
        <>
          {subLabel('FP auto-close', '(a TRUE_POSITIVE can never auto-close)')}
          <EuiSpacer size="xs" />
          {switchField(['fp_auto_close', 'enabled'], 'FP auto-close enabled', false)}
          <EuiSpacer size="s" />
          <EuiFlexGroup wrap>
            <EuiFlexItem>
              <EuiFormRow label="Min confidence">{numberField(['fp_auto_close', 'min_confidence'], 0.95, 0.01)}</EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow label="Max risk score">{numberField(['fp_auto_close', 'max_risk_score'], 30, 1)}</EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow label="Objection window (minutes)">
                {numberField(['fp_auto_close', 'objection_window_minutes'], 60)}
              </EuiFormRow>
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiHorizontalRule margin="s" />
          <EuiFlexGroup wrap>
            <EuiFlexItem>
              <EuiFormRow label="Escalation confidence">{numberField(['escalation_confidence'], 0.6, 0.01)}</EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow label="Critical severity">{numberField(['critical_severity'], 7, 0.1)}</EuiFormRow>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ),
    },
    {
      id: 'sec-correlation',
      title: 'Correlation, risk weights & assets',
      icon: 'graphApp',
      accent: COLORS.accent,
      content: (
        <>
          {subLabel('Default correlation')}
          <EuiSpacer size="xs" />
          <EuiFlexGroup wrap responsive={false}>
            <EuiFlexItem style={{ minWidth: 150 }}>
              <EuiFormRow label="Mode">
                <EuiSuperSelect
                  disabled={readOnly}
                  options={CORRELATION_MODES.map((m) => ({ value: m, inputDisplay: m }))}
                  valueOfSelected={String(getPref(['default_correlation', 'mode'], 'threshold'))}
                  onChange={(v) => setPref(['default_correlation', 'mode'], v)}
                />
              </EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 90 }}>
              <EuiFormRow label="N">{numberField(['default_correlation', 'n'], 5)}</EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 140 }}>
              <EuiFormRow label="Window (s)">{numberField(['default_correlation', 'window_seconds'], 120)}</EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 130 }}>
              <EuiFormRow label="Group by">
                <EuiSuperSelect
                  disabled={readOnly}
                  options={ENTITY_TYPES.map((m) => ({ value: m, inputDisplay: m }))}
                  valueOfSelected={String(getPref(['default_correlation', 'group_by'], 'ip'))}
                  onChange={(v) => setPref(['default_correlation', 'group_by'], v)}
                />
              </EuiFormRow>
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiHorizontalRule margin="s" />
          <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
            <EuiFlexItem grow={false}>{subLabel('Per-rule correlation')}</EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty size="xs" iconType="plusInCircle" disabled={readOnly} onClick={addCorrelationRule}>
                Add rule
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
          {Object.keys(correlationRules).length === 0 ? (
            <EuiText size="xs" color="subdued"><p>No per-rule overrides; the default applies to all rules.</p></EuiText>
          ) : (
            Object.entries(correlationRules).map(([name, rule]: [string, any]) => (
              <EuiFlexGroup key={name} gutterSize="s" responsive={false} wrap alignItems="flexEnd">
                <EuiFlexItem style={{ minWidth: 160 }}>
                  <EuiFormRow label="Rule value" display="rowCompressed">
                    <EuiFieldText
                      compressed
                      disabled={readOnly}
                      defaultValue={name}
                      onBlur={(e) => renameCorrelationRule(name, e.target.value.trim())}
                    />
                  </EuiFormRow>
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 130 }}>
                  <EuiFormRow label="Mode" display="rowCompressed">
                    <EuiSuperSelect
                      compressed
                      disabled={readOnly}
                      options={CORRELATION_MODES.map((m) => ({ value: m, inputDisplay: m }))}
                      valueOfSelected={String(rule?.mode ?? 'threshold')}
                      onChange={(v) => setPref(['correlation_rules', name, 'mode'], v)}
                    />
                  </EuiFormRow>
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 70 }}>
                  <EuiFormRow label="N" display="rowCompressed">{numberField(['correlation_rules', name, 'n'], 5)}</EuiFormRow>
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 110 }}>
                  <EuiFormRow label="Window (s)" display="rowCompressed">
                    {numberField(['correlation_rules', name, 'window_seconds'], 120)}
                  </EuiFormRow>
                </EuiFlexItem>
                <EuiFlexItem style={{ minWidth: 110 }}>
                  <EuiFormRow label="Group by" display="rowCompressed">
                    <EuiSuperSelect
                      compressed
                      disabled={readOnly}
                      options={ENTITY_TYPES.map((m) => ({ value: m, inputDisplay: m }))}
                      valueOfSelected={String(rule?.group_by ?? 'ip')}
                      onChange={(v) => setPref(['correlation_rules', name, 'group_by'], v)}
                    />
                  </EuiFormRow>
                </EuiFlexItem>
                <EuiFlexItem grow={false}>
                  <EuiButtonIcon
                    color="danger"
                    iconType="trash"
                    aria-label={`Remove rule ${name}`}
                    isDisabled={readOnly}
                    onClick={() => removeCorrelationRule(name)}
                  />
                </EuiFlexItem>
              </EuiFlexGroup>
            ))
          )}

          <EuiHorizontalRule margin="s" />
          {subLabel('Risk weights', '(normalised to 0-100)')}
          <EuiSpacer size="xs" />
          <EuiFlexGroup wrap responsive={false}>
            {['volume', 'velocity', 'reputation', 'diversity', 'asset_criticality'].map((w) => (
              <EuiFlexItem key={w} style={{ minWidth: 120 }}>
                <EuiFormRow label={w}>{numberField(['risk_weights', w], 0, 0.05)}</EuiFormRow>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>

          <EuiHorizontalRule margin="s" />
          <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
            <EuiFlexItem grow={false}>{subLabel('Asset networks (CIDR → criticality)')}</EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty size="xs" iconType="plusInCircle" disabled={readOnly} onClick={addAssetNetwork}>
                Add network
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
          {assetNetworks.map((net: any, idx: number) => (
            <EuiFlexGroup key={idx} gutterSize="s" responsive={false} alignItems="flexEnd">
              <EuiFlexItem>
                <EuiFormRow label="CIDR" display="rowCompressed">
                  <EuiFieldText
                    compressed
                    disabled={readOnly}
                    value={net?.cidr ?? ''}
                    onChange={(e) => setPref(['asset_networks', idx, 'cidr'], e.target.value)}
                  />
                </EuiFormRow>
              </EuiFlexItem>
              <EuiFlexItem grow={false} style={{ minWidth: 140 }}>
                <EuiFormRow label="Criticality (0-100)" display="rowCompressed">
                  {numberField(['asset_networks', idx, 'criticality'], 0, 1)}
                </EuiFormRow>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonIcon
                  color="danger"
                  iconType="trash"
                  aria-label={`Remove network ${idx}`}
                  isDisabled={readOnly}
                  onClick={() => removeAssetNetwork(idx)}
                />
              </EuiFlexItem>
            </EuiFlexGroup>
          ))}

          <EuiHorizontalRule margin="s" />
          <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
            <EuiFlexItem grow={false}>{subLabel('Asset criticality (entity value → 0-100)')}</EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty size="xs" iconType="plusInCircle" disabled={readOnly} onClick={addAssetCriticality}>
                Add entity
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
          {Object.entries(assetCriticality).map(([k, v]: [string, any]) => (
            <EuiFlexGroup key={k} gutterSize="s" responsive={false} alignItems="flexEnd">
              <EuiFlexItem>
                <EuiFormRow label="Entity value" display="rowCompressed">
                  <EuiFieldText
                    compressed
                    disabled={readOnly}
                    defaultValue={k}
                    onBlur={(e) => renameAssetCriticality(k, e.target.value.trim())}
                  />
                </EuiFormRow>
              </EuiFlexItem>
              <EuiFlexItem grow={false} style={{ minWidth: 140 }}>
                <EuiFormRow label="Criticality" display="rowCompressed">
                  {numberField(['asset_criticality', k], 0, 1)}
                </EuiFormRow>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonIcon
                  color="danger"
                  iconType="trash"
                  aria-label={`Remove ${k}`}
                  isDisabled={readOnly}
                  onClick={() => removeAssetCriticality(k)}
                />
              </EuiFlexItem>
            </EuiFlexGroup>
          ))}
        </>
      ),
    },
    {
      id: 'sec-rule-catalog',
      title: 'Detection rule catalog',
      icon: 'list',
      accent: COLORS.primary,
      content: (
        <>
          <EuiText size="xs" color="subdued">
            <p>
              Config-driven detection rules. Each rule matches an event field and can carry its own
              correlation override. The catalog is seeded by the backend (event.module rules plus
              ModSec sub-rules such as <code>modsec_xss</code>); tune, enable/disable, add, or remove
              rules here. This is how rule-specific triggering (e.g. XSS) is enabled.
            </p>
          </EuiText>
          <EuiSpacer size="s" />
          <EuiFlexGroup justifyContent="flexEnd" alignItems="center">
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty size="xs" iconType="plusInCircle" disabled={readOnly} onClick={addRule}>
                Add rule
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
          {ruleCatalog.length === 0 ? (
            <EuiText size="xs" color="subdued">
              <p>No rules defined. The backend seeds defaults on first run; click "Add rule" to define one.</p>
            </EuiText>
          ) : (
            ruleCatalog.map((rule, idx) => {
              const corr = rule?.correlation || null;
              return (
                <EuiPanel key={idx} hasBorder paddingSize="s" style={{ marginBottom: 8 }}>
                  <EuiFlexGroup gutterSize="s" responsive={false} alignItems="center">
                    <EuiFlexItem grow={false}>
                      <EuiFormRow label="Enabled" display="rowCompressed">
                        <EuiSwitch
                          compressed
                          label=""
                          aria-label={`Enable rule ${rule?.name || idx}`}
                          disabled={readOnly}
                          checked={rule?.enabled !== false}
                          onChange={(e) => setPref(['rule_catalog', idx, 'enabled'], e.target.checked)}
                        />
                      </EuiFormRow>
                    </EuiFlexItem>
                    <EuiFlexItem>
                      <EuiFormRow label="Name" display="rowCompressed">
                        <EuiFieldText
                          compressed
                          disabled={readOnly}
                          value={rule?.name ?? ''}
                          onChange={(e) => setPref(['rule_catalog', idx, 'name'], e.target.value)}
                        />
                      </EuiFormRow>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false} style={{ minWidth: 110 }}>
                      <EuiFormRow label="Priority" display="rowCompressed">
                        {numberField(['rule_catalog', idx, 'priority'], 0, 1)}
                      </EuiFormRow>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiButtonIcon
                        color="danger"
                        iconType="trash"
                        aria-label={`Remove rule ${rule?.name || idx}`}
                        isDisabled={readOnly}
                        onClick={() => removeRule(idx)}
                      />
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <EuiFormRow label="Description" display="rowCompressed" fullWidth>
                    <EuiFieldText
                      compressed
                      fullWidth
                      disabled={readOnly}
                      value={rule?.description ?? ''}
                      onChange={(e) => setPref(['rule_catalog', idx, 'description'], e.target.value)}
                    />
                  </EuiFormRow>
                  <EuiText size="xs"><strong>Match</strong></EuiText>
                  <EuiSpacer size="xs" />
                  <EuiFlexGroup gutterSize="s" responsive={false} wrap alignItems="flexEnd">
                    <EuiFlexItem style={{ minWidth: 160 }}>
                      <EuiFormRow label="Field" display="rowCompressed">
                        <EuiFieldText
                          compressed
                          disabled={readOnly}
                          value={rule?.match?.field ?? ''}
                          onChange={(e) => setPref(['rule_catalog', idx, 'match', 'field'], e.target.value)}
                        />
                      </EuiFormRow>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false} style={{ minWidth: 120 }}>
                      <EuiFormRow label="Op" display="rowCompressed">
                        <EuiSelect
                          compressed
                          disabled={readOnly}
                          options={RULE_MATCH_OPS.map((o) => ({ value: o, text: o }))}
                          value={String(rule?.match?.op ?? 'equals')}
                          onChange={(e) =>
                            setPref(['rule_catalog', idx, 'match', 'op'], e.target.value as RuleMatch['op'])
                          }
                        />
                      </EuiFormRow>
                    </EuiFlexItem>
                    <EuiFlexItem style={{ minWidth: 160 }}>
                      <EuiFormRow label="Value" display="rowCompressed">
                        <EuiFieldText
                          compressed
                          disabled={readOnly || rule?.match?.op === 'exists'}
                          value={rule?.match?.value ?? ''}
                          onChange={(e) => setPref(['rule_catalog', idx, 'match', 'value'], e.target.value)}
                        />
                      </EuiFormRow>
                    </EuiFlexItem>
                  </EuiFlexGroup>

                  <EuiSpacer size="xs" />
                  <EuiSwitch
                    compressed
                    label="Correlation override for this rule"
                    disabled={readOnly}
                    checked={!!corr}
                    onChange={(e) => toggleRuleCorrelation(idx, e.target.checked)}
                  />
                  {corr ? (
                    <>
                      <EuiSpacer size="xs" />
                      <EuiFlexGroup gutterSize="s" responsive={false} wrap alignItems="flexEnd">
                        <EuiFlexItem style={{ minWidth: 130 }}>
                          <EuiFormRow label="Mode" display="rowCompressed">
                            <EuiSuperSelect
                              compressed
                              disabled={readOnly}
                              options={CORRELATION_MODES.map((m) => ({ value: m, inputDisplay: m }))}
                              valueOfSelected={String((corr as any)?.mode ?? 'threshold')}
                              onChange={(v) => setPref(['rule_catalog', idx, 'correlation', 'mode'], v)}
                            />
                          </EuiFormRow>
                        </EuiFlexItem>
                        <EuiFlexItem style={{ minWidth: 70 }}>
                          <EuiFormRow label="N" display="rowCompressed">
                            {numberField(['rule_catalog', idx, 'correlation', 'n'], 5)}
                          </EuiFormRow>
                        </EuiFlexItem>
                        <EuiFlexItem style={{ minWidth: 110 }}>
                          <EuiFormRow label="Window (s)" display="rowCompressed">
                            {numberField(['rule_catalog', idx, 'correlation', 'window_seconds'], 120)}
                          </EuiFormRow>
                        </EuiFlexItem>
                        <EuiFlexItem style={{ minWidth: 110 }}>
                          <EuiFormRow label="Group by" display="rowCompressed">
                            <EuiSuperSelect
                              compressed
                              disabled={readOnly}
                              options={ENTITY_TYPES.map((m) => ({ value: m, inputDisplay: m }))}
                              valueOfSelected={String((corr as any)?.group_by ?? 'ip')}
                              onChange={(v) => setPref(['rule_catalog', idx, 'correlation', 'group_by'], v)}
                            />
                          </EuiFormRow>
                        </EuiFlexItem>
                      </EuiFlexGroup>
                    </>
                  ) : null}
                </EuiPanel>
              );
            })
          )}
        </>
      ),
    },
    {
      id: 'sec-rule-models',
      title: 'Per-rule model overrides',
      icon: 'tableDensityNormal',
      accent: COLORS.accent,
      content: (
        <>
          <EuiText size="xs" color="subdued">
            <p>
              Override the model used for specific rules. Each row sets the provider/model for one or
              more roles; an empty entry falls back to the per-role model above. Models populate from
              the live catalog and you may type a custom (possibly unpriced) model.
            </p>
          </EuiText>
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="s" responsive={false} alignItems="flexEnd" wrap>
            <EuiFlexItem style={{ minWidth: 260 }}>
              <EuiFormRow label="Rule" display="rowCompressed">
                <EuiComboBox
                  compressed
                  isDisabled={readOnly}
                  singleSelection={{ asPlainText: true }}
                  options={catalogRuleNames
                    .filter((n) => ruleModelOverride[n] === undefined)
                    .map((n) => ({ label: n }))}
                  selectedOptions={newRuleModelName ? [{ label: newRuleModelName }] : []}
                  onChange={(opts) => setNewRuleModelName(opts[0]?.label || '')}
                  onCreateOption={(val) => setNewRuleModelName(val)}
                  placeholder="Pick a catalog rule or type a name"
                  customOptionText="Use rule name {searchValue}"
                />
              </EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                size="xs"
                iconType="plusInCircle"
                disabled={readOnly || !newRuleModelName.trim()}
                onClick={() => {
                  addRuleModelRow(newRuleModelName);
                  setNewRuleModelName('');
                }}
              >
                Add override
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="s" />
          {ruleModelNames.length === 0 ? (
            <EuiText size="xs" color="subdued">
              <p>No per-rule model overrides; all rules use the per-role models.</p>
            </EuiText>
          ) : (
            ruleModelNames.map((name) => (
              <EuiPanel key={name} hasBorder paddingSize="s" style={{ marginBottom: 8 }}>
                <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive={false}>
                  <EuiFlexItem grow={false}>
                    <EuiText size="s"><strong>{name}</strong></EuiText>
                  </EuiFlexItem>
                  <EuiFlexItem grow={false}>
                    <EuiButtonIcon
                      color="danger"
                      iconType="trash"
                      aria-label={`Remove override ${name}`}
                      isDisabled={readOnly}
                      onClick={() => removeRuleModelRow(name)}
                    />
                  </EuiFlexItem>
                </EuiFlexGroup>
                {RULE_MODEL_ROLES.map((r) => (
                  <React.Fragment key={r.key}>
                    <EuiText size="xs"><strong>{r.label}</strong></EuiText>
                    <EuiSpacer size="xs" />
                    <EuiFlexGroup gutterSize="s" responsive={false} wrap>
                      {modelPickerAt(['rule_model_override', name, r.key], 'anthropic')}
                    </EuiFlexGroup>
                    <EuiSpacer size="xs" />
                  </React.Fragment>
                ))}
              </EuiPanel>
            ))
          )}
        </>
      ),
    },
    {
      id: 'sec-caps',
      title: 'Cost gate, caps & suppression',
      icon: 'controlsVertical',
      accent: COLORS.danger,
      content: (
        <>
          <EuiCallOut
            color={getPref(['caps', 'kill_switch'], false) ? 'danger' : 'primary'}
            iconType={getPref(['caps', 'kill_switch'], false) ? 'alert' : 'stopFilled'}
            title="Kill switch"
            size="s"
          >
            <EuiText size="s">
              <p>When on, ALL investigations stop immediately.</p>
            </EuiText>
            <EuiSpacer size="xs" />
            {switchField(['caps', 'kill_switch'], 'Kill switch (stop all investigations)', false)}
          </EuiCallOut>
          <EuiSpacer size="s" />
          <EuiFlexGroup wrap>
            <EuiFlexItem>
              <EuiFormRow label="Max tool calls">{numberField(['caps', 'max_tool_calls'], 8)}</EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow label="Max tokens">{numberField(['caps', 'max_tokens'], 20000)}</EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow label="Timeout (seconds)">{numberField(['caps', 'timeout_seconds'], 120)}</EuiFormRow>
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiHorizontalRule margin="s" />
          <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
            <EuiFlexItem grow={false}>{subLabel('Suppression rules', '(matching events are dropped)')}</EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty size="xs" iconType="plusInCircle" disabled={readOnly} onClick={addSuppression}>
                Add rule
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
          {suppressionRules.map((s: any, idx: number) => (
            <EuiFlexGroup key={idx} gutterSize="s" responsive={false} wrap alignItems="flexEnd">
              <EuiFlexItem>
                <EuiFormRow label="Field" display="rowCompressed">
                  <EuiFieldText
                    compressed
                    disabled={readOnly}
                    value={s?.field ?? ''}
                    onChange={(e) => setPref(['suppression_rules', idx, 'field'], e.target.value)}
                  />
                </EuiFormRow>
              </EuiFlexItem>
              <EuiFlexItem>
                <EuiFormRow label="Value" display="rowCompressed">
                  <EuiFieldText
                    compressed
                    disabled={readOnly}
                    value={s?.value ?? ''}
                    onChange={(e) => setPref(['suppression_rules', idx, 'value'], e.target.value)}
                  />
                </EuiFormRow>
              </EuiFlexItem>
              <EuiFlexItem>
                <EuiFormRow label="Reason" display="rowCompressed">
                  <EuiFieldText
                    compressed
                    disabled={readOnly}
                    value={s?.reason ?? ''}
                    onChange={(e) => setPref(['suppression_rules', idx, 'reason'], e.target.value)}
                  />
                </EuiFormRow>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiButtonIcon
                  color="danger"
                  iconType="trash"
                  aria-label={`Remove suppression ${idx}`}
                  isDisabled={readOnly}
                  onClick={() => removeSuppression(idx)}
                />
              </EuiFlexItem>
            </EuiFlexGroup>
          ))}
        </>
      ),
    },
    {
      id: 'sec-scans',
      title: 'Automated scans, enrichment, RAG & standup',
      icon: 'inspect',
      accent: COLORS.success,
      content: (
        <>
          {subLabel('Automated scans')}
          <EuiSpacer size="xs" />
          {switchField(['background_scan_enabled'], 'Background scan enabled', false)}
          <EuiSpacer size="s" />
          <EuiFormRow label="Auto-forward allowlist (comma separated rule values)">
            {csvField(['auto_forward_allowlist'])}
          </EuiFormRow>

          <EuiHorizontalRule margin="s" />
          {subLabel('Enrichment')}
          <EuiSpacer size="xs" />
          {switchField(['enrichment', 'enabled'], 'Enrichment enabled', true)}
          {switchField(['enrichment', 'use_abuseipdb'], 'Use AbuseIPDB', true)}
          {switchField(['enrichment', 'use_virustotal'], 'Use VirusTotal', true)}
          {switchField(['enrichment', 'use_geoip'], 'Use GeoIP', true)}
          <EuiSpacer size="s" />
          <EuiFormRow label="Cache TTL (seconds)">{numberField(['enrichment', 'cache_ttl_seconds'], 21600)}</EuiFormRow>

          <EuiHorizontalRule margin="s" />
          {subLabel('RAG')}
          <EuiSpacer size="xs" />
          {switchField(['rag', 'enabled'], 'RAG enabled', true)}
          {switchField(['rag', 'use_runbooks'], 'Use runbooks', true)}
          {switchField(['rag', 'use_mitre'], 'Use MITRE', true)}
          {switchField(['rag', 'use_resolved_cases'], 'Use resolved cases', true)}
          {switchField(['rag', 'use_suppression_rules'], 'Use suppression rules', true)}
          <EuiSpacer size="s" />
          <EuiFlexGroup wrap>
            <EuiFlexItem>
              <EuiFormRow label="Top K">{numberField(['rag', 'top_k'], 4)}</EuiFormRow>
            </EuiFlexItem>
            {getPref(['rag', 'min_score'], undefined) !== undefined ? (
              <EuiFlexItem>
                <EuiFormRow label="Min score">{numberField(['rag', 'min_score'], 0, 0.01)}</EuiFormRow>
              </EuiFlexItem>
            ) : null}
          </EuiFlexGroup>

          <EuiHorizontalRule margin="s" />
          {subLabel('Standup')}
          <EuiSpacer size="xs" />
          {switchField(['standup', 'enabled'], 'Standup enabled', true)}
          <EuiSpacer size="s" />
          <EuiFlexGroup wrap>
            <EuiFlexItem>
              <EuiFormRow label="Window (hours)">{numberField(['standup', 'window_hours'], 24)}</EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow label="Interval (seconds)">{numberField(['standup', 'interval_seconds'], 86400)}</EuiFormRow>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ),
    },
    {
      id: 'sec-secrets',
      title: 'Credentials & access mode',
      icon: 'lock',
      accent: COLORS.warning,
      content: (
        <>
          {subLabel('Configured credentials', '(status only — values are never shown)')}
          <EuiSpacer size="s" />
          {/* Health dots read configured-state at a glance: green = configured,
              subdued = not set. Same iteration over `configured` as before. */}
          <EuiFlexGroup wrap gutterSize="l" responsive={false}>
            {Object.entries(configured).map(([k, v]) => (
              <EuiFlexItem grow={false} key={k}>
                <EuiHealth color={v ? COLORS.success : COLORS.subdued}>
                  <span style={{ color: v ? undefined : COLORS.subdued }}>
                    {humanizeToken(k)}: {v ? 'configured' : 'not set'}
                  </span>
                </EuiHealth>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>

          <EuiSpacer size="m" />
          {subLabel('Update keys')}
          <EuiText size="xs" color="subdued">
            <p>
              Keys sent here are stored IN-MEMORY in the backend and are lost on restart. For durable
              configuration, set the matching <code>TLSOC_*</code> variables in <code>.env</code>.
            </p>
          </EuiText>
          <EuiSpacer size="s" />
          {[
            ['es_api_key', 'ES read-only API key'],
            ['es_mgmt_api_key', 'ES management API key'],
            ['anthropic_api_key', 'Anthropic API key'],
            ['openai_api_key', 'OpenAI API key'],
            ['abuseipdb_api_key', 'AbuseIPDB API key'],
            ['virustotal_api_key', 'VirusTotal API key'],
            ['embedding_api_key', 'Embedding API key'],
          ].map(([key, label]) => (
            <EuiFormRow key={key} label={label}>
              <EuiFieldText
                type="password"
                disabled={readOnly}
                placeholder={configured[key] ? '•••••••• (configured)' : 'not set'}
                value={secretDraft[key] || ''}
                onChange={(e) => setSecretDraft((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            </EuiFormRow>
          ))}
          <EuiSpacer size="s" />
          <EuiButton size="s" onClick={saveSecrets} isLoading={savingSecrets} isDisabled={readOnly}>
            Update keys
          </EuiButton>

          <EuiHorizontalRule margin="m" />
          {subLabel('Access mode')}
          <EuiSpacer size="xs" />
          <EuiSwitch
            label="Read-only settings mode (disables editing across this page)"
            checked={!!getPref(['read_only_settings_mode'], false)}
            onChange={(e) => setPref(['read_only_settings_mode'], e.target.checked)}
          />
          <EuiText size="xs" color="subdued">
            <p>Toggle and click "Save settings" to apply.</p>
          </EuiText>
        </>
      ),
    },
  ];

  // The currently selected section descriptor (defaults to data). `find` always
  // resolves because `activeSection` is seeded from, and only set to, ids above.
  const active = sections.find((s) => s.id === activeSection) || sections[0];

  return (
    <div>
      <SectionHeader
        icon="gear"
        title="Settings"
        description="Tune data scope, models, detection, cost caps and credentials. Changes are saved to the backend preferences store."
        actions={
          <EuiFlexGroup gutterSize="s" responsive={false}>
            <EuiFlexItem grow={false}>
              <EuiButton size="s" iconType="refresh" onClick={load} isLoading={loading}>
                Reload
              </EuiButton>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                fill
                iconType="save"
                onClick={save}
                isLoading={saving}
                isDisabled={readOnly && getPref(['read_only_settings_mode'], false) === true}
              >
                Save settings
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        }
      />

      {readOnly ? (
        <>
          <EuiCallOut
            color="warning"
            iconType="lock"
            title="Settings are in read-only mode"
          >
            <EuiText size="s">
              <p>
                All inputs below are disabled. To re-enable editing, turn off read-only mode and
                save.
              </p>
            </EuiText>
            <EuiSpacer size="s" />
            <EuiSwitch
              label="Read-only settings mode"
              checked={!!getPref(['read_only_settings_mode'], true)}
              onChange={(e) => setPref(['read_only_settings_mode'], e.target.checked)}
            />
            <EuiSpacer size="s" />
            <EuiButton
              size="s"
              onClick={save}
              isLoading={saving}
              isDisabled={getPref(['read_only_settings_mode'], true) === true}
            >
              Save to unlock
            </EuiButton>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      ) : null}

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {/* Two-column layout: a left section nav + the selected section's panel.
          The accordions were replaced by this so the ~91 fields are easier to
          navigate and the wide horizontal space is used. Layout only. */}
      <EuiFlexGroup gutterSize="l" alignItems="flexStart">
        <EuiFlexItem grow={false} style={{ minWidth: 220 }}>
          <div style={{ position: 'sticky', top: 8 }}>
            <EuiSideNav
              mobileTitle="Settings sections"
              isOpenOnMobile={isSideNavOpenOnMobile}
              toggleOpenOnMobile={() => setIsSideNavOpenOnMobile((open) => !open)}
              items={[
                {
                  id: 'tlsoc-settings-nav',
                  name: 'Settings',
                  items: sections.map((s) => ({
                    id: s.id,
                    name: s.title,
                    icon: <EuiIcon type={s.icon} size="s" />,
                    isSelected: activeSection === s.id,
                    onClick: () => setActiveSection(s.id),
                  })),
                },
              ]}
            />
          </div>
        </EuiFlexItem>
        <EuiFlexItem>
          {sectionPanel(active.title, active.content, {
            icon: active.icon,
            accent: active.accent,
          })}
        </EuiFlexItem>
      </EuiFlexGroup>
    </div>
  );
};
