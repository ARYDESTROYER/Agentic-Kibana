"""Elasticsearch / ELK pull connector.

A faithful wrapper of the suite's existing read-only Elasticsearch access. It
implements the :class:`PullConnector` SPI by REUSING the centralised query
builders (:mod:`app.es.querybuilder`) and reproducing — byte-for-byte — the
search body and KQL rendering the legacy ``es_query`` tool emits, so a later
rewire of ``app/tools/es_query.py`` and ``app/engine/poller.py`` onto this
connector is behaviour-preserving (every existing test stays green).

The connector NEVER sees source-native records leaking into the engine: it
normalises every hit to OCSF via :func:`app.ocsf.ecs_to_ocsf`, and the engine
consumes :class:`app.models.RawEvent` projections produced by
``RawEvent.from_hit`` (the same extraction path the legacy code uses).

All ES access flows through :class:`app.es.base.BaseESClient.search_logs`, which
is backed exclusively by the scoped, read-only API key (Non-negotiable #1).
"""

from __future__ import annotations

from typing import Any

from ..config import IndexPattern, Preferences
from ..constants import IndexRole, IngestMode, SourceType
from ..es.base import BaseESClient
from ..es.querybuilder import ids_query, poll_query
from ..models import Cursor, RawEvent
from ..ocsf import OCSFEvent, ecs_to_ocsf
from ..utils import relative_to_millis
from .base import (
    AuthField,
    ConnectionTest,
    ConnectorManifest,
    PullConnector,
    QueryRendering,
    SearchResult,
    StructuredQuery,
)

# Parity constants with ``app/tools/es_query.py`` (keep these in lock-step).
_MAX_SIZE = 200
_DEFAULT_SIZE = 50


def _http_status(exc: Exception) -> int | None:
    """Best-effort HTTP status from an ES driver exception (401/403/...), else None
    (network/TLS errors have no status). Works without importing the driver."""
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "meta", None), "status", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


