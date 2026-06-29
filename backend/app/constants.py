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

# Operator MEMORY (durable facts the agents remember). Backend-agnostic: stored
# as a single KV document (one JSON list of entries) under this namespace/key, so
# it needs NO new ES index / SQL table / migration. The ES backend stores it as a
# doc in the existing CONFIG_INDEX; the SQL backend uses the shared KV table.
MEMORY_NS = "memory"
MEMORY_KEY = "entries"
MEMORY_DOC_ID = "memory"      # ES doc id within CONFIG_INDEX

# Agent-DRAFTED proposals awaiting human approval (HITL). Stored exactly like the
# operator MEMORY set — one KV document (a single JSON list) under this namespace/
# key — so it needs NO new ES index / SQL table / migration. The ES backend stores
# it as a doc in the existing CONFIG_INDEX; the SQL backend uses the shared KV table.
PROPOSALS_NS = "proposals"
PROPOSALS_KEY = "entries"
PROPOSALS_DOC_ID = "proposals"   # ES doc id within CONFIG_INDEX

# Multi-USER store (Wave 1: real users for login + RBAC). Stored exactly like the
# operator MEMORY / agent PROPOSAL sets — ONE KV document (a single JSON list) under
# this namespace/key — so it needs NO new ES index / SQL table / migration. The ES
# backend stores it as a doc in the existing CONFIG_INDEX; the SQL backend uses the
# shared KV table.
USERS_NS = "users"
USERS_KEY = "entries"
USERS_DOC_ID = "users"   # ES doc id within CONFIG_INDEX

# Session registry (Wave 3: sessions & access policy — login/idle/absolute TTL +
# revocation + per-session metadata). Stored exactly like the operator MEMORY /
# agent PROPOSAL / multi-USER sets — ONE KV document (a single JSON list of session
# rows) under this namespace/key — so it needs NO new ES index / SQL table /
# migration. The ES backend stores it as a doc in the existing CONFIG_INDEX; the
# SQL backend uses the shared KV table. The JWT signature stays the root of trust;
# this registry only ADDS revocation + idle/absolute expiry + per-session metadata
# on top of a validly-signed access token.
SESSIONS_NS = "sessions"
SESSIONS_KEY = "entries"
SESSIONS_DOC_ID = "sessions"   # ES doc id within CONFIG_INDEX


class Verdict(str, Enum):
    """LLM-produced verdict (Section 7.1). The verdict is a *recommendation*."""

    FALSE_POSITIVE = "FALSE_POSITIVE"
    TRUE_POSITIVE = "TRUE_POSITIVE"
    NEEDS_HUMAN = "NEEDS_HUMAN"


class CaseStatus(str, Enum):
    """Lifecycle of a case (Section 7.1). DECISION is deterministic code.

    Two-axis model (see docs/research/.../STATUS_TAXONOMY.md): this is the
    LIFECYCLE axis; the investigative outcome is the separate :class:`Disposition`.
    The three ORIGINAL string values (``open``/``needs_human``/``closed``) are kept
    BYTE-FOR-BYTE so stored cases load unchanged and ``decide()`` (#3) is untouched;
    the richer states below are ADDED additively and reached via analyst lifecycle
    actions + the existing ``escalate`` flag — never by rewriting the deterministic
    decision. ``NEEDS_HUMAN`` is a RETAINED, deprecated alias of "open · awaiting
    analyst" (the UI renders it that way)."""

    NEW = "new"                    # created, not yet investigated (candidate / pre-LLM)
    OPEN = "open"                  # retained — investigated, awaiting analyst
    NEEDS_HUMAN = "needs_human"    # retained alias of "open · awaiting analyst" (decide() still uses it)
    INVESTIGATING = "investigating"  # an analyst / re-investigation is actively working it
    ESCALATED = "escalated"        # flagged high-priority for senior / Tier-3
    ON_HOLD = "on_hold"            # paused (awaiting info / maintenance / third party)
    RESOLVED = "resolved"          # worked to completion, pending final close / audit
    CLOSED = "closed"              # retained — terminal


# Lifecycle statuses that count as STILL OPEN for the case-signature idempotency
# lookup (Non-negotiable #4 / find_open_by_signature). Any non-terminal status must
# attach to its existing case rather than spawn a duplicate; only RESOLVED + CLOSED
# are terminal. This is the single source of truth for "is this case still live?",
# used by BOTH the ES and SQL case stores so the F8 statuses don't break dedupe.
OPEN_CASE_STATUSES: tuple[str, ...] = (
    CaseStatus.NEW.value,
    CaseStatus.OPEN.value,
    CaseStatus.NEEDS_HUMAN.value,
    CaseStatus.INVESTIGATING.value,
    CaseStatus.ESCALATED.value,
    CaseStatus.ON_HOLD.value,
)
# Terminal statuses (a case here is DONE; a new occurrence opens a fresh case).
TERMINAL_CASE_STATUSES: tuple[str, ...] = (
    CaseStatus.RESOLVED.value,
    CaseStatus.CLOSED.value,
)


