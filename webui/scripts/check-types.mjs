#!/usr/bin/env node
/**
 * Round-5 Coupling-F — the contract-DRIFT gate (CI + local).
 *
 * Regenerates `openapi.json` + `src/lib/api-types.gen.ts` from the live backend
 * schema, then `git diff --exit-code`s the two committed artifacts. A non-empty
 * diff means the backend contract changed but the committed generated types were
 * not refreshed → FAIL the build with an actionable message. This is the
 * mechanical enforcement of CLAUDE.md's "keep types.ts in sync with models.py"
 * rule for the codegen-covered (request/enum/shared-model) surface
 * (RESEARCH_COUPLING §C3).
 *
 * Usage:
 *   npm run check:types          # regenerate + fail on drift
 *   node scripts/check-types.mjs
 *
 * If this fails locally, run `npm run gen:types` and commit the result.
 *
 * SAFETY: if the backend python/venv is unavailable (e.g. a FE-only CI job), the
 * gate SKIPS with a clear notice instead of failing — the generation itself is
 * offline-only and this gate is meant to run where the backend is importable.
 * Set TLSOC_REQUIRE_TYPEGEN=1 to turn that skip into a hard failure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBUI_DIR = resolve(__dirname, '..');
const REPO_DIR = resolve(WEBUI_DIR, '..');
const BACKEND_DIR = resolve(REPO_DIR, 'backend');

const TARGETS = ['openapi.json', 'src/lib/api-types.gen.ts'];

function python() {
  if (process.env.TLSOC_PYTHON) return process.env.TLSOC_PYTHON;
  const venv = resolve(BACKEND_DIR, '.venv/bin/python');
  return existsSync(venv) ? venv : 'python3';
}

// If the backend can't be imported here, this gate is not applicable. Skip
// (soft) unless explicitly required — a FE-only lane should not red-wall.
{
  const probe = spawnSync(python(), ['-c', 'import app.main'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    const msg =
      'check:types — backend not importable here (no venv / deps). ' +
      'The offline gen runs where the backend is available.';
    if (process.env.TLSOC_REQUIRE_TYPEGEN === '1') {
      console.error(`✗ ${msg}\n${probe.stderr || probe.error?.message || ''}`);
      process.exit(1);
    }
    console.log(`↷ SKIP: ${msg}`);
    process.exit(0);
  }
}

// Regenerate in-place (gen-types.mjs writes both TARGETS).
console.log('• regenerating types to check for drift…');
const gen = spawnSync(process.execPath, [resolve(__dirname, 'gen-types.mjs')], {
  cwd: WEBUI_DIR,
  encoding: 'utf8',
  stdio: 'inherit',
});
if (gen.status !== 0) {
  console.error('✗ check:types — generation failed (see above).');
  process.exit(1);
}

// git diff --exit-code on the two committed artifacts.
const diff = spawnSync('git', ['diff', '--exit-code', '--', ...TARGETS], {
  cwd: WEBUI_DIR,
  encoding: 'utf8',
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (diff.status !== 0) {
  console.error(
    '\n✗ check:types — generated API types are STALE (drift detected).\n' +
      '  The backend OpenAPI contract changed but the committed generated files\n' +
      '  were not refreshed. Run:\n\n' +
      '      cd webui && npm run gen:types\n\n' +
      '  then commit openapi.json + src/lib/api-types.gen.ts.',
  );
  process.exit(1);
}

console.log('✓ check:types — generated API types are up to date (no drift).');
