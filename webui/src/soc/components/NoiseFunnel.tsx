/**
 * NoiseFunnel — the "Noise Reduction" flow ribbon for the Security Command Center
 * (Round-8 ★8, redesigned from the Round-7 stacked-bar funnel into a horizontal
 * Sankey ribbon).
 *
 * Tells the value-prop story of how the agent thins raw alert volume down to the
 * handful of cases a human sees, as a left-to-right flow:
 *
 *     ingested → clustered → cases → { auto_cleared · escalated · needs_human · true_positive }
 *
 * The raw ingested volume enters on the LEFT pre-split into its SEVERITY bands as
 * parallel strands; those strands thin through clustering and case-creation (each
 * connector carries a drop-off badge), and at the right the `cases` node fans out
 * into the four MECE case OUTCOMES (auto_cleared · escalated · needs_human · a
 * client-derived `true_positive` residual — they partition `cases.total`). Ribbon
 * width is proportional to volume (ONE global scale `k`), so "gets fewer and fewer"
 * is emotionally honest; a MIN sliver keeps a nonzero-but-small stage visible.
 * Suppressed/ignored candidates removed before clustering peel off as a dashed
 * side-spur.
 *
 * Binds VERBATIM to the §D `GET /api/metrics/noise-reduction` contract (the
 * `NoiseReduction` type). When the durable ingest counters are still warming up
 * (`counters.available === false`) it degrades gracefully to a case-only funnel.
 *
 * #9: every value shown is an aggregate count or a fixed stage label (no raw log
 * text), rendered as plain text — UNTRUSTED-safe by construction. Colours resolve
 * from severity/verdict tokens only (no raw hex; design gate). The SVG flow is
 * decorative (`aria-hidden`); ALL meaning is carried by the focusable stage
 * buttons/groups in the label rail, so assistive tech gets the numbers, not the
 * beziers. Reduced-motion is honoured globally (theme.css neutralises the keyframes).
 */
