"""Multi-source poller fan-out (Round 4 #2/#3 root-cause fix).

Historically ``AppState`` wired ONE :class:`~app.engine.poller.Poller` to the single
``primary`` PULL source, so every other enabled PULL source was silently never
polled / correlated / triaged. :class:`PollerManager` fixes that by owning **N**
per-source :class:`Poller` children — one per enabled PULL source — while preserving
byte-identical single-source behaviour when 0 or 1 PULL source is configured.

Design (the fan-out + cursor-collision contract):
  * The PRIMARY child IS ``state.log_source`` (the connector ``state`` already built
    + owns, via ``_owned_log_client``). The manager never rebuilds it and never owns
    its client — so the sole-source path is byte-identical and the read/browse/chat
    surface (``state.log_source``) stays the primary connector.
  * NON-primary PULL sources get their OWN connector built exactly like
    ``state._build_log_source`` — ``state.es_client_for_source(src)`` (which forces the
    mgmt key to None, #1) + ``connector_id=src.id`` (so per-source
    auto_correlate/ignore/severity_floor gates work) — and every OWNED client is
    tracked + closed on rebuild/stop (no connection leak over N sources).
  * Each :class:`Poller` already fans out over its own feeds on
    ``f"{source.id}:{feed.id}"`` cursors. For an UN-FED source (only
    ``data_view_pattern``) the legacy union path keys the cursor ``"primary"`` — so
    the manager gives every NON-primary un-fed source a DISTINCT
    ``f"{source.id}:primary"`` key (via ``Poller._legacy_cursor_key``) while the true
    primary keeps ``"primary"`` (no migration, #4).
  * Children SHARE ``state``'s ONE pipeline/gateway/cases/audit/cursor_store (#6) —
    the manager never mints a per-source gateway or pipeline.
  * All children are gated on the SAME flags ``Poller._run`` checks
    (polling_enabled / setup_complete / not kill_switch / not demo_active); a burst of
    sources is bounded by ``caps.max_concurrent``; a per-cluster-signature in-flight
    guard stops the same signature being investigated twice in one tick.

The manager IS ``state.poller`` and proxies the external lifecycle contract
(``start()`` / ``stop()`` / ``poll_once(prefs)`` / ``_source`` / ``_attach``) to the
primary child (or, for ``poll_once``, aggregates across all children).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from ..config import Preferences
from ..connectors.base import PullConnector
from ..constants import IngestMode
from ..engine.poller import Poller

logger = logging.getLogger("tlsoc.engine.poller_manager")

# Numeric stats keys aggregated (summed) across per-source pollers into one dict.
_SUM_KEYS = (
    "polled", "new", "clusters", "investigated", "candidates", "attached",
    "window_events", "cross_source_linked",
)


class PollerManager:
    """Owns N per-source :class:`Poller` children and drives them as one poller."""

    def __init__(self, state: "AppState") -> None:  # noqa: F821 — avoid import cycle
        self._state = state
        self._get_prefs: Callable[[], Preferences] = state.get_prefs
        # The primary child (built from state.log_source) + the non-primary children.
        # The primary is rebuilt implicitly by state.rebuild_log_source (which re-points
        # ``primary._source``); the non-primary set is rebuilt by ``rebuild()``.
        self._primary: Poller = self._build_primary()
        self._children: list[Poller] = []
        # ES clients this manager OWNS (non-primary sources with per-source overrides).
        # Closed on rebuild()/stop(); the primary's owned client is owned by state.
        self._owned_clients: list = []
        self._task: asyncio.Task | None = None
        self._running = False
        self.rebuild()

    # ------------------------------------------------------------------ #
    # External compatibility surface (mirrors the single Poller contract).
    # ------------------------------------------------------------------ #
    @property
    def _source(self):
        """The PRIMARY connector — kept for callers that read ``poller._source``."""
        return self._primary._source

    @_source.setter
    def _source(self, value) -> None:
        # state.rebuild_log_source assigns ``poller._source = self.log_source`` — route
        # that onto the primary child so the read/browse surface stays consistent.
        self._primary._source = value

    async def _attach(self, existing, cluster) -> None:
        """Proxy the attach helper (used by tests + adjacent code) to the primary."""
        await self._primary._attach(existing, cluster)

    # ------------------------------------------------------------------ #
    # Construction / rebuild.
    # ------------------------------------------------------------------ #
    def _build_primary(self) -> Poller:
        """The primary child wraps ``state.log_source`` (state owns its client)."""
        st = self._state
        return Poller(
            st.es, st._real_cases, st.cursor_store, st._real_audit,
            st._real_pipeline, st.get_prefs, source=st.log_source,
        )

    def _pull_sources(self, prefs: Preferences) -> list:
        """Every enabled PULL source (registry class check is authoritative; also honor
        the config-declared ``ingest_mode==PULL``). Receivers are SKIPPED — they stay
        handled by ``state._start_receivers`` (never double-handled)."""
        from ..connectors.registry import get_registry

        reg = get_registry()
        out: list = []
        for src in prefs.sources:
            if not src.enabled:
                continue
            if reg.is_receiver(src.source_type):
                continue  # PUSH — handled by _start_receivers, never here
            is_pull = reg.is_pull(src.source_type) or (src.ingest_mode == IngestMode.PULL)
            if is_pull:
                out.append(src)
        return out

    def _build_child_for(self, src) -> Poller | None:
        """Build a NON-primary per-source Poller exactly like ``state._build_log_source``
        (per-source client via ``es_client_for_source`` — forces mgmt key None, #1 — +
        ``connector_id=src.id``). Tracks any OWNED client for close. Returns None on a
        build failure (isolated + logged, mirroring ``_start_receivers``)."""
        from ..connectors.elastic import ElasticConnector
        from ..connectors.opensearch import OpenSearchConnector
        from ..connectors.wazuh import WazuhConnector
        from ..constants import SourceType

        st = self._state
        es_client, owned = st.es_client_for_source(src)
        if owned:
            self._owned_clients.append(es_client)
        cfg = {**(src.config or {})}
        if src.display_name:
            cfg.setdefault("display_name", src.display_name)
        cid = src.id
        if src.source_type == SourceType.OPENSEARCH:
            connector = OpenSearchConnector(es_client, config=cfg, connector_id=cid)
        elif src.source_type == SourceType.WAZUH:
            connector = WazuhConnector(es_client, config=cfg, connector_id=cid)
        else:
            connector = ElasticConnector(es_client, config=cfg, connector_id=cid)
        child = Poller(
            es_client, st._real_cases, st.cursor_store, st._real_audit,
            st._real_pipeline, st.get_prefs, source=connector,
        )
        # Un-fed (no feeds) non-primary source → legacy union path would key the cursor
        # ``"primary"`` and stomp the shared doc. Give it a DISTINCT key (#4).
        if not _connector_has_feeds(connector):
            child._legacy_cursor_key = f"{src.id}:primary"
        return child

    def rebuild(self) -> None:
        """(Re)build the NON-primary children from the CURRENT prefs. Closes any
        previously-owned clients first (no leak). The primary child is left to
        ``state.rebuild_log_source`` (it re-points ``_source``); we rebuild it here too
        so ``self._state.log_source`` is always the live primary connector."""
        # Close previously-owned non-primary clients.
        self._close_owned()
        self._primary = self._build_primary()
        self._children = []
        prefs = self._get_prefs()
        pull = self._pull_sources(prefs)
        # The primary source (if any) is already served by ``self._primary`` — skip it
        # in the non-primary fan-out so the same physical index is never double-polled.
        primary_src = prefs.primary_source()
        primary_id = getattr(primary_src, "id", None)
        for src in pull:
            if primary_id is not None and src.id == primary_id:
                continue
            try:
                child = self._build_child_for(src)
                if child is not None:
                    self._children.append(child)
            except Exception as exc:  # noqa: BLE001 — one bad source must not break fan-out
                logger.error("Could not build poller for source %s (%s): %s",
                             getattr(src, "id", "?"), getattr(src, "source_type", "?"), exc)

    def _all_pollers(self) -> list[Poller]:
        return [self._primary, *self._children]

    def _close_owned(self) -> None:
        for client in self._owned_clients:
            try:
                if client is not self._state.es:
                    self._state._schedule_close(client)
            except Exception:  # noqa: BLE001
                pass
        self._owned_clients = []

    # ------------------------------------------------------------------ #
    # Polling.
    # ------------------------------------------------------------------ #
    async def poll_once(self, prefs: Preferences | None = None) -> dict[str, Any]:
        """Fan out ONE poll cycle across every per-source poller and aggregate the
        stats into a single dict (same shape a single Poller returns). Each source is
        isolated (one failure is logged + skipped, never aborting the others). A
        fan-out semaphore bounds concurrency (``caps.max_concurrent``); an in-flight
        cluster-signature guard is shared across children for this tick."""
        prefs = prefs or self._get_prefs()
        pollers = self._all_pollers()
        # Single-poll fast path: 0/1 poller behaves BYTE-IDENTICALLY to the old single
        # Poller (no semaphore/guard overhead, same return object).
        if len(pollers) <= 1:
            return await self._primary.poll_once(prefs)

        limit = max(1, int(getattr(prefs.caps, "max_concurrent", 3)))
        sem = asyncio.Semaphore(limit)
        # Shared per-tick in-flight guard: stops the SAME cluster signature being
        # investigated concurrently by two sources' pipelines in one tick.
        guard = _install_inflight_guard(self._state._real_pipeline)

        async def _run_one(p: Poller) -> dict[str, Any] | None:
            async with sem:
                try:
                    return await p.poll_once(prefs)
                except Exception as exc:  # noqa: BLE001 — isolate one source's failure
                    logger.exception(
                        "poll_once failed for source %s (fan-out continues): %s",
                        getattr(getattr(p, "_source", None), "connector_id", "?"), exc,
                    )
                    return None

        try:
            results = await asyncio.gather(*[_run_one(p) for p in pollers])
        finally:
            guard.restore()

        agg: dict[str, Any] = {k: 0 for k in _SUM_KEYS}
        for res in results:
            if not res:
                continue
            for k in _SUM_KEYS:
                if k in res:
                    agg[k] = agg.get(k, 0) + res[k]
        return agg

    # ------------------------------------------------------------------ #
    # Background loop (gated exactly like Poller._run).
    # ------------------------------------------------------------------ #
    async def _run(self) -> None:
        self._running = True
        logger.info("PollerManager loop started")
        while self._running:
            prefs = self._get_prefs()
            interval = max(5, prefs.poll_interval_seconds)
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
        self._close_owned()


def _connector_has_feeds(connector) -> bool:
    """True when the connector exposes any (enabled, non-ignore) feed — i.e. it takes
    the per-feed cursor path, not the legacy union path. Defensive: never raises."""
    getter = getattr(connector, "feeds", None)
    if getter is None:
        return False
    try:
        return bool(list(getter()))
    except Exception:  # noqa: BLE001
        return False


class _InflightGuard:
    """Wraps ``pipeline.investigate_cluster`` for one manager tick so the SAME cluster
    signature is not investigated concurrently by two per-source pollers. A signature
    already in-flight this tick is skipped (returns None) rather than double-run. The
    original method is restored after the tick (so the shared pipeline is untouched
    outside a fan-out tick). This adds NO status/close logic (#3): it only de-dups the
    investigation call — a skipped duplicate has already been correlated by the same
    signature, so nothing is lost."""

    def __init__(self, pipeline) -> None:
        self._pipeline = pipeline
        self._orig = getattr(pipeline, "investigate_cluster", None)
        self._inflight: set[str] = set()

    def install(self) -> "_InflightGuard":
        orig = self._orig
        if orig is None:
            return self

        async def _wrapped(cluster, *args, **kwargs):
            sig = getattr(cluster, "signature", None)
            if sig is not None and sig in self._inflight:
                logger.debug("skipping duplicate in-flight investigation for %s", sig)
                return None
            if sig is not None:
                self._inflight.add(sig)
            try:
                return await orig(cluster, *args, **kwargs)
            finally:
                if sig is not None:
                    self._inflight.discard(sig)

        self._pipeline.investigate_cluster = _wrapped  # type: ignore[assignment]
        return self

    def restore(self) -> None:
        if self._orig is not None:
            self._pipeline.investigate_cluster = self._orig  # type: ignore[assignment]


def _install_inflight_guard(pipeline) -> _InflightGuard:
    return _InflightGuard(pipeline).install()
