"""Round 3 Wave 1 KV-stores — offline tests (fake-ES KV + SQLite SQL KV).

Round-trips each of the 8 new KVStore-backed collaboration / notification / RBAC /
pricing / shift-handoff stores on BOTH state backends:

* the in-memory / fake-ES KV (via ``app_state._kv``, the same KV the MEMORY /
  USER_PREFS / SESSIONS stores use), and
* the SQL backend on SQLite (``SqlKVStore`` over the shared KV table).

Running every store over BOTH backends proves the generic KV doc path handles the
new namespaces with NO new index/table/migration (the followup from Wave 0: the SQL
``SqlKVStore`` is generic over (namespace, key), and the ES ``EsKVStore._doc_id``
generic fallback yields a unique doc id per new namespace).
"""

from __future__ import annotations

import pytest

from app.models import (
    ActionItem,
    CaseActivity,
    CaseMessage,
    CustomRole,
    InAppNotification,
    NotificationPref,
)
from app.state import AppState
from app.stores.case_activity import CaseActivityStore
from app.stores.case_tasks import CaseTaskStore
from app.stores.case_thread import CaseThreadStore
from app.stores.custom_roles import CustomRoleStore
from app.stores.inbox import InboxStore, normalize_user_id
from app.stores.notif_prefs import NotificationPrefsStore
from app.stores.price_overlay import PriceOverlayStore
from app.stores.shift_handoff import ShiftHandoffStore


# --------------------------------------------------------------------------- #
# Backend fixtures: one helper to spin a fresh SQLite SqlKVStore.
# --------------------------------------------------------------------------- #
async def _sqlite_kv():
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(eng)
    return SqlKVStore(eng), eng


# --------------------------------------------------------------------------- #
# CaseThreadStore
# --------------------------------------------------------------------------- #
async def _exercise_thread(store: CaseThreadStore) -> None:
    assert await store.list_for_case("c-1") == []

    m1 = await store.append(CaseMessage(case_id="c-1", author="alice", body="first"))
    m2 = await store.append(CaseMessage(case_id="c-1", author="bob", body="second",
                                        parent_id=m1.id))
    # Isolation: a different case has its own (empty) thread.
    assert await store.list_for_case("c-2") == []

    msgs = await store.list_for_case("c-1")
    assert [m.id for m in msgs] == [m1.id, m2.id]  # insertion order
    assert (await store.get("c-1", m1.id)).body == "first"

    # Edit stamps edited_at.
    edited = await store.edit("c-1", m1.id, "first (edited)", editor="alice")
    assert edited is not None and edited.body == "first (edited)" and edited.edited_at

    # React (idempotent add + remove).
    reacted = await store.react("c-1", m2.id, "👍", "carol")
    assert reacted is not None and len(reacted.reactions) == 1
    again = await store.react("c-1", m2.id, "👍", "carol")  # no double
    assert len(again.reactions) == 1
    removed = await store.react("c-1", m2.id, "👍", "carol", remove=True)
    assert removed.reactions == []

    # Delete is a tombstone (row stays, body cleared).
    tomb = await store.delete("c-1", m1.id)
    assert tomb is not None and tomb.deleted_at and tomb.body == ""
    assert len(await store.list_for_case("c-1")) == 2  # still 2 rows
    # Editing a tombstoned message is a no-op.
    assert await store.edit("c-1", m1.id, "nope") is None

    assert await store.delete_case("c-1") is True
    assert await store.delete_case("c-1") is False


async def test_case_thread_fake(app_state: AppState) -> None:
    await _exercise_thread(CaseThreadStore(app_state._kv))


async def test_case_thread_sqlite() -> None:
    kv, eng = await _sqlite_kv()
    try:
        await _exercise_thread(CaseThreadStore(kv))
    finally:
        await eng.dispose()


# --------------------------------------------------------------------------- #
# CaseActivityStore (append-only)
# --------------------------------------------------------------------------- #
async def _exercise_activity(store: CaseActivityStore) -> None:
    assert await store.list_for_case("c-1") == []
    await store.append(CaseActivity(case_id="c-1", kind="assigned", actor="alice",
                                    summary="assigned to bob"))
    await store.append(CaseActivity(case_id="c-1", kind="commented", actor="bob",
                                    summary="left a note"))
    # Newest first by default.
    feed = await store.list_for_case("c-1")
    assert [a.kind for a in feed] == ["commented", "assigned"]
    # Oldest-first + limit.
    chron = await store.list_for_case("c-1", newest_first=False, limit=1)
    assert [a.kind for a in chron] == ["assigned"]
    assert await store.list_for_case("c-2") == []  # isolation
    assert await store.delete_case("c-1") is True


async def test_case_activity_fake(app_state: AppState) -> None:
    await _exercise_activity(CaseActivityStore(app_state._kv))


