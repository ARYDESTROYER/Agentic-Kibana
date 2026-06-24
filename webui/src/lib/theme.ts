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
export const DEFAULT_ACCENT = '#006BB4';
export const DEFAULT_ACCENT2 = '#7B61FF';

/* ═══════════════════════════════════════════════════════════════════════════
   TOKEN SYSTEM — light / dark theme
   ═══════════════════════════════════════════════════════════════════════════ */

export interface ThemeTokens {
  bgPage: string;
  bgCard: string;
  bgSidebar: string;
  bgHeader: string;
  bgHover: string;
  bgActive: string;
  bgBadge: string;
  bgTableHover: string;
  borderDefault: string;
  borderSubtle: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  textLink: string;
  navIcon: string;
  navText: string;
  navActiveBg: string;
  navActiveText: string;
  navActiveIcon: string;
  navGroupLabel: string;
}

const LIGHT_TOKENS: ThemeTokens = {
  bgPage: '#F8FAFD',
  bgCard: '#FFFFFF',
  bgSidebar: '#FAFBFC',
  bgHeader: '#FFFFFF',
  bgHover: '#F0F4F8',
  bgActive: '#E0ECFA',
  bgBadge: '#F0F4F7',
  bgTableHover: '#F5F7FA',
  borderDefault: '#E8ECF1',
  borderSubtle: '#F0F4F7',
  borderStrong: '#D3DAE6',
  textPrimary: '#1A1C21',
  textSecondary: '#69707D',
  textMuted: '#98A2B3',
  textInverse: '#FFFFFF',
  textLink: '#006BB4',
  navIcon: '#98A2B3',
  navText: '#343741',
  navActiveBg: '#E0ECFA',
  navActiveText: '#006BB4',
  navActiveIcon: '#006BB4',
  navGroupLabel: '#98A2B3',
};

const DARK_TOKENS: ThemeTokens = {
  bgPage: '#0F1117',
  bgCard: '#151A23',
  bgSidebar: '#111827',
  bgHeader: '#151A23',
  bgHover: '#1E293B',
  bgActive: 'rgba(59, 130, 246, 0.15)',
  bgBadge: '#1E293B',
  bgTableHover: '#202938',
  borderDefault: '#2A3342',
  borderSubtle: '#1E293B',
  borderStrong: '#374151',
  textPrimary: '#F3F4F6',
  textSecondary: '#9CA3AF',
  textMuted: '#6B7280',
  textInverse: '#111827',
  textLink: '#60A5FA',
  navIcon: '#6B7280',
  navText: '#D1D5DB',
  navActiveBg: 'rgba(59, 130, 246, 0.15)',
  navActiveText: '#60A5FA',
  navActiveIcon: '#60A5FA',
  navGroupLabel: '#6B7280',
};

/** Get tokens for the current theme. */
export function getTokens(): ThemeTokens {
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark') {
    return DARK_TOKENS;
  }
  return LIGHT_TOKENS;
}

/** Set the theme on <html> and update COLORS to match. */
export function setTheme(theme: 'light' | 'dark'): void {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', theme);
  }
  const tokens = theme === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
  // Update COLORS to match the active theme for inline styles
  COLORS.textDark = tokens.textPrimary;
  COLORS.textMuted = tokens.textMuted;
  COLORS.subdued = tokens.textSecondary;
  COLORS.border = tokens.borderDefault;
  COLORS.surface = tokens.bgPage;
  COLORS.sidebarBg = tokens.bgSidebar;
  COLORS.navActive = tokens.navActiveBg;
}

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
  success: '#00BFB3',
  warning: '#F5A623',
  danger: '#BD271E',
  accent: DEFAULT_ACCENT2,
  /** Secondary accent (alias of `accent`, kept for explicit two-accent reads). */
  accent2: DEFAULT_ACCENT2,
  subdued: '#69707d',
  surface: '#f8fafd',
  /** Background for sidebar nav */
  sidebarBg: '#f5f7fa',
  /** Card border colour */
  border: '#D3DAE6',
  /** Dark text colour */
  textDark: '#1A1C21',
  /** Muted text colour */
  textMuted: '#98A2B3',
  /** Active nav background */
  navActive: '#E7F0F8',

  /* ── Semantic aliases ────────────────────────────────────────────────────
   * Every colour token has a semantic name so call-sites read like English:
   *   accent={COLORS.semantic.threat}  instead of  accent={COLORS.danger}
   *
   * Meaning          Hex       Use
   * ──────────────── ───────── ──────────────────────────────────────────
   * operational      #006BB4   Open cases, documents, general operational UI
   * safe             #00BFB3   Sources, success, "false positive"
   * needsReview      #F5A623   Needs-human, pending, review-required
   * threat           #BD271E   True positives, threats, critical alerts
   * ai               #7B61FF   LLM spend, RAG chunks, memory — anything AI/ML
   */
  semantic: {
    operational: '#006BB4',
    safe: '#00BFB3',
    needsReview: '#F5A623',
    threat: '#BD271E',
    ai: '#7B61FF',
  },
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
    root.setProperty('--soc-bubble2', p === DEFAULT_ACCENT ? '#006BB4' : s);
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
  '#006BB4', '#7B61FF', '#00BFB3', '#F5A623',
  '#BD271E', '#2aa0a4', '#d6336c', '#7048e8',
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
