"""API tests for the connector registry + multi-source wizard endpoints."""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router
from app.es.fake import InMemoryESClient
from app.state import AppState


@pytest.fixture
def client(secrets, mock_provider):
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    with TestClient(api) as c:
        yield c


def test_list_connectors_exposes_pull_and_push(client):
    r = client.get("/api/connectors")
    assert r.status_code == 200
    conns = {c["source_type"]: c for c in r.json()["connectors"]}
    # pull SIEMs + universal push transports are all discoverable for the wizard
    for expected in ("elasticsearch", "opensearch", "webhook", "syslog", "kafka", "s3"):
        assert expected in conns, f"{expected} missing from connector list"
    elastic = conns["elasticsearch"]
    assert "pull" in elastic["ingest_modes"]
    auth_keys = {f["key"] for f in elastic["auth_fields"]}
    assert {"es_url", "es_api_key"} <= auth_keys
    # the api_key field must be flagged secret (UI shows configured-only)
    assert next(f for f in elastic["auth_fields"] if f["key"] == "es_api_key")["secret"] is True


def test_get_connector_manifest_and_404(client):
    r = client.get("/api/connectors/elasticsearch")
    assert r.status_code == 200
    assert r.json()["display_name"]
    assert client.get("/api/connectors/not-a-real-source").status_code == 404


def test_connector_test_uses_live_primary(client):
    # The fake ES pings True, so the wired primary source tests OK.
    r = client.post("/api/connectors/test", json={})
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_source_crud_roundtrip(client):
    assert client.get("/api/sources").json()["sources"] == []

    body = {
        "id": "elk-prod",
        "source_type": "elasticsearch",
        "display_name": "Prod ELK",
        "is_primary": True,
        "config": {"data_view_pattern": "all-logs-*"},
    }
    r = client.post("/api/sources", json=body)
    assert r.status_code == 200
    sources = r.json()["sources"]
    assert len(sources) == 1
    assert sources[0]["id"] == "elk-prod" and sources[0]["is_primary"] is True
    assert sources[0]["ingest_mode"] == "pull"  # defaulted from the manifest

    # adding a second primary unsets the first
    r2 = client.post("/api/sources", json={
        "id": "os-dev", "source_type": "opensearch", "is_primary": True,
    })
    by_id = {s["id"]: s for s in r2.json()["sources"]}
    assert by_id["os-dev"]["is_primary"] is True
    assert by_id["elk-prod"]["is_primary"] is False

    # delete
    assert client.delete("/api/sources/elk-prod").status_code == 200
    remaining = {s["id"] for s in client.get("/api/sources").json()["sources"]}
    assert remaining == {"os-dev"}
    assert client.delete("/api/sources/does-not-exist").status_code == 404


def test_upsert_rejects_unknown_source_type(client):
    r = client.post("/api/sources", json={"id": "x", "source_type": "frobnicator"})
    assert r.status_code == 400
