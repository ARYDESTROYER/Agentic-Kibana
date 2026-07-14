"""UserStore round-trip tests (F1) — over the fake-ES KV AND the SQLite KV.

Mirrors ``test_memory.py`` (fake KV via ``app_state``) and ``test_state_store_sql.py``
(SQLite via ``SqlKVStore``). Covers: create/get/list/count/delete, upsert via
``save``, case-insensitive username match, ``create_if_absent`` race-safety (only
when empty), ``update`` patching + last_login, the ``credentials`` map (active only),
the last-super-admin guard helper, and durability across store instances.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from app.auth.passwords import hash_password
from app.constants import UserRole
from app.models import User
from app.state import AppState
from app.stores.sql import SqlKVStore, build_async_engine, create_all
from app.stores.users import UserStore


@pytest_asyncio.fixture
async def sql_kv():
    """A fresh in-memory SQLite KV (the shared KV table) for backend-parity tests."""
    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(eng)
    yield SqlKVStore(eng)
    await eng.dispose()


def _h(pw: str = "Pa$$w0rd1") -> str:
    return hash_password(pw)


# --------------------------------------------------------------------------- #
# CRUD over the fake-ES KV (via app_state)
# --------------------------------------------------------------------------- #
async def test_user_store_crud_fake_kv(app_state: AppState) -> None:
    store: UserStore = app_state.users
    # The app_state fixture runs auth OFF, so seeding never fired → empty store.
    assert await store.count() == 0
    assert await store.list() == []

    u1 = await store.create(username="Alice", password_hash=_h(), role=UserRole.SOC_MANAGER.value)
    u2 = await store.create(username="bob", password_hash=_h(), role=UserRole.ANALYST_TIER1.value)
    assert u1.role == UserRole.SOC_MANAGER  # coerced to the enum on the model
    assert await store.count() == 2

    # Case-insensitive get.
    assert (await store.get("alice")) is not None
    assert (await store.get("ALICE")).username == "Alice"
    assert (await store.get("nobody")) is None

    # Duplicate (case-insensitive) create → ValueError.
    with pytest.raises(ValueError):
        await store.create(username="ALICE", password_hash=_h())

    # update: role + active patch (and last_login_at).
    updated = await store.update("bob", role=UserRole.RESPONDER.value, active=False,
                                 last_login_at="2026-06-29T00:00:00Z")
    assert updated is not None
    assert updated.role == UserRole.RESPONDER and updated.active is False
    assert updated.last_login_at == "2026-06-29T00:00:00Z"
    assert await store.update("ghost", role=UserRole.AUDITOR.value) is None

    # credentials() exposes ACTIVE users only (bob is now inactive).
    creds = await store.credentials()
    assert "Alice" in creds and "bob" not in creds

    # delete.
    assert await store.delete("alice") is True
    assert await store.delete("alice") is False
    assert await store.count() == 1


async def test_user_store_save_upsert(app_state: AppState) -> None:
    store: UserStore = app_state.users
    u = User(username="carol", password_hash=_h(), role=UserRole.AUDITOR)
    await store.save(u)
    assert (await store.get("carol")).role == UserRole.AUDITOR
    created_at = (await store.get("carol")).created_at

    # Re-save (upsert) with a new role + hash — replaces in place, preserves created_at.
    u2 = User(username="CAROL", password_hash=_h("Different1!"), role=UserRole.ANALYST_TIER2)
    await store.save(u2)
    got = await store.get("carol")
    assert got.role == UserRole.ANALYST_TIER2
    assert got.created_at == created_at      # preserved
    assert await store.count() == 1          # still one user (upsert, not append)


async def test_create_if_absent_only_when_empty(app_state: AppState) -> None:
    store: UserStore = app_state.users
    created = await store.create_if_absent(
        username="Admin", password_hash=_h(), role=UserRole.SUPER_ADMIN.value,
    )
    assert created is not None and created.username == "Admin"
    # Store is now non-empty → a second create_if_absent is a no-op (returns None).
    again = await store.create_if_absent(username="Mallory", password_hash=_h())
    assert again is None
    assert await store.count() == 1


async def test_count_active_super_admins_guard(app_state: AppState) -> None:
    store: UserStore = app_state.users
    sa = UserRole.SUPER_ADMIN.value
    await store.create(username="root", password_hash=_h(), role=sa)
    await store.create(username="ops", password_hash=_h(), role=UserRole.SOC_MANAGER.value)
    assert await store.count_active_super_admins(super_admin_role=sa) == 1
    await store.create(username="root2", password_hash=_h(), role=sa)
    assert await store.count_active_super_admins(super_admin_role=sa) == 2
    # Disabling one drops the active super-admin count.
    await store.update("root2", active=False)
    assert await store.count_active_super_admins(super_admin_role=sa) == 1


async def test_user_store_persists_across_instances(app_state: AppState) -> None:
    await app_state.users.create(username="dave", password_hash=_h())
    fresh = UserStore(app_state._kv)
    assert {u.username for u in await fresh.list()} == {"dave"}


# --------------------------------------------------------------------------- #
# Backend parity: the SAME store over the SQLite KV table
# --------------------------------------------------------------------------- #
async def test_user_store_sqlite_round_trip(sql_kv) -> None:
    store = UserStore(sql_kv)
    assert await store.count() == 0
    await store.create(username="Eve", password_hash=_h(), role=UserRole.ANALYST_TIER2.value)
    await store.create(username="frank", password_hash=_h())
    assert await store.count() == 2
    assert (await store.get("EVE")).role == UserRole.ANALYST_TIER2
    # Durable across a fresh store over the same KV.
    fresh = UserStore(sql_kv)
    assert {u.username for u in await fresh.list()} == {"Eve", "frank"}
    assert await fresh.delete("eve") is True
    assert await UserStore(sql_kv).count() == 1


async def test_concurrent_user_updates_are_not_clobbered(app_state: AppState) -> None:
    # audit #25: concurrent account changes must not silently clobber each other. With
    # every mutation routed through kv_mutate (per-store lock + _rev CAS), a disable and
    # several parallel role changes all survive instead of last-writer-wins.
    import asyncio

    store: UserStore = app_state.users
    for i in range(10):
        await store.create(username=f"u{i}", password_hash=_h())
    # Concurrently: disable u0 while patching u1..u9's role.
    await asyncio.gather(
        store.update("u0", active=False),
        *[store.update(f"u{i}", role=UserRole.ANALYST_TIER2.value) for i in range(1, 10)],
    )
    u0 = await store.get("u0")
    assert u0 is not None and u0.active is False, "the disable was clobbered"
    for i in range(1, 10):
        assert (await store.get(f"u{i}")).role == UserRole.ANALYST_TIER2
