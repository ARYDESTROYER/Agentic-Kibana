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
