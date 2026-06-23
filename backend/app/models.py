"""Pydantic models: the Section 7 data contracts plus internal pipeline types.

The three persisted contracts (``Case``, ``AuditDoc``, ``UsageDoc``) map field-for-
field to Section 7. Internal types (``RawEvent``, ``Cluster``, ``VerdictResult``,
``EnrichmentResult``, ``RagChunk``) describe data flowing through the engine.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

from pydantic import BaseModel, Field

from .config import Preferences

if TYPE_CHECKING:  # avoid an import cycle (ocsf imports config/constants, not models)
    from .ocsf import OCSFEvent
from .constants import (
    ActionType,
    CaseStatus,
    DecisionBy,
    EntityType,
    SourceSurface,
    UsageOutcome,
    Verdict,
)
from .utils import coerce_float, dotted_get, iso_now, new_id, parse_es_timestamp, to_millis


# --------------------------------------------------------------------------- #
# Entities and events
# --------------------------------------------------------------------------- #
class Entity(BaseModel):
    type: EntityType
    value: str

    def key(self) -> str:
        return f"{self.type.value}:{self.value}"


class RawEvent(BaseModel):
    """A normalised view over one Elasticsearch hit from the log surface.

    Extraction uses the configurable field mapping (Section 5.3) so we never
    hardcode assumptions about the upstream ECS schema.
    """

    id: str
    index: str = ""
    source: dict[str, Any] = Field(default_factory=dict)

    # Extracted, config-driven projections (populated by ``from_hit``).
    timestamp_millis: int = 0
    ip: str | None = None
    user: str | None = None
    host: str | None = None
    rule: str | None = None
    rule_name: str | None = None
    severity: float = 0.0
    # Multi-pattern provenance (entity-agnostic + per-pattern role). ``index_role``
    # is the role of the configured pattern this event came from ("events" default,
    # "alerts" for SIEM-generated detections that auto-forward). ``source_id`` records
    # which configured source emitted it. Both default to back-compat values.
    index_role: str = "events"
    source_id: str | None = None
    source_name: str | None = None

    @classmethod
    def from_hit(cls, hit: dict[str, Any], prefs: Preferences) -> "RawEvent":
        src = hit.get("_source", {}) or {}
        ts = parse_es_timestamp(dotted_get(src, prefs.time_field))
        # Rule identity (C3-1): when the rule catalog is non-empty, classify via
        # ``prefs.match_rule`` (so ModSec events resolve to their XSS/SQLi/...
        # sub-rule); on no catalog match, fall back to today's single-field value.
        # When the catalog is EMPTY this is byte-identical to the original
        # single-``rule_field`` derivation (critical backward compat).
        fallback_rule = _as_str(dotted_get(src, prefs.rule_field))
        if prefs.rule_catalog:
            matched = prefs.match_rule(src)
            rule = matched.name if matched is not None else fallback_rule
        else:
            rule = fallback_rule
        ev = cls(
            id=str(hit.get("_id", "")),
            index=str(hit.get("_index", "")),
            source=src,
            timestamp_millis=to_millis(ts) if ts else 0,
            ip=_as_str(dotted_get(src, prefs.source_ip_field)),
            user=_as_str(dotted_get(src, prefs.user_field)),
            host=_as_str(dotted_get(src, prefs.host_field)),
            rule=rule,
            rule_name=_as_str(dotted_get(src, prefs.rule_name_field)),
            severity=coerce_float(dotted_get(src, prefs.severity_field), 0.0),
        )
        return ev

    @classmethod
    def from_ocsf(cls, ev: "OCSFEvent") -> "RawEvent":
        """Project a canonical OCSF event onto the engine's ``RawEvent``.

        This is the source-agnostic counterpart to ``from_hit``: any connector
        normalises to OCSF, and the engine consumes the projection. ``source`` is
        the event's original record (``raw_data``) so existing downstream readers
        keep working for ECS-shaped sources; ``ocsf`` carries the full normalised
        event for source-agnostic consumers. No ``prefs`` needed — OCSF is already
        normalised.
        """
        src = dict(ev.raw_data) if ev.raw_data else ev.model_dump(mode="json")
        return cls(
            id=ev.event_id,
            index=ev.metadata.source_type or "",
            source=src,
            timestamp_millis=ev.time,
            ip=ev.ip,
            user=ev.user,
            host=ev.host,
            rule=ev.rule_uid,
            rule_name=ev.finding_title,
            severity=ev.severity_score,
        )

    # Coarse time bucket (seconds) used when grouping by RULE so a rule-grouped
    # cluster is still time-bounded (a case forms per rule per bucket). 5 minutes.
    RULE_BUCKET_SECONDS: ClassVar[int] = 300

    def entity_value(self, group_by: EntityType) -> str | None:
        """The grouping value for ``group_by`` (None when this event lacks it).

        For IP/USER/HOST this is the extracted field. For RULE (the entity-agnostic
        fallback) it is ``"<rule>|<time-bucket>"`` so events of the same rule within
        the same coarse window cluster together, but distant bursts do not merge —
        guaranteeing a case forms even when every standard entity field is null."""
        if group_by == EntityType.RULE:
            rule = self.rule or self.rule_name
            if not rule:
                return None
            bucket = self.timestamp_millis // (self.RULE_BUCKET_SECONDS * 1000)
            return f"{rule}|{bucket}"
        return {
            EntityType.IP: self.ip,
            EntityType.USER: self.user,
            EntityType.HOST: self.host,
        }[group_by]


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0] if value else None
    if value is None:
        return None
    return str(value)


# --------------------------------------------------------------------------- #
# Correlation / risk
# --------------------------------------------------------------------------- #
class RiskBreakdown(BaseModel):
    volume: float = 0.0
    velocity: float = 0.0
    reputation: float = 0.0
    diversity: float = 0.0
    asset_criticality: float = 0.0
    total: float = 0.0


class TriggerReason(BaseModel):
    """Deterministic explanation of WHY a cluster was triggered (Feature 3).

    Computed in code by correlation, copied onto the Case, and surfaced in the UI
    ("Why this fired"). Records the PRIMARY triggering rule for a multi-rule entity.
    """

    rule_value: str = ""
    mode: str = ""                       # CorrelationMode value
    n: int = 0
    window_seconds: int = 0
    group_by: str = ""                   # EntityType value
    observed_count: int = 0
    window_start: int = 0                # epoch millis of the matched window
    window_end: int = 0
    entity: str = ""
    rule_values: list[str] = Field(default_factory=list)
    severity_min: float | None = None
    severity_max: float | None = None
    sentence: str = ""                   # human-readable one-liner


class Cluster(BaseModel):
    """A correlated group of events forming one candidate investigation."""

    signature: str
    entity: Entity
    group_by: EntityType
    rule_values: list[str] = Field(default_factory=list)
    member_event_ids: list[str] = Field(default_factory=list)
    member_events: list[RawEvent] = Field(default_factory=list)
    first_seen_millis: int = 0
    last_seen_millis: int = 0
    count: int = 0
    risk_score: float = 0.0
    risk_breakdown: RiskBreakdown = Field(default_factory=RiskBreakdown)
    trigger_reason: TriggerReason | None = None
    # Source provenance (multi-source UI filter + per-source behaviour). Derived
    # from the cluster's member events; default None preserves prior behaviour.
    source_id: str | None = None
    source_name: str | None = None
    # True when ANY member event came from an ``alerts``-role index pattern: such
    # clusters are SIEM-generated detections and are auto-forwarded to investigation
    # regardless of the auto-forward allowlist (see engine/ingest.handle_clusters).
    is_alert: bool = False

    @property
    def window_seconds(self) -> float:
        if self.last_seen_millis and self.first_seen_millis:
            return max(0.0, (self.last_seen_millis - self.first_seen_millis) / 1000.0)
        return 0.0

    def primary_rule(self) -> str | None:
        """The rule that best identifies this cluster, for per-rule model selection
        (C3-6b). Prefers the deterministic ``trigger_reason.rule_value`` (the
        PRIMARY triggering rule), else the dominant member-event rule (most
        frequent, ties broken alphabetically), else None."""
        if self.trigger_reason and self.trigger_reason.rule_value:
            return self.trigger_reason.rule_value
        counts: dict[str, int] = {}
        for ev in self.member_events:
            if ev.rule:
                counts[ev.rule] = counts.get(ev.rule, 0) + 1
        if not counts:
            return self.rule_values[0] if self.rule_values else None
        return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


# --------------------------------------------------------------------------- #
# Enrichment / RAG
# --------------------------------------------------------------------------- #
class EnrichmentResult(BaseModel):
    ip: str
    reputation_score: float = 0.0   # 0 (clean) .. 100 (malicious)
    is_malicious: bool = False
    country: str | None = None
    sources: dict[str, Any] = Field(default_factory=dict)
    cached: bool = False
    error: str | None = None


class RagChunk(BaseModel):
    text: str
    source: str = "unknown"
    score: float = 0.0
    metadata: dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Verdict (LLM output schema, Section 8.2)
# --------------------------------------------------------------------------- #
class EvidenceItem(BaseModel):
    summary: str
    event_ids: list[str] = Field(default_factory=list)
    query: str | None = None


class VerdictResult(BaseModel):
    verdict: Verdict = Verdict.NEEDS_HUMAN
    confidence: float = 0.0
    evidence: list[EvidenceItem] = Field(default_factory=list)
    mitre: list[str] = Field(default_factory=list)
    recommended_action: str = ""
    reproduce_query: str = ""


class FeedbackEntry(BaseModel):
    """An analyst's grade of an AI verdict on a case (the eval / quality loop,
    Vigil-inspired). Append-only on the case; aggregated by /api/feedback/stats to
    measure agreement rate, grading quality, outcome mix and time saved."""

    ts: str = Field(default_factory=iso_now)
    analyst: str = ""
    assessment: str = ""                    # agree | partial | disagree
    accuracy: float = 0.0                   # 0..1
    reasoning_quality: float = 0.0          # 0..1
    action_appropriateness: float = 0.0     # 0..1
    actual_outcome: str = ""                # true_positive|false_positive|true_negative|false_negative|unknown
    time_saved_minutes: int = 0
    comment: str = ""
    ai_verdict: str = ""                    # snapshot of the AI verdict that was graded
    ai_confidence: float = 0.0


class CaseComment(BaseModel):
    """An append-only analyst comment on a case (collaboration). ``author``/``body``
    are user input — render-escaped in the UI, never trusted as prompt instructions."""

    ts: str = Field(default_factory=iso_now)
    author: str = ""
    body: str = ""


class MemoryEntry(BaseModel):
    """A durable operator FACT the agents remember across cases + chats (the
    Claude.ai-style "MEMORY" feature). Examples: "10.0.0.0/8 is internal",
    "Nessus scans run Sun 02:00 from 10.1.2.3", "bastion01 is a jump box".

    Memory is auto-injected as a DISTINCT, TRUSTED operator-context block into BOTH
    automated investigations and chat (it ranks above untrusted evidence but BELOW
    base role rules + playbook procedure, and NEVER overrides the deterministic
    case_manager — it only INFORMS the LLM). ``source`` records how it got here:
    ``human`` (explicit add via the UI / "remember: …") or ``agent`` (the chat
    engine stored the TEXT THE USER ASKED to remember — never raw log/tool output).
    """

    id: str = Field(default_factory=lambda: new_id("mem-"))
    text: str = ""
    category: str = ""
    tags: list[str] = Field(default_factory=list)
    source: str = "human"            # human | agent
    author: str = ""
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)
    active: bool = True


# --------------------------------------------------------------------------- #
# Section 7.1 — tlsoc-agent-cases-*
# --------------------------------------------------------------------------- #
class Case(BaseModel):
    case_id: str
    cluster_signature: str
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)
    source_surface: SourceSurface
    # The FIRST surface this case was ever created from. Unlike ``source_surface``
    # (which is preserved from the original creation), this never changes and is a
    # stable provenance marker for the UI (P1).
    origin_surface: SourceSurface | None = None
    rule_ids: list[str] = Field(default_factory=list)
    entity: Entity
    # Originating source (multi-source provenance; enables UI filter-by-source).
    # Derived from the cluster's member events at creation; default None == the
    # legacy single implicit source (full back-compat).
    source_id: str | None = None
    source_name: str | None = None
    member_event_ids: list[str] = Field(default_factory=list)
    risk_score: float = 0.0
    verdict: Verdict | None = None
    confidence: float = 0.0
    evidence: list[EvidenceItem] = Field(default_factory=list)
    mitre: list[str] = Field(default_factory=list)
    recommended_action: str = ""
    reproduce_query: str = ""
    status: CaseStatus = CaseStatus.OPEN
    decision_by: DecisionBy | None = None
    objection_window_expires_at: str | None = None
    # The specialized investigator persona deterministically assigned to this case
    # (multi-agent roster, Vigil-inspired). Empty == the generalist. Recorded for
    # the UI/audit so you can see WHICH specialist handled the cluster.
    agent_persona: str = ""
    # The Markdown playbook selected for this case (deterministic match), empty when
    # none matched / playbooks disabled. Recorded for the UI/audit "why".
    playbook_id: str = ""
    # Append-only analyst feedback on the AI verdict (the eval/quality loop).
    feedback: list[FeedbackEntry] = Field(default_factory=list)
    # Collaboration: free-form analyst tags, threaded comments, and an owner.
    tags: list[str] = Field(default_factory=list)
    comments: list[CaseComment] = Field(default_factory=list)
    assignee: str = ""
    # Helpful, non-contract-breaking extras for the UI / audit:
    title: str = ""
    summary: str = ""
    risk_breakdown: RiskBreakdown = Field(default_factory=RiskBreakdown)
    token_cost: float = 0.0
    error: str | None = None
    history: list[dict[str, Any]] = Field(default_factory=list)
    # Append-only verdict trail: {ts, verdict, confidence, risk_score} on each
    # investigation. Lets the UI show how a case's verdict evolved (P1).
    verdict_history: list[dict[str, Any]] = Field(default_factory=list)
    # Deterministic "why was this triggered" explanation (Feature 3).
    trigger_reason: TriggerReason | None = None


# --------------------------------------------------------------------------- #
# Section 7.2 — tlsoc-agent-audit-* (append-only)
# --------------------------------------------------------------------------- #
class AuditDoc(BaseModel):
    ts: str = Field(default_factory=iso_now)
    case_id: str | None = None
    surface: str = ""
    actor: str = ""                 # which agent role / analyst id
    action_type: ActionType
    model: str | None = None
    prompt_excerpt: str | None = None       # log fields delimited & labelled untrusted
    query_text: str | None = None           # exact ES|QL/DSL issued (reproducible)
    tool_name: str | None = None
    tool_input: Any = None
    tool_output_summary: str | None = None
    result_summary: str | None = None


class TraceStep(BaseModel):
    """One agent-pipeline step surfaced from tlsoc-agent-audit (C3-3).

    A read-only projection of an ``AuditDoc`` for the case-detail trace timeline.
    All fields optional except ``ts``/``actor``. ``prompt_excerpt`` /
    ``tool_output_summary`` carry fenced UNTRUSTED log data — the FE renders them
    in code blocks; the trace endpoint can omit ``prompt_excerpt`` when
    ``prefs.trace.include_prompts`` is false."""

    ts: str = ""
    actor: str = ""
    action_type: str | None = None
    model: str | None = None
    query_text: str | None = None
    tool_name: str | None = None
    tool_input: Any = None
    tool_output_summary: str | None = None
    result_summary: str | None = None
    prompt_excerpt: str | None = None


# --------------------------------------------------------------------------- #
# Section 7.3 — tlsoc-agent-usage-* (token & cost ledger)
# --------------------------------------------------------------------------- #
class UsageDoc(BaseModel):
    ts: str = Field(default_factory=iso_now)
    surface: str = ""
    case_id: str | None = None
    role: str = ""
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost: float = 0.0
    currency: str = "USD"
    latency_ms: int = 0
    outcome: UsageOutcome = UsageOutcome.OK
    # Provenance of the price used: exact | heuristic | zero | default (Vigil-
    # inspired). Lets the cost surface badge an approximate cost vs a verified one.
    pricing_source: str = "exact"


# --------------------------------------------------------------------------- #
# Durable cursor (Section 6.1)
# --------------------------------------------------------------------------- #
class Cursor(BaseModel):
    """Durable polling cursor (Section 6.1).

    Stores only *stable* document attributes so it survives restarts: the last
    processed ``@timestamp`` (millis) and the ids of every event already processed
    AT exactly that timestamp (the "boundary"). The poller filters
    ``@timestamp >= timestamp_millis`` (never `>`), so no event is ever skipped;
    the boundary ids dedupe the same-millisecond events that the inclusive bound
    re-fetches, so nothing is re-processed. Case-signature idempotency
    (Section 6.2) is the final backstop against duplicate cases.
    """

    timestamp_millis: int = 0
    boundary_ids: list[str] = Field(default_factory=list)

    def is_set(self) -> bool:
        return self.timestamp_millis > 0

    def should_skip(self, ev: "RawEvent") -> bool:
        """True if this event was already processed at the cursor boundary.

        Events with an unparseable/missing timestamp (millis <= 0) are NEVER
        skipped — they are processed (case-signature idempotency dedups them) so a
        malformed timestamp cannot silently drop an alert."""
        if ev.timestamp_millis <= 0:
            return False
        if ev.timestamp_millis < self.timestamp_millis:
            return True
        if ev.timestamp_millis == self.timestamp_millis and ev.id in set(self.boundary_ids):
            return True
        return False


# --------------------------------------------------------------------------- #
# API request/response shapes (plugin contract)
# --------------------------------------------------------------------------- #
class ChatTurn(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatContext(BaseModel):
    """On-screen context snapshot the global chat flyout may attach (Feature 1).

    ALL fields optional + best-effort. ``query``/``selection`` are
    attacker-influenceable and MUST be fenced as UNTRUSTED in prompts; the context
    is used only to DEFAULT the es_query tool (data view / time range), never as
    instructions.
    """

    app: str | None = None
    url: str | None = None
    data_view: str | None = None
    query: str | None = None
    language: str | None = None
    time_range: dict[str, Any] | None = None   # {from, to}
    case_id: str | None = None
    selection: str | None = None
    search_session: str | None = None


class ChatRequest(BaseModel):
    message: str
    case_id: str | None = None          # Surface 2: seed with a case
    history: list[ChatTurn] = Field(default_factory=list)
    context: ChatContext | None = None  # Feature 1: global flyout screen context
    # Optional per-call model override (additive; the proxy forwards it). When set,
    # the chat-role model is overridden to this id for THIS turn only via a prefs
    # copy — no gateway plumbing change. Still routed through the single gateway.
    model: str | None = None
    # Optional per-call SOURCE scoping (multi-source): when set, the chat engine
    # queries THAT configured source's connector (built per-call like the browse
    # endpoint) instead of the primary. Absent → the primary source (today's
    # behaviour). NOTE: this is single-source SELECT, not cross-source aggregation.
    source_id: str | None = None


class DiscoverLink(BaseModel):
    """Payload the plugin feeds to Kibana's locators API (Section 8.1)."""

    query: str
    language: str = "kuery"             # "kuery" | "lucene" | "esql"
    data_view_pattern: str = "all-logs-*"
    time_from: str = "now-24h"
    time_to: str = "now"


