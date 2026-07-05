/**
 * NoiseFunnel — the "Noise Reduction" panel for the Security Command Center.
 *
 * Round-8 retired the SVG "Sankey ribbon": a Sankey is for BRANCHING / merging flows,
 * but our pipeline is a strictly LINEAR reduction, so the curved ribbons degenerated
 * into wavy blobs and the single global scale crushed the small stages to slivers.
 *
 * This is the industry-standard replacement for a linear reduction funnel — horizontal
 * aligned stage bars. A big "Noise reduced by X%" hero + an ingested→human cascade, then
 * the monotonic reduction SPINE (Ingested → Clustered → Cases opened) as descending bars
 * (width = count / top-of-funnel, LINEAR + honest), then a compact part-to-whole
 * DISPOSITION row splitting the cases into their four MECE outcomes (auto-cleared /
 * escalated / needs-human / true-positive).
 *
 * Binds VERBATIM to the §D `GET /api/metrics/noise-reduction` contract (`NoiseReduction`).
 * When the durable ingest counters are still warming up (`counters.available === false`)
 * it degrades gracefully to a case-only funnel.
 *
 * #9: every value shown is an aggregate count or a fixed stage label (no raw log text),
 * rendered as plain text — UNTRUSTED-safe by construction. Colours resolve from
 * verdict/primary tokens only (no raw hex; design gate). Meaning NEVER rests on colour —
 * labels + counts are always present, and a drop between stages is a WIN so it is only
 * ever rendered in neutral ink (never red). Each stage/segment is a focusable button
 * (firing `onStageClick(key)`) when a handler is provided, else an accessibly-labelled
 * group. Any count roll uses `<CountUp>`, which honours reduced motion.
 */
import * as React from 'react';
import { Bot, Circle, ShieldCheck, Eye, EyeOff, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import type { NoiseReduction, NoiseSeverityBreakdown, NoiseStage } from '@/lib/types';
import { Skeleton } from '@/ui/skeleton';
import { token, VERDICT_COLOR, semanticIcon } from './palette';
import { CountUp } from './CountUp';
import { HelpTip } from './HelpTip';

/* ------------------------------------------------------------------------- */
/* Outcome → token-name maps (routed through the palette authority so the      */
/* disposition re-themes with the rest of the UI — no raw hex; design gate).   */
/* ------------------------------------------------------------------------- */

/**
 * Outcome segment colour (the four case dispositions) — the VERDICT semantic axis
 * (severity describes the INPUT, verdict describes the OUTPUT).
 */
const OUTCOME_TOKEN: Record<string, string> = {
  auto_cleared: VERDICT_COLOR.false_positive, // blue-grey (a cleared false positive)
  escalated: VERDICT_COLOR.suspicious, // amber-orange
  needs_human: VERDICT_COLOR.needs_human, // warning
  true_positive: VERDICT_COLOR.true_positive, // critical-red
};

/** Outcome key → the semantic-icon lookup key (the beside-colour glyph, WCAG 1.4.1). */
const OUTCOME_ICON_KEY: Record<string, string> = {
  auto_cleared: 'false_positive',
  escalated: 'escalated',
  needs_human: 'needs_human',
  true_positive: 'true_positive',
};

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
  'How the agent reduces raw alert volume: every ingested alert is clustered, a ' +
  'fraction become cases, and each case ends as auto-cleared (false positive), ' +
  'escalated, needs-human, or a confirmed true positive. The spine percentages are ' +
  'each stage’s share of the raw ingested total; the disposition percentages are each ' +
  'outcome’s share of the cases opened.';

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
/* Presentation helpers.                                                       */
/* ------------------------------------------------------------------------- */

/**
 * A single-hue ordinal blue ramp along the reduction spine (lightest at the wide top,
 * darkest at the narrow survivors). Keeps the linear spine visually ONE colour so the
 * accent colours are reserved for the case-disposition outcomes below.
 */
function spineFill(index: number, count: number): string {
  const t = count > 1 ? index / (count - 1) : 1;
  return token('primary', 0.4 + 0.55 * t);
}

/** The circular ShieldCheck / Bot phase marker — deterministic code vs the LLM stage. */
function PhaseMarker({ deterministic }: { deterministic: boolean }) {
  const Icon: LucideIcon = deterministic ? ShieldCheck : Bot;
  return (
    <span
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-card',
        deterministic ? 'border-low text-low' : 'border-info text-info',
      )}
      aria-hidden
    >
      <Icon className="h-3.5 w-3.5" focusable="false" />
    </span>
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
  /** Roll the stage counts up on change (default true; reduced-motion still wins). */
  animate?: boolean;
  /** Accessible label for the funnel figure. */
  ariaLabel?: string;
  className?: string;
  /** Fires with a stage `key` (e.g. `'escalated'`) — the host filters the Cases list. */
  onStageClick?: (key: string) => void;
  /** Per-user collapsed state (header stays; body hides). */
  hidden?: boolean;
  /** Toggle the collapsed state (renders the show/hide control when provided). */
  onToggleHidden?: () => void;
}

