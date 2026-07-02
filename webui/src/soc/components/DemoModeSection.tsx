/**
 * Experimental › Demo Mode — the Settings control (Round-2 Wave 5).
 *
 * Arms / re-seeds / exits the first-class, REVERSIBLE demo tenant (off | seeded |
 * live). Seeded loads a static synthetic history; live additionally simulates new
 * incidents on a tick. While armed, every read endpoint serves from an isolated
 * in-memory store ($0 mock LLM, sandboxed policy copy) so real cases are hidden and
 * the live durable cursor / stores / policy are untouched. Exiting hard-deletes the
 * synthetic data by run_id and restores the real state intact.
 *
 * This is a clearly-labelled EXPERIMENTAL control, gated by settings:manage. All
 * mutations refresh the shared <DemoProvider> so the shell banner / SAMPLE badges /
 * "(simulated)" cost suffix / muted health chip flip with it. Hooks live above any
 * early return (React #310). No secrets; synthetic data is a backend concern.
 */
import * as React from 'react';
import { FlaskConical, Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { DemoConfig, DemoMode } from '@/lib/types';
import { cn } from '@/lib/cn';
import { useDemo } from '@/soc/demo';

import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { NumberField } from '@/soc/components/NumberField';
import { LabeledSlider } from '@/soc/components/LabeledSlider';

const MODES: Array<{ value: Exclude<DemoMode, 'off'>; label: string; help: string }> = [
  {
    value: 'seeded',
    label: 'Seeded',
    help: 'Load a static synthetic history (old + recent cases). Nothing changes after seeding.',
  },
  {
    value: 'live',
    label: 'Live',
    help: 'Seed the history AND simulate new incidents on a tick, so the console feels alive.',
  },
];

export function DemoModeSection() {
  const { status, active, refresh } = useDemo();

  // Draft knobs for ARMING demo (only consumed by enable()). Seed defaults to the
  // current run's seed when active so a Reset/re-enable is reproducible.
  const [mode, setMode] = React.useState<Exclude<DemoMode, 'off'>>('seeded');
  const [seed, setSeed] = React.useState<number>(1337);
  const [historyDays, setHistoryDays] = React.useState<number>(14);
  const [tickSeconds, setTickSeconds] = React.useState<number>(10);
  const [incidentRatePct, setIncidentRatePct] = React.useState<number>(5);
  const [busy, setBusy] = React.useState<'enable' | 'reset' | 'disable' | null>(null);

  // When the live status changes (e.g. another tab armed it), reflect the seed so
  // the form mirrors the active run. Effect is unconditional (above any return).
  React.useEffect(() => {
    if (active) {
      if (typeof status.seed === 'number') setSeed(status.seed);
      if (typeof status.history_days === 'number') setHistoryDays(status.history_days);
      if (typeof status.tick_seconds === 'number') setTickSeconds(status.tick_seconds);
      if (typeof status.incident_rate === 'number')
        setIncidentRatePct(Math.round(status.incident_rate * 100));
      if (status.mode === 'live' || status.mode === 'seeded') setMode(status.mode);
    }
  }, [active, status.seed, status.history_days, status.tick_seconds, status.incident_rate, status.mode]);

  const onEnable = React.useCallback(async () => {
    const config: DemoConfig = {
      mode,
      seed,
      history_days: historyDays,
      tick_seconds: tickSeconds,
      incident_rate: incidentRatePct / 100,
    };
    setBusy('enable');
    try {
      await api.demo.enable(config);
      await refresh();
      toast.success(`Demo mode enabled (${mode}).`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not enable demo mode.');
    } finally {
      setBusy(null);
    }
  }, [mode, seed, historyDays, tickSeconds, incidentRatePct, refresh]);

  const onReset = React.useCallback(async () => {
    setBusy('reset');
    try {
      await api.demo.reset();
      await refresh();
      toast.success('Demo data re-seeded from the same seed.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reset demo data.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const onDisable = React.useCallback(async () => {
    setBusy('disable');
    try {
      await api.demo.disable();
      await refresh();
      toast.success('Demo mode exited — synthetic data cleared, real state restored.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not exit demo mode.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="space-y-1 border-b border-border pb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Demo mode</h2>
          <Badge variant="outline" className="gap-1 border-warning/50 bg-warning/10 text-warning">
            <FlaskConical className="h-3 w-3" aria-hidden />
            Experimental
          </Badge>
          {active ? (
            <Badge variant="warning" className="gap-1">
              {status.mode === 'live' ? 'Live' : 'Seeded'} · active
            </Badge>
          ) : null}
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Populate the console with a realistic, fully synthetic dataset so you can explore
          every surface without connecting a live source.
        </p>
      </div>

      {/* The safety contract — isolation, $0, reversibility. */}
      <Alert>
        <FlaskConical className="h-4 w-4" aria-hidden />
        <AlertTitle>Isolated, free, and fully reversible</AlertTitle>
        <AlertDescription>
          Demo data lives in a separate in-memory store and runs through a deterministic mock
          model, so it{' '}
          <strong className="font-semibold text-foreground">costs nothing</strong> and the
          deterministic close/escalate logic runs against a{' '}
          <strong className="font-semibold text-foreground">sandboxed policy copy</strong> —
          your live policy is never changed. While demo is on, your real cases are{' '}
          <strong className="font-semibold text-foreground">hidden</strong> and real-write
          actions are disabled. Exiting{' '}
          <strong className="font-semibold text-foreground">hard-deletes</strong> the synthetic
          data and restores your real state exactly as it was. The durable poll cursor and your
          real stores are never touched.
        </AlertDescription>
      </Alert>

      {!active ? (
        <>
          {/* Mode picker */}
          <div className="space-y-3">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Mode
            </Label>
            <div className="grid gap-3 sm:grid-cols-2">
              {MODES.map((m) => {
                const selected = mode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setMode(m.value)}
                    aria-pressed={selected}
                    className={cn(
                      'rounded-md border px-4 py-3 text-left transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-surface hover:border-border/80',
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span
                        className={cn(
                          'inline-block h-2 w-2 rounded-full',
                          selected ? 'bg-primary' : 'bg-muted-foreground/40',
                        )}
                        aria-hidden
                      />
                      {m.label}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      {m.help}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Knobs — shared NumberField (+/- steppers, clamp-on-blur) + LabeledSlider,
              matching Settings › Detection so the demo config uses the same primitives. */}
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <NumberField
              label="History"
              unit="days"
              value={historyDays}
              min={0}
              max={90}
              onChange={setHistoryDays}
              description="Days of trailing synthetic history to pre-generate."
            />
            <NumberField
              label="Tick"
              unit="s"
              value={tickSeconds}
              min={1}
              onChange={setTickSeconds}
              description="Live mode only — how often a new synthetic batch arrives."
            />
            <NumberField
              label="Seed"
              value={seed}
              min={0}
              onChange={setSeed}
              description="Deterministic — the same seed reproduces the same data."
            />
            <LabeledSlider
              label="Incident rate"
              value={incidentRatePct}
              onChange={setIncidentRatePct}
              min={0}
              max={50}
              step={1}
              formatValue={(v) => `${v}%`}
              description="Per-tick chance of igniting an attack storyline (live mode)."
            />
          </div>

          <Button onClick={() => void onEnable()} disabled={busy !== null}>
            <Play className="h-4 w-4" aria-hidden />
            {busy === 'enable' ? 'Enabling…' : 'Enable demo mode'}
          </Button>
        </>
      ) : (
        <>
          {/* Active summary */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryTile label="Mode" value={status.mode === 'live' ? 'Live' : 'Seeded'} />
            <SummaryTile label="Seed" value={String(status.seed ?? seed)} mono />
            <SummaryTile
              label="History"
              value={`${status.history_days ?? historyDays} days`}
            />
            <SummaryTile
              label="Synthetic cases"
              value={typeof status.case_count === 'number' ? String(status.case_count) : '—'}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void onReset()} disabled={busy !== null}>
              <RotateCcw
                className={cn('h-4 w-4', busy === 'reset' && 'animate-spin')}
                aria-hidden
              />
              Reset (re-seed)
            </Button>
            <Button
              variant="outline"
              className="border-critical/40 text-critical hover:bg-critical/10 hover:text-critical"
              onClick={() => void onDisable()}
              disabled={busy !== null}
            >
              {busy === 'disable' ? 'Exiting…' : 'Exit & clear'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-sm font-semibold text-foreground', mono && 'font-mono')}>
        {value}
      </p>
    </div>
  );
}

export default DemoModeSection;
