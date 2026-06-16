# USAGE.md — Using the TLSOC Agentic Triage Suite

A deep, example-driven guide to operating the suite once it is deployed (see
`DEPLOY.md`) and the plugin is installed (see `plugin/BUILD.md`). Everything here
maps 1:1 to the shipped UI and the backend API contract.

The Kibana app registers a single application, **TLSOC Agentic Triage**, with six
tabs once setup is complete:

| Tab | Surface | What it does |
|-----|---------|--------------|
| **Agent Chat** | 1 | Ask read-only questions; get an answer + a result table + one-click Open in Discover |
| **Alerts / Investigate** | 2 | Browse cases; investigate an IP/user/host into a verdict card; case-seeded follow-up chat |
| **Automated Scans** | 3 | The auto-investigation queue + a "new since 24h" notification badge |
| **Daily Standup** | 4 | Aggregate-then-summarise: stats + a prose summary |
| **Cost** | — | Today's spend, tokens, call count, and top cost drivers (24h window) |
| **Settings** | 5 | Every UI-editable preference (also where the wizard lands) |

Until setup is complete the app shows the **first-boot wizard** instead of the
tabs (the plugin checks `setup/status`; if `setup_complete` is false the wizard
renders).

Beyond those tabs the plugin adds two **cross-app** surfaces, available from
anywhere in Kibana: a **global agent chat button** in the chrome header
(Section 2) and a **per-log AI overview** — a Discover doc-viewer tab plus an
in-app per-row action (Section 3).

Everything the browser does goes **through Kibana**: the plugin calls
`/api/tlsoc/<path>` on Kibana, which proxies to `${backendUrl}/api/<path>`. The
browser never holds a backend URL or a secret.

---

## 1. First-boot wizard (4 steps)

The wizard is a four-step horizontal stepper. Each "Save & continue" persists to
the backend immediately, so you can leave and resume.

> The current 4-step wizard is **functional** and gets you fully set up. A deeper
> rewrite (in-wizard data-view create, entity auto-suggest, all per-role models)
> is a tracked enhancement (Feature 5 in `ROADMAP.md`), best validated against a
> live 8.19 Kibana; until then, set those extras on the **Settings** page.

### Step 1 — Elasticsearch keys

Paste two **scoped** API keys (never the `elastic` superuser). The wizard shows
the exact Dev Tools requests to mint them; example role descriptors:

- **Read-only key** (agent reads logs with ONLY this) — scoped to your log
  indices, e.g. `all-logs-*`, privileges `read`, `view_index_metadata`.
- **Management key** (backend owns its own bookkeeping indices) — scoped to
  `tlsoc-agent-*`, privileges `read`, `write`, `create_index`, `manage`.

Paste the `encoded` value of each key into the two boxes and **Save & continue**.
(If you already set `TLSOC_ES_API_KEY` / `TLSOC_ES_MGMT_API_KEY` in `.env`, you
can leave these blank — the wizard only sends non-empty values, and the Settings
page will show them as `configured ✓`.) Under the hood this POSTs
`setup/secrets` with `{ "es_api_key": "...", "es_mgmt_api_key": "..." }`.

### Step 2 — Data scope

Pick the **data view (log source)**. The dropdown is populated from Kibana's data
views; the realistic default for this pipeline is **`all-logs-*`**. Select it and
**Save & continue** (this PUTs `settings` with
`{ "data_view_pattern": "all-logs-*" }` and then loads that view's fields for
step 3).

> If no data views exist, create one in Kibana (Stack Management → Data Views)
> for `all-logs-*` with time field `@timestamp` first.

### Step 3 — Entity field mapping

Map the three entity fields the agent groups and pivots on. The dropdowns are
filled from the chosen data view's fields; defaults match this pipeline's ECS
output:

- **Source IP field** → `source.ip`
- **User field** → `user.name`
- **Host field** → `host.name`

**Save & continue** PUTs `settings` with
`{ "source_ip_field": "source.ip", "user_field": "user.name", "host_field": "host.name" }`.

### Step 4 — LLM keys & models

Paste at least one provider key and confirm the per-role models:

