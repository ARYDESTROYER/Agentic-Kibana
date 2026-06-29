/**
 * MfaSetupCard — self-service two-factor (TOTP) enrollment + disable (Wave 2 / F3).
 *
 * Enroll flow:
 *   1. "Enable two-factor" → POST /api/auth/mfa/setup (returns secret + otpauth URI +
 *      10 recovery codes, shown ONCE).
 *   2. Render the URI as a scannable QR (<QRCode>, dependency-free) AND always show
 *      the secret + URI as copyable text for manual entry.
 *   3. Show + let the operator copy/download the recovery codes.
 *   4. Enter a 6-digit code → POST /api/auth/mfa/confirm → enabled.
 *
 * Disable flow: enter a current TOTP (or a recovery code) → POST /api/auth/mfa/disable.
 *
 * All values shown here are the user's own enrollment data (trusted), but the secret
 * + recovery codes are sensitive — they are shown only transiently and never persisted
 * client-side beyond the component's state.
 */
import * as React from 'react';
import {
  ShieldCheck,
  ShieldOff,
  Copy,
  Check,
  Download,
  Loader2,
  KeyRound,
  AlertCircle,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import type { MfaSetupResult } from '@/lib/types';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Alert, AlertDescription } from '@/ui/alert';
import { Card, CardContent } from '@/ui/card';
import { Badge } from '@/ui/badge';
import { Separator } from '@/ui/separator';
import { QRCode } from './QRCode';

export interface MfaSetupCardProps {
  /** Whether MFA is currently enabled for the signed-in user. */
  enabled: boolean;
  /** Called after a successful enable/disable so the parent can refresh the session. */
  onChanged?: () => void;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1.5"
      onClick={() => {
        // copyText falls back to execCommand over plain HTTP (no secure context),
        // so this works even when navigator.clipboard is undefined.
        void copyText(text).then((ok) => {
          if (ok) {
            setFailed(false);
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          } else {
            setFailed(true);
            window.setTimeout(() => setFailed(false), 2500);
          }
        });
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {done ? 'Copied' : failed ? 'Copy failed' : label}
    </Button>
  );
}

export function MfaSetupCard({ enabled, onChanged }: MfaSetupCardProps) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Enroll state.
  const [enroll, setEnroll] = React.useState<MfaSetupResult | null>(null);
  const [qrFailed, setQrFailed] = React.useState(false);
  const [confirmCode, setConfirmCode] = React.useState('');
  // Disable state.
  const [disabling, setDisabling] = React.useState(false);
  const [disableCode, setDisableCode] = React.useState('');

  const begin = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setQrFailed(false);
    try {
      const res = await api.auth.mfa.setup();
      setEnroll(res);
      setConfirmCode('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start MFA enrollment.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy || !enroll) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.mfa.confirm(confirmCode.trim());
      setEnroll(null);
      setConfirmCode('');
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not confirm the code.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.mfa.disable(disableCode.trim());
      setDisabling(false);
      setDisableCode('');
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disable MFA.');
    } finally {
      setBusy(false);
    }
  };

  const downloadCodes = () => {
    if (!enroll) return;
    const blob = new Blob(
      [`Agentic SOC — two-factor recovery codes\n\n${enroll.recovery_codes.join('\n')}\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agentic-soc-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardContent className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-primary">
              {enabled ? <ShieldCheck className="h-4.5 w-4.5" aria-hidden /> : <KeyRound className="h-4.5 w-4.5" aria-hidden />}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Two-factor authentication</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Add a time-based one-time code from an authenticator app to your sign-in.
              </p>
            </div>
          </div>
          <Badge variant={enabled ? 'default' : 'outline'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {/* ---- Already enabled: offer disable ------------------------------- */}
        {enabled && !enroll ? (
          disabling ? (
            <form onSubmit={disable} className="space-y-3" noValidate>
              <Label htmlFor="mfa-disable-code">Enter a current code to disable</Label>
              <Input
                id="mfa-disable-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456 or a recovery code"
                value={disableCode}
                onChange={(ev) => setDisableCode(ev.target.value)}
                disabled={busy}
                autoFocus
              />
              <div className="flex gap-2">
                <Button type="submit" variant="destructive" size="sm" disabled={busy || !disableCode.trim()}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldOff aria-hidden />}
                  Disable two-factor
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDisabling(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" size="sm" onClick={() => { setDisabling(true); setError(null); }}>
              <ShieldOff aria-hidden />
              Disable two-factor
            </Button>
          )
        ) : null}

        {/* ---- Not enrolled yet: start ------------------------------------- */}
        {!enabled && !enroll ? (
          <Button size="sm" onClick={begin} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
            Enable two-factor
          </Button>
        ) : null}

        {/* ---- Enrollment in progress: QR + secret + recovery + confirm ----- */}
        {enroll ? (
          <div className="space-y-5">
            <Separator />
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <div className="shrink-0">
                {qrFailed ? (
                  <div className="flex h-[180px] w-[180px] items-center justify-center rounded-md border border-dashed border-border bg-muted/40 p-3 text-center text-xs text-muted-foreground">
                    QR unavailable — enter the secret manually below.
                  </div>
                ) : (
                  <div className="rounded-md border border-border bg-white p-2">
                    <QRCode value={enroll.otpauth_uri} size={180} onError={() => setQrFailed(true)} />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <p className="text-sm font-medium text-foreground">1. Scan with your authenticator app</p>
                  <p className="text-xs text-muted-foreground">
                    Google Authenticator, 1Password, Authy, Microsoft Authenticator, etc. Can&apos;t
                    scan? Enter the secret or URI by hand:
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Secret</Label>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-xs">
                      {enroll.secret}
                    </code>
                    <CopyButton text={enroll.secret} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">otpauth URI</Label>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-[11px]">
                      {enroll.otpauth_uri}
                    </code>
                    <CopyButton text={enroll.otpauth_uri} />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">2. Save your recovery codes</p>
                <div className="flex gap-2">
                  <CopyButton text={enroll.recovery_codes.join('\n')} label="Copy all" />
                  <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={downloadCodes}>
                    <Download className="h-3.5 w-3.5" aria-hidden />
                    Download
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Each code works once if you lose your device. Store them somewhere safe — they
                are shown only now.
              </p>
              <div className="grid grid-cols-2 gap-1.5 font-mono text-xs sm:grid-cols-2">
                {enroll.recovery_codes.map((c) => (
                  <span key={c} className="rounded border border-border bg-card px-2 py-1">{c}</span>
                ))}
              </div>
            </div>

            <form onSubmit={confirm} className="space-y-2" noValidate>
              <Label htmlFor="mfa-confirm-code">3. Enter the 6-digit code to finish</Label>
              <div className="flex gap-2">
                <Input
                  id="mfa-confirm-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="max-w-[160px]"
                  value={confirmCode}
                  onChange={(ev) => setConfirmCode(ev.target.value)}
                  disabled={busy}
                  autoFocus
                />
                <Button type="submit" size="sm" disabled={busy || confirmCode.trim().length < 6}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
                  Verify &amp; enable
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { setEnroll(null); setError(null); }}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default MfaSetupCard;
