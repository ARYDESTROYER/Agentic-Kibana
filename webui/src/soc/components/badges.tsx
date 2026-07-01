/**
 * Domain badges — map TLSOC enums/values onto the shared <Badge> primitive.
 *
 * Every badge here renders short, controlled labels (humanized enum tokens or
 * formatted numbers) — never raw free-form UNTRUSTED strings. When a value is an
 * arbitrary string the backend produced (e.g. an open-ended category), it is
 * passed through `humanizeToken` and rendered as plain text inside the Badge.
 */
import { Badge, type BadgeProps } from '@/ui/badge';
import { cn } from '@/lib/cn';
import { DASH, humanizeToken, fmtPercent, toPercentValue } from '@/lib/format';
import {
  SEVERITY_COLOR,
  STATUS_COLOR,
  VERDICT_COLOR,
  scoreBand,
  type ScoreBand,
} from './palette';

type Variant = NonNullable<BadgeProps['variant']>;

/**
 * Bridge a palette.ts TOKEN NAME (the ONE authority, §1.6) to a Badge variant.
 * palette.ts speaks in token names (`critical`/`high`/`primary`/`muted`/…); the
 * Badge cva speaks in variant names. `primary` → the filled `default`; `muted` →
 * the neutral `secondary`; every semantic token maps to its same-named variant.
 */
const TOKEN_VARIANT: Record<string, Variant> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
  success: 'success',
  warning: 'warning',
  primary: 'default',
  muted: 'secondary',
};

function tokenVariant(name: string): Variant {
  return TOKEN_VARIANT[name] ?? 'secondary';
}

// --------------------------------------------------------------------------- //
// Severity — accepts a number (0..100 or a 1..4/1..5 bucket) or a string label
// ("critical"/"high"/"medium"/"low"/"info"). Normalises to one severity band.
// --------------------------------------------------------------------------- //
type SeverityBand = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Normalise a numeric severity into a band via the ONE 0-100 ladder (palette.ts
 *  scoreBand: 0-21 low / 22-47 medium / 48-73 high / 74-100 critical). A value at
 *  or below the low floor with no signal reads as `info`. */
function severityBandFromNumber(n: number): SeverityBand {
  // Small-bucket scales (e.g. Wazuh-ish 0..15, or 1..5): scale up to 0..100.
  const scaled = n <= 5 ? (n / 5) * 100 : n <= 15 ? (n / 15) * 100 : n;
  const band: ScoreBand = scoreBand(scaled);
  // A genuinely-nil score reads as informational, not a "low" alert.
  if (band === 'low' && scaled < 8) return 'info';
  return band;
}

function severityBand(severity: number | string | null | undefined): SeverityBand | null {
  if (severity === null || severity === undefined || severity === '') return null;
  if (typeof severity === 'number') {
    if (Number.isNaN(severity)) return null;
    return severityBandFromNumber(severity);
  }
  const t = severity.trim().toLowerCase();
  if (t === 'critical' || t === 'crit') return 'critical';
  if (t === 'high') return 'high';
  if (t === 'medium' || t === 'med' || t === 'moderate') return 'medium';
  if (t === 'low') return 'low';
  if (t === 'info' || t === 'informational' || t === 'none') return 'info';
  const asNum = Number(t);
  if (!Number.isNaN(asNum)) return severityBandFromNumber(asNum);
  return null;
}

// Derived from the ONE SEVERITY_COLOR authority (palette.ts, §1.6) → Badge variants,
// so the severity chip color can never drift from the chart/legend color.
const SEVERITY_VARIANT: Record<SeverityBand, Variant> = {
  critical: tokenVariant(SEVERITY_COLOR.critical),
  high: tokenVariant(SEVERITY_COLOR.high),
  medium: tokenVariant(SEVERITY_COLOR.medium),
  low: tokenVariant(SEVERITY_COLOR.low),
  info: tokenVariant(SEVERITY_COLOR.info),
};

