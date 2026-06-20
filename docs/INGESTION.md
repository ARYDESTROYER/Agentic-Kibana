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
  Elasticsearch, OpenSearch, Splunk, Sentinel, QRadar, Chronicle, SentinelOne,
  Wazuh-indexer, Defender-hunting.
- **`PushReceiver`** — *it drives us.* We run a listener / consume a broker / poll
  an object store, and events arrive asynchronously, fed into the **same**
  `correlate → risk → cost-gate → LLM → case` pipeline the poller feeds.

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

| Transport (`SourceType`) | Mode | Durable offset / ack | Replay | Auth / TLS | pip (lazy) | Notes |
|---|---|---|---|---|---|---|
| `webhook` | PUSH_HTTP | client dedup | sender-retry | HMAC-SHA256 · bearer · mTLS | — (FastAPI) | **universal cloud push**; JSON/NDJSON/array; verify HMAC on raw bytes before parse |
| `hec` | PUSH_HTTP | indexer-ack ext | — | `Splunk <token>` | — | Splunk-HEC-compatible; unwraps `{event,fields,time}`; any HEC forwarder (Cribl/Vector/UF) can ship to us |
| `syslog` | PUSH_SYSLOG | none | no | none / TLS (6514) | — (asyncio) | RFC 3164 + 5424; UDP/TCP; octet-counting + newline framing |
| `otlp` | PUSH_HTTP/SOCKET | per-stream ack | no | bearer · mTLS | `opentelemetry-proto`,`grpcio` | OTel logs gRPC 4317 / HTTP 4318 |
| `beats` | PUSH_SOCKET | batch ack | no | TLS/mTLS | (relay) | Lumberjack v2; relay via Logstash/OTel in practice |
| `fluentd` | PUSH_SOCKET | chunk ack | no | TLS + shared key | (relay) | Fluent forward (MsgPack, 24224) |
| `kafka` | QUEUE | committed offset | **yes** | SASL_SSL · mTLS | `confluent-kafka` | dominant bus; **Azure Event Hubs is Kafka-compatible** too |
| `pulsar` | QUEUE | per-msg/cumulative ack | yes | TLS · token/OAuth2 | `pulsar-client` | tiered storage for long retention |
| `rabbitmq` | QUEUE | `basic.ack` | no (Streams: yes) | TLS · SASL | `aio-pika` | use async client; heartbeat-sensitive |
| `nats` | QUEUE | durable consumer seq | yes (JetStream) | TLS · NKEYS/JWT | `nats-py` | JetStream for durability; very lightweight |
| `mqtt` | QUEUE | QoS 1/2 | retained | TLS · cert/user | `paho-mqtt` | OT/IoT/ICS telemetry |
| `redis_streams` | QUEUE | consumer group + `XACK` | yes (in-stream) | TLS · ACL | `redis` | trim with `MAXLEN`; claim stale with `XCLAIM` |
| `aws_sqs` | QUEUE | visibility-timeout + delete | DLQ | IAM · TLS | `boto3` | pairs with S3 event notifications |
| `aws_kinesis` | QUEUE/STREAM | sequence number/shard | yes (1–365d) | IAM · TLS | `boto3` | enhanced fan-out for low latency |
| `azure_event_hub` | QUEUE | checkpoint store | yes | AAD · SAS · TLS | `azure-eventhub` | or just use the Kafka endpoint |
| `gcp_pubsub` | QUEUE/PUSH_HTTP | ack id | yes | SA JSON · TLS | `google-cloud-pubsub` | pull or push subscription |
| `s3` | OBJECT_STORE | last key/marker | yes | IAM · TLS | `boto3`,`pyarrow` | **AWS Security Lake = OCSF Parquet**; SQS-notify for near-real-time |
| `gcs` | OBJECT_STORE | last key | yes | SA JSON · TLS | `google-cloud-storage` | |
| `azure_blob` | OBJECT_STORE | last key | yes | SAS · TLS | `azure-storage-blob` | |
| `file` | OBJECT_STORE | byte offset | yes | local | — (stdlib) | tail file/dir; handle rotation by inode/size |

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

## 8. Implement-first order (coverage vs effort)

Grounded in the ingestion research (≈90% of real deployments with five pipes):

- **Tier 1 (built):** `webhook` (+`hec`), `syslog`, `kafka`, `s3`, `aws_sqs`.
- **Tier 2:** `otlp`, `azure_event_hub`, `gcp_pubsub`, `nats`, plus the Splunk /
  Sentinel / CrowdStrike **pull** connectors.
- **Tier 3:** `mqtt`, `redis_streams`, `file`, `fluentd`, `rabbitmq`, `pulsar`,
  `aws_kinesis`, `gcs`, `azure_blob`, SNMP traps, WEF (via NXLog relay), Beats
  (via relay), journald.

All transports share one SPI, so Tier 2/3 are incremental additions, not
re-architecture. Optional client libraries are imported lazily inside each
receiver's `start()`, so the core ships without them and an operator installs only
what their deployment needs.
