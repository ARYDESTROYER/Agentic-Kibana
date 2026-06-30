"""Round 3 Wave 5 — KV-store concurrency + user-delete cleanup + quiet-hours tz.

Locks the Wave-5 fixes for the kv-stores + inapp-notifications dimensions:

* **Lost-update concurrency (MEDIUM x2).** Every shared single-document KV store
  (inbox + the 7 sibling Round-3 stores) now routes its read-modify-write through
  :func:`app.stores.base.kv_mutate` — a per-key :class:`asyncio.Lock` plus a
  ``_rev`` compare-and-set retry. Two concurrent writers on the SAME doc must BOTH
  survive (no silent clobber). The tests force the interleave with a yielding,
  snapshot-isolated ``SlowKV`` (and re-run the core case on the real SQLite
  ``SqlKVStore``) so they exercise the exact race the production ES/SQL backends
  produce — NOT the fake ES whose get/put don't await.

* **User-delete cleanup (MEDIUM).** Deleting a user must clear their inbox +
  notification prefs so a re-created same-name user can't inherit them. Driven via
  :meth:`app.auth.service.AuthService.purge_user_side_state` (the wiring hook the
  delete route calls).

* **Quiet-hours timezone (LOW).** ``_in_quiet_hours`` evaluates the window in the
  user's ``tz`` (IANA), not server UTC; a bad/blank tz falls back to UTC.

* **Digest/quiet-hours deferral (LOW).** A role-tier recipient on a digest cadence
  / in quiet-hours is no longer a silent DROP — the item is HELD in a per-user
  pending-digest buffer and can be flushed.

Fully offline: in-memory + SQLite KV; no network, no real LLM. The non-negotiables
are untouched — these stores are advisory (never feed ``case_manager.decide()`` #3)
and every stored title/body stays plain data (#9).
"""

from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timezone

import pytest

from app.auth.service import AuthService
from app.models import (
    ActionItem,
    CaseActivity,
    CaseMessage,
    CaseTask,
    CustomRole,
    InAppNotification,
    NotificationPref,
)
from app.notifications.dispatch import NotificationService, _in_quiet_hours
from app.stores.base import KV_REV_FIELD, kv_mutate
from app.stores.case_activity import CaseActivityStore
from app.stores.case_tasks import CaseTaskStore
from app.stores.case_thread import CaseThreadStore
from app.stores.custom_roles import CustomRoleStore
from app.stores.inbox import InboxStore
from app.stores.notif_prefs import NotificationPrefsStore
from app.stores.price_overlay import PriceOverlayStore
from app.stores.shift_handoff import ShiftHandoffStore

# asyncio_mode = "auto" (pyproject) runs the async tests without an explicit marker.


# --------------------------------------------------------------------------- #
# A yielding, snapshot-isolated KVStore that REPRODUCES the real backend race.
#
# The fake ES / trivial dict KVs in the other test modules don't `await` inside
# get/put, so two gathered coroutines run to completion one-after-another and never
# interleave — they can't surface the lost-update bug. SlowKV mirrors the real ES /
# SQL round-trip: get/put yield to the loop (await asyncio.sleep(0)) AND each caller
# gets its OWN deepcopy snapshot (so an unguarded read-modify-write clobbers).
# --------------------------------------------------------------------------- #
class SlowKV:
    def __init__(self) -> None:
        self._store: dict[tuple[str, str], dict] = {}
        self.put_calls = 0

    async def get(self, ns: str, key: str):
        await asyncio.sleep(0)
        val = self._store.get((ns, key))
        return copy.deepcopy(val) if val is not None else None

    async def put(self, ns: str, key: str, value: dict) -> None:
        await asyncio.sleep(0)
        self.put_calls += 1
        self._store[(ns, key)] = copy.deepcopy(value)


async def _sqlite_kv():
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(eng)
    return SqlKVStore(eng), eng


# --------------------------------------------------------------------------- #
# 1. kv_mutate primitive — CAS revision + never-raise degrade.
# --------------------------------------------------------------------------- #
async def test_kv_mutate_stamps_and_bumps_rev() -> None:
    kv = SlowKV()
    lock = asyncio.Lock()
    v1 = await kv_mutate(kv, "ns", "k", lambda cur: {"n": 1}, lock=lock)
    assert v1[KV_REV_FIELD] == 1 and v1["n"] == 1
    v2 = await kv_mutate(kv, "ns", "k", lambda cur: {"n": (cur or {}).get("n", 0) + 1}, lock=lock)
    assert v2[KV_REV_FIELD] == 2 and v2["n"] == 2


