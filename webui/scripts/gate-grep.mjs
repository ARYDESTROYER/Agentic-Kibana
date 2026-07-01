#!/usr/bin/env node
/**
 * Round-5 W0-E E4 — GATE 3 & 4: no NEW arbitrary text sizes / raw hex colors in `.tsx`.
 *
 * Baselined (DESIGN_STANDARD §2.6, §12.3/§12.4): the pre-existing occurrences are
 * grandfathered in `scripts/grep-baseline.json`; the guard fails ONLY on a NET-NEW
 * occurrence (a file exceeding its baseline count, or a new file with any hit). Shrinks
 * are always allowed, so the Codemod wave freely removes them.
 *
 * Usage:
 *   node scripts/gate-grep.mjs            check (exit 0 pass / 1 fail)
 *   node scripts/gate-grep.mjs --update   regenerate the baseline from the current tree
 * Library: `checkGrepGuards()` (lib/grep-guard.mjs) for the Vitest wiring.
 */
import fs from 'node:fs';
import { checkGrepGuards, countAll, BASELINE_PATH, PATTERNS } from './lib/grep-guard.mjs';

function update() {
  const counts = countAll();
  const total = Object.fromEntries(
    Object.keys(PATTERNS).map((k) => [k, Object.values(counts[k]).reduce((a, b) => a + b, 0)]),
  );
  const header = {
    _comment:
      'Round-5 W0-E E4 grep-guard baseline. Per-file counts of pre-existing arbitrary ' +
      'text sizes / raw hex in .tsx. The guard fails only on counts ABOVE these. ' +
      'Regenerate with `node scripts/gate-grep.mjs --update` (ratchets the ceiling down).',
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({ ...header, ...counts }, null, 2) + '\n');
  console.log('✓ grep baseline written:', BASELINE_PATH);
  for (const [k, n] of Object.entries(total)) console.log(`   ${k}: ${n} occurrence(s) baselined`);
}

function main() {
  if (process.argv.includes('--update')) {
    update();
    process.exit(0);
  }
  const { ok, violations } = checkGrepGuards();
  if (ok) {
    console.log('✓ grep-guards: no NEW arbitrary text-[…] size or raw #rrggbb hex in .tsx.');
    process.exit(0);
  }
  console.error(`✗ grep-guards: ${violations.length} NEW violation(s):`);
  for (const v of violations) {
    console.error(
      `   [${v.pattern}] ${v.file} — baseline ${v.baseline}, now ${v.current} ` +
        `(+${v.current - v.baseline} new)`,
    );
  }
  console.error('\nRoute new font sizes through the text-* scale (DESIGN_STANDARD §2.3) and');
  console.error('new colors through a token (§1). If a removal legitimately lowered another');
  console.error("file, run `node scripts/gate-grep.mjs --update` to ratchet the baseline.");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
