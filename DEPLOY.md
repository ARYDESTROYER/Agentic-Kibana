# DEPLOY.md — Cold deployment of the TLSOC Agentic Triage Suite

This guide is written for a **fresh session with SSH access to the running SIEM
server and nothing else** (no build context). The Kibana plugin is **already
built and committed** — you will **not** compile anything on the server.

> **CRITICAL — no plugin compilation on the server.** The plugin ZIP
> (`plugin/dist/tlsocAgenticTriage-8.12.2.zip`) was built in a separate session
> against the cloned Kibana source. The fragile `yarn kbn bootstrap` toolchain
> must **never** run on the SIEM server. Here you only unzip + restart.

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

```bash
# Copy the committed, already-built zip into the running Kibana container:
docker cp agentic-kibana/plugin/dist/tlsocAgenticTriage-8.12.2.zip kibana:/tmp/

# Install it with kibana-plugin (uses the official installer; correct structure):
docker exec kibana ./bin/kibana-plugin install file:///tmp/tlsocAgenticTriage-8.12.2.zip

docker restart kibana
docker logs kibana -f      # watch for the plugin id "tlsocAgenticTriage" initializing
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

## Troubleshooting

| Symptom | Fix |
|---|---|
| `es_connected:false` | Check `TLSOC_ES_*` keys, that `ca.crt` mounted, and `ES_URL=https://elasticsearch:9200`. |
| Backend can't write indices | The **management** key is missing/under-scoped (needs `create_index` on `tlsoc-agent-*`). |
| Plugin not visible | Re-run step 5; confirm `docker logs kibana` shows `tlsocAgenticTriage`. |
| Plugin can't reach backend | Confirm the backend container is named `tlsoc-backend` and both share the network, or set `tlsocAgenticTriage.backendUrl`. |
| No cases appear | Lower `severity_threshold`, ensure rules are in scope, and POST `/api/poll`. |

## What you did NOT do (by design)

- You did **not** compile the plugin (the ZIP was pre-built).
- You did **not** use the `elastic` superuser at runtime (only to mint keys).
- You did **not** modify any existing service, the log pipeline, or the ECS schema.
