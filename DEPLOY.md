# DEPLOY.md — Cold deployment of the TLSOC Agentic Triage Suite

This guide is written for a **fresh session with SSH access to the running SIEM
server and nothing else** (no build context). The Kibana plugin is **already
built and committed** — you will **not** compile anything on the server.

> **CRITICAL — no plugin compilation on the server.** The plugin ZIPs
> (`plugin/dist/tlsocAgenticTriage-8.12.2.zip` and
> `plugin/dist/tlsocAgenticTriage-8.19.12.zip`) were built in a separate session
> against the cloned Kibana source. The fragile `yarn kbn bootstrap` toolchain
> must **never** run on the SIEM server. Here you only unzip + restart. **Install
> the zip that matches your running Kibana version** (see the table in step 5).

---

## 0. Prerequisites (already true on the target)

- The **TLSOCDockerDeploy** stack is up: `elasticsearch`, `kibana`, `logstash`,
  `kafka` containers running, TLS certs generated under `./certs/`, logs landing
  in `all-logs-*`.
- You have the stack's `ELASTIC_PASSWORD` (the `elastic` superuser) — used **only
  by you, once, to mint scoped API keys**. The suite itself never uses it.
- `docker` / `docker compose` available; outbound registry access for `redis:7-alpine`
  and to build the backend image (small, pure-Python).

## 1. Get this repository onto the server

Clone it **next to** the TLSOCDockerDeploy `docker-compose.yml` so the compose
build context resolves:

```bash
cd /path/to/TLSOCDockerDeploy
git clone <this-repo-url> agentic-kibana
# now: ./docker-compose.yml  and  ./agentic-kibana/{backend,plugin,deploy}
```

## 2. Mint TWO scoped Elasticsearch API keys (NEVER the superuser)

The suite uses two least-privilege keys (see `COMPATIBILITY.md` for why two).
Mint them with the `elastic` user **once**, then never use the superuser again.

**Read-only key** (the agent reads logs with ONLY this):

```bash
curl -k -u elastic:$ELASTIC_PASSWORD -X POST https://localhost:9200/_security/api_key \
  -H 'Content-Type: application/json' -d '{
    "name": "tlsoc_agent_readonly",
    "role_descriptors": {
      "tlsoc_agent_readonly": {
        "indices": [
          { "names": ["all-logs-*"], "privileges": ["read","view_index_metadata"] }
        ]
      }
    }
  }'
```

**Management key** (the backend owns its OWN indices with this — scoped to
`tlsoc-agent-*` only, it can never read the log surface):

```bash
curl -k -u elastic:$ELASTIC_PASSWORD -X POST https://localhost:9200/_security/api_key \
  -H 'Content-Type: application/json' -d '{
    "name": "tlsoc_agent_mgmt",
    "role_descriptors": {
      "tlsoc_agent_mgmt": {
        "indices": [
          { "names": ["tlsoc-agent-*"],
            "privileges": ["read","write","create_index","view_index_metadata","manage"] }
        ]
      }
    }
  }'
```

Each response returns an `"encoded"` value — that base64 string is the API key.
(You can also mint these in Kibana: **Stack Management → Security → API keys →
Create API key → Restrict privileges**, pasting the same role descriptors.)

## 3. Configure `.env`

```bash
cp agentic-kibana/.env.example .env     # in the TLSOCDockerDeploy dir
```

Fill in `.env`:

- `TLSOC_ES_API_KEY` = the **read-only** `encoded` value from step 2.
- `TLSOC_ES_MGMT_API_KEY` = the **management** `encoded` value from step 2.
- `TLSOC_ANTHROPIC_API_KEY` and/or `TLSOC_OPENAI_API_KEY` (at least one).
- Optional: `TLSOC_ABUSEIPDB_API_KEY`, `TLSOC_VIRUSTOTAL_API_KEY`,
  `TLSOC_EMBEDDING_API_KEY`.

Secrets live **only** in this `.env` / the container environment — never in the
plugin, never in any Elasticsearch index, never committed.

## 4. Add the backend service and bring it up

Open `agentic-kibana/deploy/docker-compose.tlsoc.yml` and **copy the
`tlsoc-backend` (and optional `tlsoc-redis`) entries into the `services:` map of
your existing `docker-compose.yml`**. Do not modify any existing service. (The
new service joins the default network, reaches `https://elasticsearch:9200` by
container name, and mounts the existing `./certs/ca/ca.crt` read-only.)

```bash
docker compose up -d --build tlsoc-backend tlsoc-redis

# Verify the backend is healthy and created its indices:
docker exec tlsoc-backend curl -fsS http://localhost:8088/api/health ; echo
# -> {"status":"ok",...,"es_connected":true,"setup_complete":false}
docker logs tlsoc-backend --tail=50         # look for "AppState started" + index creation
curl -k -u elastic:$ELASTIC_PASSWORD https://localhost:9200/_cat/indices/tlsoc-agent-*?v
```

