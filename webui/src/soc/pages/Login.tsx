/**
 * Login — branded sign-in surface for the SOC console, with Wave-1 identity flows.
 *
 * Three modes, decided from GET /api/setup/status (public):
 *   1. FIRST-RUN ("create your admin account") — when `needs_user` is true (auth on,
 *      no users yet): POST /api/setup/init-admin, then sign in.
 *   2. NORMAL sign-in — POST /api/auth/login. If the user `must_change_password`,
 *      transition inline to:
 *   3. SET-A-NEW-PASSWORD — POST /api/auth/change-password before completing.
 *
 * When `seeded_default` is true, a subtle hint surfaces the demo Admin / Admin@123
 * credentials. When auth is disabled this component is never mounted, so the no-auth
 * experience is untouched. All branding text is operator-set → rendered as PLAIN text.
 */
import * as React from 'react';
import {
  Shield,
  LockKeyhole,
  User,
  AlertCircle,
  ExternalLink,
  Loader2,
  UserPlus,
  KeyRound,
  ShieldCheck,
  LogIn,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { LoginResult, SetupStatus, SsoProviderPublic } from '@/lib/types';
import { useTheme } from '@/soc/theme';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/ui/card';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Alert, AlertDescription } from '@/ui/alert';

export interface LoginProps {
  /** Called after a fully-successful login so the app can re-fetch the session. */
  onAuthenticated: () => void;
}

type Mode = 'signin' | 'setup' | 'change' | 'mfa';

export default function Login({ onAuthenticated }: LoginProps) {
  const { branding } = useTheme();

  const wordmark = branding.org_name?.trim() || 'Agentic SOC';
  const tagline = branding.product_name?.trim() || 'Triage console';
  const logoUrl = branding.logo_data_url?.trim() || '';
  const loginSubtitle = branding.login_subtitle?.trim() || '';
  const footerText = branding.footer_text?.trim() || '';
  const rawSupport = branding.support_url?.trim() || '';
  const supportUrl = /^https?:\/\//i.test(rawSupport) ? rawSupport : '';

  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  const [mode, setMode] = React.useState<Mode>('signin');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // MFA phase 2 (Wave 2): the half-auth pending token + the entered code.
  const [pendingToken, setPendingToken] = React.useState('');
  const [mfaCode, setMfaCode] = React.useState('');
  const [useRecovery, setUseRecovery] = React.useState(false);

  // SSO providers (Wave 2): the enabled "Sign in with …" buttons.
  const [ssoProviders, setSsoProviders] = React.useState<SsoProviderPublic[]>([]);
  const [ssoBusy, setSsoBusy] = React.useState<string | null>(null);

  // Detect the first-run OOBE state once on mount.
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const s = await api.setup.status();
        if (!alive) return;
        setStatus(s);
        if (s.needs_user) setMode('setup');
      } catch {
        /* fall back to normal sign-in */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Load the enabled SSO providers (best-effort; empty when SSO is off).
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await api.auth.sso.providers();
        if (alive) setSsoProviders(res.providers ?? []);
      } catch {
        if (alive) setSsoProviders([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Surface an SSO callback error (the backend redirects to /login?sso_error=...).
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const e = params.get('sso_error');
    if (e) {
      setError(`Single sign-on failed: ${e}`);
      // Clean the URL so a refresh doesn't keep showing the error.
      const url = new URL(window.location.href);
      url.searchParams.delete('sso_error');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const startSso = async (providerId: string) => {
    if (ssoBusy) return;
    setSsoBusy(providerId);
    setError(null);
    try {
      const res = await api.auth.sso.authorize(providerId);
      window.location.assign(res.auth_url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start single sign-on.');
      setSsoBusy(null);
    }
  };

  const seededHint = Boolean(status?.seeded_default) && mode === 'signin';

  // --- Mode 1: first-run create admin --------------------------------------- //
  const submitSetup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setup.initAdmin(username.trim(), password);
      // Immediately sign the new admin in.
      await api.auth.login(username.trim(), password);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the admin account.');
      setBusy(false);
    }
  };

  // --- Mode 2: normal sign-in ----------------------------------------------- //
  const submitSignin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res: LoginResult = await api.auth.login(username.trim(), password);
      // Wave 2 (MFA): the password is correct but a second factor is required. The
      // backend returns a short-lived pending token instead of a session.
      if (res.requires_mfa && res.pending_token) {
        setPendingToken(res.pending_token);
        setMfaCode('');
        setUseRecovery(false);
        setMode('mfa');
        setBusy(false);
        return;
      }
      if (res.user?.must_change_password) {
        // Keep the (now-validated) current password; ask for a new one.
        setNewPassword('');
        setConfirm('');
        setMode('change');
        setBusy(false);
        return;
      }
      onAuthenticated();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || `Sign in failed (${err.status}).`);
      } else {
        setError('Could not reach the backend. Please try again.');
      }
      setPassword('');
      setBusy(false);
    }
  };

  // --- Mode (MFA phase 2): exchange the TOTP / recovery code for a session ----- //
  const submitMfa = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res: LoginResult = await api.auth.mfa.verify(pendingToken, mfaCode.trim());
      if (res.user?.must_change_password) {
        // Session minted, but the password is still flagged for change. The verify
        // route set the cookie, so we can change the password with the current one.
        setNewPassword('');
        setConfirm('');
        setMode('change');
        setBusy(false);
        return;
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed. Please try again.');
      setMfaCode('');
      setBusy(false);
    }
  };

  // --- Mode 3: set a new password (forced change) --------------------------- //
  const submitChange = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.auth.changePassword(password, newPassword);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
      setBusy(false);
    }
  };

  const titleByMode: Record<Mode, string> = {
    signin: 'Sign in',
    setup: 'Create your admin account',
    change: 'Set a new password',
    mfa: 'Two-factor authentication',
  };
  const descByMode: Record<Mode, string> = {
    signin: loginSubtitle || 'Enter your credentials to access the console.',
    setup: 'No accounts exist yet. Create the first administrator to get started.',
    change: 'Your password must be changed before you can continue.',
    mfa: useRecovery
      ? 'Enter one of your single-use recovery codes.'
      : 'Enter the 6-digit code from your authenticator app.',
  };

  const ssoLabel = (p: SsoProviderPublic): string => {
    if (p.display_name && p.display_name.trim()) return p.display_name.trim();
    if (p.type === 'google') return 'Google';
    if (p.type === 'microsoft') return 'Microsoft';
    return p.id;
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-6 py-12">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-hero-glow" aria-hidden />

      <div className="relative z-10 w-full max-w-sm animate-rise-in">
        {/* Brand mark */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-card shadow-elev1">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="h-9 w-9 rounded-md object-contain" />
            ) : (
              <Shield className="h-7 w-7 text-primary" aria-hidden />
            )}
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{wordmark}</h1>
          <p className="mt-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {tagline}
          </p>
        </div>

        <Card className="shadow-elev1">
          <CardHeader>
            <CardTitle>{titleByMode[mode]}</CardTitle>
            <CardDescription>{descByMode[mode]}</CardDescription>
          </CardHeader>
          <CardContent>
            {error ? (
              <Alert variant="destructive" className="mb-4">
                <AlertCircle aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {seededHint ? (
              <Alert className="mb-4">
                <KeyRound aria-hidden />
                <AlertDescription>
                  Default sign-in — <span className="font-medium">Admin</span> /{' '}
                  <span className="font-medium">Admin@123</span>
                </AlertDescription>
              </Alert>
            ) : null}

            {/* ---- Mode: create first admin -------------------------------- */}
            {mode === 'setup' ? (
              <form onSubmit={submitSetup} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="setup-username">Admin username</Label>
                  <div className="relative">
                    <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="setup-username"
                      className="pl-9"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      disabled={busy}
                      autoFocus
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setup-password">Password</Label>
                  <Input
                    id="setup-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setup-confirm">Confirm password</Label>
                  <Input
                    id="setup-confirm"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={busy || username.trim().length === 0 || password.length === 0}
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <UserPlus aria-hidden />}
                  {busy ? 'Creating…' : 'Create admin & sign in'}
                </Button>
              </form>
            ) : null}

            {/* ---- Mode: normal sign-in ------------------------------------ */}
            {mode === 'signin' ? (
              <form onSubmit={submitSignin} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="login-username">Username</Label>
                  <div className="relative">
                    <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="login-username"
                      className="pl-9"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      name="username"
                      disabled={busy}
                      autoFocus
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="login-password">Password</Label>
                  <div className="relative">
                    <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="login-password"
                      type="password"
                      className="pl-9"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      name="password"
                      disabled={busy}
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={busy || username.trim().length === 0 || password.length === 0}
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <LockKeyhole aria-hidden />}
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            ) : null}

            {/* ---- SSO: "Sign in with …" (only on the sign-in screen) ------- */}
            {mode === 'signin' && ssoProviders.length > 0 ? (
              <div className="mt-5">
                <div className="relative mb-4 flex items-center">
                  <span className="h-px flex-1 bg-border" aria-hidden />
                  <span className="px-3 text-xs uppercase tracking-wide text-muted-foreground">or</span>
                  <span className="h-px flex-1 bg-border" aria-hidden />
                </div>
                <div className="space-y-2">
                  {ssoProviders.map((p) => (
                    <Button
                      key={p.id}
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => void startSso(p.id)}
                      disabled={Boolean(ssoBusy)}
                    >
                      {ssoBusy === p.id ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <LogIn aria-hidden />
                      )}
                      Sign in with {ssoLabel(p)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* ---- Mode: MFA second factor (TOTP / recovery) --------------- */}
            {mode === 'mfa' ? (
              <form onSubmit={submitMfa} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-code">
                    {useRecovery ? 'Recovery code' : 'Authentication code'}
                  </Label>
                  <div className="relative">
                    <ShieldCheck className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="mfa-code"
                      className="pl-9"
                      inputMode={useRecovery ? 'text' : 'numeric'}
                      autoComplete="one-time-code"
                      placeholder={useRecovery ? 'XXXX-XXXX' : '123456'}
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value)}
                      disabled={busy}
                      autoFocus
                    />
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={busy || mfaCode.trim().length === 0}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
                  {busy ? 'Verifying…' : 'Verify & continue'}
                </Button>
                <div className="flex items-center justify-between text-xs">
                  <button
                    type="button"
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => { setUseRecovery((v) => !v); setMfaCode(''); setError(null); }}
                    disabled={busy}
                  >
                    {useRecovery ? 'Use an authenticator code' : 'Use a recovery code'}
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => {
                      setMode('signin');
                      setMfaCode('');
                      setPendingToken('');
                      setPassword('');
                      setError(null);
                    }}
                    disabled={busy}
                  >
                    Back to sign in
                  </button>
                </div>
              </form>
            ) : null}

            {/* ---- Mode: forced password change ---------------------------- */}
            {mode === 'change' ? (
              <form onSubmit={submitChange} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="change-new">New password</Label>
                  <Input
                    id="change-new"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={busy}
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="change-confirm">Confirm new password</Label>
                  <Input
                    id="change-confirm"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={busy || newPassword.length === 0 || confirm.length === 0}
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
                  {busy ? 'Updating…' : 'Set password & continue'}
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Audited, cost-metered agentic triage.
        </p>

        {supportUrl ? (
          <div className="mt-3 flex justify-center">
            <a
              href={supportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground',
                'transition-colors hover:text-foreground focus-visible:outline-none',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
              )}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              Docs &amp; help
            </a>
          </div>
        ) : null}

        {footerText ? (
          <p className="mt-3 text-center text-xs text-muted-foreground">{footerText}</p>
        ) : null}
      </div>
    </div>
  );
}
