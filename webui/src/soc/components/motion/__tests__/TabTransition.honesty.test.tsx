/**
 * TabTransition honesty lock (motion #2 regression).
 *
 * TabPanelMotion is deliberately an ENTER-ONLY "the tab landed" fade+rise: Radix mounts
 * only the active panel (no outgoing panel co-renders), so a real cross-fade is impossible
 * as built, and there is no tab-to-tab height animation. The doc/comment previously
 * OVERCLAIMED a "cross-fade"; this test locks the implementation to what it actually does
 * so the claim can't drift back:
 *   - the component uses `initial`/`animate` (enter) with NO `exit` and NO
 *     `AnimatePresence`/`forceMount` (which a cross-fade would require);
 *   - the doc comment does not assert a "cross-fade" or a "height" fix it doesn't deliver.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'TabTransition.tsx');

describe('TabTransition — honest enter-only scope', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // Strip block + line comments so the checks below judge the CODE, not the doc prose
  // (which legitimately NAMES AnimatePresence/forceMount while denying their use).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('is enter-only: no exit / AnimatePresence / forceMount (which a cross-fade would need)', () => {
    expect(code).toMatch(/initial="hidden"/);
    expect(code).toMatch(/animate="show"/);
    expect(code).not.toMatch(/\bexit=/);
    expect(code).not.toMatch(/AnimatePresence/);
    expect(code).not.toMatch(/forceMount/);
  });

  it('the doc explicitly frames the transition as enter-only and denies a cross-fade', () => {
    // The honest framing must be present: an "enter-only" description AND an explicit
    // denial of the cross-fade it cannot do. Reverting to a bare positive "cross-fade"
    // claim (dropping this denial) fails the test.
    expect(src).toMatch(/enter-only/i);
    expect(src).toMatch(/not a cross-?fade/i);
  });
});
