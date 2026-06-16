# Changelog

All notable changes to the **TLSOC Agentic Triage Suite** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Target platform: Elastic / Kibana / Elasticsearch **8.19.12** (legacy **8.12.2**
kept). History is reconstructed from `git log`.

## [Unreleased]

In-flight work order for this cycle (live status in [`ROADMAP.md`](ROADMAP.md);
session notes in [`Journal.md`](Journal.md)). Every item ends with: rebuild the
8.19.12 zip, `pytest -q` green, plugin build verified, docs + Journal updated.

### Added (in progress)
- **Feature 1 — Global header chat button + context-aware flyout.** Right-nav
  chat control + flyout; `lib/screen_context.ts`; backend `ChatContext` /
  `ChatRequest.context` fenced through the chat engine.
- **Feature 2 — Per-log "AI overview".** Discover doc-viewer tab + in-app per-row
  overview; backend `POST /api/overview` single-event agent with the cheap
  `overview_model`.
- **Feature 3 — "Why was this triggered".** `TriggerReason` model + matched-window
  detail carried onto the case and rendered in the UI.
- **Feature 4 — Comprehensive settings + per-task model selection.** Settings UI
  rendering every `Preferences` field; per-role model pickers; `GET /api/models`.
- **Feature 5 — First-run setup wizard rewrite.** 4-step `EuiSteps` (ES + test,
  data scope, entity mapping, LLM + per-role models + enrichment); in-memory
  secret warning.
- **RAG improvements (P1).** `use_resolved_cases` as retrievable memory; persist
  the vector store via ES `dense_vector` kNN behind the `VectorStore` ABC;
  mixed-embedding-space guards; min-cosine relevance threshold; ground chat in RAG.

### Changed (done this cycle)
- **P0 — Case detail + lifecycle in the UI.** Selected case lifted into app
  state; case-detail rehydrates via `GET /api/cases/{id}`; table rows open the
  stored case (no re-investigate); `VerdictCard` lifecycle controls →
  `POST /api/cases/{id}/action`.
- **P1 — Case/verdict stability + provenance.** Don't re-run the LLM pipeline on
  an already-investigated open case every attach; preserve original surface;
  keep verdict history.
- **P2 — Risk/verdict correctness.** CIDR asset tagging; velocity edge case;
  enforce `caps.timeout_seconds` in the investigator loop; normalize
  `reproduce_query` syntax.

## [1.0.0] — 2026-06-16

Phase-1 POC of the agentic SOC triage suite — a read-only consumer alongside the
TrustLab / IIT Bombay ELK pipeline.

### Added
- **Backend (FastAPI + LangGraph) — the full agentic spine.** Durable-cursor
  polling → deterministic correlation → deterministic risk scoring → cost gate →
  cheap router → strong investigator (ReAct) → formatter → deterministic Case
  Manager (close/escalate; a TRUE_POSITIVE is never auto-closed). Tools:
  `es_query` (read-only logs), `enrich` (Redis-cached AbuseIPDB/VirusTotal),
  `rag_retrieve`. One LLM gateway with a usage/cost ledger for every call.
- **Two-scoped-key Elasticsearch model.** Physically separate read-only
  (`all-logs-*`) and management (`tlsoc-agent-*`) clients; never `kibana_system`
  or the superuser at runtime (`es/client.py`).
- **The suite's own indices:** `tlsoc-agent-{cases,audit,usage}-*` plus the
  single-doc `tlsoc-agent-config` and `tlsoc-agent-cursor`.
- **Append-only audit trail** and **prompt-injection fencing seam** (all
  log-derived values wrapped as UNTRUSTED data).
- **Kibana plugin (React + EUI)** — five surfaces (Chat, Investigate/Alerts,
  Automated Scans, Daily Standup, Cost) plus Settings/Wizard; a thin viewer that
  talks to the backend only through the Kibana server-side proxy `/api/tlsoc/*`.
- **Plugin artifact for Kibana 8.12.2** (`plugin/dist/tlsocAgenticTriage-8.12.2.zip`)
  and bundled saved-object dashboards (Audit + Cost & Tokens).
- **Deploy assets** — `deploy/docker-compose.tlsoc.yml`, index-template mappings,
  dashboards; `.env.example`.
- **Offline test suite** (fake ES + mock LLM) — 49 backend tests green.

### Security
- Applied a security/correctness review pass over the backend (commit
  `942bc49`): scoped-key separation, fail-to-human on every error path, and the
  prompt-injection fencing seam.

## [Plugin build 8.19.12] — 2026-06-16

- **Built the plugin for Kibana 8.19.12** from the single source tree
  (`plugin/dist/tlsocAgenticTriage-8.19.12.zip`), keeping the 8.12.2 artifact.
  Portability via `@kbn/*` import aliases + `--kibana-version` stamping; legacy
  `kibana.json` manifest; Node 22.22.0, no bazel. No backend or contract change
  between versions (`COMPATIBILITY.md`).

## [Docs] — 2026-06-16

- **Exhaustive build/deploy/usage/troubleshooting guides** (commit `585647b`):
  `plugin/BUILD.md`, `DEPLOY.md`, `docs/USAGE.md`, `docs/TROUBLESHOOTING.md`,
  `COMPATIBILITY.md`.
- **Coordination & context docs** (commit `a9db0af`): `CLAUDE.md` (master
  context), `Journal.md` (work diary), `ROADMAP.md` (live work tracking),
  `docs/ENVIRONMENT.md` (the two environments).

[Unreleased]: https://claude.ai/code/session_01JxMk6xXxXEgQ1JKUnD7EF6
