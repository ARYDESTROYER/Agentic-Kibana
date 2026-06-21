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

### 2026-06-16 ~18:00Z — orchestrator — Feature 2 (per-log AI overview) + 8.19.12 rebuild
- Context: The Feature 2/5 frontend agent STALLED (infra watchdog, 4th frontend
  infra failure) with zero repo changes. The original wizard already has working
  4-step EuiSteps, so Feature 5 is a polish-rewrite of a functional wizard ->
  DEFERRED (tracked). I implemented Feature 2 directly.
- Did: new public/components/log_overview.tsx (renders POST /api/overview result);
  doc_viewer_overview.tsx (resolves http via getStartServices for the Discover
  tab); plugin.ts setup() registers a guarded, loosely-typed unifiedDocViewer
  doc-viewer tab "TLSOC AI Overview" (optionalPlugins, try/catch -> can't break
  setup); in-app per-row "AI overview" button in the chat result table (opens a
  modal; reconstructs a nested _source so IP enrichment works); types.ts
  AppPluginSetupDependencies; kibana.json optionalPlugins=[unifiedDocViewer].
  Rebuilt the 8.19.12 zip from source.
- Tests: pytest 69 green; tsc clean for public/+common; zip verified — bundle
  present, kibanaVersion 8.19.12, optionalPlugins set, 0 backend-URL leak,
  Feature 1/2 compiled in. dist zip 57493 bytes.
- Status: Feature 2 done. Feature 5 (wizard rewrite) DEFERRED — the existing
  wizard works; rewrite is polish + risky to do blind (no live Kibana).
- Next: USAGE/CHANGELOG refresh; Feature 5 wizard-rewrite when a live 8.19 stack
  is available to validate dataViews.createAndSave.

### 2026-06-16 ~18:40Z — docs sub-agent — USAGE.md + BUILD.md refresh for shipped features
- Context: Document this cycle's user-facing features in the usage/build guides.
- Did: USAGE.md (+144/-15) — global header chat button (F1), new "Per-log AI
  overview" section (F2) + curl for POST /api/overview & GET /api/models, case
  detail+lifecycle (P0), "why this fired" (F3), Settings now documents every
  preference + 7 per-role models, wizard-is-functional note (F5 deferred).
  BUILD.md (+20/-2) — optionalPlugins:[unifiedDocViewer] (guarded), no recipe
  change, verified 8.19.12 zip ~57KB. Grounded in routes.py/config.py/pricing.py/
  plugin.ts/kibana.json/components.
- Tests: n/a (docs); git status shows only the 2 files.
- Status: done — work-order cycle complete except deferred Feature 5.
- Next: Feature 5 wizard rewrite against a live 8.19 Kibana (tracked in ROADMAP).

### 2026-06-16 17:00Z — orchestrator — Cycle 2/3 kickoff (fresh container)
- Context: New session on branch `claude/epic-cannon-p5z5ha` at 948bc45 — the exact
  deployed commit the Cycle 2 bugs were filed against. Goal: work the Cycle 2 bug
  list + Cycle 3 feature requests via Opus sub-agents, backend-first (pytest is the
  only in-container verification; plugin build needs the heavy Kibana checkout).
- Did: rebuilt backend/.venv (baseline 69→ now 88 tests green); re-cloned
  `/tmp/kibana-8.19` (v8.19.12) + `yarn kbn bootstrap` (exit 0) in background so the
  plugin toolchain is warm for the final 8.19.12 zip rebuild. Ran Wave 1 = 3 isolated
  backend agents on disjoint files (below).
- Tests: full suite 88 passed after the wave.
- Status: in-progress — Wave 1 committed (7370f43, 65e695b, ba6d09f).
- Next: Wave 2 = investigate-path agent (BUG-2 backend + IMPROVEMENT + C3-4) owning
  routes/pipeline/config/models; then rule-catalog wave (C3-1 + C3-6b); then
  trace+resolved-RAG wave (C3-3 + C3-5); then frontend; then rebuild 8.19.12 zip.

### 2026-06-16 17:10Z — backend agent (BUG-1) — chat 2-turn analysis
- Context: BUG-1 (HIGH) — chat never showed analysis; ChatEngine.chat was single-turn
  and the fetched rows never reached the model (only a preamble + raw table).
- Did: second model turn `_analyse_results` in agents/chat.py — on tr.ok+tr.data, build
  a COMPACT facets-first aggregate (counts, time span, top-5 rules/users/hosts/ips,
  <=5 sample rows), fence() it UNTRUSTED, re-prompt for {answer}, set the final answer
  + add res2.cost to the ledger; try/except falls back to old summary so chat never
  hard-fails. No-query/query-failed paths + Feature-1 ChatContext unchanged. CHAT_SYSTEM
  rewritten for the 2-step contract (only that constant). +tests/test_chat_analysis.py.
- Tests: pytest 73 passed (at the time). Note: fence() caps at 600 chars; facets are
  ordered before sample_rows so truncation drops samples first (acceptable).
- Status: done (committed 7370f43).
- Next: plugin chat UI already renders answer+table — no contract change.

### 2026-06-16 17:15Z — backend agent (BUG-5) — real-time correlation over full window
- Context: BUG-5 (HIGH) — poller correlated only the incremental cursor batch, so bursts
  spread across >1 poll interval never reached the threshold (slow-burn misses).
- Did: poller.py only — poll_once now does a second read-only sliding look-back read
  (`max(widest rule window, poll_interval)+2*interval`, clamped to cold-start), de-dupes
  by event id with new_events, and feeds the FULL window to correlate() (signature
  unchanged). Cursor still defines "new"; signature idempotency + _attach prevent dup
  cases / re-investigation. +2 tests: a 6-event/~60s burst arriving as below-threshold
  batches now creates exactly 1 case; overlapping windows + idle polls create no dup and
  no re-investigation; verified 0 cases under old per-batch behavior.
- Tests: pytest 75 passed (at the time).
- Status: done (committed 65e695b).
- Next: live-stack sanity that the window read stays within poll_batch_size on noisy windows.

### 2026-06-16 17:30Z — backend agent (C3-6a) — OpenAI catalog + provider param quirks
- Context: C3-6 PART A (isolated half) — expand the OpenAI price catalog + per-model param
  quirks; per-rule model wiring (config/pipeline) deferred to the rule-catalog wave.
- Did: pricing.py — added gpt-4.1, gpt-4.1-mini, gpt-4-turbo, gpt-4, o4-mini, gpt-5,
  gpt-5-mini with operator-verifiable approx USD/1M prices (commented), kept _DEFAULT_PRICE;
  provider_for() maps o1/o3/o4* to openai. providers.py — _is_reasoning_or_gpt5(); OpenAI
  complete omits temperature + sends max_completion_tokens for gpt-5 family + o-series,
  classic params elsewhere. +tests/test_pricing_catalog.py (13 cases incl. httpx-boundary).
- Tests: pytest 88 passed.
- Status: done (committed ba6d09f).
- Next: per-rule model_for_rule wiring rides with C3-1 rule catalog (shares model_override).

### 2026-06-16 19:45Z — backend agent (Wave2) — investigate path: BUG-2 + IMPROVEMENT + C3-4
- Context: own the investigate flow — fix the hardcoded now-24h 400 (BUG-2), restore manual
  "Why this fired"/provenance/reproduce_query (IMPROVEMENT), add human-triggered case
  re-investigation (C3-4).