async def test_kv_mutate_never_raises_on_backend_glitch() -> None:
    class BoomKV:
        async def get(self, ns, key):
            raise RuntimeError("read boom")

        async def put(self, ns, key, value):
            raise RuntimeError("write boom")

    # A get + put that both raise must degrade (the value is still computed/returned),
    # never propagate — the stores' degrade-don't-drop contract.
    out = await kv_mutate(BoomKV(), "ns", "k", lambda cur: {"n": 1}, lock=asyncio.Lock())
    assert out["n"] == 1  # mutator ran; the write was best-effort-swallowed


# --------------------------------------------------------------------------- #
# 2. Lost-update race — concurrent appends to ONE shared inbox doc.
# --------------------------------------------------------------------------- #
async def test_concurrent_appends_distinct_users_both_survive() -> None:
    inbox = InboxStore(SlowKV())
    await asyncio.gather(
        inbox.append(InAppNotification(recipient="alice", title="a", body="a", category="system")),
        inbox.append(InAppNotification(recipient="bob", title="b", body="b", category="system")),
    )
    # Cross-user clobber guard: BOTH users keep their item.
    assert await inbox.unread_count("alice") == 1
    assert await inbox.unread_count("bob") == 1


async def test_concurrent_appends_same_user_both_survive() -> None:
    inbox = InboxStore(SlowKV())
    await asyncio.gather(
        inbox.append(InAppNotification(recipient="alice", title="a1", body="x", category="system")),
        inbox.append(InAppNotification(recipient="alice", title="a2", body="y", category="system")),
    )
    # Same-bucket lost-update guard: both appends land (today's bug drops one).
    assert await inbox.unread_count("alice") == 2
    items, total = await inbox.list_for_user("alice")
    titles = {n.title for n in items}
    assert total == 2 and titles == {"a1", "a2"}


async def test_many_concurrent_appends_none_lost() -> None:
    inbox = InboxStore(SlowKV())
    n = 25
    await asyncio.gather(*[
        inbox.append(InAppNotification(recipient="dan", title=f"t{i}", body="b", category="system"))
        for i in range(n)
    ])
    assert await inbox.unread_count("dan") == n


async def test_mark_all_read_vs_append_no_lost_stamp() -> None:
    inbox = InboxStore(SlowKV())
    await inbox.append(InAppNotification(recipient="dan", title="old", body="b", category="system"))
    # Concurrent: mark the existing unread read WHILE a new unread arrives.
    await asyncio.gather(
        inbox.mark_all_read("dan"),
        inbox.append(InAppNotification(recipient="dan", title="new", body="b", category="system")),
    )
    items, total = await inbox.list_for_user("dan")
    by_title = {n.title: n for n in items}
    assert total == 2  # neither write was lost
    assert by_title["old"].state == "read"  # the read-stamp survived the append
    # The new item is present (its unseen state is acceptable; whether it raced in
    # before or after the mark depends on interleave — but it must EXIST).
    assert "new" in by_title


async def test_concurrent_appends_survive_on_real_sqlite_kv() -> None:
    kv, eng = await _sqlite_kv()
    try:
        inbox = InboxStore(kv)
        await asyncio.gather(
            inbox.append(InAppNotification(recipient="alice", title="a", body="a", category="system")),
            inbox.append(InAppNotification(recipient="alice", title="b", body="b", category="system")),
        )
        assert await inbox.unread_count("alice") == 2
    finally:
        await eng.dispose()


# --------------------------------------------------------------------------- #
# 3. The lock+CAS applies to EVERY sibling store (append/add for each).
# --------------------------------------------------------------------------- #
async def test_concurrent_thread_appends_both_survive() -> None:
    store = CaseThreadStore(SlowKV())
    await asyncio.gather(
        store.append(CaseMessage(case_id="c", author="a", body="one")),
        store.append(CaseMessage(case_id="c", author="b", body="two")),
    )
    msgs = await store.list_for_case("c")
    assert {m.body for m in msgs} == {"one", "two"}


