# Agentic SOC — standalone web UI (`webui/`)

A self-hosted single-page app (Vite + React 18 + TypeScript + Tailwind CSS +
shadcn-style primitives on Radix UI — **not** `@elastic/eui`) for the
vendor-agnostic Agentic SOC triage backend. This **is** the primary UI (the
legacy Kibana plugin is archived, see [`../archive/README.md`](../archive/README.md)):
the browser talks to the FastAPI backend **directly**, with no Kibana and no
in-Kibana proxy in the loop.

## What's here

- **First-run setup wizard** (`src/soc/pages/Wizard.tsx`) — a **4-step** minimal
  on-ramp (deeper configuration — the other 5 LLM providers and per-role model
  pickers — lives in Settings, not the wizard):
  1. **Welcome** — name the deployment, optional non-destructive *Demo mode*.
  2. **Sources** — pick a connector from `GET /api/connectors` (grouped by
     category), render a dynamic form from its `auth_fields` + `config_fields` via
     the shared `SourceEditor` component, **test the connection**, and save
     (secrets → `POST /api/setup/secrets`, config → `POST /api/sources`). Add
     multiple sources; mark one primary.
  3. **Provider keys** — Anthropic / OpenAI / embedding API keys only (at least
     one is recommended; without one, investigations fall back to a mock model).
     Azure / Bedrock / Vertex / OpenAI-compatible (local) keys and per-role model
     selection (router / investigator / formatter / standup / chat / overview /
     embedding, `GET /api/models`) are configured later from **Settings → Models**.
  4. **Review & finish** — summary → `POST /api/setup/complete`.
  The wizard shows automatically when `GET /api/setup/status` reports
  `setup_complete: false`, and is re-runnable from **Settings**.
- **Sources manager** (`src/soc/pages/Sources.tsx`) — a standalone top-level page
  (Platform nav group; not nested inside Settings): a dense, sortable
  `<DataTable>` (search/filter/bulk-select/inline enable toggle/status/last-event
  via `GET /api/sources/health`) for listing, adding, editing, testing, and
  deleting sources and setting the primary — reusing the same `SourceEditor`
  (`src/soc/components/SourceEditor.tsx`) the wizard uses.
- **Settings** (`src/soc/pages/Settings.tsx` + `src/soc/pages/settings/*`) — the
  full `Preferences` surface, organized as a data-driven section registry
  (5 nav groups × 25 sections: account, general, integrations, security & access,
  organization), plus write-only secret management and a "Re-run setup wizard"
  button.
- **The rest of the console** — Cases/CaseDetail, Chat/Investigate (one chat
  engine, two entry points), Automated scans, Standup, Cost, Metrics, Campaigns,
  Baseline, Batch jobs, Detection & Rules, custom Dashboards, Knowledge (RAG),
  Memory, Playbooks, Notifications/Inbox, Audit log, Users/Roles, and more — all
  mature, shipped surfaces (not previews) that call their backend endpoints and
  render full result sets, not just basic scaffolding.

**`src/soc/registry.tsx`** (`FEATURES[]`) is the single source of truth for
navigation: it derives the left nav, the router, and the command palette from
one typed table, gated per-feature by RBAC. There is no separate hand-maintained
route list to keep in sync.

The reusable centerpiece for connector configuration is **`SourceEditor`**
(`src/soc/components/SourceEditor.tsx`): it turns an `AuthField[]` into a
validated form and returns a `{ config, secrets }` pair, so any SIEM/connector
the backend advertises is configurable with zero per-connector UI code.

## Authentication

Login, 6-role RBAC (+ operator-defined custom roles), MFA (TOTP), and OIDC SSO
are **built into this app** — not something you bring yourself. Auth is
**default OFF** (the no-auth "everyone is super_admin" mode is the out-of-the-box
experience); set `TLSOC_AUTH_ENABLED=true` on the backend to turn on the login
screen and enforce RBAC. See `SECURITY.md` for the full model.

## Develop

```bash
cd webui
npm install
npm run dev          # serves on http://localhost:5173, proxies /api -> :8088
```

Point the dev proxy at a different backend with `BACKEND_URL`:

```bash
BACKEND_URL=http://my-backend:8088 npm run dev
```

Run the backend in another terminal:

```bash
cd ../backend && . .venv/bin/activate && uvicorn app.main:app --port 8088
```

## Build

```bash
cd webui
npm run build        # tsc --noEmit (strict type check) + vite build -> dist/
npm run typecheck    # type check only
npm run preview      # preview the production build
```

The build emits a static `dist/` you can serve from any web server behind a
reverse proxy that forwards `/api` to the FastAPI backend.

## Test

```bash
cd webui
npx vitest run        # unit/component tests — see Journal.md for the current count
npm run lint          # eslint, 0 errors required (a few benign warnings are OK)
```

`npm run build` + `npx vitest run` + `npm run lint` must all be clean before a
commit touching `webui/` (see `AGENTS.md` §7/§8).

## Production (Docker)

The container path bundles the build + an nginx that serves the SPA and
reverse-proxies the API — the browser only ever calls **relative** `/api/*` paths,
so it never needs to know the backend's address (no CORS, no Kibana proxy):

- **`webui/Dockerfile`** — multi-stage: `node:22-alpine` runs `npm ci` +
  `npm run build`, then `nginx:1.27-alpine` serves `dist/`.
- **`webui/nginx.conf`** — `location /api/` proxies to `http://tlsoc-backend:8088`
  (300s timeouts for long LLM investigations; a separate unbuffered
  `location /api/events` handles the live SSE stream); everything else falls back
  to `index.html` (SPA routing); hashed assets are long-cached, `index.html` is not.

The agnostic stack builds and runs this image as the `tlsoc-webui` service and
publishes it on **:8080**:

```bash
# from the repo root
docker compose -f deploy/docker-compose.agnostic.yml up -d --build
# then open http://localhost:8080
```

In production, terminate TLS at a reverse proxy in front of nginx. Application
auth (login/RBAC/MFA/SSO) is built in and optional (see above); see `SECURITY.md`
for the full threat model and hardening notes.

## Design system

The console shares one look end-to-end — reuse it rather than re-rolling styles:

- **Tokens**: `src/styles/theme.css` — CSS custom properties (dual light/dark),
  consumed through Tailwind. Semantic colors (severity/status/verdict) come from
  `src/soc/components/palette.ts`.
- **Primitives**: `src/ui/*` — shadcn-style wrappers over Radix UI (`button`,
  `card`, `dialog`, `select`, `tabs`, `table`, `tooltip`, `sheet`, …). Wrap them,
  don't fork them.
- **SOC-domain components**: `src/soc/components/*` — `PageContainer`,
  `PageHeader`, `KpiTile`/`StatCard`, `DataTable`, `EmptyState`, `RiskGauge`,
  `Can` (the RBAC guard), `ChatPanel`, and more.

See `AGENTS.md` §8 for the full design-system pointer and conventions.

## Notes

- No Kibana / `@kbn/*` imports — this is a fully standalone npm project, so new
  dependencies are a deliberate decision, not a constraint imposed by a host
  plugin (unlike the archived Kibana plugin).
- Theming: `src/soc/theme.tsx` (`ThemeProvider`/`useTheme`) drives Tailwind's
  dark-mode class + the CSS-variable tokens; a header toggle switches
  light/dark/system at runtime.
- The typed API client (`src/lib/api.ts`) centralizes error handling: non-2xx
  responses become `ApiError` carrying the backend's `detail`.
