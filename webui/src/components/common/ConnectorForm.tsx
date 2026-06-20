/**
 * ConnectorForm — the reusable, DYNAMIC form that renders a connector's
 * `auth_fields` + `config_fields` into a validated EUI form and returns a
 * `{ config, secrets }` pair on submit.
 *
 * This is the centerpiece of the wizard AND the Sources manager: both compose it
 * so an operator can configure "any SIEM they wish" with zero UI code per
 * connector. Field rendering is driven entirely by the backend's `AuthField`
 * schema:
 *
 *   - type=string|number   → text / number input
 *   - type=password        → masked input; tracked as a SECRET
 *   - type=bool            → switch
 *   - type=select          → single dropdown from `options`
 *   - type=multiselect     → multi-select combo box from `options`
 *   - type=textarea        → multi-line input
 *   - `secret` fields      → never echoed; shown as `configured ✓` when already set
 *
 * Fields are grouped by their `group` (e.g. "Connection", "Field mapping").
 */
import React, { useMemo, useState } from 'react';
import {
  EuiComboBox,
  EuiFieldNumber,
  EuiFieldPassword,
  EuiFieldText,
  EuiFormRow,
  EuiHorizontalRule,
  EuiIcon,
  EuiSelect,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTextArea,
  EuiTitle,
} from '@elastic/eui';
import type { AuthField, ConnectorManifest } from '../../lib/types';
import { COLORS } from '../../lib/theme';

export interface ConnectorFormValue {
  /** Non-secret config values, keyed by field key. */
  config: Record<string, unknown>;
  /** Secret values the operator typed THIS session, keyed by field key. */
  secrets: Record<string, string>;
}

interface ConnectorFormProps {
  manifest: ConnectorManifest;
  /** Current values (config). Secrets are write-only and never pre-filled. */
  value: ConnectorFormValue;
  onChange: (next: ConnectorFormValue) => void;
  /** Secret keys already configured in the backend (shown as `configured ✓`). */
  configuredSecrets?: string[];
  /** Show inline required-field validation. */
  showValidation?: boolean;
}

/** All fields (auth then config) flattened, preserving order. */
function allFields(manifest: ConnectorManifest): AuthField[] {
  return [...(manifest.auth_fields || []), ...(manifest.config_fields || [])];
}

/** Group fields by their `group`, preserving first-seen group order. */
function groupFields(fields: AuthField[]): Array<[string, AuthField[]]> {
  const order: string[] = [];
  const map = new Map<string, AuthField[]>();
  for (const f of fields) {
    const g = f.group || 'Settings';
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(f);
  }
  return order.map((g) => [g, map.get(g)!]);
}

/** Whether a required field is currently unsatisfied (for validation). */
export function missingRequired(
  manifest: ConnectorManifest,
  value: ConnectorFormValue,
  configuredSecrets: string[] = [],
): AuthField[] {
  return allFields(manifest).filter((f) => {
    if (!f.required) return false;
    if (f.secret) {
      // satisfied if typed now OR already configured in the backend
      return !value.secrets[f.key] && !configuredSecrets.includes(f.key);
    }
    const v = value.config[f.key];
    return v === undefined || v === null || v === '';
  });
}

