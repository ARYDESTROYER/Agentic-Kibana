/**
 * Login — branded sign-in surface for the SOC console, with Wave-1/2 identity flows.
 *
 * FOUR modes, decided from GET /api/setup/status (public) + the login response:
 *   1. FIRST-RUN ("create your admin account") — `needs_user` true (auth on, no
 *      users yet): POST /api/setup/init-admin, then sign in.            (`setup`)
 *   2. NORMAL sign-in — POST /api/auth/login.                           (`signin`)
 *   3. TWO-FACTOR — when the password is correct but MFA is required, exchange the
 *      pending token at /api/auth/mfa/verify.                           (`mfa`)
 *   4. SET-A-NEW-PASSWORD — when `must_change_password`.                (`change`)
 *
 * Round-2 Wave 2 restyle: a 2-column split (brand hero + form) on lg+, collapsing
 * to a single column with a compact brand header below. The submit handlers and
 * the mode state machine are UNCHANGED — only the presentation and a few UX
 * niceties (password-strength meter, segmented OTP, per-provider SSO icons) are new.
 *
 * When `seeded_default` is true, a subtle hint surfaces the demo Admin / Admin@123
 * credentials. When auth is disabled this component is never mounted, so the
 * no-auth experience is untouched. All branding text is operator-set → rendered as
 * PLAIN text (#9).
 *
 * a11y — WCAG 2.2 §3.3.8 Accessible Authentication (Round-5 W0-E): every credential
 * field carries the correct `autocomplete` for password-manager autofill —
 * `username`, `current-password`, `new-password`, and `one-time-code` for the MFA /
 * recovery-code inputs — and NONE of them block paste (no `onPaste` interception),
 * so a manager can paste secrets and no cognitive-function test is imposed.
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
  IdCard,
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
import {
  asLoginIllustration,
  asLoginLayout,
  BrandHero,
  OtpInput,
  PasswordStrengthMeter,
  SsoBrandIcon,
} from '@/soc/components/auth/loginParts';
import { setupAccount, type LoginBranding } from '@/soc/components/auth/login.api';
import { MfaSetupCard } from '@/soc/components/MfaSetupCard';

export interface LoginProps {
  /** Called after a fully-successful login so the app can re-fetch the session. */
  onAuthenticated: () => void;
}

// `setup` is the OOBE create-first-admin flow; `mfa-enroll` is the optional
// prompted MFA step shown AFTER the admin account is created (never forced).
type Mode = 'signin' | 'setup' | 'change' | 'mfa' | 'mfa-enroll';

// The OOBE password policy MIRRORS the server-side gate in routes_setup.py
// (min length + not equal to the username + not a trivially-common password) so the
// button-disable + inline hint match what the backend will accept. This is a UX
// nicety; the server remains authoritative (#9 — never client-trusted).
const OOBE_MIN_PASSWORD_LEN = 12;
const OOBE_COMMON_PASSWORDS = new Set(
  [
    'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
    '123456', '12345678', '123456789', '1234567890', '111111', '000000',
    'qwerty', 'qwerty123', 'qwertyuiop', 'abc123', 'abc12345', 'a1b2c3d4',
    'letmein', 'welcome', 'welcome1', 'welcome123', 'admin', 'admin123',
    'administrator', 'root', 'toor', 'changeme', 'changeme1', 'changeme123',
    'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
    'trustno1', 'master', 'superman', 'starwars', 'whatever', 'secret',
    'default', 'temp1234', 'test1234', 'passw0rd1', 'adminadmin', 'rootroot',
    'soc12345678', 'tlsoc123456', 'admin@123', 'admin12345678',
  ].map((p) => p.toLowerCase()),
);

/** The client mirror of the server strong-password policy — reason string or null. */
function oobePasswordPolicyError(password: string, username: string): string | null {
  const pw = password || '';
  if (pw.length < OOBE_MIN_PASSWORD_LEN) {
    return `Password must be at least ${OOBE_MIN_PASSWORD_LEN} characters.`;
  }
  if (pw.trim().toLowerCase() === (username || '').trim().toLowerCase()) {
    return 'Password must not be the same as the username.';
  }
  if (OOBE_COMMON_PASSWORDS.has(pw.trim().toLowerCase())) {
    return 'That password is too common — choose a less predictable one.';
  }
  return null;
}

