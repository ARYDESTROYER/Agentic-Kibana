/**
 * SecretInput — a masked secret field that shows `configured ✓` when the backend
 * already has it, and lets the operator set/replace it. The parent collects typed
 * values and pushes them via POST /api/setup/secrets.
 */
import React from 'react';
import { EuiFieldPassword, EuiFormRow, EuiHealth, EuiText } from '@elastic/eui';
import { COLORS } from '../../lib/theme';

interface SecretInputProps {
  label: string;
  /** The known secret key (es_api_key, anthropic_api_key, …). */
  secretKey: string;
  configured?: boolean;
  value: string;
  onChange: (v: string) => void;
  help?: React.ReactNode;
  placeholder?: string;
}

export const SecretInput: React.FC<SecretInputProps> = ({
  label,
  secretKey,
  configured,
  value,
  onChange,
  help,
  placeholder,
}) => (
  <EuiFormRow
    label={
      <span>
        {label}{' '}
        {configured ? (
          <EuiHealth color={COLORS.success}>
            <EuiText size="xs" component="span">
              configured
            </EuiText>
          </EuiHealth>
        ) : null}
      </span>
    }
    helpText={help}
    fullWidth
  >
    <EuiFieldPassword
      type="dual"
      name={secretKey}
      value={value}
      placeholder={configured ? 'configured — type to replace' : placeholder || ''}
      onChange={(e) => onChange(e.target.value)}
      fullWidth
    />
  </EuiFormRow>
);
