# USAGE.md — Using the Agentic SOC Triage Suite

A deep, example-driven guide to operating the suite once it is deployed (see
`DEPLOY.md`) and the standalone web UI is up. Everything here maps 1:1 to the
shipped UI and the backend API contract (`backend/app/api/routes.py`).

> **The standalone web UI is the primary surface.** It is a self-hosted SPA
> (Vite + React + **Tailwind + shadcn**, in `webui/`) that talks to the FastAPI
> backend **directly** over `/api/*` (proxied by nginx in production). The old
> Kibana plugin (`plugin/tlsoc_agentic_triage/`) is **legacy**; this document
> describes the standalone UI.

The suite is **vendor-agnostic**: it ingests from any number of configured
**sources** (pull connectors like Elasticsearch / OpenSearch / Wazuh, or push
receivers like webhook / HEC / syslog / Kafka / SQS / …), normalises every event
to **OCSF** (`backend/app/ocsf/`), and runs the same correlate → risk →
two-tier-LLM → deterministic-case-manager pipeline regardless of where the alert
came from.

---

## 0. Open the UI

The agnostic stack (`deploy/docker-compose.agnostic.yml`) publishes the web UI on
**http://localhost:8080** (nginx serves the SPA and reverse-proxies `/api/*` to
`tlsoc-backend:8088`). The backend's own API is also published on **:8088** for
ops/automation.

```bash
cp .env.example .env   # set TLSOC_PG_PASSWORD + at least one LLM key
docker compose -f deploy/docker-compose.agnostic.yml up -d --build
# then open http://localhost:8080
```

On first load the UI checks `GET /api/setup/status`; if `setup_complete` is
`false` it shows the **first-run wizard** instead of the console. After setup the
console exposes these surfaces:

| Surface | What it does |
|---|---|
| **Sources** | Add / edit / test / delete log sources (pull + push); per-feed config; mark one primary |
| **Cases** | Browse cases; open case detail + lifecycle; bulk actions; saved views |
| **Chat** | Ask read-only questions; get a two-turn analysis + result table |
| **Investigate** | Investigate an IP/user/host into a verdict card (a tab alongside Chat) |
| **Scans** | The auto-investigation queue |
| **Standup** | Aggregate-then-summarise daily report (a panel on Overview) |
| **Cost** | Today's spend, tokens, call count, top cost drivers (a tab under Analytics) |
| **Settings** | Two-scope IA (Personal Account / Organization): profile, sessions, prefs, sources, models, security, notifications, branding, demo, admin |

> **Top-level nav (Wave 4 consolidation).** The left rail is grouped into ≤5
> areas (Overview / Triage / Intelligence / Analytics / Admin). Investigate is a
> segmented control on the Chat scaffold (one chat engine), Cost is a tab under
> Metrics, and Standup is a panel on Overview. The analytics surfaces call their
> endpoints directly; every backend endpoint is also usable via `curl` (Section 9).

> **Round 2 features.** This release adds account self-service + a redesigned
> login (§12), session management + a token policy (§13), the consolidated
> Settings IA (§14), **Demo Mode** (§15), per-source **feeds** (§16), Resend/SES
> email + customizable templates (§17), per-user customization — saved views,
> table columns, terminology, theme (§18), and the **Cmd-K command palette +
> global search + bulk case actions + the audit viewer** (§19). Auth must be
> enabled (§8h) for the account/session features to be reachable.

---

## 1. First-run wizard (5 steps)

The wizard (`webui/src/components/Wizard/`) is a five-step flow that collects
every key, value, and input the backend exposes. It shows automatically when
`GET /api/setup/status` reports `setup_complete: false`, and is re-runnable from
**Settings**.

### Step 1 — Welcome / deployment

Name the deployment and optionally toggle a non-destructive **Demo mode**.

### Step 2 — Add your first source

This is the heart of the vendor-agnostic design. The wizard lists every available
connector from `GET /api/connectors` (grouped by category: `siem`, `edr_xdr`,
`transport`, `queue`, `object_store`, `file`). Pick one and the wizard renders a
**dynamic form** from that connector's `auth_fields` + `config_fields` (no
per-connector UI code — `ConnectorForm` turns the manifest into a validated EUI
form).

- **Pull sources** (Elasticsearch / OpenSearch / Wazuh): supply the cluster URL,
  a **read-only** API key, optional CA cert, and the **per-source field mapping**
  (`data_view_pattern`, `time_field`, `source_ip_field`, `user_field`,
  `host_field`, `rule_field`, `rule_name_field`, `severity_field`). Defaults match
  ECS (`source.ip` / `user.name` / `host.name` / `event.module` / `@timestamp`).
- **Push sources** (webhook / HEC / syslog / Kafka / SQS / Kinesis / Event Hub /
  Pub/Sub / RabbitMQ / NATS / MQTT / Redis Streams / S3 / GCS / Azure Blob /
  file): supply the transport's auth + config (e.g. a webhook `auth_mode` +
  `token`, or a syslog `bind_host` / `port` / `protocol`).

