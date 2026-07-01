#!/usr/bin/env node
/**
 * Round-5 Coupling-F — OFFLINE OpenAPI → TypeScript type generation.
 *
 * Contract-sync (RESEARCH_COUPLING §C, IMPLEMENTATION Coupling-F):
 *   1. Dump the backend OpenAPI schema WITHOUT running the stack — import
 *      `app.main:app` and write `app.openapi()` to `webui/openapi.json`
 *      (sorted keys → stable, reviewable diffs; this sandbox blocks the full
 *      stack and the webui build must work offline, CLAUDE.md §6a).
 *   2. Run `openapi-typescript` on that committed JSON to (re)generate
 *      `webui/src/lib/api-types.gen.ts`.
 *
 * This is ADDITIVE. It does NOT touch the hand-maintained `src/lib/types.ts`
 * (the mirror of `models.py`). The generated file gives correct types for all
 * request bodies + enums + shared component models; response bodies stay
 * `unknown`-ish until `response_model=` lands on endpoints (Coupling-F Phase 2).
 *
 * DEV-ONLY: `openapi-typescript` is a devDependency; the generated `.d`-style
 * type aliases are stripped at build → 0 runtime bytes.
 *
 * Pydantic-v2 note: `Optional[T]` renders as `anyOf: [{...}, {type:null}]`,
 * which openapi-typescript v7 maps to `field?: T | null` (both optional `?`
 * AND `| null`). Enums render as literal unions. Verified 2026-07-02.
 *
 * Usage:
 *   npm run gen:types            # regenerate openapi.json + api-types.gen.ts
 *   node scripts/gen-types.mjs   # same
 *
 * Env overrides (rarely needed):
 *   TLSOC_PYTHON   path to the python interpreter (default: ../backend/.venv/bin/python)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBUI_DIR = resolve(__dirname, '..');
const REPO_DIR = resolve(WEBUI_DIR, '..');
const BACKEND_DIR = resolve(REPO_DIR, 'backend');

const OPENAPI_JSON = resolve(WEBUI_DIR, 'openapi.json');
const GEN_TS = resolve(WEBUI_DIR, 'src/lib/api-types.gen.ts');

/** Locate the backend python interpreter (venv preferred; fall back to PATH). */
function resolvePython() {
  if (process.env.TLSOC_PYTHON) return process.env.TLSOC_PYTHON;
  const venv = resolve(BACKEND_DIR, '.venv/bin/python');
  if (existsSync(venv)) return venv;
  return 'python3';
}

function fail(msg) {
  console.error(`✗ gen:types — ${msg}`);
  process.exit(1);
}

// --- Step 1: dump OpenAPI offline (import app; never bind a port) ------------
// `json.dumps(..., sort_keys=True)` keeps the committed schema stable so PR
// diffs show real contract changes (not dict-ordering churn) and the CI drift
// gate (check:types) is meaningful.
const python = resolvePython();
console.log(`• dumping OpenAPI  (python: ${python})`);
const dumpCode =
  'import json,sys\n' +
  'from app.main import app\n' +
  'sys.stdout.write(json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False))\n' +
  'sys.stdout.write("\\n")\n';

const dump = spawnSync(python, ['-c', dumpCode], {
  cwd: BACKEND_DIR,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (dump.error) {
  fail(
    `could not run python (${python}): ${dump.error.message}\n` +
      '  Set TLSOC_PYTHON, or create the backend venv:\n' +
      '    cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt',
  );
}
if (dump.status !== 0) {
  fail(`OpenAPI dump failed (exit ${dump.status}):\n${dump.stderr || dump.stdout}`);
}
if (!dump.stdout || dump.stdout.trim().length === 0) {
  fail('OpenAPI dump produced empty output');
}

// Validate it parses + looks like an OpenAPI doc before writing.
let spec;
try {
  spec = JSON.parse(dump.stdout);
} catch (e) {
  fail(`OpenAPI dump was not valid JSON: ${e.message}`);
}
if (!spec.openapi || !spec.paths) {
  fail('dumped JSON does not look like an OpenAPI document (missing openapi/paths)');
}

const { writeFileSync } = await import('node:fs');
writeFileSync(OPENAPI_JSON, dump.stdout.endsWith('\n') ? dump.stdout : `${dump.stdout}\n`, 'utf8');
console.log(
  `  → ${OPENAPI_JSON}  (openapi ${spec.openapi}, ${Object.keys(spec.paths).length} paths)`,
);

// --- Step 2: openapi-typescript → src/lib/api-types.gen.ts -------------------
// Run the locally-installed binary. `--enum false` (v7 default) keeps enums as
// literal unions (no runtime `enum` objects → truly 0 runtime bytes). We add a
// generated-file banner via the CLI so lint/reviewers know not to hand-edit it.
const openapiTsBin = resolve(WEBUI_DIR, 'node_modules/.bin/openapi-typescript');
if (!existsSync(openapiTsBin)) {
  fail(
    'openapi-typescript is not installed. Run `npm install` in webui/ ' +
      '(it is a devDependency).',
  );
}

console.log('• generating TypeScript types (openapi-typescript)');
const gen = spawnSync(
  openapiTsBin,
  [OPENAPI_JSON, '--output', GEN_TS],
  { cwd: WEBUI_DIR, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
);
if (gen.error) fail(`could not run openapi-typescript: ${gen.error.message}`);
if (gen.status !== 0) fail(`openapi-typescript failed (exit ${gen.status})`);

console.log(`  → ${GEN_TS}`);
console.log('✓ gen:types done. Commit openapi.json + src/lib/api-types.gen.ts.');
