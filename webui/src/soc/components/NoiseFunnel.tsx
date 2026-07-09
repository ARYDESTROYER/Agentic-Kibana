/**
 * NoiseFunnel — the "Noise Reduction" flow ribbon for the Security Command Center
 * (restored + polished from the Round-8 horizontal-Sankey ribbon).
 *
 * Tells the value-prop story of how the agent thins raw alert volume down to the
 * handful of cases a human sees, as a left-to-right flow:
 *
 *     ingested → clustered → cases → auto_cleared → escalated → closed
 *
 * The raw ingested volume enters on the LEFT pre-split into its SEVERITY bands as
 * parallel strands; those strands thin through clustering and case-creation (each
 * connector carries a drop-off badge), and at the right the `cases` node fans out
 * into the three terminal case OUTCOMES (auto_cleared = AI-closed · escalated · closed
 * = human-driven terminal). The `needs_human`/`true_positive` keys remain in the raw
 * payload for back-compat but are no longer separate spine chips. Node
 * heights use a gentle floor-compressed scale so the deep reduction stays legible
 * (a strictly-proportional scale crushes the small survivor stages into invisible
 * slivers — the exact "wavy blob" the flat redesign was reacting to); the EXACT
 * counts + shares always live on the focusable rail below, so the flow can be a
 * clean, decorative flourish while the numbers stay honest.
 *
 * Premium polish: a prominent "Noise reduced by X%" hero + an ingested→human cascade
 * line, a symmetric full-width flow band (`preserveAspectRatio='none'` so nodes+rail
 * stay column-aligned with no dead side-gutter), fully-rounded card corners, and a
 * rich per-stage HOVER card (count, share, one-line meaning, per-severity /
 * per-disposition breakdown) on every rail chip.
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
import { fmtNumber } from '@/lib/format';
import type { NoiseReduction, NoiseSeverityBreakdown, NoiseStage } from '@/lib/types';
import { Skeleton } from '@/ui/skeleton';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/ui/hover-card';
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

const SEV_LABEL: Record<SevBand, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

/**
 * Outcome ribbon colour (cases → the terminal outcomes) — the VERDICT/STATUS semantic
 * axis: severity describes the INPUT, the outcome describes the OUTPUT. `closed` (human-
 * resolved) reads on the resolved/success token, the calm end of the flow.
 */
const OUTCOME_TOKEN: Record<string, string> = {
  auto_cleared: VERDICT_COLOR.false_positive, // blue-grey (a cleared false positive)
  escalated: VERDICT_COLOR.suspicious, // amber-orange
  closed: 'success', // green — a human drove it to a terminal state
  needs_human: VERDICT_COLOR.needs_human, // warning (back-compat; no longer a spine chip)
  true_positive: VERDICT_COLOR.true_positive, // critical-red (back-compat)
};

/** Fallback labels for the canonical funnel stages (the backend supplies `label`). */
const STAGE_LABEL: Record<string, string> = {
  ingested: 'Ingested',
  clustered: 'Clustered',
  // Below-floor candidates: risk-scored but NOT yet promoted to an LLM investigation.
  candidate: 'Awaiting review',
  awaiting: 'Awaiting review',
  cases: 'Cases opened',
  auto_cleared: 'Auto-cleared',
  escalated: 'Escalated',
  closed: 'Closed by human',
  needs_human: 'Needs human',
  true_positive: 'True positive',
};

/** One-line "what this stage means" copy for the per-stage hover card (plain text). */
const STAGE_MEANING: Record<string, string> = {
  ingested: 'Every raw alert pulled from your connected sources, before any triage.',
  clustered: 'Related alerts grouped into deduplicated clusters by the correlation engine.',
  // Honest about the below-floor tier: these are seen + risk-scored, not silently dropped,
  // but they have NOT been reasoned over by the strong LLM yet (they sit below the
  // auto-investigate risk floor). They stay $0 candidates until risk/anomaly promotes them.
  candidate:
    'Clusters the agent risk-scored but kept below the auto-investigate floor — seen and ' +
    'tracked as $0 candidates, not yet reasoned over by the AI.',
  awaiting:
    'Clusters the agent risk-scored but kept below the auto-investigate floor — seen and ' +
    'tracked as $0 candidates, not yet reasoned over by the AI.',
  cases: 'Clusters the agent promoted into investigable cases.',
  auto_cleared: 'Cases the agent auto-closed as false positives — no human needed.',
  escalated: 'Cases raised in priority for faster analyst attention.',
  closed: 'Cases a human analyst drove to a terminal state (resolved / closed).',
  needs_human: 'Cases routed to a human for the final decision.',
  true_positive: 'Cases confirmed as real, actionable threats.',
};

