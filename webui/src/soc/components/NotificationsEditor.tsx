/**
 * NotificationsEditor — the "Alerting & Notifications" Settings surface (F5 / Wave 4).
 *
 * Edits the `Preferences.notifications` subtree (master enable, channels, triggers,
 * dedup / rate-limit / digest / default recipients) through the parent's `update`
 * callback (saved with the rest of Settings via PUT /api/settings). Channel SECRETS
 * (SMTP password / API key / sensitive webhook URL / bot token / routing key) are
 * NEVER part of the config — they are pushed immediately and write-only via
 * POST /api/notifications/channels/{id}/secret; the UI only ever shows a configured
 * boolean. A per-channel "Send test" calls POST /api/notifications/test.
 *
 * Security: every value here is operator-entered (trusted); no secrets are displayed.
 * Gated by <Can resource="settings" action="manage"> at the call site.
 */
import * as React from 'react';
import {
  Bell,
  Check,
  Mail,
  MessageSquare,
  Plus,
  Send,
  Slack,
  Trash2,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  EmailPreset,
  NotificationChannel,
  NotificationChannelType,
  NotificationConfig,
  NotificationProviders,
  Preferences,
} from '@/lib/types';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Slider } from '@/ui/slider';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';

import { HelpTip } from './HelpTip';

/* ---------------------------------------------------------------- helpers --- */

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

const CHANNEL_META: Record<
  NotificationChannelType,
  { label: string; icon: LucideIcon; secretLabel: string; secretHelp: string }
> = {
  email: {
    label: 'Email (SMTP)',
    icon: Mail,
    secretLabel: 'SMTP password',
    secretHelp:
      'Your mailbox password or, for Gmail / Yahoo / iCloud, an APP PASSWORD (not your normal password). For SendGrid / Mailjet / Brevo this is the API key.',
  },
  slack: {
    label: 'Slack',
    icon: Slack,
    secretLabel: 'Incoming Webhook URL',
    secretHelp:
      'A Slack Incoming Webhook URL (https://hooks.slack.com/services/...). Stored write-only as a secret.',
  },
  teams: {
    label: 'Microsoft Teams',
    icon: MessageSquare,
    secretLabel: 'Incoming Webhook URL',
    secretHelp: 'A Teams channel Incoming Webhook URL. Stored write-only as a secret.',
  },
  webhook: {
    label: 'Generic webhook',
    icon: Webhook,
    secretLabel: 'Webhook URL (secret)',
    secretHelp:
      'A JSON POST target. Use this secret field for a sensitive URL; a non-sensitive URL can go in the plain URL field below.',
  },
  pagerduty: {
    label: 'PagerDuty',
    icon: Zap,
    secretLabel: 'Routing (integration) key',
    secretHelp: 'A PagerDuty Events API v2 routing key for the target service.',
  },
  telegram: {
    label: 'Telegram',
    icon: Send,
    secretLabel: 'Bot token',
    secretHelp: 'Your Telegram bot token from @BotFather. The chat_id is set below.',
  },
};

const CHANNEL_TYPES: NotificationChannelType[] = [
  'email',
  'slack',
  'teams',
  'webhook',
  'pagerduty',
  'telegram',
];

function channelIcon(type: string): LucideIcon {
  return CHANNEL_META[type as NotificationChannelType]?.icon ?? Bell;
}

function channelLabel(type: string): string {
  return CHANNEL_META[type as NotificationChannelType]?.label ?? type;
}

/** A short, friendly destination string for a channel (no secrets). */
function channelTarget(ch: NotificationChannel): string {
  const cfg = (ch.config || {}) as Record<string, unknown>;
  if (ch.type === 'email') {
    const r = cfg.recipients;
    const list = Array.isArray(r) ? r : typeof r === 'string' ? [r] : [];
    return list.length ? `${list.length} recipient(s)` : 'no recipients';
  }
  if (ch.type === 'telegram') return cfg.chat_id ? `chat ${String(cfg.chat_id)}` : 'no chat_id';
  if (ch.configured_secrets && ch.configured_secrets.length) return 'secret configured';
  if (cfg.url) return 'URL configured';
  return 'not configured';
}

