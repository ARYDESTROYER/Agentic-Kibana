"""Cluster signature — the case idempotency key (Section 6.2 / Non-negotiable #4).

The signature is SOURCE + ENTITY centric when source provenance is available: one
open case per ``(source_id, entity_type, entity_value)``. Legacy/unconfigured paths
without a source id retain the historical entity-only key.
This is what gives the spine its idempotency and "attach, don't duplicate"
semantics — re-polling a window yields the same signature, and new events for an
already-open entity on the same source attach instead of spawning a duplicate.
The source scope prevents two independent systems from merging their incidents;
cross-source correlation links those cases as related/campaign members instead.
The rules hit are recorded as a cluster attribute and feed the diversity risk
factor; they are deliberately NOT part of the signature so a newly-seen rule for
an open entity enriches the existing case instead of fragmenting it.
"""

from __future__ import annotations

from ..constants import EntityType
from ..utils import stable_signature


def cluster_signature(
    entity_type: EntityType,
    entity_value: str,
    *,
    source_id: str | None = None,
) -> str:
    if source_id:
        return stable_signature("cluster", source_id, entity_type.value, entity_value)
    return stable_signature("cluster", entity_type.value, entity_value)


async def find_open_case_for_cluster(cases, cluster):
    """Find the source-scoped case, with a one-way legacy-signature bridge.

    Releases before source isolation keyed cases by entity alone. On upgrade, the
    first new source-scoped cluster must update that open case in place instead of
    minting a duplicate. New cases never use the legacy key.
    """
    existing = await cases.find_open_by_signature(cluster.signature)
    if existing is not None or not getattr(cluster, "source_id", None):
        return existing
    legacy = getattr(cluster, "legacy_signature", None) or cluster_signature(
        cluster.entity.type, cluster.entity.value
    )
    if legacy == cluster.signature:
        return None
    legacy_case = await cases.find_open_by_signature(legacy)
    if (
        legacy_case is not None
        and getattr(legacy_case, "source_id", None)
        and legacy_case.source_id != cluster.source_id
    ):
        # Older releases could persist source provenance while still using the
        # entity-only signature. Never let a different source claim that case.
        return None
    return legacy_case


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
