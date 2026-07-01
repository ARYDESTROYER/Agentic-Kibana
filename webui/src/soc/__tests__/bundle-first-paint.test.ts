/**
 * Build-artifact regression test — keeps heavy vendor libraries OUT of the
 * first-paint (entry) graph.
 *
 * Two perf-bundle findings this locks:
 *   1. recharts (422 KB / 112 KB gzip) was eagerly loaded on first paint because a
 *      manualChunks co-location bug pulled clsx into the recharts chunk, so the
 *      entry's cn() statically imported recharts. Fix: split clsx/tailwind-merge
 *      into their own `utils` chunk BEFORE the recharts branch in vite.config.ts.
 *   2. framer-motion (111 KB / 37 KB gzip) loaded on first paint via the eager
 *      Login -> loginParts -> framer-motion chain. Fix: the login hero animation is
 *      now pure CSS, so framer-motion is gone from the bundle entirely.
 *
 * The assertions read the PRODUCED bundle (the static `dist/` output IS the check —
 * there is no browser/Playwright dependency). They run against an already-built
 * `dist/` (the CI / integrator flow is `vite build` then the test suite). When no
 * build is present these build-artifact cases SKIP with a clear hint rather than
 * fail — a programmatic build cannot run inside the jsdom test environment because
 * esbuild requires a real Node env. The source-level guards below need no build and
 * always run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// .../webui/src/soc/__tests__ -> .../webui
const WEBUI_ROOT = path.resolve(HERE, '..', '..', '..');
const DIST = path.join(WEBUI_ROOT, 'dist');
const HAS_DIST = fs.existsSync(path.join(DIST, 'index.html'));

const HINT = 'no dist/ build present — run `vite build` first (CI/integrator does)';

function readHtml(): string {
  return fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
}
function readEntry(): string {
  const html = readHtml();
  const m = html.match(/src="\/assets\/(index-[^"]+\.js)"/);
  if (!m) throw new Error('could not find the entry chunk in dist/index.html');
  return fs.readFileSync(path.join(DIST, 'assets', m[1]), 'utf8');
}

describe.skipIf(!HAS_DIST)('first-paint bundle graph', () => {
  if (!HAS_DIST) it.skip(HINT, () => undefined);

  it('does NOT modulepreload recharts on first paint', () => {
    expect(readHtml()).not.toMatch(/modulepreload[^>]*recharts/);
  });

  it('does NOT modulepreload framer-motion (motion-*.js) on first paint', () => {
    // The login hero is pure CSS now, so there is no motion chunk to preload.
    // (`motion-reduce` Tailwind utility classes are not chunk filenames.)
    expect(readHtml()).not.toMatch(/modulepreload[^>]*\/motion-[^"']+\.js/);
  });

  it('entry chunk does NOT statically import recharts (a lazy dynamic import is allowed)', () => {
    // A static `from"./recharts-*.js"` in the entry is the bug; a dynamic
    // `import("./recharts-*.js")` from a React.lazy chart page is fine.
    expect(readEntry()).not.toMatch(/from\s*["']\.\/recharts-[^"']+\.js["']/);
  });

  it('entry chunk does NOT statically import framer-motion (motion-*.js)', () => {
    expect(readEntry()).not.toMatch(/from\s*["']\.\/motion-[^"']+\.js["']/);
  });

  it('no motion-*.js chunk is emitted at all (framer-motion removed from the bundle)', () => {
    const assets = fs.readdirSync(path.join(DIST, 'assets'));
    expect(assets.filter((f) => /^motion-[^/]+\.js$/.test(f))).toHaveLength(0);
  });

  /* -------------------------------------------------------------------------- *
   * Round-5 Coupling-A — the FEATURES[]-derived ROUTES table + the settings-
   * sections meta split keep every page body (and the heavy Settings renderer
   * tree that the always-on CommandPalette used to drag in) OUT of the entry.
   * The entry had ballooned to ~537 kB; these assertions lock the shrink so a
   * future eager import of a page / settings section can't silently re-bloat it.
   * -------------------------------------------------------------------------- */

  it('entry chunk is well under the pre-Coupling-A 537 kB (page bodies are lazy)', () => {
    const html = readHtml();
    const m = html.match(/src="\/assets\/(index-[^"]+\.js)"/);
    if (!m) throw new Error('could not find the entry chunk in dist/index.html');
    const bytes = fs.statSync(path.join(DIST, 'assets', m[1])).size;
    // Hard ceiling FAR below the 537 777-byte regression; today it is ~264 kB.
    expect(bytes).toBeLessThan(400_000);
  });

  it('entry chunk statically imports ONLY vendor chunks (no page/settings chunk)', () => {
    // Static `from"./<chunk>.js"` statements in the entry. The ONLY allowed static
    // app-graph imports are the shared vendor splits (react-vendor/radix/icons/utils);
    // any page or the settings-sections/Settings chunk being statically imported means
    // it rode into the first-paint bundle (the exact 537 kB regression).
    const entry = readEntry();
    const statics = [...entry.matchAll(/from\s*["']\.\/([A-Za-z0-9._-]+)\.js["']/g)].map(
      (mm) => mm[1],
    );
    const ALLOWED = /^(react-vendor|radix|icons|utils)-/;
    const offenders = statics.filter((name) => !ALLOWED.test(name));
    expect(offenders, `unexpected static entry imports: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the heavy Settings section tree is code-split out of the entry', () => {
    // The Settings renderer tree (BrandingEditor/RolesInner/DangerZone/…) lands in its
    // own chunk (today `settings-dirty-*.js`), NOT the entry. Assert such a chunk exists
    // and is a real (non-trivial) split — proof the CommandPalette no longer eager-imports
    // the component-bearing settings-sections module.
    const assets = fs.readdirSync(path.join(DIST, 'assets'));
    const settingsChunks = assets.filter((f) => /^(settings-dirty|Settings)-[^/]+\.js$/.test(f));
    expect(settingsChunks.length).toBeGreaterThan(0);
    const biggest = Math.max(
      ...settingsChunks.map((f) => fs.statSync(path.join(DIST, 'assets', f)).size),
    );
    expect(biggest).toBeGreaterThan(50_000);
  });
});

describe('eager login chain does not pull framer-motion (source guard)', () => {
  // loginParts.tsx is the sole framer-motion importer AND is statically reachable
  // from the eager Login page. If anyone re-adds the dependency here, the login
  // screen would drag framer-motion back onto first paint.
  it('loginParts.tsx imports neither framer-motion nor any other animation lib', () => {
    const src = fs.readFileSync(
      path.join(WEBUI_ROOT, 'src', 'soc', 'components', 'auth', 'loginParts.tsx'),
      'utf8',
    );
    // No `import ... from 'framer-motion'` anywhere in the eager login part.
    expect(src).not.toMatch(/\bfrom\s+['"]framer-motion['"]/);
    expect(src).not.toMatch(/\bimport\(\s*['"]framer-motion['"]\s*\)/);
  });

  it('framer-motion is not imported anywhere under src/', () => {
    // Walk the source tree; assert framer-motion has no remaining importers (Option A
    // removed it outright). This is the strongest lock against silent re-introduction.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip build/dep output and test code (tests reference the string by name).
          if (['node_modules', 'dist', '__tests__', 'test'].includes(entry.name)) continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/['"]framer-motion['"]/.test(text)) offenders.push(path.relative(WEBUI_ROOT, full));
        }
      }
    };
    walk(path.join(WEBUI_ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
