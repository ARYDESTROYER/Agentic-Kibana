"""Configured source mutations reconcile the live background receiver set."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest


def test_source_create_secret_rotation_and_delete_reconcile_receivers(client, monkeypatch):
    state = client.app.state.tlsoc
    reconcile = AsyncMock()
    monkeypatch.setattr(state, "reconcile_receivers", reconcile)

    created = client.post(
        "/api/sources",
        json={"id": "lifecycle-webhook", "source_type": "webhook", "config": {}},
    )
    assert created.status_code == 200

    secret = client.post(
        "/api/sources/lifecycle-webhook/secrets", json={"token": "rotated"}
    )
    assert secret.status_code == 200
    assert state.secrets.source_secrets("lifecycle-webhook") == {"token": "rotated"}

    deleted = client.delete("/api/sources/lifecycle-webhook")
    assert deleted.status_code == 200
    assert state.secrets.source_secrets("lifecycle-webhook") == {}
    assert reconcile.await_count == 3


async def test_reconcile_is_side_effect_free_when_runtime_not_started(app_state, monkeypatch):
    start = AsyncMock()
    monkeypatch.setattr(app_state, "_start_receivers", start)

    assert app_state._receivers_enabled is False
    await app_state.reconcile_receivers()

    start.assert_not_awaited()


@pytest.mark.asyncio
async def test_failed_receiver_is_restarted_with_backoff(app_state, monkeypatch):
    class FlakyReceiver:
        def __init__(self):
            self.starts = 0
            self.stops = 0

        async def start(self, emit, prefs):
            self.starts += 1
            if self.starts == 1:
                raise RuntimeError("processing failed before acknowledgement")
            app_state._receivers_enabled = False

        async def stop(self):
            self.stops += 1

    sleep = AsyncMock()
    monkeypatch.setattr("app.state.asyncio.sleep", sleep)
    receiver = FlakyReceiver()
    app_state._receivers_enabled = True

    await app_state._run_receiver(receiver, AsyncMock(), "flaky-source")

    assert receiver.starts == 2
    assert receiver.stops == 1
    sleep.assert_awaited_once_with(1.0)
