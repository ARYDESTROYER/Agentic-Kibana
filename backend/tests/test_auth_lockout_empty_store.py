"""Regression tests for the transient-empty-user-store auth lockout.

Bug: a transient empty read from the ``UserStore`` (``UserStore._load`` swallows read
errors and degrades to ``[]``) used to flow through ``AppState.refresh_users`` →
``AuthService.set_users([])``, collapsing the synced in-memory auth view to the env
base layer alone. On an OOBE-only deployment (no env-seeded admin) that evicts EVERY
persisted account, so every subsequent login returns 401 "invalid credentials" even
though the stored ``password_hash`` still verifies — a total, silent auth lockout that
persists until the process restarts.

These tests pin the hardening:
  * ``AuthService.set_users`` refuses to drop known stored accounts on an empty update
    unless an authoritative ``allow_empty`` signal is passed.
  * ``AppState.refresh_users`` treats an empty ``users.list()`` as a failed read (keeps
    the view) unless the raising ``has_any()`` probe authoritatively confirms an empty
    store.
  * A ``_wire()`` rebuild (as ``apply_secrets`` does on a credential change) followed by
    ``refresh_users`` restores the stored overlay instead of leaving it evicted.
  * A source rename persists (atomic ``mutate_prefs``) and never mutates the auth view.

Offline: fake ES + mock LLM, no network.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router
from app.auth.passwords import hash_password
from app.auth.service import AuthService
from app.config import Secrets, SourceInstance
from app.constants import IngestMode, SourceType, UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import User
from app.state import AppState

_SEED_USER = "Admin"
_SEED_PASS = "Admin@123"


# --------------------------------------------------------------------------- #
# AuthService.set_users — unit
# --------------------------------------------------------------------------- #
def _svc_with_stored_admin() -> AuthService:
    """An AuthService with an EMPTY env base layer + one persisted (store) admin
    folded in — i.e. the OOBE-only shape where the base layer can't cover a wipe."""
    svc = AuthService(enabled=True, jwt_secret="unit-secret", token_hours=8, users={})
    stored = User(username=_SEED_USER, password_hash=hash_password(_SEED_PASS),
                  role=UserRole.SUPER_ADMIN.value, active=True)
    svc.set_users([stored])
    return svc


def test_set_users_refuses_empty_drop_of_stored_accounts() -> None:
    svc = _svc_with_stored_admin()
    assert svc.authenticate(_SEED_USER, _SEED_PASS) is not None
    # A transient empty update (default allow_empty=False) must NOT evict the admin.
    svc.set_users([])
    assert svc.authenticate(_SEED_USER, _SEED_PASS) is not None
    # ...even when passed None.
    svc.set_users(None)  # type: ignore[arg-type]
    assert svc.authenticate(_SEED_USER, _SEED_PASS) is not None


def test_set_users_allow_empty_clears_view() -> None:
    svc = _svc_with_stored_admin()
    assert svc.authenticate(_SEED_USER, _SEED_PASS) is not None
    # An AUTHORITATIVE empty (allow_empty=True) genuinely clears to the base-only view.
    svc.set_users([], allow_empty=True)
    assert svc.authenticate(_SEED_USER, _SEED_PASS) is None


def test_set_users_nonempty_still_replaces() -> None:
    """A normal, non-empty update still replaces the overlay wholesale (a disabled/
    removed account must still take effect)."""
    svc = _svc_with_stored_admin()
    other = User(username="bob", password_hash=hash_password("bob-pass-123"),
                 role=UserRole.ANALYST_TIER1.value, active=True)
    svc.set_users([other])
    # The admin is gone (a real replace), bob is in.
    assert svc.authenticate(_SEED_USER, _SEED_PASS) is None
    assert svc.authenticate("bob", "bob-pass-123") is not None


# --------------------------------------------------------------------------- #
# AppState.refresh_users — integration against a real UserStore
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def _oobe_state():
    """An auth-enabled AppState whose ONLY admin is the seeded (store-persisted)
    ``Admin`` — no env admin, so the base layer is empty and a wipe is fatal."""
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="lockout-test-secret",
        auth_seed_admin=True, auth_admin_username="envadmin", auth_admin_password=None,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    try:
        yield state
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_seeded_admin_authenticates_after_startup() -> None:
    async with _oobe_state() as state:
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None


@pytest.mark.asyncio
async def test_refresh_users_transient_empty_keeps_view() -> None:
    """list() degrades to [] (transient glitch) but has_any() still reports accounts →
    the view must be kept and the stored admin must still authenticate."""
    async with _oobe_state() as state:
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None

        async def _empty_list():
            return []

        state.users.list = _empty_list  # type: ignore[assignment]
        # has_any() is left intact (real store → True), so this is a transient empty.
        assert await state.users.has_any() is True
        await state.refresh_users()
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None


@pytest.mark.asyncio
async def test_refresh_users_failed_read_keeps_view() -> None:
    """A raising list() (store read error) is a failed read → keep the view intact."""
    async with _oobe_state() as state:
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None

        async def _boom():
            raise RuntimeError("transient store read error")

        state.users.list = _boom  # type: ignore[assignment]
        await state.refresh_users()
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None


@pytest.mark.asyncio
async def test_refresh_users_probe_failure_keeps_view() -> None:
    """list() empty AND the has_any() probe itself fails → unconfirmable empty is a
    failed read → keep the view (never evict on an ambiguous signal)."""
    async with _oobe_state() as state:
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None

        async def _empty_list():
            return []

        async def _boom_probe():
            raise RuntimeError("probe read glitch")

        state.users.list = _empty_list  # type: ignore[assignment]
        state.users.has_any = _boom_probe  # type: ignore[assignment]
        await state.refresh_users()
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None