function Header({ hidden, onToggleHidden }: { hidden?: boolean; onToggleHidden?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold text-foreground">Noise reduction</h3>
        <HelpTip label="What the noise-reduction funnel means" text={NOISE_FUNNEL_HELP_TEXT} />
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
      className={cn('rounded-lg border border-border bg-card p-4', className)}
      role="group"
      aria-label={ariaLabel ?? 'Noise reduction funnel'}
      aria-busy
      data-testid="noise-funnel-loading"
    >
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-3 h-8 w-56" />
      <div className="mt-4 space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
      <Skeleton className="mt-4 h-2.5 w-full rounded-full" />
    </section>
  );
}

/** One descending spine bar: [name] · [linear bar from x=0] · [count + % of input]. */
function SpineBar({
  row,
  index,
  count,
  relativeTo,
  animate,
  onStageClick,
}: {
  row: FunnelRow;
  index: number;
  count: number;
  relativeTo: string;
  animate: boolean;
  onStageClick?: (key: string) => void;
}) {
  const pct = Math.round(row.pctRetained);
  const widthPct = Math.max(0, Math.min(100, row.ratio * 100));
  const accessibleLabel = `${row.label}: ${row.total} ${row.total === 1 ? 'event' : 'events'}, ${pct}% ${relativeTo}`;

  const inner = (
    <div className="flex items-center gap-3">
      {/* left: stage name (fixed width, left-aligned) */}
      <div className="flex w-36 shrink-0 items-center gap-2 sm:w-44">
        <PhaseMarker deterministic={row.deterministic} />
        <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
      </div>
      {/* bar track — a single rounded bar growing from the x=0 baseline */}
      <div className="min-w-0 flex-1">
        <div
          className="h-5 rounded-r-sm"
          style={{ width: `${widthPct}%`, minWidth: 3, backgroundColor: spineFill(index, count) }}
          aria-hidden
        />
      </div>
      {/* right: absolute count + share of input (tabular, right-aligned) */}
      <div className="w-24 shrink-0 text-right sm:w-28">
        <CountUp
          value={row.total}
          duration={animate ? undefined : 0}
          className="font-mono text-sm font-semibold tabular-nums text-foreground"
        />
        <div className="text-2xs tabular-nums text-muted-foreground">
          {pct}% {relativeTo}
        </div>
      </div>
    </div>
  );

  if (onStageClick) {
    return (
      <button
        type="button"
        onClick={() => onStageClick(row.key)}
        aria-label={accessibleLabel}
        className={cn(
          '-mx-1 block w-full rounded-md px-1 py-0.5 text-left transition-colors',
          'hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {inner}
      </button>
    );
  }
  return (
    <div role="group" aria-label={accessibleLabel} className="px-1 py-0.5">
      {inner}
    </div>
  );
}

/** One case-disposition outcome tile in the part-to-whole legend. */
function OutcomeTile({
  row,
  casesTotal,
  animate,
  onStageClick,
}: {
  row: FunnelRow;
  casesTotal: number;
  animate: boolean;
  onStageClick?: (key: string) => void;
}) {
  const pct = casesTotal > 0 ? Math.round((row.total / casesTotal) * 100) : 0;
  const colorName = OUTCOME_TOKEN[row.key] ?? 'primary';
  const Icon = semanticIcon(OUTCOME_ICON_KEY[row.key] ?? row.key) ?? Circle;
  const accessibleLabel = `${row.label}: ${row.total} ${row.total === 1 ? 'case' : 'cases'}, ${pct}% of cases`;

  const inner = (
    <>
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: token(colorName) }} aria-hidden />
        <span className="truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {row.label}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <CountUp
          value={row.total}
          duration={animate ? undefined : 0}
          className="font-mono text-lg font-semibold tabular-nums text-foreground"
        />
        <span className="text-2xs tabular-nums text-muted-foreground">{pct}%</span>
      </div>
    </>
  );

  if (onStageClick) {
    return (
      <button
        type="button"
        onClick={() => onStageClick(row.key)}
        aria-label={accessibleLabel}
        className={cn(
          'rounded-md border px-2.5 py-2 text-left transition-colors',
          'hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
        style={{ borderColor: token(colorName, 0.35) }}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label={accessibleLabel}
      className="rounded-md border px-2.5 py-2"
      style={{ borderColor: token(colorName, 0.35) }}
    >
      {inner}
    </div>
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
  // Absent data + not loading → render nothing (a missing/off backend simply omits it).
  if (!data || !derived) return null;

  const overall = data.reduction?.overall_pct;
  const headlinePct = typeof overall === 'number' ? overall : null;
  const degradedNote =
    derived.mode === 'cases' ? 'Counters warming up — showing case-based funnel' : 'Reduction pending';
  const relativeTo = derived.mode === 'full' ? 'of ingested' : 'of cases';

  const spineRows = derived.rows.filter((r) => !r.isOutcome);
  const outcomeRows = derived.rows.filter((r) => r.isOutcome);
  const casesTotal = derived.casesTotal;
  const needsHuman = derived.rows.find((r) => r.key === 'needs_human')?.total ?? 0;

  const dropSuppressed = data.drops?.suppressed ?? 0;
  const dropIgnored = data.drops?.ignored ?? 0;
  const dropTotal = dropSuppressed + dropIgnored;

  const spineCount = spineRows.length;
  const showDisposition = outcomeRows.length > 0 && casesTotal > 0;

  return (
    <section
      className={cn('rounded-lg border border-border bg-card p-4', className)}
      role="figure"
      aria-label={ariaLabel ?? 'Noise reduction funnel'}
      data-testid="noise-funnel"
    >
      <Header hidden={hidden} onToggleHidden={onToggleHidden} />

      {hidden ? null : (
        <div className="mt-3 space-y-4">
          {/* Hero — the value-prop headline + the ingested→human cascade. */}
          {headlinePct != null ? (
            <div>
              <p className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                Noise reduced by <span className="text-primary tabular-nums">{headlinePct}%</span>
              </p>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {fmtNumber(derived.topTotal)}{' '}
                {derived.mode === 'full' ? 'events ingested' : 'cases opened'} →{' '}
                {fmtNumber(needsHuman)} case{needsHuman === 1 ? '' : 's'} routed to a human
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="noise-funnel-warming">
              {degradedNote}
            </p>
          )}

          {/* Spine — the monotonic linear reduction as descending aligned bars. */}
          <div className="space-y-1">
            {spineRows.map((row, i) => (
              <SpineBar
                key={row.key}
                row={row}
                index={i}
                count={spineCount}
                relativeTo={relativeTo}
                animate={animate}
                onStageClick={onStageClick}
              />
            ))}
          </div>

          {/* Disposition — the four MECE case outcomes as a part-to-whole row. */}
          {showDisposition ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Case disposition
                </span>
                <span className="text-2xs tabular-nums text-muted-foreground">
                  {fmtNumber(casesTotal)} case{casesTotal === 1 ? '' : 's'} opened
                </span>
              </div>
              {/* Proportional stacked bar (decorative — the labelled tiles carry meaning). */}
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                {outcomeRows.map((row) =>
                  row.total > 0 ? (
                    <div
                      key={row.key}
                      style={{
                        width: `${(row.total / casesTotal) * 100}%`,
                        backgroundColor: token(OUTCOME_TOKEN[row.key] ?? 'primary'),
                      }}
                    />
                  ) : null,
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {outcomeRows.map((row) => (
                  <OutcomeTile
                    key={row.key}
                    row={row}
                    casesTotal={casesTotal}
                    animate={animate}
                    onStageClick={onStageClick}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {dropTotal > 0 ? (
            <p className="border-t border-border pt-2 text-2xs text-muted-foreground">
              {dropSuppressed} suppressed · {dropIgnored} ignored removed before clustering
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default NoiseFunnel;
