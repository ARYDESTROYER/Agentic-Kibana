"""The OCSF event model (pinned to ``OCSF_VERSION``).

This is a pragmatic subset of the Open Cybersecurity Schema Framework: the
objects and attributes the triage engine actually reasons over, plus the
first-class ``unmapped`` catch-all so no source data is ever lost. It is NOT the
full OCSF taxonomy — connectors set the class/category they best fit and drop
everything else into ``unmapped`` (documented per-connector in ``mappings``).

Design rules:
  * ``time`` is epoch milliseconds (UTC) — the suite's single time unit.
  * ``severity_id`` is the OCSF 0..6 scale; ``severity_to_score()`` projects it
    onto the 0..100 scale the deterministic risk engine consumes.
  * ``raw_data`` keeps the original source record (for audit/repro); ``unmapped``
    keeps source fields with no OCSF home. BOTH are attacker-influenceable log
    data and MUST be fenced as UNTRUSTED when placed in any prompt (#9).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ..constants import (
    OCSF_CAT_FINDINGS,
    OCSF_CLASS_BASE_EVENT,
    OCSF_SEVERITY_TO_SCORE,
    OCSF_VERSION,
)


# --------------------------------------------------------------------------- #
# Nested OCSF objects (subset)
# --------------------------------------------------------------------------- #
class Product(BaseModel):
    name: str | None = None
    vendor_name: str | None = None
    version: str | None = None


class Metadata(BaseModel):
    """Provenance: which product/connector produced and normalised this event."""

    version: str = OCSF_VERSION          # OCSF schema version
    product: Product = Field(default_factory=Product)
    # Suite-specific provenance (additive; lives under metadata so it travels with
    # the event). ``source_type`` is the SourceType value of the originating
    # connector; ``connector`` is the connector instance id; ``uid`` is the
    # source-native record id (used as the stable event id).
    source_type: str | None = None
    connector: str | None = None
    uid: str | None = None
    original_time: str | None = None     # the source's own timestamp string, verbatim


class Endpoint(BaseModel):
    ip: str | None = None
    port: int | None = None
    hostname: str | None = None
    mac: str | None = None
    uid: str | None = None
    domain: str | None = None


class User(BaseModel):
    name: str | None = None
    uid: str | None = None
    type: str | None = None
    domain: str | None = None
    email_addr: str | None = None


class Device(BaseModel):
    hostname: str | None = None
    ip: str | None = None
    uid: str | None = None
    type: str | None = None
    os: str | None = None


class Observable(BaseModel):
    """A typed indicator extracted from the event (ip, user, hostname, hash, ...)."""

    name: str                    # the OCSF attribute path, e.g. "src_endpoint.ip"
    type: str                    # observable type, e.g. "IP Address", "User", "Hostname"
    value: str


# --------------------------------------------------------------------------- #
# severity helpers
# --------------------------------------------------------------------------- #
def severity_id_to_score(severity_id: int | None) -> float:
    """OCSF severity_id (0..6) → the 0..100 score the risk engine uses."""
    if severity_id is None:
        return 0.0
    return OCSF_SEVERITY_TO_SCORE.get(int(severity_id), 0.0)


def score_to_severity_id(score: float | None, scale: str = "auto") -> int:
    """A severity score → the nearest OCSF severity_id (0..6), scale-aware.

    ``scale`` disambiguates the source's native range so a genuine LOW 0..100 severity
    is not inflated (audit #36 — the old magnitude guess x10'd any value <= 10, so an
    OCSF severity of 8 became 80 → High):

    * ``"ocsf_0_100"`` / ``"0-100"`` — already 0..100; NO rescale (8 stays 8 → Info/Low).
    * ``"0_10"`` / ``"0-10"`` — the 0..10 SIEM scale; x10.
    * ``"wazuh_0_16"`` — Wazuh rule.level 0..16; level/16*100.
    * ``"auto"`` (default) — the legacy magnitude heuristic (``<=10 ? x10 : as-is``),
      kept for callers that cannot resolve the source scale (back-compat, byte-identical).
    """
    if score is None:
        return 0
    s = float(score)
    if s <= 0:
        return 1                        # Informational
    if scale in ("ocsf_0_100", "0-100", "0_100"):
        pass                            # already 0..100 — never rescale
    elif scale in ("0_10", "0-10"):
        s = s * 10.0
    elif scale == "wazuh_0_16":
        s = s / 16.0 * 100.0
    elif s <= 10:                       # "auto"/unknown — legacy magnitude heuristic
        s = s * 10.0
    if s >= 90:
        return 5                        # Critical
    if s >= 70:
        return 4                        # High
    if s >= 40:
        return 3                        # Medium
    if s >= 15:
        return 2                        # Low
    return 1                            # Informational


# --------------------------------------------------------------------------- #
# The event
# --------------------------------------------------------------------------- #
class OCSFEvent(BaseModel):
    """A normalised security event in the canonical OCSF subset."""

    # Classification (self-describing semantics for the LLM)
    category_uid: int = OCSF_CAT_FINDINGS
    class_uid: int = OCSF_CLASS_BASE_EVENT
    activity_id: int = 0
    type_uid: int = 0                    # = class_uid * 100 + activity_id (auto if 0)
    class_name: str | None = None
    activity_name: str | None = None

    # Severity + time
    severity_id: int = 0
    time: int = 0                        # epoch millis (UTC)

    # Human/agent-facing
    message: str = ""
    status: str | None = None

    # Provenance
    metadata: Metadata = Field(default_factory=Metadata)

    # Entities / observables (the risk + correlation engine reads these)
    src_endpoint: Endpoint = Field(default_factory=Endpoint)
    dst_endpoint: Endpoint = Field(default_factory=Endpoint)
    device: Device = Field(default_factory=Device)
    actor_user: User = Field(default_factory=User)
    observables: list[Observable] = Field(default_factory=list)

    # Finding/rule identity (maps onto the suite's ``rule`` / ``rule_name``)
    finding_title: str | None = None     # the detection/rule name (rule_name)
    rule_uid: str | None = None          # the rule id/value (rule)
    count: int = 1

    # Lossless carry-through (FENCE as UNTRUSTED in prompts)
    unmapped: dict[str, Any] = Field(default_factory=dict)
    raw_data: dict[str, Any] = Field(default_factory=dict)

    def model_post_init(self, __context: Any) -> None:  # noqa: D401
        # Auto-compute type_uid the OCSF way when a caller didn't set it.
        if not self.type_uid and self.class_uid:
            object.__setattr__(self, "type_uid", self.class_uid * 100 + self.activity_id)

    # --- projections the engine uses -------------------------------------- #
    @property
    def severity_score(self) -> float:
        return severity_id_to_score(self.severity_id)

    @property
    def event_id(self) -> str:
        """Stable id for cursor dedup + member_event_ids: the source-native uid."""
        return self.metadata.uid or ""

    @property
    def ip(self) -> str | None:
        return self.src_endpoint.ip or self.device.ip

    @property
    def user(self) -> str | None:
        return self.actor_user.name

    @property
    def host(self) -> str | None:
        return self.device.hostname or self.src_endpoint.hostname
