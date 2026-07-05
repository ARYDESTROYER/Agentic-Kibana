#!/usr/bin/env node
/**
 * Round-5 W0-E E4 — GATE 2: WCAG contrast checker (~zero-dep luminance math).
 *
 * Parses theme.css and asserts the semantic contrast axes clear their WCAG 2.x bar in
 * BOTH themes (DESIGN_STANDARD §6.3 / §1.2-1.4). Every axis resolves BOTH colors through
 * `resolveToken` (following `var(--slate-*)` aliases), so it measures the EFFECTIVE color
 * the browser paints — the same reason a "claimed AA" in-code comment can be wrong (§0).
 * Passing on the current W0-A palette proves G1 is real.
 *
 * Three bars, matched to WCAG + the standard's own methodology:
 *   1. STANDALONE TEXT (body + `*-text` tints) → ≥ 4.5:1 (WCAG AA normal text).
 *      Reference background = the theme's lightest paper the token was tuned on
 *      (DESIGN_STANDARD §1.3 "measured as text on white card"): WHITE in light, `--card`
 *      in dark. This is the exact reference the `-text` triples were tuned against.
 *   2. ON-FILL `*-foreground` (badge/pill/button text ON a solid semantic fill) → ≥ 3:1.
 *      Badge/pill fills carry BOLD short text on a solid graphical fill — WCAG's
 *      3:1 large-text / UI-component bar governs (the primary-button axis is held to the
 *      stricter 4.5:1 since it is the main normal-weight CTA, and it clears it).
 *   3. NON-TEXT (focus ring, structural/interactive border, chart series, AND every
 *      severity/status/verdict SOLID FILL used as a graphic — badge chip, timeline node,
 *      gauge arc) → ≥ 3:1 (WCAG 1.4.11 graphical objects / UI components), measured on
 *      `--card`/`--background`. (`--medium` light was 2.97:1 → nudged to clear the bar.)
 *
 * Usage:  node scripts/gate-contrast.mjs   (exit 0 = pass, 1 = fail)
 * Library: `checkContrast()` returns { ok, results[] } for the Vitest wiring.
 */
import { parseThemeCss, resolveTokenRgb, contrastRatio } from './lib/theme-css.mjs';

const AA_TEXT = 4.5;
const AA_NONTEXT = 3.0;
const AA_ONFILL = 3.0; // bold badge/pill text on a solid fill = large-text/UI-component bar
const WHITE = [1, 1, 1];

/** Standalone tint/body text tokens — measured on the theme's lightest paper (bar 1). */
const TEXT_AXES = [
  '--foreground',
  '--card-foreground',
  '--popover-foreground',
  '--muted-foreground',
  '--secondary-foreground',
  '--critical-text',
  '--high-text',
  '--medium-text',
  '--low-text',
  '--info-text',
  '--success-text',
  '--warning-text',
  '--danger-text',
];

/** On-fill `<axis>-foreground` on `<axis>` fill (bar 2 = 3:1; primary held to 4.5). */
const ON_FILL_AXES = [
  { axis: 'primary', bar: AA_TEXT }, // main CTA — normal-weight; clears 4.5 both themes
  { axis: 'critical', bar: AA_ONFILL },
  { axis: 'high', bar: AA_ONFILL },
  { axis: 'medium', bar: AA_ONFILL },
  { axis: 'low', bar: AA_ONFILL },
  { axis: 'info', bar: AA_ONFILL },
  { axis: 'success', bar: AA_ONFILL },
  { axis: 'warning', bar: AA_ONFILL },
  { axis: 'accent', bar: AA_ONFILL },
];

/** Non-text graphical/UI axes on card/background (bar 3 = 3:1). */
const NON_TEXT_AXES = [
  { name: 'ring on background', fg: '--ring', bg: '--background' },
  { name: 'ring on card', fg: '--ring', bg: '--card' },
  { name: 'border-strong on card', fg: '--border-strong', bg: '--card' },
  { name: 'input on card', fg: '--input', bg: '--card' },
  { name: 'chart-1 on card', fg: '--chart-1', bg: '--card' },
  { name: 'chart-2 on card', fg: '--chart-2', bg: '--card' },
  { name: 'chart-3 on card', fg: '--chart-3', bg: '--card' },
  { name: 'chart-4 on card', fg: '--chart-4', bg: '--card' },
  { name: 'chart-5 on card', fg: '--chart-5', bg: '--card' },
  { name: 'chart-6 on card', fg: '--chart-6', bg: '--card' },
  { name: 'chart-7 on card', fg: '--chart-7', bg: '--card' },
  { name: 'chart-8 on card', fg: '--chart-8', bg: '--card' },
];

