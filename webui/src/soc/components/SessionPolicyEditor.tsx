/**
 * Token / session policy editor (Round-2 Wave 3).
 *
 * Admin-only (mount it inside `<Can resource="settings" action="manage">`). Edits
 * `prefs.session_policy` and persists it via the existing settings PUT — no new
 * endpoint. Durations are entered in friendly units (minutes / hours) and stored
 * as SECONDS to match the backend model. Two notify toggles gate the optional
 * new-device / terminate emails.
 *
 * Self-contained: loads its own settings slice and saves independently so it can be
 * dropped onto the Security page now and folded into Settings > Security in W4.
 */
import * as React from 'react';
import { Timer, Save, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import type { SessionPolicy } from '@/lib/types';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Card, CardContent } from '@/ui/card';
import { Skeleton } from '@/ui/skeleton';

/** Generous defaults that match the backend (so nothing expires mid-session). */
const DEFAULTS: Required<
  Pick<
    SessionPolicy,
    'access_ttl' | 'idle_timeout' | 'absolute_lifetime' | 'sudo_reauth_window'
  >
> = {
  access_ttl: 900, // 15m
  idle_timeout: 1800, // 30m
  absolute_lifetime: 43200, // 12h
  sudo_reauth_window: 600, // 10m
};

/** A labelled duration field that edits seconds via a `unit` divisor. */
function DurationField({
  id,
  label,
  help,
  seconds,
  unit,
  unitLabel,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  help: string;
  seconds: number;
  unit: number;
  unitLabel: string;
  onChange: (seconds: number) => void;
  disabled?: boolean;
}) {
  const value = seconds > 0 ? String(Math.round(seconds / unit)) : '';
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={1}
          className="h-9 w-28"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) && n > 0 ? Math.round(n * unit) : 0);
          }}
        />
        <span className="text-xs text-muted-foreground">{unitLabel}</span>
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

export interface SessionPolicyEditorProps {
  /**
   * Controlled value (embedded in Settings). When provided, the editor edits the
   * parent's `prefs.session_policy` via `onChange` and hides its own Save button —
   * Settings owns the single Save. When omitted, the editor self-loads settings and
   * renders its own Save (the standalone /security route).
   */
  policy?: SessionPolicy;
  /** Controlled change handler (embedded mode). */
  onChange?: (next: SessionPolicy) => void;
}

export function SessionPolicyEditor({ policy: controlledPolicy, onChange }: SessionPolicyEditorProps = {}) {
  const controlled = Boolean(onChange);

  const [localPolicy, setLocalPolicy] = React.useState<SessionPolicy | null>(
    controlled ? { ...DEFAULTS, ...(controlledPolicy ?? {}) } : null,
  );
  const [loading, setLoading] = React.useState(!controlled);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getSettings();
      const p = (s.prefs.session_policy as SessionPolicy | undefined) ?? {};
      setLocalPolicy({ ...DEFAULTS, ...p });
    } catch {
      setLocalPolicy({ ...DEFAULTS });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!controlled) void load();
  }, [controlled, load]);

  // In controlled mode, fold the parent's value over the generous defaults so a
  // blank stored policy never expires a live session mid-edit.
  const policy: SessionPolicy | null = controlled
    ? { ...DEFAULTS, ...(controlledPolicy ?? {}) }
    : localPolicy;

  const set = (patch: Partial<SessionPolicy>) => {
    if (controlled) onChange?.({ ...DEFAULTS, ...(controlledPolicy ?? {}), ...patch });
    else setLocalPolicy((prev) => ({ ...(prev ?? {}), ...patch }));
  };

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      await api.putSettings({ session_policy: policy });
      toast.success('Session policy saved.');
    } catch (e) {
      toast.error(e instanceof ApiError && e.message ? e.message : 'Could not save the session policy.');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !policy) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <DurationField
            id="sp-access-ttl"
            label="Access token TTL"
            help="How long an access token is valid before it must be refreshed."
            seconds={policy.access_ttl ?? DEFAULTS.access_ttl}
            unit={60}
            unitLabel="minutes"
            onChange={(v) => set({ access_ttl: v })}
            disabled={saving}
          />
          <DurationField
            id="sp-idle"
            label="Idle timeout"
            help="A session is signed out after this long without activity."
            seconds={policy.idle_timeout ?? DEFAULTS.idle_timeout}
            unit={60}
            unitLabel="minutes"
            onChange={(v) => set({ idle_timeout: v })}
            disabled={saving}
          />
          <DurationField
            id="sp-absolute"
            label="Absolute lifetime"
            help="A hard cap on a session regardless of activity."
            seconds={policy.absolute_lifetime ?? DEFAULTS.absolute_lifetime}
            unit={3600}
            unitLabel="hours"
            onChange={(v) => set({ absolute_lifetime: v })}
            disabled={saving}
          />
          <DurationField
            id="sp-sudo"
            label="Re-auth (sudo) window"
            help="Sensitive actions re-prompt for the password after this long."
            seconds={policy.sudo_reauth_window ?? DEFAULTS.sudo_reauth_window}
            unit={60}
            unitLabel="minutes"
            onChange={(v) => set({ sudo_reauth_window: v })}
            disabled={saving}
          />
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-3">
            <Switch
              id="sp-notify-new-device"
              checked={Boolean(policy.notify_on_new_device)}
              onCheckedChange={(v) => set({ notify_on_new_device: v })}
              disabled={saving}
            />
            <Label htmlFor="sp-notify-new-device" className="text-sm">
              Email users when a session signs in from a new device or location
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id="sp-notify-terminate"
              checked={Boolean(policy.notify_on_terminate)}
              onCheckedChange={(v) => set({ notify_on_terminate: v })}
              disabled={saving}
            />
            <Label htmlFor="sp-notify-terminate" className="text-sm">
              Email users when one of their sessions is terminated
            </Label>
          </div>
        </div>

        {/* In controlled (Settings) mode the parent owns the single Save button. */}
        {!controlled ? (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
              Save session policy
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A titled section wrapper for the Security page. Forwards controlled props. */
export function SessionPolicySection(props: SessionPolicyEditorProps = {}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Timer className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">Token &amp; session policy</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Control how long sign-ins last and when sensitive actions require re-authentication.
      </p>
      <SessionPolicyEditor {...props} />
    </section>
  );
}

export default SessionPolicyEditor;
