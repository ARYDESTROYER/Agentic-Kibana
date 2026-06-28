/**
 * Wizard — first-run setup (new "command center" UI).
 *
 * Shown automatically when GET /api/setup/status reports `setup_complete: false`,
 * and re-runnable from Settings. A focused 4-step flow:
 *
 *   1. Welcome     — name the deployment + non-destructive demo-mode toggle
 *   2. Sources     — pick a connector, fill its dynamic form, test, save (reuses
 *                    the shared new-UI SourceEditor); mark one primary
 *   3. Keys        — Anthropic / OpenAI / embedding provider keys (write-only,
 *                    → POST /api/setup/secrets); per-role model selection lives in
 *                    Settings (kept out of the first-run path to stay focused)
 *   4. Done        — review summary → POST /api/setup/complete → app
 *
 * Reuses the legacy step logic/contract verbatim where it matters:
 * api.setupStatus / listConnectors / listSources / getSettings (boot),
 * api.updateSecrets (keys), api.upsertSource / deleteSource (sources, via
 * SourceEditor's saveSource helper), api.putSettings (deployment name/demo) +
 * api.completeSetup (finish).
 *
 * Security: secrets are write-only and only ever surfaced as a boolean
 * ("configured"); never echoed. Source display names / connector text render as
 * plain text — nothing is interpolated as markup.
 */
import * as React from 'react';
import {
  ShieldCheck,
  Database,
  KeyRound,
  CheckCircle2,
  Check,
  ArrowLeft,
  ArrowRight,
  X,
  Loader2,
  ScanSearch,
  Gauge,
  ClipboardCheck,
  Beaker,
  Info,
  Plus,
  Pencil,
  Trash2,
  Star,
  Save,
  Eye,
  EyeOff,
  type LucideIcon,
} from 'lucide-react';

import type {
  ConnectorManifest,
  ConfiguredStatus,
  Preferences,
  SecretsUpdate,
  SetupStatus,
  SourceInstance,
} from '@/lib/types';
import { api } from '@/lib/api';
import { humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Separator } from '@/ui/separator';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';

import { HeroPanel } from '@/soc/components/HeroPanel';
import { EmptyState } from '@/soc/components/EmptyState';
import { SourceEditor } from '@/soc/components/SourceEditor';
import { LoadingBar } from '@/soc/components/LoadingBar';

/* ----------------------------------------------------------------- helpers - */

/** Best-effort human message from an unknown thrown value. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || 'Something went wrong.';
  if (typeof e === 'string') return e;
  return 'Something went wrong.';
}

const STEPS: Array<{ key: string; title: string; icon: LucideIcon }> = [
  { key: 'welcome', title: 'Welcome', icon: ShieldCheck },
  { key: 'sources', title: 'Sources', icon: Database },
  { key: 'keys', title: 'Provider keys', icon: KeyRound },
  { key: 'done', title: 'Review & finish', icon: ClipboardCheck },
];

/* --------------------------------------------------------------- props ----- */

export interface WizardProps {
  /** Called when setup completes successfully — App routes to the dashboard. */
  onComplete: () => void;
  /** Re-run mode: render a "Close" affordance back to the app. */
  onExit?: () => void;
}

/* ============================================================== component == */

