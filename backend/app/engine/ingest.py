"""Shared ingest path — correlate normalised events into cases.

Both the poller (PULL) and the push receivers (webhook/syslog/queues/…) produce
batches of normalised :class:`RawEvent`. From there the handling is IDENTICAL:
correlate into clusters, drop suppressed clusters, then for each cluster either
attach to an open case (idempotent), auto-investigate (if its rule is on the
allowlist), or register a candidate. Centralising it here guarantees push and
pull ingestion behave the same and never drop an event.
"""

from __future__ import annotations

import collections
import logging
from typing import TYPE_CHECKING

from ..config import Preferences
from ..constants import OPEN_CASE_STATUSES, ActionType, SourceSurface
from ..engine.cost_gate import passes_suppression
from ..models import Cluster, RawEvent
from ..utils import iso_now

if TYPE_CHECKING:  # avoid import cycles (these import connectors/agents)
    from ..audit.audit_log import AuditLogger
    from ..agents.pipeline import InvestigationPipeline
    from ..stores.cases import CaseStore

logger = logging.getLogger("tlsoc.engine.ingest")


def _push_source_role(src) -> str:
    """The role a PUSH source declares for its events ("alerts" or "events").

    A push source has no per-document index, so it is declared wholesale: either
    ``config["role"] = "alerts"`` or an ``index_patterns`` list whose entries are
    ALL alerts-role. Anything else (incl. no source) is treated as ``events`` —
    full back-compat with today's correlate→allowlist behaviour."""
    if src is None:
        return "events"
    cfg = getattr(src, "config", None) or {}
    if str(cfg.get("role") or "").lower() == "alerts":
        return "alerts"
    try:
        patterns = src.index_patterns()
    except Exception:  # noqa: BLE001
        patterns = []
    if patterns and all(p.role.value == "alerts" for p in patterns):
        return "alerts"
    return "events"


def dedup_by_id(events: list[RawEvent]) -> list[RawEvent]:
    """De-dupe events by document id (overlapping windows/batches). First wins."""
    seen: dict[str, RawEvent] = {}
    for ev in events:
        if ev.id not in seen:
            seen[ev.id] = ev
    return list(seen.values())


def _auto_correlate_allowed(cluster: Cluster, prefs: Preferences) -> bool:
    """The per-source + per-sub-source "Auto-Correlate" gate (Wave 5 / F6).

    A cluster may auto-forward to investigation ONLY when BOTH its SOURCE and the
    matched SUB-SOURCE (index pattern) allow it. Both toggles default TRUE so, out of
    the box, this returns True for every cluster and the auto-forward decision is
    byte-identical to before.

    Resolution:
      * Source level — ``SourceInstance.auto_correlate()`` (config["auto_correlate"]).
      * Sub-source level — every configured index pattern that ANY member event's
        ``_index`` matches must have ``auto_correlate=True``; a cluster touching a
        pattern whose toggle is OFF is not auto-forwarded. When the source declares no
        index patterns (legacy / push sources without patterns), the sub-source check
        is a no-op (True), so back-compat holds.

    A cluster with no resolvable source (the legacy implicit single source) always
    returns True — nothing changes for the default deployment."""
    source_id = cluster.source_id
    if not source_id:
        return True
    src = next((s for s in prefs.sources if s.id == source_id), None)
    if src is None:
        return True
    if not src.auto_correlate():
        return False
    patterns = src.index_patterns()
    if not patterns:
        return True
    import fnmatch

    # Disabled-sub-source patterns this cluster's events touch ⇒ block auto-forward.
    disabled = [p.pattern for p in patterns if not p.auto_correlate]
    if not disabled:
        return True
    for ev in cluster.member_events:
        idx = ev.index or ""
        for pat in disabled:
            if idx and fnmatch.fnmatch(idx, pat):
                return False
    return True


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
        # Alerts-role index patterns carry SIEM-generated detections the operator
        # wants EVERY one of triaged: an alerts-role cluster is auto-forwarded to
        # investigation regardless of the auto-forward allowlist (still gated by
        # background_scan_enabled, the global automated-investigation switch).
        # Events-role clusters keep the existing correlate→allowlist behaviour.
        #
        # The per-source + per-sub-source "Auto-Correlate" toggle (Wave 5 / F6) is an
        # ADDITIONAL gate on top of all of the above: a cluster auto-forwards only when
        # its source AND the matched sub-source pattern allow it. Both default TRUE so
        # this is byte-identical out of the box; a disabled toggle routes the cluster to
        # a candidate (manual triage) instead — it is still correlated + never dropped.
        forwarded = (
            prefs.background_scan_enabled
            and _auto_correlate_allowed(cluster, prefs)
            and (cluster.is_alert or wildcard or any(r in allow for r in cluster.rule_values))
        )
        if forwarded:
            await pipeline.investigate_cluster(cluster, source_surface, prefs)
            stats["investigated"] += 1
        else:
            await pipeline.register_candidate(cluster, source_surface, prefs)
            stats["candidates"] += 1
    return stats


