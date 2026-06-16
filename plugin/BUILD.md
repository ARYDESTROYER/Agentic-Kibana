# Building the TLSOC Agentic Triage Kibana plugin

This produces `tlsocAgenticTriage-8.12.2.zip`, an installable Kibana 8.12.2 plugin that
is a **thin viewer** over the TLSOC backend. The browser only ever talks to the backend
*through* Kibana (a server-side proxy at `/api/tlsoc/{path*}`), so the Kibana session,
CSRF token and TLS all carry.

## Layout

```
plugin/
├── tlsoc_agentic_triage/      # buildable plugin SOURCE (committed)
│   ├── kibana.json
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
    └── tlsocAgenticTriage-8.12.2.zip   # the built, verified artifact
```

## Prerequisites (proven toolchain)

A working Kibana 8.12.2 checkout with bootstrap already run. In this environment that is
`/tmp/kibana` (Node 18.18.2, `yarn kbn bootstrap` already done) with a generated plugin
skeleton at `/tmp/kibana/plugins/tlsoc_agentic_triage` (this keeps the generated
`.i18nrc.json`, `.eslintrc.js`, `.gitignore`, `translations/`).

- **Node 18.18.2** is required (the monorepo pins it).
- Do **not** add new npm dependencies — only packages already in the Kibana monorepo are
  used (`react`, `@elastic/eui`, `@kbn/i18n`, `@kbn/i18n-react`, `@kbn/config-schema`,
  core/plugin contracts, `data`, `dataViews`, `share`, `navigation`). Adding deps breaks
  the bazel build.

## Exact, reproducible build steps

```bash
# 1. Select Node 18.18.2
source /opt/nvm/nvm.sh
nvm use 18.18.2            # must print v18.18.2

# 2. Copy the committed SOURCE over the bootstrapped skeleton.
#    Replace public/, server/, common/, kibana.json, package.json, tsconfig.json.
#    KEEP the generated .i18nrc.json / .eslintrc.js / .gitignore / translations/.
SRC=/home/user/Agentic-Kibana/plugin/tlsoc_agentic_triage
DST=/tmp/kibana/plugins/tlsoc_agentic_triage
rm -rf "$DST/public" "$DST/server" "$DST/common"
cp -r "$SRC/public" "$SRC/server" "$SRC/common" "$DST/"
cp "$SRC/kibana.json" "$SRC/package.json" "$SRC/tsconfig.json" "$DST/"

# 3. Export the build env vars. BROWSERSLIST_IGNORE_OLD_DATA=true is MANDATORY —
#    without it the @kbn/optimizer silently drops the UI bundle.
export PUPPETEER_SKIP_DOWNLOAD=true \
       PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
       CYPRESS_INSTALL_BINARY=0 \
       CHROMEDRIVER_SKIP_DOWNLOAD=true \
       PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
       BAZELISK_BASE_URL=https://github.com/bazelbuild/bazel/releases/download \
       BROWSERSLIST_IGNORE_OLD_DATA=true \
       NODE_OPTIONS=--max-old-space-size=4096

# 4. Build.
cd /tmp/kibana/plugins/tlsoc_agentic_triage
node ../../scripts/plugin_helpers build --kibana-version 8.12.2
# -> build/tlsocAgenticTriage-8.12.2.zip
```

> The `warn error reporting 1 timing [status=403] ... ci-stats.kibana.dev` line at the end
> is harmless network telemetry and does not affect the artifact.

## CRITICAL verification (do every time)

The optimizer can succeed at the CLI level while silently dropping the browser bundle.
Always confirm the zip contains the public plugin entry:

```bash
cd /tmp/kibana/plugins/tlsoc_agentic_triage
unzip -l build/tlsocAgenticTriage-8.12.2.zip | grep tlsocAgenticTriage.plugin.js
# MUST list: kibana/tlsocAgenticTriage/target/public/tlsocAgenticTriage.plugin.js
```

If `target/public/tlsocAgenticTriage.plugin.js` is missing, the build failed silently —
re-check that `BROWSERSLIST_IGNORE_OLD_DATA=true` was exported, then rebuild.

The verified zip is then copied into the repo:

```bash
cp build/tlsocAgenticTriage-8.12.2.zip \
   /home/user/Agentic-Kibana/plugin/dist/tlsocAgenticTriage-8.12.2.zip
```

## Optional: type-check the source

The build uses babel (no type-check), so to verify types run tsc directly:

```bash
cd /tmp/kibana/plugins/tlsoc_agentic_triage
NODE_OPTIONS=--max-old-space-size=4096 BROWSERSLIST_IGNORE_OLD_DATA=true \
  node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit \
  | grep -E '^(public|server|common)/'   # should print nothing
```

(Errors reported in `packages/kbn-config-schema` or `packages/kbn-i18n` are pre-existing
monorepo type-resolution noise — `joi`/`intl-format-cache` — and are unrelated to this
plugin.)

## Installing into Kibana

```bash
bin/kibana-plugin install file:///path/to/tlsocAgenticTriage-8.12.2.zip
```

## Configuration (kibana.yml)

```yaml
tlsocAgenticTriage.backendUrl: "http://tlsoc-backend:8088"   # default
```

The single config key `backendUrl` tells the server-side proxy where the TLSOC backend
lives. The browser never sees or uses it directly — it always calls `/api/tlsoc/...` on
Kibana, which forwards to `${backendUrl}/api/...`.