- **Anthropic API key** and/or **OpenAI API key** (password fields; only
  non-empty values are sent via `setup/secrets`).
- **Investigator** provider/model — default `anthropic` / `claude-sonnet-4-6`.
- **Router** provider/model — default `anthropic` / `claude-haiku-4-5-20251001`.

**Finish setup** sends the keys, PUTs the two model configs into `settings`, then
POSTs `setup/complete`. That flips `setup_complete=true` and — if
`polling_enabled` is true (default) — **starts the poller**. The app reloads and
shows the six tabs.

> Defaults you do not set in the wizard still apply: the formatter, standup, and
> chat roles default to `claude-haiku-4-5-20251001`; embeddings default to
> OpenAI `text-embedding-3-small` (and fall back to local hashing embeddings if no
> embedding/OpenAI key is set).

---

## 2. Agent Chat (Surface 1)

A read-only natural-language console. Type a question, press **Send** (or
Cmd/Ctrl+Enter). The agent may turn your intent into a single read-only
`es_query`, render the first 50 hits as a table, and offer **Open in Discover**.

**Example question:**

> `list all logs from 10.10.1.152 today`

**What you get back** (an assistant turn):

- A short prose **answer** plus a one-line query summary.
- A **result table** with the fixed preview columns:
  `@timestamp · ip · user · host · rule · severity · action`. Example rows:

  | @timestamp | ip | user | host | rule | severity | action |
  |---|---|---|---|---|---|---|
  | 2026-06-16T09:14:02Z | 10.10.1.152 | alice | web-01 | sshd | 5 | failed_login |
  | 2026-06-16T09:14:05Z | 10.10.1.152 | alice | web-01 | sshd | 5 | failed_login |

  If there were more than 50 hits, a small "Results truncated." note appears.
- An **Open in Discover** button. Clicking it opens Kibana Discover with the same
  KQL query (`language: kuery`), the same time range (default `now-24h` → `now`),
  and your configured data view (`all-logs-*`) — resolved by title to a real data
  view id, or an ad-hoc spec with `@timestamp` if no saved view matches.

**Other things to try:**

- `how many failed logins per source IP in the last 6 hours`
- `show events for user bob on host db-01`
- `top source IPs today`

If the query fails, the answer appends `(Query failed: …)`. If no LLM provider is
configured, chat replies: *"The assistant is unavailable (no model configured).
Configure an LLM provider key in Settings."* — it never silently errors.

**Clear conversation** resets the thread. History is sent with each turn so
follow-ups have context.

### Global agent chat button

The same chat engine is also reachable from a **persistent button on the
top-right of Kibana's chrome header** — visible from **any** Kibana app, not just
this one (it is registered in `plugin.ts start()` via
`core.chrome.navControls.registerRight`). Click the **discuss** icon to open an
`EuiFlyout` hosting the same read-only `Chat` component (one engine, two entry
points).

What makes it context-aware: at **send time** the flyout snapshots the on-screen
context and ships it with the request. The header chip previews what it will
capture:

- the current **app**,
- the active **data view** (pattern),
- the **time range** (`from → to`),
- the current **query**, and any **selection**.

This snapshot is sent as the `chat` request's `context` field. **Security note:**
server-side the context is fenced as **UNTRUSTED** — it never becomes
instructions. It only supplies **es_query defaults** (e.g. the data view to read
against); the query/selection values are treated as plain data, never executed.
Each chip is rendered as plain text in the UI too.

---

## 3. Per-log AI overview

Get a one-click AI summary of a **single log event** — no full investigation, no
case. Two entry points, one backend call:

- **In Discover** — a custom doc-viewer tab **"TLSOC AI Overview"** on the
  expanded document flyout (registered against the optional `unifiedDocViewer`
  plugin; if it is absent the tab simply does not appear).
- **In-app** — a per-row **AI overview** action in the Agent Chat result table,
  which opens the same overview in a modal.

Both call `POST /api/overview` with the event source
(`{ source, index?, id?, data_view? }`). The backend runs a single-event,
**read-only** agent on the cheap `overview_model` (see Settings), reuses IP
enrichment, and is **cost-ledgered** through the same gateway as every other LLM
call.

