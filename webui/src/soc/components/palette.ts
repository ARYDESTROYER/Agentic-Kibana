/**
 * The ONE label→token authority (Round-5 W0-A / DESIGN_STANDARD §1.4/§1.6/§6.1).
 *
 * recharts needs concrete color STRINGS (it renders to SVG `fill`/`stroke`, which
 * cannot consume Tailwind utility classes). To keep BOTH the light and dark themes
 * first-class WITHOUT hardcoding any hex, we resolve values straight from the same
 * CSS custom properties the rest of the UI uses (`--primary`, `--critical`, …) via
 * `hsl(var(--x))` — the browser re-resolves per active theme, so a chart re-render
 * after a theme toggle automatically picks up the new palette. No hardcoded colors.
 *
 * This module is the SINGLE source of truth for the three orthogonal semantic axes
 * (SEVERITY · STATUS · VERDICT), their beside-color redundancy icons (`SEMANTIC_ICON`,
 * WCAG 1.4.1), the ONE 0-100 threshold ladder, the colorblind-safe categorical chart
 * ramp (`--chart-1..8`, Okabe-Ito), and a viridis sequential ramp for heatmaps. Both
 * the Tailwind Badge variant AND the recharts `hsl()` string derive from these maps,
 * so the two can never drift apart again.
 */
import {
  AlertOctagon,
  AlertTriangle,
  Square,
  Circle,
  CircleDashed,
  CircleDot,
  HelpCircle,
  Check,
  Copy,
  type LucideIcon,
} from 'lucide-react';

/** Resolve a single semantic token to an `hsl(var(--token))` color string. */
export function token(name: string, alpha?: number): string {
  return typeof alpha === 'number'
    ? `hsl(var(--${name}) / ${alpha})`
    : `hsl(var(--${name}))`;
}

/** Named theme colors usable directly as recharts `fill`/`stroke`. */
export const palette = {
  primary: token('primary'),
  accent: token('accent'),
  critical: token('critical'),
  high: token('high'),
  medium: token('medium'),
  low: token('low'),
  info: token('info'),
  success: token('success'),
  warning: token('warning'),
  muted: token('muted'),
  mutedForeground: token('muted-foreground'),
  foreground: token('foreground'),
  border: token('border'),
  card: token('card'),
} as const;

export type PaletteKey = keyof typeof palette;

/* ------------------------------------------------------------------------- */
/* Categorical chart ramp — colorblind-safe (Okabe-Ito), off `--chart-*`.     */
/* ------------------------------------------------------------------------- */

/**
 * Categorical sequence for IDENTITY-ARBITRARY multi-series charts (per-model bars,
 * cost donut) where the color carries no semantic meaning. Sourced from the
 * dedicated `--chart-1..8` Okabe-Ito ramp (NOT the severity/status/verdict tokens),
 * so an arbitrary chart can never collide red/green/orange with a semantic reading.
 * `--chart-8` is a neutral grey reserved for an "Other" bucket.
 *
 * SEMANTIC charts (verdict/severity donuts) must keep using `semanticColor()`.
 */
export const CATEGORICAL: string[] = [
  token('chart-1'),
  token('chart-2'),
  token('chart-3'),
  token('chart-4'),
  token('chart-5'),
  token('chart-6'),
  token('chart-7'),
  token('chart-8'),
];

/** The count of DISTINCT arbitrary series before everything folds into "Other". */
export const CATEGORICAL_CAP = 7;

/** Pick a categorical color by index (wraps around). */
export function categorical(i: number): string {
  return CATEGORICAL[((i % CATEGORICAL.length) + CATEGORICAL.length) % CATEGORICAL.length];
}

/**
 * Cap an arbitrary categorical series at {@link CATEGORICAL_CAP} distinct colors +
 * a grey "Other" (`--chart-8`). Returns the color for slot `i` in a series of
 * length `total`: the first 7 get chart-1..7; anything beyond folds to grey.
 */
export function categoricalCapped(i: number, total: number): string {
  if (total <= CATEGORICAL_CAP + 1) return categorical(i);
  return i < CATEGORICAL_CAP ? CATEGORICAL[i] : token('chart-8');
}

/* ------------------------------------------------------------------------- */
/* Sequential (viridis) — for heatmaps (MITRE coverage, risk gradients).      */
/* 7 hardcoded stops + a dependency-free lerp (no d3-scale-chromatic).        */
/* ------------------------------------------------------------------------- */

/** Viridis control stops (perceptually-uniform, CVD-friendly). */
const VIRIDIS_STOPS: ReadonlyArray<[number, number, number]> = [
  [0x44, 0x01, 0x54], // #440154
  [0x44, 0x39, 0x83], // #443983
  [0x31, 0x68, 0x8e], // #31688e
  [0x21, 0x91, 0x8c], // #21918c
  [0x35, 0xb7, 0x79], // #35b779
  [0x90, 0xd7, 0x43], // #90d743
  [0xfd, 0xe7, 0x25], // #fde725
];

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : Number.isNaN(t) ? 0 : t;
}

/**
 * Sample the viridis ramp at `t` in [0,1], returning an `rgb(r, g, b)` string.
 * Linear-interpolates between the nearest control stops. Because the value is a
 * concrete rgb() (not a token), it renders identically in both themes — which is
 * correct for a sequential gradient (the intensity, not the theme, carries meaning).
 */