/** The terminal case outcomes rendered in the fan out of `cases` (AI-cleared, escalated,
 *  human-closed). `needs_human`/`true_positive` are intentionally excluded (back-compat
 *  data only; the visible flow ends at `closed`). */
const OUTCOME_KEYS = ['auto_cleared', 'escalated', 'closed'];

/** Popover help copy (>80 chars → focusable Popover, not a bare Tooltip). */
export const NOISE_FUNNEL_HELP_TEXT =
  'How the agent reduces raw alert volume: every ingested alert (by severity) is ' +
  'clustered, a fraction become cases, and each case ends as auto-cleared (false ' +
  'positive), escalated, needs-human, or a confirmed true positive. The spine ' +
  'percentages are each stage’s share of the raw ingested total; hover any stage for ' +
  'its exact count and per-severity breakdown.';

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
  /** auto_cleared + escalated + closed — OVERLAPPING terminal views of `cases`, NOT a
   *  strict partition (an escalated case can also be human-closed), so this can exceed
   *  `casesTotal`. Used only for the rail summary; the fan normalizes to avoid overflow. */
  outcomeSum: number;
}

/**
 * Derive the ordered funnel rows from the §D contract as the linear flow
 * ingested → clustered → cases → auto_cleared → escalated → closed, switching to a
 * case-only flow when the durable ingest counters are unavailable. The trailing
 * `closed` stage (label "Closed by human") is supplied by the backend (terminal AND NOT
 * AI-auto-cleared); the legacy `needs_human`/`true_positive` keys stay in the payload for
 * back-compat but are no longer separate spine chips. The MECE `reduction.overall_pct`
 * headline is the backend's own value and is byte-identical here.
 */
export function deriveFunnel(data: NoiseReduction): DerivedFunnel {
  const byKey = new Map<string, NoiseStage>();
  for (const s of data.stages ?? []) byKey.set(s.key, s);

  const countersOk = data.counters?.available !== false;

  const casesTotal = byKey.get('cases')?.total ?? 0;
  const auto = byKey.get('auto_cleared')?.total ?? 0;
  const esc = byKey.get('escalated')?.total ?? 0;
  const closed = byKey.get('closed')?.total ?? 0;

  // A below-floor "Awaiting review" tier: clusters that were correlated + risk-scored but
  // stayed below the auto-investigate floor, so they are kept as $0 candidates and have NOT
  // been reasoned over by the LLM. Rendered between `clustered` and `cases` ONLY when the
  // backend emits such a stage — so the flow is BYTE-IDENTICAL (six stages) when it doesn't,
  // and honestly shows the candidate tier when it does. Keeps the UI from implying reasoning
  // that isn't happening for below-floor candidates.
  const candidateKey = byKey.has('candidate')
    ? 'candidate'
    : byKey.has('awaiting')
      ? 'awaiting'
      : null;

  // Full flow from ingested, or case-only when the counters are still warming up.
  const visibleKeys = countersOk
    ? [
        'ingested',
        'clustered',
        ...(candidateKey ? [candidateKey] : []),
        'cases',
        'auto_cleared',
        'escalated',
        'closed',
      ]
    : ['cases', 'auto_cleared', 'escalated', 'closed'];

  const topKey = countersOk ? 'ingested' : 'cases';
  const topTotal = byKey.get(topKey)?.total ?? casesTotal;

  const asRow = (key: string, stage: NoiseStage | undefined): FunnelRow => {
    const total = stage?.total ?? 0;
    return {
      key,
      label: stage?.label || STAGE_LABEL[key] || key,
      total,
      by_severity: stage?.by_severity ?? {},
      // Trust the backend flag; default per the §H pin (only `cases` is LLM-influenced;
      // `closed` is a human-driven terminal, so it reads as deterministic).
      deterministic: stage ? stage.deterministic : key !== 'cases',
      ratio: topTotal > 0 ? total / topTotal : 0,
      pctRetained: topTotal > 0 ? (total / topTotal) * 100 : 0,
      isOutcome: OUTCOME_KEYS.includes(key),
    };
  };

  const rows = visibleKeys.map((key) => asRow(key, byKey.get(key)));

  return {
    rows,
    topTotal,
    mode: countersOk ? 'full' : 'cases',
    casesTotal,
    // The three terminal outcomes rendered in the fan out of `cases`.
    outcomeSum: auto + esc + closed,
  };
}

/* ------------------------------------------------------------------------- */
/* Sankey geometry.                                                            */
/* ------------------------------------------------------------------------- */

