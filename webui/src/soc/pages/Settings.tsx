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
  Gauge,
  Globe,
  Hash,
  Info,
  KeyRound,
  Library,
  Lock,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Timer,
  Wand2,
  Workflow,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  ConfiguredStatus,
  ModelConfig,
  ModelsResponse,
  Preferences,
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
import { Separator } from '@/ui/separator';
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

/* --------------------------------------------------------------- sections --- */

type SectionId =
  | 'data'
  | 'polling'
  | 'models'
  | 'keys'
  | 'correlation'
  | 'enrichment'
  | 'rag'
  | 'standup'
  | 'autonomy'
  | 'safety'
  | 'notifications'
  | 'caseid'
  | 'branding';

const SECTIONS: Array<{ id: SectionId; name: string; icon: LucideIcon }> = [
  { id: 'data', name: 'Data scope', icon: Database },
  { id: 'polling', name: 'Polling', icon: Timer },
  { id: 'models', name: 'Models', icon: Sparkles },
  { id: 'keys', name: 'Secret keys', icon: KeyRound },
  { id: 'correlation', name: 'Correlation & risk', icon: Workflow },
  { id: 'enrichment', name: 'Enrichment', icon: Globe },
  { id: 'rag', name: 'RAG', icon: Library },
  { id: 'standup', name: 'Standup', icon: FileText },
  { id: 'autonomy', name: 'Autonomy', icon: Gauge },
  { id: 'safety', name: 'Automation & safety', icon: Lock },
  { id: 'notifications', name: 'Alerting & notifications', icon: Bell },
  { id: 'caseid', name: 'Case-ID format', icon: Hash },
  { id: 'branding', name: 'Branding', icon: Brush },
];

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

function DataSection({ prefs, update }: SecProps) {
  return (
    <div className="space-y-6">
      <SectionTitle title="Data scope" sub="Index pattern and the fields the agent maps entities from." />
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
  );
}

