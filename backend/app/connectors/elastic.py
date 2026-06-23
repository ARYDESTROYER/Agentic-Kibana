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

from ..config import Preferences
from ..constants import IngestMode, SourceType
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

    def _effective_prefs(self, prefs: Preferences) -> Preferences:
        """Overlay this source's ``config`` field-mapping/scope keys onto ``prefs``.

        With an empty ``config`` (the default primary Elastic source) this returns
        ``prefs`` unchanged — behaviour is byte-identical to before. With a Wazuh /
        non-ECS source it yields a prefs whose field mapping + index pattern match
        that source, so poll/search/normalisation extract the right fields.

        When the source configures multiple ``index_patterns`` (events/alerts roles)
        the effective ``data_view_pattern`` becomes the comma-joined union of ALL
        configured patterns, so a single poll/search reads across every pattern;
        per-pattern role tagging happens on the resulting events."""
        overrides = {
            k: self.config[k] for k in self._OVERLAY_KEYS
            if k in self.config and self.config[k] is not None
        }
        patterns = self._index_patterns()
        if patterns:
            joined = ",".join(p["pattern"] for p in patterns)
            if joined:
                overrides["data_view_pattern"] = joined
        return prefs.model_copy(update=overrides) if overrides else prefs

    def _index_patterns(self) -> list[dict[str, str]]:
        """The source's configured index patterns + roles (normalised dicts).

        Reads ``config["index_patterns"]`` (list of ``{pattern, role}`` or bare
        strings). Empty when not configured (caller uses the single
        ``data_view_pattern`` with role ``events`` — full back-compat)."""
        raw = self.config.get("index_patterns")
        out: list[dict[str, str]] = []
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict) and item.get("pattern"):
                    role = str(item.get("role") or "events").lower()
                    role = role if role in ("events", "alerts") else "events"
                    out.append({"pattern": str(item["pattern"]), "role": role})
                elif isinstance(item, str) and item:
                    out.append({"pattern": item, "role": "events"})
        return out

    def _role_for_index(self, index: str) -> str:
        """Role of the configured pattern an event's ``_index`` belongs to.

        Matches the event's index against each configured pattern (``*`` glob); the
        FIRST alerts-role pattern that matches wins (so an alerts pattern is honoured
        even if an events pattern also matches). Defaults to ``events``."""
        import fnmatch

        patterns = self._index_patterns()
        if not patterns:
            return "events"
        for p in patterns:
            if p["role"] == "alerts" and fnmatch.fnmatch(index, p["pattern"]):
                return "alerts"
        return "events"

    def _tag_events(self, events: list[RawEvent]) -> list[RawEvent]:
        """Stamp source provenance + per-pattern role onto each RawEvent.

        ``source_id``/``source_name`` identify the originating source (UI filter);
        ``index_role`` is the role of the pattern the event's index belongs to, so
        ``handle_clusters`` can auto-forward alerts-role clusters. No-op fields when
        nothing is configured (back-compat)."""
        name = self.config.get("display_name") or self.connector_id
        for ev in events:
            ev.source_id = self.connector_id
            ev.source_name = name
            ev.index_role = self._role_for_index(ev.index)
        return events

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

        Reproduces ``Poller.poll_once``'s read EXACTLY: the body is built by
        ``poll_query(prefs, cursor, cold_start_from_millis)`` and executed via
        ``search_logs(prefs.data_view_pattern, body)``; each hit is projected to
        a :class:`RawEvent` by the same ``RawEvent.from_hit`` path. The poller
        owns cursor advancement and dedup — the connector only fetches.
        """
        prefs = self._effective_prefs(prefs)
        body = poll_query(prefs, cursor, from_millis)
        resp = await self._es.search_logs(prefs.data_view_pattern, body)
        hits = resp.get("hits", {}).get("hits", [])
        return self._tag_events([RawEvent.from_hit(h, prefs) for h in hits])

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
