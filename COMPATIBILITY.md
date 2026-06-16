# COMPATIBILITY.md — How the suite stays compatible with the upstream pipeline

The TLSOC Agentic Triage Suite is a **read-only consumer** added alongside an
existing production SOC pipeline. This document states exactly how it stays
compatible with [`sankettaware16/foss-soc-engine`](https://github.com/sankettaware16/foss-soc-engine)
and [`sankettaware16/TLSOCDockerDeploy`](https://github.com/sankettaware16/TLSOCDockerDeploy),
and what it deliberately does **not** touch.

## The pipeline we attach to (unchanged)

```
rsyslog (omkafka) → Kafka → foss-soc-engine → Logstash → Elasticsearch (all-logs-*) → Kibana
```

The suite adds **one backend service** (+ an optional Redis cache) and **one
Kibana plugin**. It introduces **no new ingestion**, **no Kafka consumer**, and
**no writes** to the log data path.

## A. Compatibility with `foss-soc-engine`

`foss-soc-engine` parses raw logs into **ECS-normalized** events. The suite is a
**read-only consumer of its output via Elasticsearch** — it never re-parses raw
logs and never touches the engine, its rules, or its output schema.

- **We read the engine's ECS fields, configurably.** The default entity mapping
  matches the fields the engine emits — `source.ip`, `user.name`, `host.name` —
  and the rule/severity fields it produces (`event.module` as the per-event rule
  identity, `rule.name`/`rule.id` where present, `event.severity`). All of these
  are **wizard-configurable** (Settings → entity mapping / rule & severity
  fields), so any future schema additions are handled by configuration, not code.
- **Heterogeneous severity is tolerated.** The engine emits severity across
  `event.severity` (int/string) and `vulnerability.severity` (float). The suite's
  severity handling is type-tolerant (`coerce_float`) and the severity field is
  configurable; query-time threshold filtering simply uses the configured field.
- **GeoIP/enrichment the engine already added** (`source.geo.*`) is read as-is;
  the suite's own `enrich` tool is additive (AbuseIPDB/VirusTotal, Redis-cached)
  and never writes back to the log indices.
- **No requirement on engine internals.** The suite does not depend on the
  engine's output directory, filenames, Redis usage, or parsing strategies. Any
  output-path/filename or Logstash pipeline naming mismatches between the upstream
  repos are **upstream concerns**: the suite reads whatever ultimately lands in
  the `all-logs-*` Elasticsearch surface, regardless of how it got there.

## B. Compatibility with `TLSOCDockerDeploy`

The suite is added as **one new service block** to the existing
`docker-compose.yml` (see `deploy/docker-compose.tlsoc.yml`) and **alters no
existing service**.

- **Network:** the `tlsoc-backend` service joins the existing **default Compose
  network** (no `networks:` key) and reaches Elasticsearch by container-name DNS
  at **`https://elasticsearch:9200`** — exactly as the existing `logstash` service
  does.
- **TLS / certs (reused, not replaced):** it mounts the existing CA read-only
  (`./certs/ca/ca.crt → /certs/ca.crt:ro`) and verifies the ES connection against
  it. It does **not** run `generate-certs.sh`, regenerate, or modify any cert. The
  ES server cert's SAN includes `DNS:elasticsearch`, so connecting via the
  container name validates correctly.
- **Kibana (unchanged image, drop-in plugin):** the pre-built plugin zip is
  installed into the existing `kibana` container's `/usr/share/kibana/plugins`
  (via `kibana-plugin install` or `docker cp` + restart). The Kibana image,
  config, and TLS are untouched. (Plugin install is ephemeral by Phase-1 design.)
- **No port/credential collisions:** the backend listens on **8088** (host
  publish optional); it does not touch `9200`, `5601`, `9092/9093/9094`. It reuses
  the existing `.env` style but with **`TLSOC_`-prefixed** variables so it cannot
  clash with `ELASTIC_PASSWORD`, `KIBANA_PASSWORD`, etc.
- **Kafka/Logstash/ES service definitions:** untouched. The suite does not
  produce to Kafka, does not change Logstash pipelines, and does not write to
  `all-logs-*`.

## C. The security boundary — two scoped keys, never the superuser

The spec mandates a **read-only** ES key for the agent. The backend also has to
**own its own indices** (cases/audit/usage). A single read-only key cannot do
both, and the `elastic` superuser / `kibana_system` are **forbidden at runtime**.
The suite therefore uses **two least-privilege API keys** (both minted by an
operator with the superuser, then the superuser is never used again):

| Key | Scope | Privileges | Used by |
|---|---|---|---|
| `ES_API_KEY` | `all-logs-*` | `read`, `view_index_metadata` | the agent's `es_query` tool — the **only** path to log data |
| `ES_MGMT_API_KEY` | `tlsoc-agent-*` | `read`, `write`, `create_index`, `manage` | the backend's own cases/audit/usage/config/cursor indices |

The read-only key is wired to a **physically separate** ES client
(`RealESClient._ro`) that backs `search_logs` and nothing else, so "running next
to Kibana" can never silently escalate what the agent can touch. The management
key can never read the log surface.

## D. Indices the suite creates (its own, namespaced)

`tlsoc-agent-cases-*`, `tlsoc-agent-audit-*`, `tlsoc-agent-usage-*`, plus the
single-doc `tlsoc-agent-config` and `tlsoc-agent-cursor`. All are namespaced
under `tlsoc-agent-*` and created with the management key on first boot. They do
not overlap `all-logs-*` or any upstream index pattern.

## E. What the suite deliberately does NOT do

- Does **not** modify `foss-soc-engine`, its rules, or its ECS output schema.
- Does **not** modify any existing `TLSOCDockerDeploy` service, the
  rsyslog→Kafka→engine→Logstash→ES path, or the certs.
- Does **not** write to, block, or slow the log data path (read-only consumer).
- Does **not** use `kibana_system` or the `elastic` superuser at runtime.
- Does **not** add a Kafka consumer or any new ingestion mechanism (it **polls**
  Elasticsearch — the store, not the stream).
- Does **not** compile the plugin on the SIEM server (pre-built zip only).
