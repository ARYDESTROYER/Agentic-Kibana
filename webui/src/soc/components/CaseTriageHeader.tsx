/**
 * CaseTriageHeader — the FOUR honestly-distinct triage chips (#12).
 *
 * Replaces the old "three panels all derived from risk_score" header with four
 * chips that answer DIFFERENT questions, sourced from `GET /api/cases/{id}/triage`:
 *
 *   RISK     — the deterministic 0-100 score (+ its volume/velocity/reputation/…
 *              breakdown, shown via the existing RiskGauge + a mini bar list).
 *   SEVERITY — what the SOURCE asserted on the events (SIEM/EDR rating), badged
 *              "(derived)" honestly when no source severity existed.
 *   IMPACT   — how important the affected asset is (asset criticality).
 *   PRIORITY — the derived P1..P4 (ITIL Impact×Urgency), advisory ordering only.
 *
 * Each chip carries a HelpTip showing the exact INPUTS the backend used, so the
 * number is never a black box.
 *
 * SECURITY (#9): every value here is read-time-derived case data. Chip values are
 * numbers / enum bands rendered as plain text; the HelpTip `inputs` (entity value,
 * severity raw, …) are operator/log-derived and rendered ONLY as plain text inside
 * the tooltip — never as markup. #3: these bands are PRESENTATION ONLY and were
 * never fed to the deterministic decide().
 */
import * as React from 'react';
import { Activity, Crosshair, Gauge, ListOrdered } from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH } from '@/lib/format';

import { Skeleton } from '@/ui/skeleton';
import { RiskGauge } from '@/soc/components/RiskGauge';
import { HelpTip } from '@/soc/components/HelpTip';

import type {
  ImpactChip,
  PriorityChip,
  RiskChip,
  SeverityChip,
  TriageChips,
} from '@/soc/pages/CaseDetail.api';

/* ----------------------------------------------------------------- tones --- */

type ChipTone = 'critical' | 'high' | 'medium' | 'low' | 'info';

const TONE_TEXT: Record<ChipTone, string> = {
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
  info: 'text-info',
};
const TONE_ACCENT: Record<ChipTone, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
};
const TONE_BAR: Record<ChipTone, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
};

