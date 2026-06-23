/**
 * Shared visual language for the Agentic SOC console.
 *
 * The semantic colour palette is reproduced from the former Kibana plugin's
 * `ui.tsx` (kept identical so the standalone console reads the same), expressed
 * as plain hex tokens applied via inline style — no `@kbn/*` theme imports, which
 * do not exist in the standalone build. EUI's own light/dark theme CSS provides
 * the chrome; these tokens encode risk / verdict / status semantics on top.
 */

/**
 * Built-in default accents — the historical brand colours. Kept separate so we
 * can always fall back to a byte-identical-to-today palette when no branding is
 * configured (or branding fails to load).
 */
export const DEFAULT_ACCENT = '#1c66e0';
export const DEFAULT_ACCENT2 = '#8a55c9';

/**
 * Semantic colour tokens (one accent per meaning).
 *
 * NOTE: this object is intentionally a plain (mutable) object — NOT `as const` —
 * so `setAccent()` can re-theme `primary` / `accent2` at runtime without touching
 * any call site (every consumer reads `COLORS.primary` live). The default values
 * are the historical brand colours, so first paint with no branding is unchanged.
 * `accent` (the legacy secondary token name) is kept and aliased to `accent2`.
 */
export const COLORS = {
  primary: DEFAULT_ACCENT,
  success: '#0a9b86',
  warning: '#d9930a',
  danger: '#c4341c',
  accent: DEFAULT_ACCENT2,
  /** Secondary accent (alias of `accent`, kept for explicit two-accent reads). */
  accent2: DEFAULT_ACCENT2,
  subdued: '#646b78',
  surface: '#f7f9fc',
};

/** Translucent tint of a hex colour, used for icon chips / soft fills. */
export function tint(hex: string, alpha = 0.12): string {
  const h = (hex || '').replace('#', '');
  if (h.length < 6) return `rgba(28, 102, 224, ${alpha})`;
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(28, 102, 224, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** True for a syntactically valid #rrggbb hex colour. */
function isHex6(v?: string): v is string {
  return typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v.trim());
}

/** Normalise to a leading-`#` 6-digit hex (or undefined if invalid). */
function normHex(v?: string): string | undefined {
  if (!isHex6(v)) return undefined;
  const s = v.trim();
  return s.startsWith('#') ? s : `#${s}`;
}

/**
 * Re-theme the accent colours at RUNTIME without breaking any call site.
 *
 * - Mutates `COLORS.primary` / `COLORS.accent` / `COLORS.accent2` in place so
 *   existing components that read `COLORS.primary` pick up the new value.
 * - Writes CSS custom properties on `<html>` so the plain CSS (logo gradient,
 *   brand accent bar, chat bubble) re-themes too: `--soc-accent`, `--soc-accent2`,
 *   and a soft `--soc-accent-tint`.
 *
 * Passing an invalid / empty value for either argument falls back to the built-in
 * default for that slot, so calling `setAccent()` with no args restores defaults.
 */
export function setAccent(primary?: string, secondary?: string): void {
  const p = normHex(primary) ?? DEFAULT_ACCENT;
  const s = normHex(secondary) ?? DEFAULT_ACCENT2;
  COLORS.primary = p;
  COLORS.accent = s;
  COLORS.accent2 = s;
  if (typeof document !== 'undefined' && document.documentElement) {
    const root = document.documentElement.style;
    root.setProperty('--soc-accent', p);
    root.setProperty('--soc-accent2', s);
    root.setProperty('--soc-accent-tint', tint(p, 0.14));
    // Re-theme the user chat bubble's second stop. When the accent is the default
    // brand blue we keep the original lighter-blue stop so the bubble is unchanged;
    // a custom brand uses its secondary accent.
    root.setProperty('--soc-bubble2', p === DEFAULT_ACCENT ? '#2f74e8' : s);
  }
}

/**
 * Layout density tokens — the single source of truth for content width so wide
 * screens don't waste space and every page lines up to the same column. Used by
 * the Shell's page section and any surface that wants the standard measure.
 */
export const MAX_CONTENT_WIDTH = 1320;

/**
 * Spacing scale (px) — a small, consistent rhythm so paddings/gaps stop being
 * scattered magic numbers. Mirrors EUI's 4px base but is plain numbers for inline
 * `style` use. Additive: existing call sites are unaffected.
 */
export const SPACE = {
  xxs: 2,
  xs: 4,
  s: 8,
  m: 12,
  l: 16,
  xl: 24,
  xxl: 32,
} as const;

/**
 * Corner-radius scale (px) — one consistent set of radii for chips, tiles, cards
 * and pills so the whole console reads as one design language.
 */
export const RADIUS = {
  /** Inline chips / code pills. */
  sm: 6,
  /** Buttons / small controls. */
  md: 8,
  /** Icon chips. */
  chip: 10,
  /** Cards / panels / tiles. */
  lg: 12,
  /** Fully-round pills. */
  pill: 999,
} as const;

/** Font-weight tokens — keeps emphasis consistent across surfaces. */
export const WEIGHT = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

/**
 * Typography scale — replaces scattered `fontSize:` literals so every surface
 * uses one consistent set of display sizes. Values are plain CSS strings to drop
 * straight into inline `style` (e.g. `style={{ fontSize: TYPE.kpi }}`).
 */
export const TYPE = {
  /** Marketing/landing hero. */
  hero: '34px',
  /** Page title. */
  h1: '22px',
  /** Section / card title. */
  h2: '17px',
  /** KPI tile number. */
  kpi: '24px',
  /** Oversized KPI number (single hero stat). */
  kpiLg: '34px',
  /** Eyebrow / tile label (uppercase microcopy). */
  label: '11px',
} as const;

/** Named EUI badge colour for a verdict. */
export function verdictColor(
  verdict?: string,
): 'danger' | 'success' | 'warning' | 'default' {
  const v = (verdict || '').toUpperCase();
  if (v.includes('TRUE')) return 'danger';
  if (v.includes('FALSE')) return 'success';
  if (v.includes('INCONCLUSIVE') || v.includes('UNKNOWN') || v.includes('NEEDS_HUMAN')) {
    return 'warning';
  }
  return 'default';
}

/** Hex accent for a verdict (for left borders / icon chips). */
export function verdictHex(verdict?: string): string {
  switch (verdictColor(verdict)) {
    case 'danger':
      return COLORS.danger;
    case 'success':
      return COLORS.success;
    case 'warning':
      return COLORS.warning;
    default:
      return COLORS.subdued;
  }
}

/** Hex accent for a case lifecycle status. */
export function statusHex(status?: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'closed') return COLORS.success;
  if (s === 'needs_human') return COLORS.warning;
  if (s === 'open') return COLORS.primary;
  return COLORS.subdued;
}