async def test_concurrent_activity_appends_both_survive() -> None:
    store = CaseActivityStore(SlowKV())
    await asyncio.gather(
        store.append(CaseActivity(case_id="c", actor="a", kind="assigned", summary="one")),
        store.append(CaseActivity(case_id="c", actor="b", kind="commented", summary="two")),
    )
    entries = await store.list_for_case("c")
    assert {e.summary for e in entries} == {"one", "two"}


async def test_concurrent_task_adds_both_survive() -> None:
    store = CaseTaskStore(SlowKV())
    await asyncio.gather(store.add("c", "task-one"), store.add("c", "task-two"))
    tasks = await store.list_for_case("c")
    assert {t.title for t in tasks} == {"task-one", "task-two"}
    # The order recompute is per-snapshot, so the two land with distinct orders.
    assert len({t.order for t in tasks}) == 2


async def test_concurrent_notif_pref_puts_both_survive() -> None:
    store = NotificationPrefsStore(SlowKV())
    await asyncio.gather(
        store.put("alice", NotificationPref(user="alice", digest="daily")),
        store.put("bob", NotificationPref(user="bob", digest="hourly")),
    )
    assert (await store.get("alice")).digest == "daily"
    assert (await store.get("bob")).digest == "hourly"


async def test_concurrent_custom_role_puts_both_survive() -> None:
    store = CustomRoleStore(SlowKV())
    await asyncio.gather(
        store.put(CustomRole(name="triager")),
        store.put(CustomRole(name="reviewer")),
    )
    names = {r.name for r in await store.list()}
    assert names == {"triager", "reviewer"}


async def test_concurrent_price_overlay_sets_both_survive() -> None:
    store = PriceOverlayStore(SlowKV())
    await asyncio.gather(
        store.set_price("model-a", 1.0, 2.0),
        store.set_price("model-b", 3.0, 4.0),
    )
    overlay = await store.get()
    assert set(overlay) == {"model-a", "model-b"}


async def test_concurrent_shift_action_items_both_survive() -> None:
    store = ShiftHandoffStore(SlowKV())
    await asyncio.gather(
        store.add_action_item("follow up A"),
        store.add_action_item("follow up B"),
    )
    titles = {i.title for i in await store.list_action_items()}
    assert titles == {"follow up A", "follow up B"}


async def test_concurrent_shift_ack_and_action_item_both_survive() -> None:
    # The two handoff lists (action_items + acks) share ONE doc — a naive RMW would
    # let an ack append clobber a concurrent action-item append (or vice versa).
    store = ShiftHandoffStore(SlowKV())
    await asyncio.gather(
        store.add_action_item("item"),
        store.acknowledge("alice", "2026-06-30/day"),
    )
    assert {i.title for i in await store.list_action_items()} == {"item"}
    assert await store.has_acked("alice", "2026-06-30/day") is True


# --------------------------------------------------------------------------- #
# 4. User-delete cleanup — inbox + notif_prefs cleared (no inheritance).
# --------------------------------------------------------------------------- #
def _auth() -> AuthService:
    return AuthService(enabled=True, jwt_secret="s", token_hours=1, admin_username="admin")


async def test_delete_user_clears_inbox_and_notif_prefs() -> None:
    inbox = InboxStore(SlowKV())
    notif_prefs = NotificationPrefsStore(SlowKV())
    await inbox.append(InAppNotification(recipient="alice", title="secret case event",
                                         body="b", category="case_escalated"))
    await notif_prefs.put("alice", NotificationPref(
        user="alice", digest="daily", quiet_hours={"start": "22:00", "end": "06:00"}))
    # Sanity: the side-state exists before delete.
    assert await inbox.unread_count("alice") == 1
    assert (await notif_prefs.get("alice")).digest == "daily"

    await _auth().purge_user_side_state("alice", inbox=inbox, notif_prefs=notif_prefs)

    # Inbox emptied …
    _, total = await inbox.list_for_user("alice")
    assert total == 0 and await inbox.unread_count("alice") == 0
    # … and prefs fall back to the shipped DEFAULT (digest off), not the seeded daily.
    fresh = await notif_prefs.get("alice")
    assert fresh.digest == "off" and fresh.quiet_hours is None


async def test_recreated_same_name_user_starts_clean() -> None:
    inbox = InboxStore(SlowKV())
    notif_prefs = NotificationPrefsStore(SlowKV())
    await inbox.append(InAppNotification(recipient="alice", title="old", body="b", category="system"))
    await notif_prefs.put("alice", NotificationPref(user="alice", digest="hourly"))

    await _auth().purge_user_side_state("alice", inbox=inbox, notif_prefs=notif_prefs)

    # A re-created 'alice' inherits nothing.
    assert await inbox.unread_count("alice") == 0
    assert (await notif_prefs.get("alice")).digest == "off"


