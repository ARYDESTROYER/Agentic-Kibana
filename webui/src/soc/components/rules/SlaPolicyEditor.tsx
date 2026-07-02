/**
 * SlaPolicyEditor — the per-priority SLA response/resolution editor (G6 R6,
 * DESIGN_STANDARD §8). Writes `Preferences.sla` (a `SlaPolicy`) via deep-merge PUT.
 *
 * ADVISORY only (#3): SLA timers/badges are presentation — they surface at-risk /
 * breached state + feed MTTR reporting; they NEVER gate the deterministic decision,
 * never set a case status, and never bill an LLM. Every field is `Field`/label-wrapped
 * (a11y); the timezone is a plain IANA string rendered as plain text (#9).
 *
 * CONTROLLED: `policy` + `onChange`; the host owns dirty/save (StickySaveBar).
 */
import { Clock, Info } from 'lucide-react';
import type { SlaPolicy, SlaTarget } from '@/lib/types';

import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import { Label } from '@/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Field } from '@/soc/components/Field';
import { NumberField } from '@/soc/components/NumberField';

/** The four ITIL priority tiers, in descending urgency. */
const PRIORITY_LEVELS = ['P1', 'P2', 'P3', 'P4'] as const;

const PRIORITY_LABEL: Record<string, string> = {
  P1: 'P1 — Critical',
  P2: 'P2 — High',
  P3: 'P3 — Medium',
  P4: 'P4 — Low',
};

/**
 * Per-level fallback targets — MIRROR the backend `SlaPolicy` defaults
 * (`config.py`: P1 15/240, P2 30/480, P3 120/1440, P4 480/4320). Shown for any level
 * whose target is absent from the loaded policy so the editor never implies a flat
 * 60/1440 the system does not actually enforce.
 */
const DEFAULT_TARGETS: Record<string, { response: number; resolve: number }> = {
  P1: { response: 15, resolve: 240 },
  P2: { response: 30, resolve: 480 },
  P3: { response: 120, resolve: 1440 },
  P4: { response: 480, resolve: 4320 },
};

export interface SlaPolicyEditorProps {
  policy: SlaPolicy;
  onChange: (next: SlaPolicy) => void;
  disabled?: boolean;
}

export function SlaPolicyEditor({ policy, onChange, disabled }: SlaPolicyEditorProps) {
  const enabled = policy.enabled ?? false;
  const targets = policy.targets ?? {};
  const controlsDisabled = disabled || !enabled;

  const setTarget = (level: string, patch: Partial<SlaTarget>) => {
    const cur = targets[level] ?? {};
    onChange({ ...policy, targets: { ...targets, [level]: { ...cur, ...patch } } });
  };

  return (
    <div className="space-y-5">
      <Alert>
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>SLA targets are advisory</AlertTitle>
        <AlertDescription>
          Response/resolution timers drive at-risk and breached badges plus MTTR
          reporting. They never change a case&apos;s verdict or the deterministic
          close/escalate decision.
        </AlertDescription>
      </Alert>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="sla-enabled" className="text-sm font-medium">
            Enable SLA tracking
          </Label>
          <p className="text-xs text-muted-foreground">
            When off, no SLA badges or timers are shown (today&apos;s default).
          </p>
        </div>
        <Switch
          id="sla-enabled"
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(v) => onChange({ ...policy, enabled: v })}
        />
      </div>

      <div className="space-y-4">
        {PRIORITY_LEVELS.map((level) => {
          const t = targets[level] ?? {};
          const def = DEFAULT_TARGETS[level];
          return (
            <div
              key={level}
              className="rounded-md border border-border bg-surface px-4 py-3"
            >
              <div className="mb-3 flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium text-foreground">
                  {PRIORITY_LABEL[level]}
                </span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  label="Response target"
                  description="Minutes to first response."
                  value={t.response_minutes ?? def.response}
                  min={0}
                  unit="min"
                  disabled={controlsDisabled}
                  onChange={(v) => setTarget(level, { response_minutes: v })}
                />
                <NumberField
                  label="Resolution target"
                  description="Minutes to resolution."
                  value={t.resolve_minutes ?? def.resolve}
                  min={0}
                  unit="min"
                  disabled={controlsDisabled}
                  onChange={(v) => setTarget(level, { resolve_minutes: v })}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Timezone + business-hours are stacked as full-width rows rather than paired in a
          grid with a brittle `pt-6` offset — the toggle no longer misaligns when the
          timezone helper text wraps to two lines on a narrow column (#35). */}
      <Field
        label="Timezone"
        description="IANA timezone the SLA clock runs in (e.g. UTC, America/New_York)."
      >
        <Input
          value={policy.timezone ?? 'UTC'}
          disabled={controlsDisabled}
          placeholder="UTC"
          onChange={(e) => onChange({ ...policy, timezone: e.target.value })}
        />
      </Field>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="sla-business-hours" className="text-sm">
            Business hours only
          </Label>
          <p className="text-xs text-muted-foreground">
            When on, the SLA clock pauses outside business hours (default 24×7).
          </p>
        </div>
        <Switch
          id="sla-business-hours"
          checked={policy.business_hours_only ?? false}
          disabled={controlsDisabled}
          onCheckedChange={(v) => onChange({ ...policy, business_hours_only: v })}
        />
      </div>
    </div>
  );
}

SlaPolicyEditor.displayName = 'SlaPolicyEditor';
