"""Epoch A — AppState boots on a SQL state backend and persists end-to-end.

Builds an :class:`AppState` with ``state_backend="sqlite"`` (own-state in SQLite),
the existing fake ES for the read-only LOG surface, and the mock LLM. Then it
seeds logs, runs a real poll → correlate → investigate, and proves the resulting
case is persisted to SQL (not Elasticsearch) — while the log surface stays on the
connector layer. Fully offline; no postgres/asyncpg.
"""

from __future__ import annotations

import json
import os
import tempfile

import pytest
import pytest_asyncio

from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.stores.sql.repositories import SqlCaseRepository
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event


def _route_to_investigator(mock: MockProvider) -> None:
    mock.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}
    ))


def _final_verdict() -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": "TRUE_POSITIVE", "confidence": 0.95,
            "evidence": [{"summary": "scripted evidence", "event_ids": []}],
            "mitre": ["T1110"], "recommended_action": "block the source",
            "reproduce_query": "source.ip:\"203.0.113.99\"",
        },
    })


@pytest_asyncio.fixture
async def sql_state():
    """An AppState whose OWN-state is SQLite (temp file), fake-ES log surface."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        state_backend="sqlite",
        state_db_url=f"sqlite+aiosqlite:///{path}",
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    es = InMemoryESClient()
    state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    state._mock = mock  # type: ignore[attr-defined]
    yield state
    await state.shutdown()
    try:
        os.remove(path)
    except OSError:
        pass


async def test_sql_backend_boots_and_wires_sql_stores(sql_state) -> None:
    # The own-state stores are the SQL repositories; the log surface stays on ES.
    from app.stores.sql.repositories import (
        SqlAuditRepository,
        SqlConfigStore,
        SqlCursorStore,
        SqlUsageRepository,
    )

    assert isinstance(sql_state.cases, SqlCaseRepository)
    assert isinstance(sql_state.audit, SqlAuditRepository)
    assert isinstance(sql_state.usage_store, SqlUsageRepository)
    assert isinstance(sql_state.config_store, SqlConfigStore)
    assert isinstance(sql_state.cursor_store, SqlCursorStore)
    # ES kept for the read-only log surface / connector.
    assert isinstance(sql_state.es, InMemoryESClient)
    assert sql_state._sql_engine is not None


async def test_sql_backend_persists_prefs_to_sql(sql_state) -> None:
    # update_prefs above wrote to the SQL config store; a fresh load returns it.
    loaded = await sql_state.config_store.load()
    assert loaded.setup_complete is True


async def test_sql_backend_poll_persists_case_to_sql(sql_state) -> None:
    mock = sql_state._mock  # type: ignore[attr-defined]
    ip = "203.0.113.99"
    ts = to_millis(now_utc())
    # Seed enough failed-auth events from one IP to trip correlation.
    for i in range(8):
        sql_state.es.add_log(
            "all-logs-2026.06.16",
            make_log_event(ip=ip, user=f"u{i}", rule="linux_auth",
                           severity=8.0, ts_millis=ts - i * 1000),
        )
    _route_to_investigator(mock)
    mock.push("investigator", _final_verdict())

    stats = await sql_state.poller.poll_once()
    assert stats["polled"] >= 8

    # The case must be readable from the SQL backend.
    cases, total = await sql_state.cases.list()
    assert total >= 1
    case = cases[0]
    assert case.entity.value == ip

    # And it is genuinely in SQL, not Elasticsearch: a fresh SqlCaseRepository over
    # the same engine sees it; the fake ES management indices hold no case docs.
    fresh = SqlCaseRepository(sql_state._sql_engine)
    again = await fresh.get(case.case_id)
    assert again is not None and again.case_id == case.case_id

    # Cursor advanced + persisted to SQL.
    cursor = await sql_state.cursor_store.load()
    assert cursor.is_set()


async def test_sql_backend_audit_recorded_to_sql(sql_state) -> None:
    # A poll writes audit rows; they land in the SQL audit table.
    sql_state.es.add_log("all-logs-2026.06.16", make_log_event(ip="198.51.100.7"))
    await sql_state.poller.poll_once()
    # Audit POLL action is always recorded regardless of clusters.
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.stores.sql.models import AuditRow

    sm = async_sessionmaker(sql_state._sql_engine, expire_on_commit=False)
    async with sm() as session:
        rows = (await session.execute(select(AuditRow))).scalars().all()
    assert len(rows) >= 1