class ElasticConnector(PullConnector):
    """Pull connector for Elasticsearch / the Elastic (ELK) stack.

    Wraps a :class:`BaseESClient` whose ``search_logs`` is the suite's single,
    read-only path to the log surface. Every method delegates to the existing
    query builders / OCSF mapper so behaviour is identical to the pre-connector
    code path.
    """

    source_type = SourceType.ELASTICSEARCH

    def __init__(
        self,
        es: BaseESClient,
        config: dict[str, Any] | None = None,
        connector_id: str | None = None,
    ) -> None:
        """Store the (already credential-scoped) ES client and init identity.

        ``es`` is constructed elsewhere from ``Secrets``/``Preferences`` (the
        connector does not own credentials); ``config``/``connector_id`` are the
        standard :class:`Connector` identity fields.
        """
        self._es = es
        super().__init__(config, connector_id)

    # Per-source field-mapping/scope keys that this connector's ``config`` may
    # override on top of the global Preferences (so a source whose schema differs
    # from ECS — e.g. Wazuh — reads correctly without changing global prefs).
    _OVERLAY_KEYS = (
        "data_view_pattern", "time_field", "source_ip_field", "user_field",
        "host_field", "rule_field", "rule_name_field", "severity_field",
        "severity_threshold", "in_scope_rules", "excluded_rules",
        # Deep customisability: the message column field + the entity-resolution
        # strategy can be configured per source (default = ECS / global prefs).
        "message_field", "entity_strategy",
    )

    # Per-source field-mapping override keys (Wave 5 / F9). Operators can pin a
    # source's schema explicitly under ``config["field_mappings_extra"]`` (a focused,
    # discoverable subset of the overlay keys — typically suggested by analyze-sample).
    # These take precedence over the top-level config keys above; both fall back to
    # the global Preferences when unset.
    _FIELD_MAPPING_EXTRA_KEYS = (
        "source_ip_field", "user_field", "host_field",
        "message_field", "severity_field", "rule_field", "rule_name_field",
        "time_field",
    )

    def _base_overrides(self) -> dict[str, Any]:
        """Source-level field-mapping/scope overrides (excludes the per-feed split).

        Precedence (highest first): ``config["field_mappings_extra"][k]`` (F9 explicit
        per-source override) → ``config[k]`` (top-level overlay) → global ``prefs``.
        This is the SOURCE layer of the effective mapping; a per-feed override
        (``feed.field_mapping`` / ``feed.message_field``) is layered ON TOP in
        :meth:`_feed_prefs`."""
        overrides = {
            k: self.config[k] for k in self._OVERLAY_KEYS
            if k in self.config and self.config[k] is not None
        }
        extra = self.config.get("field_mappings_extra")
        if isinstance(extra, dict):
            for k in self._FIELD_MAPPING_EXTRA_KEYS:
                v = extra.get(k)
                if v is not None and v != "":
                    overrides[k] = v
        return overrides

    def _effective_prefs(self, prefs: Preferences) -> Preferences:
        """Overlay this source's ``config`` field-mapping/scope keys onto ``prefs``.

        With an empty ``config`` (the default primary Elastic source) this returns
        ``prefs`` unchanged — behaviour is byte-identical to before. With a Wazuh /
        non-ECS source it yields a prefs whose field mapping + index pattern match
        that source, so poll/search/normalisation extract the right fields.

        When the source configures multiple feeds the effective ``data_view_pattern``
        becomes the comma-joined union of all NON-IGNORE feed patterns (ignore feeds
        are EXCLUDED — they are muted), so a single union search reads across every
        live feed; per-feed role/floor tagging happens on the resulting events. This
        union form backs ``search``/``fetch_by_ids``/``test_connection`` + the legacy
        ``data_view_pattern`` fallback; ``poll`` uses per-feed sub-queries (so a
        per-feed ``query``/``severity_floor`` applies)."""
        overrides = self._base_overrides()
        feeds = self._index_patterns()
        live = [f for f in feeds if f.role != IndexRole.IGNORE and f.enabled]
        if live:
            joined = ",".join(f.pattern for f in live)
            if joined:
                overrides["data_view_pattern"] = joined
        return prefs.model_copy(update=overrides) if overrides else prefs

    def _index_patterns(self) -> list[IndexPattern]:
        """The source's configured feeds (canonical, role-coerced).

        Reads ``config["index_patterns"]`` via the shared :class:`IndexPattern`
        parser so the TWO parsers (here + ``SourceInstance.index_patterns``) stay in
        lock-step. Accepts richer Feed dicts, legacy ``{pattern, role,
        auto_correlate}`` dicts and bare strings; an unknown role coerces to ``events``
        (NOT silently — the IndexRole allowlist now includes ``ignore``). Empty when
        not configured (caller uses the single ``data_view_pattern`` with role
        ``events`` — full back-compat)."""
        raw = self.config.get("index_patterns")
        out: list[IndexPattern] = []
        if isinstance(raw, list):
            for item in raw:
                try:
                    if isinstance(item, dict) and item.get("pattern"):
                        out.append(IndexPattern.model_validate(item))
                    elif isinstance(item, str) and item:
                        out.append(IndexPattern(pattern=item))
                except Exception:  # noqa: BLE001 — skip a malformed entry
                    continue
        return out

    def _poll_feeds(self) -> list[IndexPattern]:
        """The feeds ``poll`` reads — enabled, NON-ignore. Empty when the source has
        no feeds configured; ``poll`` then takes the legacy single-union path over
        ``_effective_prefs(prefs).data_view_pattern`` (byte-identical to before)."""
        return [f for f in self._index_patterns()
                if f.enabled and f.role != IndexRole.IGNORE]

    def _feed_prefs(self, prefs: Preferences, feed: IndexPattern) -> Preferences:
        """Per-feed effective prefs: source overrides + the feed's own pattern, field
        mapping and message field.

        Effective mapping = ``{**global, **source.field_mapping, **feed.field_mapping}``;
        effective message_field = ``feed.message_field or source.message_field or
        global`` — so a feed can pin its own schema while inheriting the rest."""
        overrides = self._base_overrides()
        if feed.field_mapping:
            for k, v in feed.field_mapping.items():
                if v is not None and v != "":
                    overrides[k] = v
        if feed.message_field:
            overrides["message_field"] = feed.message_field
        overrides["data_view_pattern"] = feed.pattern
        return prefs.model_copy(update=overrides)

    def _role_for_index(self, index: str) -> str:
        """Role of the configured feed an event's ``_index`` belongs to.

        Matches the event's index against each configured feed pattern (``*`` glob);
        the FIRST alerts-role feed that matches wins (so an alerts feed is honoured
        even if an events feed also matches). Ignore feeds are never read so they do
        not appear here. Defaults to ``events``."""
        import fnmatch

        feeds = self._index_patterns()
        if not feeds:
            return "events"
        for f in feeds:
            if f.role == IndexRole.ALERTS and fnmatch.fnmatch(index, f.pattern):
                return "alerts"
        return "events"

    def _feed_for_index(self, index: str) -> IndexPattern | None:
        """The most-specific configured feed an event's ``_index`` matches.

        Longest-pattern-wins precedence (a narrow ``host-secure-*`` feed beats a broad
        ``host-*`` feed) so an IGNORE sub-index carved out of a broad events feed is
        attributed to the IGNORE feed, and a per-feed ``severity_floor`` is applied
        from the right feed. Returns None when nothing matches (back-compat)."""
        import fnmatch

        best: IndexPattern | None = None
        best_len = -1
        for f in self._index_patterns():
            if f.pattern and fnmatch.fnmatch(index, f.pattern) and len(f.pattern) > best_len:
                best, best_len = f, len(f.pattern)
        return best

    def _tag_events(
        self, events: list[RawEvent], feed: IndexPattern | None = None
    ) -> list[RawEvent]:
        """Stamp source/feed provenance + per-feed role + severity_floor onto events.

        ``source_id``/``source_name`` identify the originating source (UI filter).
        When ``feed`` is given (the per-feed poll path) the event is attributed to
        THAT feed; otherwise (the union search/poll path) the matching feed is resolved
        by index (longest-pattern-wins) AND an event whose most-specific feed is an
        IGNORE feed is DROPPED (a broad pattern reading an ignore carve-out is muted).
        ``index_role`` drives alerts auto-forward; ``feed_id`` records the feed;
        ``auto_investigate_eligible`` is FALSE when the event is below the feed's
        ``severity_floor`` — such an event is STILL returned (so it registers a
        candidate + live-tail) but its cluster will not auto-forward (#4, never
        dropped). All no-ops when nothing is configured."""
        name = self.config.get("display_name") or self.connector_id
        out: list[RawEvent] = []
        for ev in events:
            ev.source_id = self.connector_id
            ev.source_name = name
            f = feed if feed is not None else self._feed_for_index(ev.index)
            if f is not None:
                # Union path: drop an event owned by an ignore feed (carve-out mute).
                if feed is None and f.role == IndexRole.IGNORE:
                    continue
                ev.feed_id = f.id
                ev.index_role = f.role.value if f.role != IndexRole.IGNORE else "events"
                floor = f.severity_floor
                if floor is not None and ev.severity < float(floor):
                    ev.auto_investigate_eligible = False
            else:
                ev.index_role = self._role_for_index(ev.index)
            out.append(ev)
        return out

    # --------------------------------------------------------------------- #
    # Wizard-facing self-description
    # --------------------------------------------------------------------- #
    @classmethod
    def manifest(cls) -> ConnectorManifest:
        """Static, credential-free self-description driving discovery + wizard.

        Exposes EVERY field the first-run wizard needs to configure an Elastic
        source: connection/auth in ``auth_fields`` (secrets flagged so the UI
        only ever shows ``configured ✓``), and the operator field mapping in
        ``config_fields`` (all defaulting to ECS so a stock ELK deployment needs
        no field edits).
        """
        return ConnectorManifest(
            source_type=cls.source_type,
            display_name="Elasticsearch / ELK",
            category="siem",
            description=(
                "Poll a read-only, scoped Elasticsearch log index pattern on a "
                "durable cursor and run ad-hoc structured searches. Reads only; "
                "the upstream pipeline is never modified."
            ),
            ingest_modes=[IngestMode.PULL],
            query_language="kuery",
            capabilities=["poll", "search", "fetch_by_ids", "test", "browse"],
            docs_url="https://www.elastic.co/guide/en/elasticsearch/reference/current/security-api-create-api-key.html",
            setup_help=(
                "## Connect Elasticsearch (read-only)\n"
                "1. **URL** — the Elasticsearch HTTP API base URL (e.g. "
                "`https://elasticsearch:9200`). On the deploy network use the container "
                "name.\n"
                "2. **Create a READ-ONLY, scoped API key** — never use `kibana_system` "
                "or the `elastic` superuser (non-negotiable #1). In Kibana Dev Tools run "
                "the snippet on the API-key field: it grants ONLY `read` on your log "
                "index pattern.\n"
                "3. **Index pattern** — set the data view the agent reads (e.g. "
                "`all-logs-*`). Comma-separated patterns are allowed.\n"
                "4. **CA cert** — paste the PEM (or a mounted path) if your cluster uses "
                "a private CA; leave blank for a public CA.\n"
                "5. **Test connection** — a correctly-scoped read-only key verifies via a "
                "cheap scoped read (it cannot do cluster monitor — that's expected)."
            ),
            auth_fields=[
                AuthField(
                    key="es_url",
                    label="Elasticsearch URL",
                    type="string",
                    required=True,
                    placeholder="https://elasticsearch:9200",
                    help=(
                        "Base URL of the Elasticsearch HTTP API. Use the in-cluster "
                        "container name on the deploy network (e.g. "
                        "https://elasticsearch:9200)."
                    ),
                    help_link="https://www.elastic.co/guide/en/elasticsearch/reference/current/rest-apis.html",
                    group="Connection",
                ),
                AuthField(
                    key="es_api_key",
                    label="API key (read-only)",
                    type="password",
                    secret=True,
                    help=(
                        "A READ-ONLY API key scoped to the log index pattern only "
                        "(never kibana_system or the elastic superuser). Stored in "
                        "the secret store; shown only as configured."
                    ),
                    help_link="https://www.elastic.co/guide/en/elasticsearch/reference/current/security-api-create-api-key.html",
                    help_code=(
                        "POST /_security/api_key\n"
                        "{\n"
                        '  "name": "tlsoc-readonly",\n'
                        '  "role_descriptors": {\n'
                        '    "tlsoc_ro": {\n'
                        '      "cluster": [],\n'
                        '      "indices": [\n'
                        '        { "names": ["all-logs-*"], "privileges": ["read", "view_index_metadata"] }\n'
                        "      ]\n"
                        "    }\n"
                        "  }\n"
                        "}"
                    ),
                    help_code_language="json",
                    group="Connection",
                ),
                AuthField(
                    key="es_ca_cert",
                    label="CA certificate (PEM)",
                    type="textarea",
                    help=(
                        "PEM-encoded CA certificate (or a path mounted into the "
                        "container, e.g. /certs/ca/ca.crt) used to verify the TLS "
                        "connection to Elasticsearch. Leave blank for a public CA."
                    ),
                    group="Connection",
                ),
                AuthField(
                    key="es_verify_certs",
                    label="Verify TLS certificates",
                    type="bool",
                    default=True,
                    help=(
                        "Verify the Elasticsearch server certificate against the CA. "
                        "Disable ONLY for a throwaway lab with self-signed certs."
                    ),
                    group="Connection",
                ),
            ],
            config_fields=[
                AuthField(
                    key="data_view_pattern",
                    label="Log index pattern",
                    type="string",
                    required=True,
                    default="all-logs-*",
                    placeholder="all-logs-*",
                    help=(
                        "The index pattern / data view the agent reads (read-only). "
                        "Comma-separated patterns are allowed (e.g. "
                        "'fosstlsoc-logs-*,all-logs-*')."
                    ),
                    help_link="https://www.elastic.co/guide/en/kibana/current/data-views.html",
                    group="Field mapping",
                ),
                AuthField(
                    key="time_field",
                    label="Timestamp field",
                    type="string",
                    default="@timestamp",
                    help="Event time field. Drives the durable cursor and sorting.",
                    group="Field mapping",
                ),
                AuthField(
                    key="source_ip_field",
                    label="Source IP field",
                    type="string",
                    default="source.ip",
                    help="Field holding the source/client IP used for correlation.",
                    group="Field mapping",
                ),
                AuthField(
                    key="user_field",
                    label="User field",
                    type="string",
                    default="user.name",
                    help="Field holding the acting user/account name.",
                    group="Field mapping",
                ),
                AuthField(
                    key="host_field",
                    label="Host field",
                    type="string",
                    default="host.name",
                    help="Field holding the affected host/asset name.",
                    group="Field mapping",
                ),
                AuthField(
                    key="rule_field",
                    label="Rule / module field",
                    type="string",
                    default="event.module",
                    help=(
                        "Per-event rule identity used for scope, correlation and "
                        "the auto-forward allowlist (e.g. event.module)."
                    ),
                    group="Field mapping",
                ),
                AuthField(
                    key="rule_name_field",
                    label="Rule name field",
                    type="string",
                    default="rule.name",
                    help="Human-readable detection/rule name shown in findings.",
                    group="Field mapping",
                ),
                AuthField(
                    key="severity_field",
                    label="Severity field",
                    type="string",
                    default="event.severity",
                    help=(
                        "Numeric severity field. Layer-1 of the cost gate filters "
                        "below-threshold events at query time."
                    ),
                    group="Field mapping",
                ),
            ],
        )

    # --------------------------------------------------------------------- #
    # PullConnector SPI
    # --------------------------------------------------------------------- #
    async def ping(self) -> bool:
        """Health probe — delegates to the underlying ES client."""
        return await self._es.ping()

    async def poll(
        self, prefs: Preferences, cursor: Cursor, from_millis: int
    ) -> list[RawEvent]:
        """Fetch one in-scope polling batch at/after the cursor (oldest first).

        Splits the read into PER-FEED sub-queries (Wave 6) so each feed's own
        ``query`` (a connector-native, operator-TRUSTED filter) and ``severity_floor``
        apply, and each event is attributed to its feed. For a legacy/un-fed source
        this is ONE sub-query over ``data_view_pattern`` — byte-identical to before
        (same ``poll_query`` body, same ``from_hit`` projection, same oldest-first
        sort). IGNORE feeds are excluded (muted); a below-floor event is still
        returned (NEVER dropped) but flagged ``auto_investigate_eligible=False``.

        The poller owns cursor advancement + dedup — the connector only fetches. The
        ``cursor``/``from_millis`` lower bound is applied IDENTICALLY to every feed's
        body so a single shared cursor (a feed group of equal interval) never skips."""
        feeds = self._poll_feeds()
        if not feeds:
            # Legacy / un-fed source: ONE union read over the effective data view —
            # byte-identical to the pre-Wave-6 connector.
            prefs = self._effective_prefs(prefs)
            body = poll_query(prefs, cursor, from_millis)
            resp = await self._es.search_logs(prefs.data_view_pattern, body)
            hits = resp.get("hits", {}).get("hits", [])
            return self._tag_events([RawEvent.from_hit(h, prefs) for h in hits])
        out: list[RawEvent] = []
        for feed in feeds:
            out.extend(await self.poll_feed(prefs, feed, cursor, from_millis))
        return out

    def feeds(self) -> list[IndexPattern]:
        """The enabled, NON-ignore feeds this connector polls (Wave 6).

        The poller iterates these to drive a PER-FEED durable cursor (so a fast alerts
        feed and a slow events feed never share/skip a cursor, #4). Empty for a
        legacy/un-fed source — the poller then takes the single-cursor union path,
        byte-identical to before."""
        return self._poll_feeds()

    async def poll_feed(
        self, prefs: Preferences, feed: IndexPattern, cursor: Cursor, from_millis: int
    ) -> list[RawEvent]:
        """Fetch one in-scope polling batch FOR A SINGLE FEED (oldest first).

        The feed's own pattern + field mapping + message field + ``query`` +
        ``severity_floor`` apply; each event is attributed to ``feed``. Backs the
        poller's per-feed cursor loop. ``poll`` (the union) is a thin wrapper that
        concatenates ``poll_feed`` over every feed with a shared cursor.

        A hit is KEPT only when THIS feed is its longest-pattern ("most specific")
        owner — so when a broad events feed (``logs-host-*``) overlaps a narrower
        IGNORE feed (``logs-host-noise*``), the noise sub-index is read by the broad
        feed but DROPPED here (it belongs to the ignore feed), and no event is ever
        read twice. With a single feed (or no overlap) every hit is kept."""
        fp = self._feed_prefs(prefs, feed)
        body = poll_query(fp, cursor, from_millis)
        self._apply_feed_query(body, feed)
        resp = await self._es.search_logs(fp.data_view_pattern, body)
        hits = resp.get("hits", {}).get("hits", [])
        kept = [h for h in hits if self._owns_index(feed, str(h.get("_index", "")))]
        return self._tag_events([RawEvent.from_hit(h, fp) for h in kept], feed=feed)

    def _owns_index(self, feed: IndexPattern, index: str) -> bool:
        """True when ``feed`` is the most-specific (longest-pattern) feed matching
        ``index`` — i.e. this feed OWNS the index (longest-pattern-wins). Used to
        partition overlapping feed reads so an index is read exactly once and an
        IGNORE carve-out of a broad pattern is attributed to (and dropped by) the
        ignore feed. True when no other feed matches (single-feed / no overlap)."""
        owner = self._feed_for_index(index)
        return owner is None or owner.id == feed.id

    @staticmethod
    def _apply_feed_query(body: dict[str, Any], feed: IndexPattern) -> None:
        """Append the feed's operator-authored ``query`` as a connector-native filter.

        The query is OPERATOR config (TRUSTED, #9 — not log-derived; still never
        interpolated into a prompt). It is added as a ``query_string`` filter so a
        broad feed pattern can be narrowed per feed (e.g. ``event.category:network``).
        Best-effort: a blank query is a no-op (the body is unchanged)."""
        q = (feed.query or "").strip()
        if not q:
            return
        flt = body.setdefault("query", {}).setdefault("bool", {}).setdefault("filter", [])
        flt.append({"query_string": {"query": q}})

    async def search(self, prefs: Preferences, query: StructuredQuery) -> SearchResult:
        """Run a structured ad-hoc search (backs the ``es_query`` tool).

        Builds the SAME ES body and KQL rendering as ``app/tools/es_query.py``:
        term filters for ip/user/host/rule via the configured field names, a
        ``severity_field >= severity_gte`` range, a ``contains`` ``multi_match``
        over ``[rule_name_field, message, event.original, event.action]``, and a
        time range (``gte``/``lte`` epoch millis), sorted descending on the time
        field, size capped at 200 (default 50). An ``ids`` query short-circuits
        to ``fetch_by_ids`` parity. The empty-filter case renders KQL ``"*"``.
        """
        prefs = self._effective_prefs(prefs)
        size = min(int(query.size or _DEFAULT_SIZE), _MAX_SIZE)

        # ids short-circuit — identical to es_query's `if ids:` branch.
        if query.ids:
            return await self.fetch_by_ids(prefs, list(query.ids), size=size)

        filters: list[dict[str, Any]] = []
        kql_parts: list[str] = []
        for val, field in (
            (query.ip, prefs.source_ip_field),
            (query.user, prefs.user_field),
            (query.host, prefs.host_field),
            (query.rule, prefs.rule_field),
        ):
            if val not in (None, ""):
                filters.append({"term": {field: val}})
                kql_parts.append(f'{field} : "{val}"')

        sev = query.severity_gte
        if sev not in (None, ""):
            filters.append({"range": {prefs.severity_field: {"gte": sev}}})
            kql_parts.append(f"{prefs.severity_field} >= {sev}")

        contains = query.contains
        if contains:
            fields = [prefs.rule_name_field, "message", "event.original", "event.action"]
            filters.append({"multi_match": {"query": contains, "fields": fields}})
            kql_parts.append(f'message : "*{contains}*"')

        time_from = query.time_from if query.time_from is not None else "now-24h"
        time_to = query.time_to if query.time_to is not None else "now"
        from_millis = relative_to_millis(time_from)
        to_millis = relative_to_millis(time_to)
        filters.append(
            {"range": {prefs.time_field: {"gte": from_millis, "lte": to_millis, "format": "epoch_millis"}}}
        )

        order = "desc" if query.sort_desc else "asc"
        body = {
            "size": size,
            "sort": [{prefs.time_field: {"order": order}}],
            "query": {"bool": {"filter": filters}},
        }
        resp = await self._es.search_logs(prefs.data_view_pattern, body)
        kql = " and ".join(kql_parts) if kql_parts else "*"
        return self._to_result(resp, prefs, kql, time_from, time_to)

    async def fetch_by_ids(
        self, prefs: Preferences, ids: list[str], size: int
    ) -> SearchResult:
        """Fetch specific events by document id (Surface-2 row click).

        Mirrors ``es_query``'s ids branch: an ``ids_query`` body and the KQL
        rendering ``_id in ("a", "b")`` with no time bounds.
        """
        prefs = self._effective_prefs(prefs)
        body = ids_query(list(ids), size=size)
        kql = "_id in (%s)" % ", ".join(f'"{i}"' for i in ids)
        resp = await self._es.search_logs(prefs.data_view_pattern, body)
        return self._to_result(resp, prefs, kql, None, None)

    # --------------------------------------------------------------------- #
    # Normalisation + helpers
    # --------------------------------------------------------------------- #
    def to_ocsf(self, raw: dict[str, Any], prefs: Preferences) -> OCSFEvent:
        """Map one ES hit (``{_id,_index,_source}``) to a canonical OCSFEvent.

        Delegates to the existing ECS→OCSF mapper, stamping this connector's
        ``source_type`` and ``connector_id`` for provenance.
        """
        prefs = self._effective_prefs(prefs)
        return ecs_to_ocsf(
            raw, prefs, source_type=self.source_type, connector_id=self.connector_id
        )

    async def test_connection(self, prefs: Preferences) -> ConnectionTest:
        """Validate a READ-ONLY, log-scoped key the right way.

        A correctly-scoped read-only key (read on the index pattern, no cluster
        monitor) CANNOT do HEAD / (ping). So we do NOT gate on ping(): we run the
        cheap scoped sample read FIRST and treat HTTP 200 (any/zero hits) as success,
        reporting mode="read_only". ping() is only an EXTRA signal (cluster_monitor
        true/false), never the pass/fail gate. We return ok=False only when the scoped
        read itself fails — auth (401/403 on the index) or network/TLS."""
        prefs = self._effective_prefs(prefs)
        pattern = prefs.data_view_pattern
        # 1) Authoritative: a cheap, scoped, read-only sample read.
        try:
            body = poll_query(prefs, Cursor(), 0, batch_size=1)
            resp = await self._es.search_logs(pattern, body)
        except Exception as exc:  # noqa: BLE001
            status = _http_status(exc)
            if status in (401, 403):
                msg = (f"Read access denied on '{pattern}' (HTTP {status}). The API key "
                       f"needs the 'read' privilege on that index pattern.")
            else:
                msg = (f"Could not reach Elasticsearch (network/TLS) while reading "
                       f"'{pattern}': {exc}")
            return ConnectionTest(ok=False, message=msg,
                                  detail={"data_view": pattern, "error": str(exc)})
        total = resp.get("hits", {}).get("total", {})
        count = total.get("value") if isinstance(total, dict) else (
            total if isinstance(total, int) else None)
        n = count if count is not None else 0
        # 2) OPTIONAL extra signal: can this key also reach the cluster root (HEAD /)?
        #    A scoped read-only key cannot — that's expected, NOT a failure.
        try:
            cluster_monitor = bool(await self._es.ping())
        except Exception:  # noqa: BLE001
            cluster_monitor = False
        if cluster_monitor:
            mode = "full"
            message = (f"Connection verified — {n} event(s) readable in '{pattern}'; "
                       f"cluster-monitor privilege present.")
        else:
            mode = "read_only"
            message = (f"Read-only access verified — logs are ingesting successfully "
                       f"({n} events readable in '{pattern}'). Cluster-monitor privilege "
                       f"not granted (expected for a read-only key).")
        return ConnectionTest(ok=True, message=message, mode=mode, sample_count=count,
                              cluster_monitor=cluster_monitor, detail={"data_view": pattern})

    def _to_result(
        self,
        resp: dict[str, Any],
        prefs: Preferences,
        kql: str,
        time_from: str | None,
        time_to: str | None,
    ) -> SearchResult:
        """Wrap a native ES response in a :class:`SearchResult` with provenance."""
        hits = resp.get("hits", {}).get("hits", [])
        total = resp.get("hits", {}).get("total", {})
        total_val = total.get("value", len(hits)) if isinstance(total, dict) else len(hits)
        events = self._tag_events([RawEvent.from_hit(h, prefs) for h in hits])
        rendering = QueryRendering(
            query=kql,
            language="kuery",
            data_view=prefs.data_view_pattern,
            time_from=time_from,
            time_to=time_to,
        )
        return SearchResult(events=events, total=total_val, rendering=rendering, raw=resp)
