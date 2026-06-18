# Building the TLSOC Agentic Triage Kibana plugin

This is the authoritative build guide for **both** supported Kibana versions. The
plugin is a **thin viewer** over the TLSOC backend. The browser only ever talks
to the backend *through* Kibana (a server-side proxy at `/api/tlsoc/{path*}`), so
the Kibana session, CSRF token and TLS all carry. The browser bundle contains
**no** backend URL — `backendUrl` is a server-only config (default
`http://tlsoc-backend:8088`).

The same plugin **source** builds for both versions; only the toolchain (Node,
bootstrap, root-guard) and the stamped `kibanaVersion` differ.

## Version-support matrix

| Kibana version | Built artifact (committed)                | Node (from Kibana repo pin) | Third-party manifest | Bazel | Bootstrap |
|----------------|-------------------------------------------|-----------------------------|----------------------|-------|-----------|
| **8.12.2**     | `plugin/dist/tlsocAgenticTriage-8.12.2.zip`  | **18.18.2**                 | `kibana.json`        | yes   | `yarn kbn bootstrap` (BazeliSK base URL set) |
| **8.19.12**    | `plugin/dist/tlsocAgenticTriage-8.19.12.zip` | **22.22.0**                 | `kibana.json`        | **no** (removed in 8.19) | plain `yarn kbn bootstrap` |

> Install the zip whose `kibanaVersion` **exactly matches** the running Kibana.
> `kibana-plugin install` rejects a mismatched plugin (see Troubleshooting).
> Verify a zip's stamped version with
> `unzip -p <zip> kibana/tlsocAgenticTriage/kibana.json | grep kibanaVersion`.

## Layout

```
plugin/
├── tlsoc_agentic_triage/      # buildable plugin SOURCE (committed)
│   ├── kibana.json            # legacy third-party manifest — USED by the build (both versions)
│   ├── kibana.jsonc           # 8.19 "package plugin" manifest — REFERENCE ONLY, NOT used by the build
│   ├── package.json
│   ├── tsconfig.json
│   ├── common/index.ts        # shared types + constants (PROXY_BASE = /api/tlsoc)
│   ├── server/
│   │   ├── config.ts          # config schema: backendUrl (default http://tlsoc-backend:8088)
│   │   ├── index.ts           # exports plugin() + `config` (PluginConfigDescriptor)
│   │   ├── plugin.ts          # reads config, registers proxy router
│   │   └── routes/index.ts    # catch-all GET/POST/PUT proxy -> ${backendUrl}/api/<path>
│   └── public/
│       ├── plugin.ts          # registers ONE app (id tlsocAgenticTriage)
│       ├── application.tsx     # React mount
│       ├── lib/api.ts          # core.http wrapper hitting /api/tlsoc/...
│       ├── lib/discover.ts     # DISCOVER_APP_LOCATOR helper (share + dataViews)
│       └── components/         # app shell + 6 surfaces + wizard
└── dist/
    ├── tlsocAgenticTriage-8.12.2.zip    # built, verified artifact for Kibana 8.12.2
    └── tlsocAgenticTriage-8.19.12.zip   # built, verified artifact for Kibana 8.19.12
```

## `kibana.json` vs `kibana.jsonc` — which manifest the build uses

- **`kibana.json` is the manifest the build uses, for BOTH 8.12.2 and 8.19.12.**
  Third-party plugins built with `plugin_helpers build` are still expected to be
  the legacy "external" plugin shape: a directory under
  `REPO_ROOT/plugins/<snake_case>/` containing a `kibana.json`.
- **`kibana.jsonc` is reference/forward-compat ONLY.** It describes the newer
  internal "package plugin" shape (`"type": "plugin"`, `@kbn/…` id). In 8.19,
  `plugin_helpers build` **explicitly rejects** package plugins
  (`do not support package plugins`). Do **not** copy `kibana.jsonc` into the
  build dir — copying it triggers that error.
- The committed `kibana.json` declares `"kibanaVersion": "8.12.2"`. That value is
  **overridden at build time** by `--kibana-version`, which is why the one source
  tree produces both `8.12.2` and `8.19.12` artifacts. The override is stamped
  into the zip's `kibana.json` (verified: the 8.19.12 zip's manifest reads
  `"kibanaVersion": "8.19.12"`).
