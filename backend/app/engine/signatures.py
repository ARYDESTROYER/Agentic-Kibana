"""Cluster signature — the case idempotency key (Section 6.2 / Non-negotiable #4).

The signature is ENTITY-CENTRIC: one open case per (entity_type, entity_value).
This is what gives the spine its idempotency and "attach, don't duplicate"
semantics — re-polling a window yields the same signature, and new events for an
already-open entity attach to the existing case rather than spawning a new one.
The rules hit are recorded as a cluster attribute and feed the diversity risk
factor; they are deliberately NOT part of the signature so a newly-seen rule for
an open entity enriches the existing case instead of fragmenting it.
"""

from __future__ import annotations

from ..constants import EntityType
from ..utils import stable_signature


def cluster_signature(entity_type: EntityType, entity_value: str) -> str:
    return stable_signature("cluster", entity_type.value, entity_value)


def cross_source_signature(
    entity_type: EntityType | str,
    value: str,
    ts: int,
    window_seconds: int,
) -> str:
    """The SOURCE-AGNOSTIC, time-bucketed cross-source group key (Wave 5 / F6).

    Cross-source correlation (the opt-in second pass) groups OPEN cases that share an
    entity within a window across distinct sources. Its group id must be:

    * **source-agnostic** — it deliberately does NOT include any source id, so the
      SAME entity seen from different sources lands in the SAME group.
    * **idempotent** — recomputing it for the same ``(entity_type, value, bucket)``
      yields the same id, so re-running the pass never spawns a new group.

    ``ts`` (epoch millis) is floored to a ``window_seconds`` bucket so events within
    the same window share a bucket; distant activity falls into a different bucket
    (no over-clustering across time). Distinct from :func:`cluster_signature` (which
    is the per-cluster 1:1 idempotency key) — this NEVER replaces that signature."""
    et = getattr(entity_type, "value", entity_type)
    window_ms = max(1, int(window_seconds)) * 1000
    bucket = int(ts) // window_ms if ts else 0
    return stable_signature("xsrc", str(et), value, bucket)