- Did: added Preferences.investigate_lookback + InvestigateRequest.lookback (per-request
  override). Rewrote routes._cluster_for_request with an auto-widen ladder
  (configured/requested → now-7d → now-30d → now-365d; skips rungs narrower than the start;
  first non-empty wins) + a neutral, specific 400 detail for the FE empty-state. Synthesized
  a manual TriggerReason (mode=manual) so "Why this fired" renders on manual cases; preserve
  origin_surface across a forced re-investigate. New POST /api/cases/{id}/investigate
  (load→rebuild via id-requery then config-windowed entity fallback→investigate_cluster(
  force=True); preserves source/origin surface, appends verdict_history; 404 missing, neutral
  400 when aged out). Made pipeline._assemble_case normalize reproduce_query UNCONDITIONALLY
  and fixed a latent normalize_kql regex bug (source.ip → source.source.ip) via a (?<![\w.])
  negative lookbehind in agents/common.py. Used now-365d (not now-1y; relative_to_millis lacks
  a year unit). No ES-layer change needed (existing ids_query + search_logs sufficed).
- Tests: +tests/test_investigate_flow.py (8). Full suite 96 passed (committed 2d07439).
- Status: done.
- Next: FE — surface the new POST /cases/{id}/investigate button + render the neutral-400
  empty-state (errorDetail); expose investigate_lookback in settings.

### 2026-06-16 18:00Z — orchestrator — build toolchain + Wave 3 launch
- Context: validate the plugin build toolchain (historically flaky) before frontend exists;
  start the rule-catalog backend wave.
