# ROADMAP.md — live work tracking

> **New here? Start with [`docs/HANDOFF.md`](docs/HANDOFF.md)** — the START-HERE
> onboarding doc (run commands, current status, what's done, what's next).

Status legend: ☐ todo · ◐ in-progress · ☑ done. Update this + `Journal.md` as you
work. The webui is the primary surface (Vite + React + **Tailwind + shadcn/radix**;
the Kibana plugin is archived). Every item ends with: `pytest -q` green (keep the
count current), webui tsc+vite + Vitest clean, **#3 `decide()` byte-identical**,
docs + Journal updated, commit + push.

**Current baseline (branch `Testing`, local — NOT pushed):** backend **794 pytest**
green · webui build clean (tsc+vite) · **86 vitest** green (19 files) · eslint **0
`react-hooks/rules-of-hooks` errors** · `engine/case_manager.py` **byte-identical** ·
**zero new runtime deps**. Round 1 + Round 2 (incl. the adversarial audit +
remediation) are **complete and committed**.

## Next — post-Round-2 backlog

Two tracks, both scoped in `docs/research/2026-06-round2/`:

**A. Deferred / low (from the audit — `ROUND2_AUDIT.md`):** session-KV optimistic
concurrency · multi-generation refresh-reuse detection · ES-only `CONFIG_INDEX`
nested-type collision · deep-link breadcrumb (cosmetic).

**B. Best-of-best Tier 2/3 (`ROUND2_BEST_OF_BEST.md`).** Round 2 already shipped the
whole Tier-1 productivity tier EXCEPT API keys: **saved views** (W7b), **bulk case
actions** (W7c), **Cmd-K command palette** (W7c), **global search** `GET /api/search`
(W7c), and the **audit-log viewer** `GET /api/audit` (W7c). Remaining, in recommended
order:

