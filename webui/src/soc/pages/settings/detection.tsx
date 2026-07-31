/**
 * Detection & correlation settings section (Round-5 Sett-A decomposition +
 * Round-5 R1 auto-close dead-field fix).
 *
 * Governs clustering, the deterministic risk weights, escalation, the auto-close
 * policy, and opt-in cross-source correlation.
 *
 * ⛔ ROUND-5 R1 (bug #1): the auto-close editor used to bind the DEAD
 * `prefs.fp_auto_close` scalar, while `decide()` (case_manager.py) reads
 * `prefs.auto_close` — so the flagship autonomy toggle did NOTHING. This section now
 * writes `prefs.auto_close.<verdict>` (the field `decide()` actually reads) via one
 * reusable `<VerdictAutoClose>` sub-editor rendered TWICE (false_positive +
 * true_positive). `fp_auto_close` is intentionally left in place (the
 * `_migrate_fp_auto_close` legacy path still consumes it); we simply no longer edit
 * it here.
 *
 * INVARIANT #3: this section only WRITES config. The close/escalate decision is
 * always made by deterministic code (`decide()`) against that config — never by these
 * controls. TRUE_POSITIVE auto-close is an explicit opt-in (OFF by default) and
 * NEEDS_HUMAN NEVER auto-closes (code-enforced; shown here as a locked, read-only row).
 */
