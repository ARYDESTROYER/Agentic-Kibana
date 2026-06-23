# Changelog

All notable changes to the **TLSOC Agentic Triage Suite** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Target platform: Elastic / Kibana / Elasticsearch **8.19.12** (legacy **8.12.2**
kept). History is reconstructed from `git log`.

## [Unreleased] — 2026-06-23 — Browse a source's logs + read-only Test-connection & per-source TLS fixes

Backend offline suite **349 tests green** (was 340); webui `npm run build` GREEN,
no new npm deps. Additive; the spine and the 12 non-negotiables are intact.
Developed on the `Testing` branch.

### Added
- **Browse a source's logs** — `GET /api/sources/{id}/logs?limit=&query=&from=&to=`
  (auth-protected). **Pull** sources (Elasticsearch / OpenSearch / Wazuh) run a
  bounded (hard-cap **200**), read-only, field-mapping-aware scoped search honoring
  the source's own `data_view_pattern` / field mapping / TLS; **push** sources return
  the last N events from a new in-memory **live-tail ring buffer** (cap 500/source)
  in `IngestService` (or `501` if the connector does not support browse). Each row is
  `{ ts, source_ip, user, host, rule, severity, message, _raw }` — `_raw` is the full
  log document; **secrets are never returned**. `404` for an unknown source, `502`
  for a read failure.
- **`capabilities: ["browse"]`** on the pull connector manifests, auto-applied to
  every push receiver (`registry._with_browse`), so the UI shows the Logs tab only
  where it is supported.
