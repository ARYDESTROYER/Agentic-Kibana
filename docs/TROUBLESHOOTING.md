# TROUBLESHOOTING.md — TLSOC Agentic Triage Suite

A consolidated symptom → likely cause → fix → confirm playbook spanning build,
deploy, runtime, and usage. Each entry tells you how to **confirm** the fix.

- Build-specific deep dive: `plugin/BUILD.md` (Troubleshooting table).
- Deploy-specific deep dive: `DEPLOY.md` (Deploy failure playbook).
- How everything is supposed to behave: `docs/USAGE.md`.

Quick triage:

```bash
# Backend health (run inside the container, or via the optional published port)
docker exec tlsoc-backend curl -s localhost:8088/api/health ; echo
#   -> {"status":"ok","version":"1.0.0","es_connected":true,...,"setup_complete":...}

# Same health, but THROUGH the Kibana proxy (proves the plugin path works)
docker exec kibana curl -fsS http://localhost:5601/api/tlsoc/health ; echo

# Backend logs (errors, index creation, poll lines)
docker logs tlsoc-backend --tail=100

# Kibana logs (plugin init / incompatibility)
docker logs kibana | grep tlsocAgenticTriage
```

---

## A. Build

| Symptom | Likely cause | Fix | How to confirm |
|---|---|---|---|
| Zip builds but UI never loads / 404 on the bundle | Browser bundle silently dropped (missing `BROWSERSLIST_IGNORE_OLD_DATA`) | `export BROWSERSLIST_IGNORE_OLD_DATA=true` and rebuild | `unzip -l <zip> \| grep tlsocAgenticTriage.plugin.js` lists `target/public/tlsocAgenticTriage.plugin.js` |
| `plugin_helpers ... do not support package plugins` | `kibana.jsonc` used as the manifest | Use `kibana.json` (legacy manifest), not `kibana.jsonc` | Build proceeds; `plugins/tlsoc_agentic_triage/kibana.json` present |
| Bootstrap/build fails on wrong Node | 8.12 needs Node 18.18.2; 8.19 needs Node 22.22.0 | `nvm use` the version pinned by the Kibana checkout | `node -v` prints the expected version |
| 8.19 build aborts at `build-shared` (root guard) | Building as root | Install the `yarn` shim that appends `--allow-root` to `yarn kbn …` (BUILD.md), or build as non-root | Build completes past `build-shared` |
| `[status=403]` for playwright/chromium/ci-stats | Egress allowlist (downloads the build doesn't need) | Ignore; ensure skip env vars are set | Artifact verification still passes |
| Install/runtime says the plugin is incompatible | Built with wrong `--kibana-version` | Rebuild with the running Kibana's version, or install the matching committed zip | `unzip -p <zip> kibana/tlsocAgenticTriage/kibana.json \| grep kibanaVersion` matches Kibana |

See `plugin/BUILD.md` for the full build recipes and verification block.

---

## B. Plugin won't load / version mismatch

**Symptom.** The **TLSOC Agentic Triage** app is missing from the Kibana nav, or
the install command errors.

**Likely cause.** Wrong-version zip; Kibana not restarted after install; or the
ephemeral `plugins/` dir was wiped by a `docker compose down/up`.

**Fix.**
- Install the **version-matched** zip: 8.12.2 → `tlsocAgenticTriage-8.12.2.zip`,
  8.19.12 → `tlsocAgenticTriage-8.19.12.zip` (the installer rejects a mismatch).
- `docker restart kibana` after install.
- If it disappeared after a compose recreate, re-run the install step (Phase-1
  install is ephemeral by design).

**How to confirm.** `docker exec kibana ./bin/kibana --version` matches the zip;
`docker logs kibana | grep tlsocAgenticTriage` shows it initializing with no
`incompatible` / `failed to load`; the app appears in the nav.

---

## C. App loads but 502s ("Failed to reach TLSOC backend")

**Symptom.** The app shows *"Could not reach the TLSOC backend: …"* or individual
tabs error with a 502.

**Likely cause.** The Kibana server-side proxy reached Kibana fine, but couldn't
reach the backend: backend down, wrong container name, or wrong `backendUrl`. The
proxy returns `502 {"error":"bad_gateway","message":"Failed to reach TLSOC
backend at …"}` on a fetch failure.

**Fix.**
- Bring up `tlsoc-backend` and keep that exact container name so the default
  `http://tlsoc-backend:8088` resolves on the shared network.
- If your backend has a different name/host, set
  `tlsocAgenticTriage.backendUrl` in `kibana.yml` and restart Kibana.

**How to confirm.**
`docker exec kibana curl -sS http://localhost:5601/api/tlsoc/health` returns
`{"status":"ok",...}`; `docker logs tlsoc-backend` shows it listening on 8088.

---

## D. Backend `es_connected: false`

**Symptom.** `health` returns `"es_connected": false`; nothing reads logs; index
creation may also fail.

**Likely cause.** Bad/missing ES keys, CA cert not mounted, or wrong ES URL.

**Fix (check all):**
- **Read-only key** `TLSOC_ES_API_KEY` present and scoped to your log indices
  (`read`, `view_index_metadata`).
- **Management key** `TLSOC_ES_MGMT_API_KEY` present and scoped to `tlsoc-agent-*`.
- **CA cert** mounted: `./certs/ca/ca.crt → /certs/ca.crt:ro`, and
  `ES_CA_CERT=/certs/ca.crt`, `ES_VERIFY_CERTS=true`.
- **ES URL** `ES_URL=https://elasticsearch:9200` (container-name DNS; the server
  cert SAN includes `DNS:elasticsearch`).

**How to confirm.** `docker exec tlsoc-backend curl -s localhost:8088/api/health`
→ `"es_connected": true`; `docker logs tlsoc-backend` shows no TLS/auth errors.

> Note: if `es_store_enabled` is on but ES is unreachable, the backend falls back
> to an **in-memory** store so the spine still runs — `store_type` in `health`
> will read an in-memory client name, and data is not durable until ES is fixed.

---

## E. Backend can't create its indices

**Symptom.** `es_connected:true` but the `tlsoc-agent-*` indices never appear;
logs show authorization errors on create/write.

**Likely cause.** The **management** key is missing or under-scoped.

**Fix.** Re-mint the mgmt key with
`read,write,create_index,view_index_metadata,manage` on `tlsoc-agent-*`
(see `DEPLOY.md` step 2 / `.env.example`).

**How to confirm.**
`curl -k -u elastic:$ELASTIC_PASSWORD https://localhost:9200/_cat/indices/tlsoc-agent-*?v`
lists `tlsoc-agent-cases-*`, `-audit-*`, `-usage-*`, plus `tlsoc-agent-config` and
`tlsoc-agent-cursor`.

---

## F. No cases appear

**Symptom.** Alerts / Investigate and Automated Scans are empty after deploy.

**Likely cause.** Nothing is in scope, or no poll has run yet.

**Fix.**
- Lower **`severity_threshold`** (default 0.0 means "no threshold"; a high value
  filters everything out).
- Check **`in_scope_rules`** (empty = all rules) and **`excluded_rules`** — make
  sure your rules aren't excluded.
- Check **suppression_rules** aren't dropping the events.
- Confirm there are recent in-scope events in the data view, then **run a poll**.

**How to confirm.** `POST /api/poll` returns non-zero `polled`/`clusters`; after
it, `GET /api/cases` lists cases and the **Alerts / Investigate** table populates.

---

## G. Duplicate cases (this should not happen)

**Symptom.** You expect to see two cases for the same entity.

**Why it doesn't happen.** Cases are keyed by an **entity-centric cluster
signature** (one open case per `(entity_type, entity_value)`). Re-polling a window
**attaches** new events to the existing open case (idempotently — nothing is added
if there's nothing new) instead of creating a duplicate. The durable cursor uses
an inclusive lower bound + boundary-id dedup, so events are neither skipped nor
reprocessed.

**If you genuinely see duplicates.** That implies two *different* open cases for
the same entity, which the signature prevents — check that you aren't comparing a
closed (historical) case with a newly-opened one for the same entity (a closed
case does not block a new open case for later activity), and confirm the entity
values are byte-identical.

---

## H. Enrichment / RAG / Standup "degraded"

**Symptom.** Enrichment context is thin, RAG seems weak, or standup shows the
deterministic fallback summary.

**Likely cause.** Missing optional keys — by design these degrade gracefully:

- **Enrichment** (AbuseIPDB/VirusTotal): without keys, reputation context is
  limited; GeoIP already present in logs is still read.
- **RAG embeddings**: without an embedding/OpenAI key, the gateway **falls back to
  local hashing embeddings** so RAG keeps working.
- **Standup**: if the summariser model is unavailable, it returns the
  **deterministic** summary (ends with *"(LLM summary unavailable; this is the
  deterministic aggregate.)"*).

**Fix.** Add the relevant keys (`TLSOC_ABUSEIPDB_API_KEY`,
`TLSOC_VIRUSTOTAL_API_KEY`, `TLSOC_EMBEDDING_API_KEY` / `TLSOC_OPENAI_API_KEY`),
or accept the degraded-but-working behavior.

**How to confirm.** The usage ledger records provider failures as **`outcome:
error`** rows — look for them in the **Cost** tab breakdowns or query
`tlsoc-agent-usage-*` for `outcome: error`. A successful standup summary that is
*not* the deterministic fallback means the model is reachable.

---

## I. Cost panel empty

**Symptom.** The Cost tab shows zeros / no breakdowns.

**Likely cause.** No LLM calls have been made yet in the window, or the usage
index isn't being written (ES not connected / mgmt key issue).

**Fix.** Run something that calls a model (investigate an entity, ask a chat
question, load standup), then refresh. If still empty, check `es_connected` and
the mgmt-key scope (sections D and E) — usage is written to `tlsoc-agent-usage-*`.

**How to confirm.** `curl -s "localhost:8088/api/usage/summary?window_hours=24"`
returns non-zero `call_count`/`total_tokens`; the Cost tab tiles update.

> Candidate cases registered by the poller cost **nothing** (deterministic risk
> only), so a queue full of candidates with an empty Cost panel is expected until
> an actual investigation or chat runs.

---

## J. Dashboards import issues

**Symptom.** The Audit / Cost & Tokens dashboards won't import or show "missing
references".

**Likely cause.** The `tlsoc-agent-*` data views (index patterns) aren't present,
or the indices don't exist yet.

**Fix.** Ensure the backend created its indices first (sections D/E), then import
`deploy/dashboards/tlsoc-dashboards.ndjson` (which bundles the dashboards and the
three `tlsoc-agent-*` data views). If you need only the patterns, import
`deploy/dashboards/tlsoc-index-patterns.ndjson`.

**How to confirm.** Stack Management → Saved Objects lists the **Audit** and
**Cost & Tokens** dashboards and the `tlsoc-agent-*` data views; opening a
dashboard renders panels (populating as cases/usage accrue).

---

## K. Kill switch engaged

**Symptom.** Polling stopped and investigations return a `needs_human` case with
*"Kill switch engaged; investigation skipped."*

**Likely cause.** `caps.kill_switch` is on (a deliberate global emergency stop).

**Fix.** Settings → **Caps & kill switch** → uncheck **Kill switch** → Save. With
`setup_complete` true and `polling_enabled` true, saving restarts the poller.

**How to confirm.** `GET /api/settings` shows `caps.kill_switch: false`; a
subsequent `POST /api/poll` investigates/registers normally.

---

## L. "Everything routes to NEEDS_HUMAN"

**Symptom.** Every case lands in `needs_human`, often with low/zero confidence.

**Likely cause.** No or invalid LLM key → the system **fails safe to a human**.
The router defaults to UNCERTAIN when unavailable, and any pipeline failure yields
a `needs_human` case rather than dropping the alert. (Chat shows the "assistant
unavailable (no model configured)" message in the same situation.)

**Fix.** Configure a valid provider key (Settings → credentials should show
`anthropic_api_key: configured ✓` and/or `openai_api_key: configured ✓`); confirm
the per-role model names are valid for that provider.

**How to confirm.** Settings shows the provider as configured; the usage ledger
stops logging `outcome: error` for completions; new investigations produce real
TRUE_POSITIVE / FALSE_POSITIVE verdicts instead of fail-safe `needs_human`.

> This is fail-safe behavior, not a bug: it is always preferable to route an alert
> to a human than to silently dismiss it.

---

## M. Settings won't save / read-only

**Symptom.** The Settings form is disabled with a "Settings are in read-only
mode" banner, or a PUT returns `403 Settings are in read-only mode`.

**Likely cause.** `read_only_settings_mode` is on.

**Fix.** Disable it (the PUT that turns it off must set
`read_only_settings_mode: false`). Programmatically:
`curl -X PUT .../api/settings -d '{"read_only_settings_mode": false}'`.

**How to confirm.** `GET /api/settings` returns `"read_only": false`; the form is
editable again.

---

## N. Invalid `correlation_rules` JSON

**Symptom.** The per-rule correlation editor shows
*"correlation_rules: invalid JSON (not saved until valid)"* and changes don't
persist.

**Likely cause.** The JSON in the textarea is malformed.

**Fix.** Make it valid JSON: a map of rule value → `{ mode, n, window_seconds,
group_by }` (see `docs/USAGE.md` §7). Once valid, the hint clears and **Save
settings** persists it. A `422 Invalid settings` from a PUT means the values
failed schema validation (e.g. `n < 1`, or an unknown `mode`/`group_by`).

**How to confirm.** Save succeeds; `GET /api/settings` shows your
`correlation_rules` map.
