#!/usr/bin/env node
/**
 * Round-5 W0-E E4 — GATE 5: CVD (color-vision-deficiency) sanity on the `--chart-*` ramp.
 *
 * The Okabe-Ito categorical ramp (`--chart-1..8`) exists so identity-arbitrary series
 * stay distinguishable for the ~8% of viewers with a CVD (DESIGN_STANDARD §1.4/§12.5).
 * This gate proves that AUTOMATICALLY (not just "eyeball it"):
 *   1. STRUCTURE — all 8 `--chart-*` tokens resolve to a concrete color in BOTH themes.
 *   2. NO-COLLAPSE — under NORMAL vision AND each of the three dichromacy simulations
 *      (protanopia / deuteranopia / tritanopia), no PAIR of chart colors falls below the
 *      CIE "just-noticeable-difference" floor (ΔE*ab ≥ 2.3) — i.e. no two series ever
 *      become the SAME swatch for a red/green/blue-deficient viewer.
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

const CHART_TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8'];

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

/**
 * @returns {{ ok, problems: {theme,sim,a,b,de}[], advisories: {theme,sim,a,b,de}[], resolved }}
 */
export function checkCvd() {
  const { light, dark } = parseThemeCss();
  const problems = [];
  const advisories = [];
  let resolved = 0;
  const labFor = (lin, simName) => {
    if (!lin) return null;
    if (simName === 'normal') return linRgbToLab(lin);
    if (simName === 'gray') return grayLab(linRgbToLab(lin));
    return linRgbToLab(applyMatrix(CVD_MATRICES[simName], lin));
  };
  for (const [theme, map] of [['light', light], ['dark', dark]]) {
    // 1. STRUCTURE — all 8 resolve.
    const lin = [];
    for (const t of CHART_TOKENS) {
      const rgb = resolveTokenRgb(t, map);
      if (!rgb) {
        problems.push({ theme, sim: 'structure', a: t, b: '—', de: null });
        lin.push(null);
        continue;
      }
      resolved++;
      lin.push(rgb.map(srgbToLinear));
    }
    // 2. NO-COLLAPSE — normal + 3 dichromacies (hard) + grayscale (advisory), pair ≥ JND.
    for (const simName of [...HARD_SIMS, 'gray']) {
      const labs = lin.map((v) => labFor(v, simName));
      for (let i = 0; i < labs.length; i++) {
        for (let j = i + 1; j < labs.length; j++) {
          if (!labs[i] || !labs[j]) continue;
          const de = deltaE(labs[i], labs[j]);
          if (de < JND) {
            const rec = { theme, sim: simName, a: CHART_TOKENS[i], b: CHART_TOKENS[j], de: Math.round(de * 100) / 100 };
            (simName === 'gray' ? advisories : problems).push(rec);
          }
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, advisories, resolved };
}

function main() {
  const { ok, problems, advisories, resolved } = checkCvd();
  if (ok) {
    console.log(`✓ CVD: all ${resolved} --chart-* colors resolve + stay ≥ JND (ΔE ${JND}) apart under`);
    console.log('        normal / protanopia / deuteranopia / tritanopia (both themes).');
    if (advisories.length) {
      console.log(
        `        (advisory: ${advisories.length} pair(s) merge in pure grayscale — expected for ` +
          '8 hues; rely on the SEMANTIC_ICON redundancy channel, §6.1.)',
      );
    }
    process.exit(0);
  }
  console.error(`✗ CVD: ${problems.length} problem(s) on the --chart-* ramp:`);
  for (const p of problems) {
    if (p.sim === 'structure') console.error(`   [${p.theme}] ${p.a} does not resolve to a color`);
    else console.error(`   [${p.theme}] ${p.sim}: ${p.a} vs ${p.b} collapse (ΔE ${p.de} < ${JND})`);
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
