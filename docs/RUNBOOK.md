# RUNBOOK.md — Day-2 operations

Operating the **TLSOC Agentic Triage Suite** after it is deployed. This is the
day-2 companion to [`DEPLOY.md`](../DEPLOY.md) (cold deploy),
[`docs/USAGE.md`](USAGE.md) (how to use the surfaces),
[`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) (symptom → fix playbook), and
[`SECURITY.md`](../SECURITY.md) (posture). Every command assumes the
`TLSOCDockerDeploy` stack with the `tlsoc-backend` container on the default
Compose network.

> The suite is a **read-only consumer**. None of the operations here write to the
> log surface (`all-logs-*`); they only touch the suite's own `tlsoc-agent-*`
> indices and the running backend.

## 1. Health checks & monitoring

### 1.1 Backend health

```bash
# Direct (inside the container)
docker exec tlsoc-backend curl -s localhost:8088/api/health ; echo
#   -> {"status":"ok","version":"1.0.0","es_connected":true,"store_type":"RealESClient","setup_complete":true}

# THROUGH the Kibana proxy (proves the plugin path works end-to-end)
docker exec kibana curl -fsS http://localhost:5601/api/tlsoc/health ; echo
```

Watch these fields (`api/routes.py:health`):

| Field | Healthy | If wrong |
|---|---|---|
| `es_connected` | `true` | One/both ES keys wrong, `ca.crt` not mounted, or `ES_URL` wrong → see TROUBLESHOOTING; pings `_mgmt or _ro` (`es/client.py:ping`). |
| `store_type` | `RealESClient` | `FakeESClient` / in-memory means ES is unreachable and the suite degraded to a volatile store — **data is not durable**. |
| `setup_complete` | `true` | Wizard not finished; polling has not started. |
| `version` | matches the deployed release | Stale container. |

### 1.2 The bundled dashboards

Import once via Kibana → Stack Management → Saved Objects → Import →
`deploy/dashboards/tlsoc-dashboards.ndjson` (`DEPLOY.md` §7). This adds:

- **Audit** dashboard — over `tlsoc-agent-audit-*` (append-only action trail:
  `prompt`, `es_query`, `tool_call`, `verdict`, `decision`, `error`, `poll`,
  `scan` — `constants.py:ActionType`). Use it to answer "what did the agent do,
  and when".
- **Cost & Tokens** dashboard — over `tlsoc-agent-usage-*` (one row per LLM call;
  `llm/gateway.py`). Use it to track spend and model mix. The in-plugin **Cost**
  tab calls `GET /api/usage/summary` for the same data.

### 1.3 Watch spend and degradation in `tlsoc-agent-usage-*`

Every LLM call writes a usage row (`UsageDoc`) with `cost`, `total_tokens`,
`latency_ms`, `role`, `model`, and `outcome` (`ok` / `error` / `capped`).

```bash
# Spend + error rate, last 24h (run with the mgmt key from an operator host)
curl -s -H "Authorization: ApiKey $MGMT" \
  "https://elasticsearch:9200/tlsoc-agent-usage-*/_search?size=0" --cacert ./certs/ca/ca.crt -H 'Content-Type: application/json' -d '{
    "query": { "range": { "@timestamp": { "gte": "now-24h" } } },
    "aggs": {
      "spend":    { "sum": { "field": "cost" } },
      "tokens":   { "sum": { "field": "total_tokens" } },
      "outcomes": { "terms": { "field": "outcome" } },
      "by_model": { "terms": { "field": "model" } }
    }
  }'