import * as React from 'react';
import { Bot, ShieldCheck, Eye, EyeOff, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { NoiseReduction, NoiseSeverityBreakdown, NoiseStage } from '@/lib/types';
import { Skeleton } from '@/ui/skeleton';
import { token, SEVERITY_COLOR, VERDICT_COLOR } from './palette';
import { CountUp } from './CountUp';
import { Stagger } from './Stagger';
import { HelpTip } from './HelpTip';

/* ------------------------------------------------------------------------- */
/* Severity + outcome → token-name maps (routed through the palette authority  */
/* so the flow re-themes with the rest of the UI — no raw hex; design gate).   */
/* ------------------------------------------------------------------------- */
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
type SevBand = (typeof SEV_ORDER)[number];

/** Severity strand colour (ingested → cases). Values are palette token names. */
const BAND_TOKEN: Record<SevBand, string> = {
  critical: SEVERITY_COLOR.critical,
  high: SEVERITY_COLOR.high,
  medium: SEVERITY_COLOR.medium,
  low: SEVERITY_COLOR.low,
  info: SEVERITY_COLOR.info,
};

/**
 * Outcome ribbon colour (cases → the four outcomes) — the VERDICT semantic axis:
 * severity describes the INPUT, verdict describes the OUTPUT.
 */
const OUTCOME_TOKEN: Record<string, string> = {
  auto_cleared: VERDICT_COLOR.false_positive, // blue-grey (a cleared false positive)
  escalated: VERDICT_COLOR.suspicious, // amber-orange
  needs_human: VERDICT_COLOR.needs_human, // warning
  true_positive: VERDICT_COLOR.true_positive, // critical-red
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
  /** The funnel top the ribbons/percentages are relative to (ingested, or cases when degraded). */
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
/* Sankey geometry.                                                            */
/* ------------------------------------------------------------------------- */

/** Fixed-aspect viewBox (~2.9:1, wide QRadar-style flow). Meet-scaled, not stretched. */
const VB_W = 640;
const VB_H = 220;
/** Vertical center + the plot band the strands live in. */
const CY = VB_H / 2;
const PLOT_PAD = 26;
const PLOT_H = VB_H - PLOT_PAD * 2;
/** Node rect width + the vertical splay the four outcomes fan across. */
const NODE_W = 11;
const OUTCOME_SPREAD = 66;
/** A nonzero-but-tiny stage/strand stays this many user-units tall (stays visible). */
const MIN_SLIVER = 3.5;
/** Strand opacity at the source; the target end fades by how much survived. */
const STRAND_ALPHA = 0.55;
const STRAND_ALPHA_MIN = 0.16;

/**
 * The canonical horizontal-Sankey link path: a symmetric cubic Bezier between two
 * fixed-height endpoints, using the horizontal midpoint as the control x (exactly
 * what `d3.sankeyLinkHorizontal()` generates). Exported for unit tests.
 */
export function ribbonPath(
  x0: number,
  sy0: number,
  sy1: number,
  x1: number,
  ty0: number,
  ty1: number,
): string {
  const xm = (x0 + x1) / 2;
  return `M${x0},${sy0} C${xm},${sy0} ${xm},${ty0} ${x1},${ty0} L${x1},${ty1} C${xm},${ty1} ${xm},${sy1} ${x0},${sy1} Z`;
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : Number.isNaN(t) ? 0 : t);

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}
interface Ribbon {
  id: string;
  path: string;
  colorName: string;
  x0: number;
  x1: number;
  alpha0: number;
  alpha1: number;
}
interface Badge {
  leftPct: number;
  topPct: number;
  drop: number;
  pct: number;
}
interface Layout {
  ribbons: Ribbon[];
  rects: Rect[];
  badges: Badge[];
  spurPath: string | null;
  spurNub: { x: number; y: number } | null;
  spurChip: { leftPct: number; topPct: number } | null;
}

/** One spine node's vertical extent + its per-band segment ranges. */
interface SpineGeom {
  x: number;
  top: number;
  bottom: number;
  h: number;
  bandRange: Map<SevBand, [number, number]>;
}

/**
 * Build the whole flow layout from the derived rows: severity strands
 * (ingested → clustered → cases), the verdict fan (cases → 4 outcomes), the node
 * rects, per-connector drop-off badges, and the suppressed/ignored side-spur.
 * Pure geometry — no meaning lives here (the rail carries it).
 */
function buildLayout(derived: DerivedFunnel, drops: { suppressed: number; ignored: number }, uid: string): Layout {
  const rows = derived.rows;
  const n = rows.length;
  const spineCount = (() => {
    const i = rows.findIndex((r) => r.isOutcome);
    return i < 0 ? n : i;
  })();
  const k = derived.topTotal > 0 ? PLOT_H / derived.topTotal : 0;
  const colCenter = (i: number) => (VB_W * (i + 0.5)) / Math.max(1, n);

  const rects: Rect[] = [];
  const ribbons: Ribbon[] = [];
  const badges: Badge[] = [];

  // --- spine nodes (centered), with severity segments ---
  const spine: SpineGeom[] = [];
  for (let i = 0; i < spineCount; i++) {
    const row = rows[i];
    const x = colCenter(i);
    const h = row.total > 0 ? Math.max(MIN_SLIVER, row.total * k) : 0;
    const top = CY - h / 2;
    const bandRange = new Map<SevBand, [number, number]>();
    const segSum = SEV_ORDER.reduce((a, b) => a + Math.max(0, Number(row.by_severity[b] ?? 0)), 0);
    if (h > 0 && segSum > 0) {
      let cursor = top;
      for (const b of SEV_ORDER) {
        const v = Math.max(0, Number(row.by_severity[b] ?? 0));
        if (v <= 0) continue;
        const segH = (v / segSum) * h;
        rects.push({ x: x - NODE_W / 2, y: cursor, w: NODE_W, h: segH, fill: token(BAND_TOKEN[b]) });
        bandRange.set(b, [cursor, cursor + segH]);
        cursor += segH;
      }
    } else if (h > 0) {
      rects.push({ x: x - NODE_W / 2, y: top, w: NODE_W, h, fill: token('primary', 0.5) });
    }
    spine.push({ x, top, bottom: top + h, h, bandRange });
  }

  // --- severity strands between consecutive spine nodes ---
  for (let i = 0; i < spineCount - 1; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    for (const band of SEV_ORDER) {
      const ar = a.bandRange.get(band);
      const br = b.bandRange.get(band);
      if (!ar || !br) continue;
      const survival = clamp01((br[1] - br[0]) / Math.max(1e-6, ar[1] - ar[0]));
      ribbons.push({
        id: `${uid}-s${i}-${band}`,
        path: ribbonPath(a.x + NODE_W / 2, ar[0], ar[1], b.x - NODE_W / 2, br[0], br[1]),
        colorName: BAND_TOKEN[band],
        x0: a.x + NODE_W / 2,
        x1: b.x - NODE_W / 2,
        alpha0: STRAND_ALPHA,
        alpha1: Math.max(STRAND_ALPHA_MIN, STRAND_ALPHA * survival),
      });
    }

    // drop-off badge on this connector.
    const drop = Math.max(0, rows[i].total - rows[i + 1].total);
    if (drop > 0) {
      badges.push({
        leftPct: ((a.x + b.x) / 2 / VB_W) * 100,
        topPct: (10 / VB_H) * 100,
        drop,
        pct: rows[i].total > 0 ? Math.round((drop / rows[i].total) * 100) : 0,
      });
    }
  }

  // --- outcome nodes (splayed) + the verdict fan out of the last spine node ---
  const outcomes = rows.slice(spineCount);
  const casesNode = spine[spineCount - 1];
  const casesTotal = derived.casesTotal;
  let sliceCursor = casesNode ? casesNode.top : CY;
  outcomes.forEach((row, m) => {
    const oi = spineCount + m;
    const x = colCenter(oi);
    const h = row.total > 0 ? Math.max(MIN_SLIVER, row.total * k) : 0;
    const yc =
      outcomes.length > 1
        ? CY - OUTCOME_SPREAD + (2 * OUTCOME_SPREAD * m) / (outcomes.length - 1)
        : CY;
    const top = yc - h / 2;
    const colorName = OUTCOME_TOKEN[row.key] ?? 'primary';
    if (h > 0) rects.push({ x: x - NODE_W / 2, y: top, w: NODE_W, h, fill: token(colorName) });

    // Fan ribbon: a proportional slice of the cases node → this outcome node.
    if (casesNode && casesNode.h > 0 && row.total > 0) {
      const share = casesTotal > 0 ? row.total / casesTotal : 0;
      const sliceH = share * casesNode.h;
      const s0 = sliceCursor;
      const s1 = sliceCursor + sliceH;
      sliceCursor = s1;
      ribbons.push({
        id: `${uid}-o${m}`,
        path: ribbonPath(casesNode.x + NODE_W / 2, s0, s1, x - NODE_W / 2, top, top + h),
        colorName,
        x0: casesNode.x + NODE_W / 2,
        x1: x - NODE_W / 2,
        alpha0: 0.5,
        alpha1: 0.42,
      });
    }
  });

  // --- suppressed/ignored side-spur (peels down before clustering) ---
  const dropTotal = (drops.suppressed ?? 0) + (drops.ignored ?? 0);
  let spurPath: string | null = null;
  let spurNub: { x: number; y: number } | null = null;
  let spurChip: { leftPct: number; topPct: number } | null = null;
  if (dropTotal > 0 && spineCount >= 2 && spine[0].h > 0) {
    const sx = spine[0].x;
    const sy = spine[0].bottom - spine[0].h * 0.25;
    const nubX = (spine[0].x + spine[1].x) / 2;
    const nubY = VB_H - 12;
    spurPath = `M${sx},${sy} C${(sx + nubX) / 2},${sy} ${nubX},${nubY - 24} ${nubX},${nubY}`;
    spurNub = { x: nubX, y: nubY };
    spurChip = { leftPct: (nubX / VB_W) * 100, topPct: ((nubY - 4) / VB_H) * 100 };
  }

  return { ribbons, rects, badges, spurPath, spurNub, spurChip };
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
      <Skeleton className="mt-4 h-32 w-full" />
      <div className="mt-3 flex justify-between gap-2">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-6 w-14" />
        ))}
      </div>
    </section>
  );
}