export default function Login({ onAuthenticated }: LoginProps) {
  const { branding: brandingBase } = useTheme();
  // Read the additive Round-4 login white-label fields structurally (they are not in
  // the shared `Branding` interface yet; see login.api.ts). All are operator-set →
  // rendered as PLAIN text / mapped to CODE-defined layouts (#6/#9).
  const branding = brandingBase as LoginBranding;

  const wordmark = branding.org_name?.trim() || 'Agentic SOC';
  const tagline = branding.product_name?.trim() || 'Triage console';
  const logoUrl = branding.logo_data_url?.trim() || '';
  const loginSubtitle = branding.login_subtitle?.trim() || '';
  const footerText = branding.footer_text?.trim() || '';
  const rawSupport = branding.support_url?.trim() || '';
  const supportUrl = /^https?:\/\//i.test(rawSupport) ? rawSupport : '';

  // Login white-label (bounded plain-text copy + curated enum layout/illustration).
  const loginHeadline = branding.login_headline?.trim() || '';
  const loginBody = branding.login_body?.trim() || '';
  const loginChips = Array.isArray(branding.login_chips)
    ? branding.login_chips.map((c) => String(c)).filter((c) => c.trim().length > 0)
    : [];
  const loginLayout = asLoginLayout(branding.login_layout);
  const loginIllustration = asLoginIllustration(branding.login_illustration);

  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  // Whether the initial setup-status probe has settled (resolved OR failed). Gates
  // the first paint so a first-run install doesn't flash 'signin' before 'setup'.
  const [statusResolved, setStatusResolved] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>('signin');
  const [username, setUsername] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
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
      } finally {
        if (alive) setStatusResolved(true);
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

  // --- Mode 1: first-run create admin (OOBE account-setup) ------------------ //
  // Round-4 Wave-5: the OOBE step now calls POST /api/setup/account (the force-set,
  // strong-password writer that REPLACES init-admin) with a client-mirrored policy
  // gate, then signs the new admin in and — when the server prompts — offers an
  // OPTIONAL (never forced) MFA-enrollment step before continuing.
  const submitSetup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const uname = username.trim();
    const policyErr = oobePasswordPolicyError(password, uname);
    if (policyErr) {
      setError(policyErr);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await setupAccount(uname, password, displayName);
      // The account writer does NOT mint a session — sign the new admin in now.
      await api.auth.login(uname, password);
      if (res.mfa_prompt) {
        // Offer (prompted-optional) two-factor enrollment before entering the console.
        setMode('mfa-enroll');
        setBusy(false);
        return;
      }
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
    'mfa-enroll': 'Secure your account',
  };
  const descByMode: Record<Mode, string> = {
    signin: loginSubtitle || 'Enter your credentials to access the console.',
    setup:
      'No accounts exist yet. Create the first administrator to get started — pick a strong, unique password.',
    change: 'Your password must be changed before you can continue.',
    mfa: useRecovery
      ? 'Enter one of your single-use recovery codes.'
      : 'Enter the 6-digit code from your authenticator app.',
    'mfa-enroll':
      'Optional but recommended: add a second factor now. You can skip and set it up later.',
  };

  // OOBE submit guard — mirror the server policy so the button reflects acceptance.
  const setupPolicyError = React.useMemo(
    () => oobePasswordPolicyError(password, username.trim()),
    [password, username],
  );
  const canSubmitSetup =
    !busy &&
    username.trim().length > 0 &&
    password.length > 0 &&
    confirm.length > 0 &&
    setupPolicyError === null &&
    password === confirm;

  const ssoLabel = (p: SsoProviderPublic): string => {
    if (p.display_name && p.display_name.trim()) return p.display_name.trim();
    if (p.type === 'google') return 'Google';
    if (p.type === 'microsoft') return 'Microsoft';
    return p.id;
  };

  // The brand hero copy/backdrop, shared across every layout (split hero panel,
  // full-bleed hero, centered backdrop band). Every text field is operator-set →
  // rendered as plain text by BrandHero (#6/#9).
  const heroProps = {
    wordmark,
    tagline,
    logoUrl,
    headline: loginHeadline,
    body: loginBody,
    chips: loginChips,
    subtitle: loginSubtitle,
    footerText,
    illustration: loginIllustration,
  };

  // The form CARD + support/footer. In the 'full' layout the form floats over the
  // ALWAYS-DARK brand hero (which itself carries the wordmark/tagline/footer), so the
  // peripheral brand/help copy must NOT use theme tokens tuned for a card/canvas
  // surface — in light theme they'd be dark-on-dark (fails WCAG-AA). We hide the
  // (duplicated) compact header there and render the remaining copy on-dark.
  const onDarkHero = loginLayout === 'full';
  const formInner = (
    <div className="relative z-10 w-full max-w-sm animate-rise-in">
      {/* Compact brand header — hidden on lg for 'split' (the side hero carries it),
          hidden entirely for 'full' (the full-bleed hero carries the wordmark),
          shown for 'centered' (the backdrop band carries no copy). */}
      <div
        className={cn(
          'mb-8 flex flex-col items-center text-center',
          loginLayout === 'split' && 'lg:hidden',
          onDarkHero && 'hidden',
        )}
      >
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-card shadow-elev1">
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

          <Card className="shadow-elev2">
            <CardHeader>
              <CardTitle className="text-lg">{titleByMode[mode]}</CardTitle>
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

              {/* ---- Mode: create first admin (OOBE account-setup) ----------- */}
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
                        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                        autoFocus
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-display">
                      Display name <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <div className="relative">
                      <IdCard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <Input
                        id="setup-display"
                        className="pl-9"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        autoComplete="name"
                        placeholder="e.g. Alex Morgan"
                        disabled={busy}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-password">Password</Label>
                    <div className="relative">
                      <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <Input
                        id="setup-password"
                        type="password"
                        className="pl-9"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                        aria-describedby="setup-password-help"
                        disabled={busy}
                      />
                    </div>
                    <PasswordStrengthMeter password={password} className="pt-0.5" />
                    {/* Policy hint mirrors the server gate (min 12, ≠ username, not common). */}
                    <p
                      id="setup-password-help"
                      className={cn(
                        'text-xs',
                        password && setupPolicyError ? 'text-critical' : 'text-muted-foreground',
                      )}
                    >
                      {password && setupPolicyError
                        ? setupPolicyError
                        : `Use at least ${OOBE_MIN_PASSWORD_LEN} characters — not your username or a common password.`}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-confirm">Confirm password</Label>
                    <div className="relative">
                      <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <Input
                        id="setup-confirm"
                        type="password"
                        className="pl-9"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        autoComplete="new-password"
                        disabled={busy}
                      />
                    </div>
                    {confirm && password !== confirm ? (
                      <p className="text-xs text-critical">Passwords do not match.</p>
                    ) : null}
                  </div>
                  <Button type="submit" className="w-full" disabled={!canSubmitSetup}>
                    {busy ? <Loader2 className="animate-spin" aria-hidden /> : <UserPlus aria-hidden />}
                    {busy ? 'Creating…' : 'Create admin & sign in'}
                  </Button>
                </form>
              ) : null}

              {/* ---- Mode: OPTIONAL MFA enrollment after account creation ---- */}
              {mode === 'mfa-enroll' ? (
                <div className="space-y-4">
                  {/* frameless: the outer login Card already supplies the frame +
                      the "Secure your account" heading — avoid a card-in-card. */}
                  <MfaSetupCard enabled={false} frameless onChanged={onAuthenticated} />
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={onAuthenticated}
                  >
                    Skip for now &amp; continue
                  </Button>
                </div>
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
                        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
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
                    <span className="px-3 text-xs uppercase tracking-wide text-muted-foreground">
                      or continue with
                    </span>
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
                          <SsoBrandIcon type={p.type} />
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
                  <div className="space-y-2">
                    {/* htmlFor only in the recovery branch (id="mfa-code" is the text
                        Input there). In the OTP branch the control is the segmented
                        OtpInput group, which carries its own aria-label — a htmlFor
                        pointing at a non-existent id would be a dead association. */}
                    <Label htmlFor={useRecovery ? 'mfa-code' : undefined}>
                      {useRecovery ? 'Recovery code' : 'Authentication code'}
                    </Label>
                    {useRecovery ? (
                      <div className="relative">
                        <ShieldCheck className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <Input
                          id="mfa-code"
                          className="pl-9 font-mono tracking-wider"
                          inputMode="text"
                          autoComplete="one-time-code"
                          placeholder="XXXX-XXXX"
                          value={mfaCode}
                          onChange={(e) => setMfaCode(e.target.value)}
                          disabled={busy}
                          /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                          autoFocus
                        />
                      </div>
                    ) : (
                      <OtpInput
                        value={mfaCode}
                        onChange={setMfaCode}
                        disabled={busy}
                        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                        autoFocus
                        aria-label="Authentication code"
                      />
                    )}
                  </div>
                  <Button type="submit" className="w-full" disabled={busy || mfaCode.trim().length === 0}>
                    {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
                    {busy ? 'Verifying…' : 'Verify & continue'}
                  </Button>
                  <div className="flex items-center justify-between text-xs">
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => { setUseRecovery((v) => !v); setMfaCode(''); setError(null); }}
                      disabled={busy}
                    >
                      {useRecovery ? 'Use an authenticator code' : 'Use a recovery code'}
                    </Button>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
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
                    </Button>
                  </div>
                </form>
              ) : null}

              {/* ---- Mode: forced password change ---------------------------- */}
              {mode === 'change' ? (
                <form onSubmit={submitChange} className="space-y-4" noValidate>
                  <div className="space-y-1.5">
                    <Label htmlFor="change-new">New password</Label>
                    <div className="relative">
                      <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <Input
                        id="change-new"
                        type="password"
                        className="pl-9"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        autoComplete="new-password"
                        disabled={busy}
                        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                        autoFocus
                      />
                    </div>
                    <PasswordStrengthMeter password={newPassword} className="pt-0.5" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="change-confirm">Confirm new password</Label>
                    <div className="relative">
                      <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <Input
                        id="change-confirm"
                        type="password"
                        className="pl-9"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        autoComplete="new-password"
                        disabled={busy}
                      />
                    </div>
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

          <p
            className={cn(
              'mt-6 text-center text-xs',
              onDarkHero ? 'text-white/60' : 'text-muted-foreground',
            )}
          >
            Audited, cost-metered agentic triage.
          </p>

          {supportUrl ? (
            <div className="mt-3 flex justify-center">
              <a
                href={supportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
                  'transition-colors focus-visible:outline-none',
                  onDarkHero
                    ? 'text-white/70 hover:text-white focus-visible:ring-offset-transparent'
                    : 'text-muted-foreground hover:text-foreground focus-visible:ring-offset-canvas',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                )}
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                Docs &amp; help
              </a>
            </div>
          ) : null}

        {/* Footer line — shown near the form only when NO hero carries it: always for
            'centered', and below lg for 'split' (the side hero carries it on lg+).
            'full' shows it inside the hero, so suppress it here. */}
        {footerText && loginLayout !== 'full' ? (
          <p
            className={cn(
              'mt-3 text-center text-xs text-muted-foreground',
              loginLayout === 'split' && 'lg:hidden',
            )}
          >
            {footerText}
          </p>
        ) : null}
    </div>
  );

  // Hold first paint until the setup-status probe settles, so a first-run install
  // never flashes the sign-in form before switching to the create-admin form. A
  // failed probe still flips statusResolved (→ we fall back to the sign-in form).
  if (!statusResolved) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-canvas text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <span className="sr-only">Loading sign-in…</span>
      </div>
    );
  }

  // ---- Layout shells ------------------------------------------------------ //
  // 'centered': a single centred column over a decorative backdrop band (no copy).
  if (loginLayout === 'centered') {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-6 py-12">
        <BrandHero {...heroProps} variant="backdrop" />
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-canvas/60 to-canvas"
          aria-hidden
        />
        {formInner}
      </div>
    );
  }

  // 'full': a full-bleed brand hero with the form floating over it (top-right on lg+).
  if (loginLayout === 'full') {
    return (
      <div className="relative min-h-screen overflow-hidden bg-canvas">
        <BrandHero {...heroProps} variant="full" />
        <div className="pointer-events-none absolute inset-0 bg-black/30" aria-hidden />
        <div className="relative z-10 flex min-h-screen items-center justify-center px-6 py-12 lg:justify-end lg:pr-[8vw]">
          {formInner}
        </div>
      </div>
    );
  }

  // 'split' (default): the brand hero panel (lg+) beside the form column.
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <BrandHero {...heroProps} variant="panel" />
      <div className="relative flex items-center justify-center overflow-hidden bg-canvas px-6 py-12">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-hero-glow lg:hidden"
          aria-hidden
        />
        {formInner}
      </div>
    </div>
  );
}
