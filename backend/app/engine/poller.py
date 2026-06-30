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
from ..connectors.base import PullConnector
from ..connectors.elastic import ElasticConnector
from ..constants import ActionType, SourceSurface
from ..engine.ingest import attach_cluster, dedup_by_id, handle_clusters
from ..es.base import BaseESClient
from ..models import Cursor, RawEvent
from ..stores.cursor_store import CursorStore
from ..utils import now_utc, to_millis
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


def advance_cursor_to(cursor: Cursor, max_ts: int, boundary_ids: list[str]) -> Cursor:
    """Advance ``cursor`` to an explicit watermark ``(max_ts, boundary_ids)``.

    The watermark-driven variant of :func:`advance_cursor` (#4). A per-feed poll
    advances over the watermark of EVERY hit it SCANNED — kept AND dropped — not just
    the kept events, so a broad feed that drops hits owned by a narrower overlapping
    feed still advances its OWN cursor over the whole window it scanned and never
    skips its own newer events beyond that window. Same no-skip-ties tiebreaker as
    ``advance_cursor``: same-millisecond ids are unioned with the existing boundary so
    a tie is never re-processed nor skipped. A watermark at/behind the cursor (or an
    empty/zero watermark — the feed read nothing) leaves the cursor unchanged."""
    if max_ts <= 0 or max_ts < cursor.timestamp_millis:
        return cursor
    boundary = list(boundary_ids)
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
        source: PullConnector | None = None,
    ) -> None:
        self._es = es
        # The read-only log surface the poller reads from. Defaults to wrapping
        # ``es`` in an ElasticConnector (behaviour identical to the legacy direct
        # ES read); state wiring injects the configured primary connector.
        self._source = source or ElasticConnector(es)
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

    def _cursor_key(self, prefs: Preferences, feed_id: str) -> str:
        """The durable cursor key for one feed: ``f'{source.id}:{feed.id}'`` so a fast
        alerts feed and a slow events feed never share/skip a cursor (#4). Falls back
        to the legacy ``primary`` key when the source/feed has no stable id (so an
        existing single-source cursor is read unchanged — no migration)."""
        source_id = getattr(self._source, "connector_id", "") or ""
        if not source_id or not feed_id:
            return "primary"
        return f"{source_id}:{feed_id}"

    def _source_feeds(self):
        """The connector's per-feed list (Wave 6) — empty for a connector that does
        not expose feeds (legacy single-cursor union path)."""
        getter = getattr(self._source, "feeds", None)
        if getter is None:
            return []
        try:
            return list(getter())
        except Exception:  # noqa: BLE001
            return []

    async def _poll_feed_scan(self, prefs: Preferences, feed, cursor: Cursor, cold_from: int):
        """Fetch one feed's batch + its full-scan watermark (#4).

        Prefers the connector's ``poll_feed_scan`` (which reports the watermark of
        EVERY hit it read, kept AND dropped) so a broad feed's cursor advances over the
        whole window it scanned and never skips its own newer events past a window owned
        by a narrower overlapping feed. Falls back to ``poll_feed`` for a connector that
        only exposes the events list — there the watermark is synthesised from the kept
        events (back-compat: a connector with no overlapping-feed drop has identical
        kept/scanned sets, so this is byte-equivalent to advancing over the batch)."""
        from ..connectors.elastic import FeedScan

        scan_fn = getattr(self._source, "poll_feed_scan", None)
        if scan_fn is not None:
            return await scan_fn(prefs, feed, cursor, cold_from)
        events = await self._source.poll_feed(prefs, feed, cursor, cold_from)
        max_ts = max((e.timestamp_millis for e in events), default=0)
        boundary = [e.id for e in events if e.timestamp_millis == max_ts] if max_ts > 0 else []
        return FeedScan(events=events, scan_max_ts=max_ts, scan_boundary_ids=boundary)

    async def poll_once(self, prefs: Preferences | None = None) -> dict[str, Any]:
        prefs = prefs or self._get_prefs()
        cold_from = to_millis(now_utc()) - prefs.cold_start_lookback_minutes * 60 * 1000

        # Wave 6: read each FEED on its OWN durable cursor (so a fast alerts feed and a
        # slow events feed never share/skip a cursor, #4). A legacy/un-fed source has
        # no feeds → the single-cursor union path below, byte-identical to before. Each
        # per-feed cursor still governs what is "new" for THAT feed; dedup/advance is
        # unchanged, just applied per feed.
        feeds = self._source_feeds()
        fetched: list[RawEvent] = []
        new_events: list[RawEvent] = []
        # Track each feed's (key, loaded cursor, advanced cursor) so we persist each
        # cursor independently after handling. The advanced cursor is computed from the
        # FULL SCANNED watermark (kept + dropped hits), NOT only the kept batch (#4) —
        # a broad feed that drops hits owned by a narrower overlapping feed must still
        # advance its own cursor over the whole window it scanned or it skips its own
        # newer events forever (the dropped hits are owned + processed by the narrower
        # feed via that feed's own cursor; no skip, no dup).
        feed_state: list[tuple[str, Cursor, Cursor]] = []
        if feeds:
            for feed in feeds:
                # Per-feed exception isolation (#4): a single feed whose operator
                # query_string / read fails must NOT abort the whole poll cycle and
                # freeze every other feed's cursor. On failure we log + skip THIS feed
                # only — it gets no feed_state entry, so its cursor is left untouched
                # while healthy feeds proceed and advance their own cursors. Mirrors the
                # whole-loop shield around poll_once in the run loop below.
                try:
                    key = self._cursor_key(prefs, feed.id)
                    fcursor = await self._cursor_store.load_keyed(key)
                    scan = await self._poll_feed_scan(prefs, feed, fcursor, cold_from)
                except Exception:  # noqa: BLE001 — isolate one feed's failure
                    logger.exception(
                        "poll_feed failed for feed %s; skipping it this tick (cursor untouched)",
                        getattr(feed, "id", "?"),
                    )
                    continue
                fbatch = scan.events
                # Advance over the full scanned watermark, not just the kept batch (#4).
                advanced = advance_cursor_to(fcursor, scan.scan_max_ts, scan.scan_boundary_ids)
                feed_state.append((key, fcursor, advanced))
                fetched.extend(fbatch)
                new_events.extend(e for e in fbatch if not fcursor.should_skip(e))
        else:
            cursor = await self._cursor_store.load()
            fetched = await self._source.poll(prefs, cursor, cold_from)
            new_events = [e for e in fetched if not cursor.should_skip(e)]
            feed_state.append(("primary", cursor, advance_cursor(cursor, fetched)))

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
            window_fetched = await self._source.poll(prefs, window_cursor, window_from)
            window_events = dedup_by_id(window_fetched + new_events)
            stats["window_events"] = len(window_events)

            # Honour the primary source's per-source entity strategy (entity-agnostic
            # correlation; default ``auto`` keeps today's behaviour byte-for-byte).
            strategy = prefs.entity_strategy_for(prefs.primary_source())
            clusters = correlate(window_events, prefs, entity_strategy=strategy)
            # Attach/investigate/register is the SHARED ingest path (identical for
            # push receivers): see app/engine/ingest.handle_clusters.
            cluster_stats = await handle_clusters(
                clusters, prefs, cases=self._cases, pipeline=self._pipeline,
                source_surface=SourceSurface.AUTOMATED_SCAN,
            )
            stats.update(cluster_stats)
            # Opt-in cross-source correlation (Wave 5 / F6): link open cases sharing an
            # entity across sources as RELATED (never merged). No-op when disabled.
            if prefs.cross_source_correlation.enabled:
                from ..engine.ingest import link_cross_source

                try:
                    stats["cross_source_linked"] = await link_cross_source(
                        clusters, prefs, cases=self._cases
                    )
                except Exception as exc:  # noqa: BLE001 — never break the poll loop
                    logger.warning("cross-source correlation failed: %s", exc)

        # Persist EACH feed's advanced cursor durably + independently (#4 — a slow
        # feed's cursor is never dragged forward by a fast feed's events). The advanced
        # cursor was computed above from the FULL SCANNED watermark (kept + dropped),
        # so a broad feed never skips its own window when it drops a narrower feed's hits.
        for key, fcursor, new_cursor in feed_state:
            if (new_cursor.timestamp_millis, tuple(new_cursor.boundary_ids)) != (
                fcursor.timestamp_millis, tuple(fcursor.boundary_ids)
            ):
                await self._cursor_store.save_keyed(key, new_cursor)

        await self._audit.record(
            action_type=ActionType.POLL, surface="poller", actor="poller",
            result_summary=(f"polled={stats['polled']} new={stats['new']} "
                            f"clusters={stats['clusters']} investigated={stats['investigated']} "
                            f"candidates={stats['candidates']} attached={stats['attached']}"),
        )
        return stats

    async def _attach(self, existing, cluster) -> None:
        """Merge a cluster's new events into an open case (shared ingest logic)."""
        await attach_cluster(self._cases, existing, cluster)

    # --- background loop ---
    async def _run(self) -> None:
        self._running = True
        logger.info("Poller loop started")
        while self._running:
            prefs = self._get_prefs()
            interval = max(5, prefs.poll_interval_seconds)
            # Demo Mode (Wave 5): while demo is engaged the REAL poll is GATED here —
            # BEFORE source.poll — so the durable cursor (#4) is never advanced while
            # synthetic data is being showcased. The demo telemetry flows through the
            # SEPARATE DemoSimulator into the demo store instead.
            demo_active = bool(getattr(getattr(prefs, "demo", None), "active", False))
            if (
                prefs.polling_enabled and prefs.setup_complete
                and not prefs.caps.kill_switch and not demo_active
            ):
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
