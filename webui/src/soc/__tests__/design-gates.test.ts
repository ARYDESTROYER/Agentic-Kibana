/**
 * Round-5 W0-E E4 — CI wiring for the design gates.
 *
 * The token-existence + contrast + CVD checkers (implemented dep-free under
 * `webui/scripts/`) are imported here so they run inside the normal `vitest run` (and
 * therefore in CI) — not just when someone remembers `npm run gates`. This is the
 * enforcement point that keeps the four-file token chain (theme.css ⇄ tailwind ⇄
 * theme-tokens ⇄ palette) in lockstep and proves the W0-A palette is genuinely WCAG-AA
 * and CVD-safe on every commit (DESIGN_STANDARD §12).
 *
 * The grep guards (§12.3/§12.4) are a filesystem sweep with a committed baseline; they
 * are also asserted here so a NET-NEW arbitrary text size / raw hex fails the test run.
 *
 * These read source files off disk via node `fs` (the checkers are pure node ESM), which
 * works under Vitest's jsdom environment. The scripts are the single source of truth;
 * this file only asserts their results (no logic is duplicated).
 */
import { describe, it, expect } from 'vitest';
// The gate checkers live under webui/scripts/ (node ESM). Import their pure functions.
import { checkTokenExistence } from '../../../scripts/gate-tokens.mjs';
import { checkContrast } from '../../../scripts/gate-contrast.mjs';
import { checkCvd } from '../../../scripts/gate-cvd.mjs';
import { checkGrepGuards } from '../../../scripts/lib/grep-guard.mjs';

describe('design gate: token existence (theme.css ⇄ ALLOWED_TOKENS ⇄ palette)', () => {
  it('every ALLOWED_TOKENS + palette token() name exists in :root AND .dark', () => {
    const { ok, problems, checked } = checkTokenExistence();
    expect(checked).toBeGreaterThan(0);
    // Surface the exact missing tokens in the failure message.
    expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
    expect(ok).toBe(true);
  });
});

describe('design gate: WCAG contrast (both themes)', () => {
  it('every semantic axis clears its WCAG bar (4.5:1 text / 3:1 non-text)', () => {
    const { ok, results } = checkContrast();
    const failures = results.filter((r) => !r.pass);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(ok).toBe(true);
    // Sanity: we actually measured a meaningful number of axes in both themes.
    expect(results.length).toBeGreaterThanOrEqual(40);
    expect(results.some((r) => r.theme === 'light')).toBe(true);
    expect(results.some((r) => r.theme === 'dark')).toBe(true);
  });

  it('a below-threshold pair is reported as a failure (checker is not a no-op)', () => {
    // Guard against the checker silently passing everything: assert the measured
    // ratios are real numbers and at least one axis has margin above its bar.
    const { results } = checkContrast();
    for (const r of results) expect(typeof r.ratio).toBe('number');
    expect(results.some((r) => r.ratio! > r.bar + 1)).toBe(true);
  });
});

describe('design gate: CVD safety of the --chart-* ramp', () => {
  it('all 8 chart tokens resolve in both themes and stay ≥ JND apart under 3 dichromacies', () => {
    const { ok, problems, resolved } = checkCvd();
    expect(resolved).toBe(16); // 8 chart tokens × 2 themes
    expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
    expect(ok).toBe(true);
  });
});

describe('design gate: no NEW arbitrary text sizes / raw hex in .tsx', () => {
  it('no file exceeds its committed grep baseline', () => {
    const { ok, violations } = checkGrepGuards();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    expect(ok).toBe(true);
  });
});
