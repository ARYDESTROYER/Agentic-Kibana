"""Polling loop + durable cursor (Section 6.1) — the trigger mechanism.

Elasticsearch is a store, not a stream, so the agent POLLS for above-threshold,
in-scope events newer than a durable cursor. This is also the Surface 3 background
worker: clusters whose rule is on the auto-forward allowlist are auto-investigated;
all other clusters are registered as OPEN candidates (never dropped) for manual
Surface 2 investigation.

Correctness invariants (Non-negotiable #4), all restart-tested:
  * cursor uses an INCLUSIVE lower bound + boundary-id dedup → no event skipped,
    none re-processed;
  * clusters are keyed by signature → re-polling never creates duplicate cases.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from ..audit.audit_log import AuditLogger
from ..config import Preferences
from ..constants import ActionType, SourceSurface
from ..es.base import BaseESClient
from ..es.querybuilder import poll_query
from ..models import Cursor, RawEvent
from ..stores.cursor_store import CursorStore
from ..utils import iso_now, now_utc, to_millis
from ..agents.pipeline import InvestigationPipeline

logger = logging.getLogger("tlsoc.engine.poller")


def advance_cursor(cursor: Cursor, fetched: list[RawEvent]) -> Cursor:
    """Advance the cursor to cover EVERY fetched event without skipping ties."""
    if not fetched:
        return cursor
    max_ts = max(e.timestamp_millis for e in fetched)
    if max_ts < cursor.timestamp_millis:
        return cursor
    boundary = [e.id for e in fetched if e.timestamp_millis == max_ts]
    if cursor.timestamp_millis == max_ts:
        boundary = list(dict.fromkeys(boundary + cursor.boundary_ids))
    else:
        boundary = list(dict.fromkeys(boundary))
    return Cursor(timestamp_millis=max_ts, boundary_ids=boundary)


class Poller:
    def __init__(
        self,
        es: BaseESClient,
        cases: "CaseStore",
        cursor_store: CursorStore,
        audit: AuditLogger,
        pipeline: InvestigationPipeline,
        get_prefs: Callable[[], Preferences],
    ) -> None:
        self._es = es
        self._cases = cases
        self._cursor_store = cursor_store
        self._audit = audit
        self._pipeline = pipeline
        self._get_prefs = get_prefs
        self._task: asyncio.Task | None = None
        self._running = False

    async def poll_once(self, prefs: Preferences | None = None) -> dict[str, Any]:
        prefs = prefs or self._get_prefs()
        cursor = await self._cursor_store.load()
        cold_from = to_millis(now_utc()) - prefs.cold_start_lookback_minutes * 60 * 1000
        body = poll_query(prefs, cursor, cold_from)

        resp = await self._es.search_logs(prefs.data_view_pattern, body)
        hits = resp.get("hits", {}).get("hits", [])
        fetched = [RawEvent.from_hit(h, prefs) for h in hits]
        new_events = [e for e in fetched if not cursor.should_skip(e)]

        stats = {"polled": len(fetched), "new": len(new_events),
                 "clusters": 0, "investigated": 0, "candidates": 0, "attached": 0}

        if new_events:
            from ..engine.correlation import correlate  # local import avoids cycle at import time

            clusters = correlate(new_events, prefs)
            stats["clusters"] = len(clusters)
            allow = set(prefs.auto_forward_allowlist)
            wildcard = "*" in allow
            for cluster in clusters:
                existing = await self._pipeline._cases.find_open_by_signature(cluster.signature)
                if existing:
                    await self._attach(existing, cluster)
                    stats["attached"] += 1
                    continue
                forwarded = prefs.background_scan_enabled and (
                    wildcard or any(r in allow for r in cluster.rule_values)
                )
                if forwarded:
                    await self._pipeline.investigate_cluster(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
                    stats["investigated"] += 1
                else:
                    await self._pipeline.register_candidate(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
                    stats["candidates"] += 1

        # Advance cursor over ALL fetched events (even boundary dupes) so we never
        # re-scan the same window, then persist durably.
        new_cursor = advance_cursor(cursor, fetched)
        if (new_cursor.timestamp_millis, tuple(new_cursor.boundary_ids)) != (
            cursor.timestamp_millis, tuple(cursor.boundary_ids)
        ):
            await self._cursor_store.save(new_cursor)

        await self._audit.record(
            action_type=ActionType.POLL, surface="poller", actor="poller",
            result_summary=(f"polled={stats['polled']} new={stats['new']} "
                            f"clusters={stats['clusters']} investigated={stats['investigated']} "
                            f"candidates={stats['candidates']} attached={stats['attached']}"),
        )
        return stats

    async def _attach(self, existing, cluster) -> None:
        merged = list(dict.fromkeys(existing.member_event_ids + cluster.member_event_ids))
        if set(merged) == set(existing.member_event_ids):
            return  # idempotent: nothing new to attach
        existing.member_event_ids = merged
        existing.updated_at = iso_now()
        existing.rule_ids = sorted(set(existing.rule_ids) | set(cluster.rule_values))
        existing.history.append({"ts": existing.updated_at, "event": "attach",
                                 "added_events": len(merged) - len(existing.member_event_ids)})
        await self._pipeline._cases.save(existing)

    # --- background loop ---
    async def _run(self) -> None:
        self._running = True
        logger.info("Poller loop started")
        while self._running:
            prefs = self._get_prefs()
            interval = max(5, prefs.poll_interval_seconds)
            if prefs.polling_enabled and prefs.setup_complete and not prefs.caps.kill_switch:
                try:
                    await self.poll_once(prefs)
                except Exception as exc:  # noqa: BLE001 — the loop must never die
                    logger.exception("poll_once failed (loop continues): %s", exc)
            await asyncio.sleep(interval)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
