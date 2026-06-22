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
  success: '#00a38c',
  warning: '#e9a200',
  danger: '#c4341c',
  accent: DEFAULT_ACCENT2,
  /** Secondary accent (alias of `accent`, kept for explicit two-accent reads). */
  accent2: DEFAULT_ACCENT2,
  subdued: '#69707d',
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
 * Typography scale — replaces scattered `fontSize:` literals so every surface
 * uses one consistent set of display sizes. Values are plain CSS strings to drop
 * straight into inline `style` (e.g. `style={{ fontSize: TYPE.kpi }}`).
 */
export const TYPE = {
  /** Marketing/landing hero. */
  hero: '34px',
  /** Page title. */
  h1: '24px',
  /** Section / card title. */
  h2: '18px',
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
  '#1c66e0', '#8a55c9', '#00a38c', '#e9a200',
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