## 5. Install the PRE-BUILT plugin into the Kibana container (no compilation)

**First, pick the zip that matches your running Kibana version.** Check it with
`docker exec kibana ./bin/kibana --version` (or read it from the Kibana image
tag), then choose:

| Running Kibana | Install this committed zip                         |
|----------------|----------------------------------------------------|
| **8.12.2**     | `plugin/dist/tlsocAgenticTriage-8.12.2.zip`        |
| **8.19.12**    | `plugin/dist/tlsocAgenticTriage-8.19.12.zip`       |

Installing the wrong-version zip fails with a clear version-mismatch error (the
installer refuses it). Substitute the matching filename below.

```bash
# Copy the committed, already-built zip into the running Kibana container:
# --- Kibana 8.12.2 ---
docker cp agentic-kibana/plugin/dist/tlsocAgenticTriage-8.12.2.zip kibana:/tmp/
docker exec kibana ./bin/kibana-plugin install file:///tmp/tlsocAgenticTriage-8.12.2.zip

# --- Kibana 8.19.12 (use this instead, if that is your version) ---
# docker cp agentic-kibana/plugin/dist/tlsocAgenticTriage-8.19.12.zip kibana:/tmp/
# docker exec kibana ./bin/kibana-plugin install file:///tmp/tlsocAgenticTriage-8.19.12.zip

docker restart kibana
docker logs kibana -f      # watch for the plugin id "tlsocAgenticTriage" initializing
#   Look for a line like: "Plugin "tlsocAgenticTriage" is initializing..." /
#   the plugins:tlsocAgenticTriage logger, and NO "incompatible"/"failed to load".
```

> **Backend URL:** the plugin defaults to `http://tlsoc-backend:8088`, which
> resolves on the shared Docker network because the backend container is named
> `tlsoc-backend`. Keep that name and no Kibana config change is needed. To
> override, set `tlsocAgenticTriage.backendUrl` in the Kibana config.

