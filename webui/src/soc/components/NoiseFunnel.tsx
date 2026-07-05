/**
 * NoiseFunnel — Round-7 ★b (the "Noise Reduction" infographic for the Security
 * Command Center).
 *
 * A tapering inline-SVG funnel that tells the value-prop story of how the agent
 * reduces raw alert volume down to the handful of cases a human actually sees:
 *
 *     ingested → clustered → cases → auto_cleared → escalated → needs_human
 *
 * The four case OUTCOMES (auto_cleared · escalated · needs_human · a client-derived
 * `true_positive` residual) are MECE — they partition `cases.total` — so the bars sum
 * honestly. Each stage is a centered, severity-banded bar (widths taper down the
 * funnel), with a per-stage count-up and the share of raw noise it represents.
 *
 * Binds VERBATIM to the §D `GET /api/metrics/noise-reduction` contract (the
 * `NoiseReduction` type). When the durable ingest counters are still warming up
 * (`counters.available === false`) it degrades gracefully to a case-only funnel.
 *
 * #9: every value shown is an aggregate count or a fixed stage label (no raw log
 * text), rendered as plain text — UNTRUSTED-safe by construction. Colours resolve
 * from severity tokens only (no raw hex; design gate). Reduced-motion is honoured by
 * the shared motion primitives; the funnel bars are decorative (`aria-hidden`) and the
 * per-stage text carries all meaning for assistive tech.
 */
