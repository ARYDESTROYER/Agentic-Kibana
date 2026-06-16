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
