"""Shared ingest path — correlate normalised events into cases.

Both the poller (PULL) and the push receivers (webhook/syslog/queues/…) produce
batches of normalised :class:`RawEvent`. From there the handling is IDENTICAL:
correlate into clusters, drop suppressed clusters, then for each cluster either
attach to an open case (idempotent), auto-investigate (if its rule is on the
allowlist), or register a candidate. Centralising it here guarantees push and
pull ingestion behave the same and never drop an event.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ..config import Preferences
from ..constants import ActionType, SourceSurface
from ..engine.cost_gate import passes_suppression
from ..models import Cluster, RawEvent
from ..utils import iso_now

if TYPE_CHECKING:  # avoid import cycles (these import connectors/agents)
    from ..audit.audit_log import AuditLogger
    from ..agents.pipeline import InvestigationPipeline
    from ..stores.cases import CaseStore

logger = logging.getLogger("tlsoc.engine.ingest")


def dedup_by_id(events: list[RawEvent]) -> list[RawEvent]:
    """De-dupe events by document id (overlapping windows/batches). First wins."""
    seen: dict[str, RawEvent] = {}
    for ev in events:
        if ev.id not in seen:
            seen[ev.id] = ev
    return list(seen.values())


async def attach_cluster(cases: "CaseStore", existing, cluster: Cluster) -> bool:
    """Merge a cluster's new events into an open case. Idempotent; returns True iff
    something new was attached."""
    before = len(existing.member_event_ids)
    merged = list(dict.fromkeys(existing.member_event_ids + cluster.member_event_ids))
    if len(merged) == before:
        return False  # nothing new
    existing.member_event_ids = merged
    existing.updated_at = iso_now()
    existing.rule_ids = sorted(set(existing.rule_ids) | set(cluster.rule_values))
    existing.history.append({"ts": existing.updated_at, "event": "attach",
                             "added_events": len(merged) - before})
    # Carry a deterministic "why this fired" reason onto a case that lacks one
    # (e.g. a manually-opened case an automated burst now attaches to) — without
    # overwriting a reason it already has.
    if existing.trigger_reason is None and cluster.trigger_reason is not None:
        existing.trigger_reason = cluster.trigger_reason
    await cases.save(existing)
    return True


async def handle_clusters(
    clusters: list[Cluster],
    prefs: Preferences,
    *,
    cases: "CaseStore",
    pipeline: "InvestigationPipeline",
    source_surface: SourceSurface,
) -> dict[str, int]:
    """Attach / investigate / register each cluster. Returns count stats."""
    stats = {"clusters": len(clusters), "investigated": 0, "candidates": 0,
             "attached": 0, "suppressed": 0}
    allow = set(prefs.auto_forward_allowlist)
    wildcard = "*" in allow
    for cluster in clusters:
        # Defence-in-depth suppression (cost-gate layer 2): an entirely-suppressed
        # cluster is the intended drop mechanism.
        if not passes_suppression(cluster, prefs):
            stats["suppressed"] += 1
            continue
        existing = await cases.find_open_by_signature(cluster.signature)
        if existing:
            await attach_cluster(cases, existing, cluster)
            stats["attached"] += 1
            continue
        forwarded = prefs.background_scan_enabled and (
            wildcard or any(r in allow for r in cluster.rule_values)
        )
        if forwarded:
            await pipeline.investigate_cluster(cluster, source_surface, prefs)
            stats["investigated"] += 1
        else:
            await pipeline.register_candidate(cluster, source_surface, prefs)
            stats["candidates"] += 1
    return stats


class IngestService:
    """The entrypoint push receivers feed: normalised events → correlated cases.

    Unlike the poller (which owns a durable cursor over a pollable store), push
    sources hand us events as they arrive, so there is no cursor here — just the
    shared correlate→handle_clusters path. Errors never propagate to the caller
    (a receiver must not crash on a bad batch)."""

    def __init__(
        self,
        cases: "CaseStore",
        audit: "AuditLogger",
        pipeline: "InvestigationPipeline",
        get_prefs,
    ) -> None:
        self._cases = cases
        self._audit = audit
        self._pipeline = pipeline
        self._get_prefs = get_prefs

    async def ingest(
        self,
        events: list[RawEvent],
        prefs: Preferences | None = None,
        source_surface: SourceSurface = SourceSurface.AUTOMATED_SCAN,
    ) -> dict[str, int]:
        prefs = prefs or self._get_prefs()
        base = {"received": 0, "clusters": 0, "investigated": 0,
                "candidates": 0, "attached": 0, "suppressed": 0}
        if not events:
            return base
        from ..engine.correlation import correlate  # local import avoids a cycle

        events = dedup_by_id(events)
        try:
            clusters = correlate(events, prefs)
            stats = await handle_clusters(
                clusters, prefs, cases=self._cases, pipeline=self._pipeline,
                source_surface=source_surface,
            )
        except Exception as exc:  # noqa: BLE001 — a bad batch must not crash a receiver
            logger.exception("ingest failed for a %d-event batch: %s", len(events), exc)
            await self._audit.record(
                action_type=ActionType.ERROR, surface="ingest", actor="ingest",
                result_summary=f"ingest error on {len(events)} events: {exc}",
            )
            return {**base, "received": len(events)}
        stats["received"] = len(events)
        await self._audit.record(
            action_type=ActionType.POLL, surface="ingest", actor="ingest",
            result_summary=(f"received={len(events)} clusters={stats['clusters']} "
                            f"investigated={stats['investigated']} candidates={stats['candidates']} "
                            f"attached={stats['attached']}"),
        )
        return stats
