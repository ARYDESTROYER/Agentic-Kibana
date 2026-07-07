# INGESTION.md — getting data into the agentic SOC

> How the suite ingests security logs/alerts/events from **anything**. This is the
> reference for the connector framework (`backend/app/connectors/`) and the
> supported transports. Companion to `docs/AGNOSTIC_ARCHITECTURE.md` (the why) and
> `CLAUDE.md` (the rules). Every record, whatever its origin, is normalised to
> **OCSF** (`backend/app/ocsf/`) before the engine sees it.

## 1. Two ways data arrives

Every source is one of two physical shapes, sharing one SPI (`connectors/base.py`):

- **`PullConnector`** — *we drive it.* We poll a search/query API on a durable
  cursor (and run ad-hoc structured searches for the agent's `es_query` tool).
  **Built (3):** Elasticsearch, OpenSearch, Wazuh (its indexer reuses the
  OpenSearch connector) — plus a 4th, `DemoPullConnector`, active only in Demo
  Mode. **Roadmap slots — `SourceType` enum members with no connector class yet
  (7):** Splunk, Sentinel (Microsoft Sentinel), QRadar, Chronicle, CrowdStrike,
  SentinelOne, Defender (Microsoft Defender hunting).
- **`PushReceiver`** — *it drives us.* We run a listener / consume a broker / poll
  an object store, and events arrive asynchronously, fed into the **same**
  `correlate → risk → cost-gate → LLM → case` pipeline the poller feeds. **16
  built** — see §3/§8 for the full transport-by-transport status.

The engine and agents never see source-native records — only `OCSFEvent` /
`RawEvent`. A connector's only source-specific job is `to_ocsf()`.

## 2. Supported ingest modes (`IngestMode`)

| Mode | Meaning | Cursor / durability |
|---|---|---|
| `PULL` | poll a search API | timestamp watermark + tiebreaker id (the suite default) |
| `PUSH_HTTP` | we run an HTTP(S) listener; the source POSTs | client-side dedup by event id (at-least-once) |
| `PUSH_SYSLOG` | we run a syslog listener (UDP/TCP/TLS) | none (UDP fire-and-forget); dedup downstream |
| `PUSH_SOCKET` | raw TCP/UDP/gRPC line/stream listener | none / framing-dependent |
| `QUEUE` | we consume a broker | durable broker/partition **offset** |
| `OBJECT_STORE` | we list+get objects (S3/GCS/Blob) | last processed **object key/marker** |
| `STREAM` | long-lived provider stream | provider offset/sequence |

## 3. Capability matrix (transports)

Push receivers, queue consumers, and object-store pollers — the universal
"pipes". (Vendor SIEM/EDR pull connectors are covered in
`AGNOSTIC_ARCHITECTURE.md` §5 and per-connector manifests.)

| Transport (`SourceType`) | Status | Mode | Durable offset / ack | Replay | Auth / TLS | pip (lazy) | Notes |
|---|---|---|---|---|---|---|---|
| `webhook` | ✅ built | PUSH_HTTP | client dedup | sender-retry | HMAC-SHA256 · bearer · mTLS | — (FastAPI) | **universal cloud push**; JSON/NDJSON/array; verify HMAC on raw bytes before parse |
| `hec` | ✅ built | PUSH_HTTP | indexer-ack ext | — | `Splunk <token>` | — | Splunk-HEC-compatible; unwraps `{event,fields,time}`; any HEC forwarder (Cribl/Vector/UF) can ship to us |
| `syslog` | ✅ built | PUSH_SYSLOG | none | no | none / TLS (6514) | — (asyncio) | RFC 3164 + 5424; UDP/TCP; octet-counting + newline framing |
| `otlp` | ○ not built | PUSH_HTTP/SOCKET | per-stream ack | no | bearer · mTLS | `opentelemetry-proto`,`grpcio` | OTel logs gRPC 4317 / HTTP 4318 |
| `beats` | ○ not built | PUSH_SOCKET | batch ack | no | TLS/mTLS | (relay) | Lumberjack v2; relay-only by design (via Logstash/OTel) |
| `fluentd` | ○ not built | PUSH_SOCKET | chunk ack | no | TLS + shared key | (relay) | Fluent forward (MsgPack, 24224) |
| `kafka` | ✅ built | QUEUE | committed offset | **yes** | SASL_SSL · mTLS | `confluent-kafka` | dominant bus; **Azure Event Hubs is Kafka-compatible** too |
| `pulsar` | ○ not built | QUEUE | per-msg/cumulative ack | yes | TLS · token/OAuth2 | `pulsar-client` | tiered storage for long retention |
| `rabbitmq` | ✅ built | QUEUE | `basic.ack` | no (Streams: yes) | TLS · SASL | `aio-pika` | use async client; heartbeat-sensitive |
| `nats` | ✅ built | QUEUE | durable consumer seq | yes (JetStream) | TLS · NKEYS/JWT | `nats-py` | JetStream for durability; very lightweight |
| `mqtt` | ✅ built | QUEUE | QoS 1/2 | retained | TLS · cert/user | `paho-mqtt` | OT/IoT/ICS telemetry |
| `redis_streams` | ✅ built | QUEUE | consumer group + `XACK` | yes (in-stream) | TLS · ACL | `redis` | trim with `MAXLEN`; claim stale with `XCLAIM` |
| `aws_sqs` | ✅ built | QUEUE | visibility-timeout + delete | DLQ | IAM · TLS | `boto3` | pairs with S3 event notifications |
| `aws_kinesis` | ✅ built | QUEUE/STREAM | sequence number/shard | yes (1–365d) | IAM · TLS | `boto3` | enhanced fan-out for low latency |
| `azure_event_hub` | ✅ built | QUEUE | checkpoint store | yes | AAD · SAS · TLS | `azure-eventhub` | or just use the Kafka endpoint |
| `gcp_pubsub` | ✅ built | QUEUE/PUSH_HTTP | ack id | yes | SA JSON · TLS | `google-cloud-pubsub` | pull or push subscription |
| `s3` | ✅ built | OBJECT_STORE | last key/marker | yes | IAM · TLS | `boto3`,`pyarrow` | **AWS Security Lake = OCSF Parquet**; SQS-notify for near-real-time |
| `gcs` | ✅ built | OBJECT_STORE | last key | yes | SA JSON · TLS | `google-cloud-storage` | |
| `azure_blob` | ✅ built | OBJECT_STORE | last key | yes | SAS · TLS | `azure-storage-blob` | |
| `file` | ✅ built | OBJECT_STORE | byte offset | yes | local | — (stdlib) | tail file/dir; handle rotation by inode/size |

**16 of 20 transports above are built** (`connectors/receivers/`,
`BUILTIN_RECEIVERS`); the 4 not-yet-built ones (`otlp`, `beats`, `fluentd`,
`pulsar`) share the same `PushReceiver` SPI, so each is an incremental addition,
not a re-architecture — see §8.

**Windows Event Forwarding (WEF/WEC):** no pure-Python server is practical; run
**NXLog (Community)** on Linux as a WEC relay → it emits JSON over `syslog`/`kafka`/`webhook`,
which we consume natively. Documented as the supported path.

## 4. Log formats (auto-detected at the receiver)

Receivers detect and parse the format before normalising (`receivers/formats.py`):
`json`, `ndjson`, ECS-JSON, **OCSF** JSON/Parquet, **CEF** (ArcSight), **LEEF**
(IBM QRadar), **GELF** (Graylog), syslog RFC 3164 / 5424 (incl. structured-data),
logfmt key=value, Windows EVTX/XML (via relay). Self-describing formats (OCSF,
ECS, GELF) map cleanly; positional/legacy formats (CEF/LEEF/CLF) use the bundled
parsers. Malformed input is never dropped — it becomes a best-effort
`{"message": <raw>, "_parse_error": ...}` record routed onward (and ultimately to
`NEEDS_HUMAN`), per the no-drop rule.

## 5. Durability & acknowledgement (the one rule)

**Commit the offset / ack the message only after the event is safely persisted.**
Pattern: `consume → normalise → write → ack/commit`. Never ack before writing.

- **Durable** (offsets/checkpoints): Kafka, Kinesis, Event Hubs, Pub/Sub,
  SQS, NATS JetStream, Pulsar, Redis Streams, object stores, file tail. → at-least-once;
  dedup downstream by event id (the cluster signature is the final idempotency backstop).
- **Fire-and-forget**: UDP syslog, MQTT QoS 0, SNMP traps. → use for telemetry
  where occasional loss is tolerable, not for audit-critical alert streams.

## 6. Running many listeners next to FastAPI

Push receivers run as `asyncio` tasks under the app lifespan: syslog/raw-socket
listeners bind their own ports via `asyncio.start_server` /
`create_datagram_endpoint`; the webhook/HEC receivers are FastAPI routes on the
existing HTTP port; queue/object-store consumers are pure tasks (no ports). Each
receiver pushes into an internal `asyncio.Queue` so a fast receiver never blocks
on the slower LLM pipeline (back-pressure), and each consume loop is wrapped so a
crash in one source never takes down the others.

## 7. Adding a source (the first-run wizard)

Every connector publishes a `ConnectorManifest` (`connectors/base.py`) declaring
its `ingest_modes`, `query_language`, capabilities, and — crucially — the
`auth_fields` + `config_fields` the wizard renders. The flow:

1. Wizard lists available connectors (`GET /api/connectors`).
2. Operator picks one → the wizard renders its fields (host, token, topic, index
   pattern, entity field mappings, …).
3. **Test connection** (`POST /api/connectors/test`) validates auth/reachability
   and returns a sample count.
4. Save → the source is configured; secrets go to the secret store
   (`configured ✓` only in the UI, never echoed), non-secret config is persisted.

This is how an operator "adds the SIEM they wish" with zero code change. Community
connectors install out-of-tree via the `tlsoc.connectors` entry-point group
(`pip install tlsoc-connector-<vendor>`).

## 8. What's built vs. what's left (coverage vs effort)

The original three-tier "coverage vs effort" plan (grounded in ≈90% of real
deployments running on five pipes) has almost entirely shipped. Current state:

- **Built — all 16 push/queue/object-store receivers:** `webhook` (+`hec`),
  `syslog`, `kafka`, `aws_sqs`, `aws_kinesis`, `azure_event_hub`, `gcp_pubsub`,
  `rabbitmq`, `nats`, `mqtt`, `redis_streams`, `s3`, `gcs`, `azure_blob`, `file`.
- **Built — all 3 pull connectors:** `elasticsearch`, `opensearch`, `wazuh`
  (reuses the OpenSearch connector), plus the Demo-Mode-only `DemoPullConnector`.
- **Not yet built (4 transports):** `otlp`, `beats` (relay-only by design —
  Lumberjack v2 has no practical pure-Python server; relay via Logstash/OTel
  stays the supported path, like WEF/NXLog), `fluentd`, `pulsar`. Each shares the
  existing `PushReceiver` SPI, so adding one is an incremental receiver, not a
  re-architecture.
- **Not yet built — 7 pull-connector roadmap slots** (`SourceType` enum members
  with no connector class): `splunk`, `sentinel`, `qradar`, `chronicle`,
  `crowdstrike`, `sentinelone`, `defender`. See
  `docs/AGNOSTIC_ARCHITECTURE.md` §5 for the rollout rationale (Splunk/Sentinel
  next, as demand dictates).

Optional client libraries are imported lazily inside each receiver's `start()`, so
the core ships without them and an operator installs only what their deployment
needs.

## 9. Two-tier ingestion: ALERT vs. EVENT feeds (Round 4)

Every configured feed (`IndexPattern`) carries an `IndexRole`: `alerts`, `events`,
or `ignore` (`constants.py`). `ignore` feeds are dropped entirely at ingest — a
per-feed mute, the only role that skips ingest. The other two roles now drive
genuinely different pipelines:

- **`alerts` feeds** — SIEM-generated detections: every event the operator has
  already decided is worth triaging. These stay on the **realtime** path
  unchanged — fetched, correlated, risk-gated, and triaged per-cluster — and are
  **auto-forwarded**, bypassing the correlation allowlist that gates `events`
  feeds.
- **`events` feeds** — high-volume raw telemetry (auth logs, proxy logs, DNS, …),
  too voluminous to triage per-record. When **both** `Preferences.batch.enabled`
  and `Preferences.baseline.enabled` are on (both **default OFF**), an `events`
  feed's newly-polled batch is routed **instead of** the realtime correlate
  window into a cheap-first, four-stage detection funnel
  (`engine/event_detection.py`):
  1. **Pre-aggregate** — raw events collapse into per-`(entity, hour-of-week)`
     bucket summaries (counts/rates/rule-mix) — never raw log bodies (#7,
     aggregate-then-summarise).
  2. **Rules pass** — the existing detection-rule classify/fire logic runs over
     the aggregated buckets.
  3. **Anomaly pass** — `engine/baseline.py`'s robust `modified_z` flags a bucket
     whose deviation exceeds the configured threshold (default 3.5, gated behind
     a 3×-period warm-up so a fresh baseline can't false-positive on day one).
  4. **Batch** — survivors of (2)/(3) each become one discounted `BatchProvider`
     request (Anthropic Message Batches / OpenAI Batch / `service_tier='flex'`,
     0.5× price), fenced UNTRUSTED (#9). An LLM-**confirmed** detection is
     re-shaped into a candidate cluster that **re-enters the same**
     `correlate → cluster_from_events → pipeline` path a realtime alert would —
     same `cluster_signature` (#4), same deterministic `decide()` (#3).
     `event_detection.py` is a **pure producer**: it never imports
     `case_manager` and never closes a case itself; an unconfirmed or
     unparseable batch result is never re-entered (fail-closed).
  When batch/baseline is off (the default), `events` feeds behave exactly as
  before Round 4 — realtime correlate, no funnel, byte-identical to a
  single-tier deployment.

### 9.1 Multi-source polling — `PollerManager`

`engine/poller_manager.py`'s `PollerManager` fans one logical poll tick out over
**every enabled PULL source**, not just a single historical "primary" one (fixing
a confirmed Round-4 bug where every non-primary configured pull source was
silently never polled/correlated/triaged). Design points:

- One child `Poller` per enabled PULL source. The primary child **is**
  `state.log_source` unchanged (same object/client), so a single-source
  deployment's behaviour is byte-identical to before the fan-out existed.
  Every non-primary source gets its own connector via
  `state.es_client_for_source()` (the mgmt key is always dropped, #1), tracked
  and closed on rebuild so N sources never leak connections.
- **Cursor key is per-`{source.id}:{feed.id}`** — each `Poller` already fans out
  over its own feeds this way (a source can carry several feeds, e.g. an
  `alerts` feed and an `events` feed, per §9 above, each polled on its own
  cursor). An un-fed legacy source (only a bare `data_view_pattern`, no explicit
  feeds) gets a distinct
  `f"{source.id}:primary"` cursor key, while the true single/legacy primary
  keeps the original `"primary"` key — so multiple sources can never collide on
  the same cursor row, and no migration is needed (#4).
- A per-cluster-signature in-flight lock stops two concurrently-polling sources
  from double-investigating the same signature within one tick.
- Every child shares the **one** pipeline/gateway/cases/audit/cursor store (#6)
  — the manager never mints a second gateway or a second ledger.
- A burst of sources is bounded by `Preferences.caps.max_concurrent`.

`PollerManager` also proxies the `_event_funnel` (§9) and Round-7 noise-counter
sink hooks onto every child, so a `role=events` feed on *any* configured source —
not just the primary — is eligible for the detection funnel when it's enabled.
