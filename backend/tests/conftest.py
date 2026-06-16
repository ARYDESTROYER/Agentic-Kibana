"""Shared test fixtures: an in-process AppState with a fake ES and mock LLM."""

from __future__ import annotations

import pytest
import pytest_asyncio

from app.config import Preferences, Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.utils import iso_now, to_millis, now_utc


@pytest.fixture
def mock_provider() -> MockProvider:
    return MockProvider()


@pytest.fixture
def secrets() -> Secrets:
    # _env_file=None so tests never pick up a developer .env.
    return Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",  # Cache falls back to in-memory
        anthropic_api_key=None,
        openai_api_key=None,
    )


@pytest_asyncio.fixture
async def app_state(secrets: Secrets, mock_provider: MockProvider):
    es = InMemoryESClient()
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}
    state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
    await state.startup(start_poller=False)
    # Make the suite "set up" so poll/settings behave as in production.
    prefs = state.prefs.model_copy(update={"setup_complete": True})
    await state.update_prefs(prefs)
    yield state
    await state.shutdown()


def make_log_event(
    *,
    ip: str = "203.0.113.10",
    user: str = "root",
    host: str = "web01",
    rule: str = "linux_auth",
    severity: float = 7.0,
    ts_millis: int | None = None,
    action: str = "login",
    outcome: str = "failure",
) -> dict:
    """Build an ECS-ish log _source document matching default field mappings."""
    ts = ts_millis if ts_millis is not None else to_millis(now_utc())
    from datetime import datetime, timezone

    iso = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc).isoformat()
    return {
        "@timestamp": iso,
        "source": {"ip": ip},
        "user": {"name": user},
        "host": {"name": host},
        "event": {"module": rule, "action": action, "outcome": outcome, "severity": severity},
        "rule": {"name": rule},
        "message": f"{rule} {action} {outcome} from {ip} user {user}",
    }


@pytest.fixture
def client(secrets, mock_provider):
    """A TestClient over the full app with a fake ES + mock LLM (own event loop)."""
    from contextlib import asynccontextmanager

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes import router

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


def make_raw_event(
    *,
    id: str = "e1",
    ip: str = "203.0.113.10",
    user: str = "root",
    host: str = "web01",
    rule: str = "linux_auth",
    severity: float = 7.0,
    ts_millis: int | None = None,
):
    from app.models import RawEvent

    ts = ts_millis if ts_millis is not None else to_millis(now_utc())
    src = make_log_event(ip=ip, user=user, host=host, rule=rule, severity=severity, ts_millis=ts)
    return RawEvent(
        id=id, index="all-logs-2026.06.16", source=src, timestamp_millis=ts,
        ip=ip, user=user, host=host, rule=rule, rule_name=rule, severity=severity,
    )


_SEED_COUNTER = {"n": 0}


def seed_logs(es: InMemoryESClient, events: list[dict], index: str = "all-logs-2026.06.16") -> list[str]:
    ids = []
    for ev in events:
        _SEED_COUNTER["n"] += 1
        ids.append(es.add_log(index, ev, doc_id=f"ev{_SEED_COUNTER['n']}"))
    return ids
