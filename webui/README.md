# Agentic SOC — standalone web UI (`webui/`)

A self-hosted single-page app (Vite + React + TypeScript + `@elastic/eui`) for the
vendor-agnostic Agentic SOC triage backend. **This replaces the Kibana plugin as
the primary UI**: the browser talks to the FastAPI backend **directly** (no Kibana,
no in-Kibana proxy).

## What's here

- **First-run setup wizard** (`src/components/Wizard/`) — a 5-step flow that asks
  for every key, value, and input the backend exposes:
  1. **Welcome / deployment** — name the deployment, optional non-destructive
     *Demo mode*.
  2. **Add your first source** — pick a connector from `GET /api/connectors`
     (grouped by category), render a **dynamic form** from its `auth_fields` +
     `config_fields`, **test the connection**, and save (secrets →
     `POST /api/setup/secrets`, config → `POST /api/sources`). Add multiple
     sources; mark one primary.
  3. **LLM providers** — Anthropic / OpenAI keys + per-role model pickers
     (router / investigator / formatter / standup / chat / overview / embedding)
     from `GET /api/models`.
  4. **Enrichment & detection** — AbuseIPDB / VirusTotal keys, correlation
     defaults, risk weights, auto-forward allowlist, kill switch.
  5. **Review & finish** — summary → `POST /api/setup/complete`.
  The wizard shows automatically when `GET /api/setup/status` reports
  `setup_complete: false`, and is re-runnable from **Settings**.
- **Sources manager** (`src/components/Sources/`) — list / add / edit / test /
  delete sources and set the primary, reusing the wizard's dynamic
  `ConnectorForm`.
- **Settings** (`src/components/Settings/`) — the full `Preferences`, sectioned
  with a side nav, plus write-only secret management and a "Re-run setup wizard"
  button.
- **Analytics surfaces** (Cases, Chat, Investigate, Scans, Standup, Cost) — these
  call their endpoints and render basic results; they are marked **Preview** and
  will be fully ported later.

The reusable centerpiece is **`ConnectorForm`** (`src/components/common/`): it
turns an `AuthField[]` into a validated EUI form and returns a
`{ config, secrets }` pair — so any SIEM/connector the backend advertises is
configurable with zero per-connector UI code.

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

## Production (Docker)

The container path bundles the build + an nginx that serves the SPA and
reverse-proxies the API — the browser only ever calls **relative** `/api/*` paths,
so it never needs to know the backend's address (no CORS, no Kibana proxy):

- **`webui/Dockerfile`** — multi-stage: `node:22-alpine` runs `npm ci` +
  `npm run build`, then `nginx:1.27-alpine` serves `dist/`.
- **`webui/nginx.conf`** — `location /api/` proxies to `http://tlsoc-backend:8088`
  (300s timeouts for long LLM investigations); everything else falls back to
  `index.html` (SPA routing); hashed assets are long-cached, `index.html` is not.

The agnostic stack builds and runs this image as the `tlsoc-webui` service and
publishes it on **:8080**:

```bash
# from the repo root
docker compose -f deploy/docker-compose.agnostic.yml up -d --build
# then open http://localhost:8080
```

In production, terminate TLS at a reverse proxy in front of nginx and add your own
authentication — the SPA is a thin viewer (see `SECURITY.md`).

## Notes

- No Kibana / `@kbn/*` imports — this is a fully standalone npm project, so new
  dependencies are fine here (unlike the plugin).
- Theming: `EuiProvider colorMode` drives EUI's Emotion-based styling; a header
  toggle switches light/dark at runtime (`src/lib/euiTheme.ts`).
- The typed API client (`src/lib/api.ts`) centralises error handling: non-2xx
  responses become `ApiError` carrying the backend's `detail`.
