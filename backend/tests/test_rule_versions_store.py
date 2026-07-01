"""Rule-version ledger store (Round 5 / G6 R5) — offline tests.

Covers the :class:`app.stores.rule_versions.RuleVersionStore` contract: zero-migration
load (an empty/legacy KV loads cleanly), per-(kind, rule_id) scoping, append-only
immutable history, CAS lost-update safety (concurrent version writes both land), the
per-rule backstop trim, and the SAME store over the SQLite backend (no new table). The
store is a config-adjacent audit ledger only — it never feeds ``case_manager.decide()``
(#3) — so there is nothing pipeline-adjacent to test.
"""

from __future__ import annotations

import asyncio

from app.state import AppState
from app.stores.rule_versions import (
    _MAX_VERSIONS_PER_RULE,
    RuleVersion,
    RuleVersionStore,
)


def _cfg(name: str, *, enabled: bool = True) -> dict:
    return {"name": name, "enabled": enabled, "match": {"field": "rule.name", "op": "equals", "value": name}}


# --------------------------------------------------------------------------- #
# Zero-migration load + append-only round-trip (fake-ES via app_state)
# --------------------------------------------------------------------------- #
async def test_zero_migration_empty_load(app_state: AppState) -> None:
    store: RuleVersionStore = app_state.rule_versions
    # A brand-new backend has NO ledger doc → empty list, no raise, no migration.
    assert await store.list() == []
    assert await store.list(kind="detection", rule_id="nope") == []
    assert await store.get("rv-nope") is None
    assert await store.latest("detection", "nope") is None


async def test_append_and_list_newest_first(app_state: AppState) -> None:
    store: RuleVersionStore = app_state.rule_versions

    v1 = await store.record(
        kind="detection", rule_id="brute_force", config=_cfg("brute_force"),
        action="create", actor="alice", summary="created",
    )
    v2 = await store.record(
        kind="detection", rule_id="brute_force", config=_cfg("brute_force", enabled=False),
        action="disable", actor="bob", summary="disabled",
    )
    assert v1.id != v2.id and v1.id.startswith("rv-")

    versions = await store.list(kind="detection", rule_id="brute_force")
    # Newest-first ordering.
    assert [v.id for v in versions] == [v2.id, v1.id]
    # The WHOLE config was snapshotted (not one field).
    assert versions[0].config["enabled"] is False
    assert versions[1].config["enabled"] is True
    # latest() returns the most recent snapshot (the current baseline).
    latest = await store.latest("detection", "brute_force")
    assert latest is not None and latest.id == v2.id


async def test_per_kind_and_rule_scoping(app_state: AppState) -> None:
    store: RuleVersionStore = app_state.rule_versions
    await store.record(kind="detection", rule_id="r1", config=_cfg("r1"), action="create")
    await store.record(kind="correlation", rule_id="r1", config={"n": 5}, action="create")
    await store.record(kind="case_automation", rule_id="a1", config={"id": "a1"}, action="create")

    # Same rule_id "r1" in two DIFFERENT kinds is isolated by kind.
    det = await store.list(kind="detection", rule_id="r1")
    corr = await store.list(kind="correlation", rule_id="r1")
    assert len(det) == 1 and det[0].kind == "detection"
    assert len(corr) == 1 and corr[0].kind == "correlation"
    # An unscoped list returns all three.
    assert len(await store.list()) == 3


# --------------------------------------------------------------------------- #
# CAS lost-update safety (concurrent version writes both land)
# --------------------------------------------------------------------------- #
async def test_concurrent_appends_are_cas_safe(app_state: AppState) -> None:
    store: RuleVersionStore = app_state.rule_versions
    # Two versions for the same rule + one for another, written concurrently, must ALL
    # persist (the kv_mutate CAS retry closes the read-modify-write lost-update window).
    await asyncio.gather(
        store.record(kind="detection", rule_id="r1", config=_cfg("r1"), action="create"),
        store.record(kind="detection", rule_id="r1", config=_cfg("r1", enabled=False), action="disable"),
        store.record(kind="correlation", rule_id="c1", config={"n": 3}, action="create"),
    )
    assert len(await store.list(kind="detection", rule_id="r1")) == 2
    assert len(await store.list(kind="correlation", rule_id="c1")) == 1


async def test_per_rule_backstop_trim(app_state: AppState) -> None:
    store: RuleVersionStore = app_state.rule_versions
    # Sequential monotonic created_at so the trim keeps the newest N deterministically.
    for n in range(_MAX_VERSIONS_PER_RULE + 5):
        await store.add(RuleVersion(
            kind="detection", rule_id="hot", config=_cfg("hot"), action="update",
            created_at=f"2026-07-02T00:00:{n:02d}+00:00",
        ))
    # A different rule keeps its own (untrimmed) small history.
    await store.record(kind="detection", rule_id="cool", config=_cfg("cool"), action="create")

    hot = await store.list(kind="detection", rule_id="hot")
    assert len(hot) == _MAX_VERSIONS_PER_RULE  # oldest trimmed
    assert len(await store.list(kind="detection", rule_id="cool")) == 1  # untouched


async def test_corrupt_entry_skipped_not_fatal(app_state: AppState) -> None:
    # A single corrupt version in the doc is skipped; the rest load (the store degrades
    # rather than raising a page-breaking error).
    from app.stores.rule_versions import RULE_VERSIONS_KEY, RULE_VERSIONS_NS

    store: RuleVersionStore = app_state.rule_versions
    good = await store.record(kind="detection", rule_id="r1", config=_cfg("r1"), action="create")

    kv = app_state._kv
    doc = await kv.get(RULE_VERSIONS_NS, RULE_VERSIONS_KEY)
    doc["versions"].append("not-a-dict")  # inject junk
    await kv.put(RULE_VERSIONS_NS, RULE_VERSIONS_KEY, doc)

    versions = await store.list(kind="detection", rule_id="r1")
    assert [v.id for v in versions] == [good.id]  # bad one dropped, good one survives


# --------------------------------------------------------------------------- #
# SQL state backend (SQLite) — the SAME store over SqlKVStore, no new table.
# --------------------------------------------------------------------------- #
async def test_rule_versions_store_on_sqlite() -> None:
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(eng)
    try:
        store = RuleVersionStore(SqlKVStore(eng))
        assert await store.list() == []  # zero-migration empty load through SQLite

        v = await store.record(kind="correlation", rule_id="c1", config={"n": 7}, action="create")
        # Persists across reloads (a fresh store over the same engine).
        store2 = RuleVersionStore(SqlKVStore(eng))
        got = await store2.get(v.id)
        assert got is not None and got.config["n"] == 7 and got.kind == "correlation"
    finally:
        await eng.dispose()
