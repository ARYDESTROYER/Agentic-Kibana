/**
 * Step 4 — Enrichment & detection. Optional enrichment keys (AbuseIPDB /
 * VirusTotal), correlation defaults, risk weights, auto-forward allowlist, and
 * the global kill switch. Non-secret values are written via PUT /api/settings;
 * keys via POST /api/setup/secrets.
 */
import React, { useState } from 'react';
import {
  EuiButton,
  EuiCallOut,
  EuiComboBox,
  EuiFieldNumber,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiPanel,
  EuiRange,
  EuiSelect,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type {
  ConfiguredStatus,
  CorrelationRule,
  Preferences,
  RiskWeights,
} from '../../../lib/types';
import { api } from '../../../lib/api';
import { COLORS } from '../../../lib/theme';
import { humanizeToken } from '../../../lib/format';
import { ErrorCallout } from '../../common/ui';
import { SecretInput } from '../../common/SecretInput';

interface DetectionStepProps {
  configured: ConfiguredStatus;
  prefs: Preferences;
  onPrefs: (p: Preferences) => void;
  onSecretsSaved: () => Promise<void> | void;
}

const RISK_FIELDS: Array<{ key: keyof RiskWeights; label: string }> = [
  { key: 'volume', label: 'Volume' },
  { key: 'velocity', label: 'Velocity' },
  { key: 'reputation', label: 'Reputation' },
  { key: 'diversity', label: 'Diversity' },
  { key: 'asset_criticality', label: 'Asset criticality' },
];

export const DetectionStep: React.FC<DetectionStepProps> = ({
  configured,
  prefs,
  onPrefs,
  onSecretsSaved,
}) => {
  const [abuseKey, setAbuseKey] = useState('');
  const [vtKey, setVtKey] = useState('');
  const [savingKeys, setSavingKeys] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const corr: CorrelationRule = prefs.default_correlation || {};
  const weights: RiskWeights = prefs.risk_weights || {};

  const setCorr = (patch: Partial<CorrelationRule>) =>
    onPrefs({ ...prefs, default_correlation: { ...corr, ...patch } });
  const setWeight = (key: keyof RiskWeights, v: number) =>
    onPrefs({ ...prefs, risk_weights: { ...weights, [key]: v } });

  const saveKeys = async () => {
    setSavingKeys(true);
    setError(null);
    setNote(null);
    try {
      const body: Record<string, string> = {};
      if (abuseKey) body.abuseipdb_api_key = abuseKey;
      if (vtKey) body.virustotal_api_key = vtKey;
      if (Object.keys(body).length) {
        await api.updateSecrets(body);
        await onSecretsSaved();
        setAbuseKey('');
        setVtKey('');
        setNote('Enrichment keys saved.');
      } else {
        setNote('No new enrichment keys entered.');
      }
    } catch (e) {
      setError(e);
    } finally {
      setSavingKeys(false);
    }
  };

  const savePrefs = async () => {
    setSavingPrefs(true);
    setError(null);
    setNote(null);
    try {
      await api.putSettings({
        default_correlation: prefs.default_correlation,
        risk_weights: prefs.risk_weights,
        auto_forward_allowlist: prefs.auto_forward_allowlist,
        background_scan_enabled: prefs.background_scan_enabled,
        caps: prefs.caps,
        enrichment: prefs.enrichment,
      });
      setNote('Detection settings saved.');
    } catch (e) {
      setError(e);
    } finally {
      setSavingPrefs(false);
    }
  };

  return (
    <div>
      <EuiTitle size="m">
        <h2>Enrichment &amp; detection</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      <EuiText color="subdued">
        <p>Tune how alerts are correlated, scored, and (optionally) auto-investigated.</p>
      </EuiText>

      <EuiSpacer size="l" />

      {/* Enrichment keys */}
      <EuiPanel hasBorder paddingSize="l">
        <EuiTitle size="xs">
          <h3>Threat-intel enrichment (optional)</h3>
        </EuiTitle>
        <EuiSpacer size="m" />
        <EuiSwitch
          label="Enable enrichment"
          checked={prefs.enrichment?.enabled ?? true}
          onChange={(e) =>
            onPrefs({ ...prefs, enrichment: { ...prefs.enrichment, enabled: e.target.checked } })
          }
        />
        <EuiSpacer size="m" />
        <SecretInput
          label="AbuseIPDB API key"
          secretKey="abuseipdb_api_key"
          configured={configured.abuseipdb_api_key}
          value={abuseKey}
          onChange={setAbuseKey}
          help="IP reputation enrichment. Optional; cached to protect free-tier limits."
        />
        <SecretInput
          label="VirusTotal API key"
          secretKey="virustotal_api_key"
          configured={configured.virustotal_api_key}
          value={vtKey}
          onChange={setVtKey}
          help="File/URL/IP reputation enrichment. Optional."
        />
        <EuiSpacer size="m" />
        <EuiButton iconType="save" onClick={saveKeys} isLoading={savingKeys}>
          Save enrichment keys
        </EuiButton>
      </EuiPanel>

      <EuiSpacer size="l" />

      {/* Correlation defaults */}
      <EuiPanel hasBorder paddingSize="l">
        <EuiTitle size="xs">
          <h3>Default correlation</h3>
        </EuiTitle>
        <EuiText size="xs" color="subdued">
          <p>How many matching events within a window, grouped by entity, form a cluster to investigate.</p>
        </EuiText>
        <EuiSpacer size="m" />
        <EuiFlexGroup wrap gutterSize="l">
          <EuiFlexItem style={{ minWidth: 220 }}>
            <EuiFormRow label="Mode">
              <EuiSelect
                options={[
                  { value: 'threshold', text: 'Threshold (N within window)' },
                  { value: 'every', text: 'Every occurrence' },
                  { value: 'never', text: 'Never (manual only)' },
                ]}
                value={corr.mode || 'threshold'}
                onChange={(e) => setCorr({ mode: e.target.value as CorrelationRule['mode'] })}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem style={{ minWidth: 160 }}>
            <EuiFormRow label="Threshold (N)">
              <EuiFieldNumber
                min={1}
                value={corr.n ?? 5}
                onChange={(e) => setCorr({ n: Number(e.target.value) })}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem style={{ minWidth: 180 }}>
            <EuiFormRow label="Window (seconds)">
              <EuiFieldNumber
                min={1}
                value={corr.window_seconds ?? 120}
                onChange={(e) => setCorr({ window_seconds: Number(e.target.value) })}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem style={{ minWidth: 160 }}>
            <EuiFormRow label="Group by">
              <EuiSelect
                options={[
                  { value: 'ip', text: 'Source IP' },
                  { value: 'user', text: 'User' },
                  { value: 'host', text: 'Host' },
                ]}
                value={corr.group_by || 'ip'}
                onChange={(e) => setCorr({ group_by: e.target.value as CorrelationRule['group_by'] })}
              />
            </EuiFormRow>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>

      <EuiSpacer size="l" />

      {/* Risk weights */}
      <EuiPanel hasBorder paddingSize="l">
        <EuiTitle size="xs">
          <h3>Risk weights</h3>
        </EuiTitle>
        <EuiText size="xs" color="subdued">
          <p>Relative weight of each component in the deterministic 0–100 risk score (auto-normalised).</p>
        </EuiText>
        <EuiSpacer size="m" />
        {RISK_FIELDS.map((f) => (
          <EuiFormRow key={f.key} label={f.label} fullWidth>
            <EuiRange
              min={0}
              max={1}
              step={0.05}
              showInput
              value={Number(weights[f.key] ?? 0)}
              onChange={(e) =>
                setWeight(f.key, Number((e.target as HTMLInputElement).value))
              }
              fullWidth
            />
          </EuiFormRow>
        ))}
      </EuiPanel>

      <EuiSpacer size="l" />

      {/* Auto-forward + kill switch */}
      <EuiPanel hasBorder paddingSize="l">
        <EuiTitle size="xs">
          <h3>Automation &amp; safety</h3>
        </EuiTitle>
        <EuiSpacer size="m" />
        <EuiSwitch
          label="Enable background automated scans"
          checked={Boolean(prefs.background_scan_enabled)}
          onChange={(e) => onPrefs({ ...prefs, background_scan_enabled: e.target.checked })}
        />
        <EuiSpacer size="m" />
        <EuiFormRow
          label="Auto-forward allowlist"
          helpText="Rule values that automatically forward to investigation when seen (type and press Enter)."
          fullWidth
        >
          <EuiComboBox
            noSuggestions
            placeholder="e.g. modsec_sqli, web_auth…"
            selectedOptions={(prefs.auto_forward_allowlist || []).map((r) => ({ label: r }))}
            onCreateOption={(v) =>
              onPrefs({
                ...prefs,
                auto_forward_allowlist: [...(prefs.auto_forward_allowlist || []), v],
              })
            }
            onChange={(opts) =>
              onPrefs({ ...prefs, auto_forward_allowlist: opts.map((o) => o.label) })
            }
            fullWidth
          />
        </EuiFormRow>
        <EuiSpacer size="m" />
        <EuiPanel color="subdued" hasShadow={false} paddingSize="m">
          <EuiSwitch
            label="Kill switch — emergency stop for ALL investigations"
            checked={Boolean(prefs.caps?.kill_switch)}
            onChange={(e) =>
              onPrefs({ ...prefs, caps: { ...prefs.caps, kill_switch: e.target.checked } })
            }
          />
          {prefs.caps?.kill_switch ? (
            <EuiText size="xs" color={COLORS.danger}>
              <span>While on, no LLM investigations will run.</span>
            </EuiText>
          ) : null}
        </EuiPanel>
      </EuiPanel>

      <EuiSpacer size="l" />
      <EuiFlexGroup justifyContent="flexStart" alignItems="center" gutterSize="m" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiButton fill iconType="save" onClick={savePrefs} isLoading={savingPrefs}>
            Save detection settings
          </EuiButton>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            <span>{humanizeToken(corr.mode)} correlation, {RISK_FIELDS.length} risk components.</span>
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>

      {note ? (
        <>
          <EuiSpacer size="m" />
          <EuiCallOut size="s" color="success" iconType="check" title={note} />
        </>
      ) : null}
      {error ? (
        <>
          <EuiSpacer size="m" />
          <ErrorCallout error={error} />
        </>
      ) : null}
    </div>
  );
};