export const ConnectorForm: React.FC<ConnectorFormProps> = ({
  manifest,
  value,
  onChange,
  configuredSecrets = [],
  showValidation = false,
}) => {
  const groups = useMemo(() => groupFields(allFields(manifest)), [manifest]);

  const setConfig = (key: string, v: unknown) =>
    onChange({ ...value, config: { ...value.config, [key]: v } });
  const setSecret = (key: string, v: string) =>
    onChange({ ...value, secrets: { ...value.secrets, [key]: v } });

  const renderField = (f: AuthField) => {
    const id = `cf-${manifest.source_type}-${f.key}`;
    const invalid =
      showValidation &&
      f.required &&
      (f.secret
        ? !value.secrets[f.key] && !configuredSecrets.includes(f.key)
        : value.config[f.key] === undefined ||
          value.config[f.key] === null ||
          value.config[f.key] === '');

    const help = (
      <>
        {f.help}
        {f.secret ? (
          <EuiText size="xs" color="subdued" component="span">
            {f.help ? ' ' : ''}Stored in the secret store; only ever shown as configured.
          </EuiText>
        ) : null}
      </>
    );

    // --- bool → switch (rendered inline, no row label duplication) --- //
    if (f.type === 'bool') {
      const checked =
        value.config[f.key] === undefined
          ? Boolean(f.default)
          : Boolean(value.config[f.key]);
      return (
        <EuiFormRow key={f.key} helpText={f.help || undefined} fullWidth>
          <EuiSwitch
            id={id}
            label={f.label + (f.required ? ' *' : '')}
            checked={checked}
            onChange={(e) => setConfig(f.key, e.target.checked)}
          />
        </EuiFormRow>
      );
    }

    const label = (
      <span>
        {f.label}
        {f.required ? <span style={{ color: COLORS.danger }}> *</span> : null}
        {f.secret && configuredSecrets.includes(f.key) ? (
          <EuiText size="xs" color={COLORS.success} component="span">
            {' '}
            <EuiIcon type="checkInCircleFilled" size="s" /> configured
          </EuiText>
        ) : null}
      </span>
    );

    let control: React.ReactNode;
    switch (f.type) {
      case 'password':
        control = (
          <EuiFieldPassword
            id={id}
            type="dual"
            placeholder={
              configuredSecrets.includes(f.key)
                ? 'configured — type to replace'
                : f.placeholder || ''
            }
            value={value.secrets[f.key] || ''}
            onChange={(e) => setSecret(f.key, e.target.value)}
            isInvalid={invalid}
            fullWidth
          />
        );
        break;
      case 'number':
        control = (
          <EuiFieldNumber
            id={id}
            placeholder={f.placeholder || ''}
            value={
              value.config[f.key] === undefined || value.config[f.key] === null
                ? f.default !== undefined && f.default !== null
                  ? Number(f.default)
                  : ''
                : Number(value.config[f.key])
            }
            onChange={(e) =>
              setConfig(f.key, e.target.value === '' ? '' : Number(e.target.value))
            }
            isInvalid={invalid}
            fullWidth
          />
        );
        break;
      case 'textarea':
        control = (
          <EuiTextArea
            id={id}
            placeholder={f.placeholder || ''}
            value={String(value.config[f.key] ?? f.default ?? '')}
            onChange={(e) => setConfig(f.key, e.target.value)}
            isInvalid={invalid}
            fullWidth
          />
        );
        break;
      case 'select': {
        const options = (f.options || []).map((o) => ({ value: o, text: o }));
        control = (
          <EuiSelect
            id={id}
            options={[{ value: '', text: '— select —' }, ...options]}
            value={String(value.config[f.key] ?? f.default ?? '')}
            onChange={(e) => setConfig(f.key, e.target.value)}
            isInvalid={invalid}
            fullWidth
          />
        );
        break;
      }
      case 'multiselect': {
        const selected = Array.isArray(value.config[f.key])
          ? (value.config[f.key] as string[])
          : Array.isArray(f.default)
            ? (f.default as string[])
            : [];
        control = (
          <EuiComboBox
            id={id}
            placeholder={f.placeholder || 'Select one or more…'}
            options={(f.options || []).map((o) => ({ label: o }))}
            selectedOptions={selected.map((o) => ({ label: o }))}
            onChange={(opts) =>
              setConfig(
                f.key,
                opts.map((o) => o.label),
              )
            }
            isInvalid={invalid}
            fullWidth
          />
        );
        break;
      }
      default:
        control = (
          <EuiFieldText
            id={id}
            placeholder={f.placeholder || ''}
            value={String(value.config[f.key] ?? f.default ?? '')}
            onChange={(e) => setConfig(f.key, e.target.value)}
            isInvalid={invalid}
            fullWidth
          />
        );
    }

    return (
      <EuiFormRow
        key={f.key}
        label={label}
        helpText={help}
        isInvalid={invalid}
        error={invalid ? `${f.label} is required` : undefined}
        fullWidth
      >
        {control as React.ReactElement}
      </EuiFormRow>
    );
  };

  return (
    <div>
      {groups.map(([group, fields], gi) => (
        <div key={group}>
          {gi > 0 ? <EuiHorizontalRule margin="l" /> : null}
          <EuiTitle size="xxs">
            <h4 style={{ color: COLORS.subdued, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {group}
            </h4>
          </EuiTitle>
          <EuiSpacer size="s" />
          {fields.map(renderField)}
        </div>
      ))}
    </div>
  );
};