function newChannelId(type: string, existing: NotificationChannel[]): string {
  const base = `${type}-`;
  let n = 1;
  const ids = new Set(existing.map((c) => c.id));
  while (ids.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

/* --------------------------------------------------------------- sub-bits --- */

function FieldRow({
  label,
  help,
  helpLink,
  children,
}: {
  label: string;
  help?: string;
  helpLink?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label>{label}</Label>
        {help ? <HelpTip text={help} link={helpLink} label={`${label} help`} /> : null}
      </div>
      {children}
    </div>
  );
}

function SwitchRow({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {help ? <HelpTip text={help} label={`${label} help`} /> : null}
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/* ----------------------------------------------------------- channel card --- */

function ChannelEditor({
  channel,
  presets,
  onChange,
  onRemove,
}: {
  channel: NotificationChannel;
  presets: EmailPreset[];
  onChange: (next: NotificationChannel) => void;
  onRemove: () => void;
}) {
  const Icon = channelIcon(channel.type);
  const meta = CHANNEL_META[channel.type as NotificationChannelType];
  const cfg = (channel.config || {}) as Record<string, unknown>;
  const setCfg = (patch: Record<string, unknown>) =>
    onChange({ ...channel, config: { ...cfg, ...patch } });

  const [secretDraft, setSecretDraft] = React.useState('');
  const [savingSecret, setSavingSecret] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const configured = Boolean(channel.configured_secrets && channel.configured_secrets.length);

  const recipients: string[] = React.useMemo(() => {
    const r = cfg.recipients;
    if (Array.isArray(r)) return r.map((x) => String(x));
    if (typeof r === 'string') return r.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    return [];
  }, [cfg.recipients]);
  const [recipientDraft, setRecipientDraft] = React.useState('');

  const selectedPreset = presets.find((p) => p.id === (cfg.provider || 'custom'));

  const applyPreset = (providerId: string) => {
    const p = presets.find((x) => x.id === providerId);
    const patch: Record<string, unknown> = { provider: providerId };
    if (p && providerId !== 'custom') {
      patch.host = p.host;
      patch.port = p.port;
      patch.security = p.security;
      if (p.fixed_username) patch.username = p.fixed_username;
    }
    setCfg(patch);
  };

  const saveSecret = async () => {
    const v = secretDraft.trim();
    if (!v) {
      toast.message('Enter a value first.');
      return;
    }
    setSavingSecret(true);
    try {
      const res = await api.notifications.channelSecret(channel.id, v);
      onChange({ ...channel, configured_secrets: res.configured_secrets });
      setSecretDraft('');
      toast.success(`${meta?.secretLabel ?? 'Secret'} saved.`);
    } catch (e) {
      toast.error(errMsg(e, 'Could not save the secret.'));
    } finally {
      setSavingSecret(false);
    }
  };

  const clearSecret = async () => {
    setSavingSecret(true);
    try {
      const res = await api.notifications.channelSecret(channel.id, null);
      onChange({ ...channel, configured_secrets: res.configured_secrets });
      toast.success('Secret cleared.');
    } catch (e) {
      toast.error(errMsg(e, 'Could not clear the secret.'));
    } finally {
      setSavingSecret(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await api.notifications.test(channel.id);
      if (res.ok) toast.success(`Test sent: ${res.detail || 'ok'}`);
      else toast.error(`Test failed: ${res.detail || 'unknown error'}`);
    } catch (e) {
      toast.error(errMsg(e, 'Test send failed.'));
    } finally {
      setTesting(false);
    }
  };

  const addRecipient = () => {
    const v = recipientDraft.trim();
    if (!v || recipients.includes(v)) {
      setRecipientDraft('');
      return;
    }
    setCfg({ recipients: [...recipients, v] });
    setRecipientDraft('');
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent text-primary">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <Input
              value={channel.name || ''}
              placeholder={channelLabel(channel.type)}
              aria-label="Channel name"
              className="h-7 w-48 max-w-full border-transparent bg-transparent px-1 text-sm font-semibold focus-visible:border-input"
              onChange={(e) => onChange({ ...channel, name: e.target.value })}
            />
            <p className="truncate px-1 text-xs text-muted-foreground">
              {channelLabel(channel.type)} · {channelTarget(channel)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={Boolean(channel.enabled)}
            onCheckedChange={(v) => onChange({ ...channel, enabled: v })}
            aria-label="Channel enabled"
          />
          <Button variant="ghost" size="icon" aria-label="Remove channel" onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Email-specific config */}
      {channel.type === 'email' ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldRow
              label="Provider preset"
              help="Pick your email provider to prefill host / port / security. Gmail, Yahoo and iCloud require an app password as the secret below."
            >
              <Select value={String(cfg.provider || 'custom')} onValueChange={applyPreset}>
                <SelectTrigger aria-label="Provider preset">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.id === 'custom' ? 'Custom (SMTP)' : p.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="From address" help="The envelope/From email address sent on the message.">
              <Input
                type="email"
                value={String(cfg.from_addr || '')}
                placeholder="soc-alerts@example.com"
                onChange={(e) => setCfg({ from_addr: e.target.value })}
              />
            </FieldRow>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <FieldRow label="SMTP host">
              <Input
                value={String(cfg.host || '')}
                placeholder={selectedPreset?.host || 'smtp.example.com'}
                disabled={Boolean(cfg.provider && cfg.provider !== 'custom')}
                onChange={(e) => setCfg({ host: e.target.value })}
              />
            </FieldRow>
            <FieldRow label="Port">
              <Input
                type="number"
                value={Number(cfg.port || selectedPreset?.port || 587)}
                disabled={Boolean(cfg.provider && cfg.provider !== 'custom')}
                onChange={(e) => setCfg({ port: Number(e.target.value) })}
              />
            </FieldRow>
            <FieldRow label="Security">
              <Select
                value={String(cfg.security || 'starttls')}
                onValueChange={(v) => setCfg({ security: v })}
              >
                <SelectTrigger aria-label="Security">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starttls">STARTTLS</SelectItem>
                  <SelectItem value="ssl">SSL/TLS</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
          </div>

          <FieldRow
            label="Username"
            help={selectedPreset?.username_hint || 'The SMTP login username.'}
          >
            <Input
              value={String(cfg.username || '')}
              placeholder={selectedPreset?.fixed_username || 'username'}
              disabled={Boolean(selectedPreset?.fixed_username)}
              onChange={(e) => setCfg({ username: e.target.value })}
            />
          </FieldRow>

          {cfg.provider === 'ses' ? (
            <FieldRow label="AWS region" help="The SES region for the SMTP endpoint, e.g. us-east-1.">
              <Input
                value={String(cfg.region || '')}
                placeholder="us-east-1"
                onChange={(e) => setCfg({ region: e.target.value })}
              />
            </FieldRow>
          ) : null}

          {/* recipients */}
          <FieldRow label="Recipients" help="Email addresses that receive alerts from this channel.">
            <Input
              value={recipientDraft}
              placeholder="Type an email and press Enter"
              onChange={(e) => setRecipientDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addRecipient();
                }
              }}
            />
            {recipients.length ? (
              <div className="flex flex-wrap gap-1.5 pt-1.5">
                {recipients.map((r) => (
                  <Badge key={r} variant="outline" className="gap-1 pr-1">
                    <span className="truncate">{r}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${r}`}
                      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                      onClick={() => setCfg({ recipients: recipients.filter((x) => x !== r) })}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : null}
          </FieldRow>
        </div>
      ) : null}

      {/* Telegram chat id */}
      {channel.type === 'telegram' ? (
        <FieldRow label="Chat ID" help="The target Telegram chat/channel id the bot posts to.">
          <Input
            value={String(cfg.chat_id || '')}
            placeholder="123456789"
            onChange={(e) => setCfg({ chat_id: e.target.value })}
          />
        </FieldRow>
      ) : null}

      {/* PagerDuty source name */}
      {channel.type === 'pagerduty' ? (
        <FieldRow label="Source name" help="A label shown as the event source in PagerDuty.">
          <Input
            value={String(cfg.source_name || '')}
            placeholder="tlsoc"
            onChange={(e) => setCfg({ source_name: e.target.value })}
          />
        </FieldRow>
      ) : null}

      {/* Generic webhook non-secret URL */}
      {channel.type === 'webhook' ? (
        <FieldRow
          label="Webhook URL (non-secret)"
          help="A non-sensitive JSON POST target. For a sensitive URL, use the secret field below instead."
        >
          <Input
            value={String(cfg.url || '')}
            placeholder="https://example.com/hooks/soc"
            onChange={(e) => setCfg({ url: e.target.value })}
          />
        </FieldRow>
      ) : null}

      {/* Write-only secret */}
      <Separator />
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Label>{meta?.secretLabel ?? 'Secret'}</Label>
          {meta?.secretHelp ? <HelpTip text={meta.secretHelp} label="Secret help" /> : null}
          {configured ? (
            <Badge variant="success" className="gap-1">
              <Check className="h-3 w-3" aria-hidden />
              Configured
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Not set
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={configured ? '•••••••• (enter a new value to replace)' : 'Enter a value'}
            value={secretDraft}
            onChange={(e) => setSecretDraft(e.target.value)}
          />
          <Button size="sm" variant="outline" disabled={savingSecret} onClick={() => void saveSecret()}>
            {savingSecret ? 'Saving…' : 'Save'}
          </Button>
          {configured ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={savingSecret}
              onClick={() => void clearSecret()}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Write-only — the console only ever knows whether it is configured, never the value.
        </p>
      </div>

      {/* Send test */}
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={testing} onClick={() => void sendTest()}>
          <Send className="h-4 w-4" aria-hidden />
          {testing ? 'Sending…' : 'Send test'}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ add dialog --- */

function AddChannelDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdd: (type: NotificationChannelType) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a channel</DialogTitle>
          <DialogDescription>Pick where these alerts should be delivered.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 py-2">
          {CHANNEL_TYPES.map((t) => {
            const Icon = CHANNEL_META[t].icon;
            return (
              <button
                key={t}
                type="button"
                onClick={() => {
                  onAdd(t);
                  onOpenChange(false);
                }}
                className="flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-3 text-left text-sm font-medium transition-colors hover:border-primary hover:bg-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon className="h-4 w-4 text-primary" aria-hidden />
                {CHANNEL_META[t].label}
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- editor -- */

export interface NotificationsEditorProps {
  prefs: Preferences;
  update: (patch: Partial<Preferences>) => void;
}

export function NotificationsEditor({ prefs, update }: NotificationsEditorProps) {
  const notif: NotificationConfig = prefs.notifications || {};
  const setNotif = (patch: Partial<NotificationConfig>) =>
    update({ notifications: { ...notif, ...patch } });

  const channels = notif.channels || [];
  const triggers = notif.triggers || {};
  const digest = notif.digest || {};

  const [providers, setProviders] = React.useState<NotificationProviders | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [recipientDraft, setRecipientDraft] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    void api.notifications
      .providers()
      .then((p) => {
        if (!cancelled) setProviders(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const presets: EmailPreset[] = providers?.email_presets || [];

  const setChannel = (idx: number, next: NotificationChannel) => {
    const list = channels.slice();
    list[idx] = next;
    setNotif({ channels: list });
  };
  const removeChannel = (idx: number) => {
    setNotif({ channels: channels.filter((_, i) => i !== idx) });
  };
  const addChannel = (type: NotificationChannelType) => {
    const id = newChannelId(type, channels);
    const ch: NotificationChannel = {
      id,
      type,
      enabled: true,
      name: CHANNEL_META[type].label,
      config: type === 'email' ? { provider: 'custom', security: 'starttls', recipients: [] } : {},
      configured_secrets: [],
    };
    setNotif({ channels: [...channels, ch] });
  };

  const defaultRecipients = notif.default_recipients || [];
  const addDefaultRecipient = () => {
    const v = recipientDraft.trim();
    if (!v || defaultRecipients.includes(v)) {
      setRecipientDraft('');
      return;
    }
    setNotif({ default_recipients: [...defaultRecipients, v] });
    setRecipientDraft('');
  };

  const minRisk = typeof triggers.min_risk === 'number' ? triggers.min_risk : 0;
  const setTriggers = (patch: Partial<typeof triggers>) =>
    setNotif({ triggers: { ...triggers, ...patch } });

  return (
    <div className="space-y-6">
      <div className="space-y-1 border-b border-border pb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Alerting &amp; Notifications
          </h2>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Deliver case alerts to email, Slack, Teams, PagerDuty, Telegram, or a generic webhook.
          Notifications fire AFTER the deterministic case decision and never block or change it.
        </p>
      </div>

      <SwitchRow
        label="Notifications enabled"
        help="Master switch. When off, no notifications are ever sent regardless of the channels and triggers below."
        checked={Boolean(notif.enabled)}
        onChange={(v) => setNotif({ enabled: v })}
      />

      <div className={cn('space-y-6', !notif.enabled && 'opacity-60')}>
        {/* Channels */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Channels
            </p>
            <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Add channel
            </Button>
          </div>

          {channels.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-surface px-4 py-6 text-center">
              <Bell className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
              <p className="mt-2 text-sm text-muted-foreground">
                No channels yet. Add one to start receiving alerts.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {channels.map((ch, idx) => (
                <ChannelEditor
                  key={ch.id}
                  channel={ch}
                  presets={presets}
                  onChange={(next) => setChannel(idx, next)}
                  onRemove={() => removeChannel(idx)}
                />
              ))}
            </div>
          )}
        </div>

        <Separator />

        {/* Triggers */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Triggers
            </p>
            <HelpTip text="Which case events fire a notification. NEEDS_HUMAN cases are always held for an analyst; this only governs whether you are notified." />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <SwitchRow
              label="On case created"
              help="Notify when a new case is created (can be noisy on busy stacks)."
              checked={Boolean(triggers.on_case_created)}
              onChange={(v) => setTriggers({ on_case_created: v })}
            />
            <SwitchRow
              label="On escalated"
              checked={Boolean(triggers.on_escalated)}
              onChange={(v) => setTriggers({ on_escalated: v })}
            />
            <SwitchRow
              label="On true positive"
              checked={Boolean(triggers.on_true_positive)}
              onChange={(v) => setTriggers({ on_true_positive: v })}
            />
            <SwitchRow
              label="On needs human"
              checked={Boolean(triggers.on_needs_human)}
              onChange={(v) => setTriggers({ on_needs_human: v })}
            />
            <SwitchRow
              label="On closed / resolved"
              checked={Boolean(triggers.on_closed)}
              onChange={(v) => setTriggers({ on_closed: v })}
            />
          </div>

          <div className="space-y-3 rounded-md border border-border bg-surface px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Label>Minimum risk to notify</Label>
                <HelpTip text="Cases below this normalised risk (0–100) never trigger a notification, even when a trigger matches." />
              </div>
              <span className="text-sm font-semibold tabular-nums text-foreground">{minRisk}</span>
            </div>
            <Slider
              min={0}
              max={100}
              step={1}
              value={[minRisk]}
              onValueChange={(vals) => setTriggers({ min_risk: vals[0] ?? 0 })}
              aria-label="Minimum risk to notify"
            />
          </div>
        </div>

        <Separator />

        {/* Delivery controls */}
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Delivery controls
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow
              label="Dedup window (seconds)"
              help="Suppress duplicate alerts for the same case + trigger within this window."
            >
              <Input
                type="number"
                min={0}
                value={notif.dedup_window_seconds ?? 300}
                onChange={(e) => setNotif({ dedup_window_seconds: Number(e.target.value) })}
              />
            </FieldRow>
            <FieldRow
              label="Rate limit (per hour, per channel)"
              help="Cap the number of notifications a single channel may send each hour. 0 means unlimited."
            >
              <Input
                type="number"
                min={0}
                value={notif.rate_limit_per_hour ?? 60}
                onChange={(e) => setNotif({ rate_limit_per_hour: Number(e.target.value) })}
              />
            </FieldRow>
          </div>

          <SwitchRow
            label="Batch into a digest"
            help="When on, matching events are batched per channel and flushed together on the interval below instead of sent immediately."
            checked={Boolean(digest.enabled)}
            onChange={(v) => setNotif({ digest: { ...digest, enabled: v } })}
          />
          {digest.enabled ? (
            <FieldRow label="Digest interval (minutes)">
              <Input
                type="number"
                min={1}
                value={digest.interval_minutes ?? 60}
                onChange={(e) =>
                  setNotif({ digest: { ...digest, interval_minutes: Number(e.target.value) } })
                }
              />
            </FieldRow>
          ) : null}

          <FieldRow
            label="Default recipients"
            help="Fallback email recipients used by email channels that don't set their own."
          >
            <Input
              value={recipientDraft}
              placeholder="Type an email and press Enter"
              onChange={(e) => setRecipientDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDefaultRecipient();
                }
              }}
            />
            {defaultRecipients.length ? (
              <div className="flex flex-wrap gap-1.5 pt-1.5">
                {defaultRecipients.map((r) => (
                  <Badge key={r} variant="outline" className="gap-1 pr-1">
                    <span className="truncate">{r}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${r}`}
                      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setNotif({ default_recipients: defaultRecipients.filter((x) => x !== r) })
                      }
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : null}
          </FieldRow>

          <FieldRow
            label="Console base URL"
            help="Used to build a clickable case link in the alert body, e.g. https://soc.example.com. Leave blank for no link."
          >
            <Input
              value={notif.base_url || ''}
              placeholder="https://soc.example.com"
              onChange={(e) => setNotif({ base_url: e.target.value })}
            />
          </FieldRow>
        </div>

        {!notif.enabled ? (
          <Alert>
            <Bell className="h-4 w-4" aria-hidden />
            <AlertTitle>Notifications are off</AlertTitle>
            <AlertDescription>
              Turn on the master switch above to start delivering alerts. Channel and trigger edits
              are saved with the rest of Settings; secrets save immediately.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <AddChannelDialog open={addOpen} onOpenChange={setAddOpen} onAdd={addChannel} />
    </div>
  );
}

export default NotificationsEditor;
