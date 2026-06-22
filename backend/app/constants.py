"""Stable constants and enums shared across the suite.

Keeping these in one place means the data contracts (Section 7 of the spec) and
the policy boundaries (Section 6.4) are defined exactly once.
"""

from __future__ import annotations

from enum import Enum

# --------------------------------------------------------------------------- #
# Elasticsearch indices OWNED by the backend (Section 7).
# These are write targets that use the management credential, NEVER the
# read-only agent key. Date-suffixed indices are written through a write alias
# created from the index template.
# --------------------------------------------------------------------------- #
CASES_INDEX = "tlsoc-agent-cases"
AUDIT_INDEX = "tlsoc-agent-audit"
USAGE_INDEX = "tlsoc-agent-usage"
# Non-secret, UI-editable preferences (Section 5/8.5) and the durable cursor
# (Section 6.1) live in single-doc bookkeeping indices.
CONFIG_INDEX = "tlsoc-agent-config"
CURSOR_INDEX = "tlsoc-agent-cursor"

# Write aliases (rollover-friendly). The template maps `<index>-*`; the backend
# writes through `<index>-000001` behind the `<index>` alias on first boot.
CASES_WRITE_ALIAS = CASES_INDEX
AUDIT_WRITE_ALIAS = AUDIT_INDEX
USAGE_WRITE_ALIAS = USAGE_INDEX

# Read patterns for queries/dashboards.
CASES_READ_PATTERN = f"{CASES_INDEX}-*"
AUDIT_READ_PATTERN = f"{AUDIT_INDEX}-*"
USAGE_READ_PATTERN = f"{USAGE_INDEX}-*"

# Singleton doc ids for the single-doc bookkeeping indices.
CONFIG_DOC_ID = "preferences"
CURSOR_DOC_ID = "primary"


class Verdict(str, Enum):
    """LLM-produced verdict (Section 7.1). The verdict is a *recommendation*."""

    FALSE_POSITIVE = "FALSE_POSITIVE"
    TRUE_POSITIVE = "TRUE_POSITIVE"
    NEEDS_HUMAN = "NEEDS_HUMAN"


class CaseStatus(str, Enum):
    """Lifecycle of a case (Section 7.1). DECISION is deterministic code."""

    OPEN = "open"
    NEEDS_HUMAN = "needs_human"
    CLOSED = "closed"


class SourceSurface(str, Enum):
    """Where a case originated (Section 7.1)."""

    INVESTIGATE = "investigate"
    AUTOMATED_SCAN = "automated_scan"
    CHAT = "chat"


class DecisionBy(str, Enum):
    AGENT = "agent"          # FP auto-close only, under strict conditions
    ANALYST = "analyst"      # human action
    SYSTEM = "system"        # deterministic routing (e.g. fail-to-human)


class Role(str, Enum):
    """The four model roles (Section 6.4). Every LLM call is tagged with one."""

    ROUTER = "router"
    INVESTIGATOR = "investigator"
    FORMATTER = "formatter"
    STANDUP = "standup"
    CHAT = "chat"            # the shared chat engine (Surface 1/2 follow-up)
    OVERVIEW = "overview"    # single-event AI overview (Feature 2)
    EMBEDDING = "embedding"  # embedding calls also pass through the gateway


class ActionType(str, Enum):
    """Audit action types (Section 7.2)."""

    PROMPT = "prompt"
    ES_QUERY = "es_query"
    TOOL_CALL = "tool_call"
    VERDICT = "verdict"
    DECISION = "decision"
    ERROR = "error"
    POLL = "poll"
    SCAN = "scan"


class ToolTier(str, Enum):
    """Capability tier for a tool — a declarative authorisation firewall, ported
    from Vigil's safe/managed/requires_approval/forbidden model and generalising
    non-negotiable #3 (a TRUE_POSITIVE is never auto-closed; irreversible actions
    need a human).

    Today every TLSOC tool is ``SAFE`` (read-only logs / cached enrichment / RAG),
    but this tier travels with the tool definition so the moment a write/response
    tool is added the investigator can gate it WITHOUT touching agent logic:

    * ``SAFE``              — read-only; an autonomous agent may call freely.
    * ``MANAGED``          — mutates our OWN state (e.g. annotate a case); allowed
                              autonomously but always audited.
    * ``REQUIRES_APPROVAL`` — an outward/irreversible action (isolate host, block
                              IP, disable user); the agent may only PROPOSE it — a
                              human approves before it executes.
    * ``FORBIDDEN``        — never permitted to an autonomous agent (e.g. close a
                              case, approve an action) — hard-blocked in code.
    """

    SAFE = "safe"
    MANAGED = "managed"
    REQUIRES_APPROVAL = "requires_approval"
    FORBIDDEN = "forbidden"


class CorrelationMode(str, Enum):
    """Per-rule correlation mode (Section 6.2)."""

    EVERY = "every"          # investigate every occurrence (N=1 rare/high-sev)
    THRESHOLD = "threshold"  # investigate when >= N within window, grouped
    NEVER = "never"          # manual only


class EntityType(str, Enum):
    IP = "ip"
    USER = "user"
    HOST = "host"


class UsageOutcome(str, Enum):
    OK = "ok"
    ERROR = "error"
    CAPPED = "capped"


# Router triage buckets (Section 6.3). Only UNCERTAIN/SERIOUS reach the
# expensive investigator.
class TriageBucket(str, Enum):
    BENIGN = "obviously_benign"
    SERIOUS = "needs_strong_model"
    UNCERTAIN = "uncertain"


# The strict verdict JSON schema keys (Section 8.2). The formatter must emit
# exactly these.
VERDICT_KEYS = (
    "verdict",
    "confidence",
    "evidence",
    "mitre",
    "recommended_action",
    "reproduce_query",
)