import * as React from 'react';
import { Bot, ShieldCheck, Eye, EyeOff, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { NoiseReduction, NoiseSeverityBreakdown, NoiseStage } from '@/lib/types';
import { Skeleton } from '@/ui/skeleton';
import { token } from './palette';
import { CountUp } from './CountUp';
import { Stagger } from './Stagger';
import { HelpTip } from './HelpTip';

/* ------------------------------------------------------------------------- */
/* Severity band → token map (LOCAL — `SEV_BAR` in Overview.tsx is private).  */
/* Resolves each band to an `hsl(var(--band))` string for the SVG `fill`, so   */
/* the funnel re-themes with the rest of the UI (no raw hex; design gate).     */
/* ------------------------------------------------------------------------- */
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
type SevBand = (typeof SEV_ORDER)[number];

const BAND_FILL: Record<SevBand, string> = {
  critical: token('critical'),
  high: token('high'),
  medium: token('medium'),
  low: token('low'),
  info: token('info'),
};

/** A neutral fill for a bar that carries no per-band breakdown (e.g. the residual). */
const NEUTRAL_FILL = token('primary', 0.5);

/** Fallback labels for the canonical funnel stages (the backend supplies `label`). */
const STAGE_LABEL: Record<string, string> = {
  ingested: 'Ingested',
  clustered: 'Clustered',
  cases: 'Cases opened',
  auto_cleared: 'Auto-cleared',
  escalated: 'Escalated',
  needs_human: 'Needs human',
  true_positive: 'True positive',
};

/** The four case outcomes that partition `cases.total` (MECE). */
const OUTCOME_KEYS = ['auto_cleared', 'escalated', 'needs_human', 'true_positive'];

/** Popover help copy (>80 chars → focusable Popover, not a bare Tooltip). */
export const NOISE_FUNNEL_HELP_TEXT =
  'How the agent reduces raw alert volume: every ingested alert (by severity) is ' +
  'clustered, a fraction become cases, and each case ends as auto-cleared (false ' +
  'positive), escalated, needs-human, or a confirmed true positive. The percentages ' +
  'are each stage’s share of the raw ingested total.';

/* ------------------------------------------------------------------------- */
/* Pure derivation (exported for tests).                                       */
/* ------------------------------------------------------------------------- */

/** One render-ready funnel stage. */
export interface FunnelRow {
  key: string;
  label: string;
  total: number;
  by_severity: NoiseSeverityBreakdown;
  /** Deterministic-code stage (ShieldCheck) vs the LLM-influenced `cases` stage (Bot). */
  deterministic: boolean;
  /** Bar width as a fraction of `topTotal` (0..1). */
  ratio: number;
  /** Share of the funnel top (`topTotal`) this stage retains (0..100). */
  pctRetained: number;
  /** A case outcome that partitions `cases.total`. */
  isOutcome: boolean;
}

export interface DerivedFunnel {
  rows: FunnelRow[];
  /** The funnel top the bars/percentages are relative to (ingested, or cases when degraded). */
  topTotal: number;
  /** 'full' = counters available (ingested→…); 'cases' = counters warming up (case-only). */
  mode: 'full' | 'cases';
  casesTotal: number;
  /** auto_cleared + escalated + needs_human + true_positive (MECE → == casesTotal). */
  outcomeSum: number;
}

/**
 * Derive the ordered funnel rows from the §D contract. Computes the client-side
 * `true_positive` residual (`cases − auto_cleared − escalated − needs_human`) so the
 * four outcomes are MECE, and switches to a case-only funnel when the durable ingest
 * counters are unavailable.
 */
export function deriveFunnel(data: NoiseReduction): DerivedFunnel {
  const byKey = new Map<string, NoiseStage>();
  for (const s of data.stages ?? []) byKey.set(s.key, s);

  const countersOk = data.counters?.available !== false;

  const casesTotal = byKey.get('cases')?.total ?? 0;
  const auto = byKey.get('auto_cleared')?.total ?? 0;
  const esc = byKey.get('escalated')?.total ?? 0;
  const nh = byKey.get('needs_human')?.total ?? 0;
  const tp = Math.max(0, casesTotal - auto - esc - nh);

  // Full funnel from ingested, or case-only when the counters are still warming up.
  const visibleKeys = countersOk
    ? ['ingested', 'clustered', 'cases', 'auto_cleared', 'escalated', 'needs_human']
    : ['cases', 'auto_cleared', 'escalated', 'needs_human'];

  const topKey = countersOk ? 'ingested' : 'cases';
  const topTotal = byKey.get(topKey)?.total ?? casesTotal;

  const asRow = (
    key: string,
    stage: NoiseStage | undefined,
    residualTotal?: number,
  ): FunnelRow => {
    const total = residualTotal ?? stage?.total ?? 0;
    return {
      key,
      label: stage?.label || STAGE_LABEL[key] || key,
      total,
      by_severity: stage?.by_severity ?? {},
      // Trust the backend flag; default per the §H pin (only `cases` is LLM-influenced).
      deterministic: stage ? stage.deterministic : key !== 'cases',
      ratio: topTotal > 0 ? total / topTotal : 0,
      pctRetained: topTotal > 0 ? (total / topTotal) * 100 : 0,
      isOutcome: OUTCOME_KEYS.includes(key),
    };
  };

  const rows = visibleKeys.map((key) => asRow(key, byKey.get(key)));
  // The derived residual — an outcome, so the four outcomes sum to cases.total.
  rows.push({
    key: 'true_positive',
    label: STAGE_LABEL.true_positive,
    total: tp,
    by_severity: {},
    deterministic: false,
    ratio: topTotal > 0 ? tp / topTotal : 0,
    pctRetained: topTotal > 0 ? (tp / topTotal) * 100 : 0,
    isOutcome: true,
  });

  return {
    rows,
    topTotal,
    mode: countersOk ? 'full' : 'cases',
    casesTotal,
    outcomeSum: auto + esc + nh + tp,
  };
}

/* ------------------------------------------------------------------------- */
/* Bar geometry.                                                               */
/* ------------------------------------------------------------------------- */

/** Wide user-space so bar widths tween smoothly; stretched to the box (aspect-free). */
const VB_W = 1000;
const VB_H = 24;
/** Keep a non-empty stage visible + clickable even when its share is tiny. */
const MIN_RATIO = 0.05;

/**
 * One centered, severity-segmented funnel bar (decorative — the row text carries the
 * meaning). Square edges keep the shape crisp under the responsive
 * `preserveAspectRatio="none"` stretch (rounded corners would distort by container width).
 */
function FunnelBar({ row }: { row: FunnelRow }) {
  const ratio = row.total > 0 ? Math.max(MIN_RATIO, Math.min(1, row.ratio)) : 0;
  const barW = VB_W * ratio;
  const x0 = (VB_W - barW) / 2;

  const segs = SEV_ORDER.map((b) => ({ b, v: Math.max(0, Number(row.by_severity[b] ?? 0)) })).filter(
    (s) => s.v > 0,
  );
  const segSum = segs.reduce((a, s) => a + s.v, 0);

  let cursor = x0;
  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      width="100%"
      preserveAspectRatio="none"
      className="mt-1 block h-2.5 w-full"
      aria-hidden
      focusable="false"
    >
      {barW <= 0 ? null : segSum > 0 ? (
        segs.map((s) => {
          const w = (s.v / segSum) * barW;
          const rect = (
            <rect key={s.b} x={cursor.toFixed(2)} y={0} width={w.toFixed(2)} height={VB_H} fill={BAND_FILL[s.b]} />
          );
          cursor += w;
          return rect;
        })
      ) : (
        <rect x={x0.toFixed(2)} y={0} width={barW.toFixed(2)} height={VB_H} fill={NEUTRAL_FILL} />
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* Component.                                                                  */
/* ------------------------------------------------------------------------- */

export interface NoiseFunnelProps {
  /** The §D funnel payload, or `null` while unfetched / when the feature is off. */
  data: NoiseReduction | null;
  /** Show the loading skeleton. */
  loading?: boolean;
  /** Stagger the stage reveal + count-up (default true; reduced-motion still wins). */
  animate?: boolean;
  /** Accessible label for the funnel region. */
  ariaLabel?: string;
  className?: string;
  /** Fires with a stage `key` (e.g. `'escalated'`) — the host filters the Cases list. */
  onStageClick?: (key: string) => void;
  /** Per-user collapsed state (header stays; body hides). */
  hidden?: boolean;
  /** Toggle the collapsed state (renders the show/hide control when provided). */
  onToggleHidden?: () => void;
}

function Header({
  headlinePct,
  degradedNote,
  hidden,
  onToggleHidden,
}: {
  headlinePct: number | null;
  degradedNote: string | null;
  hidden?: boolean;
  onToggleHidden?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-foreground">Noise reduction</h3>
          <HelpTip label="What the noise-reduction funnel means" text={NOISE_FUNNEL_HELP_TEXT} />
        </div>
        {headlinePct != null ? (
          <p className="mt-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
            Noise reduced by{' '}
            <span className="text-base font-semibold normal-case tracking-normal text-foreground tabular-nums">
              {headlinePct}%
            </span>
          </p>
        ) : (
          <p className="mt-0.5 text-2xs text-muted-foreground" data-testid="noise-funnel-warming">
            {degradedNote ?? 'Reduction pending'}
          </p>
        )}
      </div>
      {onToggleHidden ? (
        <button
          type="button"
          onClick={onToggleHidden}
          aria-label={hidden ? 'Show noise funnel' : 'Hide noise funnel'}
          aria-pressed={hidden ? true : false}
          className={cn(
            'inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
            'hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {hidden ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
        </button>
      ) : null}
    </div>
  );
}

function LoadingState({ ariaLabel, className }: { ariaLabel?: string; className?: string }) {
  return (
    <section
      className={cn('rounded-r-lg border border-border bg-card p-4', className)}
      role="group"
      aria-label={ariaLabel ?? 'Noise reduction funnel'}
      aria-busy
      data-testid="noise-funnel-loading"
    >
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-2 h-3 w-40" />
      <div className="mt-4 space-y-3">
        {[0.9, 0.6, 0.4, 0.28, 0.16, 0.1].map((w, i) => (
          <Skeleton key={i} className="mx-auto h-2.5" style={{ width: `${Math.round(w * 100)}%` }} />
        ))}
      </div>
    </section>
  );
}

export function NoiseFunnel({
  data,
  loading = false,
  animate = true,
  ariaLabel,
  className,
  onStageClick,
  hidden,
  onToggleHidden,
}: NoiseFunnelProps) {
  const derived = React.useMemo(() => (data ? deriveFunnel(data) : null), [data]);

  if (loading && !derived) return <LoadingState ariaLabel={ariaLabel} className={className} />;
  // Absent data + not loading → render nothing (a missing/off backend simply omits the widget).
  if (!data || !derived) return null;

  const overall = data.reduction?.overall_pct;
  const headlinePct = typeof overall === 'number' ? overall : null;
  const degradedNote =
    derived.mode === 'cases' ? 'Counters warming up — showing case-based funnel' : null;
  const relativeTo = derived.mode === 'full' ? 'of ingested' : 'of cases';

  const stageRows = derived.rows.map((row) => {
    const Icon: LucideIcon = row.deterministic ? ShieldCheck : Bot;
    const pct = Math.round(row.pctRetained);
    const accessibleLabel = `${row.label}: ${row.total} ${row.total === 1 ? 'event' : 'events'}, ${pct}% ${relativeTo}`;

    const inner = (
      <div className="w-full text-left">
        <div className="flex items-center gap-2">
          <Icon
            className={cn('h-3.5 w-3.5 shrink-0', row.deterministic ? 'text-low' : 'text-info')}
            aria-hidden
            focusable="false"
          />
          <span className="truncate text-xs font-medium text-foreground">{row.label}</span>
          <span className="ml-auto flex items-baseline gap-1.5">
            <CountUp
              value={row.total}
              duration={animate ? undefined : 0}
              className="text-sm font-semibold tabular-nums text-foreground"
            />
            <span className="w-9 text-right text-2xs tabular-nums text-muted-foreground">{pct}%</span>
          </span>
        </div>
        <FunnelBar row={row} />
      </div>
    );

    if (onStageClick) {
      return (
        <button
          key={row.key}
          type="button"
          onClick={() => onStageClick(row.key)}
          aria-label={accessibleLabel}
          className={cn(
            'block w-full rounded-md px-1.5 py-1 text-left transition-colors',
            'hover:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {inner}
        </button>
      );
    }
    return (
      <div key={row.key} role="group" aria-label={accessibleLabel} className="px-1.5 py-1">
        {inner}
      </div>
    );
  });

  const drops = data.drops;
  const dropTotal = (drops?.suppressed ?? 0) + (drops?.ignored ?? 0);

  return (
    <section
      className={cn('rounded-r-lg border border-border bg-card p-4', className)}
      role="group"
      aria-label={ariaLabel ?? 'Noise reduction funnel'}
      data-testid="noise-funnel"
    >
      <Header
        headlinePct={headlinePct}
        degradedNote={degradedNote}
        hidden={hidden}
        onToggleHidden={onToggleHidden}
      />

      {hidden ? null : (
        <>
          {animate ? (
            <Stagger step={50} className="mt-3 space-y-1.5">
              {stageRows}
            </Stagger>
          ) : (
            <div className="mt-3 space-y-1.5">{stageRows}</div>
          )}

          {dropTotal > 0 ? (
            <p className="mt-3 border-t border-border pt-2 text-2xs text-muted-foreground">
              {drops?.suppressed ?? 0} suppressed · {drops?.ignored ?? 0} ignored removed before clustering
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

export default NoiseFunnel;