async def test_case_activity_sqlite() -> None:
    kv, eng = await _sqlite_kv()
    try:
        await _exercise_activity(CaseActivityStore(kv))
    finally:
        await eng.dispose()


# --------------------------------------------------------------------------- #
# CaseTaskStore (CRUD + reorder + log)
# --------------------------------------------------------------------------- #
async def _exercise_tasks(store: CaseTaskStore) -> None:
    t1 = await store.add("c-1", "Collect host triage", assignee="alice")
    t2 = await store.add("c-1", "Pull EDR timeline")
    t3 = await store.add("c-1", "Notify owner")
    assert [t.order for t in await store.list_for_case("c-1")] == [0, 1, 2]

    upd = await store.update("c-1", t1.id, status="done")
    assert upd is not None and upd.status == "done"
    # An invalid status is ignored.
    assert (await store.update("c-1", t1.id, status="bogus")).status == "done"

    # Reorder by id sequence.
    reordered = await store.reorder("c-1", [t3.id, t1.id, t2.id])
    assert [t.id for t in reordered] == [t3.id, t1.id, t2.id]

    # Append-only log trail.
    logged = await store.log("c-1", t2.id, "ran the collector", by="bob")
    assert logged is not None and logged.logs[-1]["note"] == "ran the collector"

    assert await store.delete("c-1", t2.id) is True
    assert await store.delete("c-1", t2.id) is False
    assert {t.id for t in await store.list_for_case("c-1")} == {t1.id, t3.id}
    assert await store.delete_case("c-1") is True


async def test_case_tasks_fake(app_state: AppState) -> None:
    await _exercise_tasks(CaseTaskStore(app_state._kv))


async def test_case_tasks_sqlite() -> None:
    kv, eng = await _sqlite_kv()
    try:
        await _exercise_tasks(CaseTaskStore(kv))
    finally:
        await eng.dispose()


# --------------------------------------------------------------------------- #
# InboxStore (per-user fan-out + read lifecycle + ring trim)
# --------------------------------------------------------------------------- #
async def _exercise_inbox(store: InboxStore) -> None:
    # auth-off recipient → the default bucket.
    n1 = await store.append(InAppNotification(recipient="alice", category="case_new",
                                              title="New case", body="case-1"))
    await store.append(InAppNotification(recipient="alice", category="mention",
                                         title="You were mentioned", body="@alice"))
    await store.append(InAppNotification(recipient="bob", category="system",
                                         title="System", body="hi bob"))
    assert await store.unread_count("alice") == 2
    assert await store.unread_count("bob") == 1  # isolation

    items, total = await store.list_for_user("alice")
    assert total == 2 and items[0].title == "You were mentioned"  # newest first

    # Mark one read → unread drops.
    assert (await store.mark_read("alice", n1.id)).state == "read"
    assert await store.unread_count("alice") == 1
    only_unread, _ = await store.list_for_user("alice", unread_only=True)
    assert all(i.state in ("unseen", "seen") for i in only_unread)

    # Mark all read.
    assert await store.mark_all_read("alice") == 1
    assert await store.unread_count("alice") == 0

    # Archive hides from default view.
    arch = await store.append(InAppNotification(recipient="alice", title="later"))
    await store.archive("alice", arch.id)
    visible, _ = await store.list_for_user("alice")
    assert arch.id not in {i.id for i in visible}

    # Dismiss drops permanently.
    d = await store.append(InAppNotification(recipient="alice", title="dismiss me"))
    assert await store.dismiss("alice", d.id) is True
    assert await store.dismiss("alice", d.id) is False

    # fanout helper.
    created = await store.fanout(
        ["x", "y"],
        lambda r: InAppNotification(recipient=r, category="approval", title="approve"),
    )
    assert len(created) == 2
    assert await store.unread_count("x") == 1 and await store.unread_count("y") == 1

    # Ring is bounded (~200): push past the cap, oldest trimmed.
    for i in range(210):
        await store.append(InAppNotification(recipient="ringer", title=f"n{i}"))
    _, ring_total = await store.list_for_user("ringer", limit=1000)
    assert ring_total <= 200


async def test_inbox_fake(app_state: AppState) -> None:
    await _exercise_inbox(InboxStore(app_state._kv))


async def test_inbox_sqlite() -> None:
    kv, eng = await _sqlite_kv()
    try:
        await _exercise_inbox(InboxStore(kv))
    finally:
        await eng.dispose()


def test_inbox_normalize_user_id() -> None:
    assert normalize_user_id(None) == "default"
    assert normalize_user_id("  Alice ") == "alice"