**Test the connection** (`POST /api/connectors/test`) before saving. Saving sends
secret fields to the secret tier (`POST /api/setup/secrets` for the primary
source's keys, or `POST /api/sources/{id}/secrets` per-source) and the
non-secret config to `POST /api/sources`. You can add multiple sources and mark
one **primary** (the agent's main read surface).

### Step 3 — LLM providers

Paste an **Anthropic** and/or **OpenAI** key and pick the per-role models (router
/ investigator / formatter / standup / chat / overview / embedding) from
`GET /api/models`. Defaults: investigator `claude-sonnet-4-6`, router/formatter/
standup/chat/overview `claude-haiku-4-5-20251001`, embeddings OpenAI
`text-embedding-3-small` (falls back to local hashing embeddings if no embedding
key is set).

### Step 4 — Enrichment & detection

Optional **AbuseIPDB** / **VirusTotal** keys, correlation defaults, risk weights,
the auto-forward allowlist, and the kill switch.

### Step 5 — Review & finish

A summary, then **Finish** → `POST /api/setup/complete`. That flips
`setup_complete=true`, starts the poller (if `polling_enabled`), and starts any
background push receivers for enabled sources. The console replaces the wizard.

---

## 2. Managing sources (day-to-day)

The **Sources** screen (`webui/src/components/Sources/`) lists every configured
source and lets you add / edit / test / delete and set the primary — reusing the
wizard's `ConnectorForm`. Behind it:

| Action | Endpoint |
|---|---|
| List configured sources | `GET /api/sources` |
| List available connectors (+ field schema) | `GET /api/connectors`, `GET /api/connectors/{source_type}` |
| Add / update a source | `POST /api/sources` |
| Set / clear a per-source secret | `POST /api/sources/{id}/secrets` |
| Test connectivity | `POST /api/connectors/test` |
| Browse a source's recent logs | `GET /api/sources/{id}/logs?limit=&query=&from=&to=` (see §2b) |
| Delete a source | `DELETE /api/sources/{id}` |

**Pull vs push at runtime:**

- **Pull** sources are polled by the in-process poller on `poll_interval_seconds`
  (and on a manual `POST /api/poll`). Each pull connector compiles the agent's
  structured queries to its own dialect; the agent never emits raw DSL.
- **Push** sources arrive asynchronously:
  - **Webhook / HEC** are **route-driven** — a source POSTs to
    `POST /api/ingest/{source_id}` (Section 9). No background task; the route
    verifies auth, parses + normalises to OCSF, and feeds the same pipeline.
  - **syslog / Kafka / SQS / Kinesis / Event Hub / Pub/Sub / RabbitMQ / NATS /
    MQTT / Redis Streams / S3 / GCS / Azure Blob / file** run as **background
    receivers** that start on app startup (and on save) and `emit` batches into
    the shared ingest path. Their optional client libraries are imported lazily
    (see TROUBLESHOOTING) and, for socket receivers (syslog), the configured port
    must be **published** in your compose file.

Per-source secrets (a webhook token, a Splunk HEC token, a cloud credential) live
in the **in-memory secret tier** and are **never persisted** — only the configured
field *names* are stored on the source (`configured_secrets`). They are lost on a
backend restart unless also supplied via env/`.env`.

### Test connection — what `ok`, `mode`, and `cluster_monitor` mean

`POST /api/connectors/test` returns `ConnectionTest` `{ ok, message, mode?,
cluster_monitor? }`. For a **pull** source the test runs the **cheap, scoped,
read-only search first** — that read is the authoritative pass/fail gate, so a
correctly-scoped **read-only API key passes** (it does **not** need cluster
privileges):

- **`ok:true`, `mode:"read_only"`** — the scoped read succeeded but the key lacks
  `cluster_monitor` (the expected, healthy state for a least-privilege read-only
  key). The UI shows a green *"Read-only access verified — N events readable in
  `<pattern>`. Cluster-monitor privilege not granted (expected for a read-only
  key)."* callout.
- **`ok:true`, `mode:"full"`, `cluster_monitor:true`** — the scoped read succeeded
  **and** the key can also `ping()` the cluster (has `cluster_monitor`). A green
  "Connection verified" callout.
- **`ok:false`** — only when the **scoped read itself fails**: auth (`401`/`403` on
  the index → wrong/under-scoped key) or network/TLS (URL not routable, or a
  private CA isn't trusted). A failed `ping()` alone is **not** a failure anymore.

> A read-only key cannot do `HEAD /` (a cluster-level op), so the test no longer
> gates on `ping()` — `ping()` is now only the extra `cluster_monitor` signal that
> upgrades `mode` to `full`. (See `docs/TROUBLESHOOTING.md` §D.)

---

## 2b. Browse a source's logs

Each source card on the **Sources** screen has a **"Logs"** button — shown only for
connectors that advertise the `browse` capability (`capabilities:["browse"]`: all
pull connectors, and every push receiver). It opens the **Source Logs flyout**
(`SourceLogsFlyout`), a live window onto that one source's recent events, backed by
`GET /api/sources/{id}/logs?limit=&query=&from=&to=` (auth-protected).

| Control | What it does |
|---|---|
| **Table** | One row per event: timestamp · `source.ip` · module/rule · severity · message. |
| **Expand a row** | Reveals the **raw `_source`** document in an `EuiCodeBlock`. |
| **Search box** | Free-text `query` filter passed to the source. |
| **Time range** | An `EuiSuperDatePicker` (`from`/`to`); defaults to the **last 15m**. |
| **Live tail** | A toggle that auto-refreshes every **10s** so new events stream in. |

How the rows are produced depends on the source's runtime mode:

- **Pull sources** (Elasticsearch / OpenSearch / Wazuh) run a **bounded
  (hard-capped at 200), read-only, field-mapping-aware scoped search** against the
  source's own `data_view_pattern` / field mapping / TLS — so what you see is
  exactly what the agent can read, with the same per-source field resolution and
  certificate settings.
- **Push sources** (webhook / HEC / syslog / queues / object-stores) have no index
  to query, so they return the **last N events from an in-memory live-tail ring
  buffer** (capped at **500 events per source**) that `IngestService` keeps as
  events arrive. A connector that supports neither returns `501`.

Each row is `{ ts, source_ip, user, host, rule, severity, message, _raw }` where
`_raw` is the full log document. **Secrets are never returned.** An unknown source
id returns `404`; a read failure (e.g. an auth/TLS error against a pull source)
returns `502`. All log content renders as plain text / `EuiCodeBlock` — it is
attacker-influenceable and fenced/escaped as UNTRUSTED (see `SECURITY.md`).

---

## 3. Cases (Surface)

The triage workbench. The cases table (`GET /api/cases?limit=100`) shows **Entity
· Rules · Risk · Status · Disposition · Verdict · Created** with per-status
filtering (`?status=escalated`), per-surface filtering (`?surface=automated_scan`),
and per-entity filtering (`?entity=10.10.1.152`).

**Two-axis taxonomy (Wave 3).** A case now carries both a lifecycle **status** and
an analyst **disposition** — they are independent.

- **status** (where the case is in its lifecycle): `new` (candidate, pre-LLM),
  `open` (investigated, awaiting an analyst), `investigating` (actively worked),
  `escalated` (flagged for senior / Tier-3), `on_hold` (paused), `resolved` (worked
  to completion, pending final close), `closed` (terminal). `needs_human` is
  **retained as a deprecated alias** of "open · awaiting analyst" — the deterministic
  `decide()` still uses it internally, and old stored cases load unchanged.
- **disposition** (what the case turned out to be): `true_positive`,
  `false_positive`, `benign`, `suspicious`, `duplicate`, `undetermined` (the default
  for cases that predate the taxonomy). Set it explicitly with the `set_disposition`
  action; `confirm_fp` also stamps `false_positive` when the disposition is still
  undetermined.

### Case detail + lifecycle

Opening a case loads the **stored** case by id (`GET /api/cases/{id}`) — it does
**not** re-investigate. The detail view shows the verdict, status, confidence/risk
badges, entity, rules, summary, the `trigger_reason` ("why this fired"), evidence,
MITRE techniques, recommended action, the reproduce query, and the **History**.

**Analyst actions** go through `POST /api/cases/{id}/action` with
`{ "action": "...", "note": "...", "analyst": "..." }` (plus the optional fields
noted below):

| action | resulting status | meaning |
|---|---|---|
| `close` | `closed` | analyst closes the case |
| `confirm_fp` | `closed` | analyst confirms a false positive (sets disposition `false_positive` if still undetermined) |
| `resolve` | `resolved` | worked to completion, pending final close |
| `reopen` | `open` | reopen a closed/resolved case |
| `escalate` | `escalated` | flag for senior / Tier-3 (optional `level` raises `escalation_level`) |
| `deescalate` | `open` | undo an escalation |
| `hold` | `on_hold` | pause the case (awaiting info / third party) |
| `resume` | `open` | take a held case off hold |
| `set_status` | the `status` field | move to an arbitrary legal status |
| `set_disposition` | unchanged | set the analyst `disposition` (no status change) |
| `acknowledge` | unchanged | record an ack in history (no status change) |

The body may carry `status` (for `set_status`), `disposition` (for
`set_disposition`), `level` (for `escalate`), `reason` (recorded as `status_reason`
on `hold` / `resolve` / `set_status`), and the existing `resolution` / `assignee` /
`priority` / `tags`. A **transition guard** rejects illegal moves — e.g. leaving a
terminal status (`closed` / `resolved`) is only legal via `reopen` (a `400`
otherwise). Every action sets `decision_by=analyst`, stamps `updated_at`, appends
an entry to the case **history** + `status_history`, and is audited. A `close` /
`confirm_fp` also
indexes the resolved case (entity, rules, verdict, risk, note, trigger reason)
into the **resolved-case RAG baseline** when `rag.enabled` + `rag.use_resolved_cases`
— a RAG/embedding failure can never break the action (fail-safe).

**Re-investigate in place** (`POST /api/cases/{id}/investigate`) re-runs the same
pipeline for a stored case with `force=True`, rebuilding the cluster (preferring an
exact id-based re-query of the member events, falling back to a config-windowed
entity re-query with the auto-widen ladder) and **preserving the case's original
provenance**. A NEUTRAL `400` is returned if the activity has aged out of the
retained window.

**Agent trace** (`GET /api/cases/{id}/trace`) projects the append-only audit index
into an ordered timeline (router → investigator → tool calls → verdict → formatter
→ case-manager decision). Raw prompt excerpts are included only when
`trace.include_prompts` is true (default on).

> **Decision invariants (code-enforced):** a **TRUE_POSITIVE is never
> auto-closed** — it routes to a human (`needs_human`), escalated when confidence
> ≥ the escalation threshold or risk is critical. A FALSE_POSITIVE only auto-closes
> under the strict, off-by-default `fp_auto_close` conditions; otherwise a human
> confirms. Anything else fails safe to a human.

---

## 4. Investigate (Surface)

Choose **IP / User / Host**, type a value, and Investigate. This POSTs
`/api/investigate` with
`{ "entity": { "type": "ip", "value": "10.10.1.152" }, "source_surface": "investigate" }`.
The backend pulls in-scope events for that entity (same scope + suppression
filters the poller uses), correlates them into a cluster, and runs the full
pipeline → enrich → deterministic risk → cheap-router triage → strong investigator
(only if uncertain/serious) → deterministic Case Manager decision. It returns a
**case**, rendered as a **verdict card**.

**Lookback + auto-widen.** The starting lookback is `investigate_lookback`
(default `now-24h`); a request may override it with a `lookback` field. If the
window yields **zero** events, the backend auto-widens through a ladder
(`configured → now-7d → now-30d → now-365d`) before giving up. When nothing is
found even in the widest window the response is a NEUTRAL `400` (rendered as an
empty-state, not a red error).

**Example verdict card** (case fields the card shows):

```json
{
  "verdict": "TRUE_POSITIVE",
  "confidence": 0.82,
  "risk_score": 71,
  "evidence": [
    { "summary": "412 failed SSH logins from 10.10.1.152 in 90s, then 1 success for 'alice'." },
    { "summary": "Source IP reputation: AbuseIPDB confidence 88 (known SSH brute-forcer)." }
  ],
  "mitre": ["T1110", "T1078"],
  "recommended_action": "Isolate web-01, force-reset alice, block 10.10.1.152 at the edge.",
  "reproduce_query": "source.ip: \"10.10.1.152\" and event.module: \"sshd\""
}
```

---

## 5. Chat (Surface)

A read-only natural-language console (`POST /api/chat`). Type a question; the
agent may turn your intent into a single read-only structured query, render the
first 50 hits as a table, and produce a **two-turn analysis**: the first model
turn decides the query, then the engine builds a compact, fenced-UNTRUSTED
aggregate of the hits and re-prompts the model for the analysis you read. If the
second turn is unavailable, chat degrades gracefully (it never hard-fails). Both
turns are metered through the single gateway.

Add `case_id` to seed a case follow-up (the engine already knows the case's
entity, verdict, confidence, risk, rules, and top evidence). Add a `context`
object (`app` / `data_view` / `time_range` / `query` / `selection`) to supply
es_query defaults — server-side it is fenced **UNTRUSTED** and never becomes
instructions.

If no LLM provider is configured, chat replies *"The assistant is unavailable (no
model configured). Configure an LLM provider key in Settings."* — it never
silently errors.

---

## 6. Scans (Surface)

The background-investigation queue (`GET /api/scans?limit=100`). The poller
correlates each new in-scope cluster and either:

- **auto-investigates** it (if `background_scan_enabled` is on AND the cluster's
  rule is on the **auto-forward allowlist**, or the allowlist contains `*`), or
- **registers it as an OPEN candidate** (deterministic risk only, no LLM cost) so
  nothing is ever dropped — those appear in **Cases** for manual triage.

Every case carries a `trigger_reason` (which rule, how many events, in what
window, grouped on which entity, plus a plain-English sentence). The new-scan
badge polls `GET /api/scans/notifications?since=now-24h`.

**Control auto-forwarding** in Settings → Polling & detection: turn on
**Background scan enabled** and set the **Auto-forward allowlist** to the rule
values you want auto-investigated (comma-separated; `*` = all; empty = candidates
only).

---

## 7. Standup (Surface)

Aggregate-then-summarise (`GET /api/standup?window_hours=24`). The backend runs
near-free aggregations over the window (events from the log source, case stats from
the state store), then sends ONLY the compact JSON aggregate to the cheap model for
prose — **raw logs are never sent to a model**. You get a prose **Summary**, stat tiles (total events
· unique IPs · cases opened), the case breakdown by-verdict and by-status, and
top rules / source IPs / users / hosts.

If the summariser model is unavailable, the response is the **deterministic**
summary (ends with *"(LLM summary unavailable; this is the deterministic
aggregate.)"*). If standup is disabled, the response is
`{ "enabled": false, "summary": "Standup is disabled in settings." }`.

---

## 8. Cost (Surface)

`GET /api/usage/summary?window_hours=24`. Because **100% of LLM calls go through
the single gateway**, every token is metered. Top tiles: today's spend, total
tokens, call count, total cost (window). Breakdown tables: **by model**, **by
role** (`router` / `investigator` / `formatter` / `standup` / `chat` / `overview`
/ `embedding`), **by surface** (`investigate` / `automated_scan` / `chat` / …).
Scope to one case with `&case_id=...`.

---

## 8b. Per-log AI overview

`POST /api/overview` returns a one-click AI summary of a **single event** (no
full investigation, no case) on the cheap `overview_model`, cost-ledgered like any
other call:

```json
{
  "overview": "Repeated failed SSH logins from 10.10.1.152 against web-01 for user 'alice'.",
  "why_it_matters": "A burst of failures from one source IP is a classic brute-force precursor.",
  "suggested_next_step": "Check whether any login from 10.10.1.152 succeeded shortly after.",
  "entities": ["10.10.1.152", "alice", "web-01"],
  "mitre": ["T1110"],
  "ip_reputation": { "ip": "10.10.1.152", "reputation_score": 88, "is_malicious": true, "country": "RU" },
  "cost": 0.0003
}
```

---

## 8c. Knowledge base (RAG) — see and grow the corpus

The agent's retrieval corpus is no longer a black box. The **Knowledge** page
(`webui/src/components/Knowledge/`, under the new **Platform** nav group) lets you
inspect exactly what RAG holds and add to it. A **document** is a set of chunks that
share a `document_id`; the built-in seed knowledge is grouped by source
(`runbook` / `mitre` / `suppression` / `resolved_case`).

| Action | Endpoint | Notes |
|---|---|---|
| Corpus stats (docs, chunks, embedding model + dim, by-source) | `GET /api/rag/stats` | also feeds the Metrics page |
| Browse documents | `GET /api/rag/documents` | title, source, tags, chunk count |
| Inspect one document's chunks | `GET /api/rag/documents/{id}` | the chunk drill-in flyout |
| Import a document | `POST /api/rag/import` | `{ title, text, source?, tags? }` — chunked + embedded + indexed |
| Delete a document | `DELETE /api/rag/documents/{id}?force=` | seeds need `force=true` (see below) |
| Run a live test retrieval | `GET /api/rag/search?q=&top_k=` | shows EXACTLY what RAG returns for a query |

**Import a document.** On the Knowledge page, paste text into the import textarea or
upload a `.txt` / `.md` / `.json` / `.csv` file (read client-side, then sent as
text). Give it a title (and optional tags); the backend chunks it
(`engine/chunking.chunk_text` — dependency-free paragraph-pack with overlap),
embeds each chunk through the single gateway, and indexes it into the same vector
store the investigator retrieves from. Imported docs are immediately retrievable.

**Browse + inspect chunks.** The documents table lists every document with its
source, tags, and chunk count; open one to see its individual chunks in a flyout (so
you can see precisely what text will be retrieved and fed to the model — fenced as
UNTRUSTED at prompt time, see `SECURITY.md`).

**Run a test retrieval.** Use "Try a retrieval" (`GET /api/rag/search`) to type a
query and see the ranked snippets RAG would surface for it — the fastest way to
confirm an imported runbook or IOC list is actually being recalled.

**Delete (and the guarded-seed force flag).** Deleting your own imported document is
a one-click `DELETE /api/rag/documents/{id}`. The **built-in seed sources**
(`runbook`, `mitre`, `suppression`, `resolved_case`) are **guarded**: a plain delete
is refused; you must pass **`?force=true`** to remove seed knowledge (the UI prompts
for the force confirmation). This prevents accidentally wiping the baseline corpus.

---

## 8d. Agent memory — durable operator facts

The suite carries a small, durable **memory** of operator-supplied facts
(Claude.ai-style: "remember this"), so the agent applies your standing context to
every investigation and chat without you repeating it. Each `MemoryEntry` has
`text`, an optional `category` and `tags`, a `source` (`human` when you edit it
directly, `agent` when you told the agent to remember it in chat), an `author`, and
an **`active`** flag. Memory is stored via the existing KV layer (no new index /
migration) in whatever `STATE_BACKEND` you run.

**How it's used (and its limits).** Active memory is injected into BOTH automated
investigations and chat as a **DISTINCT `<<<MEMORY>>>` TRUSTED block** — separate
from the fenced UNTRUSTED evidence, with the precedence
`policy > base-prompt > playbook > MEMORY > untrusted`. Critically, **memory only
informs the LLM; it can NEVER override the deterministic Case Manager** (the
close/escalate decision stays code-controlled — non-negotiable #3). Forged
`<<<MEMORY>>>` markers in event data are neutralised by `fence()`.

**Add / edit / remove on the Memory page** (`webui/src/components/Memory/`, under the
**Platform** nav): add a fact, inline-edit its text, toggle it **active/inactive**,
or delete it. A human-vs-agent **source badge** shows where each fact came from.

**…or in Chat.** Say **"remember: <fact>"** to store a fact (saved with
`source=agent`, audited) or **"forget …"** to deactivate one. Chat surfaces two
distinct things in its JSON: a `memory_action` that was **executed** deterministically
(you see a calm confirmation echo), and a `memory_suggestion` — a dismissible
"remember this?" prompt that is **never auto-saved**; clicking it calls
`POST /api/memory`.

| Action | Endpoint |
|---|---|
| List memory facts | `GET /api/memory` |
| Add a fact | `POST /api/memory` (`{ text, category?, tags? }`, `source=human`) |
| Edit / toggle active | `PUT /api/memory/{id}` |
| Delete a fact | `DELETE /api/memory/{id}` |

**Active vs inactive.** Only **active** facts are injected into prompts; toggling a
fact inactive keeps it for the record but stops it influencing the agent — the
non-destructive way to retire guidance.

---

## 8e. Case "Why" — explainability

Every case can explain itself. The case-detail flyout has a **"Why"** tab backed by
`GET /api/cases/{id}/rationale`, and the investigator records a **CONTEXT audit
entry** (`ActionType.CONTEXT`) capturing everything it was handed. The rationale
object — assembled defensively from the case + audit trail — has these sections:

- **Decision (deterministic) — `decision_rationale`.** Shown prominently. This is the
  **code-made** close/escalate rationale from the Case Manager — *not* the model's
  opinion. The verdict/confidence are the LLM's recommendation; the **decision** is
  deterministic (non-negotiable #3).
- **Reasoning.** The investigator's reasoning excerpt (carried on the VERDICT record).
- **Knowledge used.** The RAG / runbook snippets retrieved for this case, each with
  its **source + snippet** provenance.
- **Memory applied.** The operator memory facts (§8d) that were in context.
- **Tools / commands run.** The exact ES queries and tool calls the agent executed.
- **Enrichment.** Any IP/indicator reputation that was pulled.
- **Persona / playbook / MITRE / evidence.** The routed specialist persona, the
  selected playbook (+ why), MITRE techniques, and the evidence list.

Use it to audit *how* a verdict was reached and to confirm the close/escalate was a
deterministic policy outcome rather than raw model output. (The **Agent trace** tab,
§3, remains the step-by-step timeline; "Why" is the assembled rationale.)

---

## 8f. Run a playbook on a case + threat context

**Run a playbook** (`POST /api/cases/{id}/run-playbook` with
`{ "playbook_id": "...", "analyst": "..." }`). A run is a **context-only**
re-investigation: the chosen playbook is **forced** into the investigator's
TRUSTED `<<<PLAYBOOK>>>` block and the case is re-investigated through the shared
pipeline. The playbook can only RECOMMEND — it can never change the deterministic
close/escalate outcome (non-negotiable #3). An unknown `playbook_id` returns `404`.
List the catalog first with `GET /api/playbooks`. In the UI, open a case and use
**Run playbook** (pick from the catalog); the resulting re-investigation renders in
place.

**Threat context** (`GET /api/cases/{id}/threat-context`) assembles a defensive,
**fail-open** panel for the case (each section degrades independently if its source
is missing):

- **IOC reputation** — AbuseIPDB / VirusTotal lookups for the case's indicators
  (an indicator is flagged malicious above `threat_context.ioc_malicious_threshold`,
  default 50).
- **MITRE ATT&CK** — technique metadata (name, tactics, platforms, sub-techniques)
  resolved from a **bundled corpus of 697 enterprise techniques**
  (`backend/app/threat/mitre_techniques.json`); no network call.
- **Related cases** — cases sharing the entity (the cross-source linkage from §8g).

The case-detail flyout shows this as a **Threat Context** tab. All untrusted log /
intel text renders as plain text / code blocks (#9). You can grow the intel corpus
with `POST /api/threat-context/import` (admin) — `{ title, content, tags? }` —
which chunks the doc into RAG as `source="threat_context"` and injects it as a
fenced TRUSTED block at investigation time.

**Resolved-case knowledge loop.** When a case transitions to `closed`/`resolved`,
the suite auto-chunks it into the RAG corpus (`source="resolved_case"`, best-effort,
never blocks the action) so future investigations retrieve *"we've seen this
before"*. Gated by `rag.enabled` + `threat_context.reuse_resolved_cases` /
`rag.use_resolved_cases`.

---

## 8g. Multi-source correlation — Auto-Correlate + cross-source related cases

By default each configured source is correlated on its own. Two controls change
that, both in the **source editor** (and on the `SourceInstance` config):

- **Auto-Correlate (per source).** A switch on each source. When **on** (default),
  that source's correlated clusters auto-forward into triage. When **off**, its
  clusters are still formed but routed to **candidates** (Cases, manual triage) —
  use this to keep a noisy source from auto-investigating. Stored as the source's
  `config.auto_correlate`.
- **Auto-Correlate (per sub-source).** Each pull source can carry multiple **index
  patterns** with an `events` / `alerts` role; each pattern has its **own**
  Auto-Correlate toggle (`IndexPattern.auto_correlate`). This lets you, say,
  auto-investigate the `alerts` pattern while leaving a high-volume `events` pattern
  on manual.

**Cross-source correlation (opt-in, default OFF).** Enable
`cross_source_correlation` (Settings → Automation) to run a **second** pass that
links clusters from *different* sources that share an entity
(`ip` / `host` / `user` / `file_hash` / `domain`) within a time window. Tunables:
`time_window_seconds` (default 300), `min_sources_to_cluster` (default 2), and the
`entity_keys`. The result is surfaced as **RELATED cases** — the cases are linked
(`related_case_ids`, `cross_source_cluster_id`, a source breakdown) but **never
force-merged**, so the per-source 1:1 cluster→case signature and audit trail stay
intact. The case-detail flyout shows a "Sources" pill and a "Related cases" facet;
the Cases list can filter to related-only.

**Per-source field-mapping overrides + connector help.** Beyond the wizard's field
mapping, a source's config can carry `field_mappings_extra` overrides applied at
ingest. Each connector field can also ship contextual setup help (`help_link` /
`help_code`), rendered as a (?) `HelpTip` in the source editor so you can see, e.g.,
the exact read-only API-key grant for that connector inline.

---

## 8h. Authentication — enabling auth, users, RBAC, MFA, SSO

Auth is **default OFF** (the no-auth "old version" is the default and stays fully
functional, which is also why the offline tests run unauthenticated). Turn it on
with the env flag and restart the backend:

```bash
# in .env (mapped to the backend's UNPREFIXED env names by compose)
TLSOC_AUTH_ENABLED=true
```

When auth is enabled, the relevant `Secrets` are `auth_enabled`,
`auth_seed_admin` (default true), `auth_seed_admin_username` (default `Admin`), and
`auth_seed_admin_password` (default `Admin@123`).

### First login + OOBE

On first boot with an **empty** user store, the suite seeds a single
**`super_admin`** — `Admin` / `Admin@123` — with `must_change_password=true`. At
the login screen sign in as `Admin` / `Admin@123`; the login flow detects the flag
and forces a **change-password** step (`POST /api/auth/change-password`) before it
issues a real session. **Change this password immediately** — the seed is a known
default. (You can disable the seed with `TLSOC_AUTH_SEED_ADMIN=false` and create the
first admin via `POST /api/setup/init-admin`, which is only accepted while no users
exist.)

### Roles (RBAC)

The suite ships a **six-role** permission matrix, enforced **in code** on every
state-changing route (and mirrored in the UI by `<Can>` guards that hide actions a
role can't perform):

| Role | Typical scope |
|---|---|
| `super_admin` | everything, incl. users / RBAC / SSO / settings |
| `soc_manager` | manage cases + approvals + most settings |
| `analyst_tier2` | investigate + close cases |
| `analyst_tier1` | investigate + work cases (no close) |
| `responder` | act on assigned cases |
| `auditor` | read-only (cases, audit, metrics) |

`GET /api/roles` returns the role→permission matrix the UI renders. Manage users
(super_admin only):

```bash
curl -s localhost:8088/api/users                                   # list
curl -s -X POST localhost:8088/api/users \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"<temp>","role":"analyst_tier2"}'
curl -s -X PUT localhost:8088/api/users/alice \
  -H 'content-type: application/json' -d '{"role":"soc_manager","active":true}'
curl -s -X DELETE localhost:8088/api/users/alice
```

In the UI, **Settings → Administration → Users** is the add / disable /
reset-password / role-picker table.

### Enrolling MFA (TOTP)

MFA is per-user, RFC-6238 TOTP, stdlib-only:

1. Signed in, go to **Settings → Security → MFA** (or `POST /api/auth/mfa/setup`).
   The backend returns `{ secret, otpauth_uri, recovery_codes }`.
2. The UI renders the `otpauth://` URI as an **inline-SVG QR** — **scan it** with
   Google Authenticator / Authy / 1Password / etc. (or type the `secret` by hand).
   **Save the recovery codes** (single-use, shown once).
3. Confirm enrolment by entering a current 6-digit code:
   `POST /api/auth/mfa/confirm` — this persists MFA as enabled.

After that, **login is two-phase**: the password call returns
`{ requires_mfa: true, session }`, and the client posts the code to
`POST /api/auth/mfa/verify` to receive the real JWT (a recovery code works here too,
once). Disable with `POST /api/auth/mfa/disable` (self, requires a current code; an
admin can force-disable). `mfa.enforce_for_roles` can require MFA for chosen roles.

### Configuring SSO (OIDC)

Configure an OIDC provider in **Settings → Security → SSO** (writes the `sso`
Preferences block). Supported: **Google**, **Microsoft**, and **generic** OIDC.
The flow is server-side: the suite redirects to the provider, exchanges the `code`
server-side, then calls the provider's **`userinfo`** endpoint and maps the claims
to a user (id_token *signature* verification is intentionally skipped — see
`SECURITY.md` — so there is **no `PyJWT`/JWKS dependency**).

1. Set `sso.enabled=true`, the provider `type`, `client_id`, `discovery_url` (for
   generic), `scopes`, the `allowed_domains` / `allowed_tenants`, and the
   `group_claim_name` + `group_role_map` (group → one of the six roles); set
   `auto_create_users` to provision users on first login at `default_role`.
2. Put the client secret in the secret tier:
   `POST /api/auth/sso/providers/{provider_id}/secret`.
3. Register the **callback URL** shown in the SSO settings panel with your IdP.

Endpoints: `GET /api/auth/sso/providers` (public; powers the "Sign in with …"
buttons), `GET /api/auth/sso/authorize?provider=` (returns the auth URL + sets a
single-use state/nonce), `GET /api/auth/sso/callback?code=&state=` (validates,
mints the JWT, redirects to `/`).

---

## 8i. Notifications — email, Slack, and other channels

Configure notifications in **Settings → Notifications** (the `notifications`
Preferences block). The suite ships a pluggable `NotificationChannel` abstraction;
the channel types available are **email**, **Slack**, **Microsoft Teams**,
**webhook**, **PagerDuty**, and **Telegram**.

**Email (SMTP).** Pick a **provider preset** from the dropdown — 13 are built in
(gmail, o365, yahoo, zoho, icloud, sendgrid, mailgun, postmark, brevo, sparkpost,
… and `custom`) — which fills host / port / encryption; supply `from_addr`,
recipients, and the SMTP credential (stored in the **secret tier**, never in
Preferences). `GET /api/notifications/providers` returns the preset table the UI
renders.

**Slack / Teams / webhook / PagerDuty / Telegram.** Add the channel and supply its
secret (a Slack/Teams incoming-webhook URL, a PagerDuty routing key, a Telegram bot
token, etc.) via `POST /api/notifications/channels/{channel_id}/secret`.

**Triggers, dedup, digest.** Each channel chooses **triggers** — on case create,
on verdict change, on escalate, on close — plus an `immediate_severity_threshold`.
Noise control is built in: **dedup** within `dedup_window_seconds`, per-recipient
**rate limiting**, and **digest** batching within `digest_window_seconds`.

**When sends happen.** Notifications fire **fire-and-forget, *after* the
deterministic `apply()` + save** — never inside `decide()` — so a channel failure
can never block or alter a case decision. Every send is audited; untrusted log
fields in the message body are fenced as plain text (#9).

```bash
# Send a sample notification to one configured channel (settings:manage)
curl -s -X POST localhost:8088/api/notifications/test \
  -H 'content-type: application/json' -d '{"channel_id":"email-1"}'

# Manually notify on a specific case (cases:write); omit channel_id to fan out
curl -s -X POST localhost:8088/api/cases/case-abc123/notify \
  -H 'content-type: application/json' -d '{"channel_id":"slack-1"}'
```

---

## 8j. Threshold automation — #3-safe post-decision rules

**Settings → Automation** holds the threshold-automation rules
(`threshold_automation`, default OFF). Each rule has `conditions` (on verdict /
risk / severity / entity type / rule / source) and an `action`, evaluated in
priority order **after** the Case Manager decides:

- `tag` — add a tag to the case.
- `recommend` — attach a recommendation.
- `notify` — fire a notification (§8i).
- `run_playbook` — queue a context-only playbook re-investigation (§8f).
- `request_approval` — raise a **HITL `Proposal`** (the existing admin-gated
  approve/reject path — see the Approvals queue).

**The hard guarantee:** automation **never sets `case.status` directly**. A SAFE
action (tag / recommend / notify) is applied and audited; anything that would write
the world routes through the HITL `Proposal` path; a re-investigation calls
`decide()` again with new inputs. `decide()` remains the only producer of a
CLOSED / auto-closed case, and `NEEDS_HUMAN` never auto-closes (CI-asserted,
non-negotiable #3). Automation rules ride `PUT /api/settings` under
`threshold_automation`.

---

## 9. Settings — full reference

Settings GET `/api/settings` (`{ prefs, configured, read_only }`) and PUT a
partial patch (deep-merged server-side; validated against the `Preferences`
schema). When **read-only mode** is on, a `403` is returned. Large subtrees can be
fetched section-by-section with `GET /api/settings/{section}`, and
`GET /api/settings/schema` returns the form-generation schema.

**Consolidated layout (Wave 7).** The page is organised into **13 sections across
4 nav groups** rather than one long form: Data Sources; Models & LLM; Correlation &
Cases (incl. the case-ID format, §below); Automation (playbooks + threshold
automation §8j + cross-source correlation §8g); Notifications (§8i); Security
(RBAC / MFA / SSO / rate-limits, §8h); Knowledge & Threat Context (§8c/§8f);
Enrichment; Appearance (branding); Advanced (caps, read-only mode); plus the
admin-only **Administration** group (Users, audit). It still renders **every**
`Preferences` field — data scope, entity mapping, severity/rules, polling, the
**seven per-role models** (router, investigator, formatter, standup, chat,
`overview_model`, embedding), decision thresholds, the correlation table + risk
weights + `asset_networks`, caps + kill switch, suppression rules, the auto-forward
allowlist, enrichment, RAG, standup, the **rule catalog** + per-rule model
overrides, the **trace** toggle, and read-only mode.

### Custom case-ID nomenclature

`case_id_format` (Settings → Correlation & Cases) controls the human-facing
**case number** (the immutable system `case_id` is unchanged). Set `enabled=true`
and a `template` (placeholders include `{prefix}`, `{sep}`, `{year}`, `{yy}`,
`{mm}`, `{seq:0Nd}`, `{source}`, `{verdict}` — e.g. `CASE-{year}-{seq:06d}` →
`CASE-2026-000123`), a `reset_period` (`none` / `calendar_year` / `fiscal_year` /
`fiscal_quarter`), and `seq_start`. The sequence is an atomic KV counter bucketed
by period. Preview candidate templates without persisting:
`POST /api/settings/case-id/preview`. When set, the UI shows `case_number` and
falls back to `case_id`.

### Per-role model selection

Each role has a provider + model picker (populated from `GET /api/models`), plus
temperature and max-tokens. The catalog covers Anthropic and an expanded OpenAI
set (`gpt-4.1`, `gpt-4.1-mini`, `gpt-4-turbo`, `gpt-4`, `o4-mini`, `gpt-5`,
`gpt-5-mini`); the gateway handles per-model quirks automatically (`gpt-5` /
`o`-series omit `temperature`, use `max_completion_tokens`). Listed prices are
operator-verifiable approximations — edit `backend/app/llm/pricing.py` to correct.

### Configured credentials

Badges per secret show **`configured ✓`** or **`not set`** — values are never
returned. Covered: `es_api_key`, `es_mgmt_api_key`, `openai_api_key`,
`anthropic_api_key`, `abuseipdb_api_key`, `virustotal_api_key`,
`embedding_api_key`. Per-source secrets show as `configured_secrets` on each
source.

### Polling & detection

| Field | Pref | Default | Notes |
|---|---|---|---|
| Poll interval (seconds) | `poll_interval_seconds` | 30 | loop sleeps `max(5, value)` |
| Severity threshold | `severity_threshold` | 0.0 | min numeric severity in scope |
| Polling enabled | `polling_enabled` | true | starts/stops the loop |
| Background scan enabled | `background_scan_enabled` | false | gate for auto-forwarding |
| Auto-forward allowlist | `auto_forward_allowlist` | `[]` | comma-separated rule values; `*` = all |

### Caps & kill switch

| Field | Pref | Default |
|---|---|---|
| Max tool calls | `caps.max_tool_calls` | 8 |
| Max tokens | `caps.max_tokens` | 20000 |
| Kill switch | `caps.kill_switch` | false |

The **kill switch** is a global emergency stop: when on, the poller does not run
and an investigation returns a `NEEDS_HUMAN` case with *"Kill switch engaged;
investigation skipped."* (`caps.timeout_seconds` = 120 is schema-level.)

### Automation toggles

| Toggle | Pref | Default |
|---|---|---|
| FP auto-close enabled | `fp_auto_close.enabled` | false |
| Enrichment enabled | `enrichment.enabled` | true |
| RAG enabled | `rag.enabled` | true |
| Standup enabled | `standup.enabled` | true |

`fp_auto_close` also has (schema-level, off by default): `min_confidence` 0.95,
`max_risk_score` 30.0, `objection_window_minutes` 60.

### Per-rule correlation (JSON editor)

A JSON map of **rule value → `{ mode, n, window_seconds, group_by }`**:

```json
{
  "web_auth":   { "mode": "threshold", "n": 5, "window_seconds": 120, "group_by": "ip" },
  "modsec_xss": { "mode": "every",     "n": 1, "window_seconds": 60,  "group_by": "ip" },
  "ml_stats":   { "mode": "never",     "n": 1, "window_seconds": 60,  "group_by": "host" }
}
```

- **mode**: `threshold` (≥ `n` within `window_seconds`, grouped), `every`
  (every occurrence), `never` (manual only).
- **group_by**: `ip` | `user` | `host`.
- Rules not listed use **default correlation** (`threshold`, `n=5`,
  `window_seconds=120`, `group_by=ip`).

---

## 10. Using the API directly (`curl`)

Every surface is backed by an HTTP route under `/api` (`backend/app/api/routes.py`).
You can drive them directly for ops/automation. Examples below hit the backend on
`localhost:8088` (the agnostic stack publishes it); through the web UI's nginx,
the same paths work under the SPA origin (e.g. `http://localhost:8080/api/...`).

```bash
# Health
curl -s localhost:8088/api/health
# -> {"status":"ok","version":"1.0.0","es_connected":true,"store_type":"...","setup_complete":true}

# Setup status (configured booleans, entity mapping, es_connected)
curl -s localhost:8088/api/setup/status
```

### Connectors + sources

```bash
# List every available connector + its wizard field schema (auth/config)
curl -s localhost:8088/api/connectors
# One connector's manifest
curl -s localhost:8088/api/connectors/elasticsearch

# Create (or update) a source — a webhook push receiver, id "edr-webhook"
curl -s -X POST localhost:8088/api/sources \
  -H 'content-type: application/json' \
  -d '{
        "id": "edr-webhook",
        "source_type": "webhook",
        "display_name": "EDR webhook",
        "ingest_mode": "push_http",
        "is_primary": false,
        "config": { "auth_mode": "bearer", "path": "/webhook", "format_hint": "auto" }
      }'

# Set a per-source secret (the bearer token) — secret tier, never persisted
curl -s -X POST localhost:8088/api/sources/edr-webhook/secrets \
  -H 'content-type: application/json' \
  -d '{ "token": "s3cr3t-webhook-token" }'

# Test connectivity (tests the live primary log source)
curl -s -X POST localhost:8088/api/connectors/test \
  -H 'content-type: application/json' -d '{}'

# List configured sources
curl -s localhost:8088/api/sources

# Browse a source's recent logs (pull=bounded scoped search ≤200; push=live-tail buffer)
curl -s "localhost:8088/api/sources/prod-es/logs?limit=50&query=ssh&from=now-15m&to=now"
# -> [{ "ts": "...", "source_ip": "...", "user": "...", "host": "...",
#       "rule": "...", "severity": "...", "message": "...", "_raw": { ... } }]
# 404 unknown source · 501 browse-unsupported connector · 502 read failure

# Delete a source
curl -s -X DELETE localhost:8088/api/sources/edr-webhook
```

A pull source (Elasticsearch) follows the same shape; its secret is the read-only
key:

```bash
curl -s -X POST localhost:8088/api/sources \
  -H 'content-type: application/json' \
  -d '{
        "id": "prod-es",
        "source_type": "elasticsearch",
        "is_primary": true,
        "config": {
          "es_url": "https://elasticsearch:9200",
          "data_view_pattern": "all-logs-*",
          "time_field": "@timestamp",
          "source_ip_field": "source.ip",
          "user_field": "user.name",
          "host_field": "host.name",
          "rule_field": "event.module"
        }
      }'
curl -s -X POST localhost:8088/api/sources/prod-es/secrets \
  -H 'content-type: application/json' -d '{ "es_api_key": "<encoded-read-only-key>" }'
```

### Push an alert to a webhook source

The receiver verifies auth (here bearer), parses + normalises to OCSF, and the
events flow into the same correlate → case pipeline:

```bash
curl -s -X POST localhost:8088/api/ingest/edr-webhook \
  -H 'authorization: Bearer s3cr3t-webhook-token' \
  -H 'content-type: application/json' \
  -d '{ "source.ip": "10.10.1.152", "user.name": "alice", "event.module": "sshd",
        "event.severity": 7, "message": "Failed password for alice" }'
# -> {"ok":true,"received":1,"clusters":...,"investigated":...,"candidates":...}
# A bad/missing token returns 401.
```

### Cases / analytics

```bash
# List cases (filterable: status, surface, entity, limit, offset)
curl -s "localhost:8088/api/cases?limit=20&status=needs_human"
curl -s localhost:8088/api/cases/case-abc123                       # one case
curl -s localhost:8088/api/cases/case-abc123/trace                 # agent trace
curl -s localhost:8088/api/cases/case-abc123/rationale             # the "Why" object (deterministic decision + reasoning + knowledge + commands + memory)

# Analyst lifecycle actions (close/confirm_fp/resolve/reopen/escalate/deescalate/
# hold/resume/set_status/set_disposition/acknowledge); illegal moves → 400
curl -s -X POST localhost:8088/api/cases/case-abc123/action \
  -H 'content-type: application/json' \
  -d '{"action":"escalate","level":2,"note":"paging on-call","analyst":"alice"}'
curl -s -X POST localhost:8088/api/cases/case-abc123/action \
  -H 'content-type: application/json' \
  -d '{"action":"set_disposition","disposition":"true_positive","analyst":"alice"}'

# Re-investigate a stored case in place (NEUTRAL 400 if activity aged out)
curl -s -X POST localhost:8088/api/cases/case-abc123/investigate

# Run a playbook on a case (context-only re-investigation; #3-safe)
curl -s -X POST localhost:8088/api/cases/case-abc123/run-playbook \
  -H 'content-type: application/json' \
  -d '{"playbook_id":"brute-force-login","analyst":"alice"}'

# Threat context for a case (IOC reputation + MITRE + related cases; fail-open)
curl -s localhost:8088/api/cases/case-abc123/threat-context

# Investigate an entity (optional "lookback" overrides; auto-widens on 0 hits)
curl -s -X POST localhost:8088/api/investigate \
  -H 'content-type: application/json' \
  -d '{"entity":{"type":"ip","value":"10.10.1.152"},"source_surface":"investigate"}'

# Chat (add "case_id" / "context" for follow-ups + screen context)
curl -s -X POST localhost:8088/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"list all logs from 10.10.1.152 today","history":[]}'

# Per-log AI overview
curl -s -X POST localhost:8088/api/overview \
  -H 'content-type: application/json' \
  -d '{"source":{"source.ip":"10.10.1.152","user.name":"alice","event.module":"sshd"}}'

# Model catalog for the per-role pickers
curl -s localhost:8088/api/models

# Knowledge base (RAG): stats, browse, import, test-retrieve, delete (seeds need force)
curl -s localhost:8088/api/rag/stats
curl -s localhost:8088/api/rag/documents
curl -s localhost:8088/api/rag/documents/doc-abc123                 # one document's chunks
curl -s "localhost:8088/api/rag/search?q=ssh%20brute%20force&top_k=5"   # live retrieval — see what RAG returns
curl -s -X POST localhost:8088/api/rag/import \
  -H 'content-type: application/json' \
  -d '{"title":"SSH brute-force runbook","text":"...","source":"runbook","tags":["ssh"]}'
curl -s -X DELETE "localhost:8088/api/rag/documents/doc-abc123"        # imported doc
curl -s -X DELETE "localhost:8088/api/rag/documents/seed:runbook?force=true"  # guarded seed needs force

# Agent memory (durable operator facts; source=human via REST)
curl -s localhost:8088/api/memory
curl -s -X POST localhost:8088/api/memory \
  -H 'content-type: application/json' \
  -d '{"text":"10.0.0.0/8 is our internal corporate range","category":"asset","tags":["network"]}'
curl -s -X PUT localhost:8088/api/memory/mem-abc123 \
  -H 'content-type: application/json' -d '{"active":false}'          # retire without deleting
curl -s -X DELETE localhost:8088/api/memory/mem-abc123

# Automated scans + badge
curl -s "localhost:8088/api/scans?limit=20"
curl -s "localhost:8088/api/scans/notifications?since=now-24h"

# Standup, cost
curl -s "localhost:8088/api/standup?window_hours=24"
curl -s "localhost:8088/api/usage/summary?window_hours=24"

# Settings get / patch (+ section / schema / case-id preview)
curl -s localhost:8088/api/settings
curl -s localhost:8088/api/settings/schema
curl -s localhost:8088/api/settings/notifications        # one section
curl -s -X PUT localhost:8088/api/settings \
  -H 'content-type: application/json' \
  -d '{"background_scan_enabled":true,"auto_forward_allowlist":["sshd","suricata"]}'
curl -s -X POST localhost:8088/api/settings/case-id/preview \
  -H 'content-type: application/json' \
  -d '{"template":"CASE-{year}-{seq:06d}","count":3}'

# Manual poll (pull sources)
curl -s -X POST localhost:8088/api/poll
```

### Auth, users + RBAC (only when TLSOC_AUTH_ENABLED=true)

```bash
# Login (returns {requires_mfa, pending_token} when the user has MFA; else {token, user})
curl -s -X POST localhost:8088/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"Admin","password":"Admin@123"}'
# Forced on the seeded admin's first login:
curl -s -X POST localhost:8088/api/auth/change-password \
  -H 'content-type: application/json' \
  -d '{"current_password":"Admin@123","new_password":"<strong-new>"}'
curl -s localhost:8088/api/auth/me                 # current user + role + must_change_password
curl -s localhost:8088/api/roles                   # role → permission matrix

# Users (super_admin)
curl -s localhost:8088/api/users
curl -s -X POST localhost:8088/api/users \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"<temp>","role":"analyst_tier2"}'
curl -s -X PUT localhost:8088/api/users/alice \
  -H 'content-type: application/json' -d '{"role":"soc_manager","active":true}'
curl -s -X DELETE localhost:8088/api/users/alice

# MFA enrolment (self): setup → scan the otpauth_uri QR → confirm
curl -s -X POST localhost:8088/api/auth/mfa/setup     # -> {secret, otpauth_uri, recovery_codes}
curl -s -X POST localhost:8088/api/auth/mfa/confirm -H 'content-type: application/json' -d '{"code":"123456"}'
# Login phase 2: exchange the pending_token + a TOTP (or recovery) code for a session
curl -s -X POST localhost:8088/api/auth/mfa/verify  -H 'content-type: application/json' -d '{"pending_token":"...","code":"123456"}'

# SSO (OIDC)
curl -s localhost:8088/api/auth/sso/providers
curl -s "localhost:8088/api/auth/sso/authorize?provider=google"
```

### Notifications

```bash
curl -s localhost:8088/api/notifications/providers        # email presets + channel types
curl -s -X POST localhost:8088/api/notifications/test \
  -H 'content-type: application/json' -d '{"channel_id":"email-1"}'   # send a sample to one configured channel
curl -s -X POST localhost:8088/api/notifications/channels/slack-1/secret \
  -H 'content-type: application/json' -d '{"field":"webhook_url","value":"https://hooks.slack.com/..."}'
curl -s -X POST localhost:8088/api/cases/case-abc123/notify \
  -H 'content-type: application/json' -d '{"channel_id":"slack-1"}'
```

---

## 11. Safety guarantees you can rely on

These are enforced in **code**, not prompts (see `SECURITY.md`):

- **A TRUE_POSITIVE is never auto-closed.** It always routes to a human.
- **FALSE_POSITIVE auto-close is off by default** and, when enabled, requires high
  confidence AND low risk AND grants a human objection window.
- **Fail-safe routing.** Missing/unknown verdict, router unavailable, kill switch,
  or any pipeline exception → a `needs_human` case (an alert is never dropped).
- **Every LLM call is metered.** 100% of completions and embeddings pass the single
  gateway, which writes the usage/cost ledger (including `error` outcomes).
- **Every agent action is audited**, append-only, from the first prompt.
- **Read-only sources.** Every connector reads with a least-privilege, read-only
  credential; the agent's tools never write the source.
- **No duplicate cases (idempotent).** Cases are keyed by an entity-centric cluster
  signature; re-polling attaches new events to the open case.
- **Inbound push payloads are untrusted.** Push receivers verify auth and fence the
  normalised data as UNTRUSTED in prompts. Raw logs are never sent to a model in
  standup.

---

## 12. Your account — profile, avatar, login (Round 2)

> Account self-service is reachable **only when auth is enabled** (§8h). With auth
> off the suite has no concept of a per-user identity, so these surfaces are hidden
> and `GET /api/account/me` reports `auth_enabled:false`.

The redesigned login is a two-column split (brand hero + form). It still drives the
same four modes — normal sign-in, the forced **OOBE change-password** on the seeded
admin's first login, the **MFA** code step (a 6-cell segmented OTP entry; §8h), and
SSO buttons — and adds a client-only password-strength meter on the OOBE/change
screens. The hero consumes your branding (`org_name`, `logo_data_url`, accent +
secondary accent), so it looks like *your* SOC.

### Edit your profile + avatar

Open **Settings → Personal Account → Profile**. It reads `GET /api/account/me` and
writes `PUT /api/account/me`. Every field is optional and only the fields you change
are written; clearing a field is an explicit empty string (never null):

| Field | Body key | Notes |
|---|---|---|
| Display name | `display_name` | shown in the top bar / audit attribution |
| Short alias | `alias` | a compact handle |
| Alternate email | `alt_email` | a contact address (not the login id) |
| Timezone / locale | `timezone` / `locale` | personal formatting |
| Avatar | `avatar` | a small data-URL image (see below) |
| Personal prefs blob | `prefs` | a small JSON object (bounded) |

**Avatar.** The browser resizes/crops your image to **256×256 WebP** before upload,
so the backend only ever validates a tiny data-URL string. Allowed:
`data:image/png|webp|jpeg;base64,…` (**SVG is rejected**; the body is magic-byte
sniffed and capped). Use the dedicated thin endpoint `PUT /api/me/avatar` to just
set or clear the avatar (an **empty string clears it**).

```bash
# View your own account (auth-on)
curl -s -b cookies.txt localhost:8088/api/account/me

# Patch your profile (only the provided fields change)
curl -s -b cookies.txt -X PUT localhost:8088/api/account/me \
  -H 'content-type: application/json' \
  -d '{"display_name":"Alice Ng","timezone":"Europe/London","alt_email":"alice@corp.example"}'

# Set / clear just the avatar
curl -s -b cookies.txt -X PUT localhost:8088/api/me/avatar \
  -H 'content-type: application/json' -d '{"avatar":"data:image/webp;base64,UklGR..."}'
curl -s -b cookies.txt -X PUT localhost:8088/api/me/avatar \
  -H 'content-type: application/json' -d '{"avatar":""}'    # clear
```

**The env single-admin can't self-edit.** If auth runs as the legacy
environment-seeded single admin (no persisted user record), `account/me` returns
`env_managed:true` and a `PUT` is refused with `400` ("managed via environment
configuration") — exactly like the change-password seam. Create real users (§8h) to
get editable profiles. Secrets never leak: `public()` excludes `password_hash`,
`mfa_secret`, and the recovery-code hashes. Every profile/avatar change is audited.

Your recent account activity is available at `GET /api/account/activity?limit=50`
(your own audit rows, newest first) — it powers the "recent activity" list on the
account page.

---

## 13. Sessions & token policy (Round 2)

When auth is enabled, the stdlib HS256 JWT is now a short-lived **access token**
carrying a session id (`sid`) + token-version (`tv`) claim, backed by a durable
`SessionStore` (in your `STATE_BACKEND`, so sessions survive a restart). Every login
path (password, MFA-verify, SSO callback) registers a session row with its device /
browser / OS / IP (+ city/country when resolvable) — all rendered as **plain data**.

### See and revoke your own sessions

**Settings → Personal Account → Security → Sessions** lists your session cards. The
current one is pinned with a **"This device"** badge; each other row has a
destructive **Revoke**, and a top-right **"Sign out all other sessions"**.

| Action | Endpoint |
|---|---|
| List my sessions (current flagged) | `GET /api/sessions` |
| Revoke one of my sessions | `POST /api/sessions/{sid}/revoke` |
| Sign out my **other** sessions (keep this one) | `POST /api/sessions/revoke-others` (`{"notify":true?}`) |

Revoking your other sessions bumps your `token_version`, so any still-valid JWT for
the other sessions is rejected on its next request (the kept `sid` is preserved).

### Admin: terminate anyone's sessions

Admins (`users:manage`) get **Settings → Administration → Sessions** — every session
across all users, force-terminable. These admin writes are **step-up gated**: if your
last password re-auth is older than the sudo window you get `401 {code:"reauth_required"}`
and the UI pops a re-auth modal (`POST /api/auth/reauth` with your password stamps a
fresh `last_authn_at`).

| Action | Endpoint |
|---|---|
| List ALL sessions | `GET /api/admin/sessions` |
| Force-terminate one session | `POST /api/admin/sessions/{sid}/revoke` (step-up) |
| Global sign-out for one user | `POST /api/admin/users/{username}/revoke-all` (step-up) |

### Token policy (idle / absolute / refresh / sudo)

**Settings → Organization → Security → Token policy** edits the `session_policy`
Preferences sub-model: `access_ttl` (default 900s), `idle_timeout` (1800s),
`absolute_lifetime` (43200s), `refresh_ttl` (604800s), `sudo_reauth_window` (600s),
plus notify-on-new-device / notify-on-terminate toggles. Idle + absolute expiry and
revocation are enforced in `require_auth` (the async gate), not in the hot-path sync
`verify()`. A session whose idle/absolute window has lapsed gets `401
{code:"session_expired"}`.

**Refresh rotation + theft detection.** `POST /api/auth/refresh` rotates the refresh
token (old hash slides to a previous-hash slot) and mints a fresh access token. If a
caller replays an **already-rotated** refresh token, that is treated as theft: the
session is revoked, the user's `token_version` is bumped (global sign-out), the event
is audited + best-effort notified, and a `401 {code:"session_invalid"}` is returned.
`POST /api/auth/logout` revokes the current `sid`.

```bash
curl -s -b cookies.txt localhost:8088/api/sessions
curl -s -b cookies.txt -X POST localhost:8088/api/sessions/revoke-others -d '{}'
curl -s -b cookies.txt -X POST localhost:8088/api/auth/reauth \
  -H 'content-type: application/json' -d '{"password":"<my-password>"}'
curl -s -b cookies.txt -X POST localhost:8088/api/auth/refresh \
  -H 'content-type: application/json' -d '{"refresh_token":"<token>"}'
```

---

## 14. Settings, reorganised — the two-scope IA (Round 2)

Settings is now one left rail split into two scopes:

- **Personal Account** (every signed-in user): Profile (§12), Account, Preferences
  (§18), Notifications view, Security → MFA + Sessions (§13).
- **Organization** (perm-gated): Data Sources & Connectors (incl. per-source feeds,
  §16), Models & LLM, Correlation & Cases, Automation, Notifications (channels +
  templates, §17), Security & SSO + Token policy (§13), Knowledge & Threat Context,
  Enrichment, Appearance / Terminology (§18), Experimental (Demo Mode, §15), and the
  admin-only **Administration** group (Users, Sessions, Audit viewer §19).

RBAC hides sections a role can't use (and auto-jumps off a hidden active section);
with auth/RBAC **off** the default profile still shows everything. The whole tree
still round-trips through the existing `/api/settings`, `/api/branding`,
`/api/roles`, and the per-feature routes — see §9 for the full Preferences reference,
which is unchanged by the IA move.

Several pages were also consolidated: Investigate is a segmented control on the Chat
scaffold, Cost is a tab under Metrics, Standup is a panel on Overview, and
Knowledge / Memory / Catalog live under one **Intelligence** area as distinct tabs.

---

## 15. Demo Mode — a safe, reversible showcase (Round 2)

Demo Mode is a first-class, **reversible, fully isolated** tenant state (not a
fork). Synthetic OCSF events flow through the **real** correlate → risk → decide
pipeline, but every write lands in a **separate in-memory store** with a
**deterministic mock LLM**, so the demo is **$0**, leaves your real data untouched,
and is removed with one flip. Enable it from **Settings → Organization → Experimental**
(admin-only). All demo cases are tagged `demo` and id-prefixed `demo-…`.

| Action | Endpoint | What it does |
|---|---|---|
| Status | `GET /api/demo/status` | `{mode, run_id, history_days, tick_seconds, …}` |
| Enable | `POST /api/demo/enable` | seed synthetic data; start the simulator (admin) |
| Reset | `POST /api/demo/reset` | delete this run + re-seed from the same seed (admin) |
| Disable / clear | `POST /api/demo/disable` | stop the tick + **hard-delete** by `run_id` (admin) |

`mode` is `off` | `seeded` | `live`:

- **`seeded`** pre-generates a trailing **history window** (`history_days`, default
  14) of backdated "old" cases over a fixed fictional org (employees / hosts / a DC /
  VIP / a corp range), a benign baseline, plus 4–6 MITRE ATT&CK storylines
  (phishing → cred-access → lateral → exfil, RDP brute force, SQLi → webshell,
  impossible-travel, ransomware beacon, insider staging).
- **`live`** additionally runs a jittered background **simulator** (`tick_seconds` ≈
  10, `tick_jitter`, `incident_rate`) that streams new benign batches and
  occasionally ignites a storyline, so cases appear in real time.

```bash
curl -s localhost:8088/api/demo/status
curl -s -b cookies.txt -X POST localhost:8088/api/demo/enable \
  -H 'content-type: application/json' \
  -d '{"mode":"live","seed":1337,"history_days":14,"tick_seconds":10,"incident_rate":0.05}'
curl -s -b cookies.txt -X POST localhost:8088/api/demo/reset      # re-seed, same seed
curl -s -b cookies.txt -X POST localhost:8088/api/demo/disable    # exit + hard-delete
```

**While demo is engaged** the app shell shows an amber **Demo banner** with *Reset*
and *Exit & clear*; demo rows carry a `SAMPLE` badge; cost tiles read "(simulated)";
and a guard disables real-write actions (real connector runs, **real notifications**,
live-policy changes). The deterministic Case Manager is never touched — FALSE_POSITIVE
still runs through the **real** `decide()` (against a sandboxed policy copy, proving
the gate) and `NEEDS_HUMAN` stays open as the HITL showcase. The real polling cursor
is left untouched, and `POST /api/demo/disable` flips the state back to `off` and
hard-deletes every demo case / audit / usage / event by `run_id`.

---

## 16. Source feeds — alerts / events / ignore (Round 2)

A pull source's index patterns are now richer **feeds**. The model keeps its wire key
(`config.index_patterns`) and class name (`IndexPattern`) for back-compat, but each
entry can now carry a per-feed **role**, query, mapping, severity floor, and
correlation behaviour. Edit them in the **per-source editor** (Settings → Data Sources
& Connectors → a source → Feeds); the source round-trips through the existing
`POST /api/sources` (additive `config`, no migration).

**Role** (`role`): `alerts` (auto-investigate by default, bypasses the allowlist),
`events` (correlate → auto-forward only when on the allowlist), or the new
**`ignore`** (skip ingest entirely — excluded from the union read, useful to carve a
noisy sub-index out of a broad `events` pattern; longest-pattern-wins precedence).

**Per-feed knobs:**

| Field | Meaning |
|---|---|
| `pattern` | the index pattern (e.g. `wazuh-alerts-*`) |
| `role` | `alerts` \| `events` \| `ignore` |
| `enabled` | turn a feed off without deleting it |
| `query` | a connector-native filter applied to just this feed (operator-**TRUSTED**) |
| `field_mapping` / `message_field` | per-feed overrides (fall back to the source-level mapping) |
| `severity_floor` | OCSF `severity_id` 1–6; below it an event is **not auto-forwarded** but is **still correlated + live-tailed** (never dropped, #4) |
| `correlate` | the per-feed "Auto-Correlate" toggle (legacy `auto_correlate` maps onto this); `false` → candidate-only (manual triage), still correlated |
| `auto_investigate` | `null` → derived from role/legacy (`alerts` or legacy `auto_correlate`); set `true`/`false` to pin it |

**Back-compat is exact.** A stored `{pattern, role, auto_correlate}` dict — or a bare
`"all-logs-*"` string — still validates and yields identical effective behaviour
(`auto_correlate` → `correlate`; `auto_investigate` derived as `role=='alerts' or
legacy auto_correlate`). Each feed gets its **own durable poll cursor**
(`{source.id}:{feed.id}`), so a fast `alerts` feed and a slow `events` feed never
share or skip a cursor (#4). The legacy `config.data_view_pattern` stays synced
(comma-join of the non-`ignore` patterns) for the fallback read path.

```bash
curl -s -X POST localhost:8088/api/sources \
  -H 'content-type: application/json' \
  -d '{
        "id": "prod-es", "source_type": "elasticsearch", "is_primary": true,
        "config": {
          "es_url": "https://elasticsearch:9200",
          "index_patterns": [
            { "pattern": "wazuh-alerts-*", "role": "alerts" },
            { "pattern": "all-logs-*", "role": "events", "severity_floor": 3,
              "query": "event.outcome: failure", "correlate": true },
            { "pattern": "all-logs-debug-*", "role": "ignore" }
          ]
        }
      }'
```

---

## 17. Email — Resend + SES + customizable templates (Round 2)

Two new email channels join the pluggable `NotificationChannel` SPI (§8i), and the
suite now ships **operator-overridable email templates**. Configure both in
**Settings → Organization → Notifications**.

- **Resend** (`type:"resend"`) — an HTTPS-API channel. Its secret is the Resend API
  key (`POST /api/notifications/channels/{id}/secret`); the channel POSTs to
  `https://api.resend.com/emails` with an idempotency key per case/trigger and a
  client-side rate limit. It self-registers, so it appears in
  `GET /api/notifications/providers` → `channel_types`.
- **SES** — shipped as an **SMTP provider preset** (`ses`, host
  `email-smtp.{region}.amazonaws.com:587`, STARTTLS). Supply either ready-made SES
  SMTP credentials **or** a raw IAM access-key pair — the backend derives the SMTP
  password via the stdlib AWS4-HMAC SES chain. No new dependency.

### Customizable templates + live preview

There are **5 preloaded templates** keyed by trigger — `case.new` (`case_created`),
`case.escalation` (`escalated`), `case.resolved` (`closed`), `digest.daily`
(`digest_daily`), and `test`. They render through a tiny **stdlib mustache-subset**
renderer: `{{var}}` is auto HTML-escaped, `{{{var}}}` is raw **only** for trusted
header HTML, with `{{#section}}`/`{{^section}}` and dotted lookup (no `eval`/`getattr`).
Subjects are CRLF-stripped/capped (header-injection safe) and untrusted text in the
`.txt` part is newline-stripped (#9). You override the per-trigger `{subject, html,
text}` in the Notifications template editor (stored under
`notifications.templates.overrides`); anything you don't override falls back to the
built-in default.

**Preview before you save.** `POST /api/notifications/preview?trigger=case_created`
renders a **sample** case server-side and returns the exact `{subject, html, text,
headers}` that would ship — the escaping is authoritative, so the preview pane shows
precisely the wire output. Pass an unsaved `{subject?, html?, text?}` body to preview
edits you haven't persisted yet. No real case data, no real send, no secret leak.

```bash
curl -s localhost:8088/api/notifications/providers      # presets + channel_types + template_ids
curl -s -b cookies.txt -X POST "localhost:8088/api/notifications/preview?trigger=escalated" \
  -H 'content-type: application/json' \
  -d '{"subject":"[{{org_name}}] ESCALATED {{case.case_number}}"}'   # preview an unsaved edit
curl -s -b cookies.txt -X POST localhost:8088/api/notifications/channels/resend-1/secret \
  -H 'content-type: application/json' -d '{"field":"api_key","value":"re_..."}'
```

---

## 18. Personal customization — saved views, table columns, terminology, theme (Round 2)

Customization is a **two-store cascade**: **ORG defaults** on
`Preferences.customization` (admin-only) ← **personal** overrides in a per-user
`UserPrefsStore` (keyed by username when auth is on, a shared `default` bucket when
auth is off — so even the no-auth profile gets real, persisted personal prefs). The
webui hydrates `GET /api/prefs/effective` once on mount and merges the two.

### Saved views

A **saved view** is a named filter/sort/column preset for a scope (e.g. `cases`). The
**Saved-views bar** above a list lets you create from the current filters, switch,
clone, pin, and delete. Org-shared views (`shared:true`, curated by an admin under
`prefs/org`) show up alongside your personal ones; cloning copies any view into your
own set as a fresh, owned, non-shared `… (copy)`.

| Action | Endpoint |
|---|---|
| List my views (personal + org-shared) | `GET /api/views` |
| Create a personal view | `POST /api/views` (`{name, scope, filters, sort, columns?, shared?}`) |
| Edit a personal view (partial) | `PUT /api/views/{view_id}` |
| Delete a personal view | `DELETE /api/views/{view_id}` |
| Clone any view into my set | `POST /api/views/{view_id}/clone` |

### Table columns

Each table persists its own **column state** (order / hidden / widths) per user via
`PUT /api/prefs/user/tables/{table_id}` with `{order, hidden, widths}`. Send an
**all-empty body** to clear the override and revert to that table's default columns.
Theme mode, pinned view ids, and last-list-state live on your personal bucket via
`GET/PUT /api/prefs/user` (a partial patch — only the fields you send change):
`theme_mode` is `light` | `dark` | `system` and overrides the org `default_theme`.

### Terminology

Admins can rename suite nouns org-wide via `GET/PUT /api/terminology` (the map, e.g.
`{"case":"incident","cases":"incidents"}`) or the broader
`GET /api/prefs/org` / `PUT /api/prefs/org` (`CustomizationConfig`: `terminology`,
`default_saved_views`, `default_theme`). The UI renders every label through a
`t(key)` helper; all terminology and view text is **plain data**, never markup and
never an LLM-prompt input (#9). Writes to `prefs/org` + `terminology` are admin-gated
and audited; reads are open to any signed-in user (the cascade needs them).

```bash
curl -s -b cookies.txt localhost:8088/api/prefs/effective       # merged ORG ← USER
curl -s -b cookies.txt -X PUT localhost:8088/api/prefs/user \
  -H 'content-type: application/json' -d '{"theme_mode":"dark"}'
curl -s -b cookies.txt -X POST localhost:8088/api/views \
  -H 'content-type: application/json' \
  -d '{"name":"My escalations","scope":"cases","filters":{"status":"escalated"},"sort":"-created_at"}'
curl -s -b cookies.txt -X PUT localhost:8088/api/prefs/user/tables/cases \
  -H 'content-type: application/json' \
  -d '{"order":["entity","risk","status","created_at"],"hidden":["source_name"],"widths":{}}'
curl -s -b cookies.txt -X PUT localhost:8088/api/terminology \
  -H 'content-type: application/json' -d '{"terminology":{"case":"incident","cases":"incidents"}}'
```

---

## 19. Command palette, global search, bulk actions & the audit viewer (Round 2)

### Cmd-K palette + global search

Press **⌘K / Ctrl-K** anywhere to open the command palette. It calls
`GET /api/search?q=&limit=20` and returns typed hits so you can jump anywhere:

- **cases** — matched on `case_id` / `case_number` / `title` / entity value / `tags`
  / `source_name` (works in Demo Mode too — it reads the active case store).
- **sources** — matched on name / type / id.
- **nav** — static page + settings-section targets, so the palette can navigate the
  whole app.

The endpoint is bounded (`limit` hard-capped) and degrades gracefully (a case-listing
failure just yields no case hits). All matched text is operator/log data rendered as
**plain** (#9).

```bash
curl -s "localhost:8088/api/search?q=10.10.1.152&limit=20"
# -> { "query":"...", "cases":[...], "sources":[...], "nav":[...] }
```

### Bulk case actions

Select multiple rows in the Cases table and apply **one** lifecycle action to all of
them via `POST /api/cases/bulk` with `{ "ids": [...], "action": "...", ...the same
optional CaseAction fields }`. Each id runs through the **exact** single-case human
action path (`_perform_case_action`) — it is **#3-safe** (the analyst layer, never
`decide()` / auto-close), RBAC is enforced once up front (`cases:close` for
close-class moves, else `cases:write`), and each case is **applied + audited
individually**. It is partial-failure tolerant (max 500 ids; a bad id or illegal
transition fails only that row):

```bash
curl -s -b cookies.txt -X POST localhost:8088/api/cases/bulk \
  -H 'content-type: application/json' \
  -d '{"ids":["case-a","case-b","case-c"],"action":"escalate","level":2,"analyst":"alice"}'
# -> { "results":[ {"id":"case-a","ok":true}, {"id":"case-b","ok":false,"error":"..."}, ... ] }
```

### Audit viewer

Admins/auditors get **Settings → Administration → Audit** — a bounded, read-only view
of the append-only audit log (#2). It is gated on `audit:view` (the auditor/admin
grant) and filterable; rows are **newest-first**, hard-capped (≤500), and all text is
rendered as plain (#9 — audit rows carry fenced UNTRUSTED log excerpts).

```bash
curl -s -b cookies.txt "localhost:8088/api/audit?limit=100&actor=alice&action=DECISION&from=now-24h"
# filters: actor, action, surface, case_id, from (alias), to, limit
```