- Did: yarn kbn bootstrap installed all deps (node_modules 2.4G, 1112 @kbn pkgs) but aborted
  at the trailing Playwright FIREFOX browser install (blocked CDN — PLAYWRIGHT_SKIP_BROWSER_
  DOWNLOAD only suppresses the npm postinstall, not Kibana's explicit `playwright install`).
  Since the optimizer build needs no browsers, run plugin_helpers build directly against the
  populated node_modules (build-only smoke test in flight). Launched Wave 3 (C3-1 rule catalog
  + C3-6b per-rule models) after two transient infra errors (Bash classifier + a 0-token Agent
  500) cost a retry — no work lost (tree was clean).
- Tests: n/a (orchestration).
- Status: in-progress.
- Next: verify build-only zip; commit+push Wave 3; then trace+resolved-RAG wave; then frontend.

### 2026-06-16 19:30Z — orchestrator (direct) — Wave 4: trace (C3-3) + resolved-case RAG (C3-5)
- Context: agent spawns were repeatedly 529-Overloaded (two Wave-4 sub-agents died at
  0 tokens), so I implemented this wave directly. All backend Cycle-2/3 work now done.
- Did: C3-3 — TraceStep model; GET /api/cases/{id}/trace (mgmt-key term case_id, sort ts
  asc; NEVER 404); AuditLogger.records_for_case(); formatter now writes a Role.FORMATTER
  audit row (so it appears in the trace); Preferences.trace.include_prompts toggle omits the
  untrusted prompt excerpt. C3-5 — RagService.index_resolved_case() indexes ONE resolved_case
  chunk on close/confirm_fp (entity+rules+verdict+risk+trigger+analyst note) with deterministic
  doc_id=resolved_case:{id}; StoredChunk gains doc_id (InMemory upserts, ES upserts by _id);
  case_action calls it fail-safe (close still 200 if RAG/embeddings fail); render_cluster groups
  resolved_case chunks under "## Prior analyst decisions (baseline)". Also: update_prefs now syncs
  RagService prefs so a live settings toggle (rag.enabled/use_resolved_cases/min_score) takes effect.
- Tests: +tests/test_trace_rag.py (8). Full suite 121 passed, clean under -W error::UserWarning.
  Committed 04c7be2.
- Status: BACKEND COMPLETE for Cycle 2/3. Remaining = frontend phase + 8.19.12 rebuild + docs.
- Next: own common/index.ts contract (BUG-3 standup shape, TraceStep/TraceResponse, RuleMatch/
  RuleDefinition); then parallel FE agents (case-detail hub · standup+board · settings editors);
  consolidated tsc + zip rebuild; docs + migration note.

### 2026-06-16 19:40Z — orchestrator + 3 FE agents — frontend phase (Cycle 2/3) + 8.19.12 rebuild
- Context: deliver all remaining frontend work after the backend was complete; one coordinated
  phase + a single verified build (frontend can only be tsc'd/built against the Kibana checkout).
- Did: orchestrator owned common/index.ts (BUG-3 cases-object shape; +TraceStep/TraceResponse,
  RuleMatch/RuleDefinition; committed ec7a847). Three parallel FE agents on disjoint files:
  FE-A case-detail (509b928) — BUG-2 neutral no-events empty-state (errorDetail/isNoEventsError),
  C3-3 agent_trace.tsx (EuiCommentList, untrusted query/tool/prompt in EuiCodeBlock), C3-4
  Investigate button (POST cases/{id}/investigate + trace refresh), C3-5 note modal feeding the
  action, C3-7 case_timeline.tsx (merge history+verdict_history, dedupe decisions ×N). FE-B
  (a9c97c1) — BUG-3 standup fix + ErrorBoundary, C3-2 board.tsx Kanban (drag→close/reopen/escalate,
  optimistic+revert) + Board tab in app.tsx. FE-C (49a69a8) — C3-1 rule-catalog editor + C3-6
  per-rule model table in settings.tsx (reuses the per-role pickers).
- Tests: consolidated `tsc --noEmit` CLEAN for public/server/common (all 3 agents' code). Built the
  8.19.12 zip: bundle present, kibanaVersion 8.19.12, 0 backend-URL leaks, 68KB (was 57KB); copied to
  plugin/dist (b988329). Backend suite remains 121 green.
- Status: ALL Cycle 2 bugs + Cycle 3 features delivered (BE + FE), verified, pushed. Two deliberate
  deferrals: Feature 5 (wizard rewrite — the existing 4-step wizard works; rewrite best validated on a
  live 8.19 stack) and the Cycle-2 "entity-signature attach" NOTE (being handled next).
- Next: implement the optional NOTE (surface trigger_reason on attached non-scan cases); refresh
  USAGE/BUILD/CHANGELOG/ROADMAP + migration note; final push.

### 2026-06-16 19:50Z — docs sub-agent — USAGE/BUILD/CHANGELOG/ROADMAP + migration note (Cycle 2/3)
- Context: refresh user-facing docs for the shipped Cycle-2 bug fixes + Cycle-3 features, grounded
  against the code on this branch.
- Did: USAGE.md — 7-tab table + new Board section; documented chat 2-turn analysis, native header
  button, investigate lookback/auto-widen/empty-state, agent trace + re-investigate + RAG-on-close +
  merged timeline, standup cases-object + error boundary, settings rule-catalog + per-rule models +
  expanded catalog + trace toggle, sliding correlation, and new curl examples (/cases/{id}/investigate,
  /cases/{id}/trace, lookback). BUILD.md — zip ~57→~68KB, new components compile in, recipe unchanged.
  CHANGELOG.md — Cycle 2/3 subsections. ROADMAP.md — status ticks. DEPLOY.md — new ## Migration section
  (reinstall zip, version-guarded rule_catalog seed, additive prefs, no new ES index, rebuild on pricing
  edits). Verified every claim against chat.py/routes.py/standup.py/poller.py/config.py/pricing.py/
  models.py/app.tsx/board.tsx.
- Tests: n/a (docs). Orchestrator corrected the cited test count 121→124 (the NOTE added 3 after the
  agent ran).
- Status: done.

### 2026-06-16 19:55Z — orchestrator — Cycle 2 + Cycle 3 COMPLETE
- Context: close out the full work order (Cycle-2 bugs + Cycle-3 features) on branch
  claude/epic-cannon-p5z5ha (started at the deployed 948bc45).
- Did: delivered + pushed EVERY Cycle-2 item (BUG-1..5, IMPROVEMENT, NOTE) and EVERY Cycle-3 item
  (C3-1..C3-7), backend + frontend. Backend across waves 1-4 + the NOTE; frontend via the contract
  (common/index.ts) + 3 parallel FE agents (case-detail hub / standup+board / settings editors); docs
  refreshed. Several sub-agent spawns hit transient 529/500/classifier outages — Wave 4 was authored
  directly after two 0-token agent deaths; all other waves landed via agents.
- Tests: backend 124 passed (clean under -W error::UserWarning); plugin tsc --noEmit clean for
  public/server/common; 8.19.12 zip rebuilt + verified (bundle present, kibanaVersion 8.19.12, 0
  backend-URL leaks, ~68KB) and committed to plugin/dist.
- Status: DONE. Deferred (deliberate): Feature 5 wizard rewrite (existing 4-step wizard works; rewrite
  best validated on a live 8.19 stack).
- Next: live-stack validation on the SIEM server (install the 68KB zip, restart backend → rule_catalog
  seeds; exercise board drag, agent trace, re-investigate, close-with-note→RAG, settings editors).

### 2026-06-16 18:10Z — orchestrator — plugin build toolchain VALIDATED
- Context: de-risk the historically-flaky plugin build before frontend changes exist.
- Did: wrote /tmp/build_only.sh (root-guard yarn shim → --allow-root; PLAYWRIGHT/PUPPETEER/etc.
  skip vars; BROWSERSLIST_IGNORE_OLD_DATA mandatory). generate_plugin scaffolded the skeleton,
  copied repo source over it, plugin_helpers build --kibana-version 8.19.12 against the populated
  node_modules. Result zip VERIFIED: browser bundle present, kibanaVersion 8.19.12, 0 backend-URL
  leaks, 57494 bytes (== committed zip; source unchanged). Only warning is ci-stats.kibana.dev 403
  (telemetry, harmless). The final post-frontend rebuild is now just a re-run of this script.
- Tests: build verification block (bundle/version/leak/size) all pass.
- Status: done.

### 2026-06-16 18:42Z — frontend agent (BUG-4) — header chat button styling
- Context: BUG-4 (LOW, cosmetic) — global navControl chat trigger was a dark, low-contrast button.
- Did: public/components/global_chat_control.tsx now uses Kibana's native EuiHeaderSectionItemButton
  wrapping EuiIcon type="discuss" (no hardcoded colors → EUI owns theme contrast), with aria-label/
  title + aria-expanded/pressed and a subtle notification dot while the flyout is open. Behavior/props/
  flyout wiring preserved; no other files, no new deps.
- Tests: tsc -p tsconfig.json --noEmit against /tmp/kibana-8.19 → NO PLUGIN TS ERRORS.
- Status: done (committed 387d27b, pushed).

### 2026-06-16 18:05Z — backend agent (Wave3) — rule catalog (C3-1) + per-rule models (C3-6b)
- Context: C3-1 config-driven rule catalog (13 real event.module rules + 5 ModSec sub-rules isolating
  XSS/SQLi/LFI/RCE/scanner via rule.id prefix) + C3-6b per-rule model selection (share model_override).
- Did: RuleMatch/RuleDefinition + rule_catalog/rule_catalog_seed_version/rule_model_override +
  match_rule/correlation_for_def/model_for_rule/maybe_seed_rule_catalog/default_rule_catalog in
  config.py. from_hit classifies via catalog when non-empty (empty path byte-identical); Cluster.
  primary_rule(). correlate uses correlation_for_def(rd) with legacy correlation_for(name) fallback.
  router/investigator/formatter resolve models via model_for_rule(role, cluster.primary_rule()).
  Seeding via ConfigStore.seed_rule_catalog wired into state.startup(), version-guarded, never clobbers
  operator edits. Verified empty-catalog backward-compat in correlation.py + from_hit diffs.
- Tests: +tests/test_rule_catalog.py (17). Full suite 113 passed (was 96). Committed e714a35, pushed.
- Status: done.
- Next: FE rule-catalog editor + per-rule model table in settings.tsx; common/index.ts types.

### 2026-06-18 09:00Z — orchestrator + 6 frontend sub-agents — UI redesign (design system + all surfaces)
- Context: User asked for a cleaner, more attractive UI across the plugin — better
  colour scheme + nomenclature, a Board you can actually move cards in, and a much
  tidier Automated Scans, Cost, and Settings. Branch `claude/amazing-noether-vrm2ly`.
- Did (orchestrator, authored directly):
  - NEW shared design system (single source of truth for the look):
    `public/lib/format.ts` (DASH, humanizeAge, formatTimestamp, fmtMoney/Number/
    Tokens/Percent, toPercentValue, humanizeToken) and `public/components/ui.tsx`
    (COLORS palette + tint(); verdictColor/verdictHex/statusHex/riskHex; RiskBadge/
    VerdictBadge/StatusBadge/ConfidenceBadge; SectionHeader; StatTile; EmptyState).
    Expanded `public/index.scss` with layout utilities (tlsocIconChip, tlsocStatTile,
    tlsocBoard__scroll/__column/__dropZone, tlsocCard hover/dragging, tlsocCard__handle).
  - Dispatched 6 non-overlapping sub-agents; reviewed every diff for EUI-prop/JSX
    correctness against the bootstrapped 8.19 EUI.
- Did (sub-agents, one file-set each, presentation-only, no logic/contract change):
  - board.tsx — SectionHeader; horizontal scroll lane (no more cramped columns);
    coloured column headers (status dot + count); cards restyled with verdict/status
    left-accent + shared badges; **fixes "can't move cards"**: a VISIBLE grab handle
    (customDragHandle + hasInteractiveChildren) AND a per-card actions menu
    (Open / Close / Escalate / Reopen) — both funnel into the existing confirm flow.
  - scans.tsx — SectionHeader + 4 KPI StatTiles + a responsive card grid (verdict/
    status accent, entity icon chip, shared badges, formatTimestamp·age, Open/
    Reproduce/Why-fired); EmptyState + spinner. Replaced the plain table.
  - cost.tsx — SectionHeader + 4 StatTiles; By model/role/surface breakdown cards
    with proportional EuiProgress bars; dependency-free cost-over-time bar list;
    resilient top-cost-drivers table; EmptyState. No @elastic/charts.
  - settings.tsx — visual-only: SectionHeader; accordion sections now carry an
    accented icon chip; configured-credentials shown via EuiHealth; consistent
    subsection labels. ALL ~91 fields + every handler/path unchanged.
  - app.tsx — page-header description; restrictWidth 1280; tab nomenclature + per-tab
    EuiIcon (prepend) + bottomBorder; error → EuiCallOut. Logic untouched.
  - standup.tsx — SectionHeader + 3 StatTiles + titled summary/breakdown cards +
    EmptyState; ErrorBoundary + BUG-3 cases-object handling preserved.
  - investigate.tsx / case_detail.tsx / verdict_card.tsx — adopt shared badges +
    SectionHeader + formatTimestamp; removed duplicated local verdict/status colour
    fns. trigger_reason_callout.tsx left as-is (already consistent).
- Tests: bootstrapped a fresh /tmp/kibana-8.19 (v8.19.12, Node 22.22.0); `tsc -p
  tsconfig.json --noEmit` → **0 plugin-scoped errors** (the 13 errors are all in
  `src/`/`x-pack/` kbn-config-schema/kbn-i18n — pre-existing monorepo noise).
  `plugin_helpers build --kibana-version 8.19.12` rc=0; verification block all green:
  bundle `tlsocAgenticTriage.plugin.js` present, `"kibanaVersion": "8.19.12"`,
  backend-URL leak count = 0. Verified zip = **75,631 B (~74 KB)**, copied into
  `plugin/dist/`. (Bootstrap note: the only bootstrap failure was the post-install
  `playwright install` Firefox download — blocked by egress, irrelevant to plugin
  builds; deps + all 1112 `@kbn/*` symlinks installed fine.)
- Status: done (8.19.12). The legacy 8.12.2 zip is NOT rebuilt this session (needs the
  Node 18 + bazel checkout) — source is version-agnostic; flagged in BUILD.md for parity.
- Next: commit + push to claude/amazing-noether-vrm2ly. Optional follow-ups: live-stack
  visual check on a real 8.19 Kibana; rebuild the 8.12.2 zip for parity.

### 2026-06-18 11:25Z — orchestrator — Investigate page → reference "Security Investigation" design
- Context: User supplied a reference mock for the Investigate tab and asked to implement it +
  "use the wasted free space" + make it prettier.
- Did: Rewrote `public/components/investigate.tsx` to match the reference. Header is now
  "Security Investigation" (subtitle "Triage emerging threats and analyze entity behavior
  across the infrastructure."). Manual entry uses an uppercase meta-label + entity-type
  `EuiSelect` ("IP Address"/User/Host) + `EuiFieldSearch` (magnifier + Enter-to-investigate)
  + a filled Investigate button. Replaced the cases `EuiBasicTable` with a 3-column
  `EuiFlexGrid` of "Active Case" cards — each shows ENTITY/RISK meta labels, the entity in
  monospace/primary, a prominent colour-coded risk number (riskNumberColor: ≥80 danger,
  ≥60 orange, else ink), RULES pills, a divider, CREATED timestamp and a status pill
  (open=hollow / needs_human=amber / closed=green). Whole card is a keyboard-accessible
  selectable control with a primary ring on the selected case. Added an "Active Cases"
  sub-header (live count) with Refresh + a functional **Filters** popover (client-side
  status toggles + a hidden-count badge). When no case is selected the detail area shows a
  tall dashed "Select a case to begin Agentic Triage" prompt; selecting one renders the
  existing CaseDetail + follow-up Chat. Dropped the old per-row re-investigate modal
  (CaseDetail already exposes Re-investigate). Also added a subtle global footer to
  `app.tsx` (PLUGIN_NAME + read-only note + ES-connected when known). No new deps; logic/
  contracts unchanged.
- Tests: tsc -p tsconfig.json --noEmit against /tmp/kibana-8.19 → 0 plugin-scoped errors;
  all new EUI icons verified against icon_map.js (filter/search/refresh/iInCircle OK);
  rebuilt + verified 8.19.12 zip (bundle present, kibanaVersion 8.19.12, 0 backend-URL leak,
  76,850 B ~75 KB) → copied into plugin/dist/.
- Status: done.
- Next: commit + push. Optional: apply the same card style to Scans/Board for full parity;
  live-stack visual check.

### 2026-06-18 19:45Z — orchestrator + 2 sub-agents — case detail flyout + unified cards + Settings nav
- Context: User design review: clicking a case only revealed detail far down the page (had to
  scroll) and several surfaces still felt unpolished. Agreed direction (via AskUserQuestion):
  right-side FLYOUT for detail; unify the card + open behaviour across Investigate + Scans +
  Board; add severity accents/hover, sort, filter chips, KPI strip; add a left section-nav to
  Settings; and use the wasted horizontal space.
- Did (orchestrator, authored directly):
  - NEW `lib/cases.ts` — risk banding (critical/high/medium/low), sort (risk/date), and
    filter (status/risk-band/verdict) pure helpers.
  - NEW `components/case_card.tsx` — the ONE uniform case card (severity left-accent, entity,
    prominent restrained risk number, band+verdict chips, rules +N, created + status pill;
    clickable root; optional dragHandle/cornerActions slots for the Board). Exports MetaLabel/
    StatusPill/riskNumberColor/fmtRisk.
  - NEW `components/case_grid.tsx` — KPI strip + controls (count, sort EuiSelect, refresh,
    filter EuiPopover) + removable active-filter chips + an auto-filling responsive CSS grid
    (`.tlsocCaseGrid` repeat(auto-fill,minmax(320px,1fr))).
  - NEW `components/case_detail_flyout.tsx` — right-side EuiFlyout (size l): header (entity +
    verdict/status/risk/confidence badges) + tabs (Overview · Agent trace · History · Ask) +
    sticky EuiFlyoutFooter with contextual lifecycle actions + Re-investigate; reuses
    TriggerReasonCallout/AgentTrace/CaseTimeline/Chat; confirm modal with note; neutral
    no-events handling.
  - `app.tsx` — renders ONE global flyout over any tab (selectedCaseId), full-width
    (`restrictWidth={false}`), a `casesVersion` refresh signal bumped on flyout change so
    grids re-sync; surfaces now just call `onOpenCase` (no tab switch).
  - Rewrote `investigate.tsx` + `scans.tsx` as thin wrappers around `CaseGrid` (Investigate
    keeps the search panel; Scans points at the `scans` endpoint).
  - `index.scss` — `.tlsocCaseCard` + `.tlsocCaseGrid`. Removed dead `case_detail.tsx`
    (superseded by the flyout; was imported only by the old Investigate).
- Did (sub-agents):
  - board.tsx — uses the shared `CaseCard` (dragHandle + per-card actions menu), opens the
    global flyout on click instead of switching tabs, re-fetches on `refreshSignal`; drag +
    quick-move confirm flow preserved.
  - settings.tsx — replaced the accordion stack with a two-column layout: a left `EuiSideNav`
    listing all 10 sections + the selected section's content on the right (sticky nav, uses
    the wide space). EVERY field/handler/path unchanged.
- Tests: `tsc -p tsconfig.json --noEmit` against /tmp/kibana-8.19 → 0 plugin-scoped errors;
  full icon sweep of all new/changed files verified against EUI icon_map.js (all valid);
  8.19.12 zip rebuilt + verified (bundle present, kibanaVersion 8.19.12, 0 backend-URL leak,
  78,330 B ~76 KB) → copied into plugin/dist/.
- Status: done.
- Next: commit + push. Optional follow-ups: dark-mode-safe palette pass; rebuild the 8.12.2
  zip for parity; live-stack visual check of the flyout + side-nav.

### 2026-06-20 — orchestrator — Vendor-agnostic SOC transition: research + design
- Context: User asked to convert the ELK/Kibana-coupled suite into an open-source,
  self-hosted, vendor-agnostic agentic SOC that integrates with any SIEM/EDR/XDR
  (start ELK + OpenSearch), and to research data ingestion + scaling to millions of
  logs/day. Discussion/architecture turn (no code changes yet).
- Did: ran 4 parallel sub-agents — (A) codebase ELK-coupling audit, (B) agnostic
  schema/prior-art, (C) per-vendor ingestion mechanics, (D) scaling to millions/day.
  Key finding: the reasoning/agent layer is already ~90% source-agnostic (`RawEvent`
  projection + configurable field maps in `Preferences` + MCP-shaped tools + a
  cursor that needs only timestamp+stable-id); coupling is concentrated in 3 seams
  (query/log-access = ES DSL passed straight through; internal storage = 100% ES;
  UI = Kibana plugin). Locked 4 decisions with the user: canonical schema **OCSF**;
  internal state **decoupled from ES → Postgres + pgvector**; first new connector
  after ELK+OpenSearch = **Wazuh**; UI = **standalone web app** (retire the Kibana
  plugin). Wrote `docs/AGNOSTIC_ARCHITECTURE.md` (full design: OCSF normalization,
  connector SPI via entry-points + manifest + OCSF type, pull/push ingestion +
  cursor patterns, the volume funnel + build-now/build-later scaling, StateStore
  decoupling, standalone-UI plan, 5-epoch roadmap, risks/licensing). Added the EPIC
  block to `ROADMAP.md` (Epochs A–E).
- Tests: n/a (research + docs only; no code touched, suite untouched).
- Status: done (design approved); implementation not started.
- Next: Epoch A first (StateStore SPI + Postgres impl + pgvector RAG) — highest
  "self-hostable" payoff, contained blast radius — then Epoch B (connector SPI +
  query IR + OCSF; Elastic-parity + OpenSearch connectors). Keep `pytest -q` green
  at every step; the 12 non-negotiables still hold.

### 2026-06-20 21:45Z — backend agent (connectors) — Elastic/OpenSearch pull connectors
- Context: Implement the first two PULL connectors against the connector SPI
  (app/connectors/base.py) + OCSF schema, as faithful wrappers of the read-only ES
  access, so a later rewire of es_query.py/poller.py is behavior-preserving.
- Did: app/connectors/elastic.py (ElasticConnector(PullConnector); ping/poll/
  search/fetch_by_ids/to_ocsf/test_connection; rich manifest with es_url/es_api_key
  [secret]/es_ca_cert/es_verify_certs + 8 ECS-default config_fields) reusing
  poll_query/ids_query and reproducing es_query.py's body+KQL exactly;
  app/connectors/opensearch.py (subclass; source_type=OPENSEARCH; manifest only;
  query_language=lucene); tests/test_connectors_elastic.py (11 offline tests).
- Tests: 135 passed (124 existing + 11 new); parity confirmed programmatically.
- Status: done. Next: orchestrator wires registry + rewires es_query/poller.

### 2026-06-20 22:30Z — backend agent (receivers) — push/queue/object-store ingestion
- Context: Support EVERY common way logs are forwarded to us, against the SPI + OCSF.
- Did: app/connectors/receivers/{formats,common,webhook,syslog,queues,objectstore,
  __init__}.py. formats.py = stdlib detect/parse json/ndjson/CEF/LEEF/syslog-3164/
  5424/GELF/kv (never raises). PayloadReceiver base (records→generic_to_ocsf→
  RawEvent.from_ocsf). WebhookReceiver (bearer/HMAC/none) + HECReceiver (Splunk
  envelope). SyslogReceiver (asyncio UDP/TCP). 9 broker receivers (Kafka/SQS/
  Kinesis/EventHub/PubSub/RabbitMQ/NATS/MQTT/RedisStreams) + S3/GCS/AzureBlob/File,
  all lazy-importing optional deps. BUILTIN_RECEIVERS (16). 
- Tests: tests/test_receivers.py (48) — formats, webhook auth, HEC unwrap, syslog,
  all manifests valid with NO optional deps. Full suite 183 passed.
- Status: done. Next: orchestrator wires registry + receiver runtime/lifecycle.

### 2026-06-20 23:30Z — orchestrator — connector registry + live rewire + wizard backend
- Context: Make the connector abstraction the LIVE path and stand up the
  multi-source wizard backend (Epoch B integration), after the two sub-agents.
- Did: app/connectors/registry.py (SourceType→class map, manifests() for the
  wizard, tlsoc.connectors entry-point discovery; 18 builtins = 2 pull + 16
  receivers). Rewired the agent's log surface through the connector, behaviour-
  preserving: es_query.py tool now compiles a StructuredQuery and calls
  source.search()/fetch_by_ids() (identical ToolResult, incl. the 0-severity
  edge); poller.poll_once reads via source.poll() for both the incremental and
  sliding-window reads; pipeline/chat take an optional `source` (default
  ElasticConnector(es) for back-compat, test_rag_p1 still constructs ChatEngine
  directly); state._wire builds self.log_source (_build_log_source picks Elastic/
  OpenSearch by primary_source) and injects it; added state.rebuild_log_source().
  Routes: GET /api/connectors (+/{source_type}), POST /api/connectors/test,
  GET/POST/DELETE /api/sources (SourceInstance CRUD; new primary unsets others).
  config.py SourceInstance + Preferences.sources + primary_source() (empty ==
  legacy single implicit Elastic source). docs/INGESTION.md authored.
- Tests: 188 passed (183 + 5 new tests/test_connectors_api.py); zero regressions
  through the rewire. NOTE: real baseline is 188 now (CLAUDE.md's "49"/"124" stale).
- Status: done. Connector path is live; wizard backend ready.
- Next: receiver RUNTIME (webhook FastAPI route + asyncio lifecycle in AppState so
  push sources actually flow), per-source secret storage, then Epoch A (StateStore
  → Postgres + pgvector), then the standalone web UI + full first-run wizard.

### 2026-06-21 00:30Z — orchestrator — push ingestion RUNTIME (every-way-in works)
- Context: Make push sources actually flow end-to-end (not just exist as classes),
  on a single shared ingest path with the poller.
- Did: app/engine/ingest.py — extracted the shared correlate→attach/investigate/
  register logic (handle_clusters, attach_cluster, dedup_by_id) + IngestService
  (the entrypoint receivers feed; never raises on a bad batch). Refactored
  poller.poll_once to use handle_clusters/dedup_by_id (kept a thin _attach
  delegator for the existing tests); removed the duplicated loop. config.py: Secrets
  gains connector_secrets (per-source secret tier, never persisted to config) +
  source_secrets()/set_source_secret(). state.py: wires self.ingest_service; starts
  enabled background PUSH receivers (syslog/queues/object-store) as guarded asyncio
  tasks whose emit feeds IngestService (HTTP webhook/HEC are route-driven, skipped);
  _stop_receivers on shutdown. routes.py: POST /api/ingest/{source_id} (webhook/HEC
  → verify auth → parse → OCSF → IngestService; 401 on auth fail), POST
  /api/sources/{id}/secrets (per-source secrets → secret tier; records field NAMES
  on the SourceInstance). FIX: generic_to_ocsf no longer short-circuits to the ECS
  path on a loose @timestamp heuristic — that dropped the record id (collapsing a
  batch to 1 via id-dedup) and missed generic field names (src_ip vs source.ip);
  now always uses the alias path (covers ECS + generic) with per-record uid.
- Tests: +tests/test_ingest_push.py (4: webhook→case end-to-end, 404, bearer-auth
  enforced via per-source secret, NDJSON body). Full suite 192 passed (188 + 4).
- Status: done. Push + pull both flow through one ingest path.
- Next: Epoch A (StateStore → Postgres + pgvector); standalone web UI + wizard
  (sub-agent in flight); later: TLS for syslog, S3 Parquet, restart receivers on
  live source change, standup-aggregation + routes entity-path onto the connector.

### 2026-06-21 00:00Z — frontend agent (webui) — standalone SPA + first-run wizard
- Context: New deliverable — a vendor-agnostic, self-hosted web UI decoupled from
  Kibana; talks to the FastAPI backend directly. Headline = first-run wizard +
  connector/source management (Epoch D start).
- Did: Created webui/ (Vite+React+TS+@elastic/eui 95). Typed API client
  (src/lib/api.ts, ApiError); types mirroring ConnectorManifest/AuthField/
  SourceInstance/Preferences/ConnectionTest/ModelsResponse/Case; framework-free
  format.ts; plugin COLORS palette reproduced as standalone theming. Reusable
  dynamic ConnectorForm + ConnectorPicker + SourceEditor + ModelPicker +
  SecretInput. 5-step first-run Wizard (Welcome+demo-mode / Sources / Providers+
  per-role models / Detection+correlation+risk+allowlist+kill-switch / Review→
  /setup/complete); auto-shows when setup_complete is false; re-runnable from
  Settings. Sources manager (list/add/edit/test/delete/primary). Sectioned
  Settings (full Preferences + secret status). Shell (nav + /health + dark mode).
  Preview pages for Cases/Chat/Investigate/Scans/Standup/Cost.
- Tests: npm install clean; npm run build (tsc --noEmit strict + vite build) green,
  no type errors (orchestrator re-verified: 2319 modules, dist built). No browser
  run (CDNs blocked) — static build + tsc is the verification.
- Status: done — wizard + sources + settings functional; analytics surfaces are
  preview stubs.
- Next: port analytics surfaces in depth; serve dist/ from backend or reverse
  proxy; improve /api/connectors/test to test UNSAVED form values (see below).

### 2026-06-21 01:00Z — orchestrator — webui build verification + commit
- Context: Verify + land the standalone SPA the sub-agent built.
- Did: re-ran `npm run build` (strict tsc + vite) → green; committed webui/ (WIP
  snapshot earlier as ccc1aa9, finalized here); node_modules/dist git-ignored.
- Tests: webui build green; backend suite unaffected (192).
- Status: done. Standalone UI is the primary front door (Kibana plugin retiring).
- Next: improve POST /api/connectors/test to accept unsaved {source_type,config,
  secrets} and build a throwaway connector (better wizard "Test connection" UX),
  then Epoch A (StateStore → Postgres + pgvector).

### 2026-06-21 — backend agent (statestore) — Epoch A: SQL StateStore
- Context: Decouple the suite's OWN state (cases/audit/usage/config/cursor/RAG)
  from Elasticsearch so self-hosting needs no ES; keep ES default; only management
  state moves — the read-only log surface stays on the connector layer.
- Did: repository ABCs (app/stores/base.py) mirroring the existing store
  signatures; ES stores + AuditLogger subclass them. SQLAlchemy 2.x async SQL
  backend under app/stores/sql/ (engine factory, ORM tables cases/audit/usage/kv/
  rag_chunks, Sql{Case,Audit,Usage}Repository + SqlKVStore/SqlConfigStore/
  SqlCursorStore + SqlVectorStore). Audit INSERT-only (preserves #2). Secrets
  state_backend + state_db_url. state.py _build_state_backend() selects ES vs SQL
  from one async engine; SQL startup create_all + SKIP bootstrap_indices; _build_rag
  → SqlVectorStore on SQL; shutdown disposes the engine; es kept for the log
  surface. bootstrap_indices guarded for non-ES backends. asyncpg/pgvector lazy
  (postgres only). Added sqlalchemy/aiosqlite (dev) + sqlalchemy/aiosqlite/asyncpg/
  pgvector (prod) to requirements.
- Tests: pytest 216 passed (192 existing + 24 new), SQLite only, no postgres/
  asyncpg installed. test_state_store_sql.py (case round-trip/list filters+total/
  sort/find_open_by_signature/count_new_scans; append-only audit + ordered search;
  usage window summary; KV/config/cursor; SqlVectorStore cosine/upsert/dim-mismatch)
  + test_state_backend_e2e.py (AppState boots on sqlite, poll→investigate→persist
  case to SQL, ES kept for logs). Orchestrator reviewed SqlAuditRepository (append-
  only confirmed) + wiring; full suite re-verified green.
- Status: done. A self-hosted deploy can now run on Postgres with NO Elasticsearch
  for the app's own state.
- Next: document TLSOC_STATE_BACKEND/TLSOC_STATE_DB_URL (ENVIRONMENT/DEPLOY) +
  surface the selector in the wizard; real-Postgres integration test in a deploy
  session (pg deps blocked in sandbox).

### 2026-06-21 — orchestrator — Epoch C: Wazuh connector + per-source field mapping
- Context: Complete the "ELK + OpenSearch + Wazuh" story; first third-party
  (non-ECS) connector proves the connector abstraction.
- Did: Added per-source field-mapping to the Elastic connector family —
  `ElasticConnector._effective_prefs(prefs)` overlays the source's `config`
  field-mapping/scope keys (data_view_pattern/time_field/*_field/severity_threshold/
  in_scope_rules/excluded_rules) onto the global prefs; applied at the top of
  poll/search/fetch_by_ids/to_ocsf/test_connection (empty config → returns prefs
  unchanged → byte-identical legacy behaviour). New app/connectors/wazuh.py
  (WazuhConnector(ElasticConnector), source_type=WAZUH; manifest with Wazuh indexer
  connection fields + Wazuh alert-schema config defaults: wazuh-alerts-*,
  timestamp, data.srcip, data.srcuser, agent.name, rule.id, rule.description,
  rule.level). Registered in the registry; state._build_log_source now passes
  primary.config to the connector and handles WAZUH/OPENSEARCH/ELASTICSEARCH.
  .env.example documents TLSOC_STATE_BACKEND/TLSOC_STATE_DB_URL.
- Tests: +tests/test_connector_wazuh.py (5: poll extracts Wazuh schema; to_ocsf
  entity mapping; search filters by data.srcip + KQL; manifest/registry; overlay
  no-op-when-empty + applied). Full suite 221 passed (216 + 5).
- Status: done. Three sources live (ELK, OpenSearch, Wazuh); per-source field
  mapping works.
- Next: deep UI surface port (Cases/Chat/Investigate/Scans/Standup/Cost beyond
  previews) + serve dist/ from backend; standup-aggregation + routes entity-path
  onto the connector; ENVIRONMENT/DEPLOY prose for the state backend; pre-save
  /api/connectors/test; Epoch E scale-out.

### 2026-06-21 — docs agent (readme) — README rewrite + CHANGELOG vendor-agnostic entry
- Context: Refresh docs for the vendor-agnostic transition ahead of first deploy.
- Did: Full README rewrite (agnostic positioning, source→connectors→OCSF→funnel→
  case→webui diagram, feature list, agnostic-compose quick start, connectors table,
  repo layout incl. ocsf/connectors/receivers/stores-sql/webui, honest pull-vs-push
  limits, doc links). CHANGELOG [2.0.0] entry (OCSF, connector SPI+registry, ELK/
  OpenSearch/Wazuh pull, 16 receivers + /api/ingest, per-source secrets, wizard
  backend, SQL StateStore, standalone webui, deploy artifacts, plugin→legacy).
  Verified endpoints/enums/paths/test-count against source.
- Tests: n/a (docs). 221 backend green per prior runs.
- Status: done.
- Next: trim the legacy plugin section once webui surfaces are fully ported.

### 2026-06-21 — docs agent (deploy) — DEPLOY.md rewrite (agnostic + legacy)
- Context: Make DEPLOY.md accurate for the vendor-agnostic stack ahead of deploy.
- Did: Rewrote DEPLOY.md — Mode A (agnostic: deploy/docker-compose.agnostic.yml,
  postgres+pgvector/redis/backend STATE_BACKEND=postgres/webui:8080, .env, wizard
  walkthrough, PULL vs PUSH sources, 16 receivers + optional pip deps, /api/ingest
  + /api/sources/{id}/secrets curl, syslog port publishing, verify); state-backend
  matrix; secrets model; ops (pg_dump/ES-snapshot backups, upgrades); Mode B
  (legacy ELK merge + two scoped ES keys + plugin install); hardening. Env-var
  nuance (backend reads UNPREFIXED names; compose maps TLSOC_*) stated. Orchestrator
  stripped a stray journal entry the agent had appended into DEPLOY.md.
- Tests: n/a (docs). Commands cross-checked against the real artifacts.
- Status: done.

### 2026-06-21 — docs agent (env/compat/claude) — vendor-agnostic doc refresh
- Context: Align ENVIRONMENT.md, COMPATIBILITY.md, CLAUDE.md with the agnostic
  transition (OCSF, pluggable connectors, selectable state backend, standalone
  webui primary / Kibana plugin legacy).
- Did: COMPATIBILITY.md = matrix (state backends ES8/PG15-16+pgvector/SQLite; pull
  Elastic/OpenSearch/Wazuh + 16 receivers w/ requires_pip; OCSF 1.4.0; Py3.11/
  Node22; plugin legacy). ENVIRONMENT.md both envs (webui toolchain, pytest=221,
  SQL offline on SQLite, TLSOC_*→backend env mapping table, per-source secrets).
  CLAUDE.md §1/§3/§4/§6/§7/§10 updated (agnostic framing, connectors/ocsf/stores-sql/
  webui in layout, 49→221 reconciled, Epoch A/B/C/D status), additive OCSF-unmapped
  note under #9; PRESERVED the Journal mandate, §5 non-negotiables, §9, Journal format.
- Tests: backend 221 passed; webui build clean.
- Status: done.

### 2026-06-21 — docs agent (usage/ops/security) — usage/ops/security/contrib refresh
- Context: Refresh the usage/ops/security/contrib docs for the agnostic suite.
- Did: docs/USAGE.md (standalone UI + wizard, managing pull/push sources, API curl
  examples incl. /api/connectors, /api/sources, /api/sources/{id}/secrets,
  /api/ingest); docs/TROUBLESHOOTING.md (Postgres/pgvector, connector test failures,
  webhook 401, optional-dep ConnectionError, syslog ports, UI build, no-cases);
  docs/RUNBOOK.md (state-backend ops + pg backup/restore, receiver lifecycle, key
  rotation, kill switch/budget, scaling); SECURITY.md (per-source secrets, read-only
  source creds generalised, webhook HMAC/bearer + untrusted push payloads, OCSF
  unmapped fencing, state-backend security, TLS reverse proxy); CONTRIBUTING.md
  ("Writing a connector" via the SPI + manifest + entry-point, updated layout);
  webui/README.md (dev/build + Docker/nginx production serving).
- Tests: n/a (docs); cross-checked endpoints/paths against source.
- Status: done.

### 2026-06-21 — orchestrator — research roadmap + UI overhaul (pass 1)
- Context: User asked to (a) research agentic-AI/SOC open-source platforms for what
  to add next, and (b) overhaul the "ugly" webui.
- Did (research): ran parallel sub-agents over open-source agentic SOCs (Vigil,
  AiSOC, FunnyWolf, SecurityClaw, SocTalk, Tracecat, Nemesis), agentic-AI
  frameworks/patterns (LangGraph HITL/streaming/checkpointing, Langfuse/OpenLLMetry,
  DeepEval/promptfoo, Mem0, LlamaFirewall, prompt caching), detection-engineering AI
  (pySigma/SigmAIQ/Uncoder/SigmaGen, CTI-REALM/CyberSOCEval benchmarks), and a
  codebase gap analysis. Wrote docs/ROADMAP_RESEARCH.md. CRITICAL finding: the
  FastAPI API has NO auth and the webui→nginx→backend path is open (old model
  assumed Kibana session) — flagged as #1 priority.
- Did (UI pass 1): new design-system foundation — charts.tsx (SVG donut/barlist/
  sparkline/minibars/gauge), Card+TrendStat primitives, index.css polish, branded
  Shell (logo/wordmark/grouped nav/health), new Overview dashboard as the default
  landing. webui build green. Committed e319849.
- Tests: webui `npm run build` green (tsc+vite). Backend untouched.
- Status: research done; UI pass-1 foundation shipped; UI pass-2 (Case detail
  flyout + Chat/Investigate/Scans/Standup/Cost) in progress via 3 sub-agents.
- Next: integrate UI pass-2, full build, commit; then (per roadmap) API auth is the
  top backend priority.

### 2026-06-21 — orchestrator — UI overhaul pass 2 (surfaces)
- Context: Turn the preview stubs + dead-end Cases table into real, polished
  surfaces on the pass-1 design kit (3 parallel sub-agents, disjoint files).
- Did: Case-detail flyout (CaseDetailFlyout.tsx — verdict/evidence/MITRE deep
  links/risk-breakdown bars/RiskGauge + Agent-trace timeline via /cases/{id}/trace
  + merged history timeline + sticky lifecycle action footer) and clickable Cases
  page w/ status filter; Chat console (bubbles, result tables, query/cost
  footnotes, suggested prompts, typing indicator); Investigate form → rich Case
  result card + neutral no-events empty state + session history; Scans card grid +
  KPIs; Standup hero digest + guarded aggregate tiles/barlists; Cost dashboard
  (window selector, sparkline/minibars, by-model/role/surface charts). All build
  on common/ui + charts + theme + format + soc* CSS; no kit files changed.
- Tests: full webui `npm run build` green (tsc strict + vite, 2322 modules). Note:
  JS bundle ~2.0MB (570KB gz) — fine for an internal console; code-split later.
- Status: done. UI is materially better (branded shell, dashboard, drill-in,
  charts).
- Next: per docs/ROADMAP_RESEARCH.md — API auth (#1), then observability + prompt
  caching + notifications. Optional UI follow-ups: open Case-detail from Overview/
  Scans cards; bundle code-splitting.

### 2026-06-21 — orchestrator — Vigil deep-study + overhaul kickoff
- Context: User asked to (1) study github.com/Vigil-SOC/vigil end-to-end with a
  fleet of Opus sub-agents, (2) propose + execute a heavy architectural overhaul of
  our suite taking inspiration from Vigil (multi-agent, runbooks, RAG), and (3)
  archive the legacy Kibana plugin now that we're vendor-neutral.
- Did (recon): cloned Vigil (11M, v0.2.3) + its mempalace (77M, memory/RAG) and
  mcp-servers submodules to /tmp. Mapped it: 339 py / 79 tsx; pillars = Agents
  (services/soc_agents.py + claude_service.py 4156 LoC + daemon/agent_runner.py),
  Workflows (markdown WORKFLOW.md + orchestrator/plan_generator), MCP+tools+skills,
  LLM gateway/router/cost/budgets (+ Bifrost), daemon/federation/autonomy, mempalace
  RAG. Stack: claude-agent-sdk + anthropic (NOT LangGraph), heavy MCP, Postgres.
- Tests: n/a yet (recon only).
- Status: in-progress — launching parallel Opus research sub-agents over Vigil + a
  fresh map of our own repo.
- Next: synthesize findings → recommendations → archive plugin → overhaul.

### 2026-06-21 — orchestrator — Vigil study done; plugin archived; Wave-1 begins
- Context: 10 Opus sub-agents finished reading Vigil end-to-end (agents, workflows,
  MCP/tools/skills, LLM/cost, daemon/federation/autonomy, RAG/mempalace, data model,
  frontend, architecture/philosophy) + a fresh ground-truth map of our own repo.
- Did: (1) wrote docs/VIGIL_STUDY.md — full synthesis, subsystem-by-subsystem
  Vigil-vs-us verdicts, ranked port list, anti-patterns, 4-wave overhaul plan.
  (2) Archived the legacy Kibana plugin: `git mv plugin → archive/kibana-plugin`
  (45 files, history preserved) + archive/README.md explaining the freeze (we're
  vendor-neutral; webui is the sole primary surface). (3) Established a GREEN test
  baseline: created backend/.venv, installed requirements-dev, `pytest -q` = 221
  passed before any code change.
- Tests: baseline pytest 221 passed.
- Status: in-progress — starting Wave 1 (agent personas · plain-text runbooks ·
  hybrid RAG · tool safety tiers · stronger fencing + pricing provenance).
- Next: implement Wave 1 additively, keep pytest + webui build green, then commit.

### 2026-06-21 — orchestrator — Wave-1 overhaul shipped (personas · runbooks · hybrid RAG)
- Context: Implement the Vigil-inspired overhaul the user named (multi-agent,
  runbooks, RAG) additively on our spine, keep everything green.
- Did:
  - **Multi-agent roster**: `agents/personas.py` (`AgentPersona` registry +
    deterministic `select_persona`); investigator composes the persona addendum
    (`prompts.build_investigator_system`); persona threaded through `graph.run_
    investigation` + `pipeline`; recorded on `Case.agent_persona` + audit; `GET
    /api/personas`; badge on the webui case-detail flyout.
  - **Plain-text runbooks**: `engine/runbooks.py` (dep-free frontmatter parser +
    loader + `select_runbook`) + 7 seed `runbooks/*.md`; matched runbook injected as
    TRUSTED guidance via `render_cluster(runbook=...)` and indexed into RAG
    (concise descriptor); `GET /api/runbooks`; `RunbookConfig`.
  - **Hybrid RAG**: drawer-floor-first vector + dep-free BM25 re-rank in `tools/rag.py`
    (`_hybrid_rerank`); `RagConfig.hybrid/vector_weight/bm25_weight/overfetch`.
  - **Tool tiers**: `constants.ToolTier` + `tools/base.Tool.tier`; investigator gates
    non-safe tools (propose, never execute).
  - **Hardened fencing + provenance**: `fence()` escapes forged close-markers + adds
    source/tool tags; `pricing.pricing_source` (+ tier heuristic) onto `UsageDoc`.
  - Archived the Kibana plugin (`git mv plugin → archive/kibana-plugin`) + archive
    README. Wrote `docs/VIGIL_STUDY.md`. Refreshed CLAUDE.md / ROADMAP / CHANGELOG.
  - Added `tests/test_vigil_wave1.py` (23 tests) covering all of the above.
- Tests: `pytest` **244 passed** (was 221); webui `tsc --noEmit` clean; `vite build`
  clean (2322 modules). Baseline was green before changes.
- Status: done (Wave 1). All 12 non-negotiables intact; spine (cost_gate /
  case_manager / durable cursor / OCSF / one gateway) untouched.
- Next: Wave 2 — auth-by-default + CI route-coverage test (the #1 gap) +
  CSRF/headers/rate-limit; approval workflow + pre-flight projected-cost gate +
  $-budget. See docs/VIGIL_STUDY.md §5.

### 2026-06-21 — orchestrator — Wave 2: Markdown playbooks + optional auth (+AutoClosePolicy)
- Context: User approved Wave 2 ("but ensure the old version without auth is also
  available") + supplied a detailed brief for a Markdown playbook/workflow system
  (single-agent, deterministic selection, injection, AutoClosePolicy refactor).
- Did (sub-agent fleet, disjoint files; orchestrator owned all shared-file
  integration + the safety-critical refactors):
  - **Playbook engine** (`app/playbooks/{manifest,loader,registry}.py`): strict
    `PlaybookManifest`, dep-free front-matter (reuses engine.runbooks.parse_frontmatter),
    deterministic `select_playbook` (rule_ids/entity_types/min_event_count hard;
    mitre/tags advisory — clusters carry no MITRE pre-investigation), atomic
    validate-then-swap reload. 3 seed playbooks in `backend/playbooks/`.
  - **Injection**: matched playbook → distinct `<<<PLAYBOOK>>>` TRUSTED block in
    render_cluster, separate from fenced UNTRUSTED evidence + a PRECEDENCE line in
    INVESTIGATOR_SYSTEM; `rag_queries` augment retrieval (bounded by top_k, deduped);
    selection/fallback audited; `Case.playbook_id`. Pipeline/graph/investigator
    threaded; Wave-1 runbook injection retired (runbooks = RAG knowledge only).
  - **AutoClosePolicy** (`case_manager.decide` pure over policy): per-verdict-class
    enable/min-confidence/max-risk/objection-window; FP on above a bar; TP opt-in
    (default OFF); NEEDS_HUMAN never (code-enforced); `fp_auto_close` migrated.
  - **Optional auth (default OFF — old no-auth version preserved & default)**:
    `app/auth/` (PBKDF2 + stdlib HS256) + `app/middleware/` (headers/csrf/ratelimit);
    router-level `require_auth` (no-op when off) + tiny PUBLIC allowlist (normalised
    path, tight ingest regex); `/api/auth/{login,me,logout}`, `/api/playbooks*`;
    CI route-coverage test. webui: login gate (no-op when off) + Playbooks/Agents catalog.
  - **2 review sub-agents** (auth-security, playbook-safety): playbook = ship-ready
    (all 7 invariants hold); auth = 1 HIGH (prefix not normalised) + MEDIUM/LOW.
    Applied fixes: normalised path + tight ingest regex; `auth_cookie_secure`;
    rate-limit default OFF + XFF only when trusted; real full-iteration timing
    dummy; PLAYBOOK-marker neutralisation in fence(); atomic state.reload_playbooks();
    CI test hardened (no Mount/WS under /api; ingest regex tightness). Docs:
    SECURITY.md auth section, .env.example, playbooks/README note, CLAUDE/CHANGELOG/ROADMAP.
- Tests: `pytest` **302 passed** (was 244 → +playbook/auth/wave2/coverage suites);
  webui `tsc + vite build` clean. All 12 non-negotiables hold (#3 generalised to the
  policy model — documented).
- Status: done (Wave 2 core). Deferred (noted): approval workflow + pre-flight
  cost projection + $-budget; webui CSRF token wiring.
- Next: Wave-2 leftovers above, then Wave 3 (memory/KG, MITRE-from-STIX, HITL UI).
