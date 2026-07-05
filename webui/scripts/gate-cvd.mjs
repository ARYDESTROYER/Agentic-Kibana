#!/usr/bin/env node
/**
 * Round-5 W0-E E4 — GATE 5: CVD (color-vision-deficiency) sanity on the palette ramps.
 * Round-7 W2: extended from the `--chart-*` ramp ALONE to the three semantic axes too.
 *
 * The Okabe-Ito categorical ramp (`--chart-1..8`) exists so identity-arbitrary series
 * stay distinguishable for the ~8% of viewers with a CVD (DESIGN_STANDARD §1.4/§12.5);
 * the severity / status / verdict axes (`SEMANTIC_AXES`, mirroring palette.ts
 * SEVERITY_COLOR / STATUS_COLOR / VERDICT_COLOR) must stay distinguishable WITHIN each
 * axis for the same reason (two badges a viewer compares side-by-side). This gate proves
 * that AUTOMATICALLY (not just "eyeball it"):
 *   1. STRUCTURE — every ramp token resolves to a concrete color in BOTH themes.
 *   2. NO-COLLAPSE — under NORMAL vision AND each of the three dichromacy simulations
 *      (protanopia / deuteranopia / tritanopia), no PAIR of colors WITHIN a group falls
 *      below the CIE "just-noticeable-difference" floor (ΔE*ab ≥ 2.3) — i.e. no two
 *      series/severity-levels ever become the SAME swatch for a red/green/blue-deficient
 *      viewer. (The independently-authored per-theme semantic values clear it with
 *      margin — tightest ≈ 3.9, light-severity deuteranopia high↔medium.) Groups are
 *      checked SEPARATELY: two labels in DIFFERENT axes intentionally reuse a token (the
 *      verdict axis reuses SEVERITY hues), which is a same-reading, never a collapse.
 *
 * Metric: CIELAB ΔE*ab (perceptual, dep-free) — the right space for CVD separability,
 * because it preserves the LIGHTNESS (L*) differences Okabe-Ito relies on when a hue
 * axis collapses (a raw linear-RGB Euclidean distance under-weights exactly that). The
 * dichromacy simulation uses the standard Machado/Viénot linear approximation in
 * linear-sRGB. The 2.3 floor is the CIE JND; the shipped Okabe-Ito ramp clears it with
 * margin (tightest ≈ 2.6, deuteranopia).
 *
 * GRAYSCALE is measured but ADVISORY (not a failure): 8 distinct categories CANNOT all
 * separate in pure luminance — that is mathematically impossible and is exactly why the
 * standard mandates a non-color redundancy channel (SEMANTIC_ICON / patterns / labels,
 * §6.1) rather than relying on grayscale. The advisory line documents that dependence.
 *
 * Usage:  node scripts/gate-cvd.mjs   (exit 0 = pass, 1 = fail)
 * Library: `checkCvd()` returns { ok, problems[] } for the Vitest wiring.
 */
import { parseThemeCss, resolveTokenRgb } from './lib/theme-css.mjs';

export const CHART_TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8'];

/**
 * The three orthogonal semantic axes — the DISTINCT token values behind palette.ts
 * SEVERITY_COLOR / STATUS_COLOR / VERDICT_COLOR (deduped per axis: two LABELS sharing a
 * token, e.g. resolved/closed→success or false_positive/benign→info, is an INTENTIONAL
 * same-reading, not a collapse). Mirrored here as bare `--token` names because a CI gate
 * must NEVER import the app (React / lucide-react / TS) — the SAME reason theme-css.mjs
 * re-implements the WCAG math. Kept in lockstep with palette.ts by the design-gates
 * vitest wiring. Each axis is its OWN no-collapse group (cross-axis reuse is expected).
 */
export const SEMANTIC_AXES = {
  severity: ['--critical', '--high', '--medium', '--low', '--info'],
  status: ['--muted', '--primary', '--high', '--warning', '--success'],
  verdict: ['--critical', '--info', '--warning', '--high', '--muted'],
};

/** CIE just-noticeable-difference floor — no two series may collapse below this ΔE*ab. */
const JND = 2.3;

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Dichromacy simulation matrices (severity 1.0) on LINEAR sRGB (Machado/Viénot approx). */
const CVD_MATRICES = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

function applyMatrix(m, [r, g, b]) {
  return [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  ].map((x) => (x < 0 ? 0 : x > 1 ? 1 : x));
}

/** linear-sRGB → CIE XYZ (D65) → CIELAB. */
function linRgbToLab([r, g, b]) {
  const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / 0.95047), fy = f(y / 1.0), fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** ΔE*ab (CIE76) between two Lab colors. */
