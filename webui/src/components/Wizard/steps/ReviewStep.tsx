/**
 * Step 5 — Review & finish. A read-only summary of everything configured. The
 * parent's "Finish setup" button calls POST /api/setup/complete and routes to the
 * dashboard.
 */
import React from 'react';
import {
  EuiBadge,
  EuiCallOut,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHealth,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { ConfiguredStatus, ModelConfig, Preferences, SourceInstance } from '../../../lib/types';
import { MODEL_ROLES } from '../../../lib/types';
import { COLORS } from '../../../lib/theme';
import { humanizeToken } from '../../../lib/format';

interface ReviewStepProps {
  deploymentName: string;
  demoMode: boolean;
  sources: SourceInstance[];
  configured: ConfiguredStatus;
  prefs: Preferences | null;
}

const ROLE_PREF_KEY: Record<string, keyof Preferences> = {
  router: 'router_model',
  investigator: 'investigator_model',
  formatter: 'formatter_model',
  standup: 'standup_model',
  chat: 'chat_model',
  overview: 'overview_model',
  embedding: 'embedding_model',
};

const ConfiguredDot: React.FC<{ ok?: boolean; label: string }> = ({ ok, label }) => (
  <EuiHealth color={ok ? COLORS.success : COLORS.subdued}>
    {label} {ok ? 'configured' : 'not set'}
  </EuiHealth>
);

export const ReviewStep: React.FC<ReviewStepProps> = ({
  deploymentName,
  demoMode,
  sources,
  configured,
  prefs,
}) => {
  const hasProvider = configured.anthropic_api_key || configured.openai_api_key;
  const primary = sources.find((s) => s.is_primary) || sources.find((s) => s.enabled);

  return (
    <div>
      <EuiTitle size="m">
        <h2>Review &amp; finish</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      <EuiText color="subdued">
        <p>Confirm your configuration. You can change any of this later in Settings.</p>
      </EuiText>

      <EuiSpacer size="l" />

      {!hasProvider && !demoMode ? (
        <>
          <EuiCallOut
            color="warning"
            iconType="alert"
            title="No LLM provider key configured"
            size="s"
          >
            <p>The agent cannot run investigations without an Anthropic or OpenAI key. You can still finish and add one later in Settings.</p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      ) : null}

      {sources.length === 0 && !demoMode ? (
        <>
          <EuiCallOut color="warning" iconType="alert" title="No source configured" size="s">
            <p>Add a source so the agent has events to triage. You can finish in demo mode and add one later.</p>
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      ) : null}

      <EuiFlexGroup gutterSize="l" wrap>
        <EuiFlexItem style={{ minWidth: 320 }}>
          <EuiPanel hasBorder paddingSize="l" style={{ height: '100%' }}>
            <EuiTitle size="xs">
              <h3>Deployment</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <EuiDescriptionList
              compressed
              type="column"
              listItems={[
                { title: 'Name', description: deploymentName || '—' },
                {
                  title: 'Mode',
                  description: demoMode ? <EuiBadge color={COLORS.accent}>Demo</EuiBadge> : 'Live',
                },
              ]}
            />
          </EuiPanel>
        </EuiFlexItem>

        <EuiFlexItem style={{ minWidth: 320 }}>
          <EuiPanel hasBorder paddingSize="l" style={{ height: '100%' }}>
            <EuiTitle size="xs">
              <h3>Sources ({sources.length})</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            {sources.length ? (
              sources.map((s) => (
                <EuiText size="s" key={s.id}>
                  <span>
                    {s.display_name || s.source_type}{' '}
                    {s.is_primary ? <EuiBadge color={COLORS.primary}>primary</EuiBadge> : null}
                  </span>
                </EuiText>
              ))
            ) : (
              <EuiText size="s" color="subdued">
                <span>None configured.</span>
              </EuiText>
            )}
            {primary ? (
              <>
                <EuiSpacer size="s" />
                <EuiText size="xs" color="subdued">
                  <span>Agent reads from: {primary.display_name || primary.source_type}</span>
                </EuiText>
              </>
            ) : null}
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      <EuiFlexGroup gutterSize="l" wrap>
        <EuiFlexItem style={{ minWidth: 320 }}>
          <EuiPanel hasBorder paddingSize="l" style={{ height: '100%' }}>
            <EuiTitle size="xs">
              <h3>Keys</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <ConfiguredDot ok={configured.anthropic_api_key} label="Anthropic" />
            <ConfiguredDot ok={configured.openai_api_key} label="OpenAI" />
            <ConfiguredDot ok={configured.embedding_api_key} label="Embeddings" />
            <ConfiguredDot ok={configured.abuseipdb_api_key} label="AbuseIPDB" />
            <ConfiguredDot ok={configured.virustotal_api_key} label="VirusTotal" />
            <ConfiguredDot ok={configured.es_api_key} label="ES read-only key" />
          </EuiPanel>
        </EuiFlexItem>

        <EuiFlexItem style={{ minWidth: 320 }}>
          <EuiPanel hasBorder paddingSize="l" style={{ height: '100%' }}>
            <EuiTitle size="xs">
              <h3>Models</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <EuiDescriptionList
              compressed
              type="column"
              listItems={MODEL_ROLES.map((role) => {
                const m = prefs?.[ROLE_PREF_KEY[role]] as ModelConfig | undefined;
                return { title: humanizeToken(role), description: m?.model || '—' };
              })}
            />
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>

      {prefs ? (
        <>
          <EuiSpacer size="l" />
          <EuiPanel hasBorder paddingSize="l">
            <EuiTitle size="xs">
              <h3>Detection</h3>
            </EuiTitle>
            <EuiSpacer size="s" />
            <EuiDescriptionList
              compressed
              type="column"
              listItems={[
                {
                  title: 'Correlation',
                  description: `${humanizeToken(prefs.default_correlation?.mode)} · N=${prefs.default_correlation?.n ?? 5} · ${prefs.default_correlation?.window_seconds ?? 120}s · by ${prefs.default_correlation?.group_by ?? 'ip'}`,
                },
                {
                  title: 'Background scans',
                  description: prefs.background_scan_enabled ? 'Enabled' : 'Disabled',
                },
                {
                  title: 'Auto-forward rules',
                  description: (prefs.auto_forward_allowlist || []).join(', ') || 'None',
                },
                {
                  title: 'Kill switch',
                  description: prefs.caps?.kill_switch ? 'ON' : 'Off',
                },
              ]}
            />
          </EuiPanel>
        </>
      ) : null}

      <EuiSpacer size="l" />
      <EuiCallOut color="success" iconType="check" title="Ready to go" size="s">
        <p>Click “Finish setup” to mark setup complete and open the console.</p>
      </EuiCallOut>
    </div>
  );
};
