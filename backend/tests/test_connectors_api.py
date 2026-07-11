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


def test_connector_test_uses_exact_draft_without_persisting(client, monkeypatch):
    state = client.app.state.tlsoc
    draft_es = InMemoryESClient()
    draft_es.add_log(
        "draft-events-2026",
        {"@timestamp": "2026-07-11T12:00:00Z", "message": "draft sample"},
        "draft-1",
    )
    captured = {}

    def client_for_source(source):
        captured["source"] = source
        return draft_es, False

    monkeypatch.setattr(state, "es_client_for_source", client_for_source)
    before_sources = list(state.prefs.sources)
    before_secrets = dict(state.secrets.connector_secrets)

    response = client.post(
        "/api/connectors/test",
        json={
            "source_type": "elasticsearch",
            "config": {"data_view_pattern": "draft-events-*"},
            "secrets": {"es_api_key": "request-only-key"},
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert response.json()["sample_count"] == 1
    assert captured["source"].config["data_view_pattern"] == "draft-events-*"
    assert captured["source"].config["es_api_key"] == "request-only-key"
    assert state.prefs.sources == before_sources
    assert state.secrets.connector_secrets == before_secrets


def test_connector_test_push_receiver_is_honestly_unsupported(client):
    response = client.post(
        "/api/connectors/test",
        json={"source_type": "webhook", "config": {"auth_mode": "none"}},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["mode"] == "push"
    assert response.json()["detail"]["supported"] is False


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


def test_upsert_preserves_configured_secrets_and_created_at(client):
    """Regression (validation F1/F2): a bare re-upsert — the Enabled toggle / bulk
    enable-disable / make-primary path — must NOT wipe the source's `configured_secrets`
    NAMES or reset its `created_at`. `SourceUpsert` carries neither field, so `upsert_source`
    carries them forward from the existing source; without that fix every toggle emptied the
    secret-name list (the "N secrets" subline + delete warning) and re-stamped the creation
    date, which the new Log Sources table surfaces as an Enabled toggle + a Creation Date col."""
    body = {
        "id": "elk-x",
        "source_type": "elasticsearch",
        "display_name": "ELK",
        "enabled": True,
        "config": {},
    }
    assert client.post("/api/sources", json=body).status_code == 200

    # record a secret NAME on the source (values go to the in-memory secret tier)
    r = client.post("/api/sources/elk-x/secrets", json={"es_api_key": "s3cr3t"})
    assert r.status_code == 200 and r.json()["configured_secrets"] == ["es_api_key"]
    created0 = next(
        s for s in client.get("/api/sources").json()["sources"] if s["id"] == "elk-x"
    )["created_at"]

    # a bare re-upsert that does NOT re-send the secret (an enable/disable toggle)
    r2 = client.post("/api/sources", json={**body, "enabled": False})
    assert r2.status_code == 200
    src = next(s for s in r2.json()["sources"] if s["id"] == "elk-x")
    assert src["configured_secrets"] == ["es_api_key"]  # secret-name metadata survives (F1)
    assert src["created_at"] == created0  # creation date unchanged (F2)
    assert src["enabled"] is False


def test_pull_secret_rotation_rebuilds_live_clients(client, monkeypatch):
    """A pull key saved after source upsert must affect the live poller immediately."""
    state = client.app.state.tlsoc
    created = client.post(
        "/api/sources",
        json={
            "id": "rotating-pull",
            "source_type": "elasticsearch",
            "is_primary": True,
            "config": {"data_view_pattern": "rotating-*"},
        },
    )
    assert created.status_code == 200

    observed: list[dict[str, str]] = []

    def client_for_source(source):
        observed.append(dict(state.secrets.source_secrets(source.id)))
        return InMemoryESClient(), False

    monkeypatch.setattr(state, "es_client_for_source", client_for_source)
    rotated = client.post(
        "/api/sources/rotating-pull/secrets",
        json={"es_api_key": "rotated-key"},
    )

    assert rotated.status_code == 200
    assert observed and observed[-1]["es_api_key"] == "rotated-key"