import {
  Activity,
  Gauge,
  Info,
  Lock,
  Network,
  RotateCcw,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import { humanizeToken } from '@/lib/format';
import type { AutoClosePolicy, RiskWeights, VerdictAutoClose as VerdictAutoCloseConfig } from '@/lib/types';
import { cn } from '@/lib/cn';

import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { SettingsGrid, SettingsCard, type SettingsTOCItem } from '@/soc/components/SettingsGrid';
import { NumberField } from '@/soc/components/NumberField';
import { LabeledSlider } from '@/soc/components/LabeledSlider';
import { Field } from '@/soc/components/Field';
import { SCORE_BANDS, type ScoreBand } from '@/soc/components/palette';
import { AssetCriticalityEditor } from '@/soc/components/rules';

import { SectionShell, NumPref, SwitchPref, type SecProps } from './primitives';

/* --------------------------------------------------------------------------- */
/* Risk-weight mixer — a slider-per-factor view of the deterministic risk model. */
/* Binds to the REAL `prefs.risk_weights` fields; the per-factor "% of score" is  */
/* the honest normalised share (compute_risk() normalises by the weight sum), and */
/* the score-band scale uses the ONE canonical ladder from palette (22/48/74).    */
/* --------------------------------------------------------------------------- */

const RISK_WEIGHT_KEYS = ['volume', 'velocity', 'reputation', 'diversity', 'asset_criticality'] as const;
type RiskWeightKey = (typeof RISK_WEIGHT_KEYS)[number];

/** Defaults mirror `config.py` `RiskWeights` — used to fill an unset field for display
 *  and to power "Reset to defaults". Kept in sync with the backend (additive-safe). */
const RISK_WEIGHT_DEFAULTS: Record<RiskWeightKey, number> = {
  volume: 0.25,
  velocity: 0.2,
  reputation: 0.3,
  diversity: 0.15,
  asset_criticality: 0.1,
};

const RISK_WEIGHT_META: Record<RiskWeightKey, { icon: LucideIcon; help: string }> = {
  volume: { icon: Activity, help: 'How many alerts clustered into the case.' },
  velocity: { icon: Gauge, help: 'How fast those alerts arrived (burst rate).' },
  reputation: { icon: ShieldAlert, help: 'Threat-intel reputation of the involved indicators.' },
  diversity: { icon: Network, help: 'How many distinct entities/signals the cluster spans.' },
  asset_criticality: { icon: Server, help: 'Criticality of the assets involved (from Asset criticality).' },
};

const BAND_ORDER: ScoreBand[] = ['low', 'medium', 'high', 'critical'];
const BAND_CLS: Record<ScoreBand, string> = {
  low: 'bg-low',
  medium: 'bg-medium',
  high: 'bg-high',
  critical: 'bg-critical',
};

/** A read-only reference of the ONE canonical 0–100 score-band ladder (palette.SCORE_BANDS). */
function ScoreScaleBar() {
  const total = 100;
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-foreground">Score bands (0–100)</p>
      <div className="flex h-2 overflow-hidden rounded-full" aria-hidden>
        {BAND_ORDER.map((b) => {
          const [from, to] = SCORE_BANDS[b];
          return (
            <span
              key={b}
              className={cn('h-full', BAND_CLS[b])}
              style={{ width: `${((to - from + 1) / total) * 100}%` }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-2xs text-muted-foreground">
        {BAND_ORDER.map((b) => {
          const [from, to] = SCORE_BANDS[b];
          return (
            <span key={b} className="capitalize">
              {b} <span className="tabular-nums">{from}–{to}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function RiskWeightMixer({
  weights,
  onChange,
}: {
  weights: RiskWeights;
  onChange: (key: RiskWeightKey, value: number) => void;
}) {
  const values = RISK_WEIGHT_KEYS.map((k) => Number(weights[k] ?? RISK_WEIGHT_DEFAULTS[k]));
  const sum = values.reduce((a, b) => a + Math.max(0, b), 0);
  return (
    <div className="space-y-5">
      {RISK_WEIGHT_KEYS.map((k, i) => {
        const v = values[i];
        const Icon = RISK_WEIGHT_META[k].icon;
        const share = sum > 0 ? Math.round((Math.max(0, v) / sum) * 100) : 0;
        return (
          <LabeledSlider
            key={k}
            label={
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                {humanizeToken(k)}
              </span>
            }
            description={RISK_WEIGHT_META[k].help}
            value={v}
            min={0}
            max={1}
            step={0.05}
            formatValue={(x) => x.toFixed(2)}
            labelAction={
              <span className="font-mono text-2xs font-medium tabular-nums text-muted-foreground">
                {share}% of score
              </span>
            }
            onChange={(x) => onChange(k, x)}
          />
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <span>Weights are normalised to a 0–100 score (they need not sum to 1).</span>
        <span className="tabular-nums">
          Total weight <span className="font-semibold text-foreground">{sum.toFixed(2)}</span>
        </span>
      </div>
      <ScoreScaleBar />
    </div>
  );
}

const DETECTION_TOC: SettingsTOCItem[] = [
  { anchor: 'detection-correlation', label: 'Correlation', icon: Workflow },
  { anchor: 'detection-risk', label: 'Risk weights', icon: SlidersHorizontal },
  { anchor: 'detection-asset', label: 'Asset criticality', icon: Server },
  { anchor: 'detection-escalation', label: 'Escalation', icon: ShieldAlert },
  { anchor: 'detection-autoclose', label: 'Auto-close', icon: ShieldCheck },
  { anchor: 'detection-crosssource', label: 'Cross-source', icon: Network },
];

export function DetectionSection({ prefs, update }: SecProps) {
  const corr = prefs.default_correlation || {};
  const weights = prefs.risk_weights || {};
  const resetWeights = () => update({ risk_weights: { ...RISK_WEIGHT_DEFAULTS } });
  return (
    <SectionShell
      // Match the Round-5 rail label (SETTINGS_SECTIONS_META title = 'Detection') so the
      // nav item and the body heading agree; the longer phrasing lives in `sub`.
      title="Detection"
      sub="Tune how detections are scored and triaged: how alerts cluster into cases, how risk is scored, when a case escalates, and when (if ever) the agent may auto-close a confident false positive."
      toc={DETECTION_TOC}
      rail
    >
      {/* Single-column stack: the rail already consumes horizontal room, so the
          viewport-based 2/3-col grid would crush non-wide cards — force one column. */}
      <SettingsGrid className="lg:grid-cols-1 xl:grid-cols-1">
        <SettingsCard
          anchor="detection-correlation"
          title="Correlation"
          icon={Workflow}
          description="Alerts that share an entity within the window cluster into one case. The cluster signature keeps cases idempotent (no dups)."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <NumPref label="Threshold (N)" value={corr.n} onChange={(v) => update({ default_correlation: { ...corr, n: v } })} />
            <NumPref label="Window (seconds)" value={corr.window_seconds} onChange={(v) => update({ default_correlation: { ...corr, window_seconds: v } })} />
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="detection-risk"
          title="Risk weights"
          icon={SlidersHorizontal}
          description="How the deterministic risk score is built. Each weight's share of the score is shown live; values are auto-normalised to 0–100 and the model never sees raw logs."
          wide="full"
          actions={
            <Button variant="outline" size="sm" onClick={resetWeights}>
              <RotateCcw aria-hidden />
              Reset to defaults
            </Button>
          }
        >
          <RiskWeightMixer
            weights={weights}
            onChange={(k, v) => update({ risk_weights: { ...weights, [k]: v } })}
          />
        </SettingsCard>

        <SettingsCard
          anchor="detection-asset"
          title="Asset criticality"
          icon={Server}
          description="Mark internal assets (CIDR ranges and exact hosts/users/IPs) as high-value. Feeds the deterministic risk model's asset-criticality weight above — higher criticality only RAISES risk; it never auto-closes or escalates a case (#3)."
          wide="full"
        >
          <AssetCriticalityEditor
            networks={prefs.asset_networks ?? []}
            onNetworksChange={(next) => update({ asset_networks: next })}
            exact={prefs.asset_criticality ?? {}}
            onExactChange={(next) => update({ asset_criticality: next })}
          />
        </SettingsCard>

        <SettingsCard
          anchor="detection-escalation"
          title="Escalation"
          icon={ShieldAlert}
          description="The confidence below which a case is escalated for a human, and the severity considered critical."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <NumPref label="Escalation confidence" value={prefs.escalation_confidence} step={0.05} onChange={(v) => update({ escalation_confidence: v })} />
            <NumPref label="Critical severity" value={prefs.critical_severity} step={0.5} onChange={(v) => update({ critical_severity: v })} />
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="detection-autoclose"
          title="Auto-close policy"
          icon={ShieldCheck}
          description="The close/escalate decision is always made by deterministic code against this policy — never by raw model output. TRUE_POSITIVE auto-close is an opt-in (off by default); NEEDS_HUMAN never auto-closes."
          wide="full"
        >
          <AutonomyControls prefs={prefs} update={update} />
        </SettingsCard>

        <SettingsCard
          anchor="detection-crosssource"
          title="Cross-source correlation"
          icon={Network}
          description="An opt-in second pass that links related open cases across sources sharing an entity. Surfaces RELATED cases — never force-merges."
          wide="full"
        >
          <CrossSourceSubsection prefs={prefs} update={update} />
        </SettingsCard>
      </SettingsGrid>
      <p className="text-xs leading-relaxed text-muted-foreground">
        New detections are scored with these settings after you Save. Existing alerts keep the
        score they were given at ingest.
      </p>
    </SectionShell>
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
      {/* Entity keys shares the cross-source enable gate: it dims + disables with the two
          numeric knobs above so the whole sub-form reads as one on/off unit (#20). */}
      <div className={cn(!enabled && 'opacity-60')}>
        <Field
          label="Entity keys"
          description="Comma-separated entity keys to correlate on across sources (e.g. ip, host, user, file_hash, domain)."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={entityKeys.join(', ')}
              placeholder="ip, host, user, file_hash, domain"
              disabled={!enabled}
              onChange={(e) =>
                set({
                  entity_keys: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          )}
        </Field>
      </div>
    </div>
  );
}

/** Conservative per-verdict defaults (mirror `config.py` `AutoClosePolicy`). Applied
 * only to fill an absent field for a control's readout — never written unless edited. */
const VERDICT_DEFAULTS: Record<'false_positive' | 'true_positive', Required<VerdictAutoCloseConfig>> = {
  false_positive: { enabled: true, min_confidence: 0.85, max_risk_score: 30, objection_window_minutes: 1440 },
  true_positive: { enabled: false, min_confidence: 0.95, max_risk_score: 10, objection_window_minutes: 4320 },
};

/**
 * ONE reusable per-verdict-class auto-close sub-editor. Rendered TWICE (for
 * `false_positive` and `true_positive`) by {@link AutonomyControls}. It reads and
 * writes exactly `prefs.auto_close.<verdictKey>` — the nested field
 * `case_manager.decide()` evaluates (#3) — so toggling it actually changes what the
 * engine does. Every control is labelled (a11y): the enable switch via `SwitchPref`,
 * the confidence bar via `LabeledSlider`, the risk ceiling + objection window via
 * `NumberField`.
 */
function VerdictAutoClose({
  verdictKey,
  label,
  optIn,
  entry,
  onChange,
}: {
  verdictKey: 'false_positive' | 'true_positive';
  label: string;
  /** When true this class is an explicit opt-in (TRUE_POSITIVE) — note it in the copy. */
  optIn?: boolean;
  entry: VerdictAutoCloseConfig;
  onChange: (next: VerdictAutoCloseConfig) => void;
}) {
  const d = VERDICT_DEFAULTS[verdictKey];
  const enabled = entry.enabled ?? d.enabled;
  const minConf = entry.min_confidence ?? d.min_confidence;
  const maxRisk = entry.max_risk_score ?? d.max_risk_score;
  const objWindow = entry.objection_window_minutes ?? d.objection_window_minutes;
  const set = (patch: Partial<VerdictAutoCloseConfig>) => onChange({ ...entry, ...patch });

  const enableHelp = optIn
    ? `Explicit opt-in, OFF by default. When on, a ${label} verdict that clears BOTH bars below is closed automatically (and audited). Enable only when you trust the agent to auto-resolve confirmed detections.`
    : `When on, a ${label} verdict that clears BOTH bars below is closed automatically (and audited). When off, every ${label.toLowerCase()} case is held for a human.`;

  const minConfPct = Math.round(minConf * 100);
  return (
    <div className="space-y-4">
      <SwitchPref
        label={`Auto-close confident ${label.toLowerCase()}s`}
        help={enableHelp}
        checked={enabled}
        onChange={(v) => set({ enabled: v })}
      />

      <div
        className={cn(
          'space-y-4 border-l border-border py-1 pl-4 transition-opacity',
          !enabled && 'opacity-60',
        )}
      >
        <LabeledSlider
          label="Minimum confidence to auto-close"
          description="The agent's verdict confidence must be at or above this bar."
          value={minConfPct}
          min={0}
          max={100}
          step={1}
          disabled={!enabled}
          formatValue={(v) => `${v}%`}
          onChange={(v) => set({ min_confidence: v / 100 })}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Maximum risk score to auto-close"
            description={`Cases scoring above this normalised risk (0–100) are never auto-closed, even as a ${label.toLowerCase()}.`}
            value={maxRisk}
            min={0}
            max={100}
            disabled={!enabled}
            onChange={(v) => set({ max_risk_score: v })}
          />
          <NumberField
            label="Objection window (minutes)"
            description="Grace period before an auto-close takes effect, leaving room for a human to object."
            value={objWindow}
            min={0}
            unit="min"
            disabled={!enabled}
            onChange={(v) => set({ objection_window_minutes: v })}
          />
        </div>
      </div>
    </div>
  );
}

function AutonomyControls({ prefs, update }: SecProps) {
  // R1: read + write the LIVE `prefs.auto_close` policy — the field decide() acts on.
  const policy: AutoClosePolicy = prefs.auto_close || {};
  const setVerdict = (key: 'false_positive' | 'true_positive', next: VerdictAutoCloseConfig) =>
    update({ auto_close: { ...policy, [key]: next } });

  return (
    <div className="space-y-6">
      <Alert>
        <Info className="h-4 w-4" aria-hidden />
        <AlertTitle>The agent proposes a verdict; deterministic code decides</AlertTitle>
        <AlertDescription>
          Auto-close is enforced by <code className="rounded bg-muted px-1 py-0.5 text-xs">decide()</code>{' '}
          against this policy — never by raw model output.{' '}
          <strong className="font-semibold text-foreground">FALSE_POSITIVE</strong> may auto-close
          above a bar;{' '}
          <strong className="font-semibold text-foreground">TRUE_POSITIVE</strong> auto-close is a
          separate opt-in and is off by default;{' '}
          <strong className="font-semibold text-foreground">NEEDS_HUMAN</strong> is always held for
          an analyst (code-enforced, not tunable here).
        </AlertDescription>
      </Alert>

      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          False positive
        </legend>
        <VerdictAutoClose
          verdictKey="false_positive"
          label="False positive"
          entry={policy.false_positive || {}}
          onChange={(next) => setVerdict('false_positive', next)}
        />
      </fieldset>

      <fieldset className="space-y-4 border-t border-border pt-6">
        <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          True positive <span className="font-normal normal-case text-muted-foreground/70">— opt-in</span>
        </legend>
        <VerdictAutoClose
          verdictKey="true_positive"
          label="True positive"
          optIn
          entry={policy.true_positive || {}}
          onChange={(next) => setVerdict('true_positive', next)}
        />
      </fieldset>

      {/* NEEDS_HUMAN: code-enforced never-auto-close — shown as a LOCKED, read-only row
          (no editable toggle), so operators see the guarantee without a way to disable it. */}
      <div
        className="flex items-start justify-between gap-4 border-l border-border py-1 pl-4"
        aria-label="Needs human: never auto-closes (code-enforced)"
      >
        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Needs human — never auto-closes
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            A case the agent routes to NEEDS_HUMAN is always held for an analyst. This is enforced in
            code (<code className="rounded bg-muted px-1 py-0.5 text-2xs">case_manager.decide()</code>)
            and cannot be tuned.
          </p>
        </div>
        <span className="shrink-0 font-mono text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Locked
        </span>
      </div>
    </div>
  );
}