function PollingSection({ prefs, update }: SecProps) {
  return (
    <div className="space-y-6">
      <SectionTitle title="Polling" sub="How the durable poller pulls new events." />
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

function CorrelationSection({ prefs, update }: SecProps) {
  const corr = prefs.default_correlation || {};
  const weights = prefs.risk_weights || {};
  return (
    <div className="space-y-6">
      <SectionTitle title="Correlation & risk" sub="Clustering thresholds and the deterministic risk weights." />
      <div className="grid gap-4 sm:grid-cols-2">
        <NumPref label="Threshold (N)" value={corr.n} onChange={(v) => update({ default_correlation: { ...corr, n: v } })} />
        <NumPref label="Window (seconds)" value={corr.window_seconds} onChange={(v) => update({ default_correlation: { ...corr, window_seconds: v } })} />
      </div>
      <Separator />
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Risk weights
        <span className="ml-2 font-normal normal-case tracking-normal">auto-normalised to 0–100</span>
      </p>
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
      <Separator />
      <div className="grid gap-4 sm:grid-cols-2">
        <NumPref label="Escalation confidence" value={prefs.escalation_confidence} step={0.05} onChange={(v) => update({ escalation_confidence: v })} />
        <NumPref label="Critical severity" value={prefs.critical_severity} step={0.5} onChange={(v) => update({ critical_severity: v })} />
      </div>
      <Separator />
      <CrossSourceSubsection prefs={prefs} update={update} />
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

function RagSection({ prefs, update }: SecProps) {
  const r = prefs.rag || {};
  const set = (patch: Partial<typeof r>) => update({ rag: { ...r, ...patch } });
  return (
    <div className="space-y-6">
      <SectionTitle title="RAG" sub="Retrieval-augmented context for investigations." />
      <SwitchPref label="RAG enabled" checked={r.enabled ?? true} onChange={(v) => set({ enabled: v })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <NumPref label="Top K" value={r.top_k} onChange={(v) => set({ top_k: v })} />
        <NumPref label="Minimum score" value={r.min_score} step={0.05} onChange={(v) => set({ min_score: v })} />
      </div>
      <div className="space-y-2">
        <SwitchPref label="Use runbooks" checked={r.use_runbooks ?? true} onChange={(v) => set({ use_runbooks: v })} />
        <SwitchPref label="Use MITRE" checked={r.use_mitre ?? true} onChange={(v) => set({ use_mitre: v })} />
        <SwitchPref label="Use resolved cases" checked={r.use_resolved_cases ?? true} onChange={(v) => set({ use_resolved_cases: v })} />
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

function AutonomySection({ prefs, update }: SecProps) {
  const fp = prefs.fp_auto_close || {};
  const set = (patch: Partial<typeof fp>) => update({ fp_auto_close: { ...fp, ...patch } });
  const minConfPct = toPercentValue(fp.min_confidence ?? 0.8);
  return (
    <div className="space-y-6">
      <SectionTitle
        title="Autonomy"
        sub="When the agent may auto-close a FALSE POSITIVE. The close/escalate decision is always made by deterministic code against this policy — never by raw model output."
      />
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

function SafetySection({ prefs, update }: SecProps) {
  const caps = prefs.caps || {};
  const setCaps = (patch: Partial<typeof caps>) => update({ caps: { ...caps, ...patch } });
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
    <div className="space-y-6">
      <SectionTitle title="Automation & safety" sub="Caps, the auto-forward allowlist, and the kill switch." />
      <SwitchPref
        label="Background automated scans"
        checked={Boolean(prefs.background_scan_enabled)}
        onChange={(v) => update({ background_scan_enabled: v })}
      />

      <div className="space-y-1.5">
        <Label htmlFor="allowlist-input">Auto-forward allowlist</Label>
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
        <p className="text-xs text-muted-foreground">Rule values that auto-forward to investigation.</p>
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

      <div className="grid gap-4 sm:grid-cols-3">
        <NumPref label="Max tool calls / case" value={caps.max_tool_calls} onChange={(v) => setCaps({ max_tool_calls: v })} />
        <NumPref label="Max tokens / case" value={caps.max_tokens} onChange={(v) => setCaps({ max_tokens: v })} />
        <NumPref label="Timeout (seconds)" value={caps.timeout_seconds} onChange={(v) => setCaps({ timeout_seconds: v })} />
      </div>

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

export default function Settings({ onRerunWizard }: SettingsPageProps) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [prefs, setPrefs] = React.useState<Preferences | null>(null);
  const [savedPrefs, setSavedPrefs] = React.useState<Preferences | null>(null);
  const [configured, setConfigured] = React.useState<ConfiguredStatus>({});
  const [readOnly, setReadOnly] = React.useState(false);
  const [models, setModels] = React.useState<ModelsResponse | null>(null);
  const [section, setSection] = React.useState<SectionId>('data');
  const [saving, setSaving] = React.useState(false);

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

      <div className="grid gap-6 lg:grid-cols-[224px_minmax(0,1fr)]">
        {/* Section nav */}
        <nav aria-label="Settings sections" className="lg:sticky lg:top-4 lg:self-start">
          <div className="flex flex-wrap gap-1 lg:flex-col">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  aria-current={active ? 'page' : undefined}
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
                      active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{s.name}</span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* Section body */}
        <Card>
          <CardContent className="p-6 sm:p-7">
            {section === 'data' ? (
              <DataSection {...secProps} />
            ) : section === 'polling' ? (
              <PollingSection {...secProps} />
            ) : section === 'models' ? (
              <ModelsSection {...secProps} models={models} />
            ) : section === 'keys' ? (
              <KeysSection
                configured={configured}
                draft={secretDraft}
                setDraft={setSecretDraft}
                onSave={() => void saveSecrets()}
                saving={savingSecrets}
                readOnly={readOnly}
              />
            ) : section === 'correlation' ? (
              <CorrelationSection {...secProps} />
            ) : section === 'enrichment' ? (
              <EnrichmentSection {...secProps} />
            ) : section === 'rag' ? (
              <RagSection {...secProps} />
            ) : section === 'standup' ? (
              <StandupSection {...secProps} />
            ) : section === 'autonomy' ? (
              <AutonomySection {...secProps} />
            ) : section === 'safety' ? (
              <SafetySection {...secProps} />
            ) : section === 'notifications' ? (
              <Can
                resource="settings"
                action="manage"
                fallback={
                  <EmptyState
                    icon={Bell}
                    title="Restricted"
                    description="Alerting & notifications are managed by administrators."
                  />
                }
              >
                <NotificationsEditor {...secProps} />
              </Can>
            ) : section === 'caseid' ? (
              <Can
                resource="settings"
                action="manage"
                fallback={
                  <EmptyState
                    icon={Hash}
                    title="Restricted"
                    description="Case-ID nomenclature is managed by administrators."
                  />
                }
              >
                <CaseIdSection {...secProps} />
              </Can>
            ) : (
              <BrandingEditor readOnly={readOnly} />
            )}
          </CardContent>
        </Card>
      </div>

      <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
        Changes to preferences take effect after Save. Secret keys are stored write-only — the
        console only ever knows whether a key is configured.
      </p>
    </div>
  );
}
