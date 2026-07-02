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
  Sparkles,
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
import { errorMessage } from '@/lib/errorMessage';
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

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { SourceEditor } from '@/soc/components/SourceEditor';
import { SecretField } from '@/soc/components/SecretField';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { LoadingBar } from '@/soc/components/LoadingBar';
import { useAuth } from '@/soc/auth';
import { useDemo, isDemoActive } from '@/soc/demo';
import { enableRecommendedAutomation } from './automation';

/* ----------------------------------------------------------------- helpers - */

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

  // Demo mode is an ADMIN action (POST /api/demo/enable is admin-gated server-side); the
  // toggle is only offered to a principal who can manage it. Auth off → everyone is admin.
  const { authEnabled, hasPermission } = useAuth();
  const { status: demoStatus, refresh: refreshDemo } = useDemo();
  const canManageDemo = !authEnabled || hasPermission('settings', 'manage');

  // Recommended-automation grants (the ReviewStep card + finish()). Tuning needs
  // `automation:manage`; the admin-gated campaigns PUT needs `cases:read` + `users:manage`
  // (require_admin === users:manage). Auth off / super_admin holds everything.
  const canTuneAutomation = !authEnabled || hasPermission('automation', 'manage');
  const canCampaignAutomation =
    !authEnabled || (hasPermission('cases', 'read') && hasPermission('users', 'manage'));
  const canRecommendAutomation = canTuneAutomation || canCampaignAutomation;
  const [enableAutomation, setEnableAutomation] = React.useState(true);

  // Shared, persisted-between-steps state.
  const [deploymentName, setDeploymentName] = React.useState('My SOC');
  // Reflects the LIVE demo tenant state (GET /api/demo/status), not a dead pref flag.
  const [demoMode, setDemoMode] = React.useState(false);
  const [demoBusy, setDemoBusy] = React.useState(false);
  // Demo toggle gets its OWN error channel so an enable/disable failure on the Welcome
  // step never masquerades as the finish-only "Could not complete setup" banner.
  const [demoError, setDemoError] = React.useState<unknown>(null);

  // Seed the toggle from the real demo status once it loads (so re-running the wizard
  // with demo already armed shows it ON).
  React.useEffect(() => {
    setDemoMode(isDemoActive(demoStatus));
  }, [demoStatus]);

  /**
   * Bug #3 fix — actually ARM/disarm demo mode instead of writing a dead `demo_mode`
   * pref. Turning it ON seeds the isolated, $0, reversible demo tenant via
   * POST /api/demo/enable; OFF tears it down via POST /api/demo/disable. Either way we
   * re-fetch the shared demo status so the banner + every surface update. Optimistic UI
   * (flip immediately) with rollback on failure.
   */
  const onDemoMode = React.useCallback(
    async (nextOn: boolean) => {
      if (demoBusy || !canManageDemo) return;
      setDemoBusy(true);
      setDemoError(null);
      setDemoMode(nextOn); // optimistic
      try {
        const st = nextOn ? await api.demo.enable({}) : await api.demo.disable();
        setDemoMode(isDemoActive(st));
      } catch (e) {
        setDemoMode(!nextOn); // rollback
        setDemoError(e); // demo-specific channel, NOT the finish banner
      } finally {
        setDemoBusy(false);
        void refreshDemo();
      }
    },
    [demoBusy, canManageDemo, refreshDemo],
  );

  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  const [connectors, setConnectors] = React.useState<ConnectorManifest[]>([]);
  const [sources, setSources] = React.useState<SourceInstance[]>([]);

  // Provider-key draft is LIFTED to the wizard so it survives the KeysStep unmounting
  // on step change (the step is conditionally rendered) — otherwise a beginner who
  // pastes a key and clicks the prominent "Continue" (not "Save") silently loses it.
  const [keyValues, setKeyValues] = React.useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = React.useState(false);
  const [keysError, setKeysError] = React.useState<unknown>(null);
  const [keysSavedNote, setKeysSavedNote] = React.useState<string | null>(null);

  const configured: ConfiguredStatus = status?.configured || {};

  const refreshStatus = React.useCallback(async () => {
    const [st, src] = await Promise.all([api.setupStatus(), api.listSources()]);
    setStatus(st);
    setSources(src.sources);
  }, []);

  const setKeyValue = React.useCallback((k: string, v: string) => {
    setKeyValues((prev) => ({ ...prev, [k]: v }));
    setKeysSavedNote(null);
  }, []);

  /** Persist any typed provider keys. Returns false on failure so nav can stay put. */
  const saveKeys = React.useCallback(async (): Promise<boolean> => {
    setSavingKeys(true);
    setKeysError(null);
    setKeysSavedNote(null);
    try {
      const body: SecretsUpdate = {};
      for (const f of KEY_FIELDS) {
        const v = (keyValues[f.key] || '').trim();
        if (v) (body as Record<string, string>)[f.key] = v;
      }
      if (Object.keys(body).length === 0) {
        setKeysSavedNote('No new keys entered.');
        return true;
      }
      await api.updateSecrets(body);
      await refreshStatus();
      setKeyValues({});
      setKeysSavedNote('Provider keys saved.');
      return true;
    } catch (e) {
      setKeysError(e);
      return false;
    } finally {
      setSavingKeys(false);
    }
  }, [keyValues, refreshStatus]);

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
      // Persist the deployment name. Demo mode is NOT a pref flag — it is armed live via
      // POST /api/demo/enable from the toggle (bug #3), so we no longer write a dead
      // `demo_mode` key here.
      await api.putSettings({
        deployment_name: deploymentName,
      } as Partial<Preferences>);
      // Recommended automation: BEST-EFFORT + never blocks completion. The helper
      // catches its own failures (#3-safe: tuning keeps shadow-eval on & routes
      // suppression to HITL; campaigns are advisory) so setup always finishes.
      if (enableAutomation && canRecommendAutomation) {
        await enableRecommendedAutomation({
          tuning: canTuneAutomation,
          campaigns: canCampaignAutomation,
        });
      }
      await api.completeSetup();
      onComplete();
    } catch (e) {
      setFinishError(e);
      setFinishing(false);
    }
  };

  const next = React.useCallback(async () => {
    // Auto-save any typed-but-unsaved provider keys before leaving the Keys step so a
    // beginner who clicks the prominent "Continue" (not "Save") doesn't silently lose
    // them. A save failure keeps us on the step; the inline error explains why.
    if (step === 2 && Object.values(keyValues).some((v) => v.trim())) {
      const ok = await saveKeys();
      if (!ok) return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, [step, keyValues, saveKeys]);
  const back = () => setStep((s) => Math.max(s - 1, 0));
  const isLast = step === STEPS.length - 1;

  /* --------------------------------------------------------------- render -- */

  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto w-full max-w-5xl animate-fade-in px-4 py-8 sm:px-6 sm:py-12">
        <PageHeader
          variant="hero"
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

        {/* stepper — calm, connected; no heavy pill borders */}
        <nav aria-label="Setup steps" className="mt-8">
          <ol className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            {STEPS.map((s, i) => {
              const state =
                i < step ? 'complete' : i === step ? 'current' : 'incomplete';
              const Icon = s.icon;
              return (
                <li key={s.key} className="flex flex-1 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setStep(i)}
                    aria-current={state === 'current' ? 'step' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      state === 'current'
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
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
                  {i < STEPS.length - 1 ? (
                    <span
                      className="hidden h-px w-4 shrink-0 bg-border sm:block"
                      aria-hidden
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </nav>

        {/* body */}
        <Card className="mt-6 shadow-elev1">
          <CardContent className="p-6 sm:p-8">
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
                    onDemoMode={onDemoMode}
                    canManageDemo={canManageDemo}
                    demoBusy={demoBusy}
                    demoError={demoError}
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
                  <KeysStep
                    configured={configured}
                    values={keyValues}
                    onChange={setKeyValue}
                    onSave={saveKeys}
                    saving={savingKeys}
                    error={keysError}
                    savedNote={keysSavedNote}
                  />
                )}
                {step === 3 && (
                  <ReviewStep
                    deploymentName={deploymentName}
                    demoMode={demoMode}
                    sources={sources}
                    configured={configured}
                    showAutomation={canRecommendAutomation}
                    canCampaignAutomation={canCampaignAutomation}
                    enableAutomation={enableAutomation}
                    onEnableAutomation={setEnableAutomation}
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
            <Button onClick={() => void next()} disabled={loading || savingKeys}>
              {savingKeys ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
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
    <div className="mb-6">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function WelcomeStep({
  deploymentName,
  onDeploymentName,
  demoMode,
  onDemoMode,
  canManageDemo,
  demoBusy,
  demoError,
}: {
  deploymentName: string;
  onDeploymentName: (v: string) => void;
  demoMode: boolean;
  onDemoMode: (v: boolean) => void;
  /** Only an admin (or auth-off) may arm demo mode — hide the toggle otherwise. */
  canManageDemo: boolean;
  /** True while an enable/disable call is in flight (disables the switch). */
  demoBusy: boolean;
  /** A demo enable/disable failure — shown INLINE here, never as the finish banner. */
  demoError: unknown;
}) {
  return (
    <div>
      <StepHeading
        title="Welcome to your Agentic SOC"
        description="This console turns raw alert volume into audited, cost-metered, human-reviewable cases. Let's get it connected to your data and models."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          return (
            <Card key={f.title} className="h-full">
              <CardContent className="space-y-2.5 p-5">
                <span
                  className={cn(
                    'inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface',
                    f.tone,
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <div className="text-sm font-semibold text-foreground">{f.title}</div>
                <p className="text-xs leading-relaxed text-muted-foreground">{f.body}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-8 space-y-1.5">
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

      {/* Demo mode is an ADMIN action — the toggle is hidden entirely for a principal
          who can't manage it (bug #3). */}
      {canManageDemo ? (
        <Card className="mt-6 bg-muted/40">
          <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-info">
              <Beaker className="h-5 w-5" aria-hidden />
            </span>
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <Switch
                  id="wz-demo"
                  checked={demoMode}
                  disabled={demoBusy}
                  onCheckedChange={(v) => void onDemoMode(v)}
                />
                <Label htmlFor="wz-demo" className="cursor-pointer">
                  Demo mode (explore with realistic sample data, no real SIEM required)
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Turning this on seeds an isolated, $0, fully reversible synthetic tenant so
                you can explore the console immediately. It touches no real data and can be
                switched off (and wiped) any time from Settings › Experimental. You can
                still add a real source on the next step.
              </p>
              {demoError ? (
                <Alert variant="destructive" className="mt-2">
                  <X className="h-4 w-4" aria-hidden />
                  <AlertTitle>Couldn&apos;t switch demo mode</AlertTitle>
                  <AlertDescription>{errorMessage(demoError)}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {demoMode ? (
        <Alert className="mt-4">
          <Info className="h-4 w-4 text-info" aria-hidden />
          <AlertTitle>Demo mode is on</AlertTitle>
          <AlertDescription>
            The console is populated with isolated sample cases and activity. You can finish
            setup without configuring a live source; switch demo off from Settings ›
            Experimental to clear it.
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
  // Destructive removal is gated behind the shared ConfirmDialog (matching the hardened
  // Sources page) so a single misclick can't wipe a configured source + its secrets.
  const [pendingDelete, setPendingDelete] = React.useState<SourceInstance | null>(null);

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
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
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
                      className="text-critical-text"
                      onClick={() => setPendingDelete(s)}
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
        <Card className="p-4 sm:p-6">
          <SourceEditor
            connectors={connectors}
            existing={editing || undefined}
            defaultPrimary={sources.length === 0}
            onSaved={reload}
            onCancel={sources.length > 0 ? () => reload() : undefined}
          />
        </Card>
      ) : null}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title="Remove this source?"
        // display name is operator input → rendered as plain text by ConfirmDialog (#9)
        description={
          pendingDelete
            ? `"${pendingDelete.display_name || pendingDelete.source_type}" and its configuration${
                pendingDelete.configured_secrets?.length ? ' (including its stored secrets)' : ''
              } will be deleted. This can't be undone.`
            : ''
        }
        destructive
        confirmLabel="Remove source"
        onConfirm={() => {
          const s = pendingDelete;
          setPendingDelete(null);
          if (s) void remove(s);
        }}
      />
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

function KeysStep({
  configured,
  values,
  onChange,
  onSave,
  saving,
  error,
  savedNote,
}: {
  configured: ConfiguredStatus;
  /** The lifted key draft (survives step changes). */
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Persist the draft (also invoked by Continue). */
  onSave: () => Promise<boolean> | void;
  saving: boolean;
  error: unknown;
  savedNote: string | null;
}) {
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

      {/* Uses the SHARED SecretField primitive (Field + IconButton a11y wiring,
          autoComplete="new-password", boolean-only status) — no re-rolled input (#10). */}
      <div className="space-y-4">
        {KEY_FIELDS.map((f) => (
          <SecretField
            key={f.key}
            label={f.label}
            description={`${f.help} Stored in the secret store; only ever shown as configured.`}
            configured={Boolean(configured[f.key])}
            value={values[f.key] || ''}
            onChange={(v) => onChange(f.key, v)}
          />
        ))}
      </div>

      <Separator className="my-5" />

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void onSave()} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          Save provider keys
        </Button>
        {savedNote ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-success-text">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> {savedNote}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Continue also saves any key you&apos;ve entered here.
      </p>

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
  showAutomation,
  canCampaignAutomation,
  enableAutomation,
  onEnableAutomation,
}: {
  deploymentName: string;
  demoMode: boolean;
  sources: SourceInstance[];
  configured: ConfiguredStatus;
  /** Show the recommended-automation card only when the principal can enable ≥1 engine. */
  showAutomation: boolean;
  /** Whether the admin-gated campaigns line is also offered. */
  canCampaignAutomation: boolean;
  enableAutomation: boolean;
  onEnableAutomation: (v: boolean) => void;
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
        <CardContent className="divide-y divide-border p-5">
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

      {/* Recommended automation — the one-click beginner self-improvement journey. On
          Finish, when checked, we enable the #3-safe engines (FP-noise tuning + advisory
          campaign grouping). Default-on; hidden when the principal can't enable any. */}
      {showAutomation ? (
        <Card className="mt-4 bg-muted/40">
          <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
              <Sparkles className="h-5 w-5" aria-hidden />
            </span>
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="wz-automation"
                  checked={enableAutomation}
                  onCheckedChange={onEnableAutomation}
                />
                <Label htmlFor="wz-automation" className="cursor-pointer">
                  Let this SOC improve itself over time (recommended)
                </Label>
              </div>
              <ul className="ml-0.5 space-y-1 text-xs text-muted-foreground">
                <li>
                  Reduce false-positive noise from your closed cases — nightly and
                  shadow-checked, so a threshold change can never hide a real threat.
                </li>
                {canCampaignAutomation ? (
                  <li>Group related cases into campaigns (daily, advisory).</li>
                ) : null}
              </ul>
              <p className="text-2xs text-muted-foreground">
                This only adjusts what gets investigated — never how a case is closed or
                escalated. That decision stays deterministic (non-negotiable&nbsp;#3). You
                can change it any time in Settings.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

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
