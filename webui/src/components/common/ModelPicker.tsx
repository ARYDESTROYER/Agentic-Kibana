/**
 * ModelPicker — a per-role model selector populated from GET /api/models. Used in
 * the wizard's LLM step and the Settings model section.
 */
import React, { useMemo } from 'react';
import { EuiFlexGroup, EuiFlexItem, EuiFormRow, EuiSelect } from '@elastic/eui';
import type { ModelConfig, ModelsResponse } from '../../lib/types';
import { humanizeToken } from '../../lib/format';

interface ModelPickerProps {
  role: string;
  models: ModelsResponse | null;
  value?: ModelConfig;
  onChange: (next: ModelConfig) => void;
  help?: string;
}

/** Flatten provider→models into select options, tagging the provider. */
function buildOptions(models: ModelsResponse | null): Array<{ value: string; text: string; provider: string }> {
  if (!models) return [];
  const out: Array<{ value: string; text: string; provider: string }> = [];
  for (const [provider, list] of Object.entries(models.providers || {})) {
    for (const m of list) {
      out.push({ value: m, text: `${m}  ·  ${provider}`, provider });
    }
  }
  return out;
}

export const ModelPicker: React.FC<ModelPickerProps> = ({ role, models, value, onChange, help }) => {
  const options = useMemo(() => buildOptions(models), [models]);
  const current = value?.model || '';

  return (
    <EuiFormRow label={`${humanizeToken(role)} model`} helpText={help} fullWidth>
      <EuiFlexGroup gutterSize="none" responsive={false}>
        <EuiFlexItem>
          <EuiSelect
            options={[
              { value: '', text: current ? current : '— select a model —' },
              ...options.map((o) => ({ value: o.value, text: o.text })),
            ]}
            value={current}
            onChange={(e) => {
              const sel = options.find((o) => o.value === e.target.value);
              onChange({
                provider: sel?.provider || value?.provider || 'anthropic',
                model: e.target.value,
                temperature: value?.temperature,
                max_tokens: value?.max_tokens,
              });
            }}
            fullWidth
          />
        </EuiFlexItem>
      </EuiFlexGroup>
    </EuiFormRow>
  );
};
