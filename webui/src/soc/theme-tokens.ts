/**
 * Theme-token resolver + branding application (Round 3, design-system layer).
 *
 * This is the ONE place that decides the effective colour mode and that writes
 * runtime CSS custom properties. It is a pure module (no React) so it can be unit
 * tested and reused by both the React ThemeProvider and any non-React caller.
 *
 * NON-NEGOTIABLE #10 / #3 (branding) + #9 (untrusted appearance inputs):
 *   - `applyTokens()` writes ONLY allow-listed `--*` custom properties (see
 *     ALLOWED_TOKENS). An operator/branding payload can NEVER set an arbitrary CSS
 *     property, inject a selector, or smuggle a `url(...)`/`expression(...)` —
 *     every value is sanitised by `sanitizeTokenValue()` before it touches the DOM.
 *   - Nothing here uses dangerouslySetInnerHTML or innerHTML; values are assigned
 *     via `element.style.setProperty(name, value)` which the browser treats as a
 *     single declaration value (no selector/at-rule escape possible).
 *   - `--font-display` is the one font hook; its value is allow-listed to a small
 *     enum of vetted families, never an arbitrary string.
 */

/* ------------------------------------------------------------------------- */
/* Types — a structural view of the backend BrandingConfig round-3 fields.    */
/* These mirror, but do not import from, webui/src/lib/types.ts (kept local so */
/* the design-system layer does not contend on the shared types file).        */
/* ------------------------------------------------------------------------- */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Material = 'quiet' | 'command';

/** A named theme preset the operator can offer (plain data; bounded). */
export interface ThemePreset {
  name?: string;
  material?: Material | string;
  default_theme?: ThemeMode | string;
  theme_tokens?: Record<string, string>;
  /** Optional accent preset key (see ACCENT_PRESETS). */
  accent?: string;
  [key: string]: unknown;
}

/**
 * The subset of the backend `BrandingConfig` (config.py) this resolver consumes.
 * Every field is optional + defaulted so a legacy/empty branding doc resolves to
 * the byte-for-byte pre-wave look (`material: 'quiet'`, no token overrides).
 */
export interface BrandingLike {
  accent_color?: string;
  accent_color2?: string;
  /** Legacy mode field (kept working). */
  theme?: ThemeMode | string;
  /** Round-3 org default colour mode (supersedes `theme`/`dark_mode_default`). */
  default_theme?: ThemeMode | string;
  dark_mode_default?: boolean;
  /** Shell density/contrast surface pack. */
  material?: Material | string;
  /** Bounded design-token override map (css-var → value). */
  theme_tokens?: Record<string, string>;
  /** Operator-curated preset list. */
  presets?: ThemePreset[];
}

/* ------------------------------------------------------------------------- */
/* Allow-list — the ONLY custom properties applyTokens()/applyBranding() write. */
/* ------------------------------------------------------------------------- */

/**
 * The exhaustive set of writable CSS custom properties. Anything not in this set
 * is dropped silently (#10). Mirrors the tokens declared in styles/theme.css.
 */
export const ALLOWED_TOKENS: ReadonlySet<string> = new Set([
  // Core brand + ring
  '--primary',
  '--ring',
  '--accent2',
  // Semantic SOC scale (operator may re-key severity hues within reason)
  '--critical',
  '--high',
  '--medium',
  '--low',
  '--info',
  '--success',
  '--warning',
  // Canvas / surface tints (backdrop nudges)
  '--canvas-tint',
  '--surface-tint',
  // Radius + density scale
  '--radius',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--density-unit',
  // Display font hook (value further restricted to FONT_ALLOWLIST)
  '--font-display',
  // Material-pack chrome
  '--glass-tint',
  '--glass-opacity',
  '--glow-strength',
  '--grid-opacity',
]);

/** Allow-listed display font families (vetted for AA legibility + availability). */
const FONT_ALLOWLIST: Record<string, string> = {
  inter: "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', SFMono-Regular, Consolas, Menlo, monospace",
  grotesk: "'Space Grotesk', Inter, ui-sans-serif, system-ui, sans-serif",
};

/**
 * Sanitise a single token VALUE before it is written. Rejects anything that could
 * escape a single CSS declaration value: braces, semicolons, `url(`, `expression(`,
 * `@`, comment markers, angle brackets, backslashes, or excessive length. Returns
 * null when the value is unsafe (the caller then skips the token). `--font-display`
 * is special-cased to the FONT_ALLOWLIST. Bare HSL triples / hex / rem numbers all
 * pass. This is defence-in-depth on top of `setProperty` (which already cannot
 * break out of a declaration).
 */
