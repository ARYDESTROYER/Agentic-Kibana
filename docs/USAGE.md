# USAGE.md — Using the Agentic SOC Triage Suite

A deep, example-driven guide to operating the suite once it is deployed (see
`DEPLOY.md`) and the standalone web UI is up. Everything here maps 1:1 to the
shipped UI and the backend API contract (`backend/app/api/routes.py`).

> **The standalone web UI is the primary surface.** It is a self-hosted SPA
> (Vite + React + `@elastic/eui`, in `webui/`) that talks to the FastAPI backend
> **directly** over `/api/*` (proxied by nginx in production). The old Kibana
> plugin (`plugin/tlsoc_agentic_triage/`) is **legacy**; this document describes
> the standalone UI.

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
| **Sources** | Add / edit / test / delete log sources (pull + push); mark one primary |
| **Cases** | Browse cases; open case detail + lifecycle (Preview in the standalone UI) |
| **Chat** | Ask read-only questions; get a two-turn analysis + result table (Preview) |
| **Investigate** | Investigate an IP/user/host into a verdict card (Preview) |
| **Scans** | The auto-investigation queue (Preview) |
| **Standup** | Aggregate-then-summarise daily report (Preview) |
| **Cost** | Today's spend, tokens, call count, top cost drivers (Preview) |
| **Settings** | Full Preferences + per-role models + secret status; re-run the wizard |

> **Preview note.** The wizard, Sources manager, and Settings are fully built in
> the standalone UI. The analytics surfaces (Cases / Chat / Investigate / Scans /
> Standup / Cost) currently call their endpoints and render **basic results** —
> they are marked **Preview** and will be fully ported later (`webui/README.md`).
> Their backend endpoints are complete and fully usable via `curl` today
> (Section 9).

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

---

## 3. Cases (Surface)

The triage workbench. The cases table (`GET /api/cases?limit=100`) shows **Entity
· Rules · Risk · Status · Verdict · Created** with per-status filtering
(`?status=needs_human`), per-surface filtering (`?surface=automated_scan`), and
per-entity filtering (`?entity=10.10.1.152`). Statuses: `open` (candidate awaiting
investigation), `needs_human` (escalated / fail-safe), `closed` (confirmed /
auto-closed FP).

### Case detail + lifecycle

Opening a case loads the **stored** case by id (`GET /api/cases/{id}`) — it does
**not** re-investigate. The detail view shows the verdict, status, confidence/risk
badges, entity, rules, summary, the `trigger_reason` ("why this fired"), evidence,
MITRE techniques, recommended action, the reproduce query, and the **History**.

**Analyst actions** go through `POST /api/cases/{id}/action` with
`{ "action": "...", "note": "...", "analyst": "..." }`:

| action | resulting status | meaning |
|---|---|---|
| `close` | `closed` | analyst closes the case |
| `confirm_fp` | `closed` | analyst confirms a false positive |
| `reopen` | `open` | reopen a closed case |
| `escalate` | `needs_human` | push to a human queue |
| `acknowledge` | unchanged | record an ack in history (no status change) |

Every action sets `decision_by=analyst`, stamps `updated_at`, and appends an
`analyst_action` entry to the case **history**. A `close` / `confirm_fp` also
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

## 9. Settings — full reference

Settings GET `/api/settings` (`{ prefs, configured, read_only }`) and PUT a
partial patch (deep-merged server-side; validated against the `Preferences`
schema). When **read-only mode** is on, a `403` is returned. The page renders
**every** `Preferences` field — data scope, entity mapping, severity/rules,
polling, the **seven per-role models** (router, investigator, formatter, standup,
chat, `overview_model`, embedding), decision thresholds, the correlation table +
risk weights + `asset_networks`, caps + kill switch, suppression rules, the
auto-forward allowlist, enrichment, RAG, standup, the **rule catalog** + per-rule
model overrides, the **trace** toggle, and read-only mode.

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

# Analyst action
curl -s -X POST localhost:8088/api/cases/case-abc123/action \
  -H 'content-type: application/json' \
  -d '{"action":"escalate","note":"paging on-call","analyst":"alice"}'

# Re-investigate a stored case in place (NEUTRAL 400 if activity aged out)
curl -s -X POST localhost:8088/api/cases/case-abc123/investigate

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

# Settings get / patch
curl -s localhost:8088/api/settings
curl -s -X PUT localhost:8088/api/settings \
  -H 'content-type: application/json' \
  -d '{"background_scan_enabled":true,"auto_forward_allowlist":["sshd","suricata"]}'

# Manual poll (pull sources)
curl -s -X POST localhost:8088/api/poll
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