**Example response shape:**

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

The card shows **Overview · Why it matters · Suggested next step**, plus
**Entities**, **MITRE** badges, and an **IP reputation** badge when present.

> Cost note: the overview defaults to the cheap `overview_model`
> (`claude-haiku-4-5-20251001`), and its tokens/cost land in the **Cost** tab
> under the `overview` role like any other call.

---

## 4. Alerts / Investigate (Surface 2)

The triage workbench. Three regions, top to bottom:

### a) Investigate by IP / user / host

Choose **IP / User / Host**, type a value (placeholder
`e.g. 10.0.0.5 / alice / web-01`), and click **Investigate**. This POSTs
`investigate` with `{ "entity": { "type": "ip", "value": "10.10.1.152" }, "source_surface": "investigate" }`.
The backend pulls the last 24h of in-scope events for that entity (applying the
same scope + suppression filters the poller uses), correlates them into a cluster,
and runs the full pipeline → enrich → deterministic risk → cheap-router triage →
strong investigator (only if uncertain/serious) → deterministic Case Manager
decision. It returns a **case**, rendered as a **verdict card**.

**Example verdict card** (the case fields the card shows):

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

Rendering:

- Title + a **verdict badge** (TRUE_POSITIVE → red, FALSE_POSITIVE → green,
  inconclusive/unknown → amber), plus `confidence 82%` and `risk 71` badges.
- A **summary** line, an **Evidence** list, **MITRE** technique badges
  (`T1110`, `T1078`), a **Recommended action** row.
- A **Reproduce in Discover** button that opens Discover for `reproduce_query`.

> Decision invariants you can rely on: a **TRUE_POSITIVE is never auto-closed** —
> it routes to a human (`needs_human`), escalated when confidence ≥ the
> escalation threshold or risk is critical. A FALSE_POSITIVE only auto-closes
> under the strict, off-by-default `fp_auto_close` conditions; otherwise a human
> confirms. Anything else fails safe to a human.

### b) Follow-up on this case (case-seeded chat)

After a verdict card appears, a **Follow-up on this case** panel hosts the same
chat engine, but seeded with the case (`case_id`). It already knows the entity,
verdict, confidence, risk, rules, recommended action, and the top evidence, so you
can ask:

> `why did you rule this a true positive?`
> `show me the successful login that followed the brute force`
> `what other hosts did 10.10.1.152 touch?`

The follow-up chat is the **same** read-only engine as Surface 1 — it can run a
query and produce a table + Open in Discover, but it never mutates the case.

### c) Cases table

All cases (`cases?limit=100`), with columns **Entity · Rules · Risk · Status ·
Verdict · Created** and a per-row **Investigate** action (re-runs the pipeline for
that entity). **Refresh** reloads. Statuses you'll see: `open` (candidate awaiting
investigation), `needs_human` (escalated / fail-safe), `closed` (confirmed/auto-
closed FP).

### Case detail + lifecycle

Opening a row loads the **stored** case by id (`GET cases/{id}`) — it does **not**
re-investigate — and the selection survives tab switches. The case-detail view
shows the verdict, status, confidence/risk badges, entity, rules, summary, the
`trigger_reason` ("why this fired"), evidence, MITRE, recommended action,
**Reproduce in Discover**, and the audit **History**. Lifecycle buttons —
**Close / Confirm FP / Escalate / Reopen** — are contextualised by current status
and post to `cases/{id}/action` (see the table below); a separate, explicit
**Re-investigate (LLM)** action exists for when you do want to re-run the pipeline.

### Analyst actions on a case (API)

The card UI focuses on viewing; analyst state changes go through
`POST cases/{case_id}/action` with `{ "action": "...", "note": "...", "analyst": "..." }`.
Valid actions and their effect:

| action | resulting status | meaning |
|---|---|---|
| `close` | `closed` | analyst closes the case |
| `confirm_fp` | `closed` | analyst confirms a false positive |
| `reopen` | `open` | reopen a closed case |
| `escalate` | `needs_human` | push to a human queue |
| `acknowledge` | unchanged | record an ack in history (no status change) |