const SEVERITY_LABEL: Record<SeverityBand, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export interface SeverityBadgeProps {
  severity: number | string | null | undefined;
  className?: string;
  /** Append the raw numeric value in parens (e.g. "High (72)"). */
  showValue?: boolean;
}

export function SeverityBadge({ severity, className, showValue }: SeverityBadgeProps) {
  const band = severityBand(severity);
  if (!band) {
    return (
      <Badge variant="outline" className={className}>
        {DASH}
      </Badge>
    );
  }
  const suffix = showValue && typeof severity === 'number' ? ` (${Math.round(severity)})` : '';
  return (
    <Badge variant={SEVERITY_VARIANT[band]} className={className}>
      {SEVERITY_LABEL[band]}
      {suffix}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Status — case lifecycle states. Open-ended; common ones get a semantic colour.
// --------------------------------------------------------------------------- //
function statusVariant(status: string): Variant {
  const t = status.trim().toLowerCase();
  // Route the canonical lifecycle statuses through the ONE STATUS_COLOR authority
  // (palette.ts, §1.6) so the badge + charts never drift (fixes escalated→high).
  if (t in STATUS_COLOR) return tokenVariant(STATUS_COLOR[t as keyof typeof STATUS_COLOR]);
  switch (t) {
    // Legacy / non-lifecycle states not in the canonical STATUS_COLOR map.
    case 'open':
    case 'in_progress':
      return 'info';
    case 'needs_human':
      // Legacy alias of "open · awaiting analyst" — an open/attention state.
      return 'high';
    case 'auto_closed':
      return 'success';
    case 'reopened':
      return 'warning';
    case 'error':
    case 'failed':
      return 'critical';
    default:
      return 'secondary';
  }
}

/** Human-facing label for a status. The legacy NEEDS_HUMAN alias renders as a
 *  clearer "Open · awaiting analyst" per the F8 taxonomy. */
function statusLabel(status: string): string {
  const t = status.trim().toLowerCase();
  if (t === 'needs_human') return 'Open · awaiting analyst';
  if (t === 'on_hold') return 'On hold';
  return humanizeToken(status);
}

export interface StatusBadgeProps {
  status: string | null | undefined;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  if (!status) {
    return (
      <Badge variant="outline" className={className}>
        {DASH}
      </Badge>
    );
  }
  return (
    <Badge variant={statusVariant(status)} className={className}>
      {statusLabel(status)}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Disposition — the investigative OUTCOME axis (orthogonal to lifecycle status).
// true_positive (alarming) / false_positive + benign (success) / suspicious
// (amber) / duplicate + undetermined (neutral). Permissive to unknown values.
// --------------------------------------------------------------------------- //
function dispositionVariant(disposition: string): Variant {
  const t = disposition.trim().toLowerCase();
  // Disposition shares the verdict value-space (the investigative OUTCOME axis), so
  // it routes through the same VERDICT_COLOR authority (§1.6): TP→critical, FP/benign
  // →info (neutral blue-grey), suspicious→high, duplicate/undetermined→neutral.
  if (t in VERDICT_COLOR) return tokenVariant(VERDICT_COLOR[t as keyof typeof VERDICT_COLOR]);
  return 'secondary';
}

export interface DispositionBadgeProps {
  disposition: string | null | undefined;
  className?: string;
}

export function DispositionBadge({ disposition, className }: DispositionBadgeProps) {
  if (!disposition || disposition.trim().toLowerCase() === 'none') {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        Undetermined
      </Badge>
    );
  }
  return (
    <Badge variant={dispositionVariant(disposition)} className={className}>
      {humanizeToken(disposition)}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Verdict — TRUE_POSITIVE / FALSE_POSITIVE / NEEDS_HUMAN (+ unverdicted).
// --------------------------------------------------------------------------- //
function verdictVariant(verdict: string): Variant {
  const t = verdict.trim().toLowerCase();
  // Route through the ONE VERDICT_COLOR authority (palette.ts, §1.6). This applies
  // the FP→info (neutral blue-grey, NOT green) fix by construction; unknown values
  // degrade to the neutral secondary variant.
  if (t in VERDICT_COLOR) return tokenVariant(VERDICT_COLOR[t as keyof typeof VERDICT_COLOR]);
  return 'secondary';
}

export interface VerdictBadgeProps {
  verdict: string | null | undefined;
  className?: string;
}

export function VerdictBadge({ verdict, className }: VerdictBadgeProps) {
  if (!verdict || verdict.trim().toLowerCase() === 'none') {
    return (
      <Badge variant="outline" className={className}>
        Unverdicted
      </Badge>
    );
  }
  return (
    <Badge variant={verdictVariant(verdict)} className={className}>
      {humanizeToken(verdict)}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Confidence — a 0..1 (or 0..100) score, coloured by how confident the agent is,
// optionally annotated against an auto-close threshold.
// --------------------------------------------------------------------------- //
export interface ConfidenceBadgeProps {
  confidence: number | null | undefined;
  /** Auto-close confidence bar (0..1). When set, low-confidence renders muted. */
  threshold?: number;
  /** Optional trailing note (e.g. "below bar"). Controlled text only. */
  note?: string;
  className?: string;
}

export function ConfidenceBadge({ confidence, threshold, note, className }: ConfidenceBadgeProps) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return (
      <Badge variant="outline" className={className}>
        {DASH}
      </Badge>
    );
  }
  const pct = toPercentValue(confidence);
  let variant: Variant;
  if (typeof threshold === 'number') {
    const barPct = toPercentValue(threshold);
    variant = pct >= barPct ? 'success' : 'medium';
  } else {
    variant = pct >= 75 ? 'success' : pct >= 50 ? 'medium' : 'low';
  }
  return (
    <Badge variant={variant} className={className}>
      {fmtPercent(confidence)}
      {note ? ` · ${note}` : ''}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Risk — a normalised 0..100 score.
// --------------------------------------------------------------------------- //
function riskVariant(score: number): Variant {
  // The ONE 0-100 ladder (palette.ts scoreBand): 0-21 low / 22-47 medium /
  // 48-73 high / 74-100 critical. Risk never reads as "info" (it is a real score).
  return SEVERITY_VARIANT[scoreBand(score)];
}

export interface RiskBadgeProps {
  score: number | null | undefined;
  className?: string;
  /** Prefix the label (default "Risk"). */
  label?: string;
}

export function RiskBadge({ score, className, label = 'Risk' }: RiskBadgeProps) {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return (
      <Badge variant="outline" className={className}>
        {label} {DASH}
      </Badge>
    );
  }
  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <Badge variant={riskVariant(rounded)} className={className}>
      {label} {rounded}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Posture — an overall security-posture label (e.g. "Critical"/"Elevated"/
// "Guarded"/"Stable"). Accepts a label string or a 0..100 score to derive one.
// --------------------------------------------------------------------------- //
type PostureBand = 'critical' | 'elevated' | 'guarded' | 'stable';

function postureFromScore(score: number): PostureBand {
  // Reuse the ONE 0-100 ladder (palette.ts scoreBand) so posture shares cut-points
  // with severity/risk; posture just relabels the four bands.
  const BAND_TO_POSTURE: Record<ScoreBand, PostureBand> = {
    critical: 'critical',
    high: 'elevated',
    medium: 'guarded',
    low: 'stable',
  };
  return BAND_TO_POSTURE[scoreBand(score)];
}

function postureBand(posture: number | string | null | undefined): PostureBand | null {
  if (posture === null || posture === undefined || posture === '') return null;
  if (typeof posture === 'number') {
    return Number.isNaN(posture) ? null : postureFromScore(posture);
  }
  const t = posture.trim().toLowerCase();
  if (t === 'critical' || t === 'severe') return 'critical';
  if (t === 'elevated' || t === 'high') return 'elevated';
  if (t === 'guarded' || t === 'moderate' || t === 'medium') return 'guarded';
  if (t === 'stable' || t === 'low' || t === 'nominal' || t === 'healthy') return 'stable';
  const asNum = Number(t);
  return Number.isNaN(asNum) ? null : postureFromScore(asNum);
}

const POSTURE_VARIANT: Record<PostureBand, Variant> = {
  critical: 'critical',
  elevated: 'high',
  guarded: 'medium',
  stable: 'success',
};

const POSTURE_LABEL: Record<PostureBand, string> = {
  critical: 'Critical',
  elevated: 'Elevated',
  guarded: 'Guarded',
  stable: 'Stable',
};

export interface PostureBadgeProps {
  posture: number | string | null | undefined;
  className?: string;
}

export function PostureBadge({ posture, className }: PostureBadgeProps) {
  const band = postureBand(posture);
  if (!band) {
    return (
      <Badge variant="outline" className={className}>
        {DASH}
      </Badge>
    );
  }
  return (
    <Badge variant={POSTURE_VARIANT[band]} className={className}>
      {POSTURE_LABEL[band]}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Category — an open-ended case/entity category. The label is backend-derived so
// it is humanized and rendered as plain text; the colour is neutral/outline.
// --------------------------------------------------------------------------- //
export interface CategoryBadgeProps {
  category: string | null | undefined;
  className?: string;
}

export function CategoryBadge({ category, className }: CategoryBadgeProps) {
  if (!category) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        Uncategorized
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={className}>
      {humanizeToken(category)}
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// UrgencyPill — a derived "how urgent is this open case" signal computed from its
// age, risk score, and status. Closed cases are not urgent.
// --------------------------------------------------------------------------- //
type UrgencyBand = 'critical' | 'high' | 'medium' | 'low';

const CLOSED_STATUSES = new Set(['closed', 'resolved', 'auto_closed']);

function ageHours(createdAt?: string | null): number | null {
  if (!createdAt) return null;
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (Date.now() - then) / 3_600_000);
}

function computeUrgency(
  createdAt?: string | null,
  riskScore?: number | null,
  status?: string | null,
): { band: UrgencyBand; label: string } | null {
  if (status && CLOSED_STATUSES.has(status.trim().toLowerCase())) return null;
  const risk = typeof riskScore === 'number' && !Number.isNaN(riskScore) ? riskScore : 0;
  const hrs = ageHours(createdAt);
  const escalated = status
    ? ['needs_human', 'escalated'].includes(status.trim().toLowerCase())
    : false;

  // Score blends risk with how long the case has been waiting + escalation.
  let urgency = risk;
  if (hrs !== null) {
    if (hrs >= 24) urgency += 25;
    else if (hrs >= 8) urgency += 15;
    else if (hrs >= 2) urgency += 5;
  }
  if (escalated) urgency += 20;

  let band: UrgencyBand;
  if (urgency >= 85) band = 'critical';
  else if (urgency >= 60) band = 'high';
  else if (urgency >= 35) band = 'medium';
  else band = 'low';

  const LABEL: Record<UrgencyBand, string> = {
    critical: 'Urgent',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };
  return { band, label: LABEL[band] };
}

const URGENCY_VARIANT: Record<UrgencyBand, Variant> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

export interface UrgencyPillProps {
  createdAt?: string | null;
  riskScore?: number | null;
  status?: string | null;
  className?: string;
}

export function UrgencyPill({ createdAt, riskScore, status, className }: UrgencyPillProps) {
  const u = computeUrgency(createdAt, riskScore, status);
  if (!u) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        {DASH}
      </Badge>
    );
  }
  return (
    <Badge variant={URGENCY_VARIANT[u.band]} className={cn('rounded-full', className)}>
      {u.label}
    </Badge>
  );
}