class Disposition(str, Enum):
    """Investigative OUTCOME (verdict-class) axis — the analyst-confirmable,
    reportable classification on/after close. Orthogonal to :class:`CaseStatus`
    (lifecycle). Defaulted to ``None`` on the Case so old stored cases load
    unchanged; the LLM ``Verdict`` is unchanged and still feeds ``decide()``."""

    TRUE_POSITIVE = "true_positive"
    FALSE_POSITIVE = "false_positive"
    BENIGN = "benign"
    SUSPICIOUS = "suspicious"
    DUPLICATE = "duplicate"
    UNDETERMINED = "undetermined"


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
    FEEDBACK = "feedback"      # analyst graded an AI verdict (eval loop)
    COLLAB = "collab"          # analyst comment / tag / assignment
    STATUS = "status"          # analyst case-lifecycle transition (hold/resume/resolve/escalate/set_disposition/...)
    CONTEXT = "context"        # the injected investigation context (RAG/memory/enrichment) — explainability
    PROPOSAL = "proposal"      # agent drafted / human approved-rejected a HITL proposal
    AUTOMATION = "automation"  # a post-decision threshold-automation action (tag/recommend/notify/run_playbook/request_approval) — NEVER sets status (#3)
    NOTIFICATION = "notification"  # an outbound notification send attempt (email/slack/teams/webhook/...)
    USER_MGMT = "user_mgmt"        # user-management action (create/update/delete/role/password reset)
    AUTH_EVENT = "auth"            # login success/failure, logout, password change (auth events)
    ACCESS_DENIED = "access_denied"  # an authenticated caller was denied by the RBAC policy


class UserRole(str, Enum):
    """SOC operator roles for multi-user RBAC (Wave 1). Distinct from the LLM
    :class:`Role` (model roles). The permission matrix that maps each role to
    ``resource:action`` grants lives in ``app/rbac/policy.py`` (DEFAULT_MATRIX),
    and is operator-overridable via ``Preferences.rbac.roles``."""

    SUPER_ADMIN = "super_admin"
    SOC_MANAGER = "soc_manager"
    ANALYST_TIER2 = "analyst_tier2"
    ANALYST_TIER1 = "analyst_tier1"
    RESPONDER = "responder"
    AUDITOR = "auditor"


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
    # Richer cross-source correlation keys (Wave 5 / F6). These are ADDITIVE: the
    # per-source auto/IP/HOST/USER/RULE fallback ladder is unchanged (RULE is still
    # the always-resolvable terminal fallback). FILE_HASH/DOMAIN are NOT part of the
    # per-rule grouping ladder — they are extra entity keys the OPT-IN cross-source
    # pass may group on (engine/correlation.cross_source_correlate).
    FILE_HASH = "file_hash"
    DOMAIN = "domain"
    # Fallback grouping key when an event carries no IP/USER/HOST (entity-agnostic
    # correlation). A RULE-grouped cluster keys on the rule name + a coarse time
    # bucket so an in-scope event is NEVER silently dropped just because every
    # standard entity field is null (see engine/correlation.resolve_entity).
    RULE = "rule"


# Per-source entity-resolution strategy for correlation (Preferences.entity_strategy
# default + SourceInstance.config["entity_strategy"] override). ``auto`` tries
# IP → HOST → USER → RULE so a case always forms; the others pin one entity (with
# RULE as the always-present fallback so an event is never dropped).
class EntityStrategy(str, Enum):
    AUTO = "auto"
    IP = "ip"
    HOST = "host"
    USER = "user"
    RULE = "rule"


# Role a configured index pattern / feed plays for a source (multi-feed sources).
# ``events`` patterns keep the correlate→auto-forward-allowlist behaviour;
# ``alerts`` patterns are SIEM-generated detections every one of which the operator
# wants triaged, so alerts-role clusters are AUTO-FORWARDED (bypass the allowlist).
# ``ignore`` patterns are dropped entirely at ingest (a per-feed mute) — they are the
# ONLY role that skips ingest; a below-severity_floor event on an events/alerts feed is
# never dropped (it still registers a candidate + live-tail, just not auto-forwarded).
class IndexRole(str, Enum):
    EVENTS = "events"
    ALERTS = "alerts"
    IGNORE = "ignore"


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
