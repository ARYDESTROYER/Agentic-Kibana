/**
 * Step 3 — LLM providers. Keys for Anthropic / OpenAI (masked, → setup/secrets)
 * and per-role model pickers (router/investigator/formatter/standup/chat/overview/
 * embedding) populated from GET /api/models, saved via PUT /api/settings.
 */
import React, { useState } from 'react';
import {
  EuiButton,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { ConfiguredStatus, ModelConfig, ModelsResponse, Preferences } from '../../../lib/types';
import { MODEL_ROLES } from '../../../lib/types';
import { api } from '../../../lib/api';
import { ErrorCallout } from '../../common/ui';
import { SecretInput } from '../../common/SecretInput';
import { ModelPicker } from '../../common/ModelPicker';

interface ProvidersStepProps {
  models: ModelsResponse | null;
  configured: ConfiguredStatus;
  prefs: Preferences;
  onPrefs: (p: Preferences) => void;
  onSecretsSaved: () => Promise<void> | void;
}

const ROLE_HELP: Record<string, string> = {
  router: 'Cheap model that triages each alert before the expensive investigation.',
  investigator: 'Strong model that runs the ReAct investigation and proposes a verdict.',
  formatter: 'Formats the strict verdict JSON; a cheap model is fine.',
  standup: 'Summarises the daily aggregate for the standup.',
  chat: 'Powers the chat / ask-the-SOC experience.',
  overview: 'Single-event AI overview; defaults to the cheap model.',
  embedding: 'Embedding model used for RAG retrieval.',
};

const PREF_KEY: Record<string, keyof Preferences> = {
  router: 'router_model',
  investigator: 'investigator_model',
  formatter: 'formatter_model',
  standup: 'standup_model',
  chat: 'chat_model',
  overview: 'overview_model',
  embedding: 'embedding_model',
};

export const ProvidersStep: React.FC<ProvidersStepProps> = ({
  models,
  configured,
  prefs,
  onPrefs,
  onSecretsSaved,
}) => {
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [embeddingKey, setEmbeddingKey] = useState('');
  const [savingKeys, setSavingKeys] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const saveKeys = async () => {
    setSavingKeys(true);
    setError(null);
    setSavedNote(null);
    try {
      const body: Record<string, string> = {};
      if (anthropicKey) body.anthropic_api_key = anthropicKey;
      if (openaiKey) body.openai_api_key = openaiKey;
      if (embeddingKey) body.embedding_api_key = embeddingKey;
      if (Object.keys(body).length) {
        await api.updateSecrets(body);
        await onSecretsSaved();
        setAnthropicKey('');
        setOpenaiKey('');
        setEmbeddingKey('');
        setSavedNote('Provider keys saved.');
      } else {
        setSavedNote('No new keys entered.');
      }
    } catch (e) {
      setError(e);
    } finally {
      setSavingKeys(false);
    }
  };

  const setRoleModel = (role: string, model: ModelConfig) => {
    onPrefs({ ...prefs, [PREF_KEY[role]]: model });
  };

  const saveModels = async () => {
    setSavingModels(true);
    setError(null);
    setSavedNote(null);
    try {
      const patch: Partial<Preferences> = {};
      for (const role of MODEL_ROLES) {
        const v = prefs[PREF_KEY[role]] as ModelConfig | undefined;
        if (v) (patch as Record<string, unknown>)[PREF_KEY[role]] = v;
      }
      await api.putSettings(patch);
      setSavedNote('Model selections saved.');
    } catch (e) {
      setError(e);
    } finally {
      setSavingModels(false);
    }
  };

  return (
    <div>
      <EuiTitle size="m">
        <h2>LLM providers &amp; models</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      <EuiText color="subdued">
        <p>
          Add at least one provider key (Anthropic or OpenAI) so the agent can reason.
          Keys are stored in the secret store and only ever shown as configured.
        </p>
      </EuiText>

      <EuiSpacer size="l" />

      <EuiPanel hasBorder paddingSize="l">
        <EuiTitle size="xs">
          <h3>Provider keys</h3>
        </EuiTitle>
        <EuiSpacer size="m" />
        <SecretInput
          label="Anthropic API key"
          secretKey="anthropic_api_key"
          configured={configured.anthropic_api_key}
          value={anthropicKey}
          onChange={setAnthropicKey}
          help="Used for Claude models (router/investigator/etc.)."
        />
        <SecretInput
          label="OpenAI API key"
          secretKey="openai_api_key"
          configured={configured.openai_api_key}
          value={openaiKey}
          onChange={setOpenaiKey}
          help="Used for GPT models and (by default) embeddings."
        />
        <SecretInput
          label="Embedding API key (optional)"
          secretKey="embedding_api_key"
          configured={configured.embedding_api_key}
          value={embeddingKey}
          onChange={setEmbeddingKey}
          help="Leave blank to reuse the OpenAI key for RAG embeddings."
        />
        <EuiSpacer size="m" />
        <EuiButton iconType="save" onClick={saveKeys} isLoading={savingKeys}>
          Save provider keys
        </EuiButton>
      </EuiPanel>

      <EuiSpacer size="l" />

      <EuiPanel hasBorder paddingSize="l">
        <EuiTitle size="xs">
          <h3>Per-role models</h3>
        </EuiTitle>
        <EuiText size="xs" color="subdued">
          <p>Choose the model used for each task. Cheaper models for routing, stronger for investigation.</p>
        </EuiText>
        <EuiSpacer size="m" />
        <EuiFlexGroup wrap gutterSize="l">
          {MODEL_ROLES.map((role) => (
            <EuiFlexItem key={role} style={{ minWidth: 320 }}>
              <ModelPicker
                role={role}
                models={models}
                value={prefs[PREF_KEY[role]] as ModelConfig | undefined}
                onChange={(m) => setRoleModel(role, m)}
                help={ROLE_HELP[role]}
              />
            </EuiFlexItem>
          ))}
        </EuiFlexGroup>
        <EuiSpacer size="m" />
        <EuiButton iconType="save" onClick={saveModels} isLoading={savingModels}>
          Save model selections
        </EuiButton>
      </EuiPanel>

      {savedNote ? (
        <>
          <EuiSpacer size="m" />
          <EuiCallOut size="s" color="success" iconType="check" title={savedNote} />
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
