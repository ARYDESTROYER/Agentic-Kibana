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
from ..engine.cost_gate import passes_suppression
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

    def _correlation_lookback_seconds(self, prefs: Preferences) -> int:
        """The sliding look-back (seconds) correlation must see each poll.

        Correlation triggers require N events within ``window_seconds`` of the SAME
        entity. The durable cursor only yields the incremental batch since the last
        poll (~one poll interval of events in steady state), so a real burst spread
        across its full window would arrive a few events at a time and never reach
        the threshold in any single batch (BUG-5). We therefore correlate over the
        WIDEST configured rule window (never less than one poll interval) plus a
        small safety margin, so a slow-burn burst is seen whole. The cursor still
        governs what is "new" for de-dup of investigation/attach (Non-negotiable #4).
        """
        windows = [prefs.default_correlation.window_seconds]
        windows += [r.window_seconds for r in prefs.correlation_rules.values()]
        widest = max(windows) if windows else prefs.default_correlation.window_seconds
        interval = max(1, prefs.poll_interval_seconds)
        # +2 poll intervals of slack absorbs poll jitter / a late-arriving event at
        # the trailing edge of the window without re-scanning unboundedly.
        return max(widest, interval) + 2 * interval

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
                 "clusters": 0, "investigated": 0, "candidates": 0, "attached": 0,
                 "window_events": 0}

        # Correlate over the FULL sliding look-back window (not just the incremental
        # batch) so real-time bursts spread across >1 poll interval still trigger.
        # The cursor read above is what advances the cursor & defines "new"; this is
        # a second, read-only window over the SAME in-scope log surface (#1, #12).
        # We only do the wider read when there is genuinely new activity, so a quiet
        # poll stays cheap and we never re-correlate an unchanged window.
        if new_events:
            from ..engine.correlation import correlate  # local import avoids cycle at import time

            lookback_ms = self._correlation_lookback_seconds(prefs) * 1000
            window_from = to_millis(now_utc()) - lookback_ms
            # Never look back further than a cold start would; the cursor still bounds
            # what is treated as new, so this only widens the correlation input.
            window_from = max(window_from, cold_from)
            window_cursor = Cursor(timestamp_millis=window_from)
            window_body = poll_query(prefs, window_cursor, window_from)
            window_resp = await self._es.search_logs(prefs.data_view_pattern, window_body)
            window_hits = window_resp.get("hits", {}).get("hits", [])
            window_events = self._dedup_by_id(
                [RawEvent.from_hit(h, prefs) for h in window_hits] + new_events
            )
            stats["window_events"] = len(window_events)

            clusters = correlate(window_events, prefs)
            stats["clusters"] = len(clusters)
            allow = set(prefs.auto_forward_allowlist)
            wildcard = "*" in allow
            for cluster in clusters:
                # Defence-in-depth suppression (cost-gate layer 2): the poll query
                # already excludes suppressed events; if an ENTIRE cluster is
                # suppressed, skip it (suppression is the intended drop mechanism).
                if not passes_suppression(cluster, prefs):
                    stats["suppressed"] = stats.get("suppressed", 0) + 1
                    continue
                existing = await self._cases.find_open_by_signature(cluster.signature)
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

    @staticmethod
    def _dedup_by_id(events: list[RawEvent]) -> list[RawEvent]:
        """De-dupe events by document id (the wider window may overlap the
        incremental batch). First occurrence wins; order is preserved."""
        seen: dict[str, RawEvent] = {}
        for ev in events:
            if ev.id not in seen:
                seen[ev.id] = ev
        return list(seen.values())

    async def _attach(self, existing, cluster) -> None:
        before = len(existing.member_event_ids)
        merged = list(dict.fromkeys(existing.member_event_ids + cluster.member_event_ids))
        if len(merged) == before:
            return  # idempotent: nothing new to attach
        existing.member_event_ids = merged
        existing.updated_at = iso_now()
        existing.rule_ids = sorted(set(existing.rule_ids) | set(cluster.rule_values))
        existing.history.append({"ts": existing.updated_at, "event": "attach",
                                 "added_events": len(merged) - before})
        await self._cases.save(existing)

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