- **webui — `SourceLogsFlyout`** — a per-source Logs panel (opened by a "Logs"
  button on each source card, gated on the connector's `browse` capability): an
  `EuiBasicTable` (timestamp · source.ip · module/rule · severity · message) with
  expandable rows showing the raw `_source` in an `EuiCodeBlock`, a search box, an
  `EuiSuperDatePicker` time range (default last 15m), and a **10s live-tail
  auto-refresh** toggle. All log content renders as plain text / code blocks
  (UNTRUSTED-safe, non-negotiable #9). `api.sourceLogs` + types added; no new deps.

### Changed / Fixed
- **Test connection now works for read-only API keys.** `ElasticConnector.test_connection()`
  no longer gates on `ping()` (a correctly-scoped read-only key cannot do `HEAD /`).
  It runs the cheap scoped read-only search **first**; HTTP 200 (any/zero hits) →
  `ok:true, mode:"read_only"` with a green *"Read-only access verified — N events
  readable in <pattern>. Cluster-monitor privilege not granted (expected for a
  read-only key)."* `ping()` is now only an extra `cluster_monitor` signal
  (`mode:"full"` when present), never the pass/fail gate; `ok:false` only when the
  scoped read fails (auth `401`/`403` on the index, or network/TLS). `ConnectionTest`
  gained `mode` + `cluster_monitor`; the webui Test-connection result renders the
  read-only / full success callout.
- **Per-source TLS is now honored.** Pull connectors previously used the global ES
  client + field-mapping config only, so a source's `es_verify_certs:false` /
  `es_ca_cert` / `es_url` / `es_api_key` never applied (observed
  `CERTIFICATE_VERIFY_FAILED` despite `es_verify_certs:false`). Now
  `AppState.es_client_for_source()` builds a **per-source ES client** from the
  source's merged config + secrets (dropping any global mgmt key); the primary log
  source and the browse endpoint use it, and owned clients are closed on
  rebuild/shutdown. Sources with no overrides keep using the shared global client
  (no behaviour change).

## [Unreleased] — 2026-06-22 — Case explainability, RAG management & visibility, agent memory + dashboards/collaboration

Backend offline suite **340 tests green** (was 310); webui `npm run build` GREEN
(2330 modules), no new npm deps. Additive; the spine and the 12 non-negotiables are
intact. Developed on the `Testing` branch.

### Added
- **RAG ingest + management + visibility ("see the RAG")** — `engine/chunking.py`
  (`chunk_text`, a dependency-free paragraph-pack + overlap chunker); the
  `VectorStore` ABC gained `list_documents()` / `list_chunks()` / `delete_document()`
  / `stats()` (implemented in the InMemory, ES `dense_vector`, and SQL stores) — a
  "document" is the chunks sharing `metadata["document_id"]`, seeds grouped as
  `seed:<source>`. `RagService` gained `import_document(title, text, *, source, tags)`,
  `list_documents()`, `get_document(id)`, `delete_document(id, *, force)`,
  `rag_stats()`; the built-in seed sources (`runbook` / `mitre` / `suppression` /
  `resolved_case`) are **guarded against deletion unless `force=true`**. New routes:
  `GET /api/rag/stats`, `GET /api/rag/documents`, `GET /api/rag/documents/{id}`,
  `POST /api/rag/import`, `DELETE /api/rag/documents/{id}?force=`, and
  `GET /api/rag/search?q=&top_k=` (run a live retrieval to SEE what RAG returns).
  Tests: `test_rag_management.py` (11).
- **Agent memory (Claude.ai-style durable operator facts)** — `stores/memory.py`
  `MemoryStore`, backed by the existing **KVStore** (no new index or migration: ES
  via a new `EsKVStore` adapter on the config doc, SQL via `SqlKVStore`); a
  `MemoryEntry` model (`id`, `text`, `category`, `tags`, `source` (`human`|`agent`),
  `author`, `created_at`, `updated_at`, `active`). Memory is auto-injected into BOTH
  automated investigations and chat as a DISTINCT **`<<<MEMORY>>>` TRUSTED block**
  (separate from the fenced UNTRUSTED evidence), with the precedence
  policy > base > playbook > MEMORY > untrusted; `prompts.render_memory()` + `fence()`
  neutralise forged `<<<MEMORY>>>` markers. **Memory NEVER overrides the deterministic
  CaseManager** — it only informs the LLM. Editing is EXPLICIT: REST
  (`GET/POST/PUT/DELETE /api/memory`, `source=human`) or conversationally in chat
  ("remember:" / "forget", `source=agent`, user-directed text only, audited). The
  chat JSON contract gained `memory_action` (executed deterministically + audited)
  and `memory_suggestion` (returned for UI confirm, never auto-saved). Tests:
  `test_memory.py` (14).
- **Case explainability** — the investigator now emits a **CONTEXT audit record**
  (new `ActionType.CONTEXT`) summarising the persona / playbook / memory / knowledge
  (RAG snippets) / enrichment it was given, and the VERDICT record carries a reasoning
  excerpt. New `GET /api/cases/{id}/rationale` assembles a pure, defensive "why"
  object: verdict / confidence / status / decision_by, persona, playbook (+ reason),
  `memory_used[]`, `knowledge[]` (RAG/runbook source + snippet), enrichment,
  `tools[]` (the commands / ES queries the agent ran), reasoning, the **DETERMINISTIC
  `decision_rationale`** (the close/escalate rationale), `mitre[]`, and `evidence[]`.
  Tests: `test_explainability.py` (5).
- **webui — Knowledge & Memory pages + the case "Why" tab** —
  - **Knowledge page** (`components/Knowledge/KnowledgePage.tsx`): RAG corpus stats
    header; import (paste textarea + `.txt`/`.md`/`.json`/`.csv` file upload read
    client-side); a documents table + chunk drill-in flyout; guarded force-delete;
    and a "Try a retrieval" search showing exactly what RAG returns. New **Platform**
    nav entry.
  - **Memory page** (`components/Memory/MemoryPage.tsx`): add / inline-edit / delete /
    active-toggle durable facts; human-vs-agent source badges; an explainer that you
    can also say "remember:" / "forget" in Chat. New **Platform** nav entry.
  - **Case "Why" tab** (`CaseDetailFlyout.tsx`): consumes `/cases/{id}/rationale` —
    the deterministic decision (prominent), agent reasoning, knowledge used (RAG /
    runbook snippets with provenance), the exact commands / queries the agent ran,
    operator memory applied, enrichment, playbook, and MITRE; plus trace-tab polish.
  - **Chat memory UI** (`ChatPage.tsx`): a calm memory-action confirmation echo + a
    dismissible "remember this?" suggestion that calls `POST /api/memory`, with a
    per-message double-save guard.

### Changed
- **Dashboards** — the Metrics page gained a "Knowledge base & memory" section (RAG
  docs/chunks, embedding model + dim, memory facts/active, corpus-by-source,
  memory-by-author); the Overview gained compact RAG/memory nav tiles. Loading is
  non-fatal.
- **Cases list collaboration** (`CasesPage.tsx`) — a sortable assignee column, tags +
  comment-count badges, and collaboration / assignee filters.
- All attacker-influenceable text (RAG chunks, memory text, tool queries, tags, chat
  suggestions) renders as plain text / `EuiCodeBlock` — never
  `dangerouslySetInnerHTML` (non-negotiable #9 upheld). A review pass fixed one
  invalid EUI icon.

## [Unreleased] — 2026-06-22 — Wave 3: metrics, feedback loop, collaboration, white-label UI + CI

Backend offline suite **310 tests green**; webui builds clean. Additive; spine
untouched. Developed on the `Testing` branch.

### Added
- **Analytics / metrics dashboard** — `engine/metrics.compute_metrics` (verdict &
  status mix, persona/playbook usage, avg risk, coarse MTTR, per-day trend) +
  `GET /api/metrics` (merges the cost ledger), surfaced as a new **Metrics** page.
- **AI-decision feedback / grading loop** — `Case.feedback` (append-only),
  `POST /api/cases/{id}/feedback`, `GET /api/feedback/stats` (agreement rate, grade
  averages, outcome mix, time saved). UI: a grading widget in the case flyout +
  a feedback-quality panel on the Metrics page. Measures triage quality / builds
  an eval corpus.
- **Case collaboration** — `Case.tags/comments/assignee`; `POST /api/cases/{id}/
  {comment,tags,assign}`; flyout UI (comments thread, tag editor, assignee) + tag
  chips/filter on the Cases list.
- **Org branding / white-label** — `BrandingConfig` (org/product name, logo upload
  as a validated base64 data URL, primary+secondary accent, theme) on Preferences;
  public `GET /api/branding` + protected `PUT`. UI: a runtime-themeable design
  system (accent via CSS vars), a Branding settings panel with live preview, and a
  branded shell + login screen.
- **Case export** — `GET /api/cases/{id}/export?format=json|md` + a flyout export
  menu (no-dep Blob download).
- **Case hover preview** — a rich, debounced, keyboard-accessible hover card on the
  Cases list / Scans board / Overview rows (verdict, risk gauge, entity, persona,
  playbook, evidence, MITRE, age).
- **CI/CD** — `.github/workflows/ci.yml` gates every PR on the offline backend
  suite (incl. the auth route-coverage test) + the webui build, with an aggregate
  `CI passed` check to require in branch protection (see CONTRIBUTING.md).

### Changed
- Web UI visual overhaul: skeleton loaders, `PageHeader`, KPI deltas, flat nested
  cards, inline-markdown chat, hero numbers, copy/print, capped badge rows, page
  fade-ins, `prefers-reduced-motion` support. Fixed the dead Scans card click and
  the Cases stat-tile/total mismatch.

## [Unreleased] — 2026-06-21 — Wave 2: Markdown playbooks + optional auth

Backend offline suite **300 tests green**; webui builds clean. Additive; the spine
(typed OCSF, StateStore, one LLM gateway, durable cursor) is untouched.

### Added
- **Markdown playbook engine** (`backend/app/playbooks/` + `backend/playbooks/*.md`):
  operator-authored phased procedures with strict-validated YAML front-matter
  (`PlaybookManifest`), a deterministic, explainable `PlaybookRegistry.select`
  (rule_ids / entity_types / min_event_count are hard criteria; mitre/tags are
  advisory — clusters carry no MITRE pre-investigation), atomic hot-reload, and the
  matched playbook injected as a DISTINCT `<<<PLAYBOOK>>>` TRUSTED block separate
  from the fenced UNTRUSTED evidence (+ a precedence line). It can only RECOMMEND.
  3 seed playbooks (brute-force login, suspicious outbound, reported phishing).
  Endpoints: `GET /api/playbooks`, `POST /api/playbooks/reload`,
  `GET /api/playbooks/selection/{case_id}`. `Case.playbook_id` + audit record the
  selection/fallback. A playbook's `rag_queries` augment retrieval (bounded by top_k).
- **Optional auth (default OFF — the no-auth "old version" remains the default and
  fully available)**: stdlib-only `app/auth/` (PBKDF2 password hashing + HS256 JWT)
  + `app/middleware/` (security headers / CSRF / Redis-free rate limit); a
  router-level `require_auth` gate that is a strict no-op when disabled, with a tiny
  `PUBLIC_API_PATHS` allowlist; `/api/auth/{login,me,logout}`; and a CI
  route-coverage test that fails if any `/api` route bypasses auth.
- webui: an optional login gate (no-op when auth is off) + a read-only
  **Playbooks & Agents** catalog surface.

### Changed
- **Case Manager → operator-configurable `AutoClosePolicy`** (`engine/case_manager.decide`
  is now a pure fn over `(verdict, confidence, risk_score, policy)`): per-verdict-class
  enable / min-confidence / max-risk / objection-window. FALSE_POSITIVE auto-closes
  above a bar by default; **TRUE_POSITIVE auto-close is an explicit opt-in (off by
  default)**; **NEEDS_HUMAN never auto-closes (code-enforced)**. The deprecated
  `fp_auto_close` is migrated into `auto_close.false_positive` for stored configs.
  (This generalises the old "a TP is never auto-closed" invariant into a tunable,
  code-enforced policy — see CLAUDE.md non-negotiable #3.)
- Runbooks are now the RAG **knowledge** corpus only; per-cluster procedure
  injection is owned by the new playbook system.

## [Unreleased] — 2026-06-21 — Vigil-inspired overhaul (Wave 1) + plugin archived

A deep end-to-end study of the open-source **Vigil** AI-SOC (10 Opus research
agents; see `docs/VIGIL_STUDY.md`) drove an additive overhaul that keeps our
spine (typed OCSF, `StateStore`, the single LLM gateway, deterministic case
manager) fully intact. Backend offline suite: **244 tests green**; webui builds
clean (`tsc` + Vite).

### Added
- **Multi-agent roster** (`backend/app/agents/personas.py`): a declarative
  `AgentPersona` registry (identity / web-app / network-recon / malware /
  threat-intel + generalist) over the ONE investigator. The cluster is routed to a
  specialist deterministically; the persona specialises the system prompt and is
  recorded on the case + audit. `GET /api/personas`. Surfaced as a badge on the
  case-detail flyout.
- **Plain-text runbooks** (`backend/app/runbooks/*.md` + `engine/runbooks.py`):
  Markdown playbooks with frontmatter, selected per cluster and injected as TRUSTED
  guidance into the investigator, and indexed into the RAG corpus. `GET /api/runbooks`.
- **Hybrid RAG retrieval** (`tools/rag.py`): drawer-floor-first vector search +
  dependency-free BM25 re-ranking — recovers exact IOC/rule tokens that embed as
  noise. Toggle `rag.hybrid` (default on).
- **Tool safety tiers** (`constants.ToolTier` + `tools/base.py`): safe / managed /
  requires_approval / forbidden capability firewall; the investigator gates
  non-safe tools (proposes them for human approval, never auto-executes).
- **Cost provenance** (`llm/pricing.py`): `pricing_source` (exact / heuristic /
  zero / default) + a tier-prefix price heuristic, threaded onto every `UsageDoc`.

### Changed
- **Hardened untrusted-data fencing** (`agents/prompts.py` `fence()`): neutralises
  forged close-markers and carries `source=`/`tool=` provenance (non-negotiable #9).
- **Archived the legacy Kibana plugin** → `archive/kibana-plugin/` (history
  preserved). The standalone webui is now the sole supported surface.

## [2.0.0] — 2026-06-21 — Vendor-agnostic, self-hosted agentic SOC

The project transitions from an ELK/Kibana-coupled triage suite into an
**open-source, self-hosted, vendor-agnostic agentic SOC**. It now ingests from any
SIEM/EDR/XDR, normalises everything to OCSF, and ships its own standalone web UI —
the Kibana plugin becomes legacy/optional. Backend offline suite: **221 tests
green**; standalone web UI builds clean (`tsc` + Vite).

### Added

- **OCSF canonical schema** (`backend/app/ocsf/`). Every record, whatever its
  origin, is normalised to OCSF (with an ECS→OCSF mapping) before the engine
  reasons over it.
- **Connector SPI + registry** (`backend/app/connectors/`). A `PullConnector` /
  `PushReceiver` SPI, a process-wide registry, and a `tlsoc.connectors`
  entry-point group so out-of-tree connectors install via `pip` and appear in the
  wizard with zero core change.
- **PULL connectors — Elasticsearch, OpenSearch, Wazuh.** Poll an ES-API-compatible
  search API on a durable cursor (Wazuh reads the OpenSearch-based Wazuh indexer);
  per-source field mapping is set in the wizard.
- **16 PUSH / queue / object-store receivers + push runtime.** webhook, Splunk-HEC,
  syslog, Kafka, AWS SQS, AWS Kinesis, Azure Event Hub, GCP Pub/Sub, RabbitMQ,
  NATS, MQTT, Redis Streams, S3, GCS, Azure Blob, file. Formats parsed:
  JSON / NDJSON / CEF / LEEF / GELF / syslog / kv; optional client libs imported
  lazily (no new hard dependency). HTTP push lands via `POST /api/ingest/{source_id}`;
  syslog/queue/object-store receivers run as background receivers; all flow into the
  same `correlate → risk → cost-gate → LLM → case` pipeline the poller feeds.
- **Per-source secrets.** `POST /api/sources/{id}/secrets` stores secret field
  values in the in-memory secret tier (never persisted); only the field NAMES are
  recorded on the source.
- **Multi-source wizard backend.** `GET /api/connectors` (+ `/{source_type}`) lists
  every connector and its auth/config field schema; `GET|POST|DELETE /api/sources`
  and `POST /api/connectors/test` add, update, remove, mark-primary, and test
  sources.
- **SQL StateStore** (`backend/app/stores/sql/`). `STATE_BACKEND` selects where the
  app's OWN state (cases/audit/usage/config/cursor/RAG) lives: `elasticsearch`
  (default), `postgres` (asyncpg + pgvector), or `sqlite`. With postgres/sqlite, no
  Elasticsearch is required at all.
- **Standalone web UI + first-run wizard** (`webui/`, Vite + React +
  `@elastic/eui`). The new primary front door: a self-hosted SPA talking to the
  backend directly over `/api`, with a multi-step setup wizard (connector picker +
  dynamic per-connector form + connection test, LLM providers + per-role models,
  enrichment/detection defaults), a sources manager, and full Preferences editing.
- **Deploy artifacts.** `deploy/docker-compose.agnostic.yml` — a self-contained
  stack (Postgres+pgvector + Redis + backend + web UI; open http://localhost:8080,
  add the SIEM in the wizard) — plus a web UI container image (`webui/Dockerfile`).

### Changed

- **Kibana plugin is now legacy/optional.** The standalone `webui/` replaces it as
  the primary UI; the plugin and the legacy `deploy/docker-compose.tlsoc.yml`
  (merge-into-ELK) path remain for existing ELK deployments.

## [Unreleased]

Work-order cycle (live status in [`ROADMAP.md`](ROADMAP.md); session notes in
[`Journal.md`](Journal.md)). 8.19.12 zip rebuilt + verified; backend
`pytest -q` = 124 passed; plugin `tsc` clean. (Offline-verified only — there is no
live-stack validation this cycle.)

### Case detail flyout + unified cards + Settings nav (done)
- **Click-to-open now opens a right-side flyout** (`case_detail_flyout.tsx`) over any
  surface — no more scrolling to a detail panel at the bottom. The flyout has a header
  (entity + verdict/status/risk/confidence), tabs (Overview · Agent trace · History ·
  Ask) and a sticky footer with the contextual lifecycle actions + Re-investigate.
- **One unified case card** (`case_card.tsx`) and **one grid** (`case_grid.tsx`) now back
  Investigate, Automated Scans, and the Board: a severity-banded accent, a prominent
  (restrained) risk number, verdict/status chips, hover + selected states.
- **Grid controls:** a KPI strip, a sort control (risk/date), a filter popover
  (status · risk band · verdict) with removable active-filter chips, and an auto-filling
  responsive grid that fills the width. Shared case logic lives in `lib/cases.ts`.
- **Settings** now uses a **left section navigation** (all sub-sections listed on the
  left, the selected section on the right) instead of an accordion stack — every field
  preserved.
- **Full-width layout** (`restrictWidth={false}`) across the app to use the previously
  wasted horizontal space; a `casesVersion` signal keeps the grids in sync after a
  lifecycle change in the flyout. Removed the superseded inline `case_detail.tsx`.

### UI redesign — shared design system + every surface (done)
- **New shared design system.** `public/lib/format.ts` (date/money/number/percent
  formatters + `humanizeToken`) and `public/components/ui.tsx` (the single
  `COLORS` palette + `tint()`; `verdict/status/risk` colour helpers; reusable
  `SectionHeader`, `StatTile`, `EmptyState`, and `RiskBadge`/`VerdictBadge`/
  `StatusBadge`/`ConfidenceBadge`); plus layout utilities in `public/index.scss`
  (`tlsocIconChip`, `tlsocStatTile`, `tlsocCard`, `tlsocBoard__*`). No new deps.
- **Case Board** now usable: a **visible drag handle** AND a per-card actions menu
  (Open / Close / Escalate / Reopen) — both routed through the same confirm flow —
  fix the "can't move the cards" problem; columns sit in a horizontal scroll lane
  with coloured headers; cards carry a verdict/status accent + shared badges.
- **Investigate ("Security Investigation")** rebuilt to a supplied reference design:
  an IP/user/host search bar (`EuiFieldSearch`), an **Active Cases** 3-column card
  grid (ENTITY/RISK/RULES/CREATED with a prominent colour-coded risk number and a
  status pill), Refresh + a functional **Filters** popover, and a tall "Select a case
  to begin Agentic Triage" prompt that swaps to the case detail + follow-up chat on
  selection. A subtle global footer was added to the app shell. Uses the previously
  wasted horizontal/vertical space.
- **Automated Scans** rebuilt from a plain table into a KPI strip + a responsive
  card grid (entity icon, shared verdict/status/risk/confidence badges, formatted
  timestamps, Open / Reproduce / Why-this-fired) with a proper empty state.
- **Cost & Tokens** rebuilt into KPI tiles + weighted breakdown cards (proportional
  bars), a tidy dependency-free cost-over-time list, and a resilient top-cost-driver
  table.
- **Settings** visually refreshed (section header, accented section icons,
  `EuiHealth` credential status) with **every field and handler unchanged**.
- **App shell** — page-header description, per-tab icons + clearer nomenclature
  (Chat / Investigate / Case Board / Automated Scans / Standup / Cost & Tokens /
  Settings), wider layout. **Standup / Investigate / Case detail / Verdict card**
  adopt the shared badges + headers for a consistent console.
- Behaviour, data contracts, and the backend↔plugin API are unchanged — this is a
  presentation-only pass over the existing surfaces.

### Cycle 2 — bug fixes (done)
- **BUG-1 — chat does a real 2-turn analysis.** Turn 1 only chooses the query
  (before any rows exist); after the `es_query` runs, the engine re-prompts over a
  **compact, fenced-UNTRUSTED aggregate** of the results (top facets + time span +
  a few sample rows, never the raw dump) so chat shows analysis, not just a
  "fetching logs" preamble + table. Degrades to the turn-1 answer + row-count
  summary on any model error; both turns are metered (`agents/chat.py`,
  `prompts.CHAT_SYSTEM`).
- **BUG-2 — investigate no longer 400s on a fixed `now-24h` window.** New
  `Preferences.investigate_lookback` + per-request `InvestigateRequest.lookback` +
  an auto-widen ladder (configured → `now-7d` → `now-30d` → `now-365d`); the
  frontend renders a **neutral empty-state** ("No events found …") instead of a
  red error.
- **BUG-3 — the Standup tab no longer blanks.** `aggregate.cases` is now an object
  (`{ opened, by_status, by_verdict }`); the FE renders the opened tile +
  by-verdict / by-status tables, wrapped in an **error boundary**.
- **BUG-4 — header chat button contrast.** The global chat button is a native
  `EuiHeaderSectionItemButton` (correct light/dark contrast).
- **BUG-5 — correlation over a sliding look-back window.** Correlation now runs
  over the widest configured rule window (plus a margin, never less than a poll
  interval), not just the incremental poll batch, so a real-time burst spread
  across more than one poll interval still reaches its threshold
  (`engine/poller.py`).
- **IMPROVEMENT — manual-investigation provenance.** Manual investigations get a
  synthesized `TriggerReason` ("Why this fired"), a preserved `origin_surface`, and
  a normalized `reproduce_query`.

### Cycle 3 — features (done)
- **C3-1 — config-driven rule catalog.** `Preferences.rule_catalog` of
  `RuleDefinition { name, enabled, match{field,op,value}, correlation,
  model_override, priority }`; seeds the 13 real `event.module` rules + 5
  ModSec sub-rules (`modsec_xss`/`sqli`/`lfi`/`rce`/`scanner` by `rule.id` prefix,
  lower priority) into `tlsoc-agent-config` on first run. **Version-guarded** —
  never clobbers operator edits. Editable in Settings; this is how XSS-specific
  triggering is enabled.
- **C3-2 — Board tab.** A drag-and-drop Kanban of cases
  (Open · Needs human (escalated) · Closed); a drag maps to `close` / `reopen` /
  `escalate`.
- **C3-3 — agent trace.** `GET /api/cases/{id}/trace` + an "Agent trace" timeline
  on the case detail (router / investigator / tool-calls / verdict / formatter /
  case-manager, projected from `tlsoc-agent-audit`). `prefs.trace.include_prompts`
  gates whether prompt excerpts are returned.
- **C3-4 — re-investigate a stored case.** `POST /api/cases/{id}/investigate` + an
  Investigate button on stored cases; re-runs the agent in place (`force=True`),
  preserving provenance.
- **C3-5 — resolved-case RAG baseline.** Closing / confirm-FP indexes the case
  (entity + rules + verdict + risk + analyst note + trigger reason) into the
  resolved-case RAG store; the close modal has a note textarea; future
  investigations see a "Prior analyst decisions (baseline)" block. Gated by
  `rag.enabled` + `rag.use_resolved_cases`; fail-safe.
- **C3-6 — expanded model catalog + per-rule models.** Added OpenAI
  `gpt-4.1` / `gpt-4.1-mini` / `gpt-4-turbo` / `gpt-4` / `o4-mini` / `gpt-5` /
  `gpt-5-mini` to `pricing.py` (operator-verifiable approximate prices) + per-model
  param quirks (`gpt-5`/o-series omit `temperature`, use `max_completion_tokens`) +
  per-rule model overrides (`Preferences.rule_model_override`; `model_for_rule`
  precedence: `RuleDefinition.model_override` → `rule_model_override` → per-role)
  with a Settings table.
- **C3-7 — merged case history timeline.** The case history is now a merged,
  de-duplicated `EuiCommentList` timeline.

### Added (prior cycle — done)
- **Feature 1 — Global header chat button + context-aware flyout.** `plugin.ts`
  registers `core.chrome.navControls.registerRight`; `global_chat_control` +
  `global_chat_flyout` reuse the Chat engine; `lib/screen_context.ts` snapshots
  app/data-view/time-range/query/selection at send time; backend `ChatContext` /
  `ChatRequest.context`, fenced as UNTRUSTED and used only as es_query defaults.
- **Feature 2 — Per-log "AI overview".** Discover doc-viewer tab ("TLSOC AI
  Overview", guarded `unifiedDocViewer` registration) + in-app per-row overview
  button; backend `POST /api/overview` single-event agent on the cheap
  `overview_model`, metered through the gateway, reusing IP enrichment.
- **Feature 3 — "Why was this triggered".** `TriggerReason` (deterministic matched
  window + human sentence) carried onto every case and rendered in scans + case
  detail; case index-template priority raised to 600.
- **Feature 4 — Comprehensive settings + per-task model selection.** `settings.tsx`
  renders EVERY `Preferences` field; per-role model pickers from `GET /api/models`.
- **RAG (P1).** `use_resolved_cases` retrievable memory; ES `dense_vector` kNN
  store behind the `VectorStore` ABC; mixed-embedding-space guard (clear+reseed,
  no truncation); min-cosine threshold; richer query; chat grounded in RAG.

### Deferred
- **Feature 5 — wizard rewrite.** The original 4-step wizard is functional; the
  enhancement (dataViews create, auto-suggest, per-role models) is best validated
  against a live 8.19 Kibana. Tracked in ROADMAP.

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
