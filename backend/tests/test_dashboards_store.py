"""Custom-dashboard store (Round 5 / G7) — offline tests.

Covers the :class:`app.stores.dashboards.DashboardStore` contract: zero-migration
load (an empty/legacy KV loads cleanly), per-user isolation, CRUD round-trip on BOTH
state backends (fake-ES via ``app_state`` + SQLite via ``SqlKVStore``), CAS
lost-update safety (concurrent saves both land), the per-user backstop cap, and the
``schema_version`` stamp. The store is advisory presentation state only — it never
feeds ``case_manager.decide()`` (#3) — so there is nothing pipeline-adjacent to test.
"""

from __future__ import annotations

import asyncio

from app.models import DashboardLayout, DashboardWidget
from app.state import AppState
from app.stores.dashboards import DashboardStore, normalize_user_id


def _layout(name: str, *, id: str | None = None, widgets: int = 1) -> DashboardLayout:
    ws = [
        DashboardWidget(i=f"w{n}", type="kpi", x=n, y=0, w=4, h=4, options={"title": f"KPI {n}"})
        for n in range(widgets)
    ]
    kwargs: dict = {"name": name, "widgets": ws}
    if id is not None:
        kwargs["id"] = id
    return DashboardLayout(**kwargs)


# --------------------------------------------------------------------------- #
# Zero-migration load + CRUD round-trip (fake-ES via app_state)
# --------------------------------------------------------------------------- #
async def test_zero_migration_empty_load(app_state: AppState) -> None:
    store: DashboardStore = app_state.dashboards
    # A brand-new backend has NO dashboards doc → an empty list, no raise, no migration.
    assert await store.list_for_user("alice") == []
    assert await store.get("alice", "dash-nope") is None


async def test_dashboard_crud_roundtrip(app_state: AppState) -> None:
    store: DashboardStore = app_state.dashboards

    saved = await store.save("alice", _layout("My board", widgets=2))
    assert saved.id and saved.name == "My board"
    assert saved.schema_version == 1  # stamped from day one
    assert [w.i for w in saved.widgets] == ["w0", "w1"]

    # Read back the exact persisted layout (widget geometry survives the JSON round-trip).
    got = await store.get("alice", saved.id)
    assert got is not None
    assert got.widgets[0].x == 0 and got.widgets[1].w == 4
    assert got.widgets[1].options == {"title": "KPI 1"}

    # Replace preserves created_at, advances updated_at, keeps the id.
    replaced = await store.save(
        "alice", saved.model_copy(update={"name": "Renamed", "updated_at": "x"})
    )
    assert replaced.id == saved.id and replaced.name == "Renamed"
    assert replaced.created_at == saved.created_at

    assert await store.list_for_user("alice") and len(await store.list_for_user("alice")) == 1

    assert await store.delete("alice", saved.id) is True
    assert await store.delete("alice", saved.id) is False  # already gone
    assert await store.list_for_user("alice") == []


async def test_per_user_isolation(app_state: AppState) -> None:
    store: DashboardStore = app_state.dashboards
    await store.save("alice", _layout("Alice board"))
    await store.save("bob", _layout("Bob board"))
    await store.save(None, _layout("Default-bucket board"))  # auth-off principal

    assert [d.name for d in await store.list_for_user("alice")] == ["Alice board"]
    assert [d.name for d in await store.list_for_user("bob")] == ["Bob board"]
    # None → the shared 'default' bucket; isolated from named users.
    assert [d.name for d in await store.list_for_user(None)] == ["Default-bucket board"]
    assert [d.name for d in await store.list_for_user("default")] == ["Default-bucket board"]

    # Clearing one user leaves the others untouched.
    assert await store.clear("alice") == 1
    assert await store.list_for_user("alice") == []
    assert len(await store.list_for_user("bob")) == 1


def test_normalize_user_id() -> None:
    assert normalize_user_id(None) == "default"
    assert normalize_user_id("") == "default"
    assert normalize_user_id("  Alice ") == "alice"  # trimmed + lowercased


# --------------------------------------------------------------------------- #
# CAS lost-update safety (concurrent saves both land)
# --------------------------------------------------------------------------- #
async def test_concurrent_saves_are_cas_safe(app_state: AppState) -> None:
    store: DashboardStore = app_state.dashboards
    # Two DIFFERENT dashboards saved concurrently for the same user must BOTH persist
    # (the kv_mutate CAS retry closes the read-modify-write lost-update window).
    await asyncio.gather(
        store.save("carol", _layout("Board A", id="dash-a")),
        store.save("carol", _layout("Board B", id="dash-b")),
        store.save("dave", _layout("Other user")),  # a different bucket, same doc
    )
    carol = {d.id for d in await store.list_for_user("carol")}
    assert carol == {"dash-a", "dash-b"}
    assert len(await store.list_for_user("dave")) == 1


async def test_per_user_cap_backstop(app_state: AppState) -> None:
    from app.stores.dashboards import _MAX_PER_USER

    store: DashboardStore = app_state.dashboards
    for n in range(_MAX_PER_USER + 5):
        await store.save("erin", _layout(f"b{n}", id=f"dash-{n:03d}"))
    boards = await store.list_for_user("erin")
    assert len(boards) == _MAX_PER_USER  # oldest-created trimmed


async def test_corrupt_entry_skipped_not_fatal(app_state: AppState) -> None:
    # A single corrupt dashboard in the doc is skipped; the rest load. Proves the
    # store degrades rather than raising a page-breaking error.
    from app.constants import DASHBOARDS_KEY, DASHBOARDS_NS

    store: DashboardStore = app_state.dashboards
    good = await store.save("frank", _layout("Good board", id="dash-ok"))
    # Inject a malformed sibling directly into the KV doc.
    kv = app_state._kv
    doc = await kv.get(DASHBOARDS_NS, DASHBOARDS_KEY)
    doc["dashboards"]["frank"]["dash-bad"] = {"widgets": "not-a-list"}
    await kv.put(DASHBOARDS_NS, DASHBOARDS_KEY, doc)

    boards = await store.list_for_user("frank")
    assert [d.id for d in boards] == [good.id]  # bad one dropped, good one survives


# --------------------------------------------------------------------------- #
# SQL state backend (SQLite) — the SAME DashboardStore over SqlKVStore. Proves the
# store is backend-agnostic with NO new table (it reuses the shared KV table).
# --------------------------------------------------------------------------- #
async def test_dashboard_store_on_sqlite() -> None:
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(eng)
    try:
        store = DashboardStore(SqlKVStore(eng))

        # Zero-migration: empty load through SQLite, no new table needed.
        assert await store.list_for_user("carol") == []

        saved = await store.save("carol", _layout("Sqlite board", widgets=2))
        # Persists across reloads (a fresh store over the same engine).
        store2 = DashboardStore(SqlKVStore(eng))
        got = await store2.get("carol", saved.id)
        assert got is not None and got.name == "Sqlite board"
        assert len(got.widgets) == 2 and got.schema_version == 1

        assert await store2.delete("carol", saved.id) is True
        assert await store2.list_for_user("carol") == []
    finally:
        await eng.dispose()
