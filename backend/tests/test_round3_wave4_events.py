"""Round 3 — Wave 4: LIVE WIRING (backend publish side).

Proves the producers added in Wave 4 emit the right realtime frames on the in-process
:class:`app.realtime.EventBus`, WITHOUT a real network (we subscribe to the bus
directly / read its replay history):

* posting a thread message (the case-collaboration router) publishes a ``case.activity``
  frame to the PER-CASE room (topic ``cases:{case_id}``) that a subscriber of that topic
  actually receives;
* an investigation run (the agent pipeline) publishes ORDERED ``agent.step`` frames to
  the same per-case room, ending in a TERMINAL ``decision`` step;
* the ``inapp`` mention badge lands on the ALLOWLISTED ``notifications`` topic (so the
  Wave-4 bell EventSource can receive it), not the un-allowlisted ``inbox`` topic.

⚠ NON-NEGOTIABLES asserted here:

* **#3** — publishing is pure narration AFTER apply()+save: a run with a subscriber and
  a run without one produce the BYTE-IDENTICAL case decision (verdict / status /
  decision_by). The frames only report the already-decided case.
* **#11** — publish is best-effort: a bus whose ``publish`` raises NEVER breaks the
  pipeline; the case is still produced and persisted.
* **#9** — frame payloads carry only plain, clipped identifiers/enums (the producers
  fence/escape any log/AI text at their own boundary); these tests assert the shape, not
  raw evidence text.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Secrets
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine.correlation import cluster_from_events
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.realtime import EventBus
from app.state import AppState
from tests.conftest import make_raw_event


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _cluster(ip: str = "1.2.3.4", n: int = 3):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


def _final_verdict(verdict: str, confidence: float) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted evidence", "event_ids": ["e0"]}],
            "mitre": ["T1110"], "recommended_action": "block the source",
            "reproduce_query": 'source.ip : "1.2.3.4"',
        },
    })


def _payloads_for(bus: EventBus, topic: str, event_type: str) -> list[dict]:
    """Decode the replay-history payloads on ``topic`` for ``event_type`` in seq order.

    ``publish`` appends to the per-topic history ring even with ZERO subscribers, so
    this deterministically captures what a producer emitted without any async timing."""
    out: list[dict] = []
    for ev in bus.replay(frozenset({topic}), None, after_id="0"):
        if ev.event_type == event_type:
            out.append(json.loads(ev.payload))
    return out


# --------------------------------------------------------------------------- #
# Fixtures — a TestClient mounting the collab router for the case.activity test.
# --------------------------------------------------------------------------- #
@pytest.fixture
def secrets() -> Secrets:
    return Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                   anthropic_api_key=None, openai_api_key=None)


@pytest.fixture
def mock_provider() -> MockProvider:
    return MockProvider()


@pytest.fixture
def collab_client(secrets, mock_provider):
    """A TestClient mounting the collab router over a fresh AppState (auth OFF →
    require_permission is a no-op). Realtime ENABLED so a live subscriber path is real;
    publish itself is independent of that flag."""
    from app.api.routes_cases_collab import router as collab_router

    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.realtime.enabled = True
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(collab_router)
    with TestClient(api) as c:
        yield c


async def _seed_case(state: AppState, case_id: str = "c-evt-1") -> Case:
    case = Case(
        case_id=case_id, cluster_signature=f"sig-{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        verdict=Verdict.NEEDS_HUMAN, confidence=0.5, risk_score=42.0,
    )
    await state.cases.save(case)
    return case


# --------------------------------------------------------------------------- #
# (1) Thread post → case.activity on the per-case room, received by a subscriber.
# --------------------------------------------------------------------------- #
async def test_thread_post_publishes_case_activity_to_subscriber(collab_client):
    state: AppState = collab_client.app.state.tlsoc
    case = await _seed_case(state, "c-evt-thread")
    bus = state.event_bus

    # A LIVE subscriber on this case's room.
    topic = f"cases:{case.case_id}"
    gen = bus.subscribe([topic], user="alice").__aiter__()
    first = (await gen.__anext__()).decode()
    assert first == ": connected\n\n"  # connected comment flushes headers

    # Post a thread message through the real router (sync TestClient call).
    resp = collab_client.post(
        f"/api/cases/{case.case_id}/thread", json={"body": "investigating now"},
    )
    assert resp.status_code == 200

    # The subscriber receives a case.activity frame for this case.
    frame = (await gen.__anext__()).decode()
    assert "event: case.activity\n" in frame
    assert f'"case_id":"{case.case_id}"' in frame
    assert '"kind":"commented"' in frame
    await gen.aclose()


async def test_thread_post_does_not_publish_to_unrelated_case_room(collab_client):
    state: AppState = collab_client.app.state.tlsoc
    case = await _seed_case(state, "c-evt-iso-a")
    other = await _seed_case(state, "c-evt-iso-b")
    bus = state.event_bus

    collab_client.post(f"/api/cases/{case.case_id}/thread", json={"body": "hello"})

    # The activity landed ONLY on the posted case's room, not the other case's room.
    mine = _payloads_for(bus, f"cases:{case.case_id}", "case.activity")
    theirs = _payloads_for(bus, f"cases:{other.case_id}", "case.activity")
    assert any(p["case_id"] == case.case_id for p in mine)
    assert theirs == []


async def test_task_and_reaction_publish_case_activity(collab_client):
    state: AppState = collab_client.app.state.tlsoc
    case = await _seed_case(state, "c-evt-task")
    bus = state.event_bus

    # A task add and a thread message + reaction all nudge the case room.
    collab_client.post(f"/api/cases/{case.case_id}/tasks", json={"title": "isolate host"})
    msg = collab_client.post(f"/api/cases/{case.case_id}/thread", json={"body": "see task"}).json()
    collab_client.post(
        f"/api/cases/{case.case_id}/thread/{msg['id']}/reactions", json={"emoji": "👍"},
    )

    kinds = {p["kind"] for p in _payloads_for(bus, f"cases:{case.case_id}", "case.activity")}
    assert {"task_added", "commented", "reaction"} <= kinds


# --------------------------------------------------------------------------- #
# (2) Pipeline run → ordered agent.step frames ending in a decision step.
# --------------------------------------------------------------------------- #
async def test_pipeline_run_publishes_ordered_agent_steps(app_state: AppState, mock_provider):
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.4))

    case = await app_state.pipeline.investigate_cluster(
        _cluster("5.5.5.1"), SourceSurface.INVESTIGATE, app_state.prefs)

    bus = app_state.event_bus
    steps = _payloads_for(bus, f"cases:{case.case_id}", "agent.step")
    names = [s["step"] for s in steps]

    # The full strong-investigation arc, in order, terminating in a decision.
    assert names == ["router", "persona", "tools", "verdict", "decision"]
    # Each frame is scoped to this case.
    assert all(s["case_id"] == case.case_id for s in steps)
    # The terminal frame REPORTS the already-decided case (#3) — it carries the saved
    # status + verdict, marked done.
    decision = steps[-1]
    assert decision["step"] == "decision"
    assert decision["status"] == "done"
    assert decision["detail"] == case.status.value
    assert decision["verdict"] == case.verdict.value


async def test_benign_shortcut_still_emits_decision_step(app_state: AppState, mock_provider):
    # An obviously-benign router verdict short-circuits the strong investigator (no
    # "tools" handoff in the benign branch is fine) but MUST still end in a decision.
    mock_provider.push("router", json.dumps(
        {"bucket": "obviously_benign", "confidence": 0.95, "reason": "noise"}))

    case = await app_state.pipeline.investigate_cluster(
        _cluster("5.5.5.2"), SourceSurface.AUTOMATED_SCAN, app_state.prefs)

    steps = _payloads_for(app_state.event_bus, f"cases:{case.case_id}", "agent.step")
    names = [s["step"] for s in steps]
    # Router + persona always fire; the benign path runs the graph (tools) then a
    # verdict; the run always terminates in a decision step.
    assert names[0] == "router"
    assert names[-1] == "decision"
    assert "verdict" in names


# --------------------------------------------------------------------------- #
# (3) #3 — frames never alter the decision; #11 — publish never breaks the run.
# --------------------------------------------------------------------------- #
async def test_decision_identical_with_and_without_subscriber(app_state: AppState, mock_provider):
    """A subscribed run and an un-subscribed run produce the SAME deterministic case
    decision — publishing is pure narration and never feeds decide() (#3)."""
    bus = app_state.event_bus

    # Run 1: no subscriber.
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.99))
    c1 = await app_state.pipeline.investigate_cluster(
        _cluster("6.6.6.1"), SourceSurface.INVESTIGATE, app_state.prefs)

    # Run 2: WITH a live subscriber on the exact case room. Register the candidate
    # first (no LLM) to learn the stable case_id, subscribe to its room, then force the
    # full investigation — the subscriber is now genuinely receiving agent.step frames.
    cluster2 = _cluster("6.6.6.2")
    candidate = await app_state.pipeline.register_candidate(
        cluster2, SourceSurface.INVESTIGATE, app_state.prefs)
    gen = bus.subscribe([f"cases:{candidate.case_id}"], user="bob").__aiter__()
    await gen.__anext__()  # connected
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.99))
    c2 = await app_state.pipeline.investigate_cluster(
        _cluster("6.6.6.2"), SourceSurface.INVESTIGATE, app_state.prefs, force=True)
    # The subscriber actually saw the live decision frame (proves the path was live).
    saw_decision = False
    for _ in range(12):
        try:
            frame = (await gen.__anext__()).decode()
        except StopAsyncIteration:  # pragma: no cover
            break
        if "event: agent.step\n" in frame and '"step":"decision"' in frame:
            saw_decision = True
            break
    await gen.aclose()
    assert saw_decision

    # Byte-identical decision triple (#3).
    assert (c1.verdict, c1.status, c1.decision_by) == (c2.verdict, c2.status, c2.decision_by)
    assert c1.verdict == Verdict.TRUE_POSITIVE
    assert c1.status == CaseStatus.ESCALATED