- `kibana.json` now also declares `"optionalPlugins": ["unifiedDocViewer"]`
  (alongside `"requiredPlugins": ["navigation", "data", "dataViews", "share"]`).
  This is for the Feature 2 Discover doc-viewer tab ("TLSOC AI Overview"). It is
  **optional**, not required: the doc-viewer registration in `public/plugin.ts`
  `setup()` is fully guarded (it checks for `unifiedDocViewer.registry.add` and
  try/catches), so if the plugin is absent or its registry shape differs, the tab
  is skipped and plugin load is unaffected.

## No new dependencies (both versions)

Do **not** add npm dependencies. Only packages already in the Kibana monorepo are
used: `react`, `@elastic/eui`, `@kbn/i18n`, `@kbn/i18n-react`,
`@kbn/config-schema`, the core/plugin contracts, and the `navigation`, `data`,
`dataViews`, `share` plugin start contracts. The Feature 2 doc-viewer tab consumes
the **optional** `unifiedDocViewer` contract — accessed defensively via
`(plugins as any)?.unifiedDocViewer?.registry`, so it needs no static import and
adds no dependency. Adding deps breaks the build (in 8.12 it breaks bazel; in
either version it breaks the optimizer resolution).

## Build env vars (REQUIRED before bootstrap + build — both versions)

```bash
export PUPPETEER_SKIP_DOWNLOAD=true \
       PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
       CYPRESS_INSTALL_BINARY=0 \
       CHROMEDRIVER_SKIP_DOWNLOAD=true \
       PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
       BROWSERSLIST_IGNORE_OLD_DATA=true \
       NODE_OPTIONS=--max-old-space-size=4096
```

- **`BROWSERSLIST_IGNORE_OLD_DATA=true` is MANDATORY at build time.** Without it,
  `@kbn/optimizer` can succeed at the CLI level while **silently dropping the
  browser bundle** — the zip builds but has no
  `target/public/tlsocAgenticTriage.plugin.js`. Always run the verification block
  below.
- The skip vars avoid pulling browser binaries (Puppeteer/Chromium, Cypress,
  Chromedriver, Playwright) that the plugin build does not need. On a network
  allowlist you will see harmless `403` errors for these; they do not affect the
  artifact (see Troubleshooting).

---

## Recipe A — Kibana 8.12.2 (Node 18.18.2, bazel)

```bash
# 0. Clone the matching Kibana source and check out the tag.
git clone https://github.com/elastic/kibana.git /tmp/kibana-8.12
cd /tmp/kibana-8.12
git checkout v8.12.2

# 1. Select Node 18.18.2 (the monorepo pins it — see .nvmrc/.node-version in the checkout).
source /opt/nvm/nvm.sh        # or: . "$NVM_DIR/nvm.sh"
nvm install 18.18.2
nvm use 18.18.2               # must print v18.18.2

# 2. Export the build env vars (see above) PLUS the bazel base URL for 8.12.
export PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
       CYPRESS_INSTALL_BINARY=0 CHROMEDRIVER_SKIP_DOWNLOAD=true \
       PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
       BAZELISK_BASE_URL=https://github.com/bazelbuild/bazel/releases/download \
       BROWSERSLIST_IGNORE_OLD_DATA=true NODE_OPTIONS=--max-old-space-size=4096

# 3. Bootstrap the monorepo.
yarn kbn bootstrap

# 4. Scaffold a plugin skeleton (keeps the generated .i18nrc.json / .eslintrc.js /
#    .gitignore / translations/ that plugin_helpers expects).
node scripts/generate_plugin --name tlsocAgenticTriage --yes
#    -> scaffolds at /tmp/kibana-8.12/plugins/tlsoc_agentic_triage

# 5. Copy the committed SOURCE over the skeleton. Copy list:
#      public/  server/  common/  kibana.json
#    (also copy package.json + tsconfig.json). DO copy kibana.json; do NOT copy kibana.jsonc.
SRC=/home/user/Agentic-Kibana/plugin/tlsoc_agentic_triage
DST=/tmp/kibana-8.12/plugins/tlsoc_agentic_triage
rm -rf "$DST/public" "$DST/server" "$DST/common"
cp -r "$SRC/public" "$SRC/server" "$SRC/common" "$DST/"
cp "$SRC/kibana.json" "$SRC/package.json" "$SRC/tsconfig.json" "$DST/"

# 6. Build, stamping the version.
cd "$DST"
node /tmp/kibana-8.12/scripts/plugin_helpers build --kibana-version 8.12.2
#    -> build/tlsocAgenticTriage-8.12.2.zip
```

