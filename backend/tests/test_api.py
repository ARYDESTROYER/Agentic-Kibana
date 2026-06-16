"""API smoke tests over the full app with a fake ES + mock LLM (TestClient)."""

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


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


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