async def test_pipeline_survives_a_raising_event_bus(app_state: AppState, mock_provider):
    """A bus whose ``publish`` raises must NEVER break the pipeline (#11). The case is
    still investigated, decided, and persisted; _emit_step swallows the error."""
    class _BoomBus:
        def publish(self, *a, **k):  # noqa: ANN001, ANN002, ANN003
            raise RuntimeError("bus exploded")

    app_state._real_pipeline.event_bus = _BoomBus()
    try:
        mock_provider.push("router", json.dumps(
            {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
        mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.3))
        case = await app_state.pipeline.investigate_cluster(
            _cluster("7.7.7.7"), SourceSurface.INVESTIGATE, app_state.prefs)
    finally:
        app_state._real_pipeline.event_bus = app_state.event_bus

    # The run completed normally despite every publish raising.
    assert case.verdict == Verdict.NEEDS_HUMAN
    saved = await app_state.cases.get(case.case_id)
    assert saved is not None
    assert saved.case_id == case.case_id


# --------------------------------------------------------------------------- #
# (4) Mention badge lands on the allowlisted 'notifications' topic.
# --------------------------------------------------------------------------- #
async def test_mention_publishes_inapp_on_notifications_topic(collab_client):
    """An @mention's live in-app badge must publish to the ALLOWLISTED ``notifications``
    topic (event ``inapp``, per-user audience) so the Wave-4 bell EventSource receives
    it — the old un-allowlisted ``inbox`` topic was unreachable."""
    state: AppState = collab_client.app.state.tlsoc
    case = await _seed_case(state, "c-evt-mention")
    bus = state.event_bus

    # The mention target must exist in the user store for the fan-out to fire; with auth
    # OFF the store is empty and resolution falls back to the raw candidate, so a mention
    # still fans into the inbox. Subscribe as the mentioned user on the notifications
    # topic and assert the inapp badge arrives.
    target = "carol"
    gen = bus.subscribe(["notifications"], user=target).__aiter__()
    await gen.__anext__()  # connected

    resp = collab_client.post(
        f"/api/cases/{case.case_id}/thread",
        json={"body": f"hey @{target} take a look"},
    )
    assert resp.status_code == 200

    frame = (await gen.__anext__()).decode()
    assert "event: inapp\n" in frame
    assert f'"case_id":"{case.case_id}"' in frame
    await gen.aclose()