/**
 * Severity / status / verdict SOLID FILLS (the `--<axis>` base token, NOT its `-text`
 * tint) used as a NON-TEXT graphic — a badge chip, a StageTimeline node, a gauge arc,
 * a severity dot. These carry meaning through color alone as a graphical object, so
 * WCAG 1.4.11 (3:1 vs the adjacent `--card`) governs. Distinct from the on-fill bar,
 * which measures the TEXT painted on top of the fill. Every distinct base token behind
 * palette.ts SEVERITY_COLOR / STATUS_COLOR / VERDICT_COLOR: severity red→…→blue-grey,
 * status green (success), status/verdict amber (warning).
 */
export const SEMANTIC_FILL_AXES = ['critical', 'high', 'medium', 'low', 'info', 'success', 'warning'];

function push(results, theme, name, kind, bar, fg, bg) {
  if (!fg || !bg) {
    // A required contrast pair that does not resolve is itself a failure (the token
    // drifted / became a non-color) — surface it, never silently skip.
    results.push({ theme, name, kind, bar, ratio: null, pass: false });
    return;
  }
  const ratio = contrastRatio(fg, bg);
  results.push({ theme, name, kind, bar, ratio: Math.round(ratio * 100) / 100, pass: ratio >= bar });
}

/**
 * @returns {{ ok: boolean, results: {theme, name, kind, bar, ratio, pass}[] }}
 */
export function checkContrast() {
  const { light, dark } = parseThemeCss();
  const themes = [
    ['light', light, WHITE], // light standalone-text reference = white paper
    ['dark', dark, resolveTokenRgb('--card', dark)], // dark reference = card
  ];
  const results = [];
  for (const [theme, map, textPaper] of themes) {
    // Bar 1 — standalone text on the theme's paper.
    for (const t of TEXT_AXES) {
      push(results, theme, `${t.slice(2)} (text)`, 'text', AA_TEXT, resolveTokenRgb(t, map), textPaper);
    }
    // Bar 2 — on-fill `-foreground` on the fill.
    for (const { axis, bar } of ON_FILL_AXES) {
      push(
        results,
        theme,
        `${axis}-foreground on ${axis}`,
        'on-fill',
        bar,
        resolveTokenRgb(`--${axis}-foreground`, map),
        resolveTokenRgb(`--${axis}`, map),
      );
    }
    // Bar 3 — non-text graphical/UI axes.
    for (const { name, fg, bg } of NON_TEXT_AXES) {
      push(results, theme, name, 'nontext', AA_NONTEXT, resolveTokenRgb(fg, map), resolveTokenRgb(bg, map));
    }
    // Bar 3 (cont.) — semantic base fills as a graphic on the card (WCAG 1.4.11).
    for (const axis of SEMANTIC_FILL_AXES) {
      push(
        results,
        theme,
        `${axis} fill on card`,
        'nontext',
        AA_NONTEXT,
        resolveTokenRgb(`--${axis}`, map),
        resolveTokenRgb('--card', map),
      );
    }
  }
  return { ok: results.every((r) => r.pass), results };
}

function main() {
  const { ok, results } = checkContrast();
  const failures = results.filter((r) => !r.pass);
  if (ok) {
    console.log(`✓ contrast: all ${results.length} semantic axes clear their WCAG bar in both themes.`);
    process.exit(0);
  }
  console.error(`✗ contrast: ${failures.length} axis/axes below the WCAG bar:`);
  for (const r of failures) {
    const got = r.ratio == null ? 'unresolved' : `${r.ratio}:1`;
    console.error(`   [${r.theme}] ${r.name} — need ≥${r.bar}:1 (${r.kind}), got ${got}`);
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
