"""Demo Mode (Wave 5) — determinism, isolation, lifecycle, $0, decide() guard.

The non-negotiable spine of this feature:
  * SEEDED DETERMINISM — same seed → identical synthetic events + identical
    historical case spread.
  * ISOLATION — demo never writes the real stores; the write-guard rejects a
    mismatched row; the real durable poll cursor is untouched.
  * REVERSIBLE LIFECYCLE — enable → reset → disable purges demo and the real state
    returns intact.
  * $0 COST — every demo usage row is pricing_source='zero'.
  * #3 BYTE-IDENTICAL — case_manager.decide()/apply() are unedited (a sandboxed
    policy copy is the only isolation lever).
"""

from __future__ import annotations

import inspect
import random

import pytest
import pytest_asyncio

from app.config import Secrets
from app.constants import SourceSurface, Verdict
from app.engine import case_manager, demo_generator as gen
from app.es.fake import InMemoryESClient
from app.llm.providers import DemoMockProvider, MockProvider
from app.state import AppState
from app.utils import now_utc, to_millis


@pytest_asyncio.fixture
async def demo_state():
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )
    es = InMemoryESClient()
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}
    state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    yield state
    await state.shutdown()


# --------------------------------------------------------------------------- #
# Seeded determinism
# --------------------------------------------------------------------------- #
def test_seeded_org_is_deterministic() -> None:
    a = gen.build_org(1337)
    b = gen.build_org(1337)
    assert [h.name for h in a.hosts] == [h.name for h in b.hosts]
    assert [h.ip for h in a.hosts] == [h.ip for h in b.hosts]
    # The fixture has a DC, a VIP laptop, servers + a corp /16.
    kinds = {h.kind for h in a.hosts}
    assert {"dc", "vip_laptop", "server", "workstation"} <= kinds
    assert a.cidr.endswith("/16")
    assert len(a.employees) >= 12 and len(a.hosts) >= 40


def test_seeded_benign_events_are_identical() -> None:
    org = gen.build_org(1337)
    r1, r2 = random.Random(7), random.Random(7)
    a = gen.generate_benign_batch(r1, org, 1_700_000_000_000, 20)
    b = gen.generate_benign_batch(r2, org, 1_700_000_000_000, 20)
    assert a == b
    # A different seed yields a different stream.
    c = gen.generate_benign_batch(random.Random(8), org, 1_700_000_000_000, 20)
    assert a != c


def test_seeded_historical_spread_is_identical() -> None:
    org = gen.build_org(1337)
    now = 1_700_000_000_000
    a = gen.generate_historical_cases(1337, org, history_days=14, run_id="run-A", now_millis=now)
    b = gen.generate_historical_cases(1337, org, history_days=14, run_id="run-A", now_millis=now)
    # Same seed + run_id → byte-identical spread.
    assert [c.case_id for c in a] == [c.case_id for c in b]
    assert [c.model_dump(mode="json") for c in a] == [c.model_dump(mode="json") for c in b]
    # Every status / disposition / verdict appears; a couple stay OPEN for HITL.
    statuses = {c.status.value for c in a}
    dispositions = {c.disposition.value for c in a if c.disposition}
    verdicts = {c.verdict.value for c in a if c.verdict}
    assert {"resolved", "closed", "escalated", "on_hold"} <= statuses
    assert {"true_positive", "false_positive", "benign", "duplicate"} <= dispositions
    assert Verdict.NEEDS_HUMAN.value in verdicts  # an open HITL case exists
    # Some cases carry the richer feature data.
    assert any(c.notifications_sent for c in a)
    assert any(c.automation_actions for c in a)
    assert any(c.comments for c in a)


