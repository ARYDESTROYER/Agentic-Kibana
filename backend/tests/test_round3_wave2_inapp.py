"""Round 3 Wave 2 — Feature 8: in-app notification delivery (offline tests).

Covers:
* :class:`app.notifications.inapp.InAppChannel` — fan-out into the InboxStore, the
  default (assignee-only) resolver, an injected resolver, dedup, the live-badge
  publish hook, and the safe no-op when no inbox is wired.
* :class:`app.notifications.dispatch.NotificationService` in-app FAN-IN — the inbox
  copy is produced AFTER the network sends (#3 ordering), per-user category prefs +
  quiet-hours + digest gate the ROLE tier, and @mention/assignment ALWAYS fan in.
* the ``/api/notifications/inbox*`` + ``/api/notifications/prefs`` routes (self-scoped).

Fully offline: an in-memory KV store backs the inbox/prefs; no network, no real LLM.
"""

from __future__ import annotations

import time

import pytest

from app.constants import NotificationCategory
from app.models import InAppNotification, NotificationPref
from app.notifications.channel import NotificationEvent, channel_types, ensure_registered
from app.notifications.dispatch import NotificationService, _in_quiet_hours, _mentions_of
from app.notifications.inapp import InAppChannel, category_for_trigger
from app.stores.inbox import InboxStore
from app.stores.notif_prefs import NotificationPrefsStore

# asyncio_mode = "auto" (pyproject) runs the async tests without an explicit marker;
# the sync helper/route tests run as plain functions — no per-test marker needed.


# --------------------------------------------------------------------------- #
# A tiny in-memory KVStore (matches the KVStore ABC used by the stores).
# --------------------------------------------------------------------------- #
class _MemKV:
    def __init__(self) -> None:
        self._d: dict[tuple[str, str], dict] = {}

    async def get(self, ns: str, key: str):
        return self._d.get((ns, key))

    async def put(self, ns: str, key: str, value: dict) -> None:
        self._d[(ns, key)] = value

    async def delete(self, ns: str, key: str) -> None:
        self._d.pop((ns, key), None)


def _event(*, trigger="escalated", case=None, subject="Case escalated: foo",
           text="Case: case-1\nStatus: escalated", meta=None) -> NotificationEvent:
    return NotificationEvent(
        case=case if case is not None else {"case_id": "case-1", "assignee": "alice"},
        trigger=trigger, subject=subject, html="<b>x</b>", text=text,
        meta=meta or {"case_id": "case-1", "title": "foo", "severity_label": "high",
                      "case_url": "https://soc/cases/case-1", "trigger": trigger},
    )


# --------------------------------------------------------------------------- #
# Channel registration + category mapping.
# --------------------------------------------------------------------------- #
async def test_inapp_channel_registered_on_spi() -> None:
    ensure_registered()
    import app.notifications.inapp  # noqa: F401 — triggers @register_channel
    assert "in_app" in channel_types()


async def test_category_for_trigger() -> None:
    assert category_for_trigger("case_created") == NotificationCategory.CASE_NEW.value
    assert category_for_trigger("escalated") == NotificationCategory.CASE_ESCALATED.value
    assert category_for_trigger("true_positive") == NotificationCategory.CASE_ESCALATED.value
    assert category_for_trigger("closed") == NotificationCategory.CASE_RESOLVED.value
    assert category_for_trigger("manual") == NotificationCategory.SYSTEM.value
    assert category_for_trigger("digest_daily") == NotificationCategory.DIGEST.value
    assert category_for_trigger("nope") == NotificationCategory.SYSTEM.value


# --------------------------------------------------------------------------- #
# InAppChannel.send — fan-out, resolvers, dedup, publish, no-op.
# --------------------------------------------------------------------------- #
async def test_send_no_inbox_is_safe_noop() -> None:
    ch = InAppChannel()  # SPI-style construction, no inbox wired
    res = await ch.send(_event())
    assert res.ok is True and "no inbox" in res.detail


