/**
 * Step-up re-authentication modal (Round-2 Wave 3).
 *
 * Registers a global gate with the api client (`setReauthHandler`). When ANY API
 * call returns 401 `{code:'reauth_required'}`, the client awaits this gate: the
 * modal opens, the user re-proves their password (and optionally a TOTP / recovery
 * code), and on success the gate resolves `true` so the original request is retried
 * once. Cancelling resolves `false` (the original 401 surfaces).
 *
 * Back-compat: the gate is only registered when `active` (auth enabled). When auth
 * is off, no handler is registered, so the api client never calls it — the no-auth
 * path is untouched. A queue dedupes concurrent gated requests onto ONE prompt.
 */
import * as React from 'react';
import { ShieldQuestion, Loader2 } from 'lucide-react';
import { api, ApiError, setReauthHandler } from '@/lib/api';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Alert, AlertDescription } from '@/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/ui/dialog';

type Resolver = (ok: boolean) => void;

export interface ReauthDialogProps {
  /** Register the gate only when auth is enabled (off → no-op, back-compat). */
  active: boolean;
}

export function ReauthDialog({ active }: ReauthDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Every concurrently-gated request parks its resolver here; the first one opens
  // the modal, the rest ride along and are all settled together on close.
  const waitersRef = React.useRef<Resolver[]>([]);

  const settle = React.useCallback((ok: boolean) => {
    const waiters = waitersRef.current;
    waitersRef.current = [];
    setOpen(false);
    setPassword('');
    setCode('');
    setError(null);
    setBusy(false);
    for (const resolve of waiters) resolve(ok);
  }, []);

  React.useEffect(() => {
    if (!active) {
      setReauthHandler(null);
      return undefined;
    }
    const gate = () =>
      new Promise<boolean>((resolve) => {
        waitersRef.current.push(resolve);
        setOpen(true);
      });
    setReauthHandler(gate);
    return () => setReauthHandler(null);
  }, [active]);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.reauth(password, code.trim() || undefined);
      settle(true);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError && e.message ? e.message : 'Re-authentication failed.');
    }
  };

  // Closing via the overlay / escape / Cancel resolves the gate as cancelled.
  const onOpenChange = (next: boolean) => {
    if (!next) settle(false);
    else setOpen(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldQuestion className="h-5 w-5 text-primary" aria-hidden />
            Confirm it&apos;s you
          </DialogTitle>
          <DialogDescription>
            This action is sensitive. Re-enter your password to continue. Your session
            stays signed in.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="reauth-pass">Password</Label>
            <Input
              id="reauth-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reauth-code">
              Authentication code <span className="text-muted-foreground">(if enabled)</span>
            </Label>
            <Input
              id="reauth-code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              placeholder="123456 or a recovery code"
              disabled={busy}
            />
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settle(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default ReauthDialog;
