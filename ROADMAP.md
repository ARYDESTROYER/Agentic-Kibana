# ROADMAP.md — live work tracking

Status legend: ☐ todo · ◐ in-progress · ☑ done. Update this + `Journal.md` as you
work. Target: **Kibana / Elasticsearch 8.19.12**. Every item ends with: rebuild
the 8.19.12 zip, `pytest -q` green, plugin build verified, docs + Journal updated,
commit + push.

## Shipped (Phase 1)
- ☑ Backend spine + 5 surfaces + tests (49 green); both plugin zips; full docs.
- ☑ 8.19.12 plugin build (legacy `kibana.json`, Node 22.22.0, import-alias port).
- ☑ CLAUDE.md, Journal.md, docs/ENVIRONMENT.md, this ROADMAP.

## Progress (this cycle, newest first)
- ☑ **UI redesign** — new shared design system (`public/lib/format.ts`,
  `public/components/ui.tsx`, expanded `public/index.scss`) and a presentation-only
  refresh of every surface: Case Board (drag handle + per-card actions menu fix the
  "can't move cards" issue; scroll lane; accented cards), Automated Scans (KPI strip
  + card grid), Cost & Tokens (KPI tiles + weighted breakdowns + bar list), Settings
  (section icons + EuiHealth credentials, all fields preserved), app shell (per-tab
  icons + nomenclature), and Standup/Investigate/Case-detail/Verdict-card
  consistency. No new deps, no logic/contract change. 6 parallel sub-agents +
  orchestrator review; tsc clean + 8.19.12 zip rebuilt + verified.
- ☑ **Cycle 3 features** (C3-1..C3-7): config-driven rule catalog (13 event.module
  + 5 ModSec sub-rules, version-guarded seed), Board Kanban tab, agent trace
  (`GET /cases/{id}/trace`), re-investigate-in-place (`POST /cases/{id}/investigate`),
  resolved-case RAG baseline on close (note textarea), expanded OpenAI catalog +
  per-rule model overrides, merged case-history timeline — committed on
  `claude/epic-cannon-p5z5ha`.
- ☑ **Cycle 2 bug fixes** (BUG-1..BUG-5 + provenance IMPROVEMENT): chat 2-turn
  analysis; investigate lookback pref + auto-widen ladder + neutral empty-state;
  Standup `cases` object + error boundary; native header chat button; sliding
  correlation look-back; manual-investigation TriggerReason/origin_surface/
  normalized reproduce_query — committed.
- ☑ Offline verification: 124 backend tests green, plugin `tsc` clean, 8.19.12 zip
  rebuilt + verified (~68 KB). No live-stack validation.
- ☑ Docs updated for Cycle 2/3 (USAGE, BUILD, CHANGELOG, ROADMAP + migration note).
- ☑ Coordination + extra docs: CLAUDE/Journal/ENVIRONMENT/ROADMAP, SECURITY,
  RUNBOOK, CONTRIBUTING, CHANGELOG.
- ☑ **P0** (plugin case detail + lifecycle), **P1** (stability/provenance),
  **P2** (risk/timeout/normalize/CIDR) — committed, 60 tests green.
- ☑ **Backend** Features 1-4 (chat context, /api/overview, trigger-reason,
  /api/models) — committed (c572069), tested.
- ☑ **Frontend** Feature 1 (header chat button + context flyout), Feature 4
  (comprehensive settings + per-role models), Feature 3 (trigger-reason render),
  `common/index.ts` sync — committed; **8.19.12 zip rebuilt + verified** (bundle
  present, manifest 8.19.12, header navControl compiled in, 0 backend-URL leak).
- ☑ **Backend P1 RAG** — resolved-case memory, ES dense_vector store, embedding
  guard, min-cosine, richer query, chat grounding — committed (260a170), 69 tests.
- ☑ **Feature 2** — per-log AI overview (Discover doc-viewer tab + in-app button
  → POST /api/overview) — committed; 8.19.12 zip rebuilt + verified.
- ☐ **Feature 5** (wizard rewrite) — DEFERRED: the original 4-step wizard is
  functional; the rewrite (dataViews.createAndSave, auto-suggest, per-role models)
  is polish best validated against a live 8.19 Kibana. Tracked for next cycle.
- Note: 4 frontend sub-agent runs hit infra failures (rate-limit/watchdog); the
  contract-critical + Feature-2 work was authored directly to guarantee tested
  results.

## EPIC — Vendor-agnostic, self-hosted agentic SOC (approved direction 2026-06-20)