# Prompt-injection seam (Section 3.3 / 11.9): every log-derived value placed in
# a prompt is wrapped in these labelled, delimited fences so a later hardening
# pass can treat fenced content as untrusted DATA without restructuring.
UNTRUSTED_OPEN = "<<<UNTRUSTED_LOG_DATA>>>"
UNTRUSTED_CLOSE = "<<<END_UNTRUSTED_LOG_DATA>>>"


# --------------------------------------------------------------------------- #
# Vendor-agnostic ingestion (AGNOSTIC_ARCHITECTURE.md).
#
# A "source" is any system we read security events from. Every connector
# normalises its native records into OCSF (the canonical internal schema) before
# the engine ever sees them. ``SourceType`` enumerates the connectors we know
# how to build; ``IngestMode`` enumerates HOW data physically reaches us. A
# single source may support several modes (e.g. Elasticsearch is PULL; Wazuh is
# PULL via its indexer AND PUSH via integratord).
# --------------------------------------------------------------------------- #
class SourceType(str, Enum):
    # Pull-based SIEM / log stores
    ELASTICSEARCH = "elasticsearch"
    OPENSEARCH = "opensearch"
    SPLUNK = "splunk"
    SENTINEL = "sentinel"
    QRADAR = "qradar"
    CHRONICLE = "chronicle"
    # EDR / XDR
    CROWDSTRIKE = "crowdstrike"
    SENTINELONE = "sentinelone"
    DEFENDER = "defender"
    WAZUH = "wazuh"
    # Generic transports / receivers (push, queues, object stores)
    WEBHOOK = "webhook"            # generic HTTP(S) JSON/NDJSON/CEF/LEEF push
    HEC = "hec"                    # Splunk HEC-compatible receiver
    SYSLOG = "syslog"             # RFC 3164 / 5424 over UDP/TCP/TLS
    BEATS = "beats"               # Elastic Lumberjack (Filebeat/Winlogbeat)
    FLUENTD = "fluentd"           # Fluentd/Fluent Bit forward protocol
    OTLP = "otlp"                 # OpenTelemetry logs (gRPC/HTTP)
    KAFKA = "kafka"               # Kafka / Redpanda / Confluent
    PULSAR = "pulsar"
    RABBITMQ = "rabbitmq"
    NATS = "nats"
    MQTT = "mqtt"
    REDIS_STREAMS = "redis_streams"
    AWS_SQS = "aws_sqs"
    AWS_KINESIS = "aws_kinesis"
    AZURE_EVENT_HUB = "azure_event_hub"
    GCP_PUBSUB = "gcp_pubsub"
    S3 = "s3"                      # S3 / Security Lake (OCSF Parquet), object store
    GCS = "gcs"
    AZURE_BLOB = "azure_blob"
    FILE = "file"                  # local file / directory tail
    GENERIC = "generic"


class IngestMode(str, Enum):
    """How events physically arrive. Drives the connector driver the engine uses."""

    PULL = "pull"                  # we poll a search/query API on a durable cursor
    PUSH_HTTP = "push_http"        # we run an HTTP listener; the source POSTs to us
    PUSH_SYSLOG = "push_syslog"    # we run a syslog listener (UDP/TCP/TLS)
    PUSH_SOCKET = "push_socket"    # raw TCP/UDP/gRPC line/stream listener
    QUEUE = "queue"                # we consume a broker (Kafka/SQS/PubSub/...): durable offsets
    OBJECT_STORE = "object_store"  # we list+get objects (S3/GCS/Blob), cursor = key/marker
    STREAM = "stream"              # long-lived provider stream (e.g. CrowdStrike Event Streams)


# Cursor shapes a connector may use to read incrementally without skip/dup.
class CursorKind(str, Enum):
    TIMESTAMP = "timestamp"        # watermark + tiebreaker id (the suite default)
    TOKEN = "token"                # opaque continuation token (session-scoped)
    OFFSET = "offset"              # durable broker/partition offset
    OBJECT_KEY = "object_key"      # last processed object key/marker


# --------------------------------------------------------------------------- #
# OCSF (Open Cybersecurity Schema Framework) — the canonical internal schema.
# We pin a version and store it on every event (classes are renumbered across
# minor versions). Only the small, high-traffic subset of categories/classes the
# triage engine reasons over is enumerated here; the full taxonomy lives in OCSF.
# --------------------------------------------------------------------------- #
OCSF_VERSION = "1.4.0"

# Categories (category_uid)
OCSF_CAT_SYSTEM = 1
OCSF_CAT_FINDINGS = 2
OCSF_CAT_IAM = 3
OCSF_CAT_NETWORK = 4
OCSF_CAT_DISCOVERY = 5
OCSF_CAT_APPLICATION = 6

# Classes (class_uid) — the ones connectors map into most often.
OCSF_CLASS_FILE_ACTIVITY = 1001
OCSF_CLASS_PROCESS_ACTIVITY = 1007
OCSF_CLASS_AUTHENTICATION = 3002
OCSF_CLASS_NETWORK_ACTIVITY = 4001
OCSF_CLASS_HTTP_ACTIVITY = 4002
OCSF_CLASS_SECURITY_FINDING = 2001
OCSF_CLASS_DETECTION_FINDING = 2004
OCSF_CLASS_BASE_EVENT = 0          # fallback when the source class is unknown

# severity_id (OCSF standard 0..6) → a 0..100 score the risk engine uses.
OCSF_SEVERITY_TO_SCORE = {0: 0.0, 1: 10.0, 2: 30.0, 3: 50.0, 4: 75.0, 5: 90.0, 6: 100.0}