Every action sets `decision_by=analyst`, stamps `updated_at`, and appends an
`analyst_action` entry to the case **history** (audit trail).

---

## 5. Automated Scans (Surface 3)

The background-investigation queue. The poller correlates each new in-scope
cluster and either:

- **auto-investigates** it (if `background_scan_enabled` is on AND the cluster's
  rule is on the **auto-forward allowlist**, or the allowlist contains `*`), or
- **registers it as an OPEN candidate** (deterministic risk only, no LLM cost) so
  nothing is ever dropped — those appear in **Alerts / Investigate** for manual
  triage.

This tab lists scan-originated cases (`scans?limit=100`) with **Entity · Verdict ·
Risk · Status · Created** and a **Reproduce** action (Open in Discover for the
case's `reproduce_query`, shown only when present).

**Why this fired.** Every case now carries a `trigger_reason` — the deterministic
matched-window detail (which rule, how many events, in what window, grouped on
which entity) plus a plain-English sentence describing it. It is shown both here
in the Automated Scans tab and on the **case detail** view (see Surface 2), so you
can see exactly what tripped the correlation before reading the verdict.

**Notification badge.** While setup is complete, the app polls
`scans/notifications?since=now-24h` every 30 seconds and shows the count of new
scans as a badge on the **Automated Scans** tab. Opening the tab clears the badge.

**How to control auto-forwarding** (Settings → Polling & detection):

1. Turn on **Background scan enabled**.
2. Set the **Auto-forward allowlist** to the rule values you want auto-
   investigated, comma-separated — e.g. `sshd, suricata, windows_security`. Use
   `*` to auto-forward everything (use with care — it spends LLM budget on every
   correlated cluster). An empty allowlist means: register candidates only, never
   auto-investigate.

---

## 6. Daily Standup (Surface 4)

Aggregate-then-summarise. Click **Load standup** (GETs `standup?window_hours=24`).
The backend first runs near-free Elasticsearch aggregations over the window, then
sends ONLY the compact JSON aggregate to the cheap model for prose — **raw logs
are never sent to a model**.

You get:

- A **Summary** prose block.
- Three **stat tiles**: Total events · Unique IPs · Cases.
- Up to four **key/count tables**: Top rules · Top source IPs · Top users · Top
  hosts.

**Example aggregate** (shape returned in `aggregate`):

```json
{
  "total_events": 48213,
  "unique_ips": 1042,
  "cases": 7,
  "by_rule": [{ "key": "sshd", "count": 9120 }, { "key": "suricata", "count": 4310 }],
  "top_source_ips": [{ "key": "10.10.1.152", "count": 412 }],
  "top_users": [{ "key": "alice", "count": 360 }],
  "top_hosts": [{ "key": "web-01", "count": 5021 }]
}
```

**Example summary** (deterministic fallback when the model is unavailable — proves
graceful degradation):

> `Standup (24h): 48213 events across 12 rule type(s). Top rule: sshd. Top source
> IP: 10.10.1.152. 1042 unique source IPs. Cases opened: 7. (LLM summary
> unavailable; this is the deterministic aggregate.)`

If standup is disabled in Settings, the response is
`{ "enabled": false, "summary": "Standup is disabled in settings." }`.

---

## 7. Cost panel

Click into **Cost** (loads automatically; **Refresh** to re-pull
`usage/summary?window_hours=24`). Because **100% of LLM calls go through the single
gateway**, every token is metered here.

Top stat tiles: **Today's spend** (e.g. `$0.0143`), **Total tokens**, **Call
count**, **Total cost (window)**. Below them, breakdown tables (when present):

- **By model** (e.g. `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`)
- **By role** (`router`, `investigator`, `formatter`, `standup`, `chat`,
  `embedding`)
- **By surface** (`investigate`, `automated_scan`, `chat`, …)

Each breakdown row shows **Cost · Tokens · Calls**. A lightweight **Cost over
time** bar chart and a **Top cost drivers** table round it out. Costs render to 4
decimals with the ledger's currency.

> The Cost tab reads the same `tlsoc-agent-usage-*` ledger as the imported **Cost
> & Tokens** dashboard, so the in-app numbers and the dashboard agree.

---

## 8. Settings (Surface 5) — full reference

Settings GET `settings` (prefs + `configured` booleans + `read_only`) and PUT a
partial patch (deep-merged server-side; validated against the `Preferences`
schema). When **read-only mode** is on, a warning shows and the form is disabled.

The page now renders **every** `Preferences` field — there is no longer anything
that is API-only. Organised into collapsible sections, it covers: data scope,
entity mapping, severity/rules, polling, the **seven per-role models** (router,
investigator, formatter, standup, chat, **`overview_model`** for the per-log AI
overview, and embedding), decision thresholds, the correlation table + risk
weights + `asset_networks`, caps + kill switch, suppression rules, the
auto-forward allowlist, enrichment, RAG (incl. `min_score`), standup, and
read-only mode — all round-tripped through `GET`/`PUT /api/tlsoc/settings` by
saving the full prefs object so nothing is dropped.

### Per-role model selection

Each role has a **provider** picker (SuperSelect) and a **model** picker
(ComboBox), plus temperature and max-tokens. The model choices are populated from
the live catalog returned by `GET /api/tlsoc/models` (the price-table models
grouped by provider) — and the UI warns inline when the selected provider has no
configured key. You may also type a **custom** model name. The `overview_model`
controls the cost of the per-log AI overview (Section 3) and defaults to the cheap
`claude-haiku-4-5-20251001`.

### Configured credentials

A row of badges, one per secret, showing **`configured ✓`** or **`not set`**.
Values are **never** shown — the backend only ever returns booleans. Covered:
`es_api_key`, `es_mgmt_api_key`, `openai_api_key`, `anthropic_api_key`,
`abuseipdb_api_key`, `virustotal_api_key`, `embedding_api_key`.

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
and an investigation request returns a `NEEDS_HUMAN` case with
*"Kill switch engaged; investigation skipped."* (Other caps not exposed in the
form but present in the schema: `caps.timeout_seconds` = 120.)

### Automation toggles

| Toggle | Pref | Default |
|---|---|---|
| FP auto-close enabled | `fp_auto_close.enabled` | false |
| Enrichment enabled | `enrichment.enabled` | true |
| RAG enabled | `rag.enabled` | true |
| Standup enabled | `standup.enabled` | true |

`fp_auto_close` also has (schema-level, off by default):
`min_confidence` 0.95, `max_risk_score` 30.0, `objection_window_minutes` 60. A
FALSE_POSITIVE only auto-closes when **enabled AND** confidence ≥ `min_confidence`
**AND** risk ≤ `max_risk_score`, and then only with an objection window.

### Per-rule correlation (JSON editor)

A JSON map of **rule value → `{ mode, n, window_seconds, group_by }`**. Edit it
inline; invalid JSON shows a hint and is not saved until valid. Example:

```json
{
  "sshd":     { "mode": "threshold", "n": 5,  "window_seconds": 120, "group_by": "ip" },
  "suricata": { "mode": "every",     "n": 1,  "window_seconds": 60,  "group_by": "ip" },
  "noisy_rule": { "mode": "never",   "n": 1,  "window_seconds": 60,  "group_by": "host" }
}
```

- **mode**: `threshold` (investigate when ≥ `n` within `window_seconds`, grouped),
  `every` (investigate every occurrence — for rare/high-sev rules), `never`
  (manual only).
- **group_by**: `ip` | `user` | `host`.
- Rules not listed use **default correlation** (`threshold`, `n=5`,
  `window_seconds=120`, `group_by=ip`).

### Read-only footer

The footer shows the current **Data view pattern** and **Entity mapping**
(`ip=… user=… host=…`).

### Save

**Save settings** PUTs the **full** prefs object the form holds (every section
above — data scope/entity mapping, polling, per-role models, thresholds,
correlation + risk weights + asset_networks/asset_criticality, caps, suppression,
scan + allowlist, enrichment/rag/standup, read-only mode), so nothing is dropped.
Saving with `setup_complete` true, `polling_enabled` true, and the kill switch off
(re)starts the poller. The same prefs remain settable directly via the API (see
below) for ops/automation.

---

## 9. Power-user API (`curl`)

The plugin proxies to the backend, but you can call the backend directly for
ops/automation. Two ways:

- **Through Kibana** (uses your Kibana session/CSRF/TLS):
  `https://<kibana>/api/tlsoc/<path>` — GET works directly; POST/PUT need the
  `kbn-xsrf` header.
- **Directly** (inside the Docker network or via the optional published port):
  `http://localhost:8088/api/<path>` from within the `tlsoc-backend` container.

Examples below use the direct backend form. Routes match
`backend/app/api/routes.py` exactly (all under `/api`).

```bash
# Health (es_connected, setup_complete, version, store type)
curl -s localhost:8088/api/health
# -> {"status":"ok","version":"1.0.0","es_connected":true,"store_type":"RealESClient","setup_complete":true}

# Setup status (configured booleans, data view, entity mapping)
curl -s localhost:8088/api/setup/status

# Trigger an immediate poll (returns stats)
curl -s -X POST localhost:8088/api/poll
# -> {"polled":312,"new":45,"clusters":3,"investigated":1,"candidates":2,"attached":0}

# List cases (filterable: status, surface, entity, limit, offset)
curl -s "localhost:8088/api/cases?limit=20&status=needs_human"
curl -s "localhost:8088/api/cases?entity=10.10.1.152"

# Get one case
curl -s localhost:8088/api/cases/case-abc123

# Analyst action on a case
curl -s -X POST localhost:8088/api/cases/case-abc123/action \
  -H 'content-type: application/json' \
  -d '{"action":"escalate","note":"paging on-call","analyst":"alice"}'

# Investigate an entity (one open case per entity; returns the case)
curl -s -X POST localhost:8088/api/investigate \
  -H 'content-type: application/json' \
  -d '{"entity":{"type":"ip","value":"10.10.1.152"},"source_surface":"investigate"}'

# Chat (Surface 1). Add "case_id" to seed a case-follow-up (Surface 2). Add
# "context" (app/data_view/time_range/query/selection) to mimic the header chat
# button; it is fenced UNTRUSTED server-side and only supplies es_query defaults.
curl -s -X POST localhost:8088/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"list all logs from 10.10.1.152 today","history":[]}'

# Per-log AI overview (Section 3). source is the raw event _source; index/id/
# data_view are optional. Returns overview/why_it_matters/suggested_next_step/
# entities/mitre/ip_reputation/cost (cheap overview_model, cost-ledgered).
curl -s -X POST localhost:8088/api/overview \
  -H 'content-type: application/json' \
  -d '{"source":{"source.ip":"10.10.1.152","user.name":"alice","event.module":"sshd"},"index":"all-logs-000001","id":"abc123","data_view":"all-logs-*"}'
# -> {"overview":"...","why_it_matters":"...","suggested_next_step":"...",
#     "entities":["10.10.1.152","alice"],"mitre":["T1110"],
#     "ip_reputation":{"ip":"10.10.1.152","reputation_score":88,"is_malicious":true},"cost":0.0003}

# Model catalog for the Settings per-role pickers (price-table models by provider).
curl -s localhost:8088/api/models
# -> {"providers":{"anthropic":["claude-haiku-4-5-20251001","claude-sonnet-4-6", ...],
#     "openai":[...],"mock":[...]},"configured":{"anthropic_api_key":true, ...}}

# Automated scans + the badge counter
curl -s "localhost:8088/api/scans?limit=20"
curl -s "localhost:8088/api/scans/notifications?since=now-24h"

# Daily standup (aggregate + summary)
curl -s "localhost:8088/api/standup?window_hours=24"

# Cost / usage summary (optionally scope to one case)
curl -s "localhost:8088/api/usage/summary?window_hours=24"
curl -s "localhost:8088/api/usage/summary?window_hours=24&case_id=case-abc123"

# Settings get / patch
curl -s localhost:8088/api/settings
curl -s -X PUT localhost:8088/api/settings \
  -H 'content-type: application/json' \
  -d '{"background_scan_enabled":true,"auto_forward_allowlist":["sshd","suricata"]}'
```

> Through-Kibana POST/PUT example (note the `kbn-xsrf` header):
> ```bash
> curl -s -X POST 'https://kibana:5601/api/tlsoc/poll' -H 'kbn-xsrf: true' -u <user>:<pass>
> ```

---

## 10. End-to-end walkthrough

A complete loop from an event to a costed, audited decision:

1. **Poll.** `POST /api/poll` (or wait for the 30s loop). The poller fetches new
   in-scope events newer than the durable cursor and correlates them. Say a
   cluster forms for `ip:10.10.1.152` (412 failed SSH logins in 90s).
2. **Candidate or auto-investigate.** If `10.10.1.152`'s rule (`sshd`) is on the
   auto-forward allowlist and background scan is on, the cluster is
   auto-investigated as an **Automated Scan**; otherwise it is registered as an
   **OPEN candidate** (deterministic risk only, zero LLM cost) and shows up in
   Alerts / Investigate.
3. **Verdict.** Whether auto or manual, the **same pipeline** runs: enrich the IP
   (AbuseIPDB/VirusTotal, Redis-cached) → deterministic risk score → cheap router
   triage → the strong investigator only if uncertain/serious → the formatter
   emits the strict verdict JSON. You see the verdict card (TRUE_POSITIVE, conf
   0.82, risk 71, MITRE T1110/T1078, recommended action, reproduce query).
4. **Decision (deterministic).** The Case Manager applies code-only rules: this
   TRUE_POSITIVE goes to `needs_human` and is escalated (confidence ≥ threshold).
   It is **never** auto-closed.
5. **Analyst action.** From the case, the analyst escalates / closes / confirms /
   reopens / acknowledges via `cases/{id}/action`. The action is appended to the
   case history with `decision_by=analyst`.
6. **Discover.** Click **Reproduce in Discover** to pivot into raw events for the
   exact `reproduce_query` (e.g. `source.ip: "10.10.1.152" and event.module:
   "sshd"`), pre-set to your data view and time range.
7. **Cost.** Open the **Cost** tab: the investigation's tokens/cost appear under
   the `investigator`/`router`/`formatter` roles and the `investigate` /
   `automated_scan` surface — the same numbers the Cost & Tokens dashboard shows.

---

## 11. Safety guarantees you can rely on

These are enforced in **code**, not prompts:

- **A TRUE_POSITIVE is never auto-closed.** It always routes to a human; the Case
  Manager even raises an invariant error if anything tries to close one.
- **FALSE_POSITIVE auto-close is off by default** and, when enabled, requires
  high confidence AND low risk AND grants a human objection window.
- **Fail-safe routing.** Missing/unknown verdict, router unavailable, kill switch,
  or any pipeline exception → a `needs_human` case (the pipeline never drops an
  alert). No / invalid LLM key → investigations fail safe to `needs_human`; chat
  returns the "assistant unavailable" message.
- **Every LLM call is metered.** 100% of completions and embeddings pass the single
  gateway, which writes the usage/cost ledger (including `error` outcomes when a
  provider is down). Nothing escapes the Cost tab.
- **Every agent action is audited**, append-only, from the first prompt
  (`tlsoc-agent-audit-*`): prompts, es_queries, tool calls, verdicts, decisions,
  polls, scans, errors, and analyst actions.
- **Read-only by construction.** The agent reads logs through a physically
  separate, read-only ES client scoped to your log indices; the management key
  (scoped to `tlsoc-agent-*`) can never read the log surface. The chat/investigate
  engines cannot mutate logs.
- **No duplicate cases (idempotent).** Cases are keyed by an entity-centric
  cluster signature; re-polling a window attaches new events to the existing open
  case rather than spawning a new one. The cursor uses an inclusive lower bound +
  boundary-id dedup, so no event is skipped or reprocessed.
- **Raw logs are never sent to a model in standup.** Aggregations happen in
  Elasticsearch first; only the compact JSON aggregate is summarised. Log-derived
  values placed in prompts are fenced as untrusted DATA.