export default function Wizard({ onComplete, onExit }: WizardProps) {
  const [step, setStep] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [bootError, setBootError] = React.useState<unknown>(null);
  const [finishError, setFinishError] = React.useState<unknown>(null);
  const [finishing, setFinishing] = React.useState(false);

  // Shared, persisted-between-steps state.
  const [deploymentName, setDeploymentName] = React.useState('My SOC');
  const [demoMode, setDemoMode] = React.useState(false);

  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  const [connectors, setConnectors] = React.useState<ConnectorManifest[]>([]);
  const [sources, setSources] = React.useState<SourceInstance[]>([]);

  const configured: ConfiguredStatus = status?.configured || {};

  const refreshStatus = React.useCallback(async () => {
    const [st, src] = await Promise.all([api.setupStatus(), api.listSources()]);
    setStatus(st);
    setSources(src.sources);
  }, []);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [st, conns, src] = await Promise.all([
          api.setupStatus(),
          api.listConnectors(),
          api.listSources(),
        ]);
        if (!alive) return;
        setStatus(st);
        setConnectors(conns.connectors);
        setSources(src.sources);
        // Seed the deployment name from prefs if present (best-effort).
        try {
          const settings = await api.getSettings();
          const dn = (settings.prefs as Partial<Preferences> & { deployment_name?: string })
            ?.deployment_name;
          if (alive && dn) setDeploymentName(dn);
        } catch {
          /* deployment name is best-effort; ignore */
        }
      } catch (e) {
        if (alive) setBootError(e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const finish = async () => {
    setFinishing(true);
    setFinishError(null);
    try {
      // Persist deployment-name + demo flag additively into prefs (round-trips harmlessly).
      await api.putSettings({
        deployment_name: deploymentName,
        demo_mode: demoMode,
      } as Partial<Preferences>);
      await api.completeSetup();
      onComplete();
    } catch (e) {
      setFinishError(e);
      setFinishing(false);
    }
  };

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  const isLast = step === STEPS.length - 1;

  /* --------------------------------------------------------------- render -- */

  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto w-full max-w-5xl animate-fade-in px-4 py-8 sm:px-6 sm:py-12">
        <HeroPanel
          eyebrow="Agentic SOC · First-run setup"
          title="Stand up your triage console"
          description="Connect your data and models so the agent can turn raw alert volume into audited, cost-metered, human-reviewable cases."
          icon={ShieldCheck}
          actions={
            onExit ? (
              <Button variant="ghost" size="sm" onClick={onExit}>
                <X className="h-4 w-4" aria-hidden /> Close
              </Button>
            ) : undefined
          }
        />

        {/* stepper */}
        <nav aria-label="Setup steps" className="mt-6">
          <ol className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-1">
            {STEPS.map((s, i) => {
              const state =
                i < step ? 'complete' : i === step ? 'current' : 'incomplete';
              const Icon = s.icon;
              return (
                <li key={s.key} className="flex flex-1 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setStep(i)}
                    aria-current={state === 'current' ? 'step' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      state === 'current'
                        ? 'border-primary bg-primary/10 text-foreground'
                        : state === 'complete'
                          ? 'border-border bg-card text-foreground hover:bg-muted'
                          : 'border-border bg-card text-muted-foreground hover:bg-muted',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                        state === 'complete'
                          ? 'bg-success/15 text-success'
                          : state === 'current'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {state === 'complete' ? (
                        <Check className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </span>
                    <span className="truncate font-medium">{s.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* body */}
        <Card className="mt-6">
          <CardContent className="p-6">
            {loading ? (
              <WizardSkeleton />
            ) : bootError && !status ? (
              <Alert variant="destructive">
                <X className="h-4 w-4" aria-hidden />
                <AlertTitle>Could not load the setup wizard</AlertTitle>
                <AlertDescription>{errorMessage(bootError)}</AlertDescription>
              </Alert>
            ) : (
              <>
                {step === 0 && (
                  <WelcomeStep
                    deploymentName={deploymentName}
                    onDeploymentName={setDeploymentName}
                    demoMode={demoMode}
                    onDemoMode={setDemoMode}
                  />
                )}
                {step === 1 && (
                  <SourcesStep
                    connectors={connectors}
                    sources={sources}
                    onChanged={refreshStatus}
                    demoMode={demoMode}
                  />
                )}
                {step === 2 && (
                  <KeysStep configured={configured} onSecretsSaved={refreshStatus} />
                )}
                {step === 3 && (
                  <ReviewStep
                    deploymentName={deploymentName}
                    demoMode={demoMode}
                    sources={sources}
                    configured={configured}
                  />
                )}
              </>
            )}
          </CardContent>
        </Card>

        {finishError ? (
          <Alert variant="destructive" className="mt-4">
            <X className="h-4 w-4" aria-hidden />
            <AlertTitle>Could not complete setup</AlertTitle>
            <AlertDescription>{errorMessage(finishError)}</AlertDescription>
          </Alert>
        ) : null}

        {/* footer nav */}
        <div className="mt-6 flex items-center justify-between gap-3">
          <Button variant="ghost" onClick={back} disabled={step === 0 || loading}>
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back
          </Button>
          {isLast ? (
            <Button onClick={finish} disabled={finishing || loading}>
              {finishing ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Check className="h-4 w-4" aria-hidden />
              )}
              Finish setup
            </Button>
          ) : (
            <Button onClick={next} disabled={loading}>
              Continue <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ loading skel = */

function WizardSkeleton() {
  return (
    <div className="space-y-4">
      <LoadingBar />
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

/* ============================================================ step: welcome */

const FEATURES: Array<{ icon: LucideIcon; title: string; body: string; tone: string }> = [
  {
    icon: ScanSearch,
    title: 'Read-only triage',
    body: 'The agent reads your security events with a scoped, read-only key and never modifies your pipeline.',
    tone: 'text-primary',
  },
  {
    icon: Gauge,
    title: 'Deterministic risk + LLM verdicts',
    body: 'Correlation and risk scoring are deterministic; the LLM proposes verdicts. Close/escalate decisions stay in code.',
    tone: 'text-info',
  },
  {
    icon: ClipboardCheck,
    title: 'Audited & cost-metered',
    body: 'Every agent action is audited and every model call is metered, so you keep full provenance and a cost ledger.',
    tone: 'text-success',
  },
];

function StepHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-xl font-bold tracking-tight text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function WelcomeStep({
  deploymentName,
  onDeploymentName,
  demoMode,
  onDemoMode,
}: {
  deploymentName: string;
  onDeploymentName: (v: string) => void;
  demoMode: boolean;
  onDemoMode: (v: boolean) => void;
}) {
  return (
    <div>
      <StepHeading
        title="Welcome to your Agentic SOC"
        description="This console turns raw alert volume into audited, cost-metered, human-reviewable cases. Let's get it connected to your data and models."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          return (
            <Card key={f.title} className="h-full">
              <CardContent className="space-y-2 p-4">
                <span
                  className={cn(
                    'inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card',
                    f.tone,
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <div className="text-sm font-semibold text-foreground">{f.title}</div>
                <p className="text-xs text-muted-foreground">{f.body}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-6 space-y-1.5">
        <Label htmlFor="wz-deployment">Deployment name</Label>
        <Input
          id="wz-deployment"
          value={deploymentName}
          onChange={(e) => onDeploymentName(e.target.value)}
          placeholder="e.g. Acme Production SOC"
        />
        <p className="text-xs text-muted-foreground">
          A label for this SOC deployment, shown across the console.
        </p>
      </div>

      <Card className="mt-5 bg-muted/40">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-info">
            <Beaker className="h-5 w-5" aria-hidden />
          </span>
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <Switch id="wz-demo" checked={demoMode} onCheckedChange={onDemoMode} />
              <Label htmlFor="wz-demo" className="cursor-pointer">
                Demo mode (explore with defaults, no real SIEM required)
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Demo mode is non-destructive: it seeds nothing and simply lets you click
              through the wizard and console using sensible defaults. You can still add a
              real source on the next step.
            </p>
          </div>
        </CardContent>
      </Card>

      {demoMode ? (
        <Alert className="mt-4">
          <Info className="h-4 w-4 text-info" aria-hidden />
          <AlertTitle>Demo mode is on</AlertTitle>
          <AlertDescription>
            You can finish setup without configuring a live source. The analytics
            surfaces will show empty states until a real source is connected.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/* ============================================================ step: sources */

function SourcesStep({
  connectors,
  sources,
  onChanged,
  demoMode,
}: {
  connectors: ConnectorManifest[];
  sources: SourceInstance[];
  onChanged: () => Promise<void> | void;
  demoMode: boolean;
}) {
  const [adding, setAdding] = React.useState(sources.length === 0);
  const [editing, setEditing] = React.useState<SourceInstance | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const reload = async () => {
    setAdding(false);
    setEditing(null);
    setError(null);
    await onChanged();
  };

  const setPrimary = async (s: SourceInstance) => {
    setBusyId(s.id);
    setError(null);
    try {
      await api.upsertSource({
        id: s.id,
        source_type: s.source_type,
        display_name: s.display_name,
        enabled: s.enabled,
        is_primary: true,
        ingest_mode: s.ingest_mode ?? null,
        config: (s.config as Record<string, unknown>) || {},
      });
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (s: SourceInstance) => {
    setBusyId(s.id);
    setError(null);
    try {
      await api.deleteSource(s.id);
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusyId(null);
    }
  };

  const showList = sources.length > 0 && !adding && !editing;

  return (
    <div>
      <StepHeading
        title="Connect your log sources"
        description="Add at least one source so the agent has events to triage. You can add several (an Elasticsearch, a Splunk, a webhook receiver…) and mark one as primary."
      />

      {demoMode ? (
        <Alert className="mb-4">
          <Beaker className="h-4 w-4 text-info" aria-hidden />
          <AlertTitle>Demo mode</AlertTitle>
          <AlertDescription>
            Adding a source is optional in demo mode — you can skip ahead.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive" className="mb-4">
          <X className="h-4 w-4" aria-hidden />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      ) : null}

      {showList ? (
        <div className="space-y-3">
          {sources.map((s) => {
            const meta = connectors.find((c) => c.source_type === s.source_type);
            const secretCount = s.configured_secrets?.length || 0;
            return (
              <Card key={s.id}>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-primary">
                    <Database className="h-5 w-5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* display name is operator input → plain text */}
                      <span className="truncate font-semibold text-foreground">
                        {s.display_name || meta?.display_name || s.source_type}
                      </span>
                      {s.is_primary ? (
                        <Badge variant="info">Primary</Badge>
                      ) : null}
                      {s.enabled === false ? (
                        <Badge variant="outline">Disabled</Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {humanizeToken(s.source_type)}
                      {s.ingest_mode ? ` · ${humanizeToken(s.ingest_mode)}` : ''}
                      {secretCount ? ` · ${secretCount} secret(s) set` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {!s.is_primary ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPrimary(s)}
                        disabled={busyId === s.id}
                      >
                        {busyId === s.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Star className="h-4 w-4" aria-hidden />
                        )}
                        Make primary
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>
                      <Pencil className="h-4 w-4" aria-hidden /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-critical"
                      onClick={() => remove(s)}
                      disabled={busyId === s.id}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden /> Remove
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Add another source
          </Button>
        </div>
      ) : null}

      {sources.length === 0 && !adding ? (
        <EmptyState
          icon={Database}
          title="No sources yet"
          description="Add your first source to give the agent events to triage."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Add a source
            </Button>
          }
        />
      ) : null}

      {adding || editing ? (
        <div className="rounded-lg border border-border bg-card p-4 sm:p-6">
          <SourceEditor
            connectors={connectors}
            existing={editing || undefined}
            defaultPrimary={sources.length === 0}
            onSaved={reload}
            onCancel={sources.length > 0 ? () => reload() : undefined}
          />
        </div>
      ) : null}
    </div>
  );
}

/* =============================================================== step: keys */

interface KeyField {
  key: keyof SecretsUpdate;
  label: string;
  help: string;
}

const KEY_FIELDS: KeyField[] = [
  {
    key: 'anthropic_api_key',
    label: 'Anthropic API key',
    help: 'Used for Claude models (router / investigator / etc.).',
  },
  {
    key: 'openai_api_key',
    label: 'OpenAI API key',
    help: 'Used for GPT models and (by default) embeddings.',
  },
  {
    key: 'embedding_api_key',
    label: 'Embedding API key (optional)',
    help: 'Leave blank to reuse the OpenAI key for RAG embeddings.',
  },
];

function SecretField({
  field,
  configured,
  value,
  onChange,
}: {
  field: KeyField;
  configured: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  const [reveal, setReveal] = React.useState(false);
  const id = `wz-secret-${field.key}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center gap-1.5">
        <span>{field.label}</span>
        {configured ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> configured
          </span>
        ) : null}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          placeholder={configured ? 'configured — type to replace' : 'Paste your key…'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          aria-label={reveal ? 'Hide key' : 'Show key'}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {reveal ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {field.help} Stored in the secret store; only ever shown as configured.
      </p>
    </div>
  );
}

function KeysStep({
  configured,
  onSecretsSaved,
}: {
  configured: ConfiguredStatus;
  onSecretsSaved: () => Promise<void> | void;
}) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [savedNote, setSavedNote] = React.useState<string | null>(null);

  const setValue = (k: string, v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    setSavedNote(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedNote(null);
    try {
      const body: SecretsUpdate = {};
      for (const f of KEY_FIELDS) {
        const v = (values[f.key] || '').trim();
        if (v) (body as Record<string, string>)[f.key] = v;
      }
      if (Object.keys(body).length === 0) {
        setSavedNote('No new keys entered.');
        return;
      }
      await api.updateSecrets(body);
      await onSecretsSaved();
      setValues({});
      setSavedNote('Provider keys saved.');
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const anyConfigured =
    Boolean(configured.anthropic_api_key) || Boolean(configured.openai_api_key);

  return (
    <div>
      <StepHeading
        title="LLM provider keys"
        description="Add at least one provider key (Anthropic or OpenAI) so the agent can reason. Per-role model selection lives in Settings."
      />

      {!anyConfigured ? (
        <Alert variant="warning" className="mb-4">
          <Info className="h-4 w-4" aria-hidden />
          <AlertTitle>At least one provider key is recommended</AlertTitle>
          <AlertDescription>
            Without a key, investigations fall back to a mock model. You can add a key
            now or later from Settings.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-4">
        {KEY_FIELDS.map((f) => (
          <SecretField
            key={f.key}
            field={f}
            configured={Boolean(configured[f.key])}
            value={values[f.key] || ''}
            onChange={(v) => setValue(f.key, v)}
          />
        ))}
      </div>

      <Separator className="my-5" />

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          Save provider keys
        </Button>
        {savedNote ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> {savedNote}
          </span>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive" className="mt-4">
          <X className="h-4 w-4" aria-hidden />
          <AlertTitle>Could not save keys</AlertTitle>
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/* ============================================================= step: review */

function ReviewRow({
  label,
  ok,
  value,
}: {
  label: string;
  ok: boolean;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span
        className={cn(
          'mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          ok ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
        )}
      >
        {ok ? <Check className="h-3.5 w-3.5" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-sm text-muted-foreground">{value}</div>
      </div>
    </div>
  );
}

function ReviewStep({
  deploymentName,
  demoMode,
  sources,
  configured,
}: {
  deploymentName: string;
  demoMode: boolean;
  sources: SourceInstance[];
  configured: ConfiguredStatus;
}) {
  const primary = sources.find((s) => s.is_primary);
  const hasKey =
    Boolean(configured.anthropic_api_key) || Boolean(configured.openai_api_key);

  return (
    <div>
      <StepHeading
        title="Review & finish"
        description="Confirm your setup. You can change any of this later from Settings or by re-running the wizard."
      />

      <Card>
        <CardContent className="divide-y divide-border p-4">
          <ReviewRow
            label="Deployment"
            ok={Boolean(deploymentName.trim())}
            // operator-supplied name → plain text
            value={deploymentName.trim() || 'Unnamed deployment'}
          />
          <ReviewRow
            label="Sources"
            ok={sources.length > 0 || demoMode}
            value={
              sources.length > 0 ? (
                <span>
                  {sources.length} source{sources.length === 1 ? '' : 's'} configured
                  {primary
                    ? ` · primary: ${primary.display_name || primary.source_type}`
                    : ' · no primary set'}
                </span>
              ) : demoMode ? (
                'None (demo mode — analytics will show empty states)'
              ) : (
                'No sources yet — add one before the agent can triage'
              )
            }
          />
          <ReviewRow
            label="Provider key"
            ok={hasKey}
            value={
              hasKey
                ? `Configured (${[
                    configured.anthropic_api_key ? 'Anthropic' : null,
                    configured.openai_api_key ? 'OpenAI' : null,
                  ]
                    .filter(Boolean)
                    .join(', ')})`
                : 'None set — the agent will fall back to a mock model'
            }
          />
          <ReviewRow
            label="Demo mode"
            ok
            value={demoMode ? 'On — explore with defaults' : 'Off — live triage'}
          />
        </CardContent>
      </Card>

      <Alert className="mt-4">
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
        <AlertTitle>Ready when you are</AlertTitle>
        <AlertDescription>
          Click <strong>Finish setup</strong> to open the console. Polling and triage
          start automatically once a primary source and a provider key are in place.
        </AlertDescription>
      </Alert>
    </div>
  );
}