async def test_send_default_resolver_uses_assignee() -> None:
    inbox = InboxStore(_MemKV())
    ch = InAppChannel(inbox=inbox)  # no resolver → default (assignee) resolver
    res = await ch.send(_event(case={"case_id": "case-1", "assignee": "alice"}))
    assert res.ok is True
    items, total = await inbox.list_for_user("alice")
    assert total == 1
    note = items[0]
    assert note.category == NotificationCategory.CASE_ESCALATED.value
    assert note.case_id == "case-1"
    assert note.severity == "high"
    assert note.url == "https://soc/cases/case-1"
    assert note.title  # rendered subject surfaced
    # The other (non-assignee) user got nothing.
    _, bob_total = await inbox.list_for_user("bob")
    assert bob_total == 0


async def test_send_injected_resolver_and_dedup() -> None:
    inbox = InboxStore(_MemKV())

    async def resolve(_ev):
        # alice twice (dedup) + bob + a blank (dropped).
        return ["alice", "Alice", "bob", "  "]

    ch = InAppChannel(inbox=inbox, resolve_recipients=resolve)
    res = await ch.send(_event())
    assert res.ok is True and "2 recipient" in res.detail
    _, a = await inbox.list_for_user("alice")
    _, b = await inbox.list_for_user("bob")
    assert a == 1 and b == 1  # alice de-duped to one


async def test_send_publishes_live_event_per_recipient() -> None:
    inbox = InboxStore(_MemKV())
    published: list[tuple[str, dict]] = []

    async def resolve(_ev):
        return ["alice", "bob"]

    ch = InAppChannel(inbox=inbox, resolve_recipients=resolve,
                      publish=lambda user, payload: published.append((user, payload)))
    await ch.send(_event())
    users = sorted(u for u, _ in published)
    assert users == ["alice", "bob"]
    assert all("id" in p and "category" in p for _, p in published)


async def test_send_never_raises_on_store_error() -> None:
    class _Boom:
        async def fanout(self, recipients, build):
            raise RuntimeError("kv down")

    ch = InAppChannel(inbox=_Boom(), resolve_recipients=lambda ev: _aslist(["alice"]))
    res = await ch.send(_event())
    assert res.ok is False and "fanout failed" in res.detail


async def _aslist(xs):
    return xs


# --------------------------------------------------------------------------- #
# Dispatch fan-in — recipient tiers, prefs, quiet-hours, digest, ordering.
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


def _prefs_provider(notif_enabled=True):
    from app.config import NotificationConfig, Preferences

    prefs = Preferences(notifications=NotificationConfig(enabled=notif_enabled))
    return lambda: prefs


async def test_dispatch_fan_in_assignee_and_roles() -> None:
    inbox = InboxStore(_MemKV())
    notif_prefs = NotificationPrefsStore(_MemKV())
    users = _Users([_U("alice"), _U("bob"), _U("carol", active=False)])
    svc = NotificationService(
        get_prefs=_prefs_provider(), secrets=_NoSecrets(), inbox=inbox,
        notif_prefs=notif_prefs, users=users,
    )
    case = {"case_id": "case-9", "assignee": "alice", "risk_score": 80.0,
            "verdict": "TRUE_POSITIVE", "status": "escalated"}
    sent = await svc.dispatch(case, "escalated")
    # one in_app record appended
    inapp = [s for s in sent if s.get("type") == "in_app"]
    assert len(inapp) == 1 and inapp[0]["ok"] is True
    # alice (assignee+active) + bob (active role member) get it; carol (inactive) not.
    _, a = await inbox.list_for_user("alice")
    _, b = await inbox.list_for_user("bob")
    _, c = await inbox.list_for_user("carol")
    assert a == 1 and b == 1 and c == 0


