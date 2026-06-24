/**
 * Login screen — only ever rendered when the backend reports auth `enabled` and
 * the session is not authenticated. A centered EuiPanel card carrying the app
 * brand mark, a username + password form, inline 401 errors and a loading state.
 *
 * On success it calls `onAuthenticated`, which the app uses to re-fetch
 * `auth.me()` and enter the console. When auth is disabled this component is
 * never mounted, so the no-auth experience is completely untouched.
 */
import React, { useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFieldPassword,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiForm,
  EuiFormRow,
  EuiIcon,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { api, ApiError } from '../../lib/api';
import { useBranding } from '../../lib/branding';

interface LoginScreenProps {
  /** Called after a successful login so the app can re-fetch the session. */
  onAuthenticated: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onAuthenticated }) => {
  const { branding } = useBranding();
  // Fall back to the historical wording / glyph when branding is unset, so the
  // no-branding login is byte-identical to today.
  const wordmark = branding.org_name?.trim() || 'Agentic SOC';
  const tagline = branding.product_name?.trim() || 'Triage console';
  const logoUrl = branding.logo_data_url?.trim() || '';
  // Operator-set copy (UNTRUSTED-safe: rendered as plain text only).
  const loginSubtitle = branding.login_subtitle?.trim() || '';
  const footerText = branding.footer_text?.trim() || '';
  const rawSupport = branding.support_url?.trim() || '';
  const supportUrl = /^https?:\/\//i.test(rawSupport) ? rawSupport : '';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.login(username.trim(), password);
      onAuthenticated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(err.message || 'Invalid username or password.');
      } else if (err instanceof ApiError) {
        setError(err.message || `Sign in failed (${err.status}).`);
      } else {
        setError('Could not reach the backend. Please try again.');
      }
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{ width: 380, maxWidth: '100%' }}>
        <div className="socBrandAccent" style={{ borderRadius: 3 }} />
        <EuiSpacer size="l" />

        <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false} justifyContent="center">
          <EuiFlexItem grow={false}>
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                style={{ width: 30, height: 30, borderRadius: 8, objectFit: 'contain' }}
              />
            ) : (
              <span className="socLogo">
                <EuiIcon type="securityApp" size="m" />
              </span>
            )}
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <div style={{ lineHeight: 1.15 }}>
              <EuiTitle size="s">
                <h1 style={{ margin: 0 }}>{wordmark}</h1>
              </EuiTitle>
              <EuiText size="xs" color="subdued">
                <span>{tagline}</span>
              </EuiText>
            </div>
          </EuiFlexItem>
        </EuiFlexGroup>

        <EuiSpacer size="l" />

        <EuiPanel hasBorder paddingSize="l">
          <EuiTitle size="xs">
            <h2>Sign in</h2>
          </EuiTitle>
          <EuiText size="xs" color="subdued">
            <p style={{ marginTop: 4 }}>
              {loginSubtitle || 'Enter your credentials to access the console.'}
            </p>
          </EuiText>

          <EuiSpacer size="m" />

          {error ? (
            <>
              <EuiCallOut size="s" color="danger" iconType="alert" title={error} />
              <EuiSpacer size="m" />
            </>
          ) : null}

          <EuiForm component="form" onSubmit={submit}>
            <EuiFormRow label="Username" fullWidth>
              <EuiFieldText
                icon="user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                name="username"
                disabled={busy}
                autoFocus
                fullWidth
              />
            </EuiFormRow>
            <EuiFormRow label="Password" fullWidth>
              <EuiFieldPassword
                type="dual"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                name="password"
                disabled={busy}
                fullWidth
              />
            </EuiFormRow>

            <EuiSpacer size="l" />

            <EuiButton
              type="submit"
              fill
              fullWidth
              iconType="lockOpen"
              isLoading={busy}
              isDisabled={!canSubmit}
            >
              Sign in
            </EuiButton>
          </EuiForm>
        </EuiPanel>

        <EuiSpacer size="m" />
        <EuiText size="xs" color="subdued" textAlign="center">
          <span>Audited, cost-metered agentic triage.</span>
        </EuiText>

        {supportUrl ? (
          <EuiFlexGroup justifyContent="center" responsive={false} gutterSize="none">
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty
                size="xs"
                iconType="documentation"
                href={supportUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Docs &amp; help
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
        ) : null}

        {footerText ? (
          <>
            <EuiSpacer size="s" />
            {/* Operator-set classification/footer banner — plain text only. */}
            <EuiText size="xs" color="subdued" textAlign="center">
              <span>{footerText}</span>
            </EuiText>
          </>
        ) : null}
      </div>
    </div>
  );
};