# --------------------------------------------------------------------------- #
# NotificationPrefsStore
# --------------------------------------------------------------------------- #
async def _exercise_notif_prefs(store: NotificationPrefsStore) -> None:
    # Unseen user → sane default.
    d = await store.get(None)
    assert isinstance(d, NotificationPref) and d.user == "default" and d.digest == "off"

    pref = NotificationPref(
        user="ignored-overwritten",
        categories={"case_new": {"channels": ["inbox", "email"], "enabled": True}},
        digest="daily",
    )
    saved = await store.put("alice", pref)
    assert saved.user == "alice"  # forced to normalised id
    assert (await store.get("alice")).digest == "daily"
    # Isolation.
    assert (await store.get("bob")).digest == "off"

    patched = await store.patch("alice", digest="hourly",
                                quiet_hours={"start": "22:00", "end": "07:00"})
    assert patched.digest == "hourly" and patched.quiet_hours["start"] == "22:00"
    assert isinstance(patched, NotificationPref)

    assert await store.delete("alice") is True
    assert (await store.get("alice")).digest == "off"  # back to default


async def test_notif_prefs_fake(app_state: AppState) -> None:
    await _exercise_notif_prefs(NotificationPrefsStore(app_state._kv))


async def test_notif_prefs_sqlite() -> None:
    kv, eng = await _sqlite_kv()
    try:
        await _exercise_notif_prefs(NotificationPrefsStore(kv))
    finally:
        await eng.dispose()


# --------------------------------------------------------------------------- #
# CustomRoleStore
# --------------------------------------------------------------------------- #
async def _exercise_custom_roles(store: CustomRoleStore) -> None:
    assert await store.list() == []

    # put accepts a loose dict (validated into CustomRole).
    r = await store.put({
        "name": "IR-Lead",
        "description": "incident lead",
        "inherits": ["analyst_tier2"],
        "grants": {"cases": ["escalate", "assign"]},
        "denies": {"settings": ["manage"]},
    })
    assert isinstance(r, CustomRole) and r.name == "IR-Lead"
    assert (await store.get("ir-lead")).grants["cases"] == ["escalate", "assign"]  # case-insensitive

    # Upsert by name (case-insensitive) replaces, not duplicates.
    await store.put(CustomRole(name="ir-lead", description="updated"))
    roles = await store.list()
    assert len(roles) == 1 and roles[0].description == "updated"

    # Empty name → ValueError (caller error).
    with pytest.raises(ValueError):
        await store.put({"name": "  "})

    assert await store.delete("IR-Lead") is True
    assert await store.delete("IR-Lead") is False


async def test_custom_roles_fake(app_state: AppState) -> None:
    await _exercise_custom_roles(CustomRoleStore(app_state._kv))


async def test_custom_roles_sqlite() -> None:
    kv, eng = await _sqlite_kv()
    try:
        await _exercise_custom_roles(CustomRoleStore(kv))
    finally:
        await eng.dispose()


# --------------------------------------------------------------------------- #
# PriceOverlayStore
# --------------------------------------------------------------------------- #
async def _exercise_price_overlay(store: PriceOverlayStore) -> None:
    assert await store.get() == {}
    assert await store.get_model("claude-opus-4-8") is None
    assert await store.as_price_tuple("claude-opus-4-8") is None

    row = await store.set_price("claude-opus-4-8", 12.0, 60.0)
    assert row == {"input": 12.0, "output": 60.0}
    assert await store.get_model("claude-opus-4-8") == {"input": 12.0, "output": 60.0}
    assert await store.as_price_tuple("claude-opus-4-8") == (12.0, 60.0)

    # Negative / non-numeric rate → ValueError; empty model → ValueError.
    with pytest.raises(ValueError):
        await store.set_price("m", -1.0, 1.0)
    with pytest.raises(ValueError):
        await store.set_price("", 1.0, 1.0)

    # Replace the whole map (an invalid entry is skipped, valid kept).
    bucket = await store.put({
        "gpt-5": {"input": 1.0, "output": 8.0},
        "bad": {"input": -5.0, "output": 1.0},  # skipped
    })
    assert "gpt-5" in bucket and "bad" not in bucket

    assert await store.delete("gpt-5") is True
    assert await store.delete("gpt-5") is False


async def test_price_overlay_fake(app_state: AppState) -> None:
    await _exercise_price_overlay(PriceOverlayStore(app_state._kv))


async def test_price_overlay_sqlite() -> None:
    kv, eng = await _sqlite_kv()
    try:
        await _exercise_price_overlay(PriceOverlayStore(kv))
    finally:
        await eng.dispose()


