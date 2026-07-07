# archive/ — frozen, legacy code (not built, not deployed)

This directory holds code that has been **retired** from the active TLSOC Agentic
Triage Suite but is kept for reference and history. Nothing here is built, tested,
or shipped by the current toolchain. Treat it as read-only.

## Contents

### `kibana-plugin/` — the legacy Kibana plugin (retired 2026-06-21)

The original surface for this project was a Kibana plugin
(`tlsoc_agentic_triage`) that embedded the triage console inside an existing
Kibana and talked to the backend **only** through a Kibana server-side proxy
(`server/routes/index.ts` → `${backendUrl}/api/{path}`).

It was moved here when the suite completed its **vendor-agnostic transition**:
the standalone **web UI** (`webui/`, Vite + React + TypeScript + Tailwind CSS +
shadcn-style primitives on Radix UI, served by nginx with its own `/api` proxy)
is now the single primary surface, and the suite no longer assumes Elastic/Kibana
is present at all (state can run on Elasticsearch **or** PostgreSQL+pgvector **or**
SQLite; log sources are pluggable connectors). Maintaining a second frontend
against moving `@kbn/*` platform APIs was pure tax for a path almost no one uses.

What's preserved here:
- `kibana-plugin/tlsoc_agentic_triage/` — the full plugin source (public + server + common).
- `kibana-plugin/dist/` — the last built artifacts (`8.12.2` and `8.19.12` zips).
- `kibana-plugin/BUILD.md` — the original build guide.

**If you genuinely need the embedded-in-Kibana experience again:** the backend
contract is unchanged and additive-only, so the plugin's server proxy still works
in principle. You would need to (a) move it back under a build root, (b) re-pin it
against the target Kibana's `@kbn/*` packages, and (c) rebuild per `BUILD.md`. The
`webui/` is the supported path; reviving the plugin is a do-it-yourself exercise.

Nothing in the active tree (`backend/`, `webui/`, `deploy/`) imports from here.
