"""API smoke tests over the full app with a fake ES + mock LLM (TestClient)."""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import __version__
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


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["version"] == __version__


def test_health_live_ready_and_build_info(client, monkeypatch):
    live = client.get("/api/health/live")
    assert live.status_code == 200
    assert live.json() == {
        "status": "ok",
        "service": "tlsoc-agentic-triage",
        "version": __version__,
    }

    ready = client.get("/api/health/ready")
    assert ready.status_code == 200
    assert ready.json()["ready"] is True
    assert ready.json()["checks"] == {"state_store": True}

    monkeypatch.setenv("TLSOC_BUILD_SHA", "abc123")
    monkeypatch.setenv("TLSOC_BUILD_DATE", "2026-07-11T00:00:00Z")
    build = client.get("/api/health/build-info")
    assert build.status_code == 200
    assert build.json() == {
        "service": "tlsoc-agentic-triage",
        "version": __version__,
        "release_channel": "alpha",
        "commit_sha": "abc123",
        "build_time": "2026-07-11T00:00:00Z",
        "state_backend": "elasticsearch",
        "ocsf_version": "1.4.0",
    }


def test_health_readiness_is_truthful_when_state_store_is_down(client, monkeypatch):
    async def down() -> bool:
        return False

    state = client.app.state.tlsoc
    monkeypatch.setattr(state.es, "ping_state", down)

    legacy = client.get("/api/health")
    assert legacy.status_code == 200
    assert legacy.json()["status"] == "degraded"
    assert legacy.json()["es_connected"] is False

    ready = client.get("/api/health/ready")
    assert ready.status_code == 503
    assert ready.json()["status"] == "not_ready"
    assert ready.json()["ready"] is False
    assert ready.json()["checks"] == {"state_store": False}

    # Liveness is intentionally independent of dependencies so an orchestrator
    # does not restart-loop a healthy process during a store outage.
    assert client.get("/api/health/live").status_code == 200


def test_setup_status(client):
    r = client.get("/api/setup/status")
    assert r.status_code == 200
    body = r.json()
    assert "configured" in body and "data_view_pattern" in body


def test_get_and_put_settings(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["prefs"]["data_view_pattern"] == "all-logs-*"

    r2 = client.put("/api/settings", json={"poll_interval_seconds": 45})
    assert r2.status_code == 200
    assert r2.json()["prefs"]["poll_interval_seconds"] == 45


def test_poll_and_cases(client):
    assert client.post("/api/poll").status_code == 200
    r = client.get("/api/cases")
    assert r.status_code == 200
    assert "cases" in r.json() and "total" in r.json()


def test_chat_smoke(client):
    r = client.post("/api/chat", json={"message": "list logs from 10.10.1.152 today"})
    assert r.status_code == 200
    assert "answer" in r.json()


def test_usage_summary(client):
    r = client.get("/api/usage/summary?window_hours=24")
    assert r.status_code == 200
    assert "total_cost" in r.json()


def test_scans_and_standup(client):
    assert client.get("/api/scans").status_code == 200
    r = client.get("/api/standup")
    assert r.status_code == 200
    assert "summary" in r.json()


def test_secrets_never_returned(client):
    client.post("/api/setup/secrets", json={"anthropic_api_key": "sk-secret-value"})
    body = client.get("/api/settings").json()
    # The configured flag flips, but the value is never echoed anywhere.
    assert body["configured"]["anthropic_api_key"] is True
    assert "sk-secret-value" not in str(body)