```

- A rising **`error`** outcome count = a **degraded LLM or enrichment** provider
  (the gateway records the failure then fails safe; embeddings fall back to local
  hashing — `gateway.py:embed`). Cross-check provider egress.
- A rising **`spend`** = investigate the cost driver (model mix, volume) → §4.

## 2. Routine operations

### 2.1 Rotating keys

| Key | Durable path (recommended) | Runtime path (ephemeral) |
|---|---|---|
| `TLSOC_ES_API_KEY` (read-only) | Edit `.env` → `docker compose up -d tlsoc-backend` (restart) | Wizard Step 1 → **in-memory only, lost on restart** |
| `TLSOC_ES_MGMT_API_KEY` (mgmt) | Edit `.env` → restart | Wizard Step 1 → in-memory only |
| `TLSOC_ANTHROPIC_API_KEY` / `TLSOC_OPENAI_API_KEY` | Edit `.env` → restart | Wizard Step 4 → in-memory only |
| `TLSOC_ABUSEIPDB_API_KEY` / `TLSOC_VIRUSTOTAL_API_KEY` / `TLSOC_EMBEDDING_API_KEY` | Edit `.env` → restart | Wizard / `POST /api/setup/secrets` → in-memory only |

Rotation procedure (zero log-surface impact):

1. Mint the new ES key(s) with the operator superuser, scoped per
   [`SECURITY.md`](../SECURITY.md) §2 / [`DEPLOY.md`](../DEPLOY.md) §2.
2. Update `.env` with the new `encoded` value(s).
3. `docker compose up -d tlsoc-backend` (recreates the container; the gateway's
   `reset_providers` and the new ES clients pick up the values).
4. Verify `GET /api/health` → `es_connected:true`, then invalidate the old key
   via `DELETE /_security/api_key`.

> **Why restart matters:** wizard-pushed secrets live in process memory only
> (`state.apply_secrets`). `.env` is the durable source of truth
> (`docs/ENVIRONMENT.md` §2.3). Use the wizard for a quick test, `.env` for
> anything that must survive a restart.

### 2.2 Kill switch (emergency stop)

Set `caps.kill_switch=true` (Settings UI, or `PUT /api/settings`). All
investigations stop and polling will not be (re)started while it is set
(`routes.py:put_settings` checks `not prefs.caps.kill_switch`;
`config.py:CapsConfig`). Clear it (`false`) to resume.

```bash
docker exec tlsoc-backend curl -s -X PUT localhost:8088/api/settings \
  -H 'Content-Type: application/json' -d '{"caps":{"kill_switch":true}}'