- ☐ **API keys / tokens management UI** (Tier-1 #5) — scoped, revocable keys on the
  existing JWT/PBKDF2 auth (prefix + last-used); the vendor-agnostic open-API
  requirement. Builds cleanly on the W3 SessionStore + token model.
- ☐ **SLA timers** (Tier-2 #8) — per-severity `sla_due_at`/`sla_state`, at-risk badge +
  filter (display + filter only, NO enforcement of `decide()`); pairs with saved views.
- ☐ **Watchlists** (Tier-2 #10) — VIP users / crown-jewel assets / known-good IPs as
  TRUSTED operator context boosters in correlation/risk + a triage chip; matched log
  values stay UNTRUSTED (#9). Extends the HITL suppression/asset proposals.
- ☐ **Dashboards builder** (Tier-3 #11) — user-composed shareable widget grid over
  `/api/metrics` + the cost ledger; org publishes a default, users clone into
  `UserPrefsStore` (W7b). `react-grid-layout` is a NEW dep — vet against no-new-deps.
- ☐ **Scheduled reports** (Tier-3 #12) — cron MD/PDF digests via the standup
  aggregator → existing notification channels (reuses aggregate-then-summarise, #7).
- ☐ **Hunting / saved-query builder** (Tier-3 #13) — named reusable read-only queries
  over sources (Stellar Query-Library parity); builds on the `es_query` tool +
  per-source browse.

Each ends with: `pytest -q` green (keep the count current), webui tsc+vite + Vitest
clean, **#3 `decide()` byte-identical**, additive + zero new runtime deps where
possible, docs + Journal updated, commit + push.

## Shipped (Phase 1)
- ☑ Backend spine + 5 surfaces + tests (49 green); both plugin zips; full docs.
- ☑ 8.19.12 plugin build (legacy `kibana.json`, Node 22.22.0, import-alias port).
- ☑ CLAUDE.md, Journal.md, docs/ENVIRONMENT.md, this ROADMAP.

## Progress (this cycle, newest first)
- ☑ **Round 2 — 7 waves (W1–W7c) + audit/remediation** (branch `Testing`; **794
  backend tests green** (649→772 across the waves, then →794 with the audit
  remediation) + webui tsc/vite clean + **86 Vitest** green; **additive, zero new
  runtime deps, #3 `decide()` byte-identical** — Demo Mode uses a sandboxed policy
  copy — and #9 untrusted-fencing held on every new user/source-influenceable field).
  Design + audit: `docs/research/2026-06-round2/`.
  - ☑ **Final — adversarial audit + remediation** — a 16-agent audit fleet
    (`ROUND2_AUDIT.md`) → 8 confirmed RBAC/poller/gauge fixes (`aae7a76`) + a
    HIGH/MEDIUM remediation pass (`763ded9`, +22 tests: #4 feed-cursor starvation,
    demo-chat isolation, env single-admin token-version lockout, `set_status→RESOLVED`
    RBAC gap, email `text_safe`/`{{{ }}}`/branding-SVG hardening) and a strengthened
    authZ-coverage CI test (fails if any non-GET `/api` route lacks an authZ gate).
  - ☑ **W1 Bug fixes** — RiskGauge Active-Risk-Index glitch, MFA-QR copy, duplicate
    close X, chat framing, store-degraded UX; presentational + optional additive
    `/api/health.persistent`. No data-model change.
  - ☑ **W2 Login redesign + account self-service** — 2-column split login (the
    existing 4-mode form + handlers verbatim) + self-service profile
    (`display_name`/`alias`/`avatar`/`alt_email`/`timezone`/`locale`/`prefs`) on the
    `User` model (all defaulted → no migration; `User.public()` still hides secrets).
    Avatar validator (png/webp/jpeg data-url, magic-byte sniff, ≤64 KB). Endpoints
    `GET/PUT /api/account/me`, `PUT /api/me/avatar` (env-managed → 400).
  - ☑ **W3 Sessions + access policy** — ACCESS token gains `sid`+`tv`; a KV-backed
    `SessionStore` (`stores/sessions.py`, survives `_wire()`) enforces idle/absolute/
    revocation in the async `require_auth` (NOT the sync `verify()`); refresh rotation
    + replay/theft detection; token policy on Preferences; `require_fresh_auth(window)`
    step-up. Endpoints `POST /api/auth/{refresh,reauth}`, `GET /api/sessions`,
    `POST /api/sessions/{sid}/revoke`, `POST /api/sessions/revoke-others`, admin
    `GET /api/admin/sessions`, `POST /api/admin/sessions/{sid}/revoke`,
    `POST /api/admin/users/{username}/revoke-all`; logout revokes current sid; session
    created at all 3 cookie-set sites (login/mfa/sso).
  - ☑ **W4 Settings IA consolidation** — two-scope (Personal Account / Organization)
    Settings tree; Users/Security/SSO + Profile/Account/Preferences/Sessions moved INTO
    Settings (RBAC-aware); standalone admin rail group dropped; near-duplicate pages
    folded into tabs (Investigate→Chat segmented control [ONE chat engine]; Cost→Metrics;
    Standup→Overview) under ≤5 nav groups. Pure IA; no new endpoints.
  - ☑ **W5 Demo Mode + Experimental Settings** — reversible tenant state
    (`off|seeded|live`) on `Preferences.demo`; `DemoPullConnector` (`connectors/demo.py`)
    feeds seeded OCSF (`engine/demo_generator.py`) through the REAL pipeline but writes
    to a SEPARATE in-memory store + a deterministic mock LLM (`engine/demo_runtime.py`)
    — **$0, isolated, one-flip reversible**; FP runs the REAL `decide()` against a
    SANDBOXED policy copy, NEEDS_HUMAN stays open. Endpoints `POST /api/demo/{enable,
    reset,disable}`, `GET /api/demo/status` (admin); DemoBanner + `SAMPLE` badges +
    "(simulated)" cost.
  - ☑ **W6 Source multi-feed** — `IndexPattern`→richer per-feed model (wire key kept) +
    new `ignore` role + per-feed query/field-mapping/`message_field`/`severity_floor`/
    schedule; overloaded `auto_correlate` split into `correlate`+`auto_investigate`
    (behavior-preserving migration); per-feed durable cursor (`{source.id}:{feed.id}`,
    fast vs slow never skip, #4); `severity_floor` blocks auto-forward but NEVER drops
    a candidate (#4). Loose JSON, no migration; `/api/sources` round-trips it.
  - ☑ **W7a Email — Resend + SES + templates** — `ResendChannel`
    (`notifications/resend.py`, HTTPS API, idempotency, retry-only-429/5xx) + an SES
    SMTP preset with an IAM-key→SMTP-password HMAC ladder in `notifications/email.py`;
    stdlib mustache-subset renderer (`notifications/templates.py`, auto-escape +
    `header_safe`/`text_safe`) + 5 preloaded overridable templates;
    `POST /api/notifications/preview?trigger=`.
  - ☑ **W7b Per-user customization** — org Preferences + per-user `UserPrefsStore`
    (`stores/user_prefs.py` over KV; `'default'` when auth off); saved views, table
    column state, terminology overrides, theme. Endpoints `GET /api/prefs/effective`,
    `GET/PUT /api/prefs/user`, `GET/PUT /api/prefs/org` (admin), `GET/POST /api/views`,
    `PUT /api/prefs/user/tables/{table_id}`, `GET/PUT /api/terminology` (PUT admin).
  - ☑ **W7c UX — command palette + global search + bulk actions + audit viewer** —
    Cmd-K palette + global search (`GET /api/search`), multi-select bulk case actions,
    audit-log viewer (`GET /api/audit`).
- ☑ **SOC overhaul — 7 waves (W1–W7)** (branch `Testing`; **649 backend tests green**
  (395→481→527→554→571→600→638→649) + webui tsc/vite clean + **27 Vitest** green;
  **additive, zero new deps, non-negotiable #3 `decide()` byte-identical, auth DEFAULT OFF**):
  - ☑ **W1 Identity** — persisted multi-user (`stores/users.py` over the KV doc store,
    no new index/table) + **6-role RBAC** (super_admin/soc_manager/analyst_tier2/
    analyst_tier1/responder/auditor) + permission matrix + `require_permission` deps +
    React `<Can>` guards; OOBE first-run; seed **Admin/Admin@123** (super_admin) when
    auth enabled. (481)
  - ☑ **W2 MFA + SSO** — stdlib **RFC-6238 TOTP** (vs the official vectors) + inline-SVG
    QR + single-use recovery codes + two-phase login (`auth/mfa.py`,
    `/api/auth/mfa/*`); **OIDC SSO** Google/Microsoft/generic via server-side
    code-exchange + userinfo + group→role provisioning (`auth/oidc.py`,
    `/api/auth/sso/*`). (527)
  - ☑ **W3 Cases** — extended `CaseStatus` (NEW/INVESTIGATING/ESCALATED/ON_HOLD/RESOLVED,
    keeps open/needs_human/closed) + `Disposition` taxonomy + lifecycle actions +
    transition guard + `status_history`; **`decide()` byte-identical**; customizable
    `case-XXXX` nomenclature (`engine/case_id.py` template + KV sequence + preview). (554)
  - ☑ **W4 Notifications** — pluggable `NotificationChannel` + email (stdlib SMTP, 13
    presets) + Slack/Teams/webhook/PagerDuty/Telegram; per-condition triggers +
    dedup/rate-limit/digest; fire-and-forget after `apply()`+save; channel secrets in
    the secret tier (`notifications/`, `/api/notifications/*`). (571)
  - ☑ **W5 Multi-source** — Auto-Correlate toggle per source AND per sub-source
    (`IndexPattern`); opt-in cross-source correlation linking RELATED cases by shared
    entity (ip/host/user/file_hash/domain); per-source mapping overrides + connector
    `setup_help` + `HelpTip`s + analyze-sample. (600)
  - ☑ **W6 Automation + Threat-context** — **#3-safe** threshold automation
    (`engine/threshold_automation.py`: tag/recommend/notify/run_playbook/request_approval
    → HITL proposal; **never sets status**); run-a-playbook (context-only
    re-investigation); threat-context panel (`engine/threat_context.py`: IOC reputation
    + bundled **MITRE ATT&CK 697 techniques** in `threat/` + related cases, fail-open);
    resolved-case → RAG knowledge loop. (638)
  - ☑ **W7 Settings + UI** — consolidated Settings (13 sections / 4 nav groups) +
    `GET /api/settings/schema`; RiskGauge redesign (fixes Active-Risk-Index glitch);
    skeleton/shimmer loading + staggered reveals; 8px grid; WCAG AA. (649)
- ☑ **Browse a source's logs + read-only Test-connection & per-source TLS fixes**
  (branch `Testing`; **349 tests green** (+9, `test_browse_and_connection.py`);
  webui clean, no new deps; additive, spine + the 12 non-negotiables intact):
  - ☑ **Browse logs per source:** `GET /api/sources/{id}/logs?limit=&query=&from=&to=`
    (auth-protected) — pull = bounded (≤200) read-only field-mapping/TLS-aware scoped
    search; push = in-memory live-tail ring buffer (≤500/source) in `IngestService`.
    Rows `{ts,source_ip,user,host,rule,severity,message,_raw}`, secrets never
    returned; `capabilities:["browse"]` on pull manifests + auto-applied to receivers.
    webui `SourceLogsFlyout` (table + expandable `_raw`, search, `EuiSuperDatePicker`,
    10s live-tail) behind a capability-gated "Logs" button.
  - ☑ **Read-only Test-connection:** `ElasticConnector.test_connection` runs the
    scoped read first (authoritative); `ping()` is only the extra `cluster_monitor`
    signal. `ConnectionTest` +`mode`/`cluster_monitor`; webui read-only/full success
    callout.
  - ☑ **Per-source TLS:** `AppState.es_client_for_source()` builds a per-source ES
    client honoring `es_verify_certs`/`es_ca_cert`/`es_url`/`es_api_key` (mgmt key
    dropped); used by the primary log source + browse endpoint.
- ☑ **Explainability + RAG management + agent memory + dashboards/collaboration**
  (branch `Testing`; **340 tests green**; webui clean, 2330 modules; additive,
  spine + the 12 non-negotiables intact). Three additive backend features + a webui
  surface pass:
  - ☑ **RAG ingest + management + visibility** ("see the RAG"): `engine/chunking.py`
    (`chunk_text`); `VectorStore` ABC `list_documents/list_chunks/delete_document/
    stats` (InMemory + ES `dense_vector` + SQL); `RagService.import_document/
    list_documents/get_document/delete_document/rag_stats` (seed sources
    `runbook/mitre/suppression/resolved_case` guarded unless `force=true`); routes
    `GET /rag/stats`, `GET /rag/documents`, `GET /rag/documents/{id}`,
    `POST /rag/import`, `DELETE /rag/documents/{id}?force=`, `GET /rag/search`.
    `test_rag_management.py` (11).
  - ☑ **Agent memory (Claude.ai-style durable operator facts):** `stores/memory.py`
    `MemoryStore` over the existing KVStore (no new index/migration; `EsKVStore` /
    `SqlKVStore` adapters), `MemoryEntry` model; injected into investigations + chat
    as a DISTINCT `<<<MEMORY>>>` TRUSTED block (precedence
    policy>base>playbook>MEMORY>untrusted; `fence()` neutralises forged markers);
    never overrides the deterministic CaseManager. Edit via REST
    (`GET/POST/PUT/DELETE /memory`, human) or chat ("remember:"/"forget", agent,
    audited); chat gained `memory_action` + `memory_suggestion`.
    `test_memory.py` (14).
  - ☑ **Case explainability:** `ActionType.CONTEXT` audit record (persona/playbook/
    memory/knowledge/enrichment) + reasoning excerpt on VERDICT; `GET /cases/{id}/
    rationale` returns the pure "why" object incl. the DETERMINISTIC
    `decision_rationale`. `test_explainability.py` (5).
  - ☑ **webui:** new **Knowledge** + **Memory** pages (new Platform nav); case
    **"Why"** tab; chat memory action/suggestion UI; Metrics "Knowledge base &
    memory" section + Overview RAG/memory tiles; Cases-list collaboration (sortable
    assignee, tags + comment-count badges, filters). UNTRUSTED-safe (#9); no new deps.
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
  - ◐ Wave-2 leftovers: approval workflow ☑ DONE (HITL `Proposal` + admin approve;
    extended by W6 threshold `request_approval`). Still ☐: pre-flight projected-cost
    gate + `$`-budget ceiling.
- ☑ **Vigil-inspired overhaul — Wave 1** (additive, spine intact; 244 tests green;
  webui clean). Multi-agent persona roster (`agents/personas.py`, `GET /personas`),
  plain-text runbooks (`runbooks/*.md` + `engine/runbooks.py`, `GET /runbooks`),
  hybrid BM25+vector RAG (`tools/rag.py`), tool safety tiers (`ToolTier`), hardened
  fencing + `pricing_source` provenance. Legacy Kibana plugin archived →
  `archive/kibana-plugin/`. Full study + multi-wave plan in `docs/VIGIL_STUDY.md`.
  - ◐ **Wave 2:** ☑ CI route-coverage test; CSRF/headers/rate-limit; ☑ auth-on
    profile available (DEFAULT OFF, `TLSOC_AUTH_ENABLED=true` → RBAC/MFA/SSO +
    Admin/Admin@123 seed — SOC overhaul W1/W2); ☑ approval workflow (HITL proposals).
    Still ☐: pre-flight projected-cost gate + `$`-budget ceiling.
  - ☑ **Wave 3:** durable operator memory + case explainability + RAG management/
    visibility DONE. Also DONE via the SOC overhaul: a real bundled **MITRE ATT&CK**
    module (`threat/mitre_techniques.json`, 697 techniques) + **HITL / Auto-Ops webui
    surfaces** (Approvals/Users/Security pages + threshold automation). Still ☐:
    temporal KG + cross-case memory linkage; a detection-rule RAG corpus.
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
- ◐ **Epoch D — Standalone web UI.** DONE: `webui/` Vite+React+TS SPA (originally EUI,
  later re-skinned to **Tailwind + shadcn/Radix** — the current stack); the
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
