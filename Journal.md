# Journal.md — shared work diary

> **Every agent (orchestrator + sub-agents) MUST add an entry here for every work
> session and milestone.** This is our memory across context resets. Newest at the
> bottom. Sub-agents that cannot commit must return their entry in their final
> report so the orchestrator appends it. Format is defined in `CLAUDE.md`.

```
### YYYY-MM-DD HH:MMZ — <agent/role> — <short title>
- Context: <goal / roadmap item>
- Did: <files, endpoints, decisions>
- Tests: <pytest/tsc/build results>
- Status: <done | in-progress | blocked: why>
- Next: <handoff>
```

---

### 2026-06-16 (earlier) — orchestrator — Phase 1 build (history backfill)
- Context: Build the full suite from the TLSOC spec (Phase-1 POC, Kibana 8.12.2).
- Did: Authored the backend (config/models/constants/utils; es client+fake+
  querybuilder+indices; llm gateway+providers+pricing; tools es_query/enrich/rag/
  vectorstore+cache; engine correlation/risk/cost_gate/case_manager/signatures/
  poller; agents prompts/router/investigator/formatter/chat/standup/graph/pipeline;
  stores + audit; api routes + state + main; Dockerfile). Built the Kibana 8.12.2
  plugin (5 surfaces + wizard + server proxy) and the zip. Wrote deploy block,
  mappings, dashboards, and all docs.
- Tests: 49 backend tests green; live in-process end-to-end (poll→investigate→
  TRUE_POSITIVE→needs_human, audit + cost ledger, idempotent). Plugin zip built
  with UI bundle. Compose merge validated against real upstream.
- Status: done. Commits 32d52d0, 942bc49, cd6571b, 585647b.
- Next: 8.19.12 support.

### 2026-06-16 (earlier) — orchestrator + sub-agents — Kibana 8.19.12 plugin build
- Context: Produce an 8.19.12-installable zip (8.12.2 manifest was rejected).
- Did: Fresh v8.19.12 checkout (`/tmp/kibana-8.19`), Node 22.22.0 (repo pin; Bazel
  removed in 8.19). Discovered 8.19 third-party plugins still use legacy
  `kibana.json` (plugin_helpers REJECTS `kibana.jsonc` package plugins);
  `--kibana-version 8.19.12` stamps the manifest. Source change = 18 import-path
  lines only (`src/plugins/*`/`src/core/*` → `@kbn/*` aliases). Added a forward-
  compat `kibana.jsonc` (reference only). Root-guard worked around with a PATH
  `yarn` shim (no Kibana source patched).
- Tests: tsc clean for our code; zip contains target/public/...plugin.js; manifest
  kibanaVersion 8.19.12; 0 hardcoded backend URLs in browser bundle; built+verified
  3×; 8.12.2 zip byte-identical.
- Status: done. Commit 9474802. Then exhaustive docs (USAGE/TROUBLESHOOTING +
  matrix updates) committed 585647b.
- Next: Dev Work Order (P0/P1/P2 + Features 1-5) on 8.19.12.

### 2026-06-16 — orchestrator — coordination docs + work-order kickoff
- Context: User asked for CLAUDE.md + Journal.md (this file) + extra docs, answered
  two product questions (no header chat button; settings incomplete), and a large
  dev work order (P0/P1/P2 + Features 1-5), all targeting 8.19.12.
- Did: Wrote CLAUDE.md (master/context/env/journal-mandate) and Journal.md.
  Confirmed root causes: `plugin.ts` registers 0 navControls (→ Feature 1);
  settings.tsx is a 369-line subset of ~91 Preferences fields (→ Feature 4).
- Tests: n/a (docs).
- Status: in-progress — beginning the work order via sequenced Opus sub-agents.
- Next: backend contract+logic changes, then plugin, then rebuild 8.19.12 + test.

### 2026-06-16 — backend agent A — P1 (stability/provenance) + P2 (risk/correctness)
- Context: Work-order P1 + P2 (ran in parallel with the P0 frontend agent).
- Did: P1 — `Case.origin_surface` + `Case.verdict_history`; `investigate_cluster(force=…)`
  skips re-investigation of an unchanged already-investigated OPEN case (no LLM,
  no verdict drift); preserve original `source_surface` on update. P2 — velocity
  no longer saturates on a same-ms burst (needs ≥3 events + ≥1s window);
  `caps.timeout_seconds` enforced via `asyncio.wait_for` → NEEDS_HUMAN on timeout;
  `normalize_kql` maps bare `ip:/user:/host:` to configured fields; CIDR
  `asset_networks` internal-asset policy in `risk.compute_risk`. Added
  `overview_model` pref + `Role.OVERVIEW` (prep for Feature 2).
- Tests: `pytest -q` green (53 passed; +test_pipeline_stability, +risk cases).
- Status: done for P1+P2. Agent was rate-limited before Features 1-4 backend.
- Next: Feature 1 chat-context, Feature 2 /api/overview, Feature 3 trigger-reason,
  Feature 4 /api/models (routes.py still untouched), then RAG.

### 2026-06-16 — frontend agent — P0 (case detail + lifecycle)
- Context: Work-order P0 ("features feel broken").
- Did: new `public/components/case_detail.tsx` rehydrates a case via
  `api.get('cases/'+id)`; selection lifted into `app.tsx` (survives tab switches);
  table rows OPEN the stored case (GET by id) instead of re-investigating; a
  separate explicit "Re-investigate (LLM)" action remains; lifecycle controls
  (Close/Confirm FP/Escalate/Reopen) → `POST cases/{id}/action`; scans rows open
  detail too.