/** The circular ShieldCheck / Bot phase marker used on each stage chip. */
function PhaseMarker({ deterministic }: { deterministic: boolean }) {
  const Icon: LucideIcon = deterministic ? ShieldCheck : Bot;
  return (
    <span
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-full border bg-card',
        deterministic ? 'border-low text-low' : 'border-info text-info',
      )}
      aria-hidden
    >
      <Icon className="h-3.5 w-3.5" focusable="false" />
    </span>
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
  const rawUid = React.useId();
  const uid = React.useMemo(() => rawUid.replace(/[^a-zA-Z0-9_-]/g, ''), [rawUid]);
  const derived = React.useMemo(() => (data ? deriveFunnel(data) : null), [data]);
  const dropSuppressed = data?.drops?.suppressed ?? 0;
  const dropIgnored = data?.drops?.ignored ?? 0;
  const layout = React.useMemo(
    () => (derived ? buildLayout(derived, { suppressed: dropSuppressed, ignored: dropIgnored }, uid) : null),
    [derived, dropSuppressed, dropIgnored, uid],
  );

  if (loading && !derived) return <LoadingState ariaLabel={ariaLabel} className={className} />;
  // Absent data + not loading → render nothing (a missing/off backend simply omits the widget).
  if (!data || !derived || !layout) return null;

  const overall = data.reduction?.overall_pct;
  const headlinePct = typeof overall === 'number' ? overall : null;
  const degradedNote =
    derived.mode === 'cases' ? 'Counters warming up — showing case-based funnel' : null;
  const relativeTo = derived.mode === 'full' ? 'of ingested' : 'of cases';
  const n = derived.rows.length;

  const chips = derived.rows.map((row) => {
    const pct = Math.round(row.pctRetained);
    const accessibleLabel = `${row.label}: ${row.total} ${row.total === 1 ? 'event' : 'events'}, ${pct}% ${relativeTo}`;

    const inner = (
      <>
        <PhaseMarker deterministic={row.deterministic} />
        <span className="max-w-full truncate text-2xs font-medium text-foreground">{row.label}</span>
        <span className="flex items-baseline gap-1">
          <CountUp
            value={row.total}
            duration={animate ? undefined : 0}
            className="text-sm font-semibold tabular-nums text-foreground"
          />
          <span className="text-2xs tabular-nums text-muted-foreground">{pct}%</span>
        </span>
      </>
    );

    if (onStageClick) {
      return (
        <button
          key={row.key}
          type="button"
          onClick={() => onStageClick(row.key)}
          aria-label={accessibleLabel}
          className={cn(
            'flex w-full flex-col items-center gap-1 rounded-md px-1 py-1.5 text-center transition-colors',
            'hover:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {inner}
        </button>
      );
    }
    return (
      <div
        key={row.key}
        role="group"
        aria-label={accessibleLabel}
        className="flex w-full flex-col items-center gap-1 px-1 py-1.5 text-center"
      >
        {inner}
      </div>
    );
  });

  const gridStyle: React.CSSProperties = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  const dropTotal = dropSuppressed + dropIgnored;

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
          {/* The decorative flow band — all meaning is carried by the rail below. */}
          <div className="relative mt-3 w-full" style={{ aspectRatio: `${VB_W} / ${VB_H}` }}>
            <svg
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              preserveAspectRatio="xMidYMid meet"
              className="absolute inset-0 h-full w-full"
              aria-hidden
              focusable="false"
            >
              <defs>
                {layout.ribbons.map((r) => (
                  <linearGradient
                    key={r.id}
                    id={r.id}
                    gradientUnits="userSpaceOnUse"
                    x1={r.x0}
                    y1={CY}
                    x2={r.x1}
                    y2={CY}
                  >
                    <stop offset="0%" stopColor={token(r.colorName, r.alpha0)} />
                    <stop offset="100%" stopColor={token(r.colorName, r.alpha1)} />
                  </linearGradient>
                ))}
              </defs>

              {/* Ribbons — grow in L→R (staggered), reduced-motion neutralises globally. */}
              {layout.ribbons.map((r, i) => (
                <path
                  key={r.id}
                  d={r.path}
                  fill={`url(#${r.id})`}
                  className={cn(animate && 'animate-ribbon-grow')}
                  style={
                    animate
                      ? { transformBox: 'fill-box', transformOrigin: '0% 50%', animationDelay: `${i * 70}ms` }
                      : undefined
                  }
                />
              ))}

              {/* Suppressed/ignored side-spur. */}
              {layout.spurPath ? (
                <>
                  <path
                    d={layout.spurPath}
                    fill="none"
                    stroke={token('muted-foreground', 0.5)}
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                  />
                  {layout.spurNub ? (
                    <circle cx={layout.spurNub.x} cy={layout.spurNub.y} r={2.5} fill={token('muted-foreground', 0.7)} />
                  ) : null}
                </>
              ) : null}

              {/* Node anchors on top of the ribbons. */}
              {layout.rects.map((rc, i) => (
                <rect key={i} x={rc.x} y={rc.y} width={rc.w} height={rc.h} rx={2} fill={rc.fill} />
              ))}
            </svg>

            {/* HTML overlay (decorative): per-connector drop-off badges + spur chip. */}
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {layout.badges.map((b, i) => (
                <span
                  key={i}
                  className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border bg-card px-1.5 py-0.5 text-2xs font-medium tabular-nums text-muted-foreground shadow-elev1"
                  style={{ left: `${b.leftPct}%`, top: `${b.topPct}%` }}
                >
                  −{b.drop} · −{b.pct}%
                </span>
              ))}
              {layout.spurChip ? (
                <span
                  className="absolute -translate-x-1/2 whitespace-nowrap rounded-full border border-dashed border-border bg-card px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground"
                  style={{ left: `${layout.spurChip.leftPct}%`, top: `${layout.spurChip.topPct}%` }}
                >
                  −{dropTotal}
                </span>
              ) : null}
            </div>
          </div>

          {/* The interactive + labelled rail: one focusable stage per column. */}
          {animate ? (
            <Stagger as="div" step={70} className="mt-2 grid items-start gap-1" style={gridStyle} itemClassName="min-w-0">
              {chips}
            </Stagger>
          ) : (
            <div className="mt-2 grid items-start gap-1" style={gridStyle}>
              {chips}
            </div>
          )}

          {dropTotal > 0 ? (
            <p className="mt-3 border-t border-border pt-2 text-2xs text-muted-foreground">
              {dropSuppressed} suppressed · {dropIgnored} ignored removed before clustering
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

export default NoiseFunnel;