export function sanitizeTokenValue(name: string, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 200) return null;
  // Disallow characters/sequences that could end a declaration or inject CSS.
  if (/[{}<>\\;@]/.test(v)) return null;
  if (/url\s*\(/i.test(v)) return null;
  if (/expression\s*\(/i.test(v)) return null;
  if (v.includes('/*') || v.includes('*/')) return null;
  // The font hook is restricted to the vetted enum (key OR a known full stack).
  if (name === '--font-display') {
    const key = v.toLowerCase();
    if (FONT_ALLOWLIST[key]) return FONT_ALLOWLIST[key];
    // Allow an exact match against a known stack (idempotent re-apply), else drop.
    const known = Object.values(FONT_ALLOWLIST).some((s) => s === v);
    return known ? v : null;
  }
  return v;
}

/**
 * Apply a bag of design tokens to a target element's inline style, writing ONLY
 * allow-listed + sanitised properties. Unknown keys and unsafe values are skipped.
 * Returns the list of property names actually written (handy for tests/clearing).
 *
 * @param tokens   css-var → value map (keys may omit/include the leading `--`).
 * @param target   defaults to <html> (document.documentElement).
 */
export function applyTokens(
  tokens: Record<string, string> | null | undefined,
  target?: HTMLElement | null,
): string[] {
  const root = target ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!root || !tokens) return [];
  const written: string[] = [];
  for (const [rawKey, rawVal] of Object.entries(tokens)) {
    const name = rawKey.startsWith('--') ? rawKey : `--${rawKey}`;
    if (!ALLOWED_TOKENS.has(name)) continue;
    const safe = sanitizeTokenValue(name, rawVal);
    if (safe == null) continue;
    root.style.setProperty(name, safe);
    written.push(name);
  }
  return written;
}

/** Remove a set of token properties (e.g. when branding clears them). */
export function clearTokens(names: Iterable<string>, target?: HTMLElement | null): void {
  const root = target ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!root) return;
  for (const name of names) {
    const n = name.startsWith('--') ? name : `--${name}`;
    if (ALLOWED_TOKENS.has(n)) root.style.removeProperty(n);
  }
}

/* ------------------------------------------------------------------------- */
/* Material packs — chrome var deltas. 'quiet' === the pre-wave defaults.      */
/* ------------------------------------------------------------------------- */

/**
 * Material-pack token deltas. The 'quiet' pack is the IDENTITY (its values equal
 * the theme.css defaults), so selecting it renders byte-for-byte like today. The
 * 'command' pack raises the glass/glow/grid chrome vars for a denser command feel
 * WITHOUT touching the colour system (text colours/contrast unchanged).
 */
export const MATERIAL_PACKS: Record<Material, Record<string, string>> = {
  quiet: {
    '--glass-opacity': '0.82',
    '--glow-strength': '0',
    '--grid-opacity': '0',
  },
  command: {
    // Slightly more translucent chrome + a faint glow + a whisper grid overlay.
    '--glass-opacity': '0.64',
    '--glow-strength': '0.45',
    '--grid-opacity': '0.05',
  },
};

/** Resolve a material string to a known pack (defaults to 'quiet'). */
export function resolveMaterial(material?: string | null): Material {
  return material === 'command' ? 'command' : 'quiet';
}

/** Apply a material pack's chrome tokens (allow-listed via applyTokens). */
export function applyMaterial(material: Material, target?: HTMLElement | null): void {
  applyTokens(MATERIAL_PACKS[material], target);
}

/* ------------------------------------------------------------------------- */
/* Accent presets — AA-vetted brand hues (exported for the branding editor).  */
/* ------------------------------------------------------------------------- */

export interface AccentPreset {
  /** Stable key. */
  key: string;
  /** Human label (plain text). */
  label: string;
  /** Primary accent as a `#rrggbb` hex (drives --primary/--ring). */
  hex: string;
  /** Optional secondary accent (drives --accent2 / hero aurora). */
  hex2?: string;
}

/**
 * Named accent presets — each vetted to keep `--primary-foreground` (white) text
 * at WCAG-AA contrast on the accent fill in BOTH themes. Exported so the branding
 * editor can offer them as one-click choices.
 */
export const ACCENT_PRESETS: AccentPreset[] = [
  { key: 'azure', label: 'Azure', hex: '#1f6feb', hex2: '#6366f1' },
  { key: 'indigo', label: 'Indigo', hex: '#4f46e5', hex2: '#7c3aed' },
  { key: 'teal', label: 'Teal', hex: '#0d9488', hex2: '#0ea5e9' },
  { key: 'violet', label: 'Violet', hex: '#7c3aed', hex2: '#db2777' },
  { key: 'emerald', label: 'Emerald', hex: '#047857', hex2: '#0d9488' },
  { key: 'crimson', label: 'Crimson', hex: '#be123c', hex2: '#ea580c' },
];

/** Look up an accent preset by key (case-insensitive). */
export function accentPreset(key?: string | null): AccentPreset | undefined {
  if (!key) return undefined;
  const k = key.trim().toLowerCase();
  return ACCENT_PRESETS.find((p) => p.key === k);
}