/** Map an advisory band string → a chip tone (the 5-band semantic palette). */
function toneForBand(band?: string): ChipTone {
  switch ((band || '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'info';
  }
}

/** Map a 0-100 magnitude → a chip tone (for the risk number specifically). */
function toneForScore(score: number): ChipTone {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  if (score >= 15) return 'low';
  return 'info';
}

/** Title-case a band/level token for display ("high" → "High", "P1" → "P1"). */
function label(token?: string | null): string {
  const t = (token || '').trim();
  if (!t) return DASH;
  if (/^p\d$/i.test(t)) return t.toUpperCase();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/* --------------------------------------------------------------- chip shell -- */

/** Shared chip frame: a top accent bar, an uppercase label with a HelpTip, and a
 *  large headline value. All children are plain text. */
const ChipShell: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone: ChipTone;
  value: string;
  /** Optional secondary line under the value (plain text). */
  sub?: React.ReactNode;
  /** HelpTip text + an optional code block of the precise inputs. */
  helpText: string;
  helpCode?: string;
  children?: React.ReactNode;
  'data-testid'?: string;
}> = ({ icon: Icon, label: lbl, tone, value, sub, helpText, helpCode, children, ...rest }) => (
  <div
    data-testid={rest['data-testid']}
    className="relative flex min-h-[7.5rem] flex-col overflow-hidden rounded-lg border border-border bg-card p-4"
  >
    <span aria-hidden="true" className={cn('absolute inset-x-0 top-0 h-0.5', TONE_ACCENT[tone])} />
    <div className="flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
        {lbl}
      </span>
      <HelpTip text={helpText} code={helpCode} label={`What ${lbl.toLowerCase()} means`} />
    </div>
    <div className={cn('mt-2 text-2xl font-bold leading-none tracking-tight', TONE_TEXT[tone])}>
      {value}
    </div>
    {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    {children ? <div className="mt-auto pt-3">{children}</div> : null}
  </div>
);

/* ----------------------------------------------------------- risk breakdown -- */

const RISK_COMPONENTS: Array<{ key: string; label: string }> = [
  { key: 'volume', label: 'Volume' },
  { key: 'velocity', label: 'Velocity' },
  { key: 'reputation', label: 'Reputation' },
  { key: 'diversity', label: 'Diversity' },
  { key: 'asset_criticality', label: 'Asset' },
];

/** A compact horizontal breakdown of the risk components (each 0-100). Plain data. */
const RiskBreakdownBars: React.FC<{ breakdown: Record<string, number | undefined> }> = ({
  breakdown,
}) => {
  const rows = RISK_COMPONENTS.map((c) => ({
    label: c.label,
    value: Math.max(0, Math.min(100, Number(breakdown?.[c.key] ?? 0))),
  })).filter((r) => Number.isFinite(r.value));
  if (rows.every((r) => r.value === 0)) return null;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const tone = toneForScore(r.value);
        return (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              {r.label}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full', TONE_BAR[tone])}
                style={{ width: `${r.value}%` }}
                aria-hidden
              />
            </div>
            <span className="w-7 shrink-0 text-right text-[0.65rem] tabular-nums text-muted-foreground">
              {Math.round(r.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
};

/* --------------------------------------------------------- inputs → help code */

/** Build a plain-text "inputs" block for a chip's HelpTip (#9: plain text only). */
function inputsCode(inputs: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!inputs) return undefined;
  const lines: string[] = [];
  for (const k of keys) {
    const v = inputs[k];
    if (v === undefined || v === null || v === '') continue;
    lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return lines.length ? lines.join('\n') : undefined;
}

/* ------------------------------------------------------------------- chips -- */

const RiskCard: React.FC<{ risk: RiskChip }> = ({ risk }) => {
  const score = Math.max(0, Math.min(100, Number(risk?.value ?? 0)));
  const tone = toneForScore(score);
  const help =
    risk.inputs?.definition ||
    'Deterministic 0-100 risk: a weighted blend of event volume, velocity, entity reputation, rule diversity and asset criticality.';
  return (
    <div className="relative flex min-h-[7.5rem] flex-col overflow-hidden rounded-lg border border-border bg-card p-4">
      <span aria-hidden="true" className={cn('absolute inset-x-0 top-0 h-0.5', TONE_ACCENT[tone])} />
      <div className="flex items-center gap-1.5">
        <Gauge className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
          Risk
        </span>
        <HelpTip text={help} label="What risk means" />
      </div>
      <div className="mt-2 flex items-start gap-3">
        <div className="shrink-0">
          <RiskGauge score={score} size={108} />
        </div>
        <div className="min-w-0 flex-1 self-center">
          <RiskBreakdownBars breakdown={risk.breakdown || {}} />
        </div>
      </div>
    </div>
  );
};

const SeverityCard: React.FC<{ severity: SeverityChip }> = ({ severity }) => {
  const tone = toneForBand(severity?.band);
  const derived = severity?.source !== 'source_asserted';
  const help =
    severity.inputs?.definition ||
    "The maximum severity the SOURCE asserted on the member events — the SIEM/EDR's own rating, not our computed risk.";
  const code = inputsCode(severity.inputs, ['severity_max', 'severity_min']);
  return (
    <ChipShell
      data-testid="triage-chip-severity"
      icon={Activity}
      label="Severity"
      tone={tone}
      value={label(severity?.band)}
      helpText={help}
      helpCode={code}
      sub={
        <span>
          {derived ? 'derived (no source rating)' : 'source-asserted'}
          {typeof severity?.raw === 'number' ? ` · raw ${severity.raw}` : ''}
        </span>
      }
    />
  );
};

const ImpactCard: React.FC<{ impact: ImpactChip }> = ({ impact }) => {
  const tone = toneForBand(impact?.band);
  const help =
    impact.inputs?.definition ||
    "How important the affected asset is, from the operator's asset-criticality map / internal-network policy.";
  const code = inputsCode(impact.inputs, ['entity_type', 'entity_value']);
  const crit = typeof impact?.criticality === 'number' ? Math.round(impact.criticality) : null;
  return (
    <ChipShell
      data-testid="triage-chip-impact"
      icon={Crosshair}
      label="Impact"
      tone={tone}
      value={label(impact?.band)}
      helpText={help}
      helpCode={code}
      sub={crit !== null ? <span>asset criticality {crit}/100</span> : <span>asset criticality {DASH}</span>}
    />
  );
};

const PriorityCard: React.FC<{ priority: PriorityChip }> = ({ priority }) => {
  // Priority tone tracks the urgency band (how pressing) for an honest colour.
  const tone = toneForBand(priority?.urgency?.band || priority?.impact);
  const help =
    priority.inputs?.definition ||
    'ITIL priority = Impact × Urgency, looked up in the operator priority matrix. Advisory ordering only — it never changes the verdict or the deterministic close/escalate decision.';
  const code = inputsCode(priority.inputs, ['impact_band', 'urgency_band', 'matrix_enabled']);
  const level = priority?.level || priority?.default || null;
  return (
    <ChipShell
      data-testid="triage-chip-priority"
      icon={ListOrdered}
      label="Priority"
      tone={tone}
      value={label(level)}
      helpText={help}
      helpCode={code}
      sub={
        <span>
          impact {label(priority?.impact)} × urgency {label(priority?.urgency?.band)}
          {priority?.matched === false ? ' · default' : ''}
        </span>
      }
    />
  );
};

/* --------------------------------------------------------------- component -- */

export interface CaseTriageHeaderProps {
  chips: TriageChips | null;
  loading?: boolean;
  className?: string;
}

/**
 * The four-chip triage header. Renders skeletons while loading, then the four
 * honestly-distinct chips. Defensive: a missing chip degrades to a low/zero band
 * (the backend already returns a renderable shell for an unknown case).
 */
export const CaseTriageHeader: React.FC<CaseTriageHeaderProps> = ({ chips, loading, className }) => {
  if (loading || !chips) {
    return (
      <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[7.5rem] rounded-lg" />
        ))}
      </div>
    );
  }
  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}>
      <RiskCard risk={chips.risk} />
      <SeverityCard severity={chips.severity} />
      <ImpactCard impact={chips.impact} />
      <PriorityCard priority={chips.priority} />
    </div>
  );
};

export default CaseTriageHeader;