/** Risk colour scale over the normalised 0..100 risk score. */
export function riskHex(score?: number): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return COLORS.subdued;
  if (score < 30) return COLORS.success;
  if (score < 60) return COLORS.warning;
  if (score < 80) return '#e2725b';
  return COLORS.danger;
}

/** Risk band {label,color} for a 0..100 score — used by gauges/badges. */
export function riskBand(score?: number): { label: string; color: string } {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return { label: 'Unknown', color: COLORS.subdued };
  }
  if (score < 30) return { label: 'Low', color: COLORS.success };
  if (score < 60) return { label: 'Medium', color: COLORS.warning };
  if (score < 80) return { label: 'High', color: '#e2725b' };
  return { label: 'Critical', color: COLORS.danger };
}

/** Stable categorical palette for charts (donuts, bar lists, legends). */
export const CHART_COLORS = [
  '#1c66e0', '#8a55c9', '#0a9b86', '#d9930a',
  '#c4341c', '#2aa0a4', '#d6336c', '#7048e8',
] as const;

/** Pick a chart colour by index (wraps). */
export function chartColor(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length];
}

/** Accent + icon for each connector category (the wizard groups by these). */
export const CATEGORY_META: Record<string, { label: string; icon: string; accent: string }> = {
  siem: { label: 'SIEM / Log stores', icon: 'logstashQueue', accent: COLORS.primary },
  edr_xdr: { label: 'EDR / XDR', icon: 'securityApp', accent: COLORS.danger },
  transport: { label: 'Transports / Receivers', icon: 'cluster', accent: COLORS.accent },
  queue: { label: 'Queues / Brokers', icon: 'pipelineApp', accent: COLORS.warning },
  object_store: { label: 'Object stores', icon: 'storage', accent: COLORS.success },
  file: { label: 'Files', icon: 'document', accent: COLORS.subdued },
};

export function categoryMeta(category?: string): { label: string; icon: string; accent: string } {
  return (
    CATEGORY_META[category || ''] || {
      label: category || 'Other',
      icon: 'package',
      accent: COLORS.subdued,
    }
  );
}
