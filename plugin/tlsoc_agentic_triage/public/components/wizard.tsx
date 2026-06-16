import React, { useEffect, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiCodeBlock,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiStepsHorizontal,
  EuiText,
  EuiTextArea,
  EuiTitle,
} from '@elastic/eui';
import type { DataViewsPublicPluginStart } from '../../../../src/plugins/data_views/public';
import type { TlsocApi } from '../lib/api';

interface WizardProps {
  api: TlsocApi;
  dataViews: DataViewsPublicPluginStart;
  onComplete: () => void;
}

const ROLE_INSTRUCTIONS = `# Create a READ-ONLY API key scoped to your log indices (Dev Tools):
POST /_security/api_key
{
  "name": "tlsoc-agent-read",
  "role_descriptors": {
    "tlsoc_read": {
      "cluster": [],
      "indices": [
        { "names": ["all-logs-*"], "privileges": ["read", "view_index_metadata"] }
      ]
    }
  }
}

# Create a MANAGEMENT key scoped to tlsoc-agent-* (bookkeeping only):
POST /_security/api_key
{
  "name": "tlsoc-agent-mgmt",
  "role_descriptors": {
    "tlsoc_mgmt": {
      "cluster": ["monitor"],
      "indices": [
        { "names": ["tlsoc-agent-*"], "privileges": ["read","write","create_index","manage"] }
      ]
    }
  }
}`;

