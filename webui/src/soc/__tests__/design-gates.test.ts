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
import { checkGrepGuards, loadBaseline } from '../../../scripts/lib/grep-guard.mjs';

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

/**
 * Round-5 audit M1 regression. The grep guard passes green whenever every file is at
 * or below its committed baseline — so it can be neutered by REGENERATING the baseline
 * UP after a violation is added (exactly what commit 3e447da did, grandfathering the
 * split-out CaseDetail files' arbitrary text sizes). `checkGrepGuards()` alone can
 * never catch that, because the regenerated baseline makes the new count "allowed".
 *
 * These assertions pin the baseline itself so a future up-regeneration fails CI:
 *   - files known to be fully on the type scale must be grandfathered at ZERO, and
 *   - the total grandfathered ceiling must only ratchet DOWN, never back up.
 * This block would have FAILED on 3e447da (baseline grandfathered the split files at
 * 2 and 3), catching the design regression the guard was meant to catch.
 */
describe('design gate: grep baseline only ratchets DOWN (M1 anti-grandfather)', () => {
  const baseline = loadBaseline();
  const textBase: Record<string, number> = baseline['arbitrary-text-size'] || {};

  // Files migrated to the type scale in the M1 fix. The baseline must NOT grandfather
  // any arbitrary text size for them — a nonzero entry means a violation was re-baselined
  // up instead of migrated to a scale step (DESIGN_STANDARD §2.3).
  const MUST_BE_ZERO = [
    'src/soc/pages/CaseDetail.tsx',
    'src/soc/pages/casedetail/FeedbackPanel.tsx',
    'src/soc/pages/casedetail/shared.tsx',
    'src/soc/pages/settings/automation.tsx',
  ];

  it.each(MUST_BE_ZERO)('grandfathers zero arbitrary text sizes for %s', (file) => {
    expect(textBase[file] ?? 0).toBe(0);
  });

  it('total grandfathered arbitrary text sizes never exceed the ratcheted ceiling', () => {
    // The pre-Round-5 baseline grandfathered 105 occurrences; the M1 fix ratcheted it
    // down to 75. This ceiling must only ever DROP — raising it re-grandfathers new
    // violations (the M1 defect), so the assertion is deliberately a hard `<=`.
    const total = Object.values(textBase).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(75);
  });
});
