# Agentic SOC — self-hosted, vendor-agnostic triage

> A source-available, self-hosted **agentic AI SOC triage** system. It ingests
> alerts/logs from **any** SIEM/EDR/XDR, normalises everything to **OCSF**,
> correlates and risk-gates in deterministic code, runs a two-tier LLM
> investigation (cheap router → strong investigator), and lets a deterministic
> case manager close or escalate — **auto-close is a tunable per-verdict policy, and a
> case with no clear verdict is never auto-closed**. It is a **read-only consumer**:
> your upstream pipeline is never modified.

> **New here? Start with [`docs/HANDOFF.md`](docs/HANDOFF.md)** — the authoritative
> onboarding doc (what's built, how to run it, where everything lives).

It builds on the prior **TLSOC Agentic Triage Suite** (an ELK/Kibana-coupled
backend + Kibana plugin) but is now **product-agnostic**: it works against
Elasticsearch, OpenSearch, Wazuh, Splunk-HEC, syslog, Kafka, cloud queues, object
stores, plain webhooks, and more — and ships its **own standalone web UI** so it
no longer depends on Kibana at all. The UI is a self-hosted **Vite + React +
Tailwind + shadcn** SPA (the old `@elastic/eui` UI has been retired).

**Public docs source:** [`docs/index.md`](docs/index.md) · quickstart →
[`docs/getting-started/quickstart.md`](docs/getting-started/quickstart.md) · source
support → [`docs/sources/support-matrix.md`](docs/sources/support-matrix.md) · release
limits → [`docs/releases/known-limitations.md`](docs/releases/known-limitations.md).
The same site deploys free through GitHub Pages after `main` is established.

**Engineering docs:** deploy → [`DEPLOY.md`](DEPLOY.md) · use → [`docs/USAGE.md`](docs/USAGE.md)
· ingestion → [`docs/INGESTION.md`](docs/INGESTION.md) · architecture →
[`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md) · environments →
[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) · fix →
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) · security →
[`SECURITY.md`](SECURITY.md) · contribute → [`CONTRIBUTING.md`](CONTRIBUTING.md).

## What it is

Raw alert volume from any source becomes audited, cost-metered, human-reviewable
**cases**. Two loosely-coupled components do the work: a **backend** (`backend/`,
FastAPI + LangGraph) that holds all the agentic logic, connectors, OCSF
normalisation, the deterministic funnel, the LLM gateway + cost ledger, and the
suite's own state; and a **standalone web UI** (`webui/`, Vite + React + Tailwind
+ shadcn) that talks to the backend directly over `/api` — the **sole primary**
front door. The original Kibana plugin (`archive/kibana-plugin/`) is **archived**
(frozen 2026-06-21): it is no longer built, tested, or shipped. Revive it from the
archive only if a site truly needs the embedded-in-Kibana experience — see
`archive/kibana-plugin/BUILD.md`.

## Architecture

```
   any SIEM / EDR / XDR / queue / object store / webhook
                          │
        ┌─────────────────┴──────────────────┐
        │  PULL connectors        PUSH receivers (16)
        │  (we poll a search API) (they forward to us)
        │  Elastic·OpenSearch·    webhook·HEC·syslog·Kafka·
        │  Wazuh                  SQS·Kinesis·EventHub·PubSub·
        │                         RabbitMQ·NATS·MQTT·Redis·
        │                         S3·GCS·AzureBlob·file
        └─────────────────┬──────────────────┘
                          ▼
         OCSF normalisation  (backend/app/ocsf/)
                          ▼
   correlate (deterministic) ─▶ risk gate (deterministic) ─▶ cost gate
                          ▼
   router (cheap LLM) ─▶ investigator (strong LLM, ReAct) ─▶ formatter
                          ▼
   Case Manager (deterministic close/escalate; a tunable per-verdict auto-close
   policy — NEEDS_HUMAN can never be auto-closed)
                          ▼
   Case Manager decides ─▶ notifications (fire-and-forget) ─▶ threshold automation
                          ▼
   case + audit + usage + users store  (Elasticsearch | Postgres+pgvector | SQLite)
                          ▼
   standalone web UI  (webui/, /api) — optional auth: RBAC · MFA (TOTP) · OIDC SSO
```

Every LLM call goes through one gateway → a usage/cost ledger; every agent action
is appended to an append-only audit trail; log-derived values are treated as
UNTRUSTED data in prompts. Notifications and threshold automation run only **after**
the deterministic close/escalate decision and never alter it. See
[`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md) for the full design.

## Features

- **Vendor-agnostic ingestion.** A connector SPI (`backend/app/connectors/`) with
  a registry + `tlsoc.connectors` entry points (third-party connectors install via
  `pip` and appear in the wizard with zero core change). Two physical shapes:
  - **PULL** — we poll a search API on a durable cursor: **Elasticsearch,
    OpenSearch, Wazuh** today (per-source field mapping set in the wizard).
  - **PUSH (16 receivers)** — sources forward to us: webhook, Splunk-HEC, syslog,
    Kafka, AWS SQS, AWS Kinesis, Azure Event Hub, GCP Pub/Sub, RabbitMQ, NATS,
    MQTT, Redis Streams, S3, GCS, Azure Blob, file. Formats parsed:
    JSON / NDJSON / CEF / LEEF / GELF / syslog / kv. Optional client libs are
    imported lazily, so the core has no new hard dependency.
- **OCSF canonical schema** (`backend/app/ocsf/`). Whatever the source, every
  record is normalised to OCSF before the engine reasons over it.
- **Deterministic funnel + LLM tiering.** Correlation, risk scoring, the cost
  gate, and the close/escalate decision are deterministic code; only the verdict
  comes from the LLM, and investigation is tiered (cheap router → strong
  investigator) to control spend.
- **Cost ledger + batch/flex.** 100% of LLM calls pass through one gateway that records
  token usage and cost on every call (exactly one ledger write per call, #6). Round 4
  applies prompt-cache and batch pricing (cache read 0.1× / write 1.25×–2×; Batch 0.5×) and
  adds a `BatchProvider` SPI (Anthropic Message Batches + OpenAI Batch, plus OpenAI `flex`)
  keyed idempotently by `custom_id`, with a broadened, correctly-priced model catalog
  (`claude-opus-4-8` fixed to $5/$25).
- **RAG with management & visibility.** Resolved cases are indexed as retrievable
  baseline memory so future investigations learn from prior analyst decisions
  (backed by pgvector or an ES dense-vector store, depending on the state backend).
  You can also **see and grow the corpus**: import your own documents, browse the
  documents/chunks, run a live test retrieval (`GET /api/rag/search`), and delete
  (built-in seeds are guarded behind a `force` flag) — via the **Knowledge** page or
  the `/api/rag/*` routes.
- **Agent memory (durable operator facts).** Claude.ai-style memory: add facts in the
  **Memory** page or conversationally in Chat ("remember:" / "forget"); they are
  injected into investigations and chat as a DISTINCT **TRUSTED** context block —
  but **never override the deterministic close/escalate decision**.
- **Case explainability.** Every case exposes a "Why" view (`GET /api/cases/{id}/
  rationale`): the agent's reasoning, the knowledge (RAG/runbook) and operator memory
  it used, the exact commands/queries it ran, enrichment, MITRE — and, prominently,
  the **deterministic** close/escalate rationale.
- **Choice of state backend** (`STATE_BACKEND`): `elasticsearch` (default),
  `postgres` (asyncpg + pgvector), or `sqlite`. The app's own state
  (cases/audit/usage/config/cursor/RAG) lives there; with **postgres or sqlite no
  Elasticsearch is required at all**.
- **Standalone web UI + first-run wizard.** A self-hosted SPA (`webui/`,
  Vite + React + Tailwind + shadcn) with a multi-step setup wizard that lists
  connectors, renders a dynamic form per connector, tests the connection,
  configures LLM providers and per-role models, and manages multiple sources — all
  without Kibana.
- **Multi-user identity + RBAC (optional, default OFF).** When auth is enabled
  (`TLSOC_AUTH_ENABLED=true`), the suite persists real users (a KV-doc store — no
  new index/table) and enforces a six-role permission matrix in code:
  `super_admin` / `soc_manager` / `analyst_tier2` / `analyst_tier1` / `responder` /
  `auditor`. A first-run OOBE seeds an `Admin` / `Admin@123` super-admin (forced to
  change the password on first login); `require_permission` FastAPI deps gate every
  state-changing route and `<Can>` guards filter the UI. Default-OFF preserves the
  zero-auth back-compat behaviour and the offline tests.
- **MFA + SSO.** Stdlib RFC-6238 **TOTP** (no new backend dep) with a browser
  inline-SVG QR enrolment, single-use recovery codes, and a two-phase login;
  **OIDC SSO** for Google / Microsoft / generic providers via server-side code
  exchange + `userinfo` (no `id_token`-verify dependency), with group→role
  auto-provisioning.
- **Account self-service + a white-label login.** A two-column (brand hero + form) login
  whose hero is **white-labelable** (`BrandingConfig.login_*` — bounded plain-text
  headline / subtext / illustration, no raw HTML/SVG, #9), and a self-service profile
  (display name, avatar, alternate email, timezone, locale, personal prefs) on the user
  model via `GET/PUT /api/account/me` (env-managed single-admin is read-only). Secrets stay
  excluded from the public projection.
- **Sessions & access policy.** Short-lived access tokens carry a session id (`sid`)
  + token version (`tv`); a backend-agnostic `SessionStore` (over the existing KV
  layer, survives restarts) enforces idle / absolute / revocation in `require_auth`,
  with refresh rotation + reuse-detection. Users see + revoke their own sessions
  (`GET /api/sessions`, `POST /api/sessions/{sid}/revoke`,
  `POST /api/sessions/revoke-others`); admins can force-terminate any
  (`GET /api/admin/sessions`, `POST /api/admin/sessions/{sid}/revoke`). Sensitive
  routes can demand a fresh step-up (`POST /api/auth/reauth`); the token policy
  (TTL / idle / absolute / sudo window) is UI-editable.
- **Demo Mode (reversible, isolated, $0).** A first-class tenant state
  (`off` / `seeded` / `live`): project-owned synthetic facts are serialized as
  Splunk-compatible HEC, QRadar-compatible LEEF/offenses, Wazuh JSON, and RFC
  syslog, then enter the REAL parser → OCSF → correlation/investigation pipeline.
  Demo-generated workload writes land in a SEPARATE in-memory store with a
  deterministic mock LLM, so the demo is free, isolated, bounded, and one-flip
  reversible—even when real provider keys are configured. Seeded scenarios
  backfill history; live mode guarantees an early cross-source incident and keeps
  source health/live-tail activity moving. FP still runs through the real (but
  sandboxed-policy) `decide()`, NEEDS_HUMAN still stays open.
  `POST /api/demo/{enable,incident,reset,disable}`, `GET /api/demo/status`
  (`demo:read` for status; `demo:manage` for mutations—default `super_admin` and
  `soc_manager`); every demo case is tagged and run-scoped, while seeded and live
  case IDs may use different formats. Lifecycle mutations persist to the real audit
  trail and are visible in the Audit page after exit. Other organization/admin
  settings remain live during a demo.
- **Notifications.** A pluggable `NotificationChannel` abstraction with **email**
  (stdlib SMTP, 13 provider presets, plus an **Amazon SES** preset that can derive
  SMTP creds from a raw IAM key pair, and a **Resend** HTTPS-API channel), plus
  **Slack / Microsoft Teams / webhook / PagerDuty / Telegram** channels.
  Operator-overridable **email templates** (5 preloaded — `case.new` / `case.escalation`
  / `case.resolved` / `digest.daily` / `test`) rendered by a tiny stdlib
  mustache-subset renderer with hard UNTRUSTED-escaping + header-injection guards;
  server-side preview via `POST /api/notifications/preview`. Per-condition triggers
  (create / verdict-change / escalate / close) with dedup, rate-limiting, and digest
  batching; sends are fire-and-forget *after* the deterministic decision + save (never
  inside it), and channel secrets live in the secret tier.
- **Per-user customization.** A two-store model — org **Preferences** + a per-user
  `UserPrefsStore` (over the existing KV layer, no new index) — backs **saved views**,
  per-table column state, **terminology** overrides (relabel "case" → "incident", etc.),
  and a personal light / dark / system **theme**, resolved through a merged cascade
  (`GET /api/prefs/effective`). Routes: `GET/PUT /api/prefs/{user,org}`,
  `GET/POST/PUT/DELETE /api/views` (+ `/clone`), `GET/PUT /api/terminology` (PUT admin).
- **Command palette, global search, unified logs, bulk actions, audit viewer.** A
  Cmd/Ctrl-K command palette; a cross-entity **global search** (`GET /api/search`) over
  cases / sources / pages; a **unified log view** (`GET /api/logs`) that scatter-gathers
  read-only, secret-free rows across every browse-capable source with mandatory
  per-source provenance and graceful partial-failure handling; **bulk case actions**
  (`POST /api/cases/bulk`) that run each id through the EXACT single-case human action path
  (`_perform_case_action`) — never `decide()` — audited per id and partial-failure
  tolerant; and an **audit viewer** (`GET /api/audit`) over the append-only trail.
- **Two-axis case taxonomy + custom case IDs.** Lifecycle **status**
  (`new` / `investigating` / `escalated` / `on_hold` / `resolved`, plus the retained
  `open` / `needs_human` / `closed`) and analyst **disposition**
  (`true_positive` / `false_positive` / `benign` / `suspicious` / `duplicate` /
  `undetermined`), with guarded lifecycle transitions and a status history.
  `case_manager.decide()` is **byte-identical** — the taxonomy is an additive layer.
  A configurable `case_id_format` template (e.g. `CASE-2026-000123`) with a KV
  sequence and a live preview gives human-facing case numbers.
- **Multi-source polling + per-feed source config.** The poller fans out over **every
  enabled PULL source** (not just the primary) — a `PollerManager` gives each source its
  own connector, its own per-feed durable cursor (`{source.id}:{feed.id}`), and a
  per-`cluster_signature` in-flight lock so concurrent sources never skip or duplicate a
  case (#4). An opt-in **cross-source correlation** pass links RELATED cases that share an
  entity (IP / host / user / file hash / domain) without forcing a merge (1:1 cluster→case
  preserved). Each pull source can declare multiple **feeds** (index patterns) with a role —
  `events` (correlate then triage), `alerts` (auto-investigate), or `ignore` (skip) —
  plus per-feed `correlate` / `auto_investigate` switches, a connector-native query
  filter, a field-mapping override, a severity floor, and an **independent durable
  cursor** so a fast alerts feed and a slow events feed never skip each other (#4).
  A severity floor demotes auto-forwarding but **never drops events** (#4). Plus
  per-connector contextual setup help.
- **Two-tier alert/event ingestion.** **ALERT** feeds run realtime,
  per-alert; **EVENT** feeds run a cheap-first agent-driven **detection funnel**
  (`engine/event_detection.py`: pre-aggregate → deterministic rules → anomaly →
  batched-LLM detection) whose survivors **re-enter the exact same correlate → decide
  pipeline** — so nothing bypasses the deterministic close/escalate (#3/#4), log values stay
  UNTRUSTED (#9), and the LLM only ever sees fenced aggregates (#7).
- **Daily campaign correlation + entity baseline (default ON).** A deterministic
  daily **campaign** pass builds a shared-entity graph over recent cases and emits
  `Campaign` objects that only *reference* case ids (never re-clusters or closes, #4). An
  online **entity baseline** (EWMA/EWMV over 168 hour-of-week buckets + a bounded t-digest +
  robust modified-z) turns "improves over time" into a real signal that feeds the
  event-detection anomaly stage — a pure producer that never touches `decide()`.
- **Adaptive threshold auto-tuning (default ON).** A nightly **deterministic**
  observer (`engine/threshold_tuner.py`) measures per-rule false-positive noise (Wilson
  lower-bound + min-samples + EWMA), and bounded-bumps a correlation rule's `n` or a feed's
  `severity_floor` with an audit record + one-step rollback + a shadow-eval that blocks any
  change which would have hidden a confirmed true positive. Suppression drops route to a HITL
  approval instead of applying silently. It is a config-writer only — it **never** imports
  `decide()` / risk weights / signatures (#3).
- **Tiered reset + fresh OOBE (Round 4).** A gated danger-zone reset (`engine/reset.py`,
  admin + fresh-auth, type-to-confirm) clears **cases** / **sources** / a full **factory**
  reset — but **env secrets are byte-identical across every tier** (airtight-tested) and the
  cost ledger + audit trail survive the cases tier. A factory reset flips back to a fresh
  first-run OOBE (`POST /api/setup/account`) that provisions the first super-admin with a
  forced strong password (self-locking so it can only be used once).
- **Playbook automation + threat context.** A **run-a-playbook** action
  re-investigates a case with a chosen playbook injected as context (recommend-only,
  #3-safe); **threshold automation** matches cases after the decision and may tag /
  recommend / notify / queue a playbook run / raise a HITL approval — but it **never
  sets status directly**. A **threat-context** panel assembles IOC reputation, a
  bundled MITRE ATT&CK corpus (697 techniques), and related cases (fail-open); a
  resolved-case → RAG knowledge loop lets future investigations learn from closures.
- **Settings-centric information architecture.** A single Settings surface
  (`GET /api/settings/schema`), reached as its own **Platform** nav item, is the home
  for nearly all configuration — organised into **5 groups × 25 sections**: Account
  (profile, account security, sessions, personal customization), General (sources,
  models, detection/rules, cases, automation, standup), Integrations (notifications,
  enrichment, knowledge), Security & access (users, roles, security, admin sessions,
  keys), and Organization (appearance/branding, advanced, demo, danger zone) — not a
  "Personal Account vs. Organization" two-scope split. Near-duplicate top-level pages
  were consolidated into tabbed surfaces, with RBAC hiding sections the signed-in role
  can't see. Everything rides `GET/PUT /api/settings` (deep-merge + validate).
  **Round 5** replaced the old 2673-line Settings god-file with a **data-driven
  section registry** (one file per section), collapsed **6 → 5** nav groups,
  **promoted Security to top-level**, and capped nesting at two levels — deep-links
  preserved (redirect-tested).
- **Rules customization — a Detection & Rules editor (Round 5).** A first-class home for
  editing rules across **three tiers** — detection-match / threshold rules, anomaly /
  baseline rules, and case-automation — behind a **polymorphic editor** with a flat
  condition builder, threshold `NumberField` / slider controls, and asset / SLA / priority /
  suppression editors. **Test / Preview a rule against recent data** without touching
  production: preview is a **pure what-if** (`POST /api/triage/preview-decision`) that
  **never calls `decide()` and never bills the LLM** (#3/#6). Every change is captured in a
  **version ledger with one-click rollback** (a zero-migration `rule_versions` KV store).
- **Custom dashboards (Round 5).** Build your own dashboards from a **widget registry that
  reuses the existing tiles and charts** — a per-user **drag / resize grid**
  (`react-grid-layout`, lazy-loaded only in edit-mode) persisted in a zero-migration
  `DashboardStore` (`GET/PUT /api/dashboards`). Admins ship **per-role defaults**; any user
  can **clone-to-customize** their own layout.
- **A refreshed, accessible design system (Round 5).** One cohesive **shadcn / Radix /
  Tailwind** standard end-to-end: a Radix slate + blue base with three orthogonal semantic
  axes (severity / status / verdict) whose contrast is **measured WCAG-AA in both light and
  dark themes**, Okabe-Ito colour-blind-safe chart ramps, and self-hosted **Inter +
  JetBrains Mono**. A shared primitive set (`Field` / `SegmentedControl` / `NumberField` /
  `LabeledSlider` / `PageContainer` / …) + one card grammar are enforced across the console
  (adopted via a codemod). Dashboards use the full page width, the page header is compact
  (~52 px), and an accessibility pass enforces **20 `jsx-a11y` lint rules at error** with
  `jest-axe` coverage and non-color status signalling (WCAG 2.2). Under the hood a single
  `FEATURES[]` registry derives the nav, routes, and command palette, and `React.lazy`
  code-splitting brought the entry bundle to **264 kB** — none of which changes any API path
  or the deterministic decision.
- **The Security Command Center + Noise-Reduction funnel (Rounds 7–9c).** The Overview is a
  **Security Command Center**: a masthead + a 5-tile alert/case KPI strip (LLM spend was
  dropped from the hero, demoted to a "Deeper analytics" tripwire), a bigger **Active Risk
  Index** card with a `(?)` explainer, real **MTTD** (first-event → case-open) and
  **MTTR-as-first-human-response** (the ACK clock — an AI auto-close is never counted as a
  human response) with trend deltas, and a burndown chart. A durable-counter **Noise
  Reduction** ribbon (`GET /api/metrics/noise-reduction`) flows `ingested → clustered → cases
  → auto-cleared by AI → escalated → closed (by human)`, showing exactly how far the AI cut
  raw alert volume down to cases and how the survivors were disposed of. Every triage value
  carries a `source | ai | code` **provenance** tag; the case view is retold as a clean story
  (facts → AI assessment → the pinned deterministic `DecisionCard`); feedback is captured at
  close; auto-closed cases are badged as such — all additive, `decide()` byte-identical.
- **QRadar-style Sources + Cases (Round 9/9c).** **Sources** is a standalone "Log Source
  Management" `DataTable` (search/filter/"+ New"/columns-gear/bulk-select/inline Enabled
  switch/Status/Last Event via `GET /api/sources/health`) instead of a card layout. **Cases**
  is a dense incident-summary list (a 6-tile summary strip, a monogram Assignee column).
- **CaseDetail Timeline vs. Investigation (Round 9/9b).** The case view splits "what
  happened" (a **Timeline** narrative: input → correlate → risk → triage → investigate →
  decide) from "why" (an **Investigation** tab: the AI's assessment, the pinned deterministic
  `DecisionCard`, and the full ReAct trace) — six tabs total
  (`overview | timeline | investigation | threat | collab | chat`).
- **Local / self-hosted LLM provider (Round 9).** Add any OpenAI-compatible endpoint
  (LiteLLM router, vLLM, Ollama, LM Studio) at runtime from the UI — no rebuild, no new env
  var required. Backed by a zero-migration custom-models store
  (`POST/DELETE /api/llm/models/custom`), a non-metered `POST /api/llm/providers/test`
  reachability probe, and $0 pricing end-to-end (the ledger meters a real $0, never the
  conservative default rate).
- **Comprehensive ingestion + autopilot smart defaults (Round 10).** `background_scan_enabled`
  is now **default TRUE**: every event from every source is correlated, risk-scored (0–100),
  and made visible — nothing is silently dropped. `events`-role clusters auto-forward to the
  strong-LLM investigation through a **deterministic risk gate**
  (`auto_investigate_risk_floor`, default **70** — the cross-vendor "High" entity-risk band
  start); below-floor clusters stay **$0 candidates**, never dropped (#4). `alerts`-role feeds
  bypass the gate entirely and correlate in `mode=EVERY` (same-signature bursts still coalesce
  onto one open case, so every alert becomes exactly one case). A per-source per-tick cap
  (`caps.max_auto_investigations_per_tick`, default **25**) throttles investigation volume —
  cap-deferred candidates drain to investigation on a later tick once headroom frees,
  investigations run **sequentially**, and the push path is symmetric with pull; a single
  **daily budget is the global spend bound**. Alongside it, an **autopilot dial**
  (`Preferences.autopilot_profile`: `conservative` / `balanced` / `aggressive`, default
  `balanced`) turns a bundle of already-$0/#3-safe engines **default ON** — threshold tuning
  (shadow-eval forced on), campaign correlation, cross-source correlation, SLA policy, the
  priority matrix, realtime SSE, threshold automation (empty ruleset), and entity baselining
  (producer + a silent-source detector) — and scales `(risk_floor, daily_usd, cap)` per
  profile: conservative **90 / $5 / 10** · balanced **70 / $10 / 25** · aggressive
  **40 / $50 / 100**. Batch, warning-only budget mode, default notify/run-playbook rules, and
  baseline-driven investigation stay explicit opt-in. A **default budget backstop**
  (`BudgetConfig` now `enabled=True`, `daily_usd=$10` — roughly a coffee budget, ~10× below
  AI-SOC entry pricing —, `soft_warn_pct=0.80`, `on_exceed="block"`) keeps "read everything by
  default" from becoming "spend everything": the provider call is stopped and the case routes to `NEEDS_HUMAN`, never a
  silent close (#3). A **stored pre-overhaul config auto-adopts** the new defaults exactly
  once (an `autopilot_config_version` marker, preserving any opt-outs set after it), and the
  `AutomationNudge` card is **inverted** into a reassurance banner ("autopilot is on — here's
  what it's doing / turn it off").
- **Coverage observability (Round 10).** `GET /api/sources/health` gains a per-source
  last-poll snapshot (`last_poll_at` / `last_poll_ok` / `last_poll_error` / `events_per_min` /
  `silent`) and now reports `ok:false` when every feed on a multi-feed source is failing; a new
  `GET /api/sources/coverage` rollup (`sources_total` / `sources_enabled` / `sources_silent` /
  `events_per_min` / `alerts_triaged_24h` / `worst_last_event_seconds`) and `AuditDoc.source_id`
  (`GET /api/audit?source_id=`) make "is anything going dark" answerable at a glance. The
  webui adds a Sources coverage banner + server-truth per-row status, an Overview coverage
  tile, and an honest "awaiting / candidate" stage in the Noise-Reduction funnel.
- **motion.dev page transitions (Round 10).** A single new runtime dep, **`motion` 12.42.2**
  (replacing the `framer-motion` removed in Round 5), lands **lazily** — `LazyMotion` + `m` +
  `domAnimation` + `MotionConfig reducedMotion="user"` — in an ~83.85 kB chunk that is never
  modulepreloaded, so the entry chunk holds at **281.44 kB**. Animates route/page transitions,
  the CaseDetail tab enter, the Cases bulk-bar exit + row reflow, the NavSidebar rail, and
  dashboard KPI count-ups (a dynamically-imported `AnimatedNumber` inside `KpiTile`);
  reduced-motion users get instant snaps, not disabled motion.

## Quick start (deploy)

The fastest path is the self-contained compose file
[`deploy/docker-compose.agnostic.yml`](deploy/docker-compose.agnostic.yml)
(Postgres + pgvector + Redis + backend + web UI — no Elasticsearch needed for the
app's own state):

```bash
cp .env.example .env        # set TLSOC_PG_PASSWORD + at least one LLM key
docker compose -f deploy/docker-compose.agnostic.yml up -d --build
# then open http://localhost:8080 and complete the first-run wizard
```

You add your SIEM/EDR/XDR **in the wizard** ("add a source"). For the full recipe,
TLS/CA mounts, push-receiver port publishing, and the legacy ELK path, see
**[DEPLOY.md](DEPLOY.md)**.

**Legacy path:** to merge into an existing ELK stack as a read-only consumer, use
[`deploy/docker-compose.tlsoc.yml`](deploy/docker-compose.tlsoc.yml). The Kibana
plugin itself is **archived** (`archive/kibana-plugin/`) — this path attaches the
backend + standalone webui to your existing Kibana/ELK stack, it does not install
the plugin.

## Connectors / how data gets in

| Source / transport | Type | `SourceType` | Mode | How |
|---|---|---|---|---|
| Elasticsearch | pull | `elasticsearch` | `pull` | poll `_search` on a durable cursor |
| OpenSearch | pull | `opensearch` | `pull` | poll `_search` (ES-API compatible) |
| Wazuh | pull | `wazuh` | `pull` | poll the Wazuh indexer (OpenSearch `wazuh-alerts-*`) |
| Webhook | push | `webhook` | `push_http` | `POST /api/ingest/{source_id}` (JSON/NDJSON/CEF/LEEF) |
| Splunk HEC | push | `hec` | `push_http` | `POST /api/ingest/{source_id}` (HEC-compatible) |
| Syslog | push | `syslog` | `push_syslog` | background UDP/TCP/TLS listener (RFC 3164/5424) |
| Kafka | push | `kafka` | `queue` | background consumer |
| AWS SQS / Kinesis | push | `aws_sqs` / `aws_kinesis` | `queue` | background consumer |
| Azure Event Hub | push | `azure_event_hub` | `queue` | background consumer |
| GCP Pub/Sub | push | `gcp_pubsub` | `queue` | background consumer |
| RabbitMQ / NATS / MQTT / Redis Streams | push | `rabbitmq` / `nats` / `mqtt` / `redis_streams` | `queue` | background consumer |
| S3 / GCS / Azure Blob | push | `s3` / `gcs` / `azure_blob` | `object_store` | list + get on an object cursor |
| File | push | `file` | `object_store` | local file/directory tail |

Webhook/HEC ingest over `POST /api/ingest/{source_id}`; syslog/queue/object-store
receivers run as background receivers. Sources are managed through the wizard or
the backend API (`GET /api/connectors`, `GET|POST|DELETE /api/sources`, per-source
secrets via `POST /api/sources/{id}/secrets`). Full reference:
[`docs/INGESTION.md`](docs/INGESTION.md).

**Current limits (be aware):** the poller now fans out over **every enabled PULL source**
you configure in the wizard (each with its own connector, TLS, and durable per-feed
cursor). The bootstrap `ES_URL` + read-only `ES_API_KEY` seed the primary ES-API-compatible
cluster (Elastic / OpenSearch / Wazuh); additional pull sources are added through the
wizard. **Native** Splunk / Sentinel / QRadar / Chronicle / CrowdStrike / Defender pull
connectors are still on the roadmap (the `SourceType` enum already reserves their names).
**Push / queue / object-store ingestion is unlimited** — run as many receivers of as many
types as you like, in parallel with the pull sources.

## Repository layout

```
backend/                FastAPI + LangGraph backend (all agentic logic) + tests
  app/
    ocsf/               OCSF canonical schema + ECS→OCSF mapping
    connectors/         connector SPI + registry; elastic · opensearch · wazuh (pull)
      receivers/        16 push/queue/object-store receivers + format parsers
    engine/             correlation (+ cross-source) · risk · cost_gate · case_manager ·
                        case_id · threshold_automation · threat_context · mitre · poller
    agents/             router · investigator (ReAct) · formatter · chat · standup · graph
    auth/               passwords · tokens (JWT) · service · mfa (TOTP) · oidc (SSO)
    rbac/               policy (role → resource → action permission matrix)
    notifications/      channel (ABC) · email · slack · teams · webhook · pagerduty ·
                        telegram · dispatch (dedup/rate-limit/digest) · templates
    threat/             bundled MITRE ATT&CK technique corpus (mitre_techniques.json)
    stores/             cases · usage · config · cursor · users (+ audit) ·
                        dashboards (per-user custom-dashboard layouts) ·
                        rule_versions (detection-rule version ledger + rollback)
      sql/              SQL StateStore: engine · models · repositories · vectorstore
    api/                routes (decomposed into domain routers, byte-identical paths) · deps ·
                        routes_rules · routes_dashboards · … · state.py · main.py
webui/                  standalone Vite + React + Tailwind + shadcn SPA (primary UI)
  src/soc/rules/        Round-5 Detection & Rules editor (polymorphic editor + preview + versioning)
  src/soc/dashboard/    Round-5 custom-dashboard builder (widget registry + drag/resize grid)
  src/soc/registry.tsx  Round-5 the single FEATURES[] registry (derives nav + routes + palette)
deploy/                 docker-compose.agnostic.yml (self-contained) ·
                        docker-compose.tlsoc.yml (legacy ELK) · mappings · dashboards
docs/                   USAGE · INGESTION · AGNOSTIC_ARCHITECTURE · ENVIRONMENT ·
                        TROUBLESHOOTING · RUNBOOK · research/2026-0X-roundN/
archive/kibana-plugin/  ARCHIVED (frozen 2026-06-21) Kibana plugin — not built/
                        tested/shipped; superseded by webui/
```

## Configuration

Secrets and the state backend are set via environment (`.env`; see
[`.env.example`](.env.example) — `STATE_BACKEND`, `STATE_DB_URL`, LLM keys,
enrichment keys, optional `ES_URL`/`ES_API_KEY` for a pull source). Everything
operationally tunable (correlation rules, risk weights, per-role/per-rule models,
caps, kill switch) lives in UI-editable **Preferences**, surfaced in Settings and
the first-run wizard. The UI shows secrets as booleans (`configured ✓`), never the
values.

**Cloud LLM + enrichment providers (Round 3, all optional + default-off).** Beyond
`ANTHROPIC`/`OPENAI`, the gateway now supports **Azure OpenAI**, **AWS Bedrock**
(stdlib SigV4, no `boto3`), **Google Vertex**, and any **OpenAI-compatible** `base_url`
(vLLM/Ollama/OpenRouter/Together/Groq — no new key). Enrichment was generalized into an
`EnrichmentProvider` SPI with **19 registered providers** (**+17 new** in Round 3 on top
of the existing AbuseIPDB + VirusTotal; the abuse.ch entry spans the urlhaus / threatfox /
malwarebazaar classes): keyless Shodan InternetDB / abuse.ch trio / RDAP-DoH default-on;
AbuseIPDB / VirusTotal / GreyNoise / Shodan / Censys / BinaryEdge / IPinfo / OTX /
Pulsedive / Spur / X-Force / URLscan / HIBP / Project Honeypot keyed + default-off —
multi-indicator across IP/domain/hash/url/email. All keys are env-only `TLSOC_*` entries
(see [`.env.example`](.env.example) and `docs/ENVIRONMENT.md` §2.6–2.7); enrichment is
advisory only and never feeds the deterministic close/escalate decision.

## Status & verification

Verified offline (backend re-verified 2026-07-15 after a backend deep-audit hardening
pass — **47 findings fixed**, one atomic commit each): **1942 backend tests green** (0
failures; fake/in-memory backends + mock LLM, no network — an autouse `conftest` network
guard keeps the enrichment tests offline); the standalone **web UI builds clean** (`tsc` +
Vite, entry chunk **285.91 kB** — a lazy `motion` chunk of **83.85 kB** sits off the
critical path, never modulepreloaded) with a dev-only Vitest harness (**1349 tests** / 240
files, unchanged — the audit pass touched no webui code); eslint clean (**0 errors, 0
warnings**, with 20 `jsx-a11y` rules at error). Generated API contracts, all five design
gates, the distribution smoke tests, version/Compose contracts, and strict public docs
build are also green. The deterministic close/escalate authority (`decide()`) was verified
clean by the audit and is untouched. (Test counts rise each round — see `Journal.md` and
`CHANGELOG.md` for the exact current totals and the audit-fix list.)

**Round 10** (2026-07-09, current — "Autopilot & Comprehensive Ingestion + motion.dev": a
**behavior change** that flips the suite from "reads what you tell it to" to "reads +
reasons over everything by default" — `background_scan_enabled=True`, a deterministic risk
gate (`auto_investigate_risk_floor`, default 70) routes every correlated cluster to
investigation or a $0 candidate, ALERT feeds bypass the gate and coalesce same-signature
bursts onto one case, a per-tick investigation cap drains on later ticks, and a new
`autopilot_profile` dial (conservative / balanced / aggressive) turns tuning / campaigns /
cross-source correlation / SLA / priority / SSE / automation / baseline default ON —
backstopped by a default-enabled $10/day budget ceiling (over-budget → `NEEDS_HUMAN`,
never a silent close, #3), an auto-adopt migration + one-time banner for existing tenants,
per-source coverage observability (`GET /api/sources/coverage`, per-source last-poll
health), and lazy `motion.dev` page-transition animation) followed **Round 9c** (the
dashboard rebuilt from scratch: real **MTTD** + **MTTR-as-first-human-response** off the
ACK clock, a burndown chart, a terminal "closed by human" noise stage, a cleaner Cases
list) followed **Round 9b** (hover-to-expand sidebar, the noise-reduction ribbon restored +
polished, a CaseDetail Timeline/Investigation redesign, a wider case sheet) followed
**Round 9** (an 11-ask UI/UX overhaul: removed redundant in-page tab strips, a QRadar-style
Sources `DataTable`, the CaseDetail Timeline/Investigation split, a local self-hosted
LiteLLM model provider, login/wizard fixes) followed **Round 8** (UI cleanup + glitch
fixes) followed **Round 7** (the Security Command Center + the Noise-Reduction funnel)
followed **Round 6** (a ~500-agent Opus fleet glitch-hunt, 464 adversarially-verified
findings fixed) followed **Round 5** ("UI/UX overhaul + rules customization + custom
dashboards + loose coupling" — a cohesive WCAG-AA color system + one enforced
shadcn/Radix/Tailwind design standard, a decluttered data-driven Settings, a wider
dashboard + compact hero, a **Detection & Rules editor** with rule versioning + a
**pure-what-if preview that never bills the LLM**, **custom per-user dashboards**, and a
loose-coupling refactor — a single `FEATURES[]` registry and a domain-router decomposition
with byte-identical API paths) followed **Round 4** ("fix the logic, fine-tune the
product" — the multi-source poller fix + 2 more confirmed bugs, adaptive threshold
auto-tuning, two-tier alert/event ingestion with campaign correlation + agent-driven event
detection, an entity baseline, batch/flex + a broadened correctly-priced model catalog, a
unified log view, tiered reset + fresh OOBE, and a white-label login) followed **Round 3**
(12 requests: expandable nav, richer Settings real-estate, deeper branding/material,
per-case human+AI collaboration, a posture dashboard + MITRE coverage, fine-grained
custom-role RBAC, +17 new enrichment providers (19 total), in-app notifications, a
standardized Models page, distinctive UI, a forward-looking Standup, and clearer cases +
agent-work visualization), **Round 2** (login redesign + account self-service, sessions +
token policy, the Settings-centric IA, Demo Mode, per-feed sources, Resend/SES + email
templates, per-user customization, command palette + global search + bulk actions + audit
viewer), and the seven-wave overhaul before it — every round was **additive** and left
`case_manager.decide()` byte-identical to the pre-Round-5 baseline `27f0983` (CI-verified
every round since; Round 10 also left `risk.py`/`signatures.py` untouched — the new risk
gate only *routes* on `compute_risk()`'s existing output, it never changes scoring or the
decision). The backend stayed **zero-new-runtime-dep** through every round; Round 5 added
exactly **one** lazy webui runtime dep (`react-grid-layout`, dashboard edit-mode only) and
removed `framer-motion`; Round 10 added exactly one more, equally lazy, dep (`motion`
12.42.2, page-transition animation only) — zero other deps added or removed since. The 12
non-negotiables held throughout — note that #10 ("sane defaults") now *means*
smart-autopilot-on, and #3 (`decide()` is the sole close/escalate authority) still holds:
the Round-10 risk gate is routing only. Repeated adversarial audits (16-dimension audits on
Rounds 4/5, a ~500-agent fleet on Round 6, smaller adversarial-validation passes on Rounds
7–10, Round 10's own pass finding 5 major + 6 minor issues, all fixed before re-verify)
found and fixed real issues every time. A shipped security fix inverted RAG-knowledge
fencing to a TRUSTED allowlist (`runbook`/`mitre`/`suppression` only — operator-imported
documents stay UNTRUSTED-fenced) so imported documents can no longer reach the model
unfenced (OWASP LLM01). Live-stack validation against a real SIEM is a deploy step. New
here? See [`docs/HANDOFF.md`](docs/HANDOFF.md). See [`CHANGELOG.md`](CHANGELOG.md) for the
full per-round change history and [`ROADMAP.md`](ROADMAP.md) for live backlog status.