class MemorySuggestion(BaseModel):
    """A durable fact the chat agent NOTICED and proposes to remember. The UI shows
    it for the analyst to confirm before it is saved — the agent never auto-saves a
    suggestion (only explicit "remember: …" commands are executed)."""

    text: str = ""
    reason: str = ""


class ChatResponse(BaseModel):
    answer: str
    table: dict[str, Any] | None = None     # {columns:[], rows:[[...]]}
    query: str | None = None
    discover: DiscoverLink | None = None
    case_id: str | None = None
    cost: float = 0.0
    # Memory feedback (operator MEMORY feature): what the agent changed deterministically
    # on this turn (echoed for the UI), and an optional un-saved suggestion to confirm.
    memory_action: dict[str, Any] | None = None
    memory_suggestion: MemorySuggestion | None = None


class InvestigateRequest(BaseModel):
    """Start an investigation. Provide either a known cluster signature/case, or an
    ad-hoc entity + event ids (Surface 2 row click)."""

    cluster_signature: str | None = None
    entity: Entity | None = None
    group_by: EntityType = EntityType.IP
    event_ids: list[str] = Field(default_factory=list)
    rule_values: list[str] = Field(default_factory=list)
    source_surface: SourceSurface = SourceSurface.INVESTIGATE
    # Optional per-request override of the starting lookback window for an entity
    # investigation (additive; the proxy forwards it). Falls back to
    # ``Preferences.investigate_lookback``. The route auto-widens from here on 0 hits.
    lookback: str | None = None