# --------------------------------------------------------------------------- #
# ShiftHandoffStore (ActionItem CRUD + append-only ShiftAck)
# --------------------------------------------------------------------------- #
async def _exercise_shift_handoff(store: ShiftHandoffStore) -> None:
    assert await store.list_action_items() == []

    a1 = await store.add_action_item("Chase open case-12", owner="alice")
    a2 = await store.add_action_item("Review nightly scan")
    assert {i.id for i in await store.list_action_items()} == {a1.id, a2.id}

    upd = await store.update_action_item(a1.id, status="done")
    assert upd is not None and upd.status == "done"
    assert [i.id for i in await store.list_action_items(open_only=True)] == [a2.id]
    assert isinstance(await store.get_action_item(a2.id), ActionItem)

    assert await store.delete_action_item(a2.id) is True
    assert await store.delete_action_item(a2.id) is False

    # Append-only acks.
    await store.acknowledge("alice", "2026-06-30/day", note="all clear")
    await store.acknowledge("bob", "2026-06-30/day")
    await store.acknowledge("alice", "2026-06-30/night")
    assert await store.has_acked("alice", "2026-06-30/day") is True
    assert await store.has_acked("carol", "2026-06-30/day") is False

    day = await store.list_acks(window="2026-06-30/day")
    assert {a.user for a in day} == {"alice", "bob"}
    alice = await store.list_acks(user="ALICE")  # case-insensitive
    assert {a.window for a in alice} == {"2026-06-30/day", "2026-06-30/night"}


async def test_shift_handoff_fake(app_state: AppState) -> None:
    await _exercise_shift_handoff(ShiftHandoffStore(app_state._kv))


async def test_shift_handoff_sqlite() -> None:
    kv, eng = await _sqlite_kv()
    try:
        await _exercise_shift_handoff(ShiftHandoffStore(kv))
    finally:
        await eng.dispose()


# --------------------------------------------------------------------------- #
# Generic KV path: the new namespaces flow through BOTH backends with distinct,
# non-colliding doc ids (no special-casing needed) — the Wave 0 followup.
# --------------------------------------------------------------------------- #
async def test_new_namespaces_isolated_in_fake_kv(app_state: AppState) -> None:
    # Each store writes to its OWN namespace; they never clobber each other.
    kv = app_state._kv
    await CaseThreadStore(kv).append(CaseMessage(case_id="c", body="x"))
    await CaseActivityStore(kv).append(CaseActivity(case_id="c", kind="k"))
    await CaseTaskStore(kv).add("c", "t")
    await InboxStore(kv).append(InAppNotification(recipient="u", title="n"))
    await NotificationPrefsStore(kv).put("u", NotificationPref())
    await CustomRoleStore(kv).put({"name": "R"})
    await PriceOverlayStore(kv).set_price("m", 1.0, 2.0)
    await ShiftHandoffStore(kv).add_action_item("ai")

    # Re-read each independently — every namespace persisted distinctly.
    assert len(await CaseThreadStore(kv).list_for_case("c")) == 1
    assert len(await CaseActivityStore(kv).list_for_case("c")) == 1
    assert len(await CaseTaskStore(kv).list_for_case("c")) == 1
    assert (await InboxStore(kv).unread_count("u")) == 1
    assert (await NotificationPrefsStore(kv).get("u")).user == "u"
    assert len(await CustomRoleStore(kv).list()) == 1
    assert (await PriceOverlayStore(kv).get_model("m")) == {"input": 1.0, "output": 2.0}
    assert len(await ShiftHandoffStore(kv).list_action_items()) == 1


async def test_es_kv_doc_ids_distinct_for_new_namespaces() -> None:
    # The ES EsKVStore._doc_id generic fallback yields a UNIQUE doc id per new
    # namespace (no collision with each other or with the existing singletons).
    from app.constants import (
        CASE_ACTIVITY_KEY,
        CASE_ACTIVITY_NS,
        CASE_TASKS_KEY,
        CASE_TASKS_NS,
        CASE_THREAD_KEY,
        CASE_THREAD_NS,
        CUSTOM_ROLES_KEY,
        CUSTOM_ROLES_NS,
        INBOX_KEY,
        INBOX_NS,
        NOTIF_PREFS_KEY,
        NOTIF_PREFS_NS,
        PRICE_OVERLAY_KEY,
        PRICE_OVERLAY_NS,
        SHIFT_HANDOFF_KEY,
        SHIFT_HANDOFF_NS,
    )
    from app.stores.memory import EsKVStore

    triples = [
        (CASE_THREAD_NS, CASE_THREAD_KEY),
        (CASE_ACTIVITY_NS, CASE_ACTIVITY_KEY),
        (CASE_TASKS_NS, CASE_TASKS_KEY),
        (INBOX_NS, INBOX_KEY),
        (NOTIF_PREFS_NS, NOTIF_PREFS_KEY),
        (CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY),
        (PRICE_OVERLAY_NS, PRICE_OVERLAY_KEY),
        (SHIFT_HANDOFF_NS, SHIFT_HANDOFF_KEY),
    ]
    ids = {EsKVStore._doc_id(ns, key) for ns, key in triples}
    assert len(ids) == len(triples)  # all distinct