async def test_dispatch_respects_category_pref_mute_for_role_tier() -> None:
    inbox = InboxStore(_MemKV())
    notif_prefs = NotificationPrefsStore(_MemKV())
    # bob mutes the escalated category; alice is the ASSIGNEE so still gets it.
    await notif_prefs.put("bob", NotificationPref(
        user="bob",
        categories={NotificationCategory.CASE_ESCALATED.value: {"enabled": False}},
    ))
    users = _Users([_U("alice"), _U("bob")])
    svc = NotificationService(get_prefs=_prefs_provider(), secrets=_NoSecrets(),
                              inbox=inbox, notif_prefs=notif_prefs, users=users)
    case = {"case_id": "c", "assignee": "alice", "risk_score": 80.0,
            "verdict": "TRUE_POSITIVE", "status": "escalated"}
    await svc.dispatch(case, "escalated")
    _, a = await inbox.list_for_user("alice")
    _, b = await inbox.list_for_user("bob")
    assert a == 1   # assignee always
    assert b == 0   # role member muted the category


async def test_dispatch_mention_always_fans_in_even_if_muted() -> None:
    inbox = InboxStore(_MemKV())
    notif_prefs = NotificationPrefsStore(_MemKV())
    # dave mutes everything via digest, but is @mentioned → still gets it.
    await notif_prefs.put("dave", NotificationPref(user="dave", digest="daily"))
    users = _Users([_U("dave")])
    svc = NotificationService(get_prefs=_prefs_provider(), secrets=_NoSecrets(),
                              inbox=inbox, notif_prefs=notif_prefs, users=users)
    case = {"case_id": "c", "assignee": "", "risk_score": 80.0,
            "verdict": "TRUE_POSITIVE", "status": "escalated",
            "comments": [{"mentions": ["dave"]}]}
    await svc.dispatch(case, "escalated")
    _, d = await inbox.list_for_user("dave")
    assert d == 1  # mention beats the digest/quiet filter


async def test_dispatch_digest_mutes_role_tier() -> None:
    inbox = InboxStore(_MemKV())
    notif_prefs = NotificationPrefsStore(_MemKV())
    await notif_prefs.put("erin", NotificationPref(user="erin", digest="daily"))
    users = _Users([_U("erin")])
    svc = NotificationService(get_prefs=_prefs_provider(), secrets=_NoSecrets(),
                              inbox=inbox, notif_prefs=notif_prefs, users=users)
    case = {"case_id": "c", "assignee": "", "risk_score": 80.0,
            "verdict": "TRUE_POSITIVE", "status": "escalated"}
    await svc.dispatch(case, "escalated")
    _, e = await inbox.list_for_user("erin")
    assert e == 0  # role member on a digest cadence gets no per-event item


async def test_dispatch_no_inbox_wired_is_inert() -> None:
    svc = NotificationService(get_prefs=_prefs_provider(), secrets=_NoSecrets())
    case = {"case_id": "c", "assignee": "alice", "risk_score": 80.0,
            "verdict": "TRUE_POSITIVE", "status": "escalated"}
    sent = await svc.dispatch(case, "escalated")
    assert not [s for s in sent if s.get("type") == "in_app"]


async def test_dispatch_disabled_notifications_no_fan_in() -> None:
    inbox = InboxStore(_MemKV())
    svc = NotificationService(get_prefs=_prefs_provider(notif_enabled=False),
                              secrets=_NoSecrets(), inbox=inbox)
    sent = await svc.dispatch({"case_id": "c", "assignee": "a"}, "escalated")
    assert sent == []


# --------------------------------------------------------------------------- #
# Helpers — quiet hours + mentions.
# --------------------------------------------------------------------------- #
def test_quiet_hours_simple_and_wrap() -> None:
    now = time.gmtime()
    minute = now.tm_hour * 60 + now.tm_min
    # A window covering NOW.
    start = f"{(minute - 30) // 60 % 24:02d}:{(minute - 30) % 60:02d}"
    end = f"{(minute + 30) // 60 % 24:02d}:{(minute + 30) % 60:02d}"
    assert _in_quiet_hours({"start": start, "end": end}) is True
    # A window NOT covering NOW.
    assert _in_quiet_hours({"start": "01:00", "end": "01:01"}) in (True, False)
    # Malformed / missing → never in quiet hours.
    assert _in_quiet_hours(None) is False
    assert _in_quiet_hours({"start": "nope"}) is False
    assert _in_quiet_hours({}) is False