@pytest.mark.asyncio
async def test_refresh_users_authoritative_empty_clears_view() -> None:
    """A GENUINELY empty store (list()==[] AND has_any()==False) is honoured: the view
    collapses to the base-only layer (here empty), so the admin no longer authenticates.
    This proves the guard does not over-block a real empty store."""
    async with _oobe_state() as state:
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None

        async def _empty_list():
            return []

        async def _empty_probe():
            return False

        state.users.list = _empty_list  # type: ignore[assignment]
        state.users.has_any = _empty_probe  # type: ignore[assignment]
        await state.refresh_users()
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is None


@pytest.mark.asyncio
async def test_wire_rebuild_then_refresh_restores_stored_accounts() -> None:
    """``apply_secrets`` rebuilds AuthService via ``_wire()`` (base-only view) — without
    a follow-up refresh the stored admin is locked out. A ``refresh_users()`` after the
    rebuild (the apply_secrets fix) must restore it."""
    async with _oobe_state() as state:
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None
        # _wire() rebuilds a fresh AuthService with only the (empty) base layer.
        state._wire()
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is None
        # The apply_secrets fix re-folds the store into the fresh view.
        await state.refresh_users()
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None


# --------------------------------------------------------------------------- #
# Atomic prefs write / source rename — mutate_prefs
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def _plain_state():
    """A minimal auth-off AppState for exercising the prefs write path."""
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None, auth_enabled=False,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    try:
        yield state
    finally:
        await state.shutdown()


def _src(sid: str, name: str) -> SourceInstance:
    return SourceInstance(
        id=sid, source_type=SourceType.ELASTICSEARCH, display_name=name,
        enabled=True, ingest_mode=IngestMode.PULL,
    )


@pytest.mark.asyncio
async def test_mutate_prefs_reads_freshest_prefs() -> None:
    """mutate_prefs reads the CURRENT prefs inside the lock, so a change layered on top
    of a prior write is preserved (no stale-snapshot clobber)."""
    async with _plain_state() as state:
        await state.update_prefs(state.prefs.model_copy(update={"sources": [_src("b", "B")]}))
        # Append a second source via mutate_prefs — it must see "B" and keep it.
        await state.mutate_prefs(
            lambda p: p.model_copy(update={"sources": list(p.sources) + [_src("a", "A")]})
        )
        assert {s.id for s in state.prefs.sources} == {"a", "b"}


@pytest.mark.asyncio
async def test_mutate_prefs_atomic_under_concurrency() -> None:
    """Two concurrent atomic writes touching different sources must BOTH survive. With
    the old unlocked read-copy-write, whichever saved last would clobber the other."""
    async with _plain_state() as state:
        # Force the save to yield so the two coroutines genuinely interleave.
        orig_save = state.config_store.save

        async def _yielding_save(prefs):
            await asyncio.sleep(0)
            return await orig_save(prefs)

        state.config_store.save = _yielding_save  # type: ignore[assignment]

        async def add(sid: str):
            await state.mutate_prefs(
                lambda p: p.model_copy(update={"sources": list(p.sources) + [_src(sid, sid.upper())]})
            )

        await asyncio.gather(add("x"), add("y"))
        assert {s.id for s in state.prefs.sources} == {"x", "y"}


# --------------------------------------------------------------------------- #
# Source rename — route level (auth off) + auth-view isolation
# --------------------------------------------------------------------------- #
def _route_client() -> TestClient:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None, auth_enabled=False,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

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
    return TestClient(api)


def test_source_rename_persists_via_route() -> None:
    with _route_client() as c:
        create = c.post("/api/sources", json={
            "id": "s1", "source_type": SourceType.ELASTICSEARCH.value,
            "display_name": "Original", "enabled": True, "ingest_mode": IngestMode.PULL.value,
            "config": {"data_view_pattern": "logs-*"},
        })
        assert create.status_code == 200, create.text
        # Rename the SAME source id.
        rename = c.post("/api/sources", json={
            "id": "s1", "source_type": SourceType.ELASTICSEARCH.value,
            "display_name": "Renamed Source", "enabled": True, "ingest_mode": IngestMode.PULL.value,
            "config": {"data_view_pattern": "logs-*"},
        })
        assert rename.status_code == 200, rename.text
        # The new name must persist on a fresh read.
        rows = c.get("/api/sources").json()["sources"]
        s1 = next(s for s in rows if s["id"] == "s1")
        assert s1["display_name"] == "Renamed Source"


@pytest.mark.asyncio
async def test_source_rename_does_not_mutate_auth_view() -> None:
    """Renaming a source is NOT a user-management mutation: it must not refresh/evict the
    synced auth view. Requirement #3 — the trigger is narrowed to user mutations."""
    async with _oobe_state() as state:
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None
        before = dict(state.auth._records)
        # Add then rename a source through the same atomic write path the route uses.
        await state.mutate_prefs(lambda p: p.model_copy(update={"sources": [_src("s1", "Original")]}))
        await state.mutate_prefs(
            lambda p: p.model_copy(update={"sources": [_src("s1", "Renamed")]})
        )
        assert state.prefs.sources[0].display_name == "Renamed"
        # The auth view is byte-identical and the admin still authenticates.
        assert state.auth._records == before
        assert state.auth.authenticate(_SEED_USER, _SEED_PASS) is not None
