/**
 * Round-5 W0-E E4 — shared theme.css parser + WCAG helpers for the CI design gates.
 *
 * This module is the ONE place that reads `styles/theme.css` and turns its two token
 * blocks (`:root` = light, `.dark` = dark) into resolved HSL maps. Every design gate
 * (token-existence, contrast, CVD) consumes it, and the Vitest wiring imports the SAME
 * functions so the gates run identically in CI and on the CLI.
 *
 * It is dependency-free ESM (`.mjs`) so it runs both under plain `node scripts/*.mjs`
 * and inside Vitest (which transpiles/imports `.mjs` natively). It intentionally does
 * NOT import the app (no React / no TS) — it only reads source files as text.
 *
 * Contract:
 *   - `parseThemeCss()` → { light, dark, rawLight, rawDark } token maps (name → value).
 *   - `resolveToken(name, map)` follows `var(--x)` aliases to a concrete `"H S% L%"`
 *     triple (or an rgb()/hex/number literal) so a gate can measure the EFFECTIVE color.
 *   - `hslTripleToRgb` / `relLuminance` / `contrastRatio` mirror the WCAG 2.x math used
 *     by `theme-tokens.ts` (kept self-contained — a gate must never import app code).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path to the webui root (scripts/lib/ → ../../). */
export const WEBUI_ROOT = path.resolve(__dirname, '..', '..');
export const THEME_CSS_PATH = path.join(WEBUI_ROOT, 'src', 'styles', 'theme.css');

/**
 * Extract the body (text between the outermost `{ … }`) of the FIRST top-level rule
 * whose selector list contains `selector` (matched as a whole token). Brace-balanced,
 * so nested `hsl(var(--x) / 0.5)` etc. never confuse it.
 */
function ruleBody(css, selector) {
  // Find "<selector> {" where selector is a standalone selector in the list.
  const re = new RegExp(`(^|[},])\\s*${escapeRe(selector)}\\s*\\{`, 'm');
  const m = re.exec(css);
  if (!m) return '';
  const open = css.indexOf('{', m.index);
  let depth = 0;
  let i = open;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(open + 1, i);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip `/* … *\/` comments so a commented-out declaration is never counted. */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Parse a CSS block body into an ordered map of `--token` → raw value (last wins,
 * mirroring the cascade). Comments removed first. Values are trimmed; a trailing `;`
 * and any inline comment are already gone.
 */
function parseDeclarations(body) {
  const map = new Map();
  const clean = stripComments(body);
  const re = /(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi;
  let m;
  while ((m = re.exec(clean))) {
    map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

/**
 * Read + parse theme.css into light (`:root`) and dark (`.dark`) token maps.
 * @param {string} [cssText] optional override (tests may pass synthetic CSS).
 */
export function parseThemeCss(cssText) {
  const css = cssText ?? fs.readFileSync(THEME_CSS_PATH, 'utf8');
  const rootBody = ruleBody(css, ':root');
  const darkBody = ruleBody(css, '.dark');
  const light = parseDeclarations(rootBody);
  const dark = parseDeclarations(darkBody);
  return { light, dark, rawLight: rootBody, rawDark: darkBody };
}

/**
 * Resolve a token to a concrete value, following `var(--x)` aliases within the SAME
 * theme map. Handles the common shapes in theme.css:
 *   - a bare HSL triple: `220 12% 40%`  → returned as-is
 *   - an alias: `var(--slate-1)`         → follows to the aliased token
 *   - a `var(--x, fallback)`             → follows --x, else uses the fallback
 *   - a literal rgb()/#hex/number        → returned as-is
 * Returns `null` when the chain dead-ends (missing token / cyclic).
 */
export function resolveToken(name, map, _seen) {
  const seen = _seen ?? new Set();
  const key = name.startsWith('--') ? name : `--${name}`;
  if (seen.has(key)) return null; // cycle guard
  seen.add(key);
  const raw = map.get(key);
  if (raw == null) return null;
  const v = raw.trim();
  const varMatch = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/i.exec(v);
  if (varMatch) {
    const inner = resolveToken(varMatch[1], map, seen);
    if (inner != null) return inner;
    return varMatch[2] ? varMatch[2].trim() : null;
  }
  return v;
}

/** Parse an `"H S% L%"` triple → {h,s,l} with s/l in 0..1, or null. */
export function parseHslTriple(triple) {
  if (typeof triple !== 'string') return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s*$/.exec(triple);
  if (!m) return null;
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  if ([h, s, l].some(Number.isNaN)) return null;
  return { h, s: clamp01(s), l: clamp01(l) };
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** HSL (h 0..360, s/l 0..1) → [r,g,b] each 0..1. */
export function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = ((((h % 360) + 360) % 360) / 360);
  const t2c = (t) => {
    let tc = t;
    if (tc < 0) tc += 1;
    if (tc > 1) tc -= 1;
    if (tc < 1 / 6) return p + (q - p) * 6 * tc;
    if (tc < 1 / 2) return q;
    if (tc < 2 / 3) return p + (q - p) * (2 / 3 - tc) * 6;
    return p;
  };
  return [t2c(hk + 1 / 3), t2c(hk), t2c(hk - 1 / 3)];
}

/** Convert an `"H S% L%"` triple to [r,g,b] in 0..1, or null. */
export function hslTripleToRgb(triple) {
  const hsl = parseHslTriple(triple);
  if (!hsl) return null;
  return hslToRgb(hsl.h, hsl.s, hsl.l);
}

/** Convert `#rgb`/`#rrggbb` to [r,g,b] in 0..1, or null. */
export function hexToRgb(hex) {
  let h = (hex || '').trim();
  if (!h.startsWith('#')) return null;
  h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** WCAG relative luminance for [r,g,b] each 0..1 (sRGB → linear). */
export function relLuminance([r, g, b]) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1..21) between two [r,g,b] colors. */
export function contrastRatio(rgbA, rgbB) {
  const la = relLuminance(rgbA);
  const lb = relLuminance(rgbB);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Resolve a token to [r,g,b] (0..1), accepting the value shapes theme.css uses
 * (HSL triple, #hex, rgb()). Returns null when it is not a measurable solid color
 * (e.g. a composed shadow, a number, a font stack).
 */
export function resolveTokenRgb(name, map) {
  const v = resolveToken(name, map);
  if (v == null) return null;
  const hsl = hslTripleToRgb(v);
  if (hsl) return hsl;
  const hex = hexToRgb(v);
  if (hex) return hex;
  const rgbM = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(v);
  if (rgbM) return [Number(rgbM[1]) / 255, Number(rgbM[2]) / 255, Number(rgbM[3]) / 255];
  return null;
}
