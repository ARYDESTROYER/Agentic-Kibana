"""Offline tests for read-only `test_connection`, per-source TLS overrides, and the
browse-logs row projection + bounding.

All offline (in-memory fake ES, no LLM, no network):

* ``test_connection`` must NOT gate on ping(): a correctly-scoped read-only key
  cannot HEAD / (cluster monitor), so the scoped sample read is authoritative and
  the result reports mode="read_only" (ok=True). A full key (ping True) reports
  mode="full". An auth failure on the index returns ok=False.
* ``_source_es_overrides`` translates a source's merged config+secrets into Secrets
  connection overrides (the per-source TLS bug fix); an empty config yields {} so
  behaviour falls back to the shared global client byte-for-byte.
* The browse-logs row projection (``_log_row``) yields the contract row shape, and
  the connector hard-caps search size at ``_MAX_SIZE`` (200).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import _log_row, router
from app.config import Preferences
from app.connectors.base import StructuredQuery
from app.connectors.elastic import ElasticConnector, _MAX_SIZE
from app.es.fake import InMemoryESClient
from app.models import RawEvent
from app.state import AppState, _source_es_overrides
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

# Only the async tests carry the asyncio mark (the sync unit/route tests do not),
# so pytest-asyncio doesn't warn about non-async functions.
asyncio = pytest.mark.asyncio

INDEX = "all-logs-2026.06.23"


def _prefs() -> Preferences:
    return Preferences(setup_complete=True)


def _seed(es: InMemoryESClient, n: int = 4) -> int:
    base = to_millis(now_utc()) - 600_000
    for i in range(n):
        es.add_log(
            INDEX,
            make_log_event(ip=f"10.0.0.{i}", user=f"u{i}", host=f"h{i}",
                           rule="linux_auth", severity=7.0, ts_millis=base + i * 1_000),
            doc_id=f"d{i}",
        )
    return base


class _NoPingClient(InMemoryESClient):
    """A read-only-key stand-in: the scoped search works, but HEAD / (ping) does
    not — exactly the shape of a correctly-scoped read-only API key."""

    async def ping(self) -> bool:
        return False


class _AuthErr(Exception):
    pass


class _AuthDeniedClient(InMemoryESClient):
    """A client whose scoped read is rejected with HTTP 403 (no read privilege)."""

    async def search_logs(self, index, body):  # type: ignore[override]
        exc = _AuthErr("forbidden")
        exc.status_code = 403  # type: ignore[attr-defined]
        raise exc


# --------------------------------------------------------------------------- #
# 1) read-only test_connection — ping False is NOT a failure.
# --------------------------------------------------------------------------- #
@asyncio
async def test_test_connection_read_only_mode_when_ping_unavailable():
    es = _NoPingClient()
    _seed(es)
    conn = ElasticConnector(es)
    r = await conn.test_connection(_prefs())
    assert r.ok is True
    assert r.mode == "read_only"
    assert r.cluster_monitor is False
    assert r.sample_count is not None
    assert "Read-only access verified" in r.message


# --------------------------------------------------------------------------- #
# 2) full mode when ping works (cluster-monitor present).
# --------------------------------------------------------------------------- #
@asyncio
async def test_test_connection_full_mode_when_ping_works():
    es = InMemoryESClient()  # plain fake pings True
    _seed(es)
    conn = ElasticConnector(es)
    r = await conn.test_connection(_prefs())
    assert r.ok is True
    assert r.mode == "full"
    assert r.cluster_monitor is True


# --------------------------------------------------------------------------- #
# 3) auth failure on the index → ok False.
# --------------------------------------------------------------------------- #
@asyncio
async def test_test_connection_auth_failure_is_not_ok():
    conn = ElasticConnector(_AuthDeniedClient())
    r = await conn.test_connection(_prefs())
    assert r.ok is False
    assert ("denied" in r.message) or ("403" in r.message)


# --------------------------------------------------------------------------- #
# 4) per-source TLS override (the bug fix) — _source_es_overrides.
# --------------------------------------------------------------------------- #
def test_source_es_overrides_reflects_per_source_tls():
    # es_verify_certs=False must propagate (the TLS bug: a source's own setting).
    out = _source_es_overrides({"es_url": "https://es:9200", "es_verify_certs": False})
    assert out["es_verify_certs"] is False
    assert out["es_url"] == "https://es:9200"
    # An empty config yields {} → caller uses the shared global client unchanged.
    assert _source_es_overrides({}) == {}
    # ca cert + api key are reflected.
    out2 = _source_es_overrides(
        {"es_ca_cert": "/certs/ca/ca.crt", "es_api_key": "ro-key"}
    )
    assert out2["es_ca_cert"] == "/certs/ca/ca.crt"
    assert out2["es_api_key"] == "ro-key"
    # A string "false" is coerced to a bool False (wizard/env may send strings).
    assert _source_es_overrides({"es_verify_certs": "false"})["es_verify_certs"] is False


# --------------------------------------------------------------------------- #
# 5) browse logs bounding + field mapping.
# --------------------------------------------------------------------------- #
@asyncio
async def test_search_caps_size_at_max():
    es = InMemoryESClient()
    # Seed more than _MAX_SIZE docs so a cap is observable.
    base = to_millis(now_utc()) - 600_000
    for i in range(_MAX_SIZE + 50):
        es.add_log(INDEX, make_log_event(ip="10.0.0.1", ts_millis=base + i), doc_id=f"d{i}")
    conn = ElasticConnector(es)
    # Ask for 1000; the connector must never search/return more than _MAX_SIZE.
    res = await conn.search(_prefs(), StructuredQuery(size=1000, sort_desc=True))
    assert len(res.events) == _MAX_SIZE
    assert len(res.events) <= _MAX_SIZE


def test_log_row_projection_shape_and_raw():
    prefs = _prefs()
    src = make_log_event(ip="198.51.100.7", user="mallory", host="bastion",
                         rule="linux_auth", severity=9.0)
    hit = {"_id": "abc", "_index": INDEX, "_source": src}
    ev = RawEvent.from_hit(hit, prefs)
    row = _log_row(ev)
    assert set(row.keys()) == {"id", "ts", "source_ip", "user", "host", "rule",
                               "severity", "message", "_raw"}
    # _raw is the full source doc (log data), source_ip reflects the mapped field.
    assert row["_raw"] == src
    assert row["source_ip"] == "198.51.100.7"
    assert row["user"] == "mallory"
    assert row["host"] == "bastion"
    assert row["id"] == "abc"
    assert row["message"]  # non-empty (from the message field)


# --------------------------------------------------------------------------- #
# 6) route-level: GET /sources/{id}/logs is hard-capped + honors field mapping.
# --------------------------------------------------------------------------- #
@pytest.fixture
def client(secrets, mock_provider):
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        base = to_millis(now_utc()) - 600_000
        for i in range(_MAX_SIZE + 50):
            es.add_log(INDEX, make_log_event(ip="10.0.0.1", ts_millis=base + i), doc_id=f"d{i}")
        state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    with TestClient(api) as c:
        yield c


def test_route_source_logs_pull_caps_count(client):
    # Configure a pull source so /sources/{id}/logs runs a scoped search.
    body = {"id": "elk", "source_type": "elasticsearch", "is_primary": True,
            "config": {"data_view_pattern": INDEX}}
    assert client.post("/api/sources", json=body).status_code == 200
    r = client.get("/api/sources/elk/logs?limit=300")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["mode"] == "search"
    assert data["count"] <= 200
    assert len(data["logs"]) <= 200


def test_route_source_logs_unknown_404(client):
    assert client.get("/api/sources/nope/logs").status_code == 404


def test_route_source_logs_push_buffer(client):
    # A webhook (push) source returns the live-tail buffer; empty before ingest.
    assert client.post("/api/sources", json={"id": "wh", "source_type": "webhook"}).status_code == 200
    r = client.get("/api/sources/wh/logs")
    assert r.status_code == 200
    data = r.json()
    assert data["mode"] == "buffer"
    assert data["count"] == 0

    # After ingest, the buffer returns the recently-ingested events (browse them).
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    alerts = [{"src_ip": "5.5.5.5", "user": "eve", "severity": "high",
               "signature": "ssh_bruteforce", "@timestamp": now, "id": f"evt-{i}"}
              for i in range(6)]
    assert client.post("/api/ingest/wh", json=alerts).status_code == 200
    r2 = client.get("/api/sources/wh/logs?limit=10")
    data2 = r2.json()
    assert data2["mode"] == "buffer"
    assert data2["count"] == 6
    assert data2["logs"][0]["id"]  # rows have the contract id field