async def link_cross_source(
    clusters: list[Cluster],
    prefs: Preferences,
    *,
    cases: "CaseStore",
) -> int:
    """Run the OPT-IN cross-source correlation pass and apply RELATED links.

    This runs AFTER per-source correlation + handling, and ONLY when
    ``prefs.cross_source_correlation.enabled``. It NEVER force-merges: the per-cluster
    1:1 signature is untouched (#4). For each cross-source group it sets, on every
    member case, ``cross_source_cluster_id`` (the stable group id) +
    ``related_case_ids`` (the OTHER members) + ``source_breakdown`` (source_id→count),
    then re-saves the cases. Best-effort: any error is swallowed (it must never break
    ingestion). Returns the number of cases linked.

    The cross-source candidate pool is: the OPEN cases behind THIS batch's clusters
    (rich entity sets from member events) PLUS the recent OPEN cases in the store
    (contributing their primary entity), so a cluster from one source links to an
    already-open case from another source."""
    from .correlation import (
        CrossSourceItem,
        _entity_keys,
        cluster_cross_source_entities,
        cross_source_correlate,
    )

    cfg = prefs.cross_source_correlation
    if not cfg.enabled or not clusters:
        return 0
    entity_keys = _entity_keys(prefs)
    if not entity_keys:
        return 0

    items: list[CrossSourceItem] = []
    case_by_id: dict[str, object] = {}
    seen_ids: set[str] = set()
    # 1) Items from THIS batch's clusters (full cross-source entity sets from members).
    for cluster in clusters:
        existing = await cases.find_open_by_signature(cluster.signature)
        if existing is None:
            continue
        ents = cluster_cross_source_entities(cluster, entity_keys)
        if not ents:
            continue
        case_by_id[existing.case_id] = existing
        seen_ids.add(existing.case_id)
        items.append(CrossSourceItem(
            id=existing.case_id,
            source_id=existing.source_id or (cluster.source_id or ""),
            ts=cluster.last_seen_millis or cluster.first_seen_millis or 0,
            entities=ents,
        ))
    if not items:
        return 0

    # 2) Recent non-terminal cases in the store (their PRIMARY entity) as cross-source
    #    candidates from OTHER sources. Bounded; best-effort. We pull a recent page and
    #    keep the still-open (non-terminal) ones so an investigated case can still link.
    try:
        recent_cases, _ = await cases.list(limit=200, sort_field="updated_at")
    except Exception:  # noqa: BLE001 — candidate pooling is best-effort
        recent_cases = []
    open_statuses = set(OPEN_CASE_STATUSES)
    for oc in recent_cases:
        if oc.case_id in seen_ids:
            continue
        status_val = getattr(oc.status, "value", oc.status)
        if str(status_val) not in open_statuses:
            continue
        try:
            et = oc.entity.type
        except Exception:  # noqa: BLE001
            continue
        if et not in entity_keys or not oc.entity.value:
            continue
        case_by_id[oc.case_id] = oc
        seen_ids.add(oc.case_id)
        ts = _case_millis(oc)
        items.append(CrossSourceItem(
            id=oc.case_id, source_id=oc.source_id or "",
            ts=ts, entities=frozenset({(et, oc.entity.value)}),
        ))

    groups = cross_source_correlate(items, prefs)
    if not groups:
        return 0

    linked = 0
    for grp in groups:
        member_ids = grp["members"]
        for cid in member_ids:
            case = case_by_id.get(cid)
            if case is None:
                continue
            related = sorted(set(member_ids) - {cid})
            breakdown: dict[str, int] = {}
            for other_id in member_ids:
                other = case_by_id.get(other_id)
                if other is not None and other.source_id:
                    breakdown[other.source_id] = breakdown.get(other.source_id, 0) + 1
            changed = False
            if case.cross_source_cluster_id != grp["cross_source_cluster_id"]:
                case.cross_source_cluster_id = grp["cross_source_cluster_id"]
                changed = True
            if set(case.related_case_ids) != set(related):
                case.related_case_ids = related
                changed = True
            if case.source_breakdown != breakdown:
                case.source_breakdown = breakdown
                changed = True
            if changed:
                case.updated_at = iso_now()
                try:
                    await cases.save(case)
                    linked += 1
                except Exception:  # noqa: BLE001 — never break ingestion
                    pass
    return linked