function deltaE(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** Grayscale (luminance-only) Lab: keep L*, zero the a*,b* chroma axes. */
function grayLab(lab) {
  return [lab[0], 0, 0];
}

/** Simulations that HARD-FAIL the gate when a pair collapses. */
const HARD_SIMS = ['normal', 'protan', 'deutan', 'tritan'];

/** Simulate a linear-sRGB color under `simName` and return its CIELAB (or null). */
function labFor(lin, simName) {
  if (!lin) return null;
  if (simName === 'normal') return linRgbToLab(lin);
  if (simName === 'gray') return grayLab(linRgbToLab(lin));
  return linRgbToLab(applyMatrix(CVD_MATRICES[simName], lin));
}

/**
 * Check ONE color group (a ramp or a semantic axis) in ONE theme, accumulating into
 * `out`: (1) STRUCTURE — every token resolves; (2) NO-COLLAPSE — no WITHIN-group pair
 * falls below the JND under normal + the three dichromacies (HARD), and (when
 * `includeGray`) under pure grayscale (ADVISORY-only). Pairs are only compared inside
 * the group, so an intentional cross-axis token reuse never registers as a collapse.
 */
function checkGroup({ theme, group, map, tokens, includeGray }, out) {
  const lin = [];
  for (const t of tokens) {
    const rgb = resolveTokenRgb(t, map);
    if (!rgb) {
      out.problems.push({ theme, group, sim: 'structure', a: t, b: '—', de: null });
      lin.push(null);
      continue;
    }
    out.resolved++;
    lin.push(rgb.map(srgbToLinear));
  }
  for (const simName of includeGray ? [...HARD_SIMS, 'gray'] : HARD_SIMS) {
    const labs = lin.map((v) => labFor(v, simName));
    for (let i = 0; i < labs.length; i++) {
      for (let j = i + 1; j < labs.length; j++) {
        if (!labs[i] || !labs[j]) continue;
        const de = deltaE(labs[i], labs[j]);
        if (de < JND) {
          const rec = { theme, group, sim: simName, a: tokens[i], b: tokens[j], de: Math.round(de * 100) / 100 };
          (simName === 'gray' ? out.advisories : out.problems).push(rec);
        }
      }
    }
  }
}

/**
 * @returns {{ ok, problems: {theme,group,sim,a,b,de}[], advisories: {...}[], resolved }}
 */
export function checkCvd() {
  const { light, dark } = parseThemeCss();
  const out = { problems: [], advisories: [], resolved: 0 };
  for (const [theme, map] of [['light', light], ['dark', dark]]) {
    // Categorical chart ramp: dichromacies HARD + grayscale ADVISORY (8 hues cannot all
    // separate in pure luminance — that is exactly what SEMANTIC_ICON, §6.1, covers).
    checkGroup({ theme, group: 'chart', map, tokens: CHART_TOKENS, includeGray: true }, out);
    // Semantic axes: dichromacies HARD, one no-collapse group per axis. No grayscale
    // group (the red/orange/gold severity ramp collapses in luminance BY DESIGN; the
    // beside-color SEMANTIC_ICON glyph, §6.1, is the CVD guarantee there).
    for (const [group, tokens] of Object.entries(SEMANTIC_AXES)) {
      checkGroup({ theme, group, map, tokens, includeGray: false }, out);
    }
  }
  return { ok: out.problems.length === 0, problems: out.problems, advisories: out.advisories, resolved: out.resolved };
}

function main() {
  const { ok, problems, advisories, resolved } = checkCvd();
  if (ok) {
    console.log(`✓ CVD: all ${resolved} palette colors (chart ramp + severity/status/verdict axes)`);
    console.log(`        resolve + stay ≥ JND (ΔE ${JND}) apart WITHIN each group under`);
    console.log('        normal / protanopia / deuteranopia / tritanopia (both themes).');
    if (advisories.length) {
      console.log(
        `        (advisory: ${advisories.length} chart pair(s) merge in pure grayscale — expected for ` +
          '8 hues; rely on the SEMANTIC_ICON redundancy channel, §6.1.)',
      );
    }
    process.exit(0);
  }
  console.error(`✗ CVD: ${problems.length} problem(s) across the palette ramps:`);
  for (const p of problems) {
    if (p.sim === 'structure') console.error(`   [${p.theme}/${p.group}] ${p.a} does not resolve to a color`);
    else console.error(`   [${p.theme}/${p.group}] ${p.sim}: ${p.a} vs ${p.b} collapse (ΔE ${p.de} < ${JND})`);
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
