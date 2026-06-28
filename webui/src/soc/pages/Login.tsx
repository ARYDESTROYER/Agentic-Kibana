/**
 * Login — branded sign-in surface for the new SOC console.
 *
 * Rendered only when the backend reports auth `enabled` and the session is not
 * authenticated (the boot logic in App.tsx decides this). On success it calls
 * `onAuthenticated`, which the app uses to re-fetch the session and enter the
 * console. When auth is disabled this component is never mounted, so the no-auth
 * experience is untouched.
 *
 * Data/feature parity with the legacy LoginScreen (src/components/Auth/
 * LoginScreen.tsx): same api.auth.login flow, 401-aware inline errors, busy
 * state, password reset on failure, branding-driven org/product/subtitle/footer/
 * support link. Branding text is operator-set and rendered as PLAIN text only.
 */
import * as React from 'react';
import { Shield, LockKeyhole, User, AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
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
  /** Called after a successful login so the app can re-fetch the session. */
  onAuthenticated: () => void;
}

export default function Login({ onAuthenticated }: LoginProps) {
  const { branding } = useTheme();

  // Fall back to the historical wording / glyph when branding is unset.
  const wordmark = branding.org_name?.trim() || 'Agentic SOC';
  const tagline = branding.product_name?.trim() || 'Triage console';
  const logoUrl = branding.logo_data_url?.trim() || '';
  // Operator-set copy — UNTRUSTED-safe: rendered as plain text only.
  const loginSubtitle = branding.login_subtitle?.trim() || '';
  const footerText = branding.footer_text?.trim() || '';
  const rawSupport = branding.support_url?.trim() || '';
  // Only honor absolute http(s) links so we never render a javascript: URL.
  const supportUrl = /^https?:\/\//i.test(rawSupport) ? rawSupport : '';

  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas p-6">
      {/* Ambient command-center glow backdrop. */}
      <div className="pointer-events-none absolute inset-0 bg-hero-glow" aria-hidden />

      <div className="relative z-10 w-full max-w-sm animate-rise-in">
        {/* Brand mark */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-card shadow-glow">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                className="h-9 w-9 rounded-md object-contain"
              />
            ) : (
              <Shield className="h-7 w-7 text-primary" aria-hidden />
            )}
          </div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            {wordmark}
          </h1>
          <p className="mt-0.5 text-xs uppercase tracking-widest text-muted-foreground">
            {tagline}
          </p>
        </div>

        <Card className="shadow-elev2">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              {loginSubtitle || 'Enter your credentials to access the console.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error ? (
              <Alert variant="destructive" className="mb-4">
                <AlertCircle aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="login-username">Username</Label>
                <div className="relative">
                  <User
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
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
                  <LockKeyhole
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
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

              <Button type="submit" className="w-full" disabled={!canSubmit}>
                {busy ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <LockKeyhole aria-hidden />
                )}
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-5 text-center text-xs text-muted-foreground">
          Audited, cost-metered agentic triage.
        </p>

        {supportUrl ? (
          <div className="mt-2 flex justify-center">
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
          // Operator-set classification/footer banner — plain text only.
          <p className="mt-3 text-center text-xs text-muted-foreground">{footerText}</p>
        ) : null}
      </div>
    </div>
  );
}