async def test_purge_also_clears_pending_digest_bucket() -> None:
    inbox = InboxStore(SlowKV())
    await inbox.defer(InAppNotification(recipient="alice", title="held", body="b", category="system"))
    assert len(await inbox.list_pending("alice")) == 1
    await _auth().purge_user_side_state("alice", inbox=inbox)
    assert await inbox.list_pending("alice") == []


async def test_purge_never_raises_on_bad_store() -> None:
    class BoomInbox:
        async def clear(self, user):
            raise RuntimeError("boom")

    # A cleanup failure must be swallowed (the account record is already gone).
    await _auth().purge_user_side_state("alice", inbox=BoomInbox())  # no exception


async def test_purge_ignores_absent_stores() -> None:
    # No-auth / offline profile: stores absent → a no-op, not an error.
    await _auth().purge_user_side_state("alice")  # all None
    await _auth().purge_user_side_state("")        # blank username → no-op


# --------------------------------------------------------------------------- #
# 5. Quiet-hours honors the per-user timezone.
# --------------------------------------------------------------------------- #
def _freeze_utc(monkeypatch, hh: int, mm: int) -> None:
    """Pin dispatch's UTC clock AND zoneinfo's 'now' to a known instant so the tz
    conversion is deterministic."""
    import time as _time

    import app.notifications.dispatch as disp

    base = datetime(2026, 6, 30, hh, mm, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(disp.time, "gmtime", lambda *a: base.utctimetuple())

    class _FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return base.astimezone(tz) if tz is not None else base.replace(tzinfo=None)

    monkeypatch.setattr(disp, "datetime", _FrozenDateTime, raising=False)
    # _local_minute_of_day imports datetime locally from the stdlib module; patch the
    # module attribute the function resolves at call time.
    import datetime as _dt_mod
    monkeypatch.setattr(_dt_mod, "datetime", _FrozenDateTime)


def test_quiet_hours_no_tz_uses_utc(monkeypatch) -> None:
    _freeze_utc(monkeypatch, 0, 0)  # UTC 00:00
    # 22:00→06:00 wraps midnight; UTC 00:00 is inside.
    assert _in_quiet_hours({"start": "22:00", "end": "06:00"}) is True
    # 06:00→08:00 is NOT active at UTC 00:00.
    assert _in_quiet_hours({"start": "06:00", "end": "08:00"}) is False


def test_quiet_hours_honors_tz(monkeypatch) -> None:
    pytest.importorskip("zoneinfo")
    # UTC 20:00 == 01:30 in Kolkata (UTC+5:30).
    _freeze_utc(monkeypatch, 20, 0)
    # Without tz: UTC 20:00 is OUTSIDE the 22:00→06:00 night window.
    assert _in_quiet_hours({"start": "22:00", "end": "06:00"}) is False
    # With tz=Asia/Kolkata: local 01:30 is INSIDE the operator's night window.
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo("Asia/Kolkata")
    except Exception:
        pytest.skip("no IANA tzdata available")
    assert _in_quiet_hours({"start": "22:00", "end": "06:00", "tz": "Asia/Kolkata"}) is True
    # A day window the operator means for local morning is False at local 01:30.
    assert _in_quiet_hours({"start": "06:00", "end": "08:00", "tz": "Asia/Kolkata"}) is False


def test_quiet_hours_bad_tz_falls_back_to_utc(monkeypatch) -> None:
    _freeze_utc(monkeypatch, 0, 0)  # UTC 00:00
    # An unknown tz must NOT raise and must fall back to UTC (inside the night window).
    assert _in_quiet_hours({"start": "22:00", "end": "06:00", "tz": "Mars/Phobos"}) is True


# --------------------------------------------------------------------------- #
# 6. Digest/quiet-hours role-tier deferral — held, not dropped; then flush.
# --------------------------------------------------------------------------- #
class _Users:
    def __init__(self, users):
        self._u = users

    async def list(self):
        return self._u


class _U:
    def __init__(self, username, active=True):
        self.username = username
        self.active = active


class _NoSecrets:
    def get(self, *a, **k):
        return None


def _prefs_provider():
    from app.config import NotificationConfig, Preferences

    prefs = Preferences(notifications=NotificationConfig(enabled=True))
    return lambda: prefs


async def test_digest_role_tier_defers_not_drops_then_flushes() -> None:
    inbox = InboxStore(SlowKV())
    notif_prefs = NotificationPrefsStore(SlowKV())
    await notif_prefs.put("erin", NotificationPref(user="erin", digest="daily"))
    svc = NotificationService(get_prefs=_prefs_provider(), secrets=_NoSecrets(),
                              inbox=inbox, notif_prefs=notif_prefs, users=_Users([_U("erin")]))
    case = {"case_id": "c", "assignee": "", "risk_score": 80.0,
            "verdict": "TRUE_POSITIVE", "status": "escalated"}
    await svc.dispatch(case, "escalated")
    # No per-event LIVE item (the digest user gets a held copy instead) …
    _, live = await inbox.list_for_user("erin")
    assert live == 0
    # … but it is HELD, not lost.
    held = await inbox.list_pending("erin")
    assert len(held) == 1 and held[0].case_id == "c" and held[0].ref.get("deferred") is True

    # Flushing the buffer (window end / digest fire) delivers it to the live inbox.
    delivered = await inbox.flush_pending_digest("erin")
    assert delivered is not None
    _, live2 = await inbox.list_for_user("erin")
    assert live2 == 1
    assert await inbox.list_pending("erin") == []


async def test_quiet_hours_role_tier_defers(monkeypatch) -> None:
    _freeze_utc(monkeypatch, 0, 0)  # UTC 00:00 — inside a 22:00→06:00 window
    inbox = InboxStore(SlowKV())
    notif_prefs = NotificationPrefsStore(SlowKV())
    await notif_prefs.put("frank", NotificationPref(
        user="frank", quiet_hours={"start": "22:00", "end": "06:00"}))
    svc = NotificationService(get_prefs=_prefs_provider(), secrets=_NoSecrets(),
                              inbox=inbox, notif_prefs=notif_prefs, users=_Users([_U("frank")]))
    await svc.dispatch({"case_id": "c", "assignee": "", "status": "escalated",
                        "verdict": "TRUE_POSITIVE", "risk_score": 80.0}, "escalated")
    _, live = await inbox.list_for_user("frank")
    assert live == 0                                   # quiet → not delivered live
    assert len(await inbox.list_pending("frank")) == 1  # held, not dropped


async def test_muted_category_is_dropped_not_deferred() -> None:
    from app.constants import NotificationCategory

    inbox = InboxStore(SlowKV())
    notif_prefs = NotificationPrefsStore(SlowKV())
    # An EXPLICIT opt-out (enabled=False) is a real mute — not a deferral.
    await notif_prefs.put("gwen", NotificationPref(
        user="gwen",
        categories={NotificationCategory.CASE_ESCALATED.value: {"enabled": False}}))
    svc = NotificationService(get_prefs=_prefs_provider(), secrets=_NoSecrets(),
                              inbox=inbox, notif_prefs=notif_prefs, users=_Users([_U("gwen")]))
    await svc.dispatch({"case_id": "c", "assignee": "", "status": "escalated",
                        "verdict": "TRUE_POSITIVE", "risk_score": 80.0}, "escalated")
    _, live = await inbox.list_for_user("gwen")
    assert live == 0
    assert await inbox.list_pending("gwen") == []  # muted → nothing held


async def test_assignee_mention_never_deferred_even_when_digest() -> None:
    inbox = InboxStore(SlowKV())
    notif_prefs = NotificationPrefsStore(SlowKV())
    # dave is on a digest AND is @mentioned → the personal address delivers LIVE,
    # never deferred (mention/assignment bypass the prefs filter).
    await notif_prefs.put("dave", NotificationPref(user="dave", digest="daily"))
    svc = NotificationService(get_prefs=_prefs_provider(), secrets=_NoSecrets(),
                              inbox=inbox, notif_prefs=notif_prefs, users=_Users([_U("dave")]))
    case = {"case_id": "c", "assignee": "", "status": "escalated",
            "verdict": "TRUE_POSITIVE", "risk_score": 80.0,
            "comments": [{"mentions": ["dave"]}]}
    await svc.dispatch(case, "escalated")
    _, live = await inbox.list_for_user("dave")
    assert live == 1                               # mention beats the digest filter
    assert await inbox.list_pending("dave") == []  # and is NOT also held
