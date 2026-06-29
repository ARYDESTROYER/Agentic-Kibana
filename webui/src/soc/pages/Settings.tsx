/**
 * Settings — the full Preferences, sectioned (NEW Tailwind/token UI).
 *
 * Mirrors the legacy Settings/SettingsPage data wiring: GET /api/settings loads
 * `prefs` + `configured` + `read_only`; edits are buffered locally and saved with
 * PUT /api/settings (the non-editable `sources`/`setup_complete` are stripped from
 * the patch). Dirty-tracking compares the editable draft to the last saved
 * snapshot. Secret keys are write-only and pushed separately via
 * POST /api/setup/secrets (`api.updateSecrets`); the console only ever sees
 * whether a key is configured (boolean), never a value. Per-role models come from
 * GET /api/models. The Branding section embeds the new <BrandingEditor>. A
 * "Re-run setup wizard" action is exposed via the `onRerunWizard` prop.
 *
 * Security: every preference value here is operator-entered (trusted); the only
 * displayed externally-derived values are model ids (plain text). No secrets are
 * shown.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Bell,
  Brush,
  Check,
  Database,
  FileText,
  Globe,
  Hash,
  Info,
  KeyRound,
  Library,
  Lock,
  MonitorSmartphone,
  Network,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserCircle2,
  Users as UsersIcon,
  Wand2,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  AutomationRule,
  ConfiguredStatus,
  ModelConfig,
  ModelsResponse,
  Playbook,
  Preferences,
  ThreatContextConfig,
  ThresholdAutomationConfig,
} from '@/lib/types';
import { MODEL_ROLES } from '@/lib/types';
import { humanizeToken, toPercentValue } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Slider } from '@/ui/slider';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';
import { Card, CardContent } from '@/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { BrandingEditor } from '@/soc/components/BrandingEditor';
import { NotificationsEditor } from '@/soc/components/NotificationsEditor';
import { Can } from '@/soc/components/Can';
import { HelpTip } from '@/soc/components/HelpTip';
import { useNavigate } from '@/soc/router';
import { useAuth } from '@/soc/auth';

// Round-2 Wave 4 — Settings IA consolidation. These page bodies are embedded here as
// Settings sub-sections (the standalone routes stay live during cutover). Account &
// Sessions live under the Account (Personal) group; Users / Admin sessions / the org
// Security & SSO + token policy live under the Administration group (perm-gated).
import { AccountInner } from '@/soc/pages/Account';
import { SessionsInner } from '@/soc/pages/Sessions';
import { UsersInner } from '@/soc/pages/Users';
import { AdminSessionsInner } from '@/soc/pages/AdminSessions';
import { SecurityMfaInner, SecuritySsoInner } from '@/soc/pages/Security';

/* --------------------------------------------------------------- sections --- */

type SectionId =
  // Personal account (no perm → every signed-in user)
  | 'profile'
  | 'account_security'
  | 'sessions'
  // Configuration / triage / integrations / administration
  | 'general'
  | 'models'
  | 'keys'
  | 'detection'
  | 'cases'
  | 'automation'
  | 'standup'
  | 'notifications'
  | 'security'
  | 'admin_users'
  | 'admin_sessions'
  | 'knowledge'
  | 'enrichment'
  | 'appearance'
  | 'advanced';

interface SectionMeta {
  id: SectionId;
  name: string;
  /** Short one-liner shown in search + as a subtitle. */
  blurb: string;
  icon: LucideIcon;
  /** When set, the section is gated by this `resource:action` grant. */
  perm?: { resource: string; action: string };
  /** Extra keywords so search finds a section by the settings it contains. */
  keywords?: string[];
}

interface SectionGroup {
  id: string;
  label: string;
  sections: SectionMeta[];
}