export function sequential(t: number): string {
  const x = clamp01(t) * (VIRIDIS_STOPS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS_STOPS[i];
  const b = VIRIDIS_STOPS[Math.min(i + 1, VIRIDIS_STOPS.length - 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r}, ${g}, ${bl})`;
}

/* ------------------------------------------------------------------------- */
/* The 3 orthogonal semantic axes — each a separate map (can't re-conflate).   */
/* Values are TOKEN NAMES (used as `bg-{name}`/`text-{name}` variants AND, via  */
/* token(), as recharts hsl() strings). Preserve currently-shipped colors per   */
/* label except the two documented fixes: escalated→high, FP→info (blue-grey).  */
/* ------------------------------------------------------------------------- */

/** SEVERITY / RISK axis — red → orange → gold → blue → blue-grey. No green. */
export const SEVERITY_COLOR = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
} as const;
export type SeverityKey = keyof typeof SEVERITY_COLOR;

/** STATUS axis — case lifecycle. `investigating` = primary; resolved/closed green. */
export const STATUS_COLOR = {
  new: 'muted',
  investigating: 'primary',
  escalated: 'high',
  on_hold: 'warning',
  resolved: 'success',
  closed: 'success',
} as const;
export type StatusKey = keyof typeof STATUS_COLOR;

/** VERDICT axis — TP critical-red; FP/benign neutral blue-grey (NOT green). */
export const VERDICT_COLOR = {
  true_positive: 'critical',
  false_positive: 'info',
  benign: 'info',
  needs_human: 'warning',
  suspicious: 'high',
  duplicate: 'muted',
  undetermined: 'muted',
} as const;
export type VerdictKey = keyof typeof VERDICT_COLOR;

/**
 * Non-color redundancy beside every color (WCAG 1.4.1) — consumed by badges, the
 * risk gauge, chart legends, and the MITRE heatmap. Keyed by every severity /
 * status / verdict label so a single lookup gives the beside-color glyph.
 */
export const SEMANTIC_ICON: Record<string, LucideIcon> = {
  // severity
  critical: AlertOctagon, // filled diamond/octagon
  high: AlertTriangle, // filled triangle
  medium: Square, // filled square
  low: Circle, // filled circle
  info: CircleDashed, // hollow circle
  // verdict
  true_positive: CircleDot, // solid dot
  false_positive: Circle, // hollow dot (blue-grey)
  benign: Circle,
  needs_human: HelpCircle, // hand / ?
  suspicious: AlertTriangle,
  // status
  escalated: AlertTriangle,
  resolved: Check, // check
  closed: Check,
  investigating: CircleDot,
  on_hold: HelpCircle,
  new: Circle,
  duplicate: Copy, // hollow square-ish
  undetermined: HelpCircle,
};

/** Look up the beside-color icon for a semantic label (case-insensitive). */
export function semanticIcon(label: string | null | undefined): LucideIcon | undefined {
  if (!label) return undefined;
  const key = label.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return SEMANTIC_ICON[key];
}

/* ------------------------------------------------------------------------- */
/* The ONE 0-100 threshold ladder (Elastic numeric bands).                    */
/*   0-21 low · 22-47 medium · 48-73 high · 74-100 critical.                   */
/* Collapses the four ad-hoc band ladders (badges severityBandFromNumber,      */
/* riskVariant, RiskGauge bandOf, postureFromScore) into ONE module.           */
/* ------------------------------------------------------------------------- */

export type ScoreBand = 'low' | 'medium' | 'high' | 'critical';

/** Map a 0-100 score to a band using the Elastic numeric ladder. */
export function scoreBand(score: number): ScoreBand {
  if (score >= 74) return 'critical';
  if (score >= 48) return 'high';
  if (score >= 22) return 'medium';
  return 'low';
}

/** The inclusive [min, max] range each band occupies on the 0-100 ladder. */
export const SCORE_BANDS: Record<ScoreBand, readonly [number, number]> = {
  low: [0, 21],
  medium: [22, 47],
  high: [48, 73],
  critical: [74, 100],
} as const;

/* ------------------------------------------------------------------------- */
/* semanticColor — resolve any SOC label to a concrete color STRING.          */
/* Backed by the three axis maps above (single source of truth).              */
/* ------------------------------------------------------------------------- */

/** Merged label→token lookup across all three axes (+ a few legacy aliases). */
const SEMANTIC_TOKEN: Record<string, string> = {
  ...SEVERITY_COLOR,
  ...STATUS_COLOR,
  ...VERDICT_COLOR,
  // legacy / alternate spellings kept working (map to the same token names)
  moderate: 'medium',
  informational: 'info',
  in_progress: 'primary',
  open: 'info',
  suppressed: 'muted',
};

/**
 * Resolve a semantic color for a domain label, else a stable categorical color.
 * Returns a concrete `hsl(var(--token))` STRING (recharts-ready). Case-insensitive;
 * spaces/hyphens normalise to underscores.
 */
export function semanticColor(label: string, fallbackIndex = 0): string {
  if (!label) return categorical(fallbackIndex);
  const key = label.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const name = SEMANTIC_TOKEN[key] ?? SEMANTIC_TOKEN[label.trim().toLowerCase()];
  return name ? token(name) : categorical(fallbackIndex);
}