---

## Recipe B — Kibana 8.19.12 (Node 22.22.0, NO bazel)

```bash
# 0. Clone the matching Kibana source and check out the tag.
git clone https://github.com/elastic/kibana.git /tmp/kibana-8.19
cd /tmp/kibana-8.19
git checkout v8.19.12

# 1. Select Node 22.22.0 (taken from THIS checkout's .nvmrc / .node-version — NOT 18).
source /opt/nvm/nvm.sh
nvm install 22.22.0
nvm use 22.22.0              # must print v22.22.0

# 2. Export the build env vars (see "Build env vars" above). Bazel is REMOVED in
#    8.19, so NO BAZELISK_BASE_URL is needed.
export PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
       CYPRESS_INSTALL_BINARY=0 CHROMEDRIVER_SKIP_DOWNLOAD=true \
       PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
       BROWSERSLIST_IGNORE_OLD_DATA=true NODE_OPTIONS=--max-old-space-size=4096

# 3. Bootstrap (plain — no bazel workaround in 8.19).
yarn kbn bootstrap

# 4. Scaffold the skeleton.
node scripts/generate_plugin --name tlsocAgenticTriage --yes
#    -> scaffolds at /tmp/kibana-8.19/plugins/tlsoc_agentic_triage

# 5. Copy the committed SOURCE over the skeleton (same copy list as 8.12).
#      public/  server/  common/  kibana.json  (+ package.json + tsconfig.json)
#    Copy kibana.json — do NOT copy kibana.jsonc (8.19 rejects package plugins).
SRC=/home/user/Agentic-Kibana/plugin/tlsoc_agentic_triage
DST=/tmp/kibana-8.19/plugins/tlsoc_agentic_triage
rm -rf "$DST/public" "$DST/server" "$DST/common"
cp -r "$SRC/public" "$SRC/server" "$SRC/common" "$DST/"
cp "$SRC/kibana.json" "$SRC/package.json" "$SRC/tsconfig.json" "$DST/"

# 6. Build, stamping the version 8.19.12 (overrides the manifest's 8.12.2 value).
cd "$DST"
node /tmp/kibana-8.19/scripts/plugin_helpers build --kibana-version 8.19.12
#    -> build/tlsocAgenticTriage-8.19.12.zip
```

> **The UI redesign needs no recipe change.** The recipe is **unchanged**. The
> redesign adds a shared design system entirely under `public/` — `lib/format.ts`
> (formatters), `components/ui.tsx` (the `COLORS` palette + `SectionHeader`/
> `StatTile`/`EmptyState`/badge primitives), and an expanded `index.scss` (layout
> utilities) — and every surface (`board.tsx`, `scans.tsx`, `cost.tsx`,
> `settings.tsx`, `app.tsx`, `standup.tsx`, `investigate.tsx`, `case_detail.tsx`,
> `verdict_card.tsx`) composes them. All of it is plain source built only from EUI
> + existing monorepo packages, so it is picked up by the same copy + build steps
> with **no new dependency, env var, or flag**. (The `index.scss` is plain SCSS and
> compiles in the `@kbn/optimizer` for both versions.) The latest **verified**
> `tlsocAgenticTriage-8.19.12.zip` is **~74 KB** (75,631 bytes — up from ~68 KB as
> the design system + redesigned surfaces compiled in); plugin-scoped `tsc` is clean
> (the only `tsc` errors are the pre-existing `kbn-config-schema`/`kbn-i18n` monorepo
> noise). Pass the standard verification block below.
>
> **Note on the 8.12.2 zip:** the redesign source is version-agnostic (EUI + `@kbn/*`
> aliases only), so the committed `tlsocAgenticTriage-8.12.2.zip` should be rebuilt
> from the same source for parity via **Recipe A** (Node 18.18.2 + bazel). It was not
> rebuilt in the redesign session (the sandbox only had the 8.19 checkout bootstrapped);
> 8.19.12 is the primary target and is the verified artifact.