```

### 2.3 Pause / resume polling

Set `polling_enabled=false` (Settings) to stop the in-process poller without the
kill switch. Re-enabling it (with `setup_complete` true and kill switch off)
restarts the poller (`routes.py:put_settings`, `setup_complete`). Trigger a
one-off poll for a demo with `POST /api/poll` (`routes.py:poll_now`).

### 2.4 Tuning correlation / thresholds

All UI-editable (`config.py:Preferences`; round-trip via `GET`/`PUT /settings`):

- **Severity scope:** `severity_threshold`, `in_scope_rules` (empty = all),
  `excluded_rules`.
- **Correlation:** `default_correlation` and per-rule `correlation_rules`
  (`mode` = `every` / `threshold` / `never`, `n`, `window_seconds`, `group_by`).
- **Risk:** `risk_weights`, `asset_criticality` (exact-value map),
  `asset_networks` (CIDR criticality), `critical_severity`.
- **Decision:** `escalation_confidence`, `fp_auto_close.*`.
- **Caps:** `caps.max_tool_calls`, `max_tokens`, `timeout_seconds`.

### 2.5 The FP auto-close objection window

`fp_auto_close` is **disabled by default** and a TRUE_POSITIVE can **never**
auto-close (`engine/case_manager.py`). When enabled, a FALSE_POSITIVE that meets
`min_confidence` (0.95) **and** `max_risk_score` (30) auto-closes with an
**objection window** (`objection_window_minutes`, default 60) recorded on the
case (`objection_window_expires_at`). During the window an analyst can reopen the
case from the UI (`POST /api/cases/{id}/action` `reopen`). Tune the window to
your team's review latency; widen it if analysts need more time to object.

## 3. Index lifecycle

The suite owns five indices (`constants.py`), created on first boot with the
management key (`COMPATIBILITY.md` §D):

| Index pattern | Type | Growth | Notes |
|---|---|---|---|
| `tlsoc-agent-cases-*` | time-suffixed, write alias | per investigated cluster | rollover-friendly via the template + `-000001` alias |
| `tlsoc-agent-audit-*` | time-suffixed, write alias | **highest** (every action) | append-only |
| `tlsoc-agent-usage-*` | time-suffixed, write alias | high (every LLM call) | cost ledger |
| `tlsoc-agent-config` | **single-doc** (`preferences`) | constant | non-secret preferences |
| `tlsoc-agent-cursor` | **single-doc** (`primary`) | constant | the durable polling cursor |

### 3.1 ILM / rollover + retention guidance

The three date-suffixed indices write through a `<index>` alias backed by
`<index>-000001`, so they are **rollover-ready** (`constants.py` write-alias
comment). Recommended:

- Attach an **ILM policy** to each write alias: rollover on size/age (e.g. 25 GB
  or 7 days), then warm/cold and **delete** after a retention period suited to
  your audit/compliance needs (audit/usage often kept longer than cases).
- Confirm growth with `GET /_cat/indices/tlsoc-agent-*?v`. `audit-*` and
  `usage-*` dominate; size your retention accordingly.

### 3.2 Backup / restore (the suite's own indices)

Snapshot the suite's indices independently of the log surface:

```bash
# Snapshot all suite indices (register a repo first)
PUT /_snapshot/<repo>/tlsoc-<date>?wait_for_completion=true
{ "indices": "tlsoc-agent-*", "include_global_state": false }
```

The two **single-doc** indices (`tlsoc-agent-config`, `tlsoc-agent-cursor`) are
small but **operationally critical**: `config` holds your tuned preferences and
`cursor` holds the durable poll position — back them up so a restore resumes
without re-tuning or re-scanning. Restoring `cursor` avoids a re-scan of history;
deleting it forces a cold-start lookback (`cold_start_lookback_minutes`).

## 4. Scaling notes

- **Poller is single, in-process** today (one `tlsoc-backend` running the
  in-process poller on `poll_interval_seconds`; `engine/poller.py`,
  `CLAUDE.md` §3). **Do not run two replicas** — there is no distributed lock on
  the single-doc cursor, so two pollers would race the cursor and risk
  skip/dup. Scale **vertically** (more CPU/RAM) for Phase 1; horizontal scale is
  a Phase-2 concern.
- **Redis cache** (`tlsoc-redis`) backs enrichment; the backend degrades to an
  in-memory cache without it (`docs/ENVIRONMENT.md` §2.2;
  `EnrichmentConfig.cache_ttl_seconds`). For multi-restart durability of the
  cache, keep Redis up; for cost control, keep the TTL generous (default 6h) to
  protect free-tier enrichment limits.
- **Embeddings / vector store:** embeddings flow through the gateway and fall
  back to local hashing when the provider is down (`gateway.py:embed`). Persisting
  the vector store (ES `dense_vector` kNN behind the `VectorStore` ABC) is in
  progress (see ROADMAP RAG / `CHANGELOG.md` Unreleased); until persisted,
  RAG vectors are rebuilt on restart.

## 5. Incident response (for the tool itself)

| Symptom | First action | Then |
|---|---|---|
| **Runaway spend** | Set `caps.kill_switch=true` (§2.2) to halt investigations now. | Tighten `caps.max_tokens` / `max_tool_calls`, review the **Cost & Tokens** dashboard and `tlsoc-agent-usage-*` by `model`/`role`, switch a role to a cheaper model in Settings, then clear the kill switch. |
| **Bad / suspect verdicts** | Remember verdicts are **advisory** — no auto-action on TRUE_POSITIVE. Re-investigate the case (Investigate surface) or force a fresh run. | Check the **Audit** dashboard for the `prompt`/`tool_call`/`verdict` trail; tune `risk_weights`, `escalation_confidence`, or suppression rules; a wrong FP that auto-closed can be **reopened** within the objection window. |
| **Cursor stuck / no new cases** | Inspect the cursor: `GET tlsoc-agent-cursor/_doc/primary`. | Confirm scope (`severity_threshold`, `in_scope_rules`/`excluded_rules`), confirm `polling_enabled` and kill switch off, `POST /api/poll`. To reprocess from a point, restore/adjust the cursor doc (a cold-start lookback applies if absent). See TROUBLESHOOTING "No cases appear". |
| **LLM/enrichment degraded** | Rising `outcome=error` in usage (§1.3). | Investigations fail safe to NEEDS_HUMAN (never dropped); restore provider egress / rotate keys (§2.1). |
| **`es_connected:false`** | Backend can't reach ES. | Re-check both keys, `ca.crt` mount, `ES_URL` — TROUBLESHOOTING deploy playbook. |

Cross-reference: [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for the full
symptom → cause → fix → confirm matrix.

## 6. Plugin re-install (after a Kibana restart / upgrade)

The plugin directory `/usr/share/kibana/plugins` is **ephemeral by Phase-1
design** — a `docker compose down/up` or an image pull removes the plugin
(`DEPLOY.md` §5 "Accepted Phase-1 limitation"). After any such event:

1. Pick the **version-matched** zip — installing a mismatch fails with a clear
   version error:

   | Running Kibana | Install this committed zip |
   |---|---|
   | **8.12.2** | `plugin/dist/tlsocAgenticTriage-8.12.2.zip` |
   | **8.19.12** | `plugin/dist/tlsocAgenticTriage-8.19.12.zip` |

2. Re-run the install + restart:

   ```bash
   docker exec kibana ./bin/kibana --version    # confirm the version first
   docker cp plugin/dist/tlsocAgenticTriage-8.19.12.zip kibana:/tmp/
   docker exec kibana ./bin/kibana-plugin install file:///tmp/tlsocAgenticTriage-8.19.12.zip
   docker restart kibana
   docker logs kibana | grep tlsocAgenticTriage   # initializes, no "incompatible"
   ```

3. After a **Kibana upgrade**, install the zip matching the **new** version. No
   backend or contract change is needed across 8.12 ↔ 8.19 (`COMPATIBILITY.md`).
   Phase 2 replaces the ephemeral install with a derived image or volume mount.
