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
            capabilities=["poll", "search", "fetch_by_ids", "test"],
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
        body = poll_query(prefs, cursor, from_millis)
        resp = await self._es.search_logs(prefs.data_view_pattern, body)
        hits = resp.get("hits", {}).get("hits", [])
        return [RawEvent.from_hit(h, prefs) for h in hits]

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
        return ecs_to_ocsf(
            raw, prefs, source_type=self.source_type, connector_id=self.connector_id
        )

    async def test_connection(self, prefs: Preferences) -> ConnectionTest:
        """Wizard 'Test connection': ping, then a cheap sample count.

        On a reachable cluster we additionally run a tiny poll-shaped read to
        report how many in-scope events the configured pattern/mapping yields, so
        the operator gets immediate feedback that their field mapping is sane.
        Failures degrade gracefully to a ping-only / error result.
        """
        try:
            ok = await self._es.ping()
        except Exception as exc:  # noqa: BLE001
            return ConnectionTest(ok=False, message=str(exc))
        if not ok:
            return ConnectionTest(ok=False, message="unreachable")
        try:
            body = poll_query(prefs, Cursor(), 0, batch_size=1)
            resp = await self._es.search_logs(prefs.data_view_pattern, body)
            total = resp.get("hits", {}).get("total", {})
            count = total.get("value") if isinstance(total, dict) else None
            return ConnectionTest(
                ok=True,
                message="OK",
                sample_count=count,
                detail={"data_view": prefs.data_view_pattern},
            )
        except Exception as exc:  # noqa: BLE001 — reachable but the read failed
            return ConnectionTest(ok=True, message=f"reachable; sample read failed: {exc}")

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
        events = [RawEvent.from_hit(h, prefs) for h in hits]
        rendering = QueryRendering(
            query=kql,
            language="kuery",
            data_view=prefs.data_view_pattern,
            time_from=time_from,
            time_to=time_to,
        )
        return SearchResult(events=events, total=total_val, rendering=rendering, raw=resp)