export const Wizard: React.FC<WizardProps> = ({ api, dataViews, onComplete }) => {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // step 1
  const [esApiKey, setEsApiKey] = useState('');
  const [esMgmtApiKey, setEsMgmtApiKey] = useState('');

  // step 2
  const [dvOptions, setDvOptions] = useState<Array<{ value: string; text: string; title: string }>>([]);
  const [dataViewPattern, setDataViewPattern] = useState('');

  // step 3
  const [fieldOptions, setFieldOptions] = useState<string[]>([]);
  const [ipField, setIpField] = useState('source.ip');
  const [userField, setUserField] = useState('user.name');
  const [hostField, setHostField] = useState('host.name');

  // step 4
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [investigatorProvider, setInvestigatorProvider] = useState('anthropic');
  const [investigatorModel, setInvestigatorModel] = useState('claude-sonnet-4-6');
  const [routerProvider, setRouterProvider] = useState('anthropic');
  const [routerModel, setRouterModel] = useState('claude-haiku-4-5-20251001');

  // Load data views for step 2 and preload model defaults from settings.
  useEffect(() => {
    (async () => {
      try {
        const ids = await dataViews.getIdsWithTitle();
        setDvOptions(
          ids.map((dv) => ({ value: dv.id || '', text: dv.title, title: dv.title }))
        );
        if (ids.length && !dataViewPattern) {
          setDataViewPattern(ids[0].title);
        }
      } catch {
        /* no data views available */
      }
      try {
        const settings = await api.get<{ prefs: Record<string, any> }>('settings');
        const p = settings.prefs || {};
        if (p.data_view_pattern) setDataViewPattern((cur) => cur || p.data_view_pattern);
        if (p.source_ip_field) setIpField(p.source_ip_field);
        if (p.user_field) setUserField(p.user_field);
        if (p.host_field) setHostField(p.host_field);
        if (p.investigator_model) {
          setInvestigatorProvider(p.investigator_model.provider || 'anthropic');
          setInvestigatorModel(p.investigator_model.model || 'claude-sonnet-4-6');
        }
        if (p.router_model) {
          setRouterProvider(p.router_model.provider || 'anthropic');
          setRouterModel(p.router_model.model || 'claude-haiku-4-5-20251001');
        }
      } catch {
        /* settings unavailable */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load fields when entering step 3, based on selected data view.
  const loadFields = async () => {
    try {
      const match = dvOptions.find((o) => o.title === dataViewPattern);
      if (match && match.value) {
        const dv = await dataViews.get(match.value);
        const names = dv.fields.getAll().map((f) => f.name);
        setFieldOptions(names);
      } else {
        setFieldOptions([]);
      }
    } catch {
      setFieldOptions([]);
    }
  };

  const fieldSelectOptions = (current: string) => {
    const opts = fieldOptions.length
      ? fieldOptions.map((f) => ({ value: f, text: f }))
      : [{ value: current, text: current }];
    if (!fieldOptions.includes(current) && current) {
      opts.unshift({ value: current, text: `${current} (current)` });
    }
    return opts;
  };

  const saveStep1 = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      if (esApiKey.trim()) body.es_api_key = esApiKey.trim();
      if (esMgmtApiKey.trim()) body.es_mgmt_api_key = esMgmtApiKey.trim();
      if (Object.keys(body).length) {
        await api.post('setup/secrets', body);
      }
      setStep(1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveStep2 = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('settings', { data_view_pattern: dataViewPattern });
      await loadFields();
      setStep(2);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveStep3 = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('settings', {
        source_ip_field: ipField,
        user_field: userField,
        host_field: hostField,
      });
      setStep(3);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const secrets: Record<string, string> = {};
      if (openaiKey.trim()) secrets.openai_api_key = openaiKey.trim();
      if (anthropicKey.trim()) secrets.anthropic_api_key = anthropicKey.trim();
      if (Object.keys(secrets).length) {
        await api.post('setup/secrets', secrets);
      }
      await api.put('settings', {
        investigator_model: { provider: investigatorProvider, model: investigatorModel },
        router_model: { provider: routerProvider, model: routerModel },
      });
      await api.post('setup/complete', {});
      onComplete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const steps = [
    { title: 'ES keys', onClick: () => setStep(0), status: (step === 0 ? 'current' : step > 0 ? 'complete' : 'incomplete') as any },
    { title: 'Data scope', onClick: () => setStep(1), status: (step === 1 ? 'current' : step > 1 ? 'complete' : 'incomplete') as any },
    { title: 'Entity mapping', onClick: () => setStep(2), status: (step === 2 ? 'current' : step > 2 ? 'complete' : 'incomplete') as any },
    { title: 'LLM + models', onClick: () => setStep(3), status: (step === 3 ? 'current' : 'incomplete') as any },
  ];

  return (
    <EuiPanel hasBorder paddingSize="l">
      <EuiTitle size="m">
        <h2>TLSOC Agentic Triage — first-time setup</h2>
      </EuiTitle>
      <EuiSpacer size="m" />
      <EuiStepsHorizontal steps={steps} />
      <EuiSpacer size="l" />

      {error ? (
        <>
          <EuiCallOut color="danger" size="s" title={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {step === 0 ? (
        <>
          <EuiTitle size="xs">
            <h3>Step 1 — Elasticsearch keys</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          <EuiText size="s">
            <p>Create two scoped API keys (never the superuser). Run this in Dev Tools:</p>
          </EuiText>
          <EuiSpacer size="s" />
          <EuiCodeBlock language="json" fontSize="s" paddingSize="s" isCopyable>
            {ROLE_INSTRUCTIONS}
          </EuiCodeBlock>
          <EuiSpacer size="m" />
          <EuiFormRow label="ES read-only API key" fullWidth>
            <EuiTextArea
              fullWidth
              rows={2}
              value={esApiKey}
              onChange={(e) => setEsApiKey(e.target.value)}
            />
          </EuiFormRow>
          <EuiFormRow label="ES management API key (tlsoc-agent-*)" fullWidth>
            <EuiTextArea
              fullWidth
              rows={2}
              value={esMgmtApiKey}
              onChange={(e) => setEsMgmtApiKey(e.target.value)}
            />
          </EuiFormRow>
          <EuiSpacer size="m" />
          <EuiButton fill isLoading={busy} onClick={saveStep1}>
            Save &amp; continue
          </EuiButton>
        </>
      ) : null}

      {step === 1 ? (
        <>
          <EuiTitle size="xs">
            <h3>Step 2 — Data scope</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          <EuiFormRow label="Data view (log source)" fullWidth>
            <EuiSelect
              fullWidth
              options={
                dvOptions.length
                  ? dvOptions.map((o) => ({ value: o.title, text: o.text }))
                  : [{ value: '', text: 'No data views found — create one in Kibana first' }]
              }
              value={dataViewPattern}
              onChange={(e) => setDataViewPattern(e.target.value)}
            />
          </EuiFormRow>
          <EuiSpacer size="m" />
          <EuiFlexGroup gutterSize="s">
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty onClick={() => setStep(0)}>Back</EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton fill isLoading={busy} isDisabled={!dataViewPattern} onClick={saveStep2}>
                Save &amp; continue
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <EuiTitle size="xs">
            <h3>Step 3 — Entity field mapping</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          <EuiFormRow label="Source IP field" fullWidth>
            <EuiSelect
              fullWidth
              options={fieldSelectOptions(ipField)}
              value={ipField}
              onChange={(e) => setIpField(e.target.value)}
            />
          </EuiFormRow>
          <EuiFormRow label="User field" fullWidth>
            <EuiSelect
              fullWidth
              options={fieldSelectOptions(userField)}
              value={userField}
              onChange={(e) => setUserField(e.target.value)}
            />
          </EuiFormRow>
          <EuiFormRow label="Host field" fullWidth>
            <EuiSelect
              fullWidth
              options={fieldSelectOptions(hostField)}
              value={hostField}
              onChange={(e) => setHostField(e.target.value)}
            />
          </EuiFormRow>
          <EuiSpacer size="m" />
          <EuiFlexGroup gutterSize="s">
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty onClick={() => setStep(1)}>Back</EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton fill isLoading={busy} onClick={saveStep3}>
                Save &amp; continue
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <EuiTitle size="xs">
            <h3>Step 4 — LLM keys &amp; models</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          <EuiFormRow label="Anthropic API key" fullWidth>
            <EuiFieldText
              fullWidth
              type="password"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
            />
          </EuiFormRow>
          <EuiFormRow label="OpenAI API key" fullWidth>
            <EuiFieldText
              fullWidth
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
            />
          </EuiFormRow>
          <EuiSpacer size="s" />
          <EuiTitle size="xxs">
            <h4>Model per role</h4>
          </EuiTitle>
          <EuiSpacer size="xs" />
          <EuiFlexGroup>
            <EuiFlexItem>
              <EuiFormRow label="Investigator provider">
                <EuiFieldText
                  value={investigatorProvider}
                  onChange={(e) => setInvestigatorProvider(e.target.value)}
                />
              </EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow label="Investigator model">
                <EuiFieldText
                  value={investigatorModel}
                  onChange={(e) => setInvestigatorModel(e.target.value)}
                />
              </EuiFormRow>
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiFlexGroup>
            <EuiFlexItem>
              <EuiFormRow label="Router provider">
                <EuiFieldText value={routerProvider} onChange={(e) => setRouterProvider(e.target.value)} />
              </EuiFormRow>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiFormRow label="Router model">
                <EuiFieldText value={routerModel} onChange={(e) => setRouterModel(e.target.value)} />
              </EuiFormRow>
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="m" />
          <EuiFlexGroup gutterSize="s">
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty onClick={() => setStep(2)}>Back</EuiButtonEmpty>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton fill isLoading={busy} onClick={finish} iconType="check">
                Finish setup
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ) : null}
    </EuiPanel>
  );
};
