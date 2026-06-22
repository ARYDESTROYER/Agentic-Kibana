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
- ☑ **Wave 3 — analytics + eval loop + collaboration + white-label UI + CI** (branch
  `Testing`; 310 tests green; webui clean). Metrics dashboard (`engine/metrics.py`,
  `GET /api/metrics`); AI-decision feedback/grading (`/cases/{id}/feedback`,
  `/feedback/stats`); case collaboration (tags/comments/assignee); org branding
  white-label (`BrandingConfig`, runtime-themeable accent, logo upload, branded
  shell/login); case export (json/md); case hover preview; broad UI polish; and a
  GitHub Actions CI merge gate (`.github/workflows/ci.yml`).
- ☑ **Vigil-inspired overhaul — Wave 2** (additive; 300 tests green; webui clean).
  Markdown playbook engine (`app/playbooks/` + `backend/playbooks/*.md`,
  deterministic selection, atomic reload, `<<<PLAYBOOK>>>` injection distinct from
  fenced evidence, 3 seed playbooks, `GET/POST /api/playbooks*`); Case-Manager
  `AutoClosePolicy` (per-verdict-class; TP opt-in off by default; NEEDS_HUMAN never;
  `fp_auto_close` migrated); optional auth (default OFF — no-auth version preserved):
  `app/auth/` (PBKDF2 + stdlib HS256) + `app/middleware/` + router-level
  `require_auth` + CI route-coverage test; webui login gate + Playbooks/Agents catalog.
  - ☐ Wave-2 leftovers: approval workflow + pre-flight cost projection + `$`-budget.
- ☑ **Vigil-inspired overhaul — Wave 1** (additive, spine intact; 244 tests green;
  webui clean). Multi-agent persona roster (`agents/personas.py`, `GET /personas`),
  plain-text runbooks (`runbooks/*.md` + `engine/runbooks.py`, `GET /runbooks`),
  hybrid BM25+vector RAG (`tools/rag.py`), tool safety tiers (`ToolTier`), hardened
  fencing + `pricing_source` provenance. Legacy Kibana plugin archived →
  `archive/kibana-plugin/`. Full study + multi-wave plan in `docs/VIGIL_STUDY.md`.
  - ☐ **Wave 2:** auth-by-default + CI route-coverage test; CSRF/headers/rate-limit;
    approval workflow + pre-flight projected-cost gate + `$`-budget ceiling.
  - ☐ **Wave 3:** cross-case memory + temporal KG; MITRE-from-STIX; detection-rule
    RAG corpus; HITL / Auto-Ops / reasoning-trace webui surfaces.
  - ☐ **Wave 4 / Epoch E:** ARQ workers + KEDA; Helm chart; OTEL + Grafana.
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

- ◐ **Epoch A — Decouple internal state.** IN PROGRESS (sub-agent): `StateStore`
  repositories (Cases/Audit/Usage/KV) + RAG vector store behind ABCs; SQL backend
  via SQLAlchemy (SQLite dev/test, Postgres + pgvector prod, lazy pg import); ES
  kept as the default behind the abstraction. So a self-hosted deploy can run on
  Postgres with NO Elasticsearch for the app's own state.
- ☑ **Epoch B — Connector SPI + query IR + OCSF.** DONE: `OCSFEvent` (version-
  pinned) + ECS/generic→OCSF mappers; `RawEvent.from_ocsf`; `StructuredQuery` IR;
  `PullConnector`/`PushReceiver` SPI + `ConnectorManifest`/`AuthField`; registry
  with `tlsoc.connectors` entry-point discovery; **Elastic + OpenSearch** pull
  connectors (byte-parity); **es_query tool + poller rewired live through the
  connector** (behaviour-preserving); **16 push receivers** (webhook/HEC/syslog +
  Kafka/SQS/Kinesis/EventHub/PubSub/RabbitMQ/NATS/MQTT/Redis/S3/GCS/Blob/file,
  lazy-dep) + format parsers; **push RUNTIME** (POST `/api/ingest/{id}` + asyncio
  receiver lifecycle + shared `IngestService`); per-source secrets; multi-source
  config (`SourceInstance`) + wizard backend; `docs/INGESTION.md`. 192 tests green.
  REMAINING: standup-aggregation + routes entity-path onto the connector; TLS
  syslog; S3 Parquet.
- ☐ **Epoch C — Wazuh connector** (reuse OpenSearch connector + alert→OCSF mapper).
- ◐ **Epoch D — Standalone web UI.** DONE: `webui/` Vite+React+TS+EUI SPA; the
  **first-run wizard** (welcome+demo / sources / providers+per-role models /
  detection / review) driven by connector manifests; reusable dynamic
  `ConnectorForm`/`ConnectorPicker`; Sources manager; sectioned full-Preferences
  Settings; Shell + health + dark mode; typed API client. Build green (strict tsc +
  vite). REMAINING: port analytics surfaces (Cases/Chat/Investigate/Scans/Standup/
  Cost) in depth (currently preview stubs); serve `dist/` from the backend or a
  reverse proxy; per-source query rendering/deep-links; formally retire the plugin.
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