### Root-guard workaround (ONLY when building 8.19 as root)

A normal non-root dev user does **not** hit this. When building **as root**,
8.19's `buildWebpackPackages` internally runs `yarn kbn build-shared` *without*
`--allow-root`, which trips the kbn root guard and aborts the build. Fix it
**without patching Kibana** by putting a tiny `yarn` shim earliest on `PATH` that
appends `--allow-root` to `yarn kbn …` subcommands and passes everything else
through:

```bash
mkdir -p /tmp/yarnshim
cat > /tmp/yarnshim/yarn <<'SH'
#!/usr/bin/env bash
# Transparent yarn shim: append --allow-root to `yarn kbn ...` subcommands.
real_yarn="$(command -v -p yarn || true)"
[ -x "$real_yarn" ] || real_yarn="$(ls /usr/local/bin/yarn /usr/bin/yarn 2>/dev/null | head -n1)"
if [ "$1" = "kbn" ]; then
  exec "$real_yarn" "$@" --allow-root
fi
exec "$real_yarn" "$@"
SH
chmod +x /tmp/yarnshim/yarn
export PATH="/tmp/yarnshim:$PATH"   # shim must be EARLIEST on PATH
# Now re-run the bootstrap/build steps above.
```

> Confirm the shim resolves the real `yarn` correctly for your image (adjust the
> `real_yarn` lookup if `yarn` lives elsewhere). The shim only alters
> `yarn kbn …`; all other yarn invocations pass through unchanged.

---

## CRITICAL verification (run for EVERY build, both versions)

The optimizer can succeed at the CLI level while silently dropping the browser
bundle. Always confirm all of:

```bash
cd "$DST"   # the generated plugin dir under /tmp/kibana-8.xx/plugins/tlsoc_agentic_triage
ZIP=build/tlsocAgenticTriage-<VERSION>.zip   # e.g. 8.12.2 or 8.19.12

# 1. The browser bundle is present (the silent-drop check).
unzip -l "$ZIP" | grep tlsocAgenticTriage.plugin.js
#    MUST list: kibana/tlsocAgenticTriage/target/public/tlsocAgenticTriage.plugin.js
#    If missing: BROWSERSLIST_IGNORE_OLD_DATA was not set — re-export it and rebuild.

# 2. The stamped kibanaVersion matches --kibana-version.
unzip -p "$ZIP" kibana/tlsocAgenticTriage/kibana.json | grep kibanaVersion
#    MUST read the version you built for (e.g. "kibanaVersion": "8.19.12").

# 3. The browser bundle has NO hardcoded backend URL (server-only config).
unzip -p "$ZIP" kibana/tlsocAgenticTriage/target/public/tlsocAgenticTriage.plugin.js \
  | grep -c tlsoc-backend
#    MUST print 0. (backendUrl lives server-side only.)

# 4. Type-check the source (the build uses babel, no type-check).
cd "$DST"
NODE_OPTIONS=--max-old-space-size=4096 BROWSERSLIST_IGNORE_OLD_DATA=true \
  node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit \
  | grep -E '^(public|server|common)/'   # should print nothing
#    (Errors in packages/kbn-config-schema or packages/kbn-i18n — joi /
#     intl-format-cache — are pre-existing monorepo noise, unrelated to this plugin.)
```

Copy the verified zip into the repo (matching the version):

```bash
cp build/tlsocAgenticTriage-8.12.2.zip  /home/user/Agentic-Kibana/plugin/dist/   # 8.12 build
cp build/tlsocAgenticTriage-8.19.12.zip /home/user/Agentic-Kibana/plugin/dist/   # 8.19 build
```

## Source compatibility across versions (why one source builds both)

From 8.12 → 8.19 the **only** source changes were **import-path migrations**,
because 8.19 moved several plugins to `src/platform/plugins/shared`. Deep relative
imports were replaced with `@kbn/*` package aliases:

| 8.12 deep relative import                          | 8.19 `@kbn/*` alias                  |
|----------------------------------------------------|--------------------------------------|
| `../../../src/core/*`                               | `@kbn/core/*`                        |
| `src/plugins/navigation/public`                     | `@kbn/navigation-plugin/public`      |
| `src/plugins/data/public`                           | `@kbn/data-plugin/public`            |
| `src/plugins/data_views/public`                     | `@kbn/data-views-plugin/public`      |
| `src/plugins/share/public`                          | `@kbn/share-plugin/public`           |