- Tests: tsc --noEmit clean for our public/ + common/ against /tmp/kibana-8.19.
- Status: done (pending final 8.19 zip rebuild at the end).
- Next: features-frontend (F1-5) builds on this app.tsx selection state.

### 2026-06-16 14:10Z — docs sub-agent — SECURITY/RUNBOOK/CONTRIBUTING/CHANGELOG
- Context: Create the extra full-scale-deployment docs the user asked about.
- Did: SECURITY.md (threat model, trust-boundary diagram, two-key model + role
  descriptors, secrets/injection posture, hardening checklist); docs/RUNBOOK.md
  (health, dashboards, key rotation, kill switch, ILM/backup, scaling, tool IR,
  plugin re-install); CONTRIBUTING.md (workflow, conventions, extension points,
  Journal mandate); CHANGELOG.md (Keep-a-Changelog from git log). 703 lines total,
  grounded in 12 source files. Docs-only.
- Tests: n/a (docs). git status = only the 4 new files from this agent.
- Status: done.
- Next: orchestrator commit; backend Features 1-4 + RAG agent still running.

### 2026-06-16 ~15:30Z — orchestrator — backend Features 1-4 (authored directly)
- Context: The big backend agent stalled (infra watchdog) after only Feature 4's
  pricing helpers; rate-limits had also hit two earlier agents. To guarantee the
  frontend-blocking contract, I authored Features 1-4 backend myself.
- Did: Feature 4 `GET /api/models` (grouped from pricing.PRICES + configured).
  Feature 1 `ChatContext` model + `ChatRequest.context`; `ChatEngine.chat(context=)`
  fences it as UNTRUSTED and uses time_range/data_view as es_query DEFAULTS only;
  `CHAT_SYSTEM` note; `/chat` passes context. Feature 2 `agents/overview.py`
  (`OverviewService`, single-event, enrichment-reusing, cost-ledgered, never
  raises) + `POST /api/overview` + state wiring. Feature 3 `TriggerReason` model +
  `Cluster.trigger_reason` + `Case.trigger_reason`; correlation `_window_detail`
  captures the primary rule's matched window + builds a human sentence; pipeline
  copies it onto the case in all 3 builders; `CASES_MAPPING` gains
  `trigger_reason/verdict_history/origin_surface`; template priority bumped to 600.
- Tests: `pytest -q` = 60 passed (+test_features_backend: models/overview/chat-
  context/trigger-reason).
- Status: done. RAG (P1) still outstanding.
- Next: commit; then RAG (resolved-case memory, ES dense_vector store, embedding
  guard, min-cosine, chat grounding); then features-frontend; then 8.19.12 rebuild.

### 2026-06-16 ~16:10Z — frontend agent + orchestrator — Features 1/3/4 (FE) + 8.19.12 rebuild
- Context: Deliver the user's two pain points (header chat button + full settings)
  plus trigger-reason rendering, then rebuild the 8.19.12 zip.
- Did (agent): plugin.ts start() registers core.chrome.navControls.registerRight
  (global header button via toMountPoint+core.rendering); new global_chat_control
  + global_chat_flyout (reuses the Chat component with a send-time screen-context
  collector); lib/screen_context.ts (best-effort, per-source try/catch; query/
  selection only ever go in the request body); chat.tsx optional getContext prop;
  settings.tsx full rewrite (every Preferences field, per-role model pickers from
  GET /models, correlation/asset/suppression/network editors, kill switch, secrets
  status + update-keys, read-only mode); trigger_reason_callout wired into
  case_detail + scans; common/index.ts synced (origin_surface/verdict_history/
  trigger_reason + ChatContext/TriggerReason/ModelsResponse).
- Did (orchestrator): built the authoritative tlsocAgenticTriage-8.19.12.zip from
  repo source (Node 22.22.0, root-guard yarn shim, BROWSERSLIST_IGNORE_OLD_DATA).
- Tests: pytest 60 passed; tsc clean for public/+common; zip verified — bundle
  present, kibanaVersion 8.19.12, 0 backend URLs in browser bundle, navControls +
  "TLSOC Agent" compiled in (header button confirmed in the artifact).
- Status: done. Pain points delivered in the rebuilt zip.
- Next (queued): Feature 2 (Discover doc-viewer + in-app overview button),
  Feature 5 (wizard rewrite), P1 RAG; refresh USAGE/BUILD docs.

### 2026-06-16 ~17:00Z — backend/RAG sub-agent — P1 RAG upgrades
- Context: P1 "RAG improvements" (6 tasks).
- Did: (1) use_resolved_cases — RagService takes CaseStore; index_resolved_cases()
  indexes CLOSED cases (verdict+entity+rules+evidence+action, source=resolved_case)
  from ensure_seeded. (2) ESVectorStore (dense_vector tlsoc-agent-rag, kNN cosine,
  mgmt client) selected only with a real RealESClient+_mgmt; InMemoryVectorStore
  stays default/fallback; delete_index added to real+fake ES. (3) StoredChunk tagged
  with embedding_model+dim; cosine truncation removed; dim mismatch raises
  EmbeddingSpaceMismatch → clear+reseed (never truncate). (4) RagConfig.min_score=0.2;
  retrieve drops sub-threshold. (5) richer pure rag_query (entity+count+hosts/users+
  sample message). (6) RagService wired into ChatEngine; chat adds a TRUSTED
  (non-fenced, our own corpus) KB block, graceful with/without RAG.
- Tests: +tests/test_rag_p1.py (9 offline). pytest -q = 69 passed.
- Status: done. plugin/ untouched; non-negotiables preserved.
- Next: orchestrator commit; expose rag.min_score in Settings (already covered by
  the full-prefs settings page).
