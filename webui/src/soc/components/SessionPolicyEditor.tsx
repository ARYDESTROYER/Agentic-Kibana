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
import { LoadingState } from '@/design-system';
import { LoadError } from '@/soc/components/LoadError';

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
  defaultSeconds,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  help: string;
  seconds: number;
  unit: number;
  unitLabel: string;
  /** The safe fallback committed when the field is cleared / non-positive. */
  defaultSeconds: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
}) {
  const asText = React.useCallback(
    (s: number) => String(Math.round((s > 0 ? s : defaultSeconds) / unit)),
    [defaultSeconds, unit],
  );
  // A raw text buffer so the field can be CLEARED and retyped; we only parse/clamp on
  // commit (blur / Enter). A cleared or <=0 value commits the safe default — persisting
  // 0 would immediately idle-out / expire every live session (a lockout footgun).
  const [text, setText] = React.useState(() => asText(seconds));
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => {
    if (!editing) setText(asText(seconds));
  }, [seconds, editing, asText]);

  const commit = (raw: string) => {
    const n = Number(raw);
    const next = Number.isFinite(n) && n > 0 ? Math.round(n * unit) : defaultSeconds;
    setEditing(false);
    setText(asText(next));
    if (next !== seconds) onChange(next);
  };

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
          value={text}
          disabled={disabled}
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setEditing(true);
            setText(e.target.value);
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
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
  /** Use the flat divider-led Settings grammar instead of a nested card. */
  embedded?: boolean;
}

export function SessionPolicyEditor({
  policy: controlledPolicy,
  onChange,
  embedded = false,
}: SessionPolicyEditorProps = {}) {
  const controlled = Boolean(onChange);

  const [localPolicy, setLocalPolicy] = React.useState<SessionPolicy | null>(
    controlled ? { ...DEFAULTS, ...(controlledPolicy ?? {}) } : null,
  );
  const [loading, setLoading] = React.useState(!controlled);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<unknown>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await api.getSettings();
      const p = (s.prefs.session_policy as SessionPolicy | undefined) ?? {};
      setLocalPolicy({ ...DEFAULTS, ...p });
    } catch (error) {
      setLoadError(error);
      setLocalPolicy(null);
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

  if (loading) {
    return (
      <LoadingState
        layout="panel"
        shape="panel"
        label="Loading session policy"
        description="Retrieving the authoritative token and timeout settings."
      />
    );
  }

  if (loadError || !policy) {
    return (
      <LoadError
        error={loadError}
        fallback="The session policy could not be retrieved."
        title="Could not load session policy"
        onRetry={() => void load()}
      />
    );
  }

  return (
    <Card
      variant={embedded ? 'flat' : 'default'}
      className={embedded ? 'rounded-none border-t border-border/70' : undefined}
    >
      <CardContent className={embedded ? 'space-y-5 px-1 pb-5 pt-5' : 'space-y-5 p-5'}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <DurationField
            id="sp-access-ttl"
            label="Access token TTL"
            help="How long an access token is valid before it must be refreshed."
            seconds={policy.access_ttl ?? DEFAULTS.access_ttl}
            unit={60}
            unitLabel="minutes"
            defaultSeconds={DEFAULTS.access_ttl}
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
            defaultSeconds={DEFAULTS.idle_timeout}
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
            defaultSeconds={DEFAULTS.absolute_lifetime}
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
            defaultSeconds={DEFAULTS.sudo_reauth_window}
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
  const Heading = props.embedded ? 'h3' : 'h2';
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Timer className="h-4 w-4 text-muted-foreground" aria-hidden />
        <Heading className="text-sm font-semibold text-foreground">Token &amp; session policy</Heading>
      </div>
      <p className="text-xs text-muted-foreground">
        Control how long sign-ins last and when sensitive actions require re-authentication.
      </p>
      <SessionPolicyEditor {...props} />
    </section>
  );
}

export default SessionPolicyEditor;
