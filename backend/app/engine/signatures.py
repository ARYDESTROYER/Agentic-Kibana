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
