import React, { useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiCallOut,
  EuiCheckbox,
  EuiDescriptionList,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiPanel,
  EuiSpacer,
  EuiTitle,
  EuiText,
  EuiTextArea,
} from '@elastic/eui';
import type { SettingsResponse } from '../../common';
import type { TlsocApi } from '../lib/api';

interface SettingsProps {
  api: TlsocApi;
}

interface CorrelationRule {
  mode?: string;
  n?: number;
  window_seconds?: number;
  group_by?: string;
}

export const Settings: React.FC<SettingsProps> = ({ api }) => {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [prefs, setPrefs] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<SettingsResponse>('settings');
      setData(resp);
      setPrefs(resp.prefs || {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readOnly = !!data?.read_only;

  const setPref = (path: string[], value: any) => {
    setPrefs((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      let obj = next;
      for (let i = 0; i < path.length - 1; i++) {
        if (typeof obj[path[i]] !== 'object' || obj[path[i]] === null) {
          obj[path[i]] = {};
        }
        obj = obj[path[i]];
      }
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  const getPref = (path: string[], dflt?: any) => {
    let obj: any = prefs;
    for (const p of path) {
      if (obj === null || obj === undefined) return dflt;
      obj = obj[p];
    }
    return obj === undefined || obj === null ? dflt : obj;
  };

  const save = async (partial: Record<string, any>) => {
    setSaving(true);
    setError(null);
    setOkMsg(null);
    try {
      const resp = await api.put<{ ok: boolean; prefs: Record<string, any> }>('settings', partial);
      setPrefs(resp.prefs);
      setOkMsg('Settings saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const configured = data?.configured || {};

  const correlationRules: Record<string, CorrelationRule> = getPref(['correlation_rules'], {}) || {};

  return (
    <div>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="s">
            <h2>Settings</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton size="s" iconType="refresh" onClick={load} isLoading={loading}>
            Reload
          </EuiButton>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="s" />

      {readOnly ? (
        <>
          <EuiCallOut color="warning" size="s" title="Settings are in read-only mode" />
          <EuiSpacer size="s" />
        </>
      ) : null}
      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="s" />
        </>
      ) : null}
      {okMsg ? (
        <>
          <EuiCallOut color="success" size="s" title={okMsg} />
          <EuiSpacer size="s" />
        </>
      ) : null}

      {/* Secret status (never shows values) */}
      <EuiPanel hasBorder>
        <EuiTitle size="xs">
          <h3>Configured credentials</h3>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiFlexGroup wrap gutterSize="s" responsive={false}>
          {Object.entries(configured).map(([k, v]) => (
            <EuiFlexItem grow={false} key={k}>
              <EuiBadge color={v ? 'success' : 'default'}>
                {k}: {v ? 'configured ✓' : 'not set'}
              </EuiBadge>
            </EuiFlexItem>
          ))}
        </EuiFlexGroup>
      </EuiPanel>

      <EuiSpacer size="m" />

      {/* Polling + thresholds */}
      <EuiPanel hasBorder>
        <EuiTitle size="xs">
          <h3>Polling &amp; detection</h3>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiFlexGroup wrap>
          <EuiFlexItem>
            <EuiFormRow label="Poll interval (seconds)">
              <EuiFieldNumber
                disabled={readOnly}
                value={getPref(['poll_interval_seconds'], 30)}
                onChange={(e) => setPref(['poll_interval_seconds'], Number(e.target.value))}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow label="Severity threshold">
              <EuiFieldNumber
                disabled={readOnly}
                value={getPref(['severity_threshold'], 0)}
                step={0.1}
                onChange={(e) => setPref(['severity_threshold'], Number(e.target.value))}
              />
            </EuiFormRow>
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiCheckbox
          id="polling_enabled"
          disabled={readOnly}
          label="Polling enabled"
          checked={!!getPref(['polling_enabled'], true)}
          onChange={(e) => setPref(['polling_enabled'], e.target.checked)}
        />
        <EuiCheckbox
          id="background_scan_enabled"
          disabled={readOnly}
          label="Background scan enabled"
          checked={!!getPref(['background_scan_enabled'], false)}
          onChange={(e) => setPref(['background_scan_enabled'], e.target.checked)}
        />
        <EuiSpacer size="s" />
        <EuiFormRow label="Auto-forward allowlist (comma separated rule values)">
          <EuiFieldText
            disabled={readOnly}
            value={(getPref(['auto_forward_allowlist'], []) || []).join(', ')}
            onChange={(e) =>
              setPref(
                ['auto_forward_allowlist'],
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            }
          />
        </EuiFormRow>
      </EuiPanel>

      <EuiSpacer size="m" />

      {/* Caps / kill switch */}
      <EuiPanel hasBorder>
        <EuiTitle size="xs">
          <h3>Caps &amp; kill switch</h3>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiFlexGroup wrap>
          <EuiFlexItem>
            <EuiFormRow label="Max tool calls">
              <EuiFieldNumber
                disabled={readOnly}
                value={getPref(['caps', 'max_tool_calls'], 8)}
                onChange={(e) => setPref(['caps', 'max_tool_calls'], Number(e.target.value))}
              />
            </EuiFormRow>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiFormRow label="Max tokens">
              <EuiFieldNumber
                disabled={readOnly}
                value={getPref(['caps', 'max_tokens'], 20000)}
                onChange={(e) => setPref(['caps', 'max_tokens'], Number(e.target.value))}
              />
            </EuiFormRow>
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiCheckbox
          id="kill_switch"
          disabled={readOnly}
          label="Kill switch (stop all investigations)"
          checked={!!getPref(['caps', 'kill_switch'], false)}
          onChange={(e) => setPref(['caps', 'kill_switch'], e.target.checked)}
        />
      </EuiPanel>

      <EuiSpacer size="m" />

      {/* FP auto-close + toggles */}
      <EuiPanel hasBorder>
        <EuiTitle size="xs">
          <h3>Automation toggles</h3>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiCheckbox
          id="fp_auto_close_enabled"
          disabled={readOnly}
          label="FP auto-close enabled"
          checked={!!getPref(['fp_auto_close', 'enabled'], false)}
          onChange={(e) => setPref(['fp_auto_close', 'enabled'], e.target.checked)}
        />
        <EuiCheckbox
          id="enrichment_enabled"
          disabled={readOnly}
          label="Enrichment enabled"
          checked={!!getPref(['enrichment', 'enabled'], true)}
          onChange={(e) => setPref(['enrichment', 'enabled'], e.target.checked)}
        />
        <EuiCheckbox
          id="rag_enabled"
          disabled={readOnly}
          label="RAG enabled"
          checked={!!getPref(['rag', 'enabled'], true)}
          onChange={(e) => setPref(['rag', 'enabled'], e.target.checked)}
        />
        <EuiCheckbox
          id="standup_enabled"
          disabled={readOnly}
          label="Standup enabled"
          checked={!!getPref(['standup', 'enabled'], true)}
          onChange={(e) => setPref(['standup', 'enabled'], e.target.checked)}
        />
      </EuiPanel>

      <EuiSpacer size="m" />

      {/* Correlation rules editor */}
      <EuiPanel hasBorder>
        <EuiTitle size="xs">
          <h3>Per-rule correlation</h3>
        </EuiTitle>
        <EuiSpacer size="xs" />
        <EuiText size="xs" color="subdued">
          <p>
            Map of rule value to {'{ mode, n, window_seconds, group_by }'}. Edit as JSON; saved on
            "Save settings".
          </p>
        </EuiText>
        <EuiSpacer size="xs" />
        <EuiTextArea
          fullWidth
          disabled={readOnly}
          rows={6}
          value={JSON.stringify(correlationRules, null, 2)}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value);
              setPref(['correlation_rules'], parsed);
              setError(null);
            } catch {
              // keep raw; surface a hint only
              setError('correlation_rules: invalid JSON (not saved until valid)');
            }
          }}
        />
      </EuiPanel>

      <EuiSpacer size="m" />

      <EuiButton
        fill
        isLoading={saving}
        isDisabled={readOnly}
        onClick={() =>
          save({
            poll_interval_seconds: getPref(['poll_interval_seconds'], 30),
            polling_enabled: !!getPref(['polling_enabled'], true),
            severity_threshold: getPref(['severity_threshold'], 0),
            background_scan_enabled: !!getPref(['background_scan_enabled'], false),
            auto_forward_allowlist: getPref(['auto_forward_allowlist'], []),
            fp_auto_close: { enabled: !!getPref(['fp_auto_close', 'enabled'], false) },
            caps: {
              max_tool_calls: getPref(['caps', 'max_tool_calls'], 8),
              max_tokens: getPref(['caps', 'max_tokens'], 20000),
              kill_switch: !!getPref(['caps', 'kill_switch'], false),
            },
            enrichment: { enabled: !!getPref(['enrichment', 'enabled'], true) },
            rag: { enabled: !!getPref(['rag', 'enabled'], true) },
            standup: { enabled: !!getPref(['standup', 'enabled'], true) },
            correlation_rules: getPref(['correlation_rules'], {}),
          })
        }
      >
        Save settings
      </EuiButton>

      <EuiSpacer size="m" />
      <EuiDescriptionList
        compressed
        type="column"
        listItems={[
          { title: 'Data view pattern', description: String(getPref(['data_view_pattern'], '-')) },
          {
            title: 'Entity mapping',
            description: `ip=${getPref(['source_ip_field'], '-')} user=${getPref(['user_field'], '-')} host=${getPref(['host_field'], '-')}`,
          },
        ]}
      />
    </div>
  );
};
