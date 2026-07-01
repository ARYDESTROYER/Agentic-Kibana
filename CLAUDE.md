# CLAUDE.md — TLSOC Agentic Triage Suite (master context for all agents)

> **New here? Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first** (where we are, how to
> run it, what's done/next), then this file.
>
> **READ THIS FIRST, EVERY SESSION.** This is the single source of truth for the
> project: what it is, how it is built/deployed, the environment, the rules, and
> the current roadmap. It is written for Claude Code agents (and humans) so any
> fresh session can become productive immediately.
>
> ## ⛔ NON-NEGOTIABLE PROCESS RULE — UPDATE THE JOURNAL
> **Every agent (including the orchestrator) MUST append an entry to
> [`Journal.md`](Journal.md) at the start and end of any work session**, and after
> any meaningful milestone (a feature done, a build produced, a test run, a
> decision, a blocker). The Journal is our shared memory across context resets and
> across sub-agents. If you did work and did not journal it, the work is not done.
> Sub-agents that cannot commit must return their Journal entry in their final
> report so the orchestrator appends it. See the Journal format at the bottom.

---

## 1. What this is

The **TLSOC Agentic Triage Suite** is a **vendor-agnostic** agentic SOC (Security
Operations Center) triage system. It turns raw alert volume into audited,
cost-metered, human-reviewable cases. It was **built next to** the original
TrustLab / IIT Bombay ELK pipeline and still attaches to it cleanly as a
**read-only consumer**, but it is no longer tied to that one stack:

- **Source-agnostic ingest.** Log sources are pluggable **connectors**
  (`backend/app/connectors/`): pull (Elasticsearch/OpenSearch/Wazuh) + 16 push /
  queue / object-store receivers. Every connector normalises native records into
  **OCSF** (`backend/app/ocsf/`), the canonical internal schema.
- **Selectable state backend.** The suite's OWN bookkeeping runs on Elasticsearch
  (default), PostgreSQL+pgvector, or SQLite via `STATE_BACKEND`.
- **Standalone web UI** is the **primary** surface; the Kibana plugin is legacy.

The original upstream pipeline (when attached, we do NOT modify it):
```
rsyslog (omkafka) → Kafka → foss-soc-engine → Logstash → Elasticsearch (all-logs-*) → Kibana
```

Components, loosely coupled:
- **Backend** (`backend/`) — FastAPI + LangGraph. ALL the agentic logic:
  connectors + OCSF normalisation, polling/ingestion, correlation, risk scoring,
  the two-tier LLM investigation, the deterministic case manager, tools
  (es_query/enrich/rag), the single LLM gateway + cost ledger, and the suite's own
  state (ES | Postgres | SQLite) behind a `StateStore` abstraction.
- **Web UI** (`webui/`) — the **primary** surface: a standalone Vite + React + TS +
  Tailwind + shadcn/Radix SPA (the first-run wizard + console), talking to the
  backend via an `/api` proxy. Ships in the agnostic compose stack as `tlsoc-webui`
  (nginx). (EUI was removed in the UI overhaul.)
- **Plugin** (`archive/kibana-plugin/`) — **ARCHIVED (2026-06-21)**: the original
  thin Kibana plugin (React + EUI). Retired into `archive/` when we went
  vendor-neutral (the standalone webui is the sole primary surface). It is no longer
  built, tested, or shipped; see `archive/README.md`. Do NOT develop it; if a site
  truly needs the embedded-in-Kibana experience, revive it from the archive.

Authoritative companion docs (keep them in sync when you change behavior):
`docs/HANDOFF.md` (onboarding — START HERE), `README.md` (overview), `DEPLOY.md`
(deploy), `docs/USAGE.md` (use + examples),
`docs/TROUBLESHOOTING.md` (failures), `COMPATIBILITY.md` (upstream compatibility),
`docs/ENVIRONMENT.md` (environments), `docs/VIGIL_STUDY.md` (Vigil study + overhaul
plan), `ROADMAP.md` (work tracking).

## 2. Target versions

- **The webui (the only surface) targets no specific Kibana version** — it is a
  standalone SPA. The suite connects to Elastic/OpenSearch/Wazuh + 16 push sources
  as data sources, independent of any Kibana.
- When attached to a legacy ELK stack, the compatibility target is Elastic/
  Elasticsearch **8.19.12** (read-only consumer); see `COMPATIBILITY.md`.
- The Kibana **plugin** that used to target 8.19.12 / 8.12.2 is **archived** (see
  `archive/kibana-plugin/`); it is no longer built or version-stamped.

## 3. Architecture (end to end)

```
┌────── PRIMARY surface: standalone Web UI (webui/, Vite+React+Tailwind+shadcn) ─────┐
│ SPA: Wizard · Chat · Investigate · Automated Scans · Standup · Cost · Settings     │
│ api (webui/src/lib) → /api proxy (nginx) ───────────────────────▶ tlsoc-backend    │
└────────────────────────────────────────────────────────────────────────┬──────────┘
  (LEGACY surface) Kibana plugin → core.http /api/tlsoc/{path*}            │
  → server proxy (server/routes/index.ts) → ${backendUrl}/api/{path} ─────┤
┌──────────────────── tlsoc-backend (FastAPI + LangGraph) ─────────────────┴──────────┐
│ SOURCES (SIEM/EDR/queues/object-stores)                                              │
│   → CONNECTORS  pull (Elastic/OpenSearch/Wazuh) · push/queue/object receivers (16)   │
│   → OCSF normalisation (canonical schema)                                            │
│   → poll(durable cursor) / ingest → correlate (det.) → risk (det.)                   │
│   → cost-gate → router (cheap LLM) → investigator (strong LLM, ReAct)                 │
│   → formatter → Case Manager (deterministic close/escalate)                          │
│ tools: es_query (READ-ONLY logs) · enrich (Redis-cached) · rag_retrieve              │
│ single LLM gateway ──▶ usage/cost ledger (every call)                                │
│ StateStore (own bookkeeping): Elasticsearch (tlsoc-agent-*) | PostgreSQL+pgvector |  │
│   SQLite  ── selected by STATE_BACKEND                                               │
└──── read-only key → log surface (e.g. all-logs-*)   ·   own state → StateStore ──────┘
```

Request path detail (memorize it):
- **Primary (webui):** `webui api.get('cases')` → nginx `/api/*` proxy →
  `${BACKEND}/api/cases` → FastAPI route in `backend/app/api/routes.py`.
- **Legacy (Kibana plugin):** `browser TlsocApi.get('cases')` → `core.http GET
  /api/tlsoc/cases` → Kibana route `/api/tlsoc/{path*}` (`server/routes/index.ts`)
  → `fetch(${backendUrl}/api/cases)` (default `http://tlsoc-backend:8088`) → same
  FastAPI route.

**Both proxies forward arbitrary JSON bodies, so additive request fields need NO
proxy change.**

## 4. Repository layout

```
backend/app/
  config.py          Secrets (env-only; incl. STATE_BACKEND/STATE_DB_URL +
                     per-source connector_secrets) + Preferences (UI-editable,
                     incl. sources[] SourceInstance list; Round-4:
                     {threshold_tuning,batch,baseline,campaign} config blocks (all
                     default OFF) + caps.max_concurrent + BrandingConfig.login_*
                     bounded plain-text white-label [validator rejects any `<`, #9];
                     AutomationRule → CaseAutomationRule (alias kept, wire key
                     `threshold_automation` unchanged))
  constants.py       enums (incl. SourceType/IngestMode/CursorKind + OCSF_VERSION),
                     index names, verdict/role/action types, untrusted fences
  models.py          Pydantic data contracts (Case/AuditDoc/UsageDoc/Cursor/
                     RawEvent/...)
  utils.py           dotted_get, time helpers, extract_json, coerce_float, ...
  ocsf/              OCSF canonical schema: model (OCSFEvent + unmapped/raw_data) ·
                     ecs (ECS→OCSF mapping) · generic_to_ocsf
  connectors/        base (Connector/PullConnector/PushReceiver SPI) · registry
                     (built-ins + tlsoc.connectors entry points) · elastic ·
                     opensearch · wazuh · demo (DemoPullConnector — seeded OCSF;
                     registered only when demo.mode != off) · receivers/ (webhook ·
                     syslog · queues · objectstore · formats · common) — 16 push receivers
  es/                base (ABC) · client (real, two-key) · fake (in-memory) ·
                     querybuilder · indices (templates + bootstrap)
  llm/               gateway (THE cost-ledger choke point) · providers (Round-4:
                     cache-token extraction + OpenAI `service_tier='flex'` opt-in +
                     wired `with_retry`) · pricing (Round-4: `claude-opus-4-8`
                     corrected $15/$75 → $5/$25 ctx→1M; cache rates applied — read
                     0.1× / write 1.25×[5m]/2×[1h], batch 0.5×; non-cache math
                     byte-identical) · batch (Round-4: `BatchProvider` SPI — Anthropic
                     Message Batches + OpenAI Batch + flex; results UNORDERED → keyed
                     by `custom_id`, one UsageDoc/result at 0.5× #6)
  tools/             base (MCP-shaped, + ToolTier safety tier) · es_query · enrich ·
                     rag (hybrid BM25+vector retrieval; import/list/get/delete +
                     stats; Round-3 TRUSTED-allowlist fencing — only built-in/verified
                     corpus is trusted, imported docs are fenced UNTRUSTED, #9) ·
                     vectorstore (+ list_documents/list_chunks/delete_document/stats)
  enrichment/        EnrichmentProvider SPI (Round 3): base (ABC + manifest) · registry
                     (built-ins + tlsoc.enrichers entry-point, filtered by toggle+key) ·
                     dispatch (enrich_indicator: type-routed IP/domain/hash/url/email,
                     fail-open, Redis-cached) · aggregate (fuse — default max() byte-
                     identical, weighted fusion opt-in) · providers/ (19 registered
                     classes, +17 new in Round 3: abuseipdb · virustotal · greynoise ·
                     shodan · shodan_internetdb · censys · binaryedge · ipinfo · otx ·
                     pulsedive · spur · xforce · urlscan · hibp · projecthoneypot ·
                     abusech [urlhaus/threatfox/malwarebazaar = 3 classes] · rdap;
                     keyless ones default-on)
  realtime.py        multiplexed SSE EventBus (Round 3): in-process asyncio pub/sub +
                     bounded per-subscriber ring + Last-Event-ID replay + heartbeat;
                     GET /api/events (default OFF; polling is the graceful fallback);
                     frames published AFTER save, never before decide()
  engine/            correlation (multi-strategy + opt-in cross-source linking) ·
                     risk · cost_gate · case_manager (AutoClosePolicy; decide() pure) ·
                     signatures · poller · poller_manager (Round-4: PollerManager IS
                     state.poller — fans out over EVERY enabled PULL source, per
                     {source.id}:{feed.id} cursor + legacy-"primary"-collision guard +
                     per-signature in-flight lock so concurrent sources never dup a
                     case #4; single/zero-source path byte-identical) ·
                     ingest (push/queue → OCSF) · runbooks
                     (RAG-knowledge loader) · chunking · case_id (customizable
                     case-XXXX nomenclature; KV sequence + template) ·
                     metrics (verdict/status mix + Round-3 posture: MTTA/MTTR/dwell
                     p50/p90 from status_history, SLA/aging, period-over-period) ·
                     mitre_coverage (Case.mitre vs the 697-corpus → per-tactic % +
                     ATT&CK Navigator v4.5 layer export) ·
                     shift_report (deterministic attention queue + SLA/aging + workload
                     + deltas for the forward Standup; aggregate-only #7) ·
                     priority (read-time severity/impact/urgency/priority derivation —
                     advisory, never feeds decide()) ·
                     budget (pure pre-flight BudgetGate; over-budget → NEEDS_HUMAN) ·
                     threshold_automation (#3-safe rule actions → HITL proposal) ·
                     threat_context (IOC reputation + MITRE + related cases, fail-open) ·
                     mitre (bundled ATT&CK technique lookup) ·
                     demo_generator (seeded OCSF org+baseline+MITRE storylines) ·
                     demo_runtime (deterministic mock LLM + sandboxed policy — Demo Mode) ·
                     threshold_tuner (Round-4: nightly deterministic auto-tuner —
                     per-rule FP via Wilson-LB + min-samples + EWMA + shadow-eval +
                     bounded +1 correlation-n/severity_floor + audit/rollback; DROPs →
                     HITL Proposal; NEVER imports decide()/risk/signature; default OFF) ·
                     campaigns (Round-4: daily deterministic shared-entity graph →
                     `Campaign` objects, references case_ids only, never re-clusters #4) ·
                     baseline (Round-4: online EWMA/EWMV + 168 hour-of-week buckets +
                     bounded t-digest + modified-z |M|>3.5 + 3×-period warm-up, H=14d;
                     pure producer) · event_detection (Round-4: EVENT-feed cheap-first
                     funnel pre-aggregate→rules→anomaly→batched Haiku detection →
                     candidates re-enter the SAME correlate/decide pipeline #3/#4,
                     #9-fenced, #7 aggregate-only) · forwarding (Round-4: explain_forwarding
                     — read-only auto-forward-gate explainer) · reset (Round-4: tiered
                     cases/sources/factory reset, NEVER wipes env secrets)
  threat/            mitre_techniques.json (bundled ATT&CK, 697 techniques) +
                     refresh_mitre.py + SOURCE.md (data corpus, not live fetch)
  runbooks/          plain-text Markdown runbooks (RAG knowledge corpus)
  playbooks/         Markdown PLAYBOOK engine: manifest · loader · registry
                     (deterministic per-cluster selection + atomic hot-reload)
  auth/              passwords (PBKDF2) · tokens (stdlib HS256 JWT) · service
                     (multi-user + 6-role RBAC + permission matrix + require_permission) ·
                     mfa (stdlib RFC-6238 TOTP + recovery codes) · oidc (Google/
                     Microsoft/generic SSO via code-exchange + userinfo)
  notifications/     channel (NotificationChannel SPI) · email (stdlib SMTP, now incl.
                     an SES preset + IAM-key→SMTP-password HMAC ladder) · webhook
                     (Slack/Teams/generic/PagerDuty/Telegram) · resend (Resend HTTPS
                     API channel) ·
                     dispatch (per-condition triggers + dedup/rate-limit/digest) ·
                     templates (stdlib mustache-subset renderer + 5 preloaded,
                     overridable templates; header_safe/text_safe)
  middleware/        security_headers · csrf · rate_limit (Starlette middleware)
  agents/            prompts · router · investigator · formatter · chat · standup ·
                     graph (LangGraph) · pipeline · common · personas (multi-agent roster)
  stores/            base (abstract repositories — backend-agnostic StateStore) ·
                     cases · usage · config_store · cursor_store · users (UserStore
                     over KV — multi-user, no new index/table) · sessions
                     (SessionStore over KV — sid registry, idle/absolute/revocation,
                     refresh rotation) · user_prefs (UserPrefsStore over KV — personal
                     saved views/columns/terminology/theme, keyed by user) · memory
                     (MemoryStore over the KVStore — durable operator facts;
                     EsKVStore/SqlKVStore adapters, no new index) · proposals ·
                     8 Round-3 KV stores (same zero-migration pattern, no new index/
                     table): case_thread · case_activity · case_tasks (per-case
                     collaboration #4) · inbox (per-user fan-out, ~200/user ring) ·
                     notif_prefs (in-app #8) · custom_roles (#6) · price_overlay
                     (per-model price overrides #9) · shift_handoff (Standup acks +
                     action items #11) · 4 Round-4 KV stores (same zero-migration
                     pattern): tuning (per-rule FP tuning state + rollback) · campaigns ·
                     baseline (per-signature online stats) · batch_jobs (resume-safe,
                     per-`custom_id` retrieved-dedup → exactly-one UsageDoc/result #6) ·
                     2 Round-5 KV stores (same zero-migration pattern): dashboards
                     (per-user custom dashboards) · rule_versions (rule version ledger +
                     rollback) · audit/audit_log (ES-backed) · sql/ (engine ·
                     models · repositories · vectorstore — SQLite/Postgres+pgvector)
  api/               routes (the big UI-contract router; incl. /sources, /auth+/users+
                     /auth/mfa+/auth/sso, /auth/refresh+/auth/reauth, /sessions+
                     /admin/sessions, /account/me+/me/avatar, /demo/*, /prefs/{user,org,
                     effective}+/views+/terminology, /notifications+/notifications/
                     preview, /proposals, /settings/schema, /search, /audit, /branding+
                     /branding/presets; Round-4: acknowledge → INVESTIGATING +
                     GET /api/logs [unified scatter-gather over browse-capable sources] +
                     /cases/{id}/forwarding + /sources/health) + 8 Round-3 per-feature
                     routers (routes_metrics · routes_standup · routes_enrichment ·
                     routes_models · routes_inapp · routes_cases_collab · routes_triage ·
                     routes_roles) + 6 Round-4 routers (routes_tuning · routes_campaigns ·
                     routes_baseline · routes_batch · routes_reset [admin + fresh-auth,
                     tiered, never wipes env secrets] · routes_setup [OOBE first-admin,
                     strong-pw, self-locking]) + Round-5 routers (routes_rules [Detection
                     & Rules editor/versioning] · routes_dashboards [per-user custom
                     dashboards] + routes.py decomposed into domain routers, paths
                     byte-identical; +POST /api/triage/preview-decision [rule Test/Preview
                     that NEVER calls decide()/bills the LLM #3/#6] + typed baseline/
                     campaign/batch config endpoints)
                     mounted in main.py · deps (require_auth + require_permission +
                     require_fresh_auth + custom-role union enforcement + session check) ·
                     state.py (DI hub; exposes enrichment_registry + event_bus) · main.py
backend/playbooks/   operator-authored *.md PLAYBOOKS (+ README) — data, not code;
                     dir overridable via Preferences.playbooks.dir
backend/tests/       offline tests (fake ES + mock LLM; SQL store on SQLite) — green
webui/               PRIMARY surface: standalone Vite+React+TS+Tailwind+shadcn/Radix SPA
  package.json       Node 22; Tailwind + Radix primitives; build = tsc --noEmit && vite build
  src/               main.tsx · styles/theme.css (design tokens + Round-3 allow-listed
                     theme tokens + material chrome vars + Round-5: Radix slate+blue base +
                     3 orthogonal semantic axes severity/status/verdict each token/-fg/-text,
                     MEASURED WCAG-AA both themes, Okabe-Ito+viridis chart ramps, self-hosted
                     Inter+JetBrains Mono) · ui/* (shadcn/Radix primitives) · soc/
                     (App/AppShell/router/nav/theme/auth; Round-5: registry.tsx [the single
                     FEATURES[] registry deriving nav+routes+palette] · rules/* [Detection &
                     Rules home + polymorphic editor + condition builder] · dashboard/*
                     [custom-dashboard builder/grid/widget registry, LAZY react-grid-layout] ·
                     hooks/*; pages/* incl. Users/Security/Approvals/Knowledge/Memory + Round-3
                     Models/Roles/Inbox + Metrics tabs + CaseDetail chips/trace/collab +
                     Round-5 Dashboards.tsx + settings/* data-driven section files [was a
                     2673-line god-file, now a section registry]; components/* incl. Can RBAC
                     guard, MfaSetupCard, QRCode, NotificationsEditor, RiskGauge, palette +
                     Round-3 NavSidebar, NotificationBell, GlassSurface, SettingsGrid/Card,
                     theme-tokens resolver, MitreHeatmap/BurnDownChart, TraceTimeline,
                     CaseThread, EnrichmentProvidersEditor, BrandingEditor + ~15 Round-5
                     shared primitives Field/SegmentedControl/ConfirmDialog/NumberField/
                     LabeledSlider/SecretField/TagInput/IconButton/PageContainer/
                     TimeRangePicker/collapsible/typography) · lib/ (api etc.) · test/
  Dockerfile         nginx image (tlsoc-webui) with the /api proxy
archive/             FROZEN legacy code (not built/tested/shipped) — see archive/README.md
  kibana-plugin/     the retired Kibana plugin (tlsoc_agentic_triage/ + dist/ + BUILD.md)
deploy/              docker-compose.agnostic.yml (Postgres+Redis+backend+webui) ·
                     docker-compose.tlsoc.yml (legacy ELK merge) · mappings/ · dashboards/
docs/                USAGE.md · TROUBLESHOOTING.md · ENVIRONMENT.md · VIGIL_STUDY.md ·
                     HANDOFF.md · research/2026-06-round2/ · research/2026-06-round3/
                     (PROPOSAL.md + IMPLEMENTATION.md) · research/2026-07-round4/
                     (PROPOSAL.md + RESEARCH-SYNTHESIS.md + understand/ maps +
                     IMPLEMENTATION.md) · research/2026-07-round5/ (PROPOSAL.md +
                     DESIGN_STANDARD.md + IMPLEMENTATION.md + AUDIT_FINDINGS.md +
                     RESEARCH_* + understand/ maps)
.env.example  README.md  DEPLOY.md  COMPATIBILITY.md  CLAUDE.md  Journal.md  ROADMAP.md
```

## 5. The 12 non-negotiables (never regress these)

1. Read-only, scoped ES key for the agent's log access; **never** `kibana_system`
   or the `elastic` superuser. Two physically separate ES clients
   (`es/client.py`): `_ro` (read-only `all-logs-*`) and `_mgmt` (`tlsoc-agent-*`).
2. Every agent action audited, append-only (`tlsoc-agent-audit-*`).
3. Verdict from the LLM; **the close/escalate decision is made by deterministic
   code against the operator-configured `AutoClosePolicy`** — never by raw LLM
   output and never by playbook text (`engine/case_manager.py`, `decide()` is a pure
   fn over `(verdict, confidence, risk_score, policy)`). Auto-close is a tunable,
   per-verdict-class policy (enable/min-confidence/max-risk/objection-window):
   FALSE_POSITIVE on above a bar by default; **TRUE_POSITIVE auto-close is an
   explicit opt-in, OFF by default**; **NEEDS_HUMAN never auto-closes (code-enforced,
   not policy-tunable)**. A playbook can recommend but can never change this policy.
4. Durable polling cursor (no skip / no dup); cases idempotent by cluster
   signature (`engine/poller.py`, `engine/signatures.py`).
5. ONE chat engine, two entry points (`agents/chat.py`).
6. 100% of LLM calls through ONE gateway → usage/cost ledger (`llm/gateway.py`).
7. Aggregate-then-summarise (never raw logs to a model) (`agents/standup.py`).
8. Enrichment Redis-cached (`tools/enrich.py`, `cache.py`).
9. Log-derived values are UNTRUSTED DATA in prompts — fenced + labelled
   (`agents/prompts.py`, `UNTRUSTED_OPEN/CLOSE`). Applies to chat context,
   selections, queries — anything attacker-influenceable. The OCSF `unmapped`
   catch-all and `raw_data` (`ocsf/model.py`) carry source-controlled values and
   are treated as UNTRUSTED the same way.
10. Sane defaults; only keys + data scope required to run (`config.py`).
11. Spine first & tested (Gate 1); breadth degrades gracefully (Gate 2).
12. Read-only consumer; upstream untouched; cold-deployable.

## 6. Environment (build/dev sandbox AND deploy target)

See `docs/ENVIRONMENT.md` for the full detail. Summary:

### 6a. This build/dev sandbox (Claude Code on the web)
- Ephemeral container; repo cloned fresh; **commit + push or it's lost.**
- Tooling: `/opt/node22` (Node 22) default on PATH — **fine for the `webui` build**,
  WRONG for the Kibana **plugin** build (use the nvm per-version pin at
  `/opt/nvm/nvm.sh`); Python 3.11 + `backend/.venv`; Docker daemon can be started
  (`sudo dockerd &`) but **image registries are BLOCKED** (docker.elastic.co +
  Docker Hub blobs incl. `pgvector/pgvector` 403) — you CANNOT pull ES/Kibana/
  Postgres images or run any compose stack here.
- Network: `github.com`, `pypi.org`, `registry.npmjs.org`, `nodejs.org` reachable.
  BLOCKED by the egress allowlist: container registries, some Chrome/Playwright
  CDNs (`edgedl.me.gvt1.com`, `cdn.playwright.dev`,
  `playwright.download.prss.microsoft.com`), `ci-stats.kibana.dev` (telemetry).
- **webui (primary surface) builds fully here:** `cd webui && npm install &&
  npm run build` (= `tsc --noEmit && vite build`); no browser/Playwright needed —
  the static `dist/` bundle IS the check.
- **Backend tests run fully offline:** `pytest -q` (fake ES + mock LLM). The SQL
  state backend is testable on **SQLite** (sqlalchemy+aiosqlite) — no Postgres
  needed; asyncpg/pgvector are imported lazily.
- Kibana source checkouts live in `/tmp` (e.g. `/tmp/kibana-8.19`, bootstrapped).
  Keep them warm; `rm -rf` an unused one if disk is tight (~18-22GB free).
- **Consequence:** we verify the webui + plugin builds statically (tsc + vite /
  unzip + manifest checks) and the backend via offline tests; building/running the
  Docker images (agnostic or legacy compose) is a DEPLOY step.

### 6b. Deploy target (separate session) — two shapes
- **Agnostic stack** (`deploy/docker-compose.agnostic.yml`): Postgres+pgvector
  (`tlsoc-postgres`) + Redis + `tlsoc-backend` (`STATE_BACKEND=postgres`) +
  `tlsoc-webui` (nginx, port 8080). **No Elasticsearch for the app's own state;**
  connect SIEM/EDR sources from the wizard.
- **Legacy ELK merge** (`deploy/docker-compose.tlsoc.yml`): `tlsoc-backend`
  (`STATE_BACKEND=elasticsearch`, own state in `tlsoc-agent-*`) joins an existing
  `TLSOCDockerDeploy` stack (`elasticsearch`/`kibana`/`logstash`/`kafka`, 8.19.12,
  TLS via `./certs/`), reaches `https://elasticsearch:9200` by container name,
  mounts `./certs/ca/ca.crt:ro`; logs in `all-logs-*` (wizard default data view may
  be `fosstlsoc-logs-*` — confirm live); legacy plugin zip installed into Kibana.
- Backend env names are **UNPREFIXED** (`ES_API_KEY`/`STATE_BACKEND`/
  `STATE_DB_URL`/…); compose maps `.env` `TLSOC_*` → them (see ENVIRONMENT.md §2.3).
- Global secrets via `.env` (`TLSOC_*`); wizard-pushed global secrets are IN-MEMORY
  only (lost on restart). Per-source connector secrets via the wizard /
  `POST /api/sources/{id}/secrets` — also the in-memory secret tier.

## 7. Build / run / test cheatsheet

```bash
# Backend tests (offline; MUST stay green) — currently 1601 tests (see Journal for the exact per-wave count)
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
python -m pytest -q                         # -> 1601 passed (rises as harden-wave tests land; see Journal)

# Backend run locally (in-memory store, mock LLM if no keys)
uvicorn app.main:app --port 8088

# Web UI build + tests + lint (PRIMARY surface; Node 22 — /opt/node22 is fine)
cd webui && npm install && npm run build   # tsc --noEmit && vite build -> webui/dist/ (entry chunk ~264 kB)
npx vitest run                             # -> 625 passed (see Journal for the current count)
npm run lint                               # 0 errors (4 benign warnings OK; jsx-a11y at error)

# One-command demo (backend :8088 AUTH ENABLED + webui dev :5173; login Admin / Admin@123)
./scripts/run-demo.sh

# Full agnostic stack (DEPLOY target — NOT runnable in this sandbox: images blocked)
cp .env.example .env   # set TLSOC_PG_PASSWORD + at least one LLM key
docker compose -f deploy/docker-compose.agnostic.yml up -d --build   # webui on :8080

# NOTE: the Kibana plugin is ARCHIVED (archive/kibana-plugin/) and no longer built.
# The standalone webui above is the sole supported surface. To revive the plugin,
# see archive/kibana-plugin/BUILD.md — it is a do-it-yourself exercise.
```

## 8. Conventions

- **Python:** `from __future__ import annotations`, type hints, module docstrings,
  Pydantic v2 (`model_dump(mode="json")` for ES writes). Async throughout.
  Never let an LLM/ES/tool error drop an alert → route to NEEDS_HUMAN.
- **TS/React (webui, the only surface):** functional components + hooks.
  Stack is **Vite + React + TypeScript + Tailwind CSS + shadcn-style primitives on
  Radix UI** — **NOT @elastic/eui** (EUI was fully removed in the UI overhaul). NO
  new npm deps without a deliberate decision; the build is `tsc --noEmit && vite
  build`. (The archived Kibana plugin's old `@kbn/*`/EUI conventions no longer apply.)
- **UI design system (the suite's shared look — use it, don't re-roll it):**
  - **Design tokens** live in `webui/src/styles/theme.css` as CSS custom properties
    (dual light/dark "command-center" theme) consumed through Tailwind; semantic
    colours (verdict/status/risk) come from `webui/src/soc/components/palette.ts`.
  - **Low-level primitives** are the shadcn/Radix components under `webui/src/ui/*`
    (`button`, `card`, `dialog`, `select`, `tabs`, `table`, `tooltip`, `sheet`,
    `skeleton`, `popover`, `hover-card`, `badge`, … — wrap Radix, do not fork them).
  - **SOC-domain components** live in `webui/src/soc/components/*`
    (`PageHeader`, `KpiTile`/`StatCard`, `DataTable`, `EmptyState`, `RiskGauge`,
    `CaseHoverCard`, `ChatPanel`, `badges.tsx`, `charts.tsx`, `Can.tsx` RBAC guard,
    `LoadingBar`/`Stagger` motion, `HelpTip`, editors for sources/notifications/
    branding/MFA). Pages are `webui/src/soc/pages/*`; shell/nav/router/theme/auth in
    `webui/src/soc/{AppShell,nav,router,theme,auth}.tsx`. Compose these everywhere so
    the console stays consistent (8px grid, WCAG AA).
- **Backend↔webui contract:** additive request/response fields are safe (the nginx
  `/api` proxy forwards arbitrary JSON). Keep `webui/src/lib/types.ts` in sync with
  `models.py`.
- **Secrets:** env only; UI shows booleans (`configured ✓`) never values.
- **Tests:** add/keep offline tests; `pytest -q` green (1601) + `npm run build` clean
  + `vitest run` (625) + `npm run lint` (0 errors, jsx-a11y at error) before every commit.
  (Counts rise each wave — see `Journal.md` for the exact current totals.)
- **Git:** active branch `Testing`. Commit focused changes; push when asked.

## 9. Sub-agent workflow (how we parallelize)

- Delegate context-heavy or isolated work to Opus sub-agents (builds, tests, docs,
  isolated modules). Give each agent: the exact files, interfaces, acceptance, and
  "run pytest/tsc until green." Sequence agents that touch shared files
  (`models.py`, `config.py`, `routes.py`, plugin `app.tsx`) to avoid edit
  conflicts; parallelize only non-overlapping work.
- Each sub-agent MUST end its report with a **Journal entry** (see format) for the
  orchestrator to append, since sub-agents don't commit.
- The orchestrator owns cross-cutting contracts and integration, reviews diffs,
  runs the final build + tests, commits, pushes, and updates the Journal.

## 10. Current status & roadmap

Current: **Round 1 + Round 2 + Round 3 + Round 4 + Round 5 overhauls COMPLETE**
(committed on `Testing`, local only — **not pushed**). Phase-1 spine + vendor-agnostic
transition + the Vigil-inspired overhaul (Waves 1–3) + the **7-wave SOC overhaul**
(W1–W7) + **Round 2** (account self-service, sessions + token policy, Settings-centric
IA, Demo Mode, source multi-feed, Resend/SES + email templates, per-user customization,
command palette / global search / bulk actions / audit viewer) + **Round 3** (12
requests across Waves 0–4) + **Round 4** (12 requests + 3 confirmed bugs across Waves
0–6 — "fix the logic, fine-tune the product": multi-source poller fix, two-tier
ALERT/EVENT ingestion, adaptive threshold auto-tuning, campaign correlation, entity
baselining, LLM batch/flex + cache pricing, tiered reset + OOBE) + **Round 5**
("UI/UX overhaul + rules customization + custom dashboards + loose coupling": one
cohesive design standard, decluttered Settings + wider dashboard, a full rules-editor
home, per-user custom dashboards, and a registry-driven loosely-coupled shell) all
shipped.

**Round 5 (commits `5ab7c05 → 0e99c76 → 9854c36 → 7c86706 → f50e0b2 → 3e447da →
b661bc8 → 830e836 → d3801f9 → a9e2b49 → 8b91fc0 → 05552c7`) — "UI/UX overhaul + rules
customization + custom dashboards + loose coupling": 9 goals (G1–G9) across Waves 0–9,
additive, `engine/case_manager.py` `decide()` BYTE-IDENTICAL vs the pre-Round-5 baseline
`27f0983` (#3 held throughout), all API paths byte-identical, the 12 non-negotiables
held (esp. #2/#3/#6/#9/#10):**

- **G1 cohesive color scheme** — a Radix slate+blue base + **3 orthogonal semantic axes**
  (severity / status / verdict), each split into `token` / `-foreground` / `-text` with
  **MEASURED WCAG-AA contrast in both light AND dark themes**; Okabe-Ito colour-blind-safe
  chart ramps + viridis; self-hosted **Inter + JetBrains Mono** (no external font CDN).
- **G2 ONE design standard** — a single shadcn/Radix/Tailwind standard enforced
  end-to-end: shared primitives + ONE card grammar + a label→token authority + a
  **codemod** that adopted the primitives across the pages (see `DESIGN_STANDARD.md`).
- **G3 Settings decluttered** — the 2673-line Settings god-file replaced by a
  data-driven **section registry** + per-section files under `soc/pages/settings/*`
  (2673 → 575 LOC), **6 → 5 nav groups**, **Security promoted to top-level**, ≤2 nesting
  levels, 33 redirect tests. Fixed the **auto-close dead-field** bug (the flagship
  toggle did nothing).
- **G4 dashboard uses more real-estate** — a new `PageContainer` (wide/fluid) that killed
  the `max-w-[1400px]` cap; a three-zone dashboard layout.
- **G5 compact hero** — the old ~176px `HeroPanel` merged into a ~52px `PageHeader`.
- **G6 rules customization** — a **Detection & Rules** home with 3 tiers
  (detection-match/threshold · anomaly/baseline · case-automation); a polymorphic rule
  editor + a flat condition builder; **Test/Preview vs recent data that NEVER calls
  `decide()` and NEVER bills the LLM** (`POST /api/triage/preview-decision`, #3/#6); a
  version ledger + rollback (`stores/rule_versions.py`); threshold `NumberField` /
  `LabeledSlider`; asset/SLA/priority/suppression editors. New `api/routes_rules.py`.
- **G7 custom dashboards** — a widget registry reusing the existing tiles/charts; a
  per-user **drag/resize grid** via **LAZY-loaded** `react-grid-layout` (edit-mode only);
  a zero-migration `DashboardStore` (`stores/dashboards.py` over the KVStore) with
  per-role defaults + clone-to-customize. New `api/routes_dashboards.py`,
  `pages/Dashboards.tsx`, `UserPrefs.dashboards` + `CustomizationConfig.default_dashboards`.
- **G8 loose coupling** — a single `FEATURES[]` registry (`soc/registry.tsx`) that derives
  nav + routes + the command palette from one place; `useNavigate()` replaces the
  `onNavigate` prop-drill; **`React.lazy` code-splitting restored** (entry chunk
  537 → **264 kB**); `routes.py` decomposed into domain routers (paths byte-identical); a
  generic `EntryPointRegistry`; Protocol narrowing; **openapi-typescript** type generation.
- **G9 a11y + audit** — non-color `SEMANTIC_ICON` signaling, WCAG-2.2 criteria, `jest-axe`,
  20 `jsx-a11y` rules at error (**48 → 0** violations); a 16-dimension adversarial audit
  found **23 findings (9 must-fix)** — all resolved with regression tests.
- **Bugs fixed (from the subsystem maps + audit):** the **auto-close dead-field** (G3
  flagship toggle did nothing), `KpiTile` delta-by-sign, the wizard's cosmetic demo
  toggle, clipboard-over-http, a misc-prefs clobber, an automation impossible-verdict, a
  roles permission mismatch, no-confirm destructive close, a campaigns read-perm gate, a
  dead `initAdmin` stub, a `request_approval` dead-end, a tuning row always-"Active", a
  SQL sort no-op, a `derive_priority` disagreement, plus audit **C1** (dashboards
  couldn't persist), **H2** (rules verdict case-bug), **H3** (dashboards billed the LLM),
  **H4** (19 unnamed comboboxes), and **M1–M4**.

New modules: webui `soc/rules/*` (Detection & Rules home + polymorphic editor + condition
builder), `soc/dashboard/*` (custom-dashboard builder/grid/widget registry), `soc/registry.tsx`
(the `FEATURES[]` registry), `soc/hooks/*`, ~15 new shared components/primitives
(`Field` · `SegmentedControl` · `ConfirmDialog` · `NumberField` · `LabeledSlider` ·
`SecretField` · `TagInput` · `IconButton` · `PageContainer` · `TimeRangePicker` ·
`DashboardGroup` · `collapsible` · `typography` · …), `pages/settings/*` section files,
`pages/Dashboards.tsx`; backend `api/routes_rules.py` + `api/routes_dashboards.py` + the
extracted domain routers, `stores/dashboards.py` + `stores/rule_versions.py`,
`POST /api/triage/preview-decision`, typed config endpoints (baseline/campaign/batch).

**GREEN BASELINE (verified 2026-07-02):** backend **1601 pytest** pass (was 1461); the
standalone **webui builds clean** (tsc+vite) with the **entry chunk 264 kB** (was 537) +
**625 Vitest specs green** (was 273); eslint **0 errors** (4 benign warnings);
`route_auth_coverage` green + a new **design-gate** green; `engine/case_manager.py`
`decide()` **byte-identical** vs the pre-Round-5 baseline `27f0983`; **`PUT /api/settings`
deep-MERGE intact** and **all API paths byte-identical**. **Deps:** ADDED
`react-grid-layout ^2.2.3` (the ONE new runtime dep — LAZY, edit-mode only) + dev-only
`@fontsource-variable/inter` · `@fontsource/jetbrains-mono` · `@tailwindcss/container-queries`
· `openapi-typescript` · `jest-axe`/`@axe-core` · `eslint-plugin-jsx-a11y`; REMOVED
`framer-motion` (zero importers); **backend ZERO new runtime deps**. Every wave was
additive with #3 intact (rule Test/Preview and custom dashboards never call `decide()`
and never bill the LLM), #6 preserved, and #2/#9/#10 upheld. See
`docs/research/2026-07-round5/` (`PROPOSAL.md` + `DESIGN_STANDARD.md` +
`IMPLEMENTATION.md` + the `understand/` maps) for the Round-5 design + what-shipped.

**Round 4 (commits `068ede4 → 3aeab6c → 41ee54b → f7509a3 → b07f172 → 11ea46e →
3c68cf5 → 1df27ac` + this docs wave) — "fix the logic, fine-tune the product": 12
user requests + 3 confirmed bugs across 7 waves (W0–W6), additive + default-OFF, ZERO
new runtime deps, `engine/case_manager.py` BYTE-IDENTICAL throughout (#3), the 12
non-negotiables held (esp. #1/#3/#4/#6/#9):**

- **The 3 bugs fixed:** (1) **single-source poller** — new `engine/poller_manager.py`
  fans out over EVERY enabled PULL source (per `{source.id}:{feed.id}` cursor +
  legacy-`"primary"`-cursor-collision guard + a per-signature in-flight lock so
  concurrent sources never duplicate a case #4; single/zero-source path
  byte-identical). (2) **`claude-opus-4-8` mispriced** $15/$75 → **$5/$25** (ctx→1M) +
  cache rates now APPLIED (read 0.1× / write 1.25×[5m]/2×[1h]) + batch 0.5× + wired the
  previously-dead `providers.with_retry()`. (3) **acknowledge** now sets
  `CaseStatus.INVESTIGATING` (was `None`; non-terminal, not a close #3).
- **Two-tier ingestion** — **ALERT feeds** = realtime per-alert triage + a daily
  **campaign correlation** pass; **EVENT feeds** = a cheap-first, batched
  agent-driven **detection** funnel (pre-aggregate → deterministic rules → anomaly
  vs. baseline → batched Haiku detection) whose survivors re-enter the SAME
  correlate/decide pipeline as candidate cases (#3/#4, #9-fenced, #7 aggregate-only).
  Both tiers default OFF; the existing realtime path is byte-identical when disabled.
- **Adaptive threshold auto-tuning** (`engine/threshold_tuner.py` + `stores/tuning.py`)
  — a nightly deterministic observer that measures per-rule FP noise (Wilson lower-bound
  + min-samples + EWMA), auto-applies a **bounded +1** correlation-`n` / feed
  `severity_floor` bump with `ActionType.TUNING` audit + rollback + shadow-eval (never
  hides a confirmed TP), routes suppression DROPs to a **HITL Proposal**, and **never
  imports `decide()`/risk/signature** — a config-writer only, default OFF.
- **Campaign correlation** (`engine/campaigns.py` + `stores/campaigns.py`) — a daily
  deterministic shared-entity graph that groups RELATED cases into `Campaign` objects;
  references `case_ids` only, never re-clusters or closes (#3/#4).
- **Entity baselining** (`engine/baseline.py` + `stores/baseline.py`) — online
  EWMA/EWMV per cluster-signature across 168 hour-of-week buckets + a bounded t-digest
  (p50/p95/p99) + robust modified-z |M|>3.5 + a 3×-period warm-up (H=14d slow); a pure
  producer that never reads `decide()`/risk-weights.
- **LLM batch/flex + cache economics** — new `llm/batch.py` `BatchProvider` SPI
  (Anthropic Message Batches + OpenAI Batch + `service_tier='flex'`; results UNORDERED
  → keyed by `custom_id`) + `stores/batch_jobs.py` (resume-safe, per-`custom_id`
  retrieved-dedup → **exactly one** UsageDoc/result at 0.5× batch, #6); cache-token
  extraction in `providers.py` + cache rates applied in `pricing.cost_for`
  (non-cache math byte-identical).
- **Tiered reset + fresh OOBE** — `engine/reset.py` + `api/routes_reset.py`
  (admin + `require_fresh_auth`, type-to-confirm cases/sources/factory tiers; the cost
  ledger + audit survive the cases tier; **env secrets are byte-identical across ALL
  tiers**, airtight-tested #1/#10) + `api/routes_setup.py` (OOBE first-super_admin,
  strong-password-enforced, self-locking; the legacy public `init-admin` was removed in
  the audit).
- **6 new routers** (`routes_tuning · routes_campaigns · routes_baseline · routes_batch
  · routes_reset · routes_setup`) + on `routes.py`: `GET /api/logs` (unified
  scatter-gather over browse-capable sources), `/cases/{id}/forwarding`
  (`explain_forwarding`), `/sources/health`. **config.py:**
  `Preferences.{threshold_tuning,batch,baseline,campaign}` (default OFF) +
  `caps.max_concurrent` + `BrandingConfig.login_*` (bounded plain-text white-label,
  `<`-rejecting validator #9); `AutomationRule → CaseAutomationRule` (alias kept, wire
  key `threshold_automation` unchanged).
- **webui** — unified logs sheet · tuning/campaigns/baseline/batch surfaces · cleaner
  CaseDetail (single primary CTA + a unified Close-with-disposition dialog that still
  posts through `decide()` #3) · analytics declutter (Cost as the single home) · login
  white-label + OOBE account-setup · Models cache/batch pricing columns · a DangerZone
  reset panel.
- **Terminology cleanup (UI/docs only — wire keys + aliases kept):**
  event / detection / alert / case / campaign; "correlate" → auto-investigate /
  clustering / campaign-correlation; "rule" → detection-rule / case-automation.
- **Audit + harden (W6):** a 16-dimension adversarial audit found **16 confirmed
  issues** (2 HIGH poller-concurrency, event-detection now REALLY creates cases,
  OpenAI cache double-bill, the OOBE `init-admin` bypass, t-digest unbounded growth,
  …) — all fixed + regression-tested.
- **Deferred/known:** the admin-page consolidation-REDIRECTS (#4 — the pages work +
  deep-link standalone) and a dead `webui api.setup.initAdmin` stub (never called; the
  live flow uses `/setup/account`).

New modules: `engine/{poller_manager,threshold_tuner,campaigns,baseline,event_detection,
forwarding,reset}.py`, `llm/batch.py`, `stores/{tuning,campaigns,baseline,batch_jobs}.py`,
and 6 `api/routes_{tuning,campaigns,baseline,batch,reset,setup}.py` routers.

**GREEN BASELINE (verified 2026-07-01):** backend **1461 pytest** pass (Round 4:
1234 → 1235 W0 → 1253 W1 → 1263 W2 → 1371 W3 → 1437 W4 → 1461 W6); the standalone
**webui builds clean** (tsc+vite) + **273 Vitest specs green** (205 → 273); eslint
**0 `react-hooks/rules-of-hooks` errors** (3 benign `exhaustive-deps` warnings);
`engine/case_manager.py` **byte-identical**; **ZERO new runtime deps**. Every wave was
additive + default-OFF, with #3 intact (event-detection candidates re-enter the normal
pipeline and never call `decide()`; the tuner is a config-writer that never imports
`decide()`; reset never closes a case outside `decide()`) and #6 preserved (batch is
exactly-one UsageDoc/result under an atomic claim-before-bill). See
`docs/research/2026-07-round4/` (`PROPOSAL.md` + `RESEARCH-SYNTHESIS.md` + the
`understand/` subsystem maps + `IMPLEMENTATION.md`) for the Round-4 design +
what-shipped.

**Round 3 (commits `bffe4b8 → 59c2999 → 2295363 → 8b25ca2 → 3610147` + this docs/live
wave) — 12 user requests, additive, zero new deps, #3 byte-identical, the 12
non-negotiables held:** expandable hamburger nav + sub-pages; richer Settings
real-estate (card grid + sticky save); deeper branding/material (bounded theme-token
allow-list + AA presets + a "command" material pack); per-case **human+AI ticket
collaboration** (threaded human/ai/system messages, reactions, tasks, @mentions, an
activity feed — AI is a first-class author but can only RECOMMEND, never close);
a richer **posture dashboard** (server-side MTTA/MTTR/dwell p50/p90, SLA/aging, quality
mix, period-over-period deltas + **MITRE coverage** vs the 697-corpus + ATT&CK Navigator
layer export); **fine-grained RBAC** (custom roles + inheritance + explicit DENY +
opt-in row-scope hook, all server-enforced); **+17 new enrichment providers (19 total
registered)** behind an `EnrichmentProvider` SPI (multi-indicator IP/domain/hash/url/email); **in-app
notifications** (per-user fan-out inbox + bell + per-category×channel prefs); a
standardized/customizable **Models page** (provider registry incl. Azure/Bedrock/Vertex
+ OpenAI-compatible `base_url`, bundled model registry + price overlays, a pre-flight
`BudgetGate`); **distinctive UI** (opt-in material pack + glass chrome + page archetypes
+ editorial charts, calm "quiet" default preserved); a **forward-looking Standup**
(deterministic attention queue + SLA/aging + workload + ack/handoff, still
aggregate-only #7); and **clearer cases** (4 honest triage chips risk/severity/impact/
priority + a typed ReAct trace timeline with the deterministic `decide()` step surfaced
as a trust feature). Plus a shipped **security fix**: inverted RAG-knowledge fencing to
a TRUSTED allowlist so operator-imported docs no longer reach the model unfenced
(OWASP LLM01). New modules: `enrichment/` SPI (ABC + registry + dispatch + aggregate +
19 registered providers), `realtime.py` (multiplexed SSE `EventBus`), 8 KV stores
(case_thread/case_activity/case_tasks/inbox/notif_prefs/custom_roles/price_overlay/
shift_handoff), `engine/{shift_report,priority,budget,mitre_coverage}.py`, and 8
per-feature `api/routes_*.py` routers (metrics/standup/enrichment/models/inapp/
cases_collab/triage/roles).

**Round-3 GREEN BASELINE (verified 2026-06-30 — superseded by the Round-4 baseline
above):** backend **1142+ pytest** pass (395 → 772 → 794
→ 1142; rises as the harden-wave regression tests land — see `Journal.md` for the exact
per-wave count); the standalone **webui builds clean** (tsc+vite) + **181+ Vitest specs
green** (86 → 181); eslint **0 `react-hooks/rules-of-hooks` errors** (2 benign `exhaustive-deps`
warnings); `engine/case_manager.py` **byte-identical**; **ZERO new runtime deps** across
all three rounds. Every round was additive, with non-negotiable #3 intact (Demo Mode
uses a sandboxed policy copy; the Round-3 `BudgetGate` is a pure pre-flight that fails
safe to NEEDS_HUMAN, never a silent close) and #6 (one ledger write per call) preserved.
The legacy Kibana plugin is **archived** (`archive/`). Active branch: **`Testing`**.
New here? Start with `docs/HANDOFF.md`. See `docs/VIGIL_STUDY.md` for the study +
multi-wave plan, `docs/research/2026-07-round5/` (`PROPOSAL.md` + `DESIGN_STANDARD.md` +
`IMPLEMENTATION.md` + `AUDIT_FINDINGS.md` + `understand/`) for the Round 5 design +
what-shipped, `docs/research/2026-07-round4/` (`PROPOSAL.md` + `RESEARCH-SYNTHESIS.md`
+ `understand/` + `IMPLEMENTATION.md`) for the Round 4 design + what-shipped,
`docs/research/2026-06-round3/` (`PROPOSAL.md` + `IMPLEMENTATION.md`)
for the Round 3 design + what-shipped, `docs/research/2026-06-round2/` for Round 2, and
`ROADMAP.md` for live status.

**Done — Round 2 (commits since `ccc7a46`; W1–W7c; additive, zero new deps, #3
byte-identical, #9 untrusted fencing upheld on every new user/source-influenceable
field):**
- **W1 bug fixes** — RiskGauge Active-Risk-Index glitch, MFA-QR copy, duplicate close
  X, chat framing, store-degraded UX; presentational + a store-degraded notice derived
  client-side from `/api/health.store_type` (in-memory-store detection — the health
  endpoint returns `{status, version, es_connected, store_type, setup_complete}`; there
  is no `persistent` field).
- **W2 Login redesign + account self-service** — 2-column split login (brand hero +
  the existing 4-mode form, handlers untouched) + a self-service profile
  (`display_name`/`alias`/`avatar`/`alt_email`/`timezone`/`locale`/`prefs`) on the
  `User` model (all defaulted → no migration; secrets stay out of `User.public()`).
  Tight avatar validator (data-url png/webp/jpeg only, magic-byte sniff, ≤64 KB,
  browser pre-resizes to 256² WebP). Endpoints `GET/PUT /api/account/me`,
  `PUT /api/me/avatar` (env-managed admins rejected 400).
- **W3 Sessions + access policy** — short-lived HS256 ACCESS token now carries `sid`
  (128-bit) + `tv` (token_version); a backend-agnostic **`SessionStore`**
  (`stores/sessions.py` over the KVStore — survives `_wire()` rebuilds) enforces
  idle/absolute/revocation in the async `require_auth` (NOT the sync `verify()` hot
  path). Refresh-token rotation + replay/theft detection. Token policy on Preferences
  (`access_ttl`/`idle_timeout`/`absolute_lifetime`/`refresh_ttl`/`sudo_reauth_window`
  + notify toggles). `require_fresh_auth(window)` step-up gate. Endpoints
  `POST /api/auth/{refresh,reauth}`, `GET /api/sessions`,
  `POST /api/sessions/{sid}/revoke`, `POST /api/sessions/revoke-others`, admin
  `GET /api/admin/sessions`, `POST /api/admin/sessions/{sid}/revoke`,
  `POST /api/admin/users/{username}/revoke-all`; `/api/auth/logout` revokes the
  current sid; session created at all three cookie-set sites (login / mfa-verify /
  sso-callback).
- **W4 Settings IA consolidation** — a two-scope (Personal Account / Organization)
  Settings tree in one left rail; Users/Security/SSO + the new Profile/Account/
  Preferences/Sessions pages moved INTO Settings sub-sections (RBAC-aware filtering);
  the standalone admin rail group dropped; near-duplicate pages consolidated into
  tabbed surfaces (Investigate folded into Chat as a segmented control — ONE chat
  engine; Cost into Metrics; Standup into Overview) under ≤5 top-level nav groups.
  Pure IA — no new endpoints.
- **W5 Demo Mode + Experimental Settings** — a first-class **reversible tenant state**
  (`off|seeded|live`) on `Preferences.demo`, NOT a fork. A `DemoPullConnector`
  (`connectors/demo.py`) feeds seeded OCSF events (`engine/demo_generator.py` — fixed
  fictional org + diurnal-Poisson benign baseline + MITRE storylines) through the REAL
  pipeline, but all writes land in a SEPARATE in-memory store and a deterministic mock
  LLM (`engine/demo_runtime.py`) so demo is **$0, isolated, one-flip reversible**. FP
  runs through the REAL `decide()` against a **sandboxed** AutoClosePolicy copy (live
  policy untouched); NEEDS_HUMAN stays open (HITL showcase). Endpoints
  `POST /api/demo/{enable,reset,disable}`, `GET /api/demo/status` (admin-gated);
  amber `DemoBanner` + `SAMPLE` row badges + "(simulated)" cost tiles.
- **W6 Source multi-feed** — `IndexPattern` promoted to a richer per-feed model (wire
  key `config['index_patterns']` kept) with the new **`ignore`** role + per-feed
  `query` / field-mapping / `message_field` / `severity_floor` / schedule, and the
  overloaded `auto_correlate` split into `correlate` + `auto_investigate` with a
  behavior-preserving migration. Per-feed durable cursor key (`{source.id}:{feed.id}`)
  so a fast alerts feed and a slow events feed never skip (#4); `severity_floor` blocks
  auto-forward but NEVER drops the candidate (#4); IGNORE excludes a sub-index from a
  broad events pattern. Loose JSON, no migration; `/api/sources` round-trips it
  verbatim.
- **W7a Email — Resend + SES + templates** — `ResendChannel` (`notifications/resend.py`,
  HTTPS API, idempotency key, retry-only-on-429/5xx) + an **SES** SMTP preset
  (`email-smtp.{region}.amazonaws.com`, with a stdlib HMAC ladder deriving the SMTP
  password from a raw IAM key pair) on the existing `NotificationChannel` SPI. A
  stdlib **mustache-subset** template renderer (`notifications/templates.py`:
  `{{var}}` auto-`html.escape`d, `{{{raw}}}` for trusted header HTML only,
  `header_safe`/`text_safe` strip CRLF/newlines) with 5 preloaded operator-overridable
  templates (`case.new`/`case.escalation`/`case.resolved`/`digest.daily`/`test`);
  `POST /api/notifications/preview?trigger=` server-side renders a sample case
  (escaping authoritative). Deterministic email threading headers.
- **W7b Per-user customization** — a two-store cascade: org `Preferences` +
  per-user **`UserPrefsStore`** (`stores/user_prefs.py` over the KVStore, keyed by
  user, `'default'` when auth off; no new index). Personal **saved views**, per-table
  **column state**, **terminology** overrides, and light/dark/system **theme**.
  Endpoints `GET /api/prefs/effective` (merged cascade), `GET/PUT /api/prefs/user`,
  `GET/PUT /api/prefs/org` (admin), `GET/POST /api/views`, `PUT /api/prefs/user/tables/
  {table_id}`, `GET/PUT /api/terminology` (PUT admin).
- **W7c UX — command palette + global search + bulk actions + audit viewer** — a
  Cmd-K command palette + a global search surface (`GET /api/search`), multi-select
  bulk case actions, and an audit-log viewer (`GET /api/audit`).

**Done — the 7-wave SOC overhaul (W1–W7; commits since `91f8616`):**
- **W1 Identity** — persisted **multi-user** (`stores/users.py` over the KV doc store,
  no new index/table) + **6-role RBAC** (super_admin / soc_manager / analyst_tier2 /
  analyst_tier1 / responder / auditor) + permission matrix + `require_permission`
  deps + React `<Can>` guards; OOBE first-run; seeds **Admin / Admin@123**
  (super_admin) **only when auth is enabled**.
- **W2 MFA + SSO** — stdlib **RFC-6238 TOTP** (verified against the official vectors)
  + browser inline-SVG **QR** + single-use **recovery codes** + two-phase login
  (`auth/mfa.py`, `/api/auth/mfa/{setup,confirm,verify,disable}`); **OIDC SSO**
  (Google / Microsoft / generic) via server-side code-exchange + userinfo (no
  id_token-verify dep), group→role provisioning (`auth/oidc.py`, `/api/auth/sso/*`).
- **W3 Cases** — extended **status + disposition** taxonomy (`CaseStatus`
  NEW/INVESTIGATING/ESCALATED/ON_HOLD/RESOLVED keeping open/needs_human/closed;
  `Disposition` true_positive/false_positive/benign/suspicious/duplicate/undetermined;
  `needs_human` retained as alias) + lifecycle actions + transition guard +
  `status_history`; **`decide()` byte-identical**; customizable **`case-XXXX`
  nomenclature** (`engine/case_id.py` template + KV sequence + live preview); polished
  case overview panel.
- **W4 Notifications** — pluggable `NotificationChannel` SPI + **email** (stdlib SMTP,
  13 provider presets) + **Slack/Teams/webhook/PagerDuty/Telegram**; per-condition
  triggers + dedup/rate-limit/digest; fire-and-forget **after** `apply()`+save;
  channel secrets in the secret tier (`notifications/`, `/api/notifications/*`).
- **W5 Multi-source** — **Auto-Correlate** toggle per source AND per sub-source
  (`IndexPattern`); opt-in **cross-source correlation** linking RELATED cases by
  shared entity (ip/host/user/file_hash/domain); per-source field-mapping overrides +
  connector `setup_help` + `HelpTip`s + analyze-sample.
- **W6 Automation + Threat-context** — **#3-safe threshold automation**
  (`engine/threshold_automation.py`: tag/recommend/notify/run_playbook/request_approval
  → HITL proposal; **never sets status**); **run-a-playbook** (context-only
  re-investigation); **threat-context panel** (`engine/threat_context.py`: IOC
  reputation + bundled **MITRE ATT&CK 697 techniques** in `threat/` + related cases,
  fail-open); resolved-case → RAG knowledge loop.
- **W7 Settings + UI** — consolidated **Settings** (13 sections / 4 nav groups) +
  `GET /api/settings/schema`; **RiskGauge** redesign (fixes the Active-Risk-Index
  glitch); skeleton/shimmer loading + staggered reveals; 8px-grid alignment; WCAG AA.

**Auth is DEFAULT OFF** (`Secrets.auth_enabled`) so the no-auth "old version" and the
offline test suite keep working unchanged. Enable it with `TLSOC_AUTH_ENABLED=true`
to get the login + RBAC + MFA/SSO and the **Admin / Admin@123** super_admin seed
(change the password immediately).

Done (this round — browse logs per source + connection-test/TLS fixes; additive,
spine + the 12 non-negotiables intact):
- **Browse a source's logs** — `GET /api/sources/{id}/logs?limit=&query=&from=&to=`
  (auth-protected): PULL sources run a bounded (hard-cap 200), read-only,
  field-mapping-aware scoped search honoring the source's own
  `data_view_pattern`/mapping/TLS; PUSH sources return the last N events from a new
  in-memory **live-tail ring buffer** (cap 500/source) in `IngestService`. Each row
  is `{ts, source_ip, user, host, rule, severity, message, _raw}`; **secrets are
  never returned**. `capabilities:["browse"]` on pull manifests + auto-applied to
  every push receiver gates the new webui **SourceLogsFlyout** (search + time range
  + 10s live-tail).
- **Test-connection works for read-only keys** — `ElasticConnector.test_connection`
  no longer gates on `ping()` (a scoped read-only key cannot `HEAD /`); the cheap
  scoped read is now authoritative (`ok:true, mode:"read_only"`), `ping()` only an
  extra `cluster_monitor` signal (`mode:"full"`). `ConnectionTest` gained
  `mode` + `cluster_monitor`; the webui shows a green read-only/full success callout.
- **Per-source TLS honored** — `AppState.es_client_for_source()` builds a per-source
  ES client from the source's merged config+secrets (`es_verify_certs`/`es_ca_cert`/
  `es_url`/`es_api_key`, mgmt key dropped); the primary log source + browse endpoint
  use it; sources with no overrides keep the shared global client.

Done (prior round — explainability, RAG management, agent memory, dashboards/
collaboration; additive, spine + the 12 non-negotiables intact):
- **RAG ingest + management + visibility** ("see the RAG") — `engine/chunking.py`
  (`chunk_text`, dep-free paragraph-pack + overlap); `VectorStore` ABC gained
  `list_documents/list_chunks/delete_document/stats` (InMemory + ES `dense_vector`
  + SQL); `RagService.import_document/list_documents/get_document/delete_document/
  rag_stats` (built-in seed sources `runbook/mitre/suppression/resolved_case`
  guarded unless `force=true`). Routes: `GET /api/rag/stats`, `GET /api/rag/
  documents`, `GET /api/rag/documents/{id}`, `POST /api/rag/import`, `DELETE
  /api/rag/documents/{id}?force=`, `GET /api/rag/search?q=&top_k=` (live retrieval).
- **Agent memory (Claude.ai-style durable operator facts)** — `stores/memory.py`
  `MemoryStore` over the existing KVStore (no new index/migration; `EsKVStore` /
  `SqlKVStore` adapters), `MemoryEntry` model; auto-injected into BOTH automated
  investigations and chat as a DISTINCT `<<<MEMORY>>>` TRUSTED block
  (precedence policy>base>playbook>MEMORY>untrusted; `render_memory()` + `fence()`
  neutralises forged markers). Memory NEVER overrides the deterministic CaseManager
  (#3) — it only informs the LLM. Edited explicitly via REST
  (`GET/POST/PUT/DELETE /api/memory`, source=human) or in chat ("remember:"/"forget",
  source=agent, audited); chat JSON gained `memory_action` (executed) +
  `memory_suggestion` (UI-confirm, never auto-saved).
- **Case explainability** — investigator emits a CONTEXT audit record (new
  `ActionType.CONTEXT`) of the persona/playbook/memory/knowledge/enrichment given,
  + a reasoning excerpt on VERDICT; `GET /api/cases/{id}/rationale` assembles a
  pure "why" object (verdict/confidence/status/decision_by, persona, playbook+reason,
  memory_used, knowledge[RAG/runbook snippets], enrichment, tools[commands/queries
  run], reasoning, the DETERMINISTIC `decision_rationale`, mitre, evidence).
- **webui** — new **Knowledge** page (RAG corpus stats, import paste/file upload,
  documents table + chunk drill-in, guarded force-delete, "try a retrieval") and
  **Memory** page (add/inline-edit/delete/active-toggle, human-vs-agent source
  badges) under a new **Platform** nav; case **"Why"** tab (consumes `/rationale`);
  chat memory-action echo + dismissible "remember this?" suggestion; Metrics
  "Knowledge base & memory" section + Overview RAG/memory tiles; Cases-list
  collaboration (sortable assignee, tags + comment-count badges, filters). All
  attacker-influenceable text renders as plain text / code block (#9 upheld);
  no new npm deps.

Done (Wave 3 — analytics, eval loop, collaboration, white-label UI + CI; additive):
- **Metrics/analytics** (`engine/metrics.py`, `GET /api/metrics`) + a Metrics page:
  verdict/status mix, persona/playbook usage, MTTR, per-day trend, feedback rollup.
- **AI-decision feedback loop** (`Case.feedback`, `POST /api/cases/{id}/feedback`,
  `GET /api/feedback/stats`) — analyst grades the AI verdict; agreement/quality stats.
- **Case collaboration** (`Case.tags/comments/assignee` + routes) + flyout/list UI.
- **Org branding / white-label** (`BrandingConfig` on Preferences; public
  `GET /api/branding`, protected `PUT`): runtime-themeable accent (CSS vars), logo
  upload, branding settings panel + branded shell/login.
- **Case export** (`GET /api/cases/{id}/export?format=json|md`) + flyout menu.
- **Case hover preview** + a broad webui visual polish pass (skeletons, page headers,
  KPI deltas, inline-markdown chat, reduced-motion).
- **CI/CD** (`.github/workflows/ci.yml`): PR merge gate = offline backend suite
  (incl. auth route-coverage) + webui build; aggregate `CI passed` check.

Done (Wave 2 — Markdown playbooks + optional auth, additive, spine intact):
- **Markdown playbook engine** (`app/playbooks/` + `backend/playbooks/*.md`):
  operator-authored phased procedures, DETERMINISTICALLY selected per cluster
  (`registry.select_playbook`, no LLM in the default path), injected as a DISTINCT
  TRUSTED block (`<<<PLAYBOOK>>>`) separate from the fenced UNTRUSTED evidence; a
  playbook can only RECOMMEND. Atomic hot-reload; `GET /api/playbooks`,
  `POST /api/playbooks/reload`, `GET /api/playbooks/selection/{case_id}`. 3 seed
  playbooks. Selection/fallback audited; `Case.playbook_id` recorded.
- **AutoClosePolicy** (`engine/case_manager.decide`): per-verdict-class auto-close
  (see #3) — FP on above a bar, TP opt-in (off), NEEDS_HUMAN never; stored
  `fp_auto_close` migrated for back-compat.
- **Optional auth (default OFF — the no-auth "old version" stays the default)**:
  `app/auth/` (PBKDF2 + stdlib HS256 JWT) + `app/middleware/` (security-headers /
  CSRF / rate-limit); router-level `require_auth` gate (no-op when disabled) with a
  tiny `PUBLIC_API_PATHS` allowlist; `/api/auth/{login,me,logout}`; a CI
  route-coverage test (`test_route_auth_coverage`) that fails if any `/api` route
  bypasses auth — **now strengthened to also fail if any non-GET `/api` route lacks
  an authZ (`require_permission`) gate**, so every state-changer is RBAC-checked.

Done (the Vigil-inspired overhaul — Wave 1, additive, spine intact):
- **Multi-agent roster** — declarative `AgentPersona` registry (`agents/personas.py`):
  the cluster is routed deterministically to a specialist (identity / web / recon /
  malware / threat-intel) that specialises the ONE investigator; persona recorded
  on the case + audit; `GET /api/personas`.
- **Plain-text runbooks** — Markdown runbooks (`backend/app/runbooks/*.md`) loaded by
  `engine/runbooks.py` and indexed into the RAG corpus as retrievable knowledge;
  `GET /api/runbooks`. (Per-cluster PROCEDURE injection moved to the Wave-2 playbook
  system; runbooks are RAG knowledge only.)
- **Hybrid RAG** — drawer-floor-first vector + dependency-free BM25 re-ranking in
  `tools/rag.py` (recovers exact IOC/rule tokens that embed as noise).
- **Tool safety tiers** — `ToolTier` (safe/managed/requires_approval/forbidden) on
  the tool base; the investigator gates non-safe tools (proposes, never executes).
- **Hardened fencing + cost provenance** — `fence()` escapes forged close-markers +
  carries source/tool provenance (#9); `pricing_source` (exact/heuristic/zero/
  default) threaded onto every `UsageDoc`.

Done (the vendor-agnostic epochs):
- **Epoch A — Selectable state backend.** `StateStore` abstraction
  (`stores/base.py`) + SQL backend (`stores/sql/`): SQLite (dev/test) and
  PostgreSQL+pgvector (prod), selected by `STATE_BACKEND`; ES remains the default.
- **Epoch B — Connector SPI + OCSF.** `connectors/` SPI + registry; OCSF canonical
  schema (`ocsf/`); pull connectors (Elasticsearch/OpenSearch) + 16 push/queue/
  object-store receivers (`connectors/receivers/`) + ingestion (`engine/ingest.py`).
- **Epoch C — Wazuh connector** (reuses the OpenSearch connector + alert→OCSF).
- **Epoch D — Standalone web UI + wizard** (`webui/`, Vite+React; later re-skinned to
  Tailwind + shadcn/Radix in the UI overhaul) — now the primary surface.

Remaining (see `ROADMAP.md` + `docs/VIGIL_STUDY.md`):
- **Wave 2 leftovers:** an approval workflow (HITL action gating) + a pre-flight
  projected-cost gate + a `$`-budget ceiling (the `ToolTier.requires_approval`
  groundwork + `AutoClosePolicy` are in place). Optional: default auth ON for a
  hardened profile (compose), CSRF cookie issuance for the webui.
- **Wave 3:** durable operator memory + case explainability + RAG management/
  visibility shipped this round (see "Done (this round)" above). Still open: a
  temporal knowledge graph + cross-case memory linkage; a real MITRE module from a
  bundled STIX file; a detection-rule RAG corpus; HITL / Auto-Ops webui surfaces.
- **Wave 4 / Epoch E:** ARQ workers + KEDA scale-out; a Helm chart; OTEL+Grafana.
- More pull connectors — **Splunk + Microsoft Sentinel** next (enum'd, not yet built).

Every item ends with: `pytest -q` green (keep the count current), `webui` build
clean, docs updated, **Journal updated**, commit + push.

---

## Journal entry format (copy into Journal.md)

```
### YYYY-MM-DD HH:MMZ — <agent/role> — <short title>
- Context: <what you set out to do / which roadmap item>
- Did: <concrete changes: files, endpoints, decisions>
- Tests: <pytest/tsc/build results>
- Status: <done | in-progress | blocked: why>
- Next: <handoff for the next agent>
```