/* ------------------------------------------------------------------------- */
/* hex → HSL triplet (mirrors theme.tsx's converter; kept here so this module  */
/* is self-contained + testable).                                             */
/* ------------------------------------------------------------------------- */

/** Convert `#rrggbb`/`#rgb` to the `"H S% L%"` triple the tokens expect, or null. */
export function hexToHslTriplet(hex: string): string | null {
  let h = (hex || '').trim();
  if (!h.startsWith('#')) return null;
  h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hue = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        hue = (b - r) / d + 2;
        break;
      default:
        hue = (r - g) / d + 4;
        break;
    }
    hue /= 6;
  }
  return `${Math.round(hue * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/* ------------------------------------------------------------------------- */
/* The ONE colour-mode resolver — explicit precedence.                        */
/* ------------------------------------------------------------------------- */

/** True when the OS currently prefers dark (safe in SSR/jsdom). */
export function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Resolve the effective dark flag with EXPLICIT precedence:
 *   1. the user's explicit choice (`'light'`/`'dark'`) — always wins;
 *   2. when the user is on `'system'` (or unset), the org branding default
 *      (`effectiveBrandingTheme(branding)`), if it is `'light'`/`'dark'`;
 *   3. otherwise `prefers-color-scheme`.
 *
 * This keeps the no-branding behaviour identical to before (user pref or OS), and
 * only lets branding act as the default for users who have NOT chosen.
 */
export function resolveDark(
  userMode: ThemeMode | undefined,
  branding?: BrandingLike | null,
): boolean {
  if (userMode === 'dark') return true;
  if (userMode === 'light') return false;
  // userMode is 'system' or undefined → consult branding default, then the OS.
  const orgDefault = branding ? effectiveBrandingTheme(branding) : '';
  if (orgDefault === 'dark') return true;
  if (orgDefault === 'light') return false;
  return prefersDark();
}

/**
 * The org's default colour mode, reconciling the new + legacy branding fields —
 * mirrors the backend `BrandingConfig.effective_theme()`:
 *   - legacy `dark_mode_default: true` forces dark;
 *   - else prefer the explicit `default_theme`, else the legacy `theme`.
 * Returns `'light' | 'dark' | 'system' | ''` ('' = unset / no opinion).
 */
export function effectiveBrandingTheme(branding: BrandingLike): ThemeMode | '' {
  if (branding.dark_mode_default) return 'dark';
  const dt = (branding.default_theme || '') as string;
  if (dt === 'dark' || dt === 'light' || dt === 'system') return dt;
  const legacy = (branding.theme || '') as string;
  if (legacy === 'dark' || legacy === 'light' || legacy === 'system') return legacy;
  return '';
}

/* ------------------------------------------------------------------------- */
/* applyBranding — the full appearance application (accent + material + tokens). */
/* ------------------------------------------------------------------------- */

/** The token names applyBranding may set, so it can clear them cleanly first. */
const BRANDING_MANAGED_TOKENS = [
  '--primary',
  '--ring',
  '--accent2',
  '--glass-opacity',
  '--glow-strength',
  '--grid-opacity',
] as const;

/**
 * Apply ALL branding-driven appearance to <html> (or `target`), idempotently:
 *   1. accent — `accent_color` → `--primary`/`--ring`; `accent_color2` → `--accent2`;
 *   2. material pack — `material` ('quiet'|'command') → chrome vars;
 *   3. bounded token overrides — `theme_tokens` (allow-listed + sanitised).
 *
 * Order matters: theme_tokens are applied LAST so an explicit operator token wins
 * over the accent/material defaults. Everything routes through `applyTokens()`, so
 * only allow-listed, sanitised properties are ever written (#10/#9). Passing an
 * empty/legacy branding clears overrides → the byte-for-byte quiet default.
 *
 * Returns the resolved material (the shell uses it to toggle the grid overlay).
 */
export function applyBranding(
  branding: BrandingLike | null | undefined,
  target?: HTMLElement | null,
): Material {
  const root = target ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const material = resolveMaterial(branding?.material);
  if (!root) return material;

  // Start from a clean slate for the managed set so toggling OFF a value restores
  // the stylesheet default (rather than leaving a stale inline override).
  for (const name of BRANDING_MANAGED_TOKENS) root.style.removeProperty(name);

  // 1. Accent.
  const accentTriplet = branding?.accent_color ? hexToHslTriplet(branding.accent_color) : null;
  if (accentTriplet) {
    applyTokens({ '--primary': accentTriplet, '--ring': accentTriplet }, root);
  }
  const accent2Triplet = branding?.accent_color2 ? hexToHslTriplet(branding.accent_color2) : null;
  if (accent2Triplet) {
    applyTokens({ '--accent2': accent2Triplet }, root);
  }

  // 2. Material pack chrome.
  applyMaterial(material, root);

  // 3. Operator token overrides (last → highest precedence).
  if (branding?.theme_tokens) applyTokens(branding.theme_tokens, root);

  return material;
}
