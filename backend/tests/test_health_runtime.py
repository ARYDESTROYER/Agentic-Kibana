"""Release/runtime health probes: state-path truth and SQL readiness."""

from __future__ import annotations

import pytest

from app.api.routes import _state_store_probe, setup_status
from app.config import Secrets
from app.es.client import RealESClient
from app.es.fake import InMemoryESClient
from app.state import AppState


class _ReachableReadOnlyClient:
    async def ping(self) -> bool:
        return True


@pytest.mark.asyncio
async def test_real_es_read_only_connectivity_does_not_claim_state_readiness() -> None:
    """A reachable log key cannot hide a missing management/state credential."""
    client = object.__new__(RealESClient)
    client._ro = _ReachableReadOnlyClient()
    client._mgmt = None

    assert await client.ping() is True
    assert await client.ping_state() is False


@pytest.mark.asyncio
async def test_sqlite_state_backend_readiness_uses_sql_not_log_es() -> None:
    state = AppState.create(
        secrets=Secrets(
            state_backend="sqlite",
            state_db_url="sqlite+aiosqlite:///:memory:",
        ),
        es=InMemoryESClient(),
    )
    await state.startup(start_poller=False)
    try:
        async def log_surface_down() -> bool:
            return False

        state.es.ping_state = log_surface_down
        ready, store_type = await _state_store_probe(state)
        assert ready is True
        assert store_type == "SQLiteStateStore"
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_setup_status_distinguishes_optional_log_es_from_sql_state() -> None:
    state = AppState.create(
        secrets=Secrets(
            state_backend="sqlite",
            state_db_url="sqlite+aiosqlite:///:memory:",
        ),
        es=InMemoryESClient(),
    )
    await state.startup(start_poller=False)
    try:
        async def log_surface_down() -> bool:
            return False

        state.es.ping = log_surface_down
        status = await setup_status(state)
        assert status["es_connected"] is False
        assert status["es_required_for_state"] is False
        assert status["es_connection_role"] == "log_source_only"
        assert status["state_backend"] == "sqlite"

        ready, _store_type = await _state_store_probe(state)
        assert ready is True
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_readiness_fails_when_es_connects_but_state_write_is_denied() -> None:
    state = AppState.create(secrets=Secrets(), es=InMemoryESClient())
    await state.startup(start_poller=False)
    try:
        async def reachable() -> bool:
            return True

        async def denied(*args, **kwargs):
            raise PermissionError("state credential is read-only")

        state.es.ping_state = reachable
        state.es.index_doc = denied
        ready, _store_type = await _state_store_probe(state)
        assert ready is False
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_readiness_fails_when_sql_connects_but_kv_write_is_denied() -> None:
    state = AppState.create(
        secrets=Secrets(
            state_backend="sqlite",
            state_db_url="sqlite+aiosqlite:///:memory:",
        ),
        es=InMemoryESClient(),
    )
    await state.startup(start_poller=False)
    try:
        async def denied(*args, **kwargs):
            raise PermissionError("state database user is read-only")

        state.kv.put = denied
        ready, _store_type = await _state_store_probe(state)
        assert ready is False
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_real_es_count_reraises_non_notfound_errors() -> None:
    # audit #41: count() must NOT mask a live ES fault as "0 documents" — a genuine error
    # (auth/connection/cluster-red) re-raises so callers can tell "no docs" from "failed".
    client = object.__new__(RealESClient)

    class _BoomMgmt:
        async def count(self, *, index, query):  # noqa: ANN001
            raise RuntimeError("cluster red")

    client._mgmt = _BoomMgmt()
    with pytest.raises(RuntimeError):
        await client.count("all-logs-*", {"query": {"match_all": {}}})