@pytest.mark.asyncio
async def test_enable_is_deterministic_across_states() -> None:
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)

    async def _spread():
        st = AppState.create(
            secrets=secrets, es=InMemoryESClient(),
            provider_overrides={"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()},
        )
        await st.startup(start_poller=False)
        await st.update_prefs(st.prefs.model_copy(update={"setup_complete": True}))
        await st.enable_demo(mode="seeded", seed=4242, history_days=10)
        cases, _ = await st.cases.list(limit=300, sort_field="created_at")
        ids = sorted(c.case_id for c in cases)
        await st.shutdown()
        return ids

    a = await _spread()
    b = await _spread()
    assert a == b and len(a) > 0


# --------------------------------------------------------------------------- #
# Isolation + write-guard
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_demo_never_writes_the_real_store(demo_state: AppState) -> None:
    # Real store empty before.
    _rc, rt0 = await demo_state._real_cases.list(limit=10)
    assert rt0 == 0

    await demo_state.enable_demo(mode="live", seed=1337, history_days=7)
    # The active store now serves DEMO cases (real hidden).
    cases, total = await demo_state.cases.list(limit=10)
    assert total > 0 and all("demo" in c.tags for c in cases)

    # Drive several ticks (benign + storylines) through the demo pipeline.
    for _ in range(8):
        await demo_state.demo_tick()

    # The REAL store is STILL empty — nothing leaked.
    _rc, rt1 = await demo_state._real_cases.list(limit=50)
    assert rt1 == 0
    # Real usage ledger is untouched (every LLM call went to the demo gateway).
    real_usage = await demo_state._real_usage_store.summary(window_hours=48)
    assert real_usage["call_count"] == 0


def test_write_guard_rejects_mismatched_rows() -> None:
    from app.models import Case, Entity
    from app.constants import EntityType

    real = Case(case_id="case-real-1", cluster_signature="s",
                source_surface=SourceSurface.AUTOMATED_SCAN,
                entity=Entity(type=EntityType.IP, value="1.2.3.4"))
    demo = Case(case_id="demo-x-0001", cluster_signature="s2",
                source_surface=SourceSurface.AUTOMATED_SCAN,
                entity=Entity(type=EntityType.IP, value="5.6.7.8"), tags=["demo"])
    # A demo write must carry a demo row; a real write must NOT.
    AppState._write_guard(demo, demo=True)        # ok
    AppState._write_guard(real, demo=False)       # ok
    with pytest.raises(AssertionError):
        AppState._write_guard(real, demo=True)
    with pytest.raises(AssertionError):
        AppState._write_guard(demo, demo=False)


@pytest.mark.asyncio
async def test_real_poll_cursor_untouched_in_demo(demo_state: AppState) -> None:
    # Record the real durable cursor, enable demo, drive ticks, assert it never moved.
    before = await demo_state.cursor_store.load()
    await demo_state.enable_demo(mode="live", seed=1337, history_days=3)
    for _ in range(6):
        await demo_state.demo_tick()
    after = await demo_state.cursor_store.load()
    assert (after.timestamp_millis, tuple(after.boundary_ids)) == (
        before.timestamp_millis, tuple(before.boundary_ids)
    )


# --------------------------------------------------------------------------- #
# Lifecycle: enable → reset → disable
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_enable_reset_disable_lifecycle(demo_state: AppState) -> None:
    s1 = await demo_state.enable_demo(mode="seeded", seed=1337, history_days=7)
    assert s1["active"] and s1["mode"] == "seeded" and s1["case_count"] > 0
    run1 = s1["run_id"]

    # Reset re-seeds with a NEW run_id but the same deterministic spread size.
    s2 = await demo_state.reset_demo()
    assert s2["active"] and s2["run_id"] != run1
    assert s2["case_count"] == s1["case_count"]

    # Disable purges demo + flips off; the real (empty) store returns.
    s3 = await demo_state.disable_demo()
    assert s3["mode"] == "off" and not s3["active"]
    assert not demo_state.demo_active
    _cases, total = await demo_state.cases.list(limit=10)
    assert total == 0  # back to the (empty) real store
    assert demo_state.prefs.demo.mode == "off" and demo_state.prefs.demo.run_id == ""


# --------------------------------------------------------------------------- #
# $0 cost — every demo usage row is pricing_source='zero'
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_demo_cost_is_zero_priced(demo_state: AppState) -> None:
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    # Ignite a TRUE_POSITIVE storyline so the demo pipeline makes LLM calls.
    from app.connectors.demo import DemoPullConnector

    src = DemoPullConnector(seed=1337)
    dprefs = demo_state._demo._demo_prefs()
    raws = src.storyline_raw(
        gen._STORYLINE_BY_ID["phishing_chain"], random.Random(1), to_millis(now_utc()), dprefs,
    )
    await demo_state._demo.ingest_service.ingest(
        raws, dprefs, source_surface=SourceSurface.AUTOMATED_SCAN, source_id=gen.DEMO_SOURCE_ID,
    )
    # Every demo usage row is pricing_source='zero' (a $0 mock run).
    demo_es = demo_state._demo.es
    usage = [d for idx in demo_es.docs for d in demo_es.docs[idx].values() if "pricing_source" in d]
    assert usage, "expected the demo pipeline to write usage rows"
    assert {d["pricing_source"] for d in usage} == {"zero"}


# --------------------------------------------------------------------------- #
# Scenario-keyed verdicts (deterministic) + NEEDS_HUMAN stays open
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_storyline_verdicts_are_scenario_keyed(demo_state: AppState) -> None:
    from app.connectors.demo import DemoPullConnector

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    src = DemoPullConnector(seed=1337)
    dprefs = demo_state._demo._demo_prefs()
    now = to_millis(now_utc())

    async def _ignite(sid: str):
        before, _ = await demo_state.cases.list(limit=400)
        before_ids = {c.case_id for c in before}
        raws = src.storyline_raw(gen._STORYLINE_BY_ID[sid], random.Random(3), now + hash(sid) % 5000, dprefs)
        await demo_state._demo.ingest_service.ingest(
            raws, dprefs, source_surface=SourceSurface.AUTOMATED_SCAN, source_id=gen.DEMO_SOURCE_ID,
        )
        after, _ = await demo_state.cases.list(limit=400)
        return [c for c in after if c.case_id not in before_ids and c.verdict is not None]

    tp = await _ignite("ransomware_beacon")
    assert tp and all(c.verdict == Verdict.TRUE_POSITIVE for c in tp)
    # TRUE_POSITIVE is NOT auto-closed (tp auto-close off in the sandboxed copy).
    assert all(c.status.value != "closed" for c in tp)

    nh = await _ignite("impossible_travel")
    assert nh and all(c.verdict == Verdict.NEEDS_HUMAN for c in nh)
    # NEEDS_HUMAN ALWAYS stays open for the HITL showcase.
    assert all(c.status.value != "closed" for c in nh)


def test_demo_mock_provider_resolves_story_from_uid() -> None:
    prov = DemoMockProvider()
    # A prompt carrying a storyline UID resolves to that story's verdict.
    story = gen._STORYLINE_BY_ID["phishing_chain"]
    msgs = [{"role": "user", "content": f"cluster rules: demo_{story.id} extra noise"}]
    story_resolved = DemoMockProvider._resolve(msgs)
    assert story_resolved is not None and story_resolved.id == story.id
    # The benign baseline resolves to no story (→ a confident FALSE_POSITIVE).
    assert DemoMockProvider._resolve([{"role": "user", "content": "web_auth login success"}]) is None


# --------------------------------------------------------------------------- #
# #3 byte-identical guard
# --------------------------------------------------------------------------- #
def test_decide_and_apply_are_byte_identical() -> None:
    """Demo Mode must NOT have touched the deterministic decision (#3). The sandboxed
    policy is passed as a different instance to the unchanged pure decide()."""
    src = inspect.getsource(case_manager.decide)
    assert "if entry is not None and entry.enabled:" in src
    assert "if confidence >= entry.min_confidence and risk_score <= entry.max_risk_score:" in src
    assert "status=CaseStatus.CLOSED," in src
    assert "decision_by=DecisionBy.AGENT," in src
    # decide() knows nothing about demo.
    assert "demo" not in src.lower()
    apply_src = inspect.getsource(case_manager.CaseManager.apply)
    assert "Invariant violated: attempted to auto-close a NEEDS_HUMAN case" in apply_src
    assert "demo" not in apply_src.lower()


def test_sandbox_policy_is_a_distinct_copy() -> None:
    from app.config import Preferences
    from app.engine.demo_runtime import sandbox_policy

    prefs = Preferences()
    sandboxed = sandbox_policy(prefs.auto_close)
    assert sandboxed is not prefs.auto_close                    # a different instance
    assert sandboxed.model_dump() == prefs.auto_close.model_dump()  # equal content
    # NEEDS_HUMAN never auto-closes in the sandboxed policy (code-enforced regardless).
    assert sandboxed.needs_human.enabled is False


# --------------------------------------------------------------------------- #
# Read endpoints serve the active (demo) store; real hidden
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_read_endpoints_serve_demo_store(demo_state: AppState) -> None:
    # Seed a REAL case directly so we can prove it is HIDDEN during demo.
    from app.models import Case, Entity
    from app.constants import EntityType

    real_case = Case(case_id="case-real-99", cluster_signature="real-sig",
                     source_surface=SourceSurface.AUTOMATED_SCAN,
                     entity=Entity(type=EntityType.IP, value="9.9.9.9"))
    await demo_state._real_cases.save(real_case)

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=5)
    cases, _ = await demo_state.cases.list(limit=300)
    case_ids = {c.case_id for c in cases}
    assert "case-real-99" not in case_ids        # real case hidden during demo
    assert all("demo" in c.tags for c in cases)  # only demo cases visible

    await demo_state.disable_demo()
    cases2, _ = await demo_state.cases.list(limit=300)
    ids2 = {c.case_id for c in cases2}
    assert "case-real-99" in ids2                # real case back after disable