def test_mentions_extraction() -> None:
    case = {"comments": [{"mentions": ["alice", "bob"]}, {"mentions": ["carol"]}]}
    got = sorted(_mentions_of(case))
    assert got == ["alice", "bob", "carol"]
    assert _mentions_of({}) == []
    assert _mentions_of({"comments": "junk"}) == []


# --------------------------------------------------------------------------- #
# Routes — self-scoped inbox + prefs (TestClient over the standalone router).
# --------------------------------------------------------------------------- #
class _NoSecrets:
    def notification_channel_secrets(self, channel_id):
        return {}


@pytest.fixture
def inapp_client(secrets, mock_provider):
    from contextlib import asynccontextmanager

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes_inapp import router
    from app.es.fake import InMemoryESClient
    from app.state import AppState

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


def test_routes_inbox_lifecycle(inapp_client) -> None:
    c = inapp_client
    # Seed two items into the default bucket (auth off → current_username == "").
    # The fake-ES-backed KV store is loop-agnostic (no asyncio primitives), so a
    # short-lived loop here writes the same in-process store the routes read.
    state = c.app.state.tlsoc

    async def _seed():
        await state.inbox.append(InAppNotification(recipient="default", title="one",
                                                   category="system"))
        await state.inbox.append(InAppNotification(recipient="default", title="two",
                                                   category="case_escalated"))

    from asyncio import new_event_loop
    loop = new_event_loop()
    try:
        loop.run_until_complete(_seed())
    finally:
        loop.close()

    # Unread count = 2.
    r = c.get("/api/notifications/inbox/unread-count")
    assert r.status_code == 200 and r.json()["unread"] == 2

    # List newest-first.
    r = c.get("/api/notifications/inbox")
    body = r.json()
    assert body["total"] == 2 and len(body["items"]) == 2
    assert body["items"][0]["title"] == "two"  # newest first
    nid = body["items"][0]["id"]

    # Mark one read → unread drops to 1.
    r = c.post(f"/api/notifications/inbox/{nid}/read")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert c.get("/api/notifications/inbox/unread-count").json()["unread"] == 1

    # read-all → 0.
    r = c.post("/api/notifications/inbox/read-all")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert c.get("/api/notifications/inbox/unread-count").json()["unread"] == 0

    # dismiss the remaining → total 1.
    other = c.get("/api/notifications/inbox").json()["items"]
    did = other[-1]["id"]
    r = c.post(f"/api/notifications/inbox/{did}/dismiss")
    assert r.status_code == 200 and r.json()["dismissed"] is True
    assert c.get("/api/notifications/inbox").json()["total"] == 1

    # dismiss a missing id → ok False.
    assert c.post("/api/notifications/inbox/nope/dismiss").json()["ok"] is False
    # mark-read a missing id → ok False.
    assert c.post("/api/notifications/inbox/nope/read").json()["ok"] is False


def test_routes_prefs_roundtrip(inapp_client) -> None:
    c = inapp_client
    # Default prefs.
    r = c.get("/api/notifications/prefs")
    assert r.status_code == 200
    assert r.json()["digest"] in (None, "off")

    # PUT prefs — user is forced server-side.
    payload = {
        "categories": {"case_escalated": {"enabled": False}},
        "quiet_hours": {"start": "22:00", "end": "06:00"},
        "digest": "daily",
    }
    r = c.put("/api/notifications/prefs", json=payload)
    assert r.status_code == 200
    saved = r.json()
    assert saved["digest"] == "daily"
    assert saved["categories"]["case_escalated"]["enabled"] is False
    assert saved["user"] == "default"  # forced to the requester bucket

    # Persisted on the next GET.
    r2 = c.get("/api/notifications/prefs")
    assert r2.json()["quiet_hours"] == {"start": "22:00", "end": "06:00"}