def _case_millis(case) -> int:
    """Best-effort epoch-millis for a case's time (updated_at, else created_at)."""
    from ..utils import parse_es_timestamp, to_millis

    for attr in ("updated_at", "created_at"):
        ts = getattr(case, attr, None)
        if ts:
            parsed = parse_es_timestamp(ts)
            if parsed:
                return to_millis(parsed)
    return 0


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
        # Bounded per-source recent-events ring buffer so PUSH sources (which flow
        # straight to correlate→cases with no retained copy) can be browsed (live
        # tail). Keyed by source_id; capped per source so memory stays bounded.
        self._recent: dict[str, collections.deque] = {}
        self._recent_max = 500

    async def ingest(
        self,
        events: list[RawEvent],
        prefs: Preferences | None = None,
        source_surface: SourceSurface = SourceSurface.AUTOMATED_SCAN,
        source_id: str | None = None,
    ) -> dict[str, int]:
        prefs = prefs or self._get_prefs()
        base = {"received": 0, "clusters": 0, "investigated": 0,
                "candidates": 0, "attached": 0, "suppressed": 0}
        if not events:
            return base
        from ..engine.correlation import correlate  # local import avoids a cycle

        events = dedup_by_id(events)
        if source_id:
            # Tag PUSH events with source provenance + role (the ElasticConnector
            # does this for PULL). A push source can be declared an ALL-alerts source
            # via config (``role: alerts`` / ``index_patterns`` all-alerts) so every
            # one of its clusters auto-forwards. Never overwrites a role/source the
            # event already carries (e.g. set by a connector).
            src = next((s for s in prefs.sources if s.id == source_id), None)
            push_role = _push_source_role(src)
            name = (src.display_name or source_id) if src else source_id
            for ev in events:
                if not ev.source_id:
                    ev.source_id = source_id
                if not ev.source_name:
                    ev.source_name = name
                if push_role == "alerts":
                    ev.index_role = "alerts"
            buf = self._recent.get(source_id)
            if buf is None:
                buf = collections.deque(maxlen=self._recent_max)
                self._recent[source_id] = buf
            buf.extend(events)
        try:
            # Honour the originating source's per-source entity strategy (entity-
            # agnostic correlation; default auto preserves today's behaviour).
            src = next((s for s in prefs.sources if s.id == source_id), None) if source_id else None
            strategy = prefs.entity_strategy_for(src)
            clusters = correlate(events, prefs, entity_strategy=strategy)
            stats = await handle_clusters(
                clusters, prefs, cases=self._cases, pipeline=self._pipeline,
                source_surface=source_surface,
            )
            # Opt-in cross-source correlation (Wave 5 / F6): AFTER per-source handling,
            # link open cases sharing an entity across sources as RELATED (never merged).
            # No-op (returns 0) when disabled — the default — so single-source is unchanged.
            if prefs.cross_source_correlation.enabled:
                try:
                    stats["cross_source_linked"] = await link_cross_source(
                        clusters, prefs, cases=self._cases
                    )
                except Exception as exc:  # noqa: BLE001 — never break ingestion
                    logger.warning("cross-source correlation failed: %s", exc)
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

    def recent_events_for_source(self, source_id: str, limit: int = 100) -> list[RawEvent]:
        """Most-recent-first buffered events for a push source (live-tail browse)."""
        buf = self._recent.get(source_id)
        if not buf:
            return []
        return list(buf)[-max(1, limit):][::-1]