Full design: [`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md).
Locked decisions: canonical schema **OCSF**; internal state **decoupled from ES
(Postgres + pgvector)**; first new connector after ELK+OpenSearch = **Wazuh**;
UI = **standalone web app** (retire the Kibana plugin). The reasoning/agent layer
is already ~90% source-agnostic (`RawEvent` projection + configurable field maps +
MCP-shaped tools); the work is concentrated in 3 seams: query/log-access, internal
storage, and the Kibana-bound UI.

- ☐ **Epoch A — Decouple internal state.** `StateStore` SPI (CaseRepository/
  AuditRepository/UsageRepository/KVStore) + Postgres impl; RAG on pgvector via the
  existing `VectorStore` ABC; keep ES impl behind the abstraction. *Do first.*
- ☐ **Epoch B — Connector SPI + query IR + OCSF.** `OCSFEvent` (version-pinned);
  `RawEvent` as a projection over OCSF; `StructuredQuery` IR; `SourceConnector` SPI
  + entry-point registry; refactor `es_query`/poller/standup onto it; ship Elastic
  (parity) + OpenSearch connectors. *Riskiest refactor — keep `pytest -q` green.*
- ☐ **Epoch C — Wazuh connector** (reuse OpenSearch connector + alert→OCSF mapper).
- ☐ **Epoch D — Standalone web UI** (reuse React/EUI components; per-source query
  rendering + deep-links; "add a source" wizard; retire the Kibana plugin).
- ☐ **Epoch E — Scale-out (as needed):** Kafka/Redpanda buffer; stateless workers;
  semantic cache; batch API; per-tenant keys/budgets; ClickHouse analytics.

## Work order (this cycle)

### P0 — Case detail + lifecycle in the UI
- ☐ Lift selected case id into app-level state/URL (`public/components/app.tsx`).
- ☐ Case-detail view rehydrates via `api.get('cases/'+id)` on selection.
- ☐ Table row opens the STORED case (GET by id), does NOT re-investigate.
- ☐ `VerdictCard` lifecycle controls → `POST cases/{id}/action`
  (close/confirm_fp/escalate/reopen/acknowledge).
- Acceptance: investigate → switch tabs → return → analysis persists; a
  `needs_human` case can be closed from the UI and persists as `CLOSED`.

### P1 — Case/verdict stability + provenance
- ☐ Don't re-run the LLM pipeline on an already-investigated OPEN case on every
  attach; re-investigate only on material change / explicit request; keep verdict
  history.
- ☐ Preserve original surface: add `origin_surface`; stop overwriting
  `source_surface` on manual investigate (`pipeline.py`).

### P1 — RAG
- ☐ Implement `use_resolved_cases` (index CLOSED cases as retrievable memory).
- ☐ Persist vector store via ES `dense_vector` kNN behind `VectorStore` ABC.
- ☐ Guard mixed embedding spaces (tag model/dim; reseed on mismatch).
- ☐ Min-cosine relevance threshold; richer retrieval query; ground chat in RAG.

### P2 — Risk/verdict correctness
- ☐ Subnet/CIDR asset tagging + internal-asset policy (asset_criticality/reputation).
- ☐ Velocity edge case (same-millisecond burst saturating to 100).
- ☐ Enforce `caps.timeout_seconds` in the investigator loop.
- ☐ Normalize `reproduce_query` field syntax across router/LLM paths.

### Feature 1 — Global header chat button + context-aware flyout
- ☐ `plugin.ts start()` registers `core.chrome.navControls.registerRight`.
- ☐ `global_chat_control.tsx`, `global_chat_flyout.tsx`, `lib/screen_context.ts`.
- ☐ `chat.tsx` optional `getContext` prop; flyout passes it (in-app tab does not).
- ☐ Backend: `ChatContext` model + `ChatRequest.context`; `ChatEngine` fences it;
  `CHAT_SYSTEM` note; `/chat` route passes context.

### Feature 2 — Per-log "AI overview"
- ☐ Discover custom doc-viewer tab (`unifiedDocViewer.registry.add`, add to
  `requiredPlugins`, register in setup).
- ☐ In-app per-row overview button (carry `_id`/`_index`).
- ☐ Backend `POST /api/overview` single-event agent + `overview_model` pref.

### Feature 3 — "Why was this triggered"
- ☐ `TriggerReason` model; `_window_breach` returns matched-window detail;
  capture per-entity trigger metadata; build human sentence on `Cluster`.
- ☐ Copy `trigger_reason` onto Case in register_candidate/_assemble_case/fail.
- ☐ `CASES_MAPPING` adds `trigger_reason {object, enabled:false}`.
- ☐ Frontend: `common/index.ts` Case + render in scans + case detail.

### Feature 4 — Comprehensive settings + per-task model selection
- ☐ Rewrite `settings.tsx` to render EVERY `Preferences` field (sectioned).
- ☐ Per-role model pickers (provider SuperSelect + model ComboBox).
- ☐ Backend `GET /api/models` from `pricing.PRICES` + configured keys.

### Feature 5 — First-run setup wizard rewrite
- ☐ 4 `EuiSteps`: ES connection (+Test), data scope (+create dataView),
  entity mapping (auto-suggest), LLM + per-role models + enrichment.
- ☐ Warn that wizard secrets are in-memory only (durable = env/.env).

## Cross-cutting (every PR)
- ☐ Keep `common/index.ts` types in sync with `models.py`.
- ☐ `pytest -q` green; plugin `tsc` clean; rebuild + verify 8.19.12 zip.
- ☐ Update docs (USAGE/TROUBLESHOOTING/BUILD/DEPLOY/README) + Journal.
