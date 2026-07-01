#!/usr/bin/env node
/**
 * Round-5 W0-E E4 — GATE 1: token-existence checker.
 *
 * Every `ALLOWED_TOKENS` name (theme-tokens.ts) AND every `palette.ts token()` name MUST
 * exist in `styles/theme.css` in BOTH `:root` (light) and `.dark` (dark) — except the
 * mode-agnostic layout/type tokens (radius/density/font-display/…), which are declared
 * once in `:root` by design and are only required there.
 *
 * This closes the four-file drift the map flags (DESIGN_STANDARD §12.1 / §1.0): if a
 * consumer (branding allow-list or a recharts `token()` call) references a name that
 * theme.css does not define in a theme, that theme silently yields a transparent SVG /
 * an unstyled control. The gate fails the build the moment such a name appears.
 *
 * Usage:  node scripts/gate-tokens.mjs   (exit 0 = pass, 1 = fail)
 * Library: `checkTokenExistence()` returns { ok, problems[] } for the Vitest wiring.
 */
import { parseThemeCss } from './lib/theme-css.mjs';
import { requiredTokenNames, MODE_AGNOSTIC_TOKENS } from './lib/tokens.mjs';

/**
 * @returns {{ ok: boolean, problems: {token: string, source: string, missing: string[]}[],
 *             checked: number }}
 */
export function checkTokenExistence() {
  const { light, dark } = parseThemeCss();
  const { allowed, palette, all } = requiredTokenNames();
  const sourceOf = (t) => {
    const inA = allowed.includes(t);
    const inP = palette.includes(t);
    return inA && inP ? 'ALLOWED_TOKENS + palette.token()' : inA ? 'ALLOWED_TOKENS' : 'palette.token()';
  };
  const problems = [];
  for (const t of all) {
    const missing = [];
    if (!light.has(t)) missing.push(':root');
    if (!MODE_AGNOSTIC_TOKENS.has(t) && !dark.has(t)) missing.push('.dark');
    if (missing.length) problems.push({ token: t, source: sourceOf(t), missing });
  }
  return { ok: problems.length === 0, problems, checked: all.length };
}

function main() {
  const { ok, problems, checked } = checkTokenExistence();
  if (ok) {
    console.log(`✓ token-existence: all ${checked} required tokens exist in theme.css (both themes).`);
    process.exit(0);
  }
  console.error(`✗ token-existence: ${problems.length} token(s) missing from theme.css:`);
  for (const p of problems) {
    console.error(`   ${p.token}  (from ${p.source})  missing in: ${p.missing.join(', ')}`);
  }
  console.error('\nEvery ALLOWED_TOKENS + palette token() name must be declared in :root and');
  console.error('.dark (mode-agnostic radius/density/font tokens are :root-only by design).');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