const SECTION_GROUPS: SectionGroup[] = [
  {
    id: 'account',
    label: 'My account',
    sections: [
      {
        // No perm → every signed-in user edits their OWN profile. In the auth-off /
        // rbac-off default, hasPermission() is true so this still shows (back-compat).
        id: 'profile',
        name: 'Profile',
        blurb: 'Your display name, avatar, secondary email, timezone, and language.',
        icon: UserCircle2,
        keywords: ['profile', 'account', 'display name', 'avatar', 'photo', 'email', 'timezone', 'locale', 'language'],
      },
      {
        // No perm → self-service MFA enrollment for every signed-in user.
        id: 'account_security',
        name: 'Security & two-factor',
        blurb: 'Enroll TOTP two-factor authentication for your own account.',
        icon: ShieldCheck,
        keywords: ['security', 'mfa', '2fa', 'two factor', 'totp', 'authenticator', 'password'],
      },
      {
        // No perm → the backend scopes the session list to the caller.
        id: 'sessions',
        name: 'Sessions & activity',
        blurb: 'Where you are signed in, and your recent account activity.',
        icon: MonitorSmartphone,
        keywords: ['sessions', 'devices', 'activity', 'sign out', 'revoke', 'login history'],
      },
    ],
  },
  {
    id: 'configuration',
    label: 'Configuration',
    sections: [
      {
        id: 'general',
        name: 'General & data scope',
        blurb: 'Index pattern, entity fields, severity threshold, and polling.',
        icon: Database,
        keywords: ['data view', 'index', 'fields', 'polling', 'poll', 'lookback', 'timestamp', 'severity'],
      },
      {
        id: 'models',
        name: 'Models & LLM',
        blurb: 'The model used for each agent role.',
        icon: Sparkles,
        keywords: ['llm', 'model', 'router', 'investigator', 'formatter', 'chat', 'embedding', 'anthropic', 'openai'],
      },
      {
        id: 'keys',
        name: 'Secret keys',
        blurb: 'Write-only API keys for Elasticsearch, LLMs, and enrichment.',
        icon: KeyRound,
        keywords: ['api key', 'secret', 'credentials', 'anthropic', 'openai', 'abuseipdb', 'virustotal'],
      },
    ],
  },
  {
    id: 'triage',
    label: 'Triage logic',
    sections: [
      {
        id: 'detection',
        name: 'Detection & correlation',
        blurb: 'Clustering, risk weights, escalation, auto-close, and cross-source correlation.',
        icon: Workflow,
        keywords: ['correlation', 'risk', 'weights', 'escalation', 'auto-close', 'autonomy', 'false positive', 'cross-source', 'entity'],
      },
      {
        id: 'cases',
        name: 'Cases',
        blurb: 'Human-facing case-ID nomenclature and live preview.',
        icon: Hash,
        perm: { resource: 'settings', action: 'manage' },
        keywords: ['case id', 'case number', 'nomenclature', 'sequence', 'prefix', 'template'],
      },
      {
        id: 'automation',
        name: 'Automation',
        blurb: 'Threshold rules that react to a case after the deterministic decision.',
        icon: Zap,
        perm: { resource: 'settings', action: 'manage' },
        keywords: ['automation', 'rules', 'threshold', 'tag', 'notify', 'playbook', 'proposal'],
      },
      {
        id: 'standup',
        name: 'Standup',
        blurb: 'The daily aggregate summary window and cadence.',
        icon: FileText,
        keywords: ['standup', 'summary', 'digest', 'aggregate', 'report'],
      },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations & context',
    sections: [
      {
        id: 'notifications',
        name: 'Alerting & notifications',
        blurb: 'Outbound channels, triggers, dedup, and digests.',
        icon: Bell,
        perm: { resource: 'settings', action: 'manage' },
        keywords: ['alerting', 'notifications', 'email', 'slack', 'teams', 'webhook', 'pagerduty', 'telegram', 'channels'],
      },
      {
        id: 'enrichment',
        name: 'Enrichment',
        blurb: 'Threat-intel lookups (AbuseIPDB / VirusTotal / GeoIP), cached in Redis.',
        icon: Globe,
        keywords: ['enrichment', 'abuseipdb', 'virustotal', 'geoip', 'reputation', 'cache', 'ttl'],
      },
      {
        id: 'knowledge',
        name: 'Knowledge & threat context',
        blurb: 'RAG retrieval, the threat-context panel, MITRE, and runbooks/playbooks.',
        icon: ShieldAlert,
        perm: { resource: 'settings', action: 'manage' },
        keywords: ['rag', 'retrieval', 'knowledge', 'threat context', 'mitre', 'runbook', 'playbook', 'ioc', 'resolved cases'],
      },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    sections: [
      {
        // Users & roles — admin-only (was the standalone /users page).
        id: 'admin_users',
        name: 'Users & roles',
        blurb: 'Add accounts, assign roles, reset passwords, and enable/disable users.',
        icon: UsersIcon,
        perm: { resource: 'users', action: 'manage' },
        keywords: ['users', 'roles', 'rbac', 'accounts', 'permissions', 'add user', 'reset password', 'admin'],
      },
      {
        // Org Security & SSO + token/session policy — admin-only (was the admin half
        // of the standalone /security page). The self-service MFA lives under My
        // account › Security & two-factor.
        id: 'security',
        name: 'Security & SSO',
        blurb: 'Single sign-on (OIDC) providers and the token / session policy.',
        icon: ShieldCheck,
        perm: { resource: 'settings', action: 'manage' },
        keywords: ['security', 'sso', 'oidc', 'single sign-on', 'google', 'microsoft', 'session policy', 'token', 'idle', 'access ttl', 'csrf', 'rate limit'],
      },
      {
        // All-users session console — admin-only (was the standalone /admin_sessions).
        id: 'admin_sessions',
        name: 'Active sessions',
        blurb: 'Review and force-terminate sessions across all accounts.',
        icon: Network,
        perm: { resource: 'users', action: 'manage' },
        keywords: ['sessions', 'active sessions', 'terminate', 'revoke', 'force sign out', 'admin'],
      },
      {
        id: 'appearance',
        name: 'Appearance & branding',
        blurb: 'Org wordmark, logo, accent colours, and default theme.',
        icon: Brush,
        perm: { resource: 'settings', action: 'manage' },
        keywords: ['branding', 'appearance', 'theme', 'logo', 'favicon', 'colour', 'color', 'white-label', 'accent'],
      },
      {
        id: 'advanced',
        name: 'Advanced',
        blurb: 'Caps, kill switch, suppression rules, rule catalog, and the settings lock.',
        icon: SlidersHorizontal,
        perm: { resource: 'settings', action: 'manage' },
        keywords: ['advanced', 'caps', 'kill switch', 'suppression', 'rule catalog', 'read-only', 'lock', 'budget', 'allowlist'],
      },
    ],
  },
];

const ALL_SECTIONS: SectionMeta[] = SECTION_GROUPS.flatMap((g) => g.sections);

function isSectionId(v: string): v is SectionId {
  return ALL_SECTIONS.some((s) => s.id === v);
}

const ROLE_PREF_KEY: Record<string, keyof Preferences> = {
  router: 'router_model',
  investigator: 'investigator_model',
  formatter: 'formatter_model',
  standup: 'standup_model',
  chat: 'chat_model',
  overview: 'overview_model',
  embedding: 'embedding_model',
};

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/* --------------------------------------------------------- small form bits -- */

type SecProps = { prefs: Preferences; update: (p: Partial<Preferences>) => void };

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="space-y-1 border-b border-border pb-4">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
      {sub ? <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/** A subsection heading used to group related controls inside one Settings section. */
function SubHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function TextPref({
  label,
  value,
  help,
  placeholder,
  onChange,
}: {
  label: string;
  value?: string;
  help?: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function NumPref({
  label,
  value,
  help,
  step,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value?: number;
  help?: string;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={value ?? 0}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function SwitchPref({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:border-border/80">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {help ? <p className="text-xs leading-relaxed text-muted-foreground">{help}</p> : null}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  );
}

/* ----------------------------------------------------------- model picker --- */

function ModelPicker({
  role,
  models,
  value,
  onChange,
}: {
  role: string;
  models: ModelsResponse | null;
  value?: ModelConfig;
  onChange: (next: ModelConfig) => void;
}) {
  const options = React.useMemo(() => {
    const out: Array<{ value: string; label: string; provider: string }> = [];
    for (const [provider, list] of Object.entries(models?.providers || {})) {
      for (const m of list) out.push({ value: m, label: `${m} · ${provider}`, provider });
    }
    return out;
  }, [models]);

  const current = value?.model || '';
  // If the current model isn't in the option list, surface it as a standalone item
  // so the Select shows the real value rather than the placeholder.
  const hasCurrent = !current || options.some((o) => o.value === current);

  return (
    <div className="space-y-1.5">
      <Label>{humanizeToken(role)} model</Label>
      <Select
        value={current || undefined}
        onValueChange={(v) => {
          const sel = options.find((o) => o.value === v);
          onChange({
            provider: sel?.provider || value?.provider || 'anthropic',
            model: v,
            temperature: value?.temperature,
            max_tokens: value?.max_tokens,
          });
        }}
      >
        <SelectTrigger aria-label={`${humanizeToken(role)} model`}>
          <SelectValue placeholder="— select a model —" />
        </SelectTrigger>
        <SelectContent>
          {!hasCurrent ? (
            <SelectItem value={current}>{current}</SelectItem>
          ) : null}
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No models available — add an LLM key.
            </div>
          ) : (
            options.map((o) => (
              <SelectItem key={`${o.provider}:${o.value}`} value={o.value}>
                {o.label}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

/* ------------------------------------------------------------- secret row --- */

function SecretInput({
  label,
  secretKey,
  configured,
  value,
  help,
  onChange,
}: {
  label: string;
  secretKey: string;
  configured?: boolean;
  value: string;
  help?: string;
  onChange: (v: string) => void;
}) {
  const id = React.useId();
  void secretKey;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
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
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        placeholder={configured ? '•••••••• (enter a new value to replace)' : 'Enter a value'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------- sub-sections - */

function GeneralSection({ prefs, update, onNavigate }: SecProps & { onNavigate?: (p: any, opts?: any) => void }) {
  return (
    <div className="space-y-8">
      <SectionTitle title="General & data scope" sub="The index pattern, the fields the agent maps entities from, and how the durable poller pulls new events." />

      <div className="space-y-4">
        <SubHeader title="Data sources">
          <HelpTip text="Connect and manage SIEM/EDR/queue sources (Elasticsearch, OpenSearch, Wazuh, push receivers) on the dedicated Sources page." />
        </SubHeader>
        <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Add, edit, and test-connect log sources, and browse a source&apos;s logs.
          </p>
          {onNavigate ? (
            <Button variant="outline" size="sm" onClick={() => onNavigate('sources')}>
              <Database className="h-4 w-4" aria-hidden />
              Open Sources
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Default log scope & field mapping">
          <HelpTip text="The fallback index pattern and field mapping used when a source does not override them." />
        </SubHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextPref label="Log index pattern" value={prefs.data_view_pattern} onChange={(v) => update({ data_view_pattern: v })} />
          <TextPref label="Timestamp field" value={prefs.time_field} onChange={(v) => update({ time_field: v })} />
          <TextPref label="Source IP field" value={prefs.source_ip_field} onChange={(v) => update({ source_ip_field: v })} />
          <TextPref label="User field" value={prefs.user_field} onChange={(v) => update({ user_field: v })} />
          <TextPref label="Host field" value={prefs.host_field} onChange={(v) => update({ host_field: v })} />
          <TextPref label="Rule / module field" value={prefs.rule_field} onChange={(v) => update({ rule_field: v })} />
          <TextPref label="Rule name field" value={prefs.rule_name_field} onChange={(v) => update({ rule_name_field: v })} />
          <TextPref label="Severity field" value={prefs.severity_field} onChange={(v) => update({ severity_field: v })} />
          <NumPref label="Severity threshold" value={prefs.severity_threshold} step={0.5} onChange={(v) => update({ severity_threshold: v })} />
          <TextPref
            label="Investigate lookback"
            value={prefs.investigate_lookback}
            help='Starting window for manual entity investigation, e.g. "now-24h".'
            onChange={(v) => update({ investigate_lookback: v })}
          />
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Polling">
          <HelpTip text="The background poller pulls new events on a durable cursor (no skip, no dup). Off by default in some deployments." />
        </SubHeader>
        <SwitchPref
          label="Polling enabled"
          checked={Boolean(prefs.polling_enabled)}
          onChange={(v) => update({ polling_enabled: v })}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <NumPref label="Poll interval (seconds)" value={prefs.poll_interval_seconds} onChange={(v) => update({ poll_interval_seconds: v })} />
          <NumPref label="Poll batch size" value={prefs.poll_batch_size} onChange={(v) => update({ poll_batch_size: v })} />
          <NumPref label="Cold-start lookback (minutes)" value={prefs.cold_start_lookback_minutes} onChange={(v) => update({ cold_start_lookback_minutes: v })} />
        </div>
      </div>
    </div>
  );
}

function ModelsSection({ prefs, update, models }: SecProps & { models: ModelsResponse | null }) {
  return (
    <div className="space-y-6">
      <SectionTitle title="Per-role models" sub="The model used for each task." />
      {!models ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Model catalog unavailable</AlertTitle>
          <AlertDescription>
            Could not load the available models. Add an LLM key under Secret keys, then refresh.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {MODEL_ROLES.map((role) => (
          <ModelPicker
            key={role}
            role={role}
            models={models}
            value={prefs[ROLE_PREF_KEY[role]] as ModelConfig | undefined}
            onChange={(m) => update({ [ROLE_PREF_KEY[role]]: m } as Partial<Preferences>)}
          />
        ))}
      </div>
    </div>
  );
}

const SECRET_KEYS: Array<{ key: string; label: string; help: string }> = [
  { key: 'es_api_key', label: 'Elasticsearch read-only API key', help: 'Scoped, read-only key for the log indices.' },
  { key: 'es_mgmt_api_key', label: 'Elasticsearch management API key', help: 'Scoped to tlsoc-agent-* bookkeeping indices.' },
  { key: 'anthropic_api_key', label: 'Anthropic API key', help: 'For Claude models.' },
  { key: 'openai_api_key', label: 'OpenAI API key', help: 'For GPT models / embeddings.' },
  { key: 'embedding_api_key', label: 'Embedding API key', help: 'Defaults to the OpenAI key when blank.' },
  { key: 'abuseipdb_api_key', label: 'AbuseIPDB API key', help: 'IP reputation enrichment (optional).' },
  { key: 'virustotal_api_key', label: 'VirusTotal API key', help: 'File/URL/IP reputation (optional).' },
];

function KeysSection({
  configured,
  draft,
  setDraft,
  onSave,
  saving,
  readOnly,
}: {
  configured: ConfiguredStatus;
  draft: Record<string, string>;
  setDraft: (d: Record<string, string>) => void;
  onSave: () => void;
  saving: boolean;
  readOnly: boolean;
}) {
  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v });
  const pending = Object.values(draft).some((v) => v && v.trim().length > 0);
  return (
    <div className="space-y-6">
      <SectionTitle
        title="Secret keys"
        sub="Write-only. The console only ever sees whether a key is configured."
      />
      <Alert>
        <ShieldCheck className="h-4 w-4" aria-hidden />
        <AlertDescription>
          Existing values are never displayed. Enter a value to replace a key; leave a field blank
          to keep the current one.
        </AlertDescription>
      </Alert>
      <div className="grid gap-4 sm:grid-cols-2">
        {SECRET_KEYS.map((k) => (
          <SecretInput
            key={k.key}
            label={k.label}
            secretKey={k.key}
            configured={configured[k.key]}
            value={draft[k.key] || ''}
            help={k.help}
            onChange={(v) => set(k.key, v)}
          />
        ))}
      </div>
      <Button onClick={onSave} disabled={saving || readOnly || !pending}>
        <Save className="h-4 w-4" aria-hidden />
        {saving ? 'Updating…' : 'Update keys'}
      </Button>
    </div>
  );
}

function DetectionSection({ prefs, update }: SecProps) {
  const corr = prefs.default_correlation || {};
  const weights = prefs.risk_weights || {};
  return (
    <div className="space-y-8">
      <SectionTitle
        title="Detection & correlation"
        sub="How alerts cluster into cases, how risk is scored, when a case escalates, and when (if ever) the agent may auto-close a confident false positive."
      />

      <div className="space-y-4">
        <SubHeader title="Correlation">
          <HelpTip text="Alerts that share an entity within the window cluster into one case. The cluster signature keeps cases idempotent (no dups)." />
        </SubHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumPref label="Threshold (N)" value={corr.n} onChange={(v) => update({ default_correlation: { ...corr, n: v } })} />
          <NumPref label="Window (seconds)" value={corr.window_seconds} onChange={(v) => update({ default_correlation: { ...corr, window_seconds: v } })} />
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Risk weights">
          <HelpTip text="The deterministic risk model's weights. Values are auto-normalised to a 0–100 score; the model never sees raw logs." />
        </SubHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          {(['volume', 'velocity', 'reputation', 'diversity', 'asset_criticality'] as const).map((k) => (
            <NumPref
              key={k}
              label={humanizeToken(k)}
              value={weights[k]}
              step={0.05}
              onChange={(v) => update({ risk_weights: { ...weights, [k]: v } })}
            />
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Escalation">
          <HelpTip text="The confidence below which a case is escalated for a human, and the severity considered critical." />
        </SubHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumPref label="Escalation confidence" value={prefs.escalation_confidence} step={0.05} onChange={(v) => update({ escalation_confidence: v })} />
          <NumPref label="Critical severity" value={prefs.critical_severity} step={0.5} onChange={(v) => update({ critical_severity: v })} />
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Auto-close policy">
          <HelpTip text="The close/escalate decision is always made by deterministic code against this policy — never by raw model output. NEEDS_HUMAN never auto-closes." />
        </SubHeader>
        <AutonomyControls prefs={prefs} update={update} />
      </div>

      <div className="space-y-4">
        <SubHeader title="Cross-source correlation">
          <HelpTip text="An opt-in second pass that links related open cases across sources sharing an entity. Surfaces RELATED cases — never force-merges." />
        </SubHeader>
        <CrossSourceSubsection prefs={prefs} update={update} />
      </div>
    </div>
  );
}

function CrossSourceSubsection({ prefs, update }: SecProps) {
  const x = prefs.cross_source_correlation || {};
  const set = (patch: Partial<typeof x>) =>
    update({ cross_source_correlation: { ...x, ...patch } });
  const entityKeys = Array.isArray(x.entity_keys)
    ? x.entity_keys
    : ['ip', 'host', 'user', 'file_hash', 'domain'];
  const enabled = x.enabled ?? false;
  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Cross-source correlation
        <span className="ml-2 font-normal normal-case tracking-normal">
          opt-in; links related cases across sources, never merges them
        </span>
      </p>
      <SwitchPref
        label="Enable cross-source correlation"
        help="A second, source-agnostic pass groups open cases that share an entity (IP, host, user, file hash, domain) within the time window across multiple sources. Matches are surfaced as RELATED cases — the per-cluster 1:1 case mapping is never changed and nothing is force-merged. Off by default."
        checked={enabled}
        onChange={(v) => set({ enabled: v })}
      />
      <div className={cn('grid gap-4 sm:grid-cols-2', !enabled && 'opacity-60')}>
        <NumPref
          label="Time window (seconds)"
          value={x.time_window_seconds ?? 300}
          min={1}
          disabled={!enabled}
          onChange={(v) => set({ time_window_seconds: v })}
        />
        <NumPref
          label="Minimum distinct sources"
          value={x.min_sources ?? 2}
          min={2}
          disabled={!enabled}
          onChange={(v) => set({ min_sources: v })}
        />
      </div>
      <TextPref
        label="Entity keys"
        help="Comma-separated entity keys to correlate on across sources (e.g. ip, host, user, file_hash, domain)."
        value={entityKeys.join(', ')}
        placeholder="ip, host, user, file_hash, domain"
        onChange={(v) =>
          set({
            entity_keys: v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      />
    </div>
  );
}

function EnrichmentSection({ prefs, update }: SecProps) {
  const e = prefs.enrichment || {};
  const set = (patch: Partial<typeof e>) => update({ enrichment: { ...e, ...patch } });
  return (
    <div className="space-y-6">
      <SectionTitle title="Enrichment" sub="Threat-intel lookups (cached in Redis)." />
      <div className="space-y-2">
        <SwitchPref label="Enrichment enabled" checked={e.enabled ?? true} onChange={(v) => set({ enabled: v })} />
        <SwitchPref label="Use AbuseIPDB" checked={e.use_abuseipdb ?? true} onChange={(v) => set({ use_abuseipdb: v })} />
        <SwitchPref label="Use VirusTotal" checked={e.use_virustotal ?? true} onChange={(v) => set({ use_virustotal: v })} />
        <SwitchPref label="Use GeoIP" checked={e.use_geoip ?? true} onChange={(v) => set({ use_geoip: v })} />
      </div>
      <NumPref label="Cache TTL (seconds)" value={e.cache_ttl_seconds} onChange={(v) => set({ cache_ttl_seconds: v })} />
    </div>
  );
}

function RagControls({ prefs, update }: SecProps) {
  const r = prefs.rag || {};
  const set = (patch: Partial<typeof r>) => update({ rag: { ...r, ...patch } });
  return (
    <div className="space-y-4">
      <SwitchPref label="RAG enabled" checked={r.enabled ?? true} onChange={(v) => set({ enabled: v })} />
      <div className={cn('grid gap-4 sm:grid-cols-2', !(r.enabled ?? true) && 'opacity-60')}>
        <NumPref label="Top K" value={r.top_k} disabled={!(r.enabled ?? true)} onChange={(v) => set({ top_k: v })} />
        <NumPref label="Minimum score" value={r.min_score} step={0.05} disabled={!(r.enabled ?? true)} onChange={(v) => set({ min_score: v })} />
      </div>
      <div className={cn('space-y-2', !(r.enabled ?? true) && 'opacity-60')}>
        <SwitchPref label="Use runbooks" checked={r.use_runbooks ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_runbooks: v })} />
        <SwitchPref label="Use MITRE" checked={r.use_mitre ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_mitre: v })} />
        <SwitchPref label="Use resolved cases" checked={r.use_resolved_cases ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_resolved_cases: v })} />
        <SwitchPref label="Use threat intel" checked={r.use_threat_context ?? true} disabled={!(r.enabled ?? true)} onChange={(v) => set({ use_threat_context: v })} />
      </div>
    </div>
  );
}

function StandupSection({ prefs, update }: SecProps) {
  const s = prefs.standup || {};
  const set = (patch: Partial<typeof s>) => update({ standup: { ...s, ...patch } });
  return (
    <div className="space-y-6">
      <SectionTitle title="Standup" sub="Daily aggregate summary." />
      <SwitchPref label="Standup enabled" checked={s.enabled ?? true} onChange={(v) => set({ enabled: v })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <NumPref label="Window (hours)" value={s.window_hours} onChange={(v) => set({ window_hours: v })} />
        <NumPref label="Interval (seconds)" value={s.interval_seconds} onChange={(v) => set({ interval_seconds: v })} />
      </div>
    </div>
  );
}

function AutonomyControls({ prefs, update }: SecProps) {
  const fp = prefs.fp_auto_close || {};
  const set = (patch: Partial<typeof fp>) => update({ fp_auto_close: { ...fp, ...patch } });
  const minConfPct = toPercentValue(fp.min_confidence ?? 0.8);
  return (
    <div className="space-y-6">
      <Alert>
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>NEEDS_HUMAN never auto-closes</AlertTitle>
        <AlertDescription>
          A case the agent routes to{' '}
          <strong className="font-semibold text-foreground">NEEDS_HUMAN</strong> is always held for
          an analyst — this is code-enforced and cannot be tuned here.{' '}
          <strong className="font-semibold text-foreground">TRUE_POSITIVE</strong> auto-close is a
          separate opt-in and is off by default. This panel only governs confident{' '}
          <strong className="font-semibold text-foreground">FALSE_POSITIVE</strong> auto-close.
        </AlertDescription>
      </Alert>

      <SwitchPref
        label="Auto-close confident false positives"
        help="When on, a FALSE_POSITIVE verdict that clears BOTH bars below is closed automatically (and audited). When off, every case is held for a human."
        checked={Boolean(fp.enabled)}
        onChange={(v) => set({ enabled: v })}
      />

      <div
        className={cn(
          'space-y-3 rounded-md border border-border bg-surface px-4 py-4 transition-opacity',
          !fp.enabled && 'opacity-60',
        )}
      >
        <div className="flex items-center justify-between">
          <Label>Minimum confidence to auto-close</Label>
          <span className="text-sm font-semibold tabular-nums text-foreground">{minConfPct}%</span>
        </div>
        <Slider
          min={0}
          max={100}
          step={1}
          value={[minConfPct]}
          disabled={!fp.enabled}
          onValueChange={(vals) => set({ min_confidence: (vals[0] ?? 0) / 100 })}
          aria-label="Minimum confidence to auto-close"
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          The agent's verdict confidence must be at or above this bar.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumPref
          label="Maximum risk score to auto-close"
          help="Cases scoring above this normalised risk (0–100) are never auto-closed, even as a false positive."
          value={fp.max_risk_score ?? 30}
          min={0}
          max={100}
          disabled={!fp.enabled}
          onChange={(v) => set({ max_risk_score: v })}
        />
        <NumPref
          label="Objection window (minutes)"
          help="Optional grace period before an auto-close takes effect, leaving room to object."
          value={fp.objection_window_minutes ?? 0}
          min={0}
          disabled={!fp.enabled}
          onChange={(v) => set({ objection_window_minutes: v })}
        />
      </div>
    </div>
  );
}

function AdvancedSection({
  prefs,
  update,
  onNavigate,
}: SecProps & { onNavigate?: (p: any, opts?: any) => void }) {
  const caps = prefs.caps || {};
  const setCaps = (patch: Partial<typeof caps>) => update({ caps: { ...caps, ...patch } });
  const rag = prefs.rag || {};
  const setRag = (patch: Partial<typeof rag>) => update({ rag: { ...rag, ...patch } });
  const [tagInput, setTagInput] = React.useState('');
  const allowlist = prefs.auto_forward_allowlist || [];
  const addTag = () => {
    const v = tagInput.trim();
    if (!v || allowlist.includes(v)) {
      setTagInput('');
      return;
    }
    update({ auto_forward_allowlist: [...allowlist, v] });
    setTagInput('');
  };
  return (
    <div className="space-y-8">
      <SectionTitle
        title="Advanced"
        sub="Power-user controls: per-case caps, the kill switch, the auto-forward allowlist, suppression-rule retrieval, the rule catalog, and the settings lock."
      />

      <div className="space-y-4">
        <SubHeader title="Per-case caps">
          <HelpTip text="Hard limits per investigation. A case that hits a cap is routed to NEEDS_HUMAN rather than running unbounded." />
        </SubHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumPref label="Max tool calls / case" value={caps.max_tool_calls} onChange={(v) => setCaps({ max_tool_calls: v })} />
          <NumPref label="Max tokens / case" value={caps.max_tokens} onChange={(v) => setCaps({ max_tokens: v })} />
          <NumPref label="Timeout (seconds)" value={caps.timeout_seconds} onChange={(v) => setCaps({ timeout_seconds: v })} />
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Kill switch">
          <HelpTip text="An emergency stop. When on, the agent immediately halts ALL automated investigation; manual investigation still works." />
        </SubHeader>
        <div
          className={cn(
            'rounded-md border px-4 py-3 transition-colors',
            caps.kill_switch ? 'border-critical/50 bg-critical/10' : 'border-border bg-surface',
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className={cn('text-sm font-medium', caps.kill_switch ? 'text-critical' : 'text-foreground')}>
                Kill switch (stop all investigations)
              </p>
              <p className="text-xs text-muted-foreground">
                When on, the agent halts all automated investigation immediately.
              </p>
            </div>
            <Switch
              checked={Boolean(caps.kill_switch)}
              onCheckedChange={(v) => setCaps({ kill_switch: v })}
              aria-label="Kill switch"
            />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Auto-forward allowlist">
          <HelpTip text="Rule values whose alerts auto-forward straight to investigation (bypassing the cheap router). Operator-entered values render as plain text." />
        </SubHeader>
        <SwitchPref
          label="Background automated scans"
          help="Run scheduled background scans that triage new cases automatically."
          checked={Boolean(prefs.background_scan_enabled)}
          onChange={(v) => update({ background_scan_enabled: v })}
        />
        <div className="space-y-1.5">
          <Label htmlFor="allowlist-input">Allowlisted rule values</Label>
          <Input
            id="allowlist-input"
            placeholder="Type a rule value and press Enter"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
          />
          {allowlist.length ? (
            <div className="flex flex-wrap gap-1.5 pt-1.5">
              {allowlist.map((r) => (
                <Badge key={r} variant="outline" className="gap-1 pr-1">
                  {/* UNTRUSTED-ish rule value — plain text only */}
                  <span className="truncate">{r}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${r}`}
                    className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() =>
                      update({ auto_forward_allowlist: allowlist.filter((x) => x !== r) })
                    }
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Suppression & rule catalog">
          <HelpTip text="Inject approved suppression rules as TRUSTED retrieval context, and review/manage the detection rule catalog on the Playbooks & agents page." />
        </SubHeader>
        <SwitchPref
          label="Inject suppression rules"
          help="Retrieve approved suppression rules (source: suppression) and inject them into investigations as a TRUSTED fenced block. Suppression rules only go live via the approval queue — never automatically."
          checked={rag.use_suppression_rules ?? true}
          onChange={(v) => setRag({ use_suppression_rules: v })}
        />
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3">
          <span className="text-sm text-muted-foreground">Detection rule catalog &amp; playbooks</span>
          {onNavigate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate('intelligence', { tab: 'catalog' })}
            >
              <FileText className="h-4 w-4" aria-hidden />
              Open catalog
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Settings lock">
          <HelpTip text="When on, the console marks settings read-only. A safety guard against accidental edits in shared/production deployments. (Server-side read-only mode still wins.)" />
        </SubHeader>
        <SwitchPref
          label="Read-only settings mode"
          help="Surface settings as read-only in the console. Save is disabled while this is on."
          checked={Boolean(prefs.read_only_settings_mode)}
          onChange={(v) => update({ read_only_settings_mode: v })}
        />
      </div>
    </div>
  );
}

/**
 * Org Security & SSO (Administration) — a read-only posture summary, then the admin
 * token/session policy + OIDC providers, controlled by Settings' single save. The
 * SELF-SERVICE MFA lives separately under My account › Security & two-factor.
 */
function OrgSecuritySection({ prefs, update, configured }: SecProps & { configured: ConfiguredStatus }) {
  const { authEnabled, rbacEnabled, role } = useAuth();
  const sso = (prefs.sso as { enabled?: boolean; providers?: unknown[] } | undefined) ?? {};
  const providerCount = Array.isArray(sso.providers) ? sso.providers.length : 0;

  return (
    <div className="space-y-8">
      <SectionTitle
        title="Security & single sign-on"
        sub="Authentication posture, single sign-on (OIDC) providers, and the token / session policy."
      />

      <div className="space-y-4">
        <SubHeader title="Posture">
          <HelpTip text="A read-only summary of the live auth/RBAC posture, reported by the backend." />
        </SubHeader>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <PostureTile label="Authentication" on={authEnabled} onText="Enforced" offText="Disabled" />
          <PostureTile label="RBAC" on={rbacEnabled} onText="Enforced" offText="Allow-all" />
          <PostureTile label="Single sign-on" on={Boolean(sso.enabled)} onText={`${providerCount} provider${providerCount === 1 ? '' : 's'}`} offText="Off" />
        </div>
        {role ? (
          <p className="text-xs text-muted-foreground">
            You are signed in as <span className="font-medium text-foreground">{String(role)}</span>.
          </p>
        ) : null}
      </div>

      {/* Token/session policy + OIDC providers — controlled by the Settings save. */}
      <SecuritySsoInner prefs={prefs} update={update} configured={configured} />
    </div>
  );
}

function PostureTile({
  label,
  on,
  onText,
  offText,
}: {
  label: string;
  on: boolean;
  onText: string;
  offText: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <span
          className={cn('inline-block h-2 w-2 rounded-full', on ? 'bg-success' : 'bg-muted-foreground/40')}
          aria-hidden
        />
        <span className="text-sm font-semibold text-foreground">{on ? onText : offText}</span>
      </div>
    </div>
  );
}

/* ----------------------------------------------- threshold automation (F10) -- */

const AUTOMATION_ACTIONS: Array<{ value: AutomationRule['action']; text: string; help: string }> = [
  { value: 'tag', text: 'Add a tag', help: 'Attach a tag to the matched case (non-binding label).' },
  {
    value: 'recommend',
    text: 'Attach a recommendation',
    help: 'Record a non-binding recommendation note on the case.',
  },
  {
    value: 'notify',
    text: 'Send a notification',
    help: 'Fire a notification through a configured channel. Never changes the case.',
  },
  {
    value: 'run_playbook',
    text: 'Queue a playbook run',
    help: 'Re-investigate the case with a playbook injected as context. Re-runs the deterministic decision; never sets status directly.',
  },
  {
    value: 'request_approval',
    text: 'Request approval (HITL proposal)',
    help: 'Draft a Proposal for an approval-required action. Nothing goes live until a human approves it.',
  },
];

const VERDICT_CONDITION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: '', text: 'Any verdict' },
  { value: 'true_positive', text: 'True positive' },
  { value: 'false_positive', text: 'False positive' },
  { value: 'needs_human', text: 'Needs human' },
  { value: 'suspicious', text: 'Suspicious' },
  { value: 'benign', text: 'Benign' },
];

const STATUS_CONDITION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: '', text: 'Any status' },
  { value: 'new', text: 'New' },
  { value: 'open', text: 'Open' },
  { value: 'investigating', text: 'Investigating' },
  { value: 'escalated', text: 'Escalated' },
  { value: 'on_hold', text: 'On hold' },
  { value: 'resolved', text: 'Resolved' },
  { value: 'closed', text: 'Closed' },
];

const ENTITY_CONDITION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: '', text: 'Any entity' },
  { value: 'ip', text: 'IP' },
  { value: 'host', text: 'Host' },
  { value: 'user', text: 'User' },
  { value: 'rule', text: 'Rule' },
];

let _autoRuleSeq = 0;
function newAutomationRuleId(): string {
  _autoRuleSeq += 1;
  return `rule-${Date.now().toString(36)}-${_autoRuleSeq}`;
}

/** One editable automation rule card. */
function AutomationRuleEditor({
  rule,
  playbooks,
  onChange,
  onRemove,
}: {
  rule: AutomationRule;
  playbooks: Playbook[];
  onChange: (next: AutomationRule) => void;
  onRemove: () => void;
}) {
  const cond = rule.conditions || {};
  const setCond = (patch: Partial<typeof cond>) =>
    onChange({ ...rule, conditions: { ...cond, ...patch } });
  const payload = rule.payload || {};
  const setPayload = (patch: Record<string, unknown>) =>
    onChange({ ...rule, payload: { ...payload, ...patch } });
  const actionMeta = AUTOMATION_ACTIONS.find((a) => a.value === rule.action);

  // Payload editors keyed by action.
  const tagsValue = Array.isArray(payload.tags) ? (payload.tags as string[]).join(', ') : '';
  const recommendText = typeof payload.text === 'string' ? payload.text : '';
  const channelId = typeof payload.channel_id === 'string' ? payload.channel_id : '';
  const playbookId = typeof payload.playbook_id === 'string' ? payload.playbook_id : '';
  const approvalKind = typeof payload.kind === 'string' ? payload.kind : '';

  return (
    <div className="rounded-md border border-border bg-surface p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono">
            {rule.id}
          </Badge>
          <Switch
            checked={rule.enabled ?? true}
            onCheckedChange={(v) => onChange({ ...rule, enabled: v })}
            aria-label="Rule enabled"
          />
          <span className="text-xs text-muted-foreground">
            {rule.enabled ?? true ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Label className="text-xs">Priority</Label>
            <Input
              type="number"
              className="h-8 w-20"
              value={rule.priority ?? 100}
              onChange={(e) => onChange({ ...rule, priority: Number(e.target.value) })}
              aria-label="Priority"
            />
            <HelpTip text="Lower priority runs first when multiple rules match." />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-critical hover:text-critical"
            onClick={onRemove}
            aria-label="Remove rule"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* conditions */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          When a case matches
          <HelpTip text="All set conditions must hold (ANDed). Leave a field at 'Any' to ignore it." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Verdict</Label>
            <Select
              value={cond.verdict || '__any__'}
              onValueChange={(v) => setCond({ verdict: v === '__any__' ? undefined : v })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VERDICT_CONDITION_OPTIONS.map((o) => (
                  <SelectItem key={o.value || '__any__'} value={o.value || '__any__'}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Status</Label>
            <Select
              value={cond.status || '__any__'}
              onValueChange={(v) => setCond({ status: v === '__any__' ? undefined : v })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_CONDITION_OPTIONS.map((o) => (
                  <SelectItem key={o.value || '__any__'} value={o.value || '__any__'}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Minimum risk (0–100)</Label>
            <Input
              type="number"
              min={0}
              max={100}
              className="h-9"
              value={typeof cond.min_risk === 'number' ? cond.min_risk : ''}
              placeholder="Any"
              onChange={(e) =>
                setCond({
                  min_risk: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Minimum severity</Label>
            <Input
              type="number"
              min={0}
              className="h-9"
              value={typeof cond.min_severity === 'number' ? cond.min_severity : ''}
              placeholder="Any"
              onChange={(e) =>
                setCond({
                  min_severity: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Entity type</Label>
            <Select
              value={cond.entity_type || '__any__'}
              onValueChange={(v) => setCond({ entity_type: v === '__any__' ? undefined : v })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_CONDITION_OPTIONS.map((o) => (
                  <SelectItem key={o.value || '__any__'} value={o.value || '__any__'}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Source id (optional)</Label>
            <Input
              className="h-9"
              value={cond.source_id || ''}
              placeholder="Any source"
              onChange={(e) => setCond({ source_id: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Rule name contains (optional)</Label>
            <Input
              className="h-9"
              value={cond.rule_name || ''}
              placeholder="Any rule"
              onChange={(e) => setCond({ rule_name: e.target.value || undefined })}
            />
          </div>
        </div>
      </div>

      {/* action */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Then
          <HelpTip text="The action automation takes. It can only recommend / queue / propose — it never closes a case or sets its status." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Action</Label>
            <Select
              value={rule.action}
              onValueChange={(v) => onChange({ ...rule, action: v as AutomationRule['action'], payload: {} })}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTOMATION_ACTIONS.map((a) => (
                  <SelectItem key={a.value} value={String(a.value)}>
                    {a.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {actionMeta ? (
              <p className="text-xs text-muted-foreground">{actionMeta.help}</p>
            ) : null}
          </div>

          {/* action-specific payload */}
          <div className="space-y-1.5">
            {rule.action === 'tag' ? (
              <>
                <Label className="text-xs">Tags (comma-separated)</Label>
                <Input
                  className="h-9"
                  value={tagsValue}
                  placeholder="e.g. auto-triaged, watchlist"
                  onChange={(e) =>
                    setPayload({
                      tags: e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </>
            ) : null}
            {rule.action === 'recommend' ? (
              <>
                <Label className="text-xs">Recommendation text</Label>
                <Input
                  className="h-9"
                  value={recommendText}
                  placeholder="e.g. Review with the identity team"
                  onChange={(e) => setPayload({ text: e.target.value })}
                />
              </>
            ) : null}
            {rule.action === 'notify' ? (
              <>
                <Label className="text-xs">Channel id (optional)</Label>
                <Input
                  className="h-9"
                  value={channelId}
                  placeholder="All enabled channels"
                  onChange={(e) => setPayload({ channel_id: e.target.value })}
                />
              </>
            ) : null}
            {rule.action === 'run_playbook' ? (
              <>
                <Label className="text-xs">Playbook</Label>
                {playbooks.length ? (
                  <Select
                    value={playbookId || undefined}
                    onValueChange={(v) => setPayload({ playbook_id: v })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select a playbook…" />
                    </SelectTrigger>
                    <SelectContent>
                      {playbooks.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name || p.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    className="h-9"
                    value={playbookId}
                    placeholder="playbook id"
                    onChange={(e) => setPayload({ playbook_id: e.target.value })}
                  />
                )}
              </>
            ) : null}
            {rule.action === 'request_approval' ? (
              <>
                <Label className="text-xs">Proposal kind</Label>
                <Input
                  className="h-9"
                  value={approvalKind}
                  placeholder="e.g. suppression"
                  onChange={(e) => setPayload({ kind: e.target.value })}
                />
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AutomationSection({ prefs, update }: SecProps) {
  const cfg: ThresholdAutomationConfig = prefs.threshold_automation || {};
  const rules = cfg.rules || [];
  const [playbooks, setPlaybooks] = React.useState<Playbook[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    void api
      .getPlaybooks()
      .then((res) => {
        if (!cancelled) setPlaybooks(res.enabled ? res.playbooks ?? [] : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const setCfg = (patch: Partial<ThresholdAutomationConfig>) =>
    update({ threshold_automation: { ...cfg, ...patch } });

  const updateRule = (idx: number, next: AutomationRule) => {
    const copy = [...rules];
    copy[idx] = next;
    setCfg({ rules: copy });
  };
  const removeRule = (idx: number) => {
    setCfg({ rules: rules.filter((_, i) => i !== idx) });
  };
  const addRule = () => {
    setCfg({
      rules: [
        ...rules,
        {
          id: newAutomationRuleId(),
          enabled: true,
          priority: 100,
          conditions: {},
          action: 'tag',
          payload: { tags: [] },
        },
      ],
    });
  };

  // Show rules in the priority order the backend evaluates them.
  const ordered = React.useMemo(
    () =>
      rules
        .map((r, i) => ({ r, i }))
        .sort((a, b) => (a.r.priority ?? 100) - (b.r.priority ?? 100)),
    [rules],
  );

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Threshold automation"
        sub="Rules that react to a case AFTER the deterministic decision. Disabled by default."
      />

      <Alert>
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>Automation can recommend, queue, or propose — never auto-close</AlertTitle>
        <AlertDescription>
          A matched rule can only{' '}
          <strong className="font-semibold text-foreground">tag</strong>,{' '}
          <strong className="font-semibold text-foreground">recommend</strong>,{' '}
          <strong className="font-semibold text-foreground">notify</strong>,{' '}
          <strong className="font-semibold text-foreground">queue a re-investigation</strong>, or{' '}
          <strong className="font-semibold text-foreground">draft a proposal</strong> for an
          approval-required action. It runs after the close/escalate decision and{' '}
          <strong className="font-semibold text-foreground">
            never sets a case&apos;s status or auto-closes it
          </strong>{' '}
          — NEEDS_HUMAN and escalated cases are always held for a human. Any write that affects the
          outside world goes through the approval queue.
        </AlertDescription>
      </Alert>

      <SwitchPref
        label="Threshold automation enabled"
        help="Master switch. When off, no automation rules run and behaviour is unchanged."
        checked={Boolean(cfg.enabled)}
        onChange={(v) => setCfg({ enabled: v })}
      />

      <div className={cn('space-y-4', !cfg.enabled && 'opacity-60')}>
        {ordered.length === 0 ? (
          <EmptyState
            icon={Zap}
            compact
            title="No automation rules"
            description="Add a rule to react to cases after triage — tag them, attach a recommendation, notify a channel, queue a playbook, or draft an approval proposal."
          />
        ) : (
          ordered.map(({ r, i }) => (
            <AutomationRuleEditor
              key={r.id || i}
              rule={r}
              playbooks={playbooks}
              onChange={(next) => updateRule(i, next)}
              onRemove={() => removeRule(i)}
            />
          ))
        )}
        <Button variant="outline" size="sm" onClick={addRule}>
          <Plus className="h-4 w-4" aria-hidden />
          Add rule
        </Button>
      </div>
    </div>
  );
}

function KnowledgeSection({
  prefs,
  update,
  onNavigate,
}: SecProps & { onNavigate?: (p: any, opts?: any) => void }) {
  const cfg: ThreatContextConfig = prefs.threat_context || {};
  const set = (patch: Partial<ThreatContextConfig>) =>
    update({ threat_context: { ...cfg, ...patch } });

  return (
    <div className="space-y-8">
      <SectionTitle
        title="Knowledge & threat context"
        sub="Retrieval-augmented context for investigations, the per-case threat-context panel (IOC reputation, MITRE, related cases), and the reusable-knowledge loop."
      />

      <div className="space-y-4">
        <SubHeader title="Retrieval (RAG)">
          <HelpTip text="Hybrid BM25 + vector retrieval injects relevant knowledge into investigations as a clearly-labelled TRUSTED block." />
        </SubHeader>
        <RagControls prefs={prefs} update={update} />
      </div>

      <div className="space-y-4">
        <SubHeader title="Threat-context panel">
          <HelpTip text="The Threat context tab on each case. Sections fail open — a missing enrichment or MITRE lookup degrades to empty, never an error." />
        </SubHeader>
        <SwitchPref
          label="Threat-context panel enabled"
          help="Assemble and show the Threat context tab on each case."
          checked={cfg.enabled ?? true}
          onChange={(v) => set({ enabled: v })}
        />
        <SwitchPref
          label="MITRE ATT&CK technique lookup"
          help="Resolve technique ids against the bundled curated MITRE corpus (name, tactics, link)."
          checked={cfg.mitre_enabled ?? true}
          onChange={(v) => set({ mitre_enabled: v })}
        />
        <SwitchPref
          label="Reuse resolved cases"
          help="Auto-index closed/resolved cases into the corpus so future triage can retrieve 'we've seen this before'."
          checked={cfg.reuse_resolved_cases ?? true}
          onChange={(v) => set({ reuse_resolved_cases: v })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label>IOC malicious threshold</Label>
              <HelpTip text="A reputation score at or above this (0–100) marks an indicator as malicious in the panel." />
            </div>
            <Input
              type="number"
              min={0}
              max={100}
              value={cfg.ioc_malicious_threshold ?? 50}
              onChange={(e) => set({ ioc_malicious_threshold: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <SubHeader title="Corpus & procedures">
          <HelpTip text="Manage the RAG knowledge corpus (runbooks, MITRE, imported threat-intel) and the per-cluster playbooks on their dedicated pages." />
        </SubHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3">
            <span className="text-sm text-muted-foreground">Knowledge corpus (RAG)</span>
            {onNavigate ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate('intelligence', { tab: 'knowledge' })}
              >
                <Library className="h-4 w-4" aria-hidden />
                Open
              </Button>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3">
            <span className="text-sm text-muted-foreground">Playbooks & agents</span>
            {onNavigate ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate('intelligence', { tab: 'catalog' })}
              >
                <FileText className="h-4 w-4" aria-hidden />
                Open
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

const RESET_PERIOD_OPTIONS: Array<{ value: string; text: string }> = [
  { value: 'none', text: 'Never reset (one continuous sequence)' },
  { value: 'calendar_year', text: 'Each calendar year' },
  { value: 'fiscal_year', text: 'Each fiscal year (April start)' },
  { value: 'fiscal_quarter', text: 'Each fiscal quarter' },
];

const CASE_ID_PLACEHOLDERS: Array<{ token: string; desc: string }> = [
  { token: '{prefix}', desc: 'The configured prefix' },
  { token: '{seq}', desc: 'The next sequence number' },
  { token: '{seq:06d}', desc: 'Zero-padded sequence (width 6)' },
  { token: '{year}', desc: '4-digit year' },
  { token: '{yy}', desc: '2-digit year' },
  { token: '{mm}', desc: '2-digit month' },
  { token: '{dd}', desc: '2-digit day' },
  { token: '{source}', desc: 'Originating source (slug)' },
  { token: '{verdict}', desc: 'LLM verdict (lower-case)' },
];

/**
 * Case-ID nomenclature (F7) — template editor + placeholder helper + LIVE PREVIEW
 * (debounced call to POST /api/settings/case-id/preview). `Case.case_id` stays the
 * immutable internal id; this only governs the optional `case_number` display id.
 */
function CaseIdSection({ prefs, update }: SecProps) {
  const cfg = prefs.case_id_format || {
    enabled: false,
    template: 'CASE-{seq:06d}',
    prefix: 'CASE',
    reset_period: 'none' as const,
    seq_start: 1,
  };
  const set = (patch: Partial<typeof cfg>) =>
    update({ case_id_format: { ...cfg, ...patch } });

  const [preview, setPreview] = React.useState<{
    samples: string[];
    valid: boolean;
    error?: string;
  } | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  // Debounced live preview whenever the template / prefix / seq_start change.
  React.useEffect(() => {
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(() => {
      void api
        .caseIdPreview({
          template: cfg.template || '',
          prefix: cfg.prefix || 'CASE',
          seq_start: typeof cfg.seq_start === 'number' ? cfg.seq_start : 1,
        })
        .then((res) => {
          if (!cancelled) setPreview(res);
        })
        .catch(() => {
          if (!cancelled) setPreview({ samples: [], valid: false, error: 'preview failed' });
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cfg.template, cfg.prefix, cfg.seq_start]);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Case-ID format"
        sub="Customise the human-facing case number. The internal case id is unchanged; this only governs the displayed identifier on new cases."
      />

      <SwitchPref
        label="Use a custom case-number format"
        help="When off, the UI shows the internal case id. When on, new cases get a rendered display number."
        checked={Boolean(cfg.enabled)}
        onChange={(v) => set({ enabled: v })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextPref
          label="Template"
          value={cfg.template}
          placeholder="CASE-{seq:06d}"
          help="Use the placeholders below. Unknown placeholders are rejected."
          onChange={(v) => set({ template: v })}
        />
        <TextPref
          label="Prefix"
          value={cfg.prefix}
          placeholder="CASE"
          onChange={(v) => set({ prefix: v })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Reset period</Label>
          <Select
            value={cfg.reset_period || 'none'}
            onValueChange={(v) => set({ reset_period: v as typeof cfg.reset_period })}
          >
            <SelectTrigger aria-label="Reset period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESET_PERIOD_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.text}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Rolls a fresh sequence at each boundary.
          </p>
        </div>
        <NumPref
          label="Sequence start"
          value={cfg.seq_start}
          min={0}
          onChange={(v) => set({ seq_start: v })}
        />
      </div>

      {/* placeholder helper */}
      <div className="space-y-2">
        <Label>Placeholders</Label>
        <div className="flex flex-wrap gap-1.5">
          {CASE_ID_PLACEHOLDERS.map((p) => (
            <button
              key={p.token}
              type="button"
              title={p.desc}
              className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              onClick={() => set({ template: `${cfg.template || ''}${p.token}` })}
            >
              {p.token}
            </button>
          ))}
        </div>
      </div>

      {/* live preview */}
      <div className="rounded-md border border-border bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">Live preview</p>
          {previewing ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        {preview && !preview.valid ? (
          <Alert variant="destructive" className="mt-2 py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {/* error text is from the backend validator — controlled, but render plain */}
              {preview.error || 'Invalid template.'}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(preview?.samples || []).map((s, i) => (
              <Badge key={`${s}-${i}`} variant="outline" className="font-mono">
                {s}
              </Badge>
            ))}
            {!preview?.samples?.length && !previewing ? (
              <span className="text-xs text-muted-foreground">No preview.</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- page -- */

export interface SettingsPageProps {
  /** Re-launch the first-run setup wizard. */
  onRerunWizard?: () => void;
  onNavigate?: (page: any, opts?: any) => void;
}

/** Read the active section from the hash query (`#/settings?s=<id>`). */
function sectionFromHash(): SectionId | null {
  try {
    // Allow underscores so deep-links like `#/settings?s=admin_users` resolve.
    const m = (window.location.hash || '').match(/[?&]s=([a-z_]+)/i);
    const id = m?.[1];
    return id && isSectionId(id) ? id : null;
  } catch {
    return null;
  }
}

export default function Settings({ onRerunWizard, onNavigate: onNavigateProp }: SettingsPageProps) {
  const navigate = useNavigate();
  const onNavigate = onNavigateProp ?? navigate;
  const { hasPermission } = useAuth();

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [prefs, setPrefs] = React.useState<Preferences | null>(null);
  const [savedPrefs, setSavedPrefs] = React.useState<Preferences | null>(null);
  const [configured, setConfigured] = React.useState<ConfiguredStatus>({});
  const [readOnly, setReadOnly] = React.useState(false);
  const [models, setModels] = React.useState<ModelsResponse | null>(null);
  const [section, setSectionState] = React.useState<SectionId>(() => sectionFromHash() ?? 'general');
  const [query, setQuery] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  // Persist the active section in the hash query (`#/settings?s=<id>`) WITHOUT
  // disturbing the router (which keys on the bare page id before `?`).
  const setSection = React.useCallback((id: SectionId) => {
    setSectionState(id);
    try {
      const base = (window.location.hash || '#/settings').split('?')[0] || '#/settings';
      const next = `${base}?s=${id}`;
      if (window.location.hash !== next) window.location.hash = next;
    } catch {
      /* hash is best-effort */
    }
  }, []);

  // Keep the active section in sync with back/forward navigation.
  React.useEffect(() => {
    const onHash = () => {
      const id = sectionFromHash();
      if (id) setSectionState(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // buffered secret entries (write-only)
  const [secretDraft, setSecretDraft] = React.useState<Record<string, string>>({});
  const [savingSecrets, setSavingSecrets] = React.useState(false);

  // Dirty when the editable prefs diverge from the last saved snapshot. Compares
  // everything except the non-editable `sources`/`setup_complete`.
  const dirty = React.useMemo(() => {
    if (!prefs || !savedPrefs) return false;
    const strip = (p: Preferences) => {
      const { sources, setup_complete, ...rest } = p;
      void sources;
      void setup_complete;
      return rest;
    };
    try {
      return JSON.stringify(strip(prefs)) !== JSON.stringify(strip(savedPrefs));
    } catch {
      return true;
    }
  }, [prefs, savedPrefs]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, mdl] = await Promise.all([
        api.getSettings(),
        api.getModels().catch(() => null),
      ]);
      setPrefs(settings.prefs);
      setSavedPrefs(settings.prefs);
      setConfigured(settings.configured);
      setReadOnly(settings.read_only);
      setModels(mdl);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const update = React.useCallback(
    (patch: Partial<Preferences>) => setPrefs((p) => (p ? { ...p, ...patch } : p)),
    [],
  );

  const save = React.useCallback(async () => {
    if (!prefs) return;
    setSaving(true);
    try {
      const { sources, setup_complete, ...patch } = prefs;
      void sources;
      void setup_complete;
      const res = await api.putSettings(patch as Partial<Preferences>);
      setPrefs(res.prefs);
      setSavedPrefs(res.prefs);
      toast.success('Settings saved.');
    } catch (e) {
      toast.error(errMsg(e, 'Could not save settings.'));
    } finally {
      setSaving(false);
    }
  }, [prefs]);

  const saveSecrets = React.useCallback(async () => {
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(secretDraft)) if (v && v.trim()) body[k] = v;
    if (!Object.keys(body).length) {
      toast.message('No new secret values entered.');
      return;
    }
    setSavingSecrets(true);
    try {
      const res = await api.updateSecrets(body);
      setConfigured(res.configured);
      setSecretDraft({});
      toast.success('Secret keys updated.');
    } catch (e) {
      toast.error(errMsg(e, 'Could not update keys.'));
    } finally {
      setSavingSecrets(false);
    }
  }, [secretDraft]);

  // Filtered, RBAC-aware grouped section list for the rail. A section with a `perm`
  // is hidden from users without the grant; the search matches name/blurb/keywords.
  // RULES OF HOOKS: these three hooks MUST run unconditionally — i.e. ABOVE the
  // `if (loading)` / `if (!prefs)` early returns below. If they sit after a return,
  // the hook count changes once `loading` flips false on the first data load and React
  // throws #310 ("Rendered more hooks than during the previous render"). They read only
  // query/hasPermission/section state (never `prefs`), so hoisting is safe. Do NOT move
  // them back down, and do not add early returns between hooks.
  const q = query.trim().toLowerCase();
  const visibleGroups = React.useMemo(() => {
    return SECTION_GROUPS.map((g) => ({
      ...g,
      sections: g.sections.filter((s) => {
        if (s.perm && !hasPermission(s.perm.resource, s.perm.action)) return false;
        if (!q) return true;
        const hay = [s.name, s.blurb, ...(s.keywords ?? [])].join(' ').toLowerCase();
        return hay.includes(q);
      }),
    })).filter((g) => g.sections.length > 0);
  }, [q, hasPermission]);

  const flatVisible = React.useMemo(
    () => visibleGroups.flatMap((g) => g.sections),
    [visibleGroups],
  );

  // If a search/RBAC change hides the active section, jump to the first visible one.
  React.useEffect(() => {
    if (flatVisible.length && !flatVisible.some((s) => s.id === section)) {
      setSectionState(flatVisible[0].id);
    }
  }, [flatVisible, section]);

  /* ------------------------------------------------------------- states ---- */

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader icon={SettingsIcon} eyebrow="Platform" title="Settings" />
        <div className="grid gap-6 lg:grid-cols-[224px_minmax(0,1fr)]">
          <div className="space-y-1.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
          <Skeleton className="h-96 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (!prefs) {
    return (
      <div className="space-y-6">
        <PageHeader icon={SettingsIcon} eyebrow="Platform" title="Settings" />
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Could not load settings</AlertTitle>
          <AlertDescription>{errMsg(error, 'No settings loaded.')}</AlertDescription>
        </Alert>
        <EmptyState
          variant="error"
          icon={SettingsIcon}
          title="Settings unavailable"
          description="The backend did not return preferences. Check connectivity and try again."
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const secProps: SecProps = { prefs, update };

  const restricted = (icon: LucideIcon, what: string) => (
    <EmptyState icon={icon} title="Restricted" description={`${what} is managed by administrators.`} />
  );

  const renderSection = () => {
    switch (section) {
      // ---- My account (Personal) — no perm gate; the embedded bodies self-scope to
      // the signed-in caller. Do NOT wrap in <Can>: in the auth-off default these
      // must still render (back-compat).
      case 'profile':
        return <AccountInner onNavigateToSecurity={() => setSection('account_security')} />;
      case 'account_security':
        return <SecurityMfaInner />;
      case 'sessions':
        return <SessionsInner />;
      // ---- Configuration / triage / integrations
      case 'general':
        return <GeneralSection {...secProps} onNavigate={onNavigate} />;
      case 'models':
        return <ModelsSection {...secProps} models={models} />;
      case 'keys':
        return (
          <KeysSection
            configured={configured}
            draft={secretDraft}
            setDraft={setSecretDraft}
            onSave={() => void saveSecrets()}
            saving={savingSecrets}
            readOnly={readOnly}
          />
        );
      case 'detection':
        return <DetectionSection {...secProps} />;
      case 'cases':
        return (
          <Can resource="settings" action="manage" fallback={restricted(Hash, 'Case-ID nomenclature')}>
            <CaseIdSection {...secProps} />
          </Can>
        );
      case 'automation':
        return (
          <Can resource="settings" action="manage" fallback={restricted(Zap, 'Threshold automation')}>
            <AutomationSection {...secProps} />
          </Can>
        );
      case 'standup':
        return <StandupSection {...secProps} />;
      case 'notifications':
        return (
          <Can resource="settings" action="manage" fallback={restricted(Bell, 'Alerting & notifications')}>
            <NotificationsEditor {...secProps} />
          </Can>
        );
      // ---- Administration (perm-gated). The section-rail already filters these out
      // for users without the grant; the <Can> fallback here is belt-and-braces for a
      // direct deep-link (`#/settings?s=admin_users`).
      case 'admin_users':
        return (
          <Can resource="users" action="manage" fallback={restricted(UsersIcon, 'Users & roles')}>
            <UsersInner />
          </Can>
        );
      case 'security':
        return (
          <Can resource="settings" action="manage" fallback={restricted(ShieldCheck, 'Security & single sign-on')}>
            {/* Posture + org SSO + token/session policy, controlled by Settings' save. */}
            <OrgSecuritySection {...secProps} configured={configured} />
          </Can>
        );
      case 'admin_sessions':
        return (
          <Can resource="users" action="manage" fallback={restricted(Network, 'Active sessions')}>
            <AdminSessionsInner />
          </Can>
        );
      case 'knowledge':
        return (
          <Can resource="settings" action="manage" fallback={restricted(ShieldAlert, 'Knowledge & threat context')}>
            <KnowledgeSection {...secProps} onNavigate={onNavigate} />
          </Can>
        );
      case 'enrichment':
        return <EnrichmentSection {...secProps} />;
      case 'appearance':
        return (
          <Can resource="settings" action="manage" fallback={restricted(Brush, 'Branding')}>
            <BrandingEditor readOnly={readOnly} />
          </Can>
        );
      case 'advanced':
        return (
          <Can resource="settings" action="manage" fallback={restricted(SlidersHorizontal, 'Advanced settings')}>
            <AdvancedSection {...secProps} onNavigate={onNavigate} />
          </Can>
        );
      default:
        return <GeneralSection {...secProps} onNavigate={onNavigate} />;
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={SettingsIcon}
        eyebrow="Platform"
        title="Settings"
        description="Tune every preference the agent uses. Secrets are write-only."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {dirty ? (
              <Badge variant="warning" className="gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
                Unsaved changes
              </Badge>
            ) : null}
            {onRerunWizard ? (
              <Button variant="outline" size="sm" onClick={onRerunWizard}>
                <Wand2 className="h-4 w-4" aria-hidden />
                Re-run setup wizard
              </Button>
            ) : null}
            <Button size="sm" onClick={() => void save()} disabled={readOnly || !dirty || saving}>
              <Save className="h-4 w-4" aria-hidden />
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        }
      />

      {readOnly ? (
        <Alert variant="warning">
          <Lock className="h-4 w-4" aria-hidden />
          <AlertTitle>Read-only mode</AlertTitle>
          <AlertDescription>
            Settings are read-only in this deployment. Edits cannot be saved.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[256px_minmax(0,1fr)]">
        {/* Section nav: searchable, grouped, RBAC-aware. */}
        <nav aria-label="Settings sections" className="lg:sticky lg:top-4 lg:self-start">
          <div className="space-y-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings sections"
                className="h-9 pl-8"
              />
            </div>

            {flatVisible.length === 0 ? (
              <p className="px-1 py-3 text-xs text-muted-foreground">No sections match “{query}”.</p>
            ) : (
              <div className="space-y-4">
                {visibleGroups.map((g) => (
                  <div key={g.id} className="space-y-1">
                    <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                      {g.label}
                    </p>
                    <div className="flex flex-col gap-0.5">
                      {g.sections.map((s) => {
                        const Icon = s.icon;
                        const active = section === s.id;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setSection(s.id)}
                            aria-current={active ? 'page' : undefined}
                            title={s.blurb}
                            className={cn(
                              'group inline-flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              active
                                ? 'bg-accent text-foreground'
                                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                            )}
                          >
                            <Icon
                              className={cn(
                                'h-4 w-4 shrink-0 transition-colors',
                                active
                                  ? 'text-primary'
                                  : 'text-muted-foreground group-hover:text-foreground',
                              )}
                              aria-hidden
                            />
                            <span className="truncate">{s.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </nav>

        {/* Section body */}
        <Card>
          <CardContent className="p-6 sm:p-7">{renderSection()}</CardContent>
        </Card>
      </div>

      <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
        Changes to preferences take effect after Save. Secret keys are stored write-only — the
        console only ever knows whether a key is configured.
      </p>
    </div>
  );
}
