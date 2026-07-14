"""Round 3 — Wave 1: the in-process multiplexed SSE EventBus foundation.

Exercises publish / subscribe / per-user scoping / Last-Event-ID replay / drop-oldest
overflow / heartbeat-frame formatting / the module-level singleton — ALL without a real
network (the bus yields SSE-framed bytes we assert on directly).

⚠ NON-NEGOTIABLES: the bus is pure transport. These tests prove it NEVER inspects or
mutates a payload's decision content — it JSON-encodes verbatim and fans out. No LLM,
no case_manager, no ES is touched.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.config import RealtimeConfig
from app.realtime import (
    DEFAULT_HEARTBEAT_SECONDS,
    EventBus,
    configure_event_bus,
    format_sse,
    get_event_bus,
    heartbeat_frame,
    reset_event_bus,
)


# --------------------------------------------------------------------------- #
# Frame formatting (pure, no loop).
# --------------------------------------------------------------------------- #
def test_format_sse_frame_shape():
    frame = format_sse("notification", '{"a":1}', event_id="7")
    assert frame == 'id: 7\nevent: notification\ndata: {"a":1}\n\n'
    # Terminating blank line is mandatory for the browser to dispatch the event.
    assert frame.endswith("\n\n")


def test_format_sse_without_id():
    frame = format_sse("ping", "{}")
    assert frame == "event: ping\ndata: {}\n\n"
    assert not frame.startswith("id:")


def test_format_sse_multiline_payload_splits_into_data_lines():
    # A payload with a newline must become two `data:` lines (SSE spec), never break
    # the frame into two events.
    frame = format_sse("x", "line1\nline2")
    assert "data: line1\ndata: line2\n" in frame
    # Exactly one event terminator.
    assert frame.count("\n\n") == 1


def test_format_sse_id_and_event_are_single_line():
    # CR/LF in an id or event token must be collapsed so it can't split the frame.
    frame = format_sse("ev\nil", "{}", event_id="1\n2")
    assert "id: 1 2\n" in frame
    assert "event: ev il\n" in frame


def test_heartbeat_frame_is_a_comment():
    hb = heartbeat_frame()
    assert hb.startswith(": heartbeat ")
    assert hb.endswith("\n\n")


# --------------------------------------------------------------------------- #
# publish() is non-blocking + safe with zero subscribers.
# --------------------------------------------------------------------------- #
def test_publish_with_no_subscribers_is_a_noop_returning_id():
    bus = EventBus()
    eid = bus.publish("cases", "case.activity", {"case_id": "c-1"})
    assert eid == "1"
    assert bus.subscriber_count == 0
    # Still recorded in replay history for a later reconnect.
    evs = bus.replay(frozenset({"cases"}), None, after_id="0")
    assert [e.payload for e in evs] == ['{"case_id":"c-1"}']


def test_publish_encodes_unserialisable_payload_without_raising():
    bus = EventBus()

    class Weird:
        def __repr__(self) -> str:  # default=str fallback path
            return "weird-obj"

    eid = bus.publish("t", "e", {"obj": Weird()})
    assert eid == "1"
    ev = bus.replay(frozenset({"t"}), None, "0")[0]
    assert "weird-obj" in ev.payload


# --------------------------------------------------------------------------- #
# subscribe() — live delivery + the initial connected comment.
# --------------------------------------------------------------------------- #
async def _first_frames(gen, n):
    """Collect the first ``n`` yielded frames (as decoded str) from a subscribe gen."""
    out = []
    for _ in range(n):
        out.append((await gen.__anext__()).decode("utf-8"))
    return out


async def test_subscribe_emits_connected_then_live_event():
    bus = EventBus(heartbeat_seconds=60)
    gen = bus.subscribe(["cases"], user="alice").__aiter__()
    # First frame is the connected comment (flushes headers).
    first = (await gen.__anext__()).decode()
    assert first == ": connected\n\n"
    # Now publish and expect the live frame next.
    bus.publish("cases", "case.activity", {"case_id": "c-9"})
    frame = (await gen.__anext__()).decode()
    assert "event: case.activity\n" in frame
    assert '"case_id":"c-9"' in frame
    assert frame.startswith("id: ")
    await gen.aclose()


async def test_subscribe_ignores_other_topics():
    bus = EventBus(heartbeat_seconds=60)
    gen = bus.subscribe(["cases"], user="alice").__aiter__()
    await gen.__anext__()  # connected
    bus.publish("notifications", "ntf", {"x": 1})  # different topic — not delivered
    bus.publish("cases", "case.activity", {"x": 2})  # delivered
    frame = (await gen.__anext__()).decode()
    assert '"x":2' in frame
    assert '"x":1' not in frame
    await gen.aclose()


# --------------------------------------------------------------------------- #
# Per-user scoping (audience).
# --------------------------------------------------------------------------- #
async def test_audience_scoping_targets_only_named_user():
    bus = EventBus(heartbeat_seconds=60)
    alice = bus.subscribe(["inbox"], user="Alice").__aiter__()
    bob = bus.subscribe(["inbox"], user="bob").__aiter__()
    await alice.__anext__()  # connected
    await bob.__anext__()    # connected
    # Targeted to alice only (case-insensitive username match).
    bus.publish("inbox", "notification", {"to": "alice"}, audience=["ALICE"])
    a_frame = (await alice.__anext__()).decode()
    assert '"to":"alice"' in a_frame
    # Bob must NOT receive it; a broadcast proves bob's stream is otherwise live.
    bus.publish("inbox", "notification", {"to": "all"})  # broadcast
    b_frame = (await bob.__anext__()).decode()
    assert '"to":"all"' in b_frame
    assert '"to":"alice"' not in b_frame
    await alice.aclose()
    await bob.aclose()


async def test_anonymous_subscriber_sees_only_broadcasts():
    bus = EventBus(heartbeat_seconds=60)
    anon = bus.subscribe(["inbox"], user=None).__aiter__()
    await anon.__anext__()  # connected
    bus.publish("inbox", "n", {"k": "targeted"}, audience=["someone"])  # not for anon
    bus.publish("inbox", "n", {"k": "broadcast"})                        # for everyone
    frame = (await anon.__anext__()).decode()
    assert '"k":"broadcast"' in frame
    assert '"k":"targeted"' not in frame
    await anon.aclose()


def test_visible_to_helper_directly():
    bus = EventBus()
    bus.publish("t", "e", {}, audience=["carol"])
    # Replay for carol returns the targeted event (anonymous would be filtered out).
    ev = bus.replay(frozenset({"t"}), "carol", "0")[0]
    assert ev.visible_to("carol") is True
    assert ev.visible_to("CAROL") is True       # case-insensitive
    assert ev.visible_to("dave") is False
    assert ev.visible_to(None) is False         # anonymous can't see a targeted event


# --------------------------------------------------------------------------- #
# Last-Event-ID replay.
# --------------------------------------------------------------------------- #
def test_replay_returns_only_events_after_id_in_order():
    bus = EventBus()
    bus.publish("cases", "a", {"n": 1})  # id 1
    bus.publish("cases", "a", {"n": 2})  # id 2
    bus.publish("cases", "a", {"n": 3})  # id 3
    evs = bus.replay(frozenset({"cases"}), None, after_id="1")
    assert [e.id for e in evs] == ["2", "3"]


def test_history_topics_are_lru_bounded():
    # audit #32: distinct per-case topics must not grow _history without bound — the
    # least-recently-published topic is evicted past the cap.
    bus = EventBus()
    bus._max_history_topics = 3  # noqa: SLF001 — test-only knob
    for i in range(10):
        bus.publish(f"cases:{i}", "a", {"n": i})
    assert len(bus._history) == 3  # noqa: SLF001
    # The most-recent 3 topics are retained; the oldest were evicted.
    assert set(bus._history.keys()) == {"cases:7", "cases:8", "cases:9"}  # noqa: SLF001
    # Re-publishing to an existing topic keeps it (marks it most-recent), evicting another.
    bus.publish("cases:7", "a", {"n": 70})
    bus.publish("cases:99", "a", {"n": 99})
    assert "cases:7" in bus._history and len(bus._history) == 3  # noqa: SLF001


def test_replay_empty_for_none_or_bad_id():
    bus = EventBus()
    bus.publish("cases", "a", {"n": 1})
    assert bus.replay(frozenset({"cases"}), None, after_id=None) == []
    assert bus.replay(frozenset({"cases"}), None, after_id="not-an-int") == []


def test_replay_respects_audience():
    bus = EventBus()
    bus.publish("inbox", "n", {"n": 1}, audience=["alice"])  # id1, alice only
    bus.publish("inbox", "n", {"n": 2})                      # id2, broadcast
    bob = bus.replay(frozenset({"inbox"}), "bob", after_id="0")
    assert [e.id for e in bob] == ["2"]  # bob only sees the broadcast
    alice = bus.replay(frozenset({"inbox"}), "alice", after_id="0")
    assert [e.id for e in alice] == ["1", "2"]


async def test_subscribe_replays_last_event_id_on_connect():
    bus = EventBus(heartbeat_seconds=60)
    bus.publish("cases", "a", {"n": 1})  # id 1
    bus.publish("cases", "a", {"n": 2})  # id 2
    # Reconnect with Last-Event-ID = 1 → should replay id 2 right after connected.
    gen = bus.subscribe(["cases"], user="x", last_event_id="1").__aiter__()
    frames = await _first_frames(gen, 2)
    assert frames[0] == ": connected\n\n"
    assert "id: 2\n" in frames[1]
    assert '"n":2' in frames[1]
    await gen.aclose()


async def test_no_duplicate_frame_when_event_published_during_connect():
    # audit #33: an event published AFTER register but before the replay read must be
    # delivered exactly ONCE (live), not replayed AND live.
    bus = EventBus(heartbeat_seconds=60)
    bus.publish("cases", "a", {"n": 1})  # id 1 (before connect)
    gen = bus.subscribe(["cases"], user="x", last_event_id="0").__aiter__()
    first = await gen.__anext__()
    assert first == b": connected\n\n"  # registered + reg_seq snapshotted, replay not yet read
    bus.publish("cases", "a", {"n": 2})  # id 2 — arrives live, must NOT also be replayed
    frames: list[bytes] = []
    for _ in range(4):
        try:
            frames.append(await asyncio.wait_for(gen.__anext__(), timeout=0.5))
        except asyncio.TimeoutError:
            break
    text = "".join(f.decode() for f in frames)
    assert text.count("id: 2\n") == 1, f"event id 2 was duplicated: {text!r}"
    assert text.count("id: 1\n") == 1
    await gen.aclose()


# --------------------------------------------------------------------------- #
# Bounded ring / drop-oldest overflow.
# --------------------------------------------------------------------------- #
async def test_slow_subscriber_drops_oldest_and_emits_overflow():
    # Tiny per-subscriber queue so we can force an overflow deterministically.
    bus = EventBus(heartbeat_seconds=60, subscriber_queue=2)
    gen = bus.subscribe(["cases"], user="x").__aiter__()
    await gen.__anext__()  # connected — subscriber registered, queue empty
    # Publish 5 events without the consumer draining → queue holds last 2, 3 dropped.
    for i in range(5):
        bus.publish("cases", "a", {"n": i})
    # Drain the batch: first an overflow control frame, then the surviving 2 events.
    overflow = (await gen.__anext__()).decode()
    assert "event: overflow\n" in overflow
    body = _data_of(overflow)
    assert body["dropped"] == 3
    f1 = (await gen.__anext__()).decode()
    f2 = (await gen.__anext__()).decode()
    # The two SURVIVORS are the newest (drop-oldest): n=3 and n=4.
    assert '"n":3' in f1
    assert '"n":4' in f2
    await gen.aclose()


# --------------------------------------------------------------------------- #
# Bounded subscriber count (drop-oldest subscriber eviction).
# --------------------------------------------------------------------------- #
async def test_max_subscribers_evicts_oldest():
    bus = EventBus(heartbeat_seconds=60)
    bus._max_subscribers = 2  # noqa: SLF001 — test-only knob
    g1 = bus.subscribe(["t"], user="a").__aiter__()
    g2 = bus.subscribe(["t"], user="b").__aiter__()
    await g1.__anext__()
    await g2.__anext__()
    assert bus.subscriber_count == 2
    # A third subscriber evicts the OLDEST (g1).
    g3 = bus.subscribe(["t"], user="c").__aiter__()
    await g3.__anext__()
    assert bus.subscriber_count == 2
    # g1 was evicted: its generator unwinds (its pending drain was woken).
    bus.publish("t", "e", {"n": 1})
    f = (await g3.__anext__()).decode()
    assert '"n":1' in f
    await g2.aclose()
    await g3.aclose()


async def test_evicted_subscriber_generator_stops_not_zombie():
    # audit #34: an evicted subscriber's stream must STOP (so the socket closes and the
    # client reconnects), not linger as a zombie holding a slot and getting no events.
    bus = EventBus(heartbeat_seconds=60)
    bus._max_subscribers = 1  # noqa: SLF001 — test-only knob
    g1 = bus.subscribe(["t"], user="a").__aiter__()
    await g1.__anext__()  # connected; registered
    assert bus.subscriber_count == 1
    g2 = bus.subscribe(["t"], user="b").__aiter__()
    await g2.__anext__()  # evicts g1
    assert bus.subscriber_count == 1  # g1 gone from the registry
    # g1's generator now returns instead of streaming forever.
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(g1.__anext__(), timeout=2.0)
    await g2.aclose()


# --------------------------------------------------------------------------- #
# Heartbeat on idle.
# --------------------------------------------------------------------------- #
async def test_heartbeat_emitted_on_idle():
    # The heartbeat cadence floor is 1s; build the bus with the minimum so the idle
    # timeout fires quickly and we exercise the asyncio.TimeoutError path.
    bus = EventBus(heartbeat_seconds=1)
    assert bus.heartbeat_seconds == 1
    gen = bus.subscribe(["t"], user="x").__aiter__()
    await gen.__anext__()  # connected
    # With nothing published, the next frame must be a heartbeat (within ~1s).
    frame = (await asyncio.wait_for(gen.__anext__(), timeout=3)).decode()
    assert frame.startswith(": heartbeat ")
    await gen.aclose()


# --------------------------------------------------------------------------- #
# Cleanup on disconnect.
# --------------------------------------------------------------------------- #
async def test_subscriber_unregistered_on_close():
    bus = EventBus(heartbeat_seconds=60)
    gen = bus.subscribe(["t"], user="x").__aiter__()
    await gen.__anext__()  # connected
    assert bus.subscriber_count == 1
    await gen.aclose()
    assert bus.subscriber_count == 0


# --------------------------------------------------------------------------- #
# Module-level singleton survives "rewiring" + config application.
# --------------------------------------------------------------------------- #
def test_singleton_is_stable_across_calls():
    reset_event_bus()
    try:
        a = get_event_bus()
        b = get_event_bus()
        assert a is b
        # An event published on the singleton is visible to a second handle (same bus).
        a.publish("t", "e", {"n": 1})
        assert b.replay(frozenset({"t"}), None, "0")[0].payload == '{"n":1}'
    finally:
        reset_event_bus()


def test_configure_event_bus_applies_realtime_heartbeat():
    reset_event_bus()
    try:
        rt = RealtimeConfig(enabled=True, heartbeat_seconds=42)
        bus = configure_event_bus(rt)
        assert bus.heartbeat_seconds == 42
        assert bus is get_event_bus()
        # Tolerates None (leaves the current cadence unchanged).
        configure_event_bus(None)
        assert get_event_bus().heartbeat_seconds == 42
    finally:
        reset_event_bus()


def test_default_heartbeat_matches_realtime_config_default():
    # The bus default + the config default agree, so a disabled-but-present bus is sane.
    assert RealtimeConfig().heartbeat_seconds == DEFAULT_HEARTBEAT_SECONDS


def test_disabled_realtime_bus_still_publishable():
    # Default OFF: configure with a disabled config; the bus must still accept publishes
    # (producers need no conditional — the ENDPOINT, not the bus, gates serving).
    reset_event_bus()
    try:
        bus = configure_event_bus(RealtimeConfig(enabled=False))
        eid = bus.publish("t", "e", {"ok": True})
        assert eid == "1"
    finally:
        reset_event_bus()


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _data_of(frame: str) -> dict:
    """Extract + parse the JSON body from a single-line `data:` SSE frame."""
    for line in frame.split("\n"):
        if line.startswith("data: "):
            return json.loads(line[len("data: "):])
    raise AssertionError(f"no data line in frame: {frame!r}")
