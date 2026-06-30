/**
 * branding.api — co-located data + contrast helpers for the BrandingEditor.
 *
 * The shared `webui/src/lib/types.ts` `Branding` interface only models the legacy
 * white-label fields; the Round-3 backend `BrandingConfig` additionally carries
 * `material` / `default_theme` / `theme_tokens` / `presets`, and `PUT /api/branding`
 * MAY return server-side WCAG advisories (`contrast_warnings` / `auto_corrected`).
 *
 * To avoid contending on the shared types file (parallel-safety), we model those
 * additive fields HERE as a structural superset and read/write branding through the
 * low-level `api.get`/`api.put` verbs (the backend forwards arbitrary JSON bodies, so
 * the additive fields round-trip verbatim).
 *
 * SECURITY (#9/#10): every value here is operator-entered appearance data. Theme
 * tokens are bounded (allow-listed + sanitised) by `theme-tokens.ts` before they ever
 * reach the DOM; this module only carries the plain values + computes a local,
 * defensive WCAG contrast advisory so the warning is meaningful even if the backend
 * does not compute one.
 */
import { api } from '@/lib/api';
import type { Branding } from '@/lib/types';
import type { Material, ThemeMode, ThemePreset } from '@/soc/theme-tokens';

/** The Round-3 superset of the wire branding doc (additive fields, all optional). */
export interface BrandingDoc extends Branding {
  /** Shell density/contrast surface pack. */
  material?: Material | string;
  /** Org default colour mode (supersedes the legacy `theme`/`dark_mode_default`). */
  default_theme?: ThemeMode | string;
  /** Bounded design-token override map (css-var → value). */
  theme_tokens?: Record<string, string>;
  /** Operator-curated preset list (plain data). */
  presets?: ThemePreset[];
}

/**
 * The PUT response: the saved branding doc, optionally annotated by the backend with
 * WCAG advisories. Both advisory fields are optional + tolerant of either an array
 * (warning strings) or a structured map, so a backend that does not yet compute them
 * simply omits them (the editor falls back to its own client-side check).
 */
export interface BrandingPutResult extends BrandingDoc {
  /** Server-reported WCAG-AA contrast warnings (plain text), if any. */
  contrast_warnings?: string[];
  /** Tokens/colours the backend auto-corrected to stay AA (css-var → value), if any. */
  auto_corrected?: Record<string, string>;
}

/** GET the full (Round-3) branding doc. */
export function getBrandingDoc(): Promise<BrandingDoc> {
  return api.get<BrandingDoc>('branding');
}

/** PUT the branding doc; returns the saved doc plus any WCAG advisories. */
export function putBrandingDoc(body: BrandingDoc): Promise<BrandingPutResult> {
  return api.put<BrandingPutResult>('branding', body);
}

/* ------------------------------------------------------------------ WCAG ---- */

/** Parse `#rgb`/`#rrggbb` → [r,g,b] 0-255, or null. */
function parseHex(hex: string): [number, number, number] | null {
  let h = (hex || '').trim();
  if (!h.startsWith('#')) return null;
  h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Relative luminance per WCAG 2.x (sRGB → linear). */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1..21) between two hex colours; null if either is invalid. */
export function contrastRatio(fgHex: string, bgHex: string): number | null {
  const fg = parseHex(fgHex);
  const bg = parseHex(bgHex);
  if (!fg || !bg) return null;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * A local WCAG-AA advisory for the PRIMARY accent. The accent fill carries white
 * (`--primary-foreground`) text across buttons/badges; AA "large/UI" text wants ≥ 3:1
 * and normal text ≥ 4.5:1. We surface a warning below 4.5:1 (and a stronger one below
 * 3:1). Returns null when the accent is blank (built-in accent is already AA-vetted)
 * or unpar-seable. Plain-text message; the caller renders it as text.
 */
export function accentContrastAdvisory(accentHex: string): { ratio: number; message: string; severe: boolean } | null {
  const hex = (accentHex || '').trim();
  if (!hex) return null;
  const ratio = contrastRatio('#ffffff', hex);
  if (ratio == null) return null;
  if (ratio >= 4.5) return null;
  const rounded = Math.round(ratio * 100) / 100;
  if (ratio < 3) {
    return {
      ratio: rounded,
      severe: true,
      message: `White text on this accent has a contrast ratio of ${rounded}:1 — below the WCAG-AA minimum of 3:1 for UI/large text. Choose a darker accent.`,
    };
  }
  return {
    ratio: rounded,
    severe: false,
    message: `White text on this accent has a contrast ratio of ${rounded}:1 — it meets AA for large/UI text (3:1) but is below the 4.5:1 needed for small text. A darker accent improves legibility.`,
  };
}