No EUI, logic, or contract changes were needed. `DISCOVER_APP_LOCATOR` and the
`dataViews` API are unchanged between the two versions. The committed source
already uses the `@kbn/*` aliases (see `public/lib/discover.ts`,
`public/components/app.tsx`), which resolve correctly in both 8.12 and 8.19.

## Installing into Kibana

```bash
bin/kibana-plugin install file:///path/to/tlsocAgenticTriage-<VERSION>.zip
```

Pick the `<VERSION>` matching the running Kibana (see the matrix). See `DEPLOY.md`
for the in-container install + restart + verification flow.

## Configuration (kibana.yml)

```yaml
tlsocAgenticTriage.backendUrl: "http://tlsoc-backend:8088"   # default
```

The single config key `backendUrl` tells the server-side proxy where the TLSOC
backend lives. The browser never sees or uses it directly — it always calls
`/api/tlsoc/...` on Kibana, which forwards to `${backendUrl}/api/...`.

---

## Troubleshooting (build)

| # | Symptom | Root cause | Fix |
|---|---------|------------|-----|
| 1 | `nvm use` prints the wrong version, or bootstrap fails with engine/version errors | Wrong Node. 8.12 needs **18.18.2**; 8.19 needs **22.22.0** | `nvm install <ver> && nvm use <ver>` for the checkout you are building; re-bootstrap. Take the pin from the Kibana checkout's `.nvmrc`/`.node-version`. |
| 2 | Build "succeeds" but the zip has no `target/public/tlsocAgenticTriage.plugin.js` | `BROWSERSLIST_IGNORE_OLD_DATA` not set → `@kbn/optimizer` silently drops the browser bundle | `export BROWSERSLIST_IGNORE_OLD_DATA=true`, rebuild, re-run verification step 1. |
| 3 | `plugin_helpers ... do not support package plugins` | You copied/used `kibana.jsonc` (the package-plugin manifest) | Use `kibana.json` only. Remove `kibana.jsonc` from the build dir; ensure a legacy `kibana.json` is present under `plugins/tlsoc_agentic_triage/`. |
| 4 | 8.19 build aborts with a kbn **root guard** error during `build-shared` | Building as **root**; 8.19's `buildWebpackPackages` runs `yarn kbn build-shared` without `--allow-root` | Install the `yarn` shim that appends `--allow-root` to `yarn kbn …` (see "Root-guard workaround"); put it earliest on `PATH`; rebuild. Or build as a non-root user. |
| 5 | `[status=403]` for `cdn.playwright.dev`, `playwright.download.prss.microsoft.com`, Chromium, or `ci-stats.kibana.dev` | Egress allowlist blocks browser-binary / telemetry downloads the build does not need | **Harmless — ignore.** Ensure the skip env vars are exported so the build does not attempt the downloads; the artifact is unaffected. |
| 6 | Bootstrap fails part-way with out-of-disk / `ENOSPC` | Two full Kibana checkouts under `/tmp` (8.12 + 8.19) exhaust disk | `rm -rf` the checkout you are not currently building (e.g. `rm -rf /tmp/kibana-8.12`), then re-bootstrap the one you need. |
| 7 | `tsc --noEmit` reports errors in `public/`, `server/`, or `common/` after a Kibana upgrade | Upstream moved a plugin's path; a deep relative import no longer resolves | Migrate the offending import to its `@kbn/*` alias (see the source-compatibility table). Errors only in `kbn-config-schema`/`kbn-i18n` are pre-existing monorepo noise — ignore. |
| 8 | At install time: `... is not compatible with Kibana <Y>` / `Plugin ... expected Kibana version ...` | Zip was built with the wrong `--kibana-version`, or you are installing the other version's zip | Install the version-matched zip (verification step 2), or rebuild with the correct `--kibana-version <running Kibana version>`. |
| 9 | `Cannot find module '@kbn/...'` during build/type-check | New npm dependency added, or building outside a bootstrapped Kibana checkout | Do not add dependencies; build only from inside a fully bootstrapped checkout (`yarn kbn bootstrap` completed) with the plugin under `plugins/tlsoc_agentic_triage/`. |
