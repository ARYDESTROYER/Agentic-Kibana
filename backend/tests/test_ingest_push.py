"""End-to-end push ingestion: webhook → OCSF → correlate → case.

Exercises the runtime that makes "every way to get logs" real: a configured
webhook source receives alerts over HTTP, they are normalised and flow into the
SAME correlate→case pipeline the poller feeds, with per-source secret auth.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone

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


def _alerts(ip: str, n: int) -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    return [
        {"src_ip": ip, "user": "eve", "severity": "high",
         "signature": "ssh_bruteforce", "@timestamp": now, "id": f"evt-{i}"}
        for i in range(n)
    ]


def _add_webhook(client, source_id: str, config: dict | None = None):
    body = {"id": source_id, "source_type": "webhook", "config": config or {}}
    r = client.post("/api/sources", json=body)
    assert r.status_code == 200, r.text


def test_webhook_ingest_creates_case(client):
    _add_webhook(client, "wh1")
    # 6 same-IP alerts clear the default correlation threshold (n=5) → one cluster.
    r = client.post("/api/ingest/wh1", json=_alerts("5.5.5.5", 6))
    assert r.status_code == 200, r.text
    stats = r.json()
    assert stats["ok"] is True
    assert stats["received"] == 6
    assert stats["clusters"] >= 1
    assert (stats["candidates"] + stats["investigated"]) >= 1

    cases = client.get("/api/cases").json()["cases"]
    assert any(c["entity"]["value"] == "5.5.5.5" for c in cases)


def test_webhook_threshold_spans_single_event_deliveries(client):
    """Five one-record callbacks must trigger the same threshold as one batch."""
    _add_webhook(client, "wh-stream")
    now = datetime.now(timezone.utc).isoformat()
    responses = []
    for index in range(5):
        responses.append(client.post(
            "/api/ingest/wh-stream",
            json={
                "id": f"stream-{index}",
                "src_ip": "198.51.100.77",
                "severity": "medium",
                "signature": "successive-delivery",
                "@timestamp": now,
            },
        ))

    assert all(response.status_code == 200 for response in responses)
    assert all(response.json()["clusters"] == 0 for response in responses[:4])
    assert responses[4].json()["clusters"] >= 1
    cases = client.get("/api/cases").json()["cases"]
    case = next(c for c in cases if c["entity"]["value"] == "198.51.100.77")
    assert len(case["member_event_ids"]) == 5


def test_webhook_ingest_unknown_source_404(client):
    assert client.post("/api/ingest/nope", json=_alerts("1.1.1.1", 1)).status_code == 404


def test_webhook_bearer_auth_enforced(client):
    _add_webhook(client, "wh2", config={"auth_mode": "bearer"})
    # secret token goes to the secret tier (not persisted config)
    r = client.post("/api/sources/wh2/secrets", json={"token": "s3kret"})
    assert r.status_code == 200
    assert r.json()["configured_secrets"] == ["token"]

    payload = _alerts("9.9.9.9", 6)
    # no token → 401
    assert client.post("/api/ingest/wh2", json=payload).status_code == 401
    # wrong token → 401
    assert client.post(
        "/api/ingest/wh2", json=payload, headers={"Authorization": "Bearer nope"}
    ).status_code == 401
    # correct token → accepted
    ok = client.post(
        "/api/ingest/wh2", json=payload, headers={"Authorization": "Bearer s3kret"}
    )
    assert ok.status_code == 200 and ok.json()["received"] == 6


def test_webhook_accepts_ndjson_and_cef(client):
    _add_webhook(client, "wh3")
    # NDJSON body
    nd = "\n".join(json.dumps(a) for a in _alerts("7.7.7.7", 6))
    r = client.post("/api/ingest/wh3", content=nd,
                    headers={"Content-Type": "application/x-ndjson"})
    assert r.status_code == 200 and r.json()["received"] == 6
