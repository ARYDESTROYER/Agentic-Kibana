/**
 * Chart color palette — theme-aware, sourced from the CSS design tokens.
 *
 * recharts needs concrete color STRINGS (it renders to SVG `fill`/`stroke`
 * attributes, which cannot consume Tailwind utility classes). To keep both the
 * light and the dark "command center" themes first-class WITHOUT hardcoding any
 * hex, we resolve the values straight from the same CSS custom properties the
 * rest of the UI uses (`--primary`, `--critical`, ...). Each token is stored as a
 * bare HSL triple (e.g. `217 91% 60%`), so we wrap it in `hsl(var(--x))` /
 * `hsl(var(--x) / a)` — the browser then re-resolves it per active theme.
 *
 * Because the values reference the live CSS variables, a chart re-render after a
 * theme toggle automatically picks up the new theme. No hardcoded colors.
 */

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

/**
 * Categorical sequence for multi-series / multi-segment charts (donuts, stacked
 * bars). Ordered for good adjacent contrast in both themes.
 */
export const CATEGORICAL: string[] = [
  palette.primary,
  palette.info,
  palette.success,
  palette.high,
  palette.medium,
  palette.critical,
  palette.low,
  palette.accent,
];

/** Pick a categorical color by index (wraps around). */
export function categorical(i: number): string {
  return CATEGORICAL[((i % CATEGORICAL.length) + CATEGORICAL.length) % CATEGORICAL.length];
}

/**
 * Semantic mapping for SOC enum-ish labels (severity / verdict / status). Falls
 * back to a categorical color when the label is unknown. Case-insensitive.
 */
const SEMANTIC: Record<string, string> = {
  // severity
  critical: palette.critical,
  high: palette.high,
  medium: palette.medium,
  moderate: palette.medium,
  low: palette.low,
  info: palette.info,
  informational: palette.info,
  // verdict
  true_positive: palette.critical,
  'true positive': palette.critical,
  false_positive: palette.success,
  'false positive': palette.success,
  benign: palette.success,
  needs_human: palette.warning,
  'needs human': palette.warning,
  escalated: palette.high,
  // status
  open: palette.info,
  in_progress: palette.primary,
  'in progress': palette.primary,
  investigating: palette.primary,
  closed: palette.success,
  resolved: palette.success,
  suppressed: palette.muted,
};

/** Resolve a semantic color for a domain label, else a stable categorical color. */
export function semanticColor(label: string, fallbackIndex = 0): string {
  if (!label) return categorical(fallbackIndex);
  const key = label.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return SEMANTIC[key] ?? SEMANTIC[label.trim().toLowerCase()] ?? categorical(fallbackIndex);
}
