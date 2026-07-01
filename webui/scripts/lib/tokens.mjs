/**
 * Round-5 W0-E E4 — extract the set of token NAMES the token-existence gate checks:
 *   (a) every entry of `ALLOWED_TOKENS` (theme-tokens.ts) — the branding allow-list, and
 *   (b) every `token('x')` name referenced in palette.ts — the recharts color source.
 *
 * Why parse source instead of importing: these are `.ts` files, and the gate scripts run
 * under plain node (no TS transform). Parsing the exported `ALLOWED_TOKENS = new Set([…])`
 * literal + the `token('…')` calls is robust and dep-free. The Vitest wiring imports the
 * SAME helper so both paths check the identical name set.
 *
 * Mode-agnostic tokens: a few design tokens are DELIBERATELY declared once, in `:root`
 * only (DESIGN_STANDARD §3.3 "declare radius/density/font-display ONCE in :root" — they
 * are layout/typography, not per-theme color). The existence gate requires those in
 * `:root` and does NOT require them in `.dark`; every other required token must exist in
 * BOTH themes (a color/surface token defined in only one theme is the silent
 * transparent-SVG drift the gate exists to catch — DESIGN_STANDARD §12.1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { WEBUI_ROOT } from './theme-css.mjs';

const THEME_TOKENS_PATH = path.join(WEBUI_ROOT, 'src', 'soc', 'theme-tokens.ts');
const PALETTE_PATH = path.join(WEBUI_ROOT, 'src', 'soc', 'components', 'palette.ts');

/**
 * Tokens declared ONCE in `:root` on purpose (mode-agnostic layout/typography). The
 * existence gate exempts these from the `.dark` requirement. Keep in sync with the
 * "declared ONCE in :root" set in theme.css (radius scale, density unit, display font).
 */
export const MODE_AGNOSTIC_TOKENS = new Set([
  '--radius',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--density-unit',
  '--font-display',
  // Decorative secondary brand accent (login-hero aurora): W0-A gives it a single
  // real :root default (DESIGN_STANDARD §11) and tailwind resolves it via
  // `var(--accent2, var(--primary))`, so it is intentionally :root-only.
  '--accent2',
  // layout + motion tokens (declared once in :root)
  '--header-h',
  '--motion-fast',
  '--motion-base',
  '--motion-slow',
  '--motion-ease-standard',
]);

/** Extract the string entries of the `ALLOWED_TOKENS = new Set([ … ])` literal. */
export function extractAllowedTokens(src) {
  const text = src ?? fs.readFileSync(THEME_TOKENS_PATH, 'utf8');
  const anchor = 'ALLOWED_TOKENS';
  const start = text.indexOf(anchor);
  if (start < 0) throw new Error('ALLOWED_TOKENS not found in theme-tokens.ts');
  const setOpen = text.indexOf('new Set([', start);
  if (setOpen < 0) throw new Error('ALLOWED_TOKENS set literal not found');
  const arrOpen = text.indexOf('[', setOpen);
  // Find the matching ] for this array.
  let depth = 0;
  let i = arrOpen;
  for (; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = text.slice(arrOpen + 1, i);
  // Strip line comments so a commented example token is not counted.
  const clean = body.replace(/\/\/[^\n]*/g, '');
  const names = [...clean.matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]);
  return [...new Set(names)];
}

/** Extract every distinct `token('name')` reference from palette.ts (→ `--name`). */
export function extractPaletteTokens(src) {
  const text = src ?? fs.readFileSync(PALETTE_PATH, 'utf8');
  const names = [...text.matchAll(/token\(\s*'([a-z0-9-]+)'/g)].map((m) => '--' + m[1]);
  return [...new Set(names)];
}

/**
 * The full set of token names the existence gate must find in theme.css.
 * @returns {{ allowed: string[], palette: string[], all: string[] }}
 */
export function requiredTokenNames() {
  const allowed = extractAllowedTokens();
  const palette = extractPaletteTokens();
  const all = [...new Set([...allowed, ...palette])].sort();
  return { allowed, palette, all };
}