> **Alternative drop-in install** (if you prefer the spec's folder method):
> `unzip` the archive's `kibana/tlsocAgenticTriage` folder into
> `/usr/share/kibana/plugins/tlsoc_agentic_triage` inside the container and
> restart.

> **Accepted Phase-1 limitation:** `/usr/share/kibana/plugins` is ephemeral. A
> `docker compose down/up` or image pull removes the plugin — just re-run this
> step. Phase 2 replaces this with a derived image or a volume mount.

### Post-install verification checklist

Confirm all four before continuing to the wizard:

1. **Plugin appears in nav.** Open Kibana → the left nav (or the app launcher)
   lists **TLSOC Agentic Triage**. Opening it shows either the setup wizard or the
   six tabs (Agent Chat · Alerts / Investigate · Automated Scans · Daily Standup ·
   Cost · Settings).
2. **Backend health is reachable THROUGH the Kibana proxy.** From the Kibana
   container:
   ```bash
   docker exec kibana curl -fsS http://localhost:5601/api/tlsoc/health ; echo
   #   -> {"status":"ok","version":"1.0.0","es_connected":true,...}
   ```
   (Adjust for a `server.basePath`/auth if your Kibana uses them; the in-browser
   app uses the authenticated session automatically.)
3. **The Kibana log shows the plugin initialized** with no `incompatible` /
   `failed to load` lines (`docker logs kibana | grep tlsocAgenticTriage`).
4. **The wizard renders** (if `setup_complete` is false) — the four-step horizontal
   stepper "TLSOC Agentic Triage — first-time setup" is visible.

If any check fails, see the **Deploy failure playbook** below before proceeding.

## 6. First-boot wizard

Open Kibana → the **TLSOC Agentic Triage** app. If you set all secrets in `.env`,
the wizard's key steps already show **configured ✓**; otherwise paste keys in the
wizard. Then:

1. **Step 1 — ES key**: confirm/paste the read-only (and management) key.
2. **Step 2 — Data scope**: pick the data view (default `all-logs-*`) + severity scope.
3. **Step 3 — Entity mapping**: map source IP / user / host fields (defaults
   `source.ip`, `user.name`, `host.name`).
4. **Step 4 — LLM keys & models**: confirm provider keys and per-role models.

Finish → polling starts. Use **POST `/api/poll`** (or the Settings page button)
to trigger an immediate poll for the demo.

## 7. Import the bundled dashboards

Kibana → **Stack Management → Saved Objects → Import** →
`agentic-kibana/deploy/dashboards/tlsoc-dashboards.ndjson`. This adds the
**Audit** and **Cost & Tokens** dashboards (and the three `tlsoc-agent-*` data
views). The backend's indices already exist from step 4, so the dashboards
populate as cases/audit/usage accrue.

## 8. Verify end-to-end

- `docker exec tlsoc-backend curl -s localhost:8088/api/health` → `es_connected:true`.
- Trigger a poll, then check cases: `curl -s localhost:8088/api/cases` (inside the
  container) or use the plugin's **Alerts** tab.
- Open a case → **Investigate** → verdict card → **Reproduce in Discover**.
- Check the **Cost** tab and the imported **Cost & Tokens** dashboard.

## Troubleshooting — deploy failure playbook

For build-time failures see `plugin/BUILD.md`. For runtime/usage issues see
`docs/TROUBLESHOOTING.md`. Deploy-specific failures:

| Symptom | Likely cause | Fix | How to confirm |
|---|---|---|---|
| Plugin **not visible** in Kibana nav | Install didn't take, or Kibana wasn't restarted; or the plugin folder was wiped by a `compose down/up` | Re-run step 5 (matching-version zip), then `docker restart kibana` | `docker logs kibana \| grep tlsocAgenticTriage` shows it initializing |
| Install error: **`... is not compatible with Kibana <Y>`** / `version X ... expected ...` | Wrong-version zip for the running Kibana | Install the version-matched zip (8.12.2 ↔ `8.12.2.zip`, 8.19.12 ↔ `8.19.12.zip`) | `docker exec kibana ./bin/kibana --version`; `unzip -p <zip> kibana/tlsocAgenticTriage/kibana.json \| grep kibanaVersion` |
| App loads but every call shows a **502 / "Failed to reach TLSOC backend"** | Backend down, wrong container name, or wrong `backendUrl` | Bring up `tlsoc-backend`; keep its name `tlsoc-backend` so the default `http://tlsoc-backend:8088` resolves; otherwise set `tlsocAgenticTriage.backendUrl` in kibana.yml and restart Kibana | `docker exec kibana curl -sS http://localhost:5601/api/tlsoc/health`; `docker logs tlsoc-backend` |
| Health returns **`es_connected:false`** | One/both ES keys wrong, `ca.crt` not mounted, or `ES_URL` wrong | Re-check `TLSOC_ES_API_KEY` (read-only) and `TLSOC_ES_MGMT_API_KEY`, that `./certs/ca/ca.crt` is mounted to `/certs/ca.crt:ro`, and `ES_URL=https://elasticsearch:9200` | `docker exec tlsoc-backend curl -s localhost:8088/api/health`; `docker logs tlsoc-backend` |
| Backend **can't create its indices** | The **management** key is missing/under-scoped | The mgmt key needs `read,write,create_index,view_index_metadata,manage` on `tlsoc-agent-*` (re-mint per step 2) | `curl -k -u elastic:$ELASTIC_PASSWORD https://localhost:9200/_cat/indices/tlsoc-agent-*?v` lists the indices |
| **No cases appear** after polling | Nothing in scope, or no poll has run | Lower `severity_threshold`, clear/verify `in_scope_rules`/`excluded_rules`, then trigger a poll | POST `/api/poll` returns non-zero `polled`/`clusters`; **Alerts / Investigate** then lists cases |

## Migration (upgrading an existing deployment to the Cycle 2/3 build)

Short upgrade path for a stack that already runs an earlier build. No data
migration is required.

1. **Reinstall the matching plugin zip** (now **~68 KB** for 8.19.12). Inside the
   Kibana container:
   ```bash
   docker exec kibana ./bin/kibana-plugin remove tlsocAgenticTriage
   docker cp agentic-kibana/plugin/dist/tlsocAgenticTriage-8.19.12.zip kibana:/tmp/
   docker exec kibana ./bin/kibana-plugin install file:///tmp/tlsocAgenticTriage-8.19.12.zip
   docker restart kibana
   ```
   (Use the `8.12.2.zip` instead if that is your running Kibana.)
2. **Restart the backend.** On startup it **seeds `prefs.rule_catalog`** (the 13
   `event.module` rules + 5 ModSec sub-rules) — **version-guarded**, so it never
   overwrites operator edits. The new preference fields
   (`investigate_lookback`, `rule_catalog`, `rule_model_override`,
   `trace.include_prompts`) are **additive with safe defaults**, so there is no
   manual settings migration:
   ```bash
   docker compose up -d --build tlsoc-backend     # rebuild picks up code + pricing changes
   ```
3. **Elasticsearch indices — nothing new this cycle.** No new index or template is
   introduced. The resolved-case RAG store (`tlsoc-agent-rag`, `dense_vector`) was
   added in the prior P1 cycle and is created **lazily on first embed**; the agent
   trace simply reads the existing `tlsoc-agent-audit`.
4. **Pricing.** If you edited `backend/app/llm/pricing.py` `PRICES` (e.g. to
   correct the operator-verifiable approximations), the backend rebuild in step 2
   picks them up.

No upstream pipeline change; no downtime beyond the Kibana + backend restarts.

## What you did NOT do (by design)

- You did **not** compile the plugin (the ZIP was pre-built).
- You did **not** use the `elastic` superuser at runtime (only to mint keys).
- You did **not** modify any existing service, the log pipeline, or the ECS schema.