/** Fixed-aspect viewBox (~2.9:1, wide QRadar-style flow). Stretch-scaled to the band. */
const VB_W = 640;
const VB_H = 220;
/** Vertical center + the plot band the strands live in. */
const CY = VB_H / 2;
const PLOT_PAD = 24;
const PLOT_H = VB_H - PLOT_PAD * 2;
/** Node rect width + the vertical splay the four outcomes fan across. */
const NODE_W = 8;
const OUTCOME_SPREAD = 58;
/**
 * Node heights use a floored-linear scale: a node with the whole top-of-funnel volume
 * fills the plot band, and the smallest node still shows `NODE_FLOOR` of it — so the
 * survivor stages read as real (thin) bars instead of degenerating into slivers/blobs.
 * The exact counts live on the rail, so this readability compression stays honest.
 */
const NODE_FLOOR = 0.2;
/** A nonzero-but-tiny outcome node stays at least this many user-units tall. */
const OUTCOME_MIN = 6;
/** Strand opacity at the source; the target end fades by how much survived. */
const STRAND_ALPHA = 0.6;
const STRAND_ALPHA_MIN = 0.2;

/** Floor-compressed spine node height (keeps a deep reduction legible). */
function spineNodeHeight(total: number, topTotal: number): number {
  if (total <= 0) return 0;
  const prop = topTotal > 0 ? Math.min(1, total / topTotal) : 0;
  return PLOT_H * (NODE_FLOOR + (1 - NODE_FLOOR) * prop);
}

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
  const topTotal = derived.topTotal;
  const colCenter = (i: number) => (VB_W * (i + 0.5)) / Math.max(1, n);

  const rects: Rect[] = [];
  const ribbons: Ribbon[] = [];
  const badges: Badge[] = [];

  // --- spine nodes (centered), with severity segments ---
  const spine: SpineGeom[] = [];
  for (let i = 0; i < spineCount; i++) {
    const row = rows[i];
    const x = colCenter(i);
    const h = spineNodeHeight(row.total, topTotal);
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
  const casesH = casesNode ? casesNode.h : 0;
  // The visible outcomes (auto_cleared / escalated / closed) are OVERLAPPING terminal views
  // of `cases`, not a strict partition, so their source-side shares can sum past 1.0. Scale
  // the fan's SOURCE slices by their own sum so the ribbons always tile the cases node exactly
  // instead of overflowing it. Each outcome NODE keeps its true share-based height (an honest
  // per-outcome magnitude); only the shared source fan is normalized. The exact counts live on
  // the rail, so this readability normalization stays honest.
  const shareSum = outcomes.reduce(
    (a, r) => a + (casesTotal > 0 && r.total > 0 ? r.total / casesTotal : 0),
    0,
  );
  const srcScale = shareSum > 1 ? 1 / shareSum : 1;
  let sliceCursor = casesNode ? casesNode.top : CY;
  outcomes.forEach((row, m) => {
    const oi = spineCount + m;
    const x = colCenter(oi);
    const share = casesTotal > 0 ? row.total / casesTotal : 0;
    const h = row.total > 0 ? Math.max(OUTCOME_MIN, share * casesH) : 0;
    const yc =
      outcomes.length > 1
        ? CY - OUTCOME_SPREAD + (2 * OUTCOME_SPREAD * m) / (outcomes.length - 1)
        : CY;
    const top = yc - h / 2;
    const colorName = OUTCOME_TOKEN[row.key] ?? 'primary';
    if (h > 0) rects.push({ x: x - NODE_W / 2, y: top, w: NODE_W, h, fill: token(colorName) });

    // Fan ribbon: a proportional (source-normalized) slice of the cases node → this outcome.
    if (casesNode && casesH > 0 && row.total > 0) {
      const sliceH = share * casesH * srcScale;
      const s0 = sliceCursor;
      const s1 = sliceCursor + sliceH;
      sliceCursor = s1;
      ribbons.push({
        id: `${uid}-o${m}`,
        path: ribbonPath(casesNode.x + NODE_W / 2, s0, s1, x - NODE_W / 2, top, top + h),
        colorName,
        x0: casesNode.x + NODE_W / 2,
        x1: x - NODE_W / 2,
        alpha0: 0.55,
        alpha1: 0.45,
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
/* Presentation helpers.                                                       */
/* ------------------------------------------------------------------------- */

/** The circular ShieldCheck / Bot phase marker used on each stage chip. */
function PhaseMarker({ deterministic, size = 'md' }: { deterministic: boolean; size?: 'sm' | 'md' }) {
  const Icon: LucideIcon = deterministic ? ShieldCheck : Bot;
  const box = size === 'sm' ? 'h-5 w-5' : 'h-6 w-6';
  const glyph = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border bg-card',
        box,
        deterministic ? 'border-low text-low' : 'border-info text-info',
      )}
      aria-hidden
    >
      <Icon className={glyph} focusable="false" />
    </span>
  );
}

/** Per-severity (or per-disposition) mini breakdown shown inside a stage hover card. */
function StageBreakdown({ row }: { row: FunnelRow }) {
  const entries = SEV_ORDER.map(
    (b) => [b, Math.max(0, Number(row.by_severity[b] ?? 0))] as const,
  ).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  const max = entries.reduce((m, [, v]) => Math.max(m, v), 0) || 1;
  return (
    <div className="space-y-1.5">
      <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        By severity
      </p>
      <ul className="space-y-1.5">
        {entries.map(([band, value]) => (
          <li key={band} className="flex items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: token(BAND_TOKEN[band]) }}
              aria-hidden
            />
            <span className="w-14 shrink-0 text-2xs text-muted-foreground">{SEV_LABEL[band]}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full"
                style={{ width: `${(value / max) * 100}%`, backgroundColor: token(BAND_TOKEN[band]) }}
              />
            </span>
            <span className="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-foreground">
              {fmtNumber(value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The rich hover-card body for one stage chip. */
function StageHoverContent({
  row,
  relativeTo,
  casesTotal,
}: {
  row: FunnelRow;
  relativeTo: string;
  casesTotal: number;
}) {
  const pctRetained = Math.round(row.pctRetained);
  const ofCases = row.isOutcome && casesTotal > 0 ? Math.round((row.total / casesTotal) * 100) : null;
  const meaning = STAGE_MEANING[row.key];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <PhaseMarker deterministic={row.deterministic} size="sm" />
        <span className="text-sm font-semibold text-foreground">{row.label}</span>
        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {row.deterministic ? 'Deterministic' : 'AI-assisted'}
        </span>
      </div>
      {meaning ? <p className="text-xs leading-relaxed text-muted-foreground">{meaning}</p> : null}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
          {fmtNumber(row.total)}
        </span>
        <span className="text-2xs tabular-nums text-muted-foreground">
          {pctRetained}% {relativeTo}
          {ofCases != null ? ` · ${ofCases}% of cases` : ''}
        </span>
      </div>
      <StageBreakdown row={row} />
    </div>
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
      <Skeleton className="mt-4 h-40 w-full" />
      <div className="mt-3 flex justify-between gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-6 w-14" />
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
    derived.mode === 'cases' ? 'Counters warming up — showing case-based funnel' : 'Reduction pending';
  const relativeTo = derived.mode === 'full' ? 'of ingested' : 'of cases';
  const n = derived.rows.length;
  const casesTotal = derived.casesTotal;
  const closedByHuman = derived.rows.find((r) => r.key === 'closed')?.total ?? 0;

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

    const trigger = onStageClick ? (
      <button
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
    ) : (
      <div
        role="group"
        aria-label={accessibleLabel}
        className="flex w-full flex-col items-center gap-1 rounded-md px-1 py-1.5 text-center"
      >
        {inner}
      </div>
    );

    return (
      <HoverCard key={row.key} openDelay={120} closeDelay={80}>
        <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
        <HoverCardContent side="top" align="center" className="w-72">
          <StageHoverContent row={row} relativeTo={relativeTo} casesTotal={casesTotal} />
        </HoverCardContent>
      </HoverCard>
    );
  });

  const gridStyle: React.CSSProperties = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  const dropTotal = dropSuppressed + dropIgnored;

  return (
    <section
      className={cn('rounded-lg border border-border bg-card p-4', className)}
      role="group"
      aria-label={ariaLabel ?? 'Noise reduction funnel'}
      data-testid="noise-funnel"
    >
      <Header hidden={hidden} onToggleHidden={onToggleHidden} />

      {hidden ? null : (
        <div className="mt-3 space-y-3">
          {/* Hero — the value-prop headline + the ingested→human cascade. */}
          {headlinePct != null ? (
            <div>
              <p className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                Noise reduced by <span className="text-primary tabular-nums">{headlinePct}%</span>
              </p>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {fmtNumber(derived.topTotal)}{' '}
                {derived.mode === 'full' ? 'events ingested' : 'cases opened'} →{' '}
                {fmtNumber(closedByHuman)} case{closedByHuman === 1 ? '' : 's'} closed by a human
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="noise-funnel-warming">
              {degradedNote}
            </p>
          )}

          {/* The decorative flow band — full-width, column-aligned with the rail below
              (preserveAspectRatio='none' fills the width so nodes never letterbox into a
              dead side-gutter). All meaning is carried by the interactive rail. */}
          <div className="relative mt-1 h-44 w-full sm:h-52">
            <svg
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              preserveAspectRatio="none"
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

          {/* The interactive + labelled rail: one focusable, hover-detailed stage per column. */}
          {animate ? (
            <Stagger as="div" step={70} className="grid items-start gap-1" style={gridStyle} itemClassName="min-w-0">
              {chips}
            </Stagger>
          ) : (
            <div className="grid items-start gap-1" style={gridStyle}>
              {chips}
            </div>
          )}

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
