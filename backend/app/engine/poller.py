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
from ..engine.cost_gate import passes_suppression
from ..engine.ingest import (
    _is_ignored_cluster,
    attach_cluster,
    dedup_by_id,
    handle_clusters,
)
from ..engine.noise_counters import (
    count_clusters_by_band,
    count_events_by_band,
    severity_scale_for_source,
    zero_bands,
)
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
        # Round-4 Wave-4: OPTIONAL EVENT-feed routing hook. When set (by AppState) AND
        # batch+event-detection are enabled, a ``role=events`` feed's fetched events are
        # routed to this async funnel (aggregate→rules→anomaly→batched detection) INSTEAD
        # OF the realtime correlation-window read — keeping high-volume EVENT feeds out
        # of the realtime path (per the 01 ingestion map). The hook is
        # ``async (events, prefs) -> None`` and NEVER raises into the poll cycle. When the
        # hook is None (the default) or the toggle is OFF, the EXISTING realtime path is
        # byte-identical (the critical safety property: default OFF = no change). The
        # feed's durable cursor still advances over the full scanned window (#4 no-skip)
        # regardless of which path handles the events.
        self._event_funnel: Callable | None = None
        # Round-7 Noise-Reduction counters: an OPTIONAL fail-open sink that records this
        # poll tick's raw-alert-by-severity tally (ingested/clustered/suppressed/ignored)
        # into the durable NoiseCounterStore. Wired by AppState (fanned out via
        # PollerManager.set_noise_sink) as a SEPARATE hook from ``_event_funnel`` (P0 name
        # collision avoidance). ``async (delta: dict) -> None`` and NEVER raises into the
        # poll cycle. None (the default) → no counters recorded (byte-identical poll path);
        # advisory presentation state only, never feeds ``decide()`` (#3).
        self._noise_sink: Callable | None = None
        # The durable cursor key used by the LEGACY / un-fed union path (a source with
        # no ``index_patterns`` feeds). Defaults to ``"primary"`` so a single-source
        # deployment reads the legacy ``CURSOR_DOC_ID`` doc unchanged (#4 — no
        # migration). The Round-4 :class:`PollerManager` overrides this to a DISTINCT
        # ``f"{source.id}:primary"`` for every NON-primary un-fed source so two un-fed
        # sources under fan-out never stomp the single shared ``primary`` cursor doc.
        self._legacy_cursor_key = "primary"

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

    def _event_routing_active(self, prefs: Preferences) -> bool:
        """Whether high-volume EVENT-feed routing to the detection funnel is engaged.

        Active only when a funnel hook is wired AND batch inference AND the anomaly
        baseline (the event-detection toggle) are BOTH enabled. Default OFF on every
        count, so the EXISTING realtime path is byte-identical out of the box (the
        critical safety property). Demo mode is gated in the run loop before we ever
        reach here, so a demo tick never routes to the real funnel."""
        if self._event_funnel is None:
            return False
        batch = getattr(prefs, "batch", None)
        baseline = getattr(prefs, "baseline", None)
        return bool(getattr(batch, "enabled", False)) and bool(getattr(baseline, "enabled", False))

    @staticmethod
    def _feed_is_events_role(feed) -> bool:
        """True when a feed carries the ``events`` role (the high-volume, correlate→
        allowlist role). ALERTS feeds are unchanged (they stay on the realtime path);
        an IGNORE feed never reaches the poll loop (``feeds()`` excludes it)."""
        role = getattr(feed, "role", None)
        return str(getattr(role, "value", role)) == "events"

    def _routed_events_feed_ids(self, feeds) -> set[str]:
        """The ids of the ``events``-role feeds whose events are routed to the funnel.

        Used to keep those events OUT of the wider correlation-window read too — the
        window re-reads ALL feeds via ``source.poll``, so without this filter a routed
        events feed's events would sneak back into the realtime correlate. Matching is by
        ``feed_id`` (the connector tags every kept event with it)."""
        out: set[str] = set()
        for feed in feeds:
            if not self._feed_is_events_role(feed):
                continue
            fid = getattr(feed, "id", "") or ""
            if fid:
                out.add(str(fid))
        return out

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
        # Round-4 Wave-4: when EVENT-feed routing is engaged (batch + baseline enabled +
        # a funnel hook wired), a ``role=events`` feed's NEW events are collected here and
        # handed to the detection funnel INSTEAD OF the realtime correlation window read —
        # so the high-volume EVENT path never hits the realtime correlate. Default OFF →
        # this list stays empty and every event flows the byte-identical realtime path.
        event_routing = feeds and self._event_routing_active(prefs)
        funnel_events: list[RawEvent] = []
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
                # This happens for EVERY feed regardless of which path handles its events,
                # so an EVENT feed routed to the funnel still advances its own cursor and
                # never re-reads / skips (the never-skip invariant is path-independent).
                advanced = advance_cursor_to(fcursor, scan.scan_max_ts, scan.scan_boundary_ids)
                feed_state.append((key, fcursor, advanced))
                fetched.extend(fbatch)
                feed_new = [e for e in fbatch if not fcursor.should_skip(e)]
                # EVENT-feed routing: a ``role=events`` feed's new events go to the
                # detection funnel (INSTEAD OF the realtime correlate window). ALERTS
                # feeds are unchanged — they stay on the realtime path below.
                if event_routing and self._feed_is_events_role(feed):
                    funnel_events.extend(feed_new)
                else:
                    new_events.extend(feed_new)
        else:
            # Legacy / un-fed union path. The primary (or sole) source uses the legacy
            # ``"primary"`` cursor doc (byte-identical, no migration); a NON-primary
            # un-fed source under fan-out uses its OWN ``f"{source.id}:primary"`` key
            # (set by the PollerManager) so two un-fed sources never collide (#4).
            lkey = self._legacy_cursor_key
            cursor = (
                await self._cursor_store.load()
                if lkey == "primary"
                else await self._cursor_store.load_keyed(lkey)
            )
            fetched = await self._source.poll(prefs, cursor, cold_from)
            new_events = [e for e in fetched if not cursor.should_skip(e)]
            feed_state.append((lkey, cursor, advance_cursor(cursor, fetched)))

        stats = {"polled": len(fetched), "new": len(new_events),
                 "clusters": 0, "investigated": 0, "candidates": 0, "attached": 0,
                 "window_events": 0, "funnel_routed": 0}

        # Round-4 Wave-4: hand routed EVENT-feed events to the detection funnel (best-
        # effort, out-of-the-realtime-path). This is a NO-OP unless routing is engaged;
        # ``funnel_events`` is empty otherwise. The hook never raises into the poll cycle.
        if funnel_events and self._event_funnel is not None:
            stats["funnel_routed"] = len(funnel_events)
            try:
                await self._event_funnel(funnel_events, prefs)
            except Exception as exc:  # noqa: BLE001 — the funnel must never break a poll
                logger.warning("event-detection funnel routing failed: %s", exc)

        # Correlate over the FULL sliding look-back window (not just the incremental
        # batch) so real-time bursts spread across >1 poll interval still trigger.
        # The cursor read above is what advances the cursor & defines "new"; this is
        # a second, read-only window over the SAME in-scope log surface (#1, #12).
        # We only do the wider read when there is genuinely new activity, so a quiet
        # poll stays cheap and we never re-correlate an unchanged window.
        #
        # Round-7 Noise-Reduction counters (fail-open; never slows the poll path, #H W0.8):
        # the clustered/suppressed/ignored bands are computed INSIDE the ``if new_events:``
        # block below (where ``clusters``/``cluster_stats``/``own_source`` are in scope);
        # the ingested band + the sink invocation are ALWAYS-in-scope after it, so an
        # events-only / quiet tick can never UnboundLocalError on those block-locals.
        noise_clustered = zero_bands()
        noise_suppressed = 0
        noise_ignored = 0
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
            # Round-4 Wave-4: the wider window read unions ALL feeds via ``source.poll`` —
            # so when EVENT-feed routing is active, drop the routed events-role feeds'
            # events from the realtime correlation input too (they were already handed to
            # the funnel above). ALERTS feed events are kept (they stay realtime). No-op
            # when routing is off → byte-identical window (the safety property).
            if event_routing:
                routed_ids = self._routed_events_feed_ids(feeds)
                if routed_ids:
                    window_events = [
                        e for e in window_events
                        if (getattr(e, "feed_id", "") or "") not in routed_ids
                    ]
            stats["window_events"] = len(window_events)

            # Honour THIS source's per-source entity strategy (entity-agnostic
            # correlation; default ``auto`` keeps today's behaviour byte-for-byte).
            # Round 4 fan-out: each per-source Poller resolves ITS OWN SourceInstance
            # from its connector_id (falling back to the primary/global strategy when
            # the connector has no matching configured source — the legacy single-poll
            # / implicit-source case, byte-identical to before).
            own_source = prefs.source_by_id(getattr(self._source, "connector_id", None))
            strategy = prefs.entity_strategy_for(own_source or prefs.primary_source())
            clusters = correlate(window_events, prefs, entity_strategy=strategy)
            # Attach/investigate/register is the SHARED ingest path (identical for
            # push receivers): see app/engine/ingest.handle_clusters.
            cluster_stats = await handle_clusters(
                clusters, prefs, cases=self._cases, pipeline=self._pipeline,
                source_surface=SourceSurface.AUTOMATED_SCAN,
            )
            stats.update(cluster_stats)
            # Round-7: band THIS tick's clusters + record the drops, INSIDE the block where
            # ``clusters``/``cluster_stats``/``own_source`` are in scope. Only when a counter
            # sink is wired (byte-identical poll path otherwise); best-effort, never raises.
            if self._noise_sink is not None:
                try:
                    _sink_scale = severity_scale_for_source(own_source)
                    # Round-7 over-count fix: ``clusters``/``cluster_stats`` reflect the FULL
                    # re-scanned look-back window (``correlate`` ran over ``window_events``),
                    # so counting them re-tallies a straggler burst on EVERY subsequent tick
                    # while ``ingested`` is only this tick's cursor delta — inverting the
                    # funnel under sustained PULL load. Scope the cluster-derived bands to the
                    # clusters that contain at least one JUST-ARRIVED event id (this tick's
                    # ``new_events``) so clustered/suppressed/ignored stay per-tick deltas, and
                    # re-derive suppressed/ignored with the SAME predicates ``handle_clusters``
                    # uses (ignored takes priority, mirroring its loop).
                    _new_ids = {e.id for e in new_events}
                    _tick_clusters = [
                        cl for cl in clusters
                        if _new_ids.intersection(cl.member_event_ids)
                    ]
                    noise_clustered = count_clusters_by_band(_tick_clusters, _sink_scale)
                    _tick_ignored = 0
                    _tick_suppressed = 0
                    for _cl in _tick_clusters:
                        if _is_ignored_cluster(_cl, prefs):
                            _tick_ignored += 1
                        elif not passes_suppression(_cl, prefs):
                            _tick_suppressed += 1
                    noise_suppressed = _tick_suppressed
                    noise_ignored = _tick_ignored
                except Exception:  # noqa: BLE001 — counters are advisory, never break a poll
                    pass
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

        # Round-7: ingested = ALL new alerts this tick (new_events + funnel-routed events),
        # banded by the source's declared severity scale. The source instance is re-resolved
        # SEPARATELY here (NOT the if-block-local ``own_source``) so this path is always in
        # scope — an events-only feed (new_events empty, funnel_events non-empty) still tallies
        # its ingested volume. Then fan the assembled delta to the noise sink UNCONDITIONALLY:
        # fail-open, using ONLY the pre-computed dict (never the if-block locals).
        if self._noise_sink is not None:
            noise_ingested = zero_bands()
            try:
                _ns_source = prefs.source_by_id(getattr(self._source, "connector_id", None))
                noise_ingested = count_events_by_band(
                    new_events + funnel_events, severity_scale_for_source(_ns_source)
                )
            except Exception:  # noqa: BLE001 — counters are advisory, never break a poll
                pass
            try:
                await self._noise_sink({
                    "ingested": noise_ingested,
                    "clustered": noise_clustered,
                    "suppressed": noise_suppressed,
                    "ignored": noise_ignored,
                })
            except Exception as exc:  # noqa: BLE001 — the sink must never break a poll cycle
                logger.debug("noise-counter sink failed: %s", exc)

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
