"""Demo Mode chat isolation (Round-2 finding) — chat during demo is $0 + isolated.

Regression for the HIGH finding: ``AppState.chat_engine`` used to be a STATIC
attribute wired to the REAL gateway/_real_audit/_real_cases, so a /chat turn while
demo was engaged spent REAL LLM $ (broke the $0 demo guarantee), wrote PERMANENT
real audit rows (broke reversibility — disable_demo cannot purge them), and an
in-case chat read the REAL case store (so it never found the demo case).

The fix gives :class:`DemoStack` its own chat engine bound to the demo
gateway/audit/cases and makes ``AppState.chat_engine`` a demo-switchable @property
(``_demo.chat_engine`` in demo, ``_real_chat_engine`` off demo). These tests prove:

* a demo chat turn leaves ``_real_audit`` + ``_real_usage`` UNCHANGED (no real spend,
  no permanent real audit row),
* the demo chat engine writes its audit/usage into the DEMO store (purged on disable),
* an in-case demo chat resolves the DEMO case (the real store is hidden), and
* off demo, ``chat_engine`` is the real engine again — byte-for-byte as before.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from app.config import Secrets
from app.constants import EntityType, SourceSurface
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.state import AppState


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


@pytest.mark.asyncio
async def test_demo_chat_does_not_spend_real_or_write_real_audit(demo_state: AppState) -> None:
    state = demo_state
    # Baseline: real ledger + real audit are empty before any chat.
    real_usage0 = await state._real_usage_store.summary(window_hours=48)
    assert real_usage0["call_count"] == 0
    real_audit0 = await state._real_audit.records_for_actor("chat", 200)
    assert real_audit0 == []

    await state.enable_demo(mode="seeded", seed=1337, history_days=2)
    # The active chat engine IS the demo engine (switchable @property).
    assert state.chat_engine is state._demo.chat_engine
    assert state.chat_engine is not state._real_chat_engine

    # Drive a chat turn while demo is engaged.
    resp = await state.chat_engine.chat("what is happening on the network?", state.prefs)
    assert resp.answer  # the demo $0 mock answered

    # The REAL usage ledger is STILL empty — the turn metered through the DEMO gateway.
    real_usage1 = await state._real_usage_store.summary(window_hours=48)
    assert real_usage1["call_count"] == 0
    # The REAL audit log got NO chat rows (no permanent rows disable_demo can't purge).
    real_audit1 = await state._real_audit.records_for_actor("chat", 200)
    assert real_audit1 == []

    # The DEMO store DID record the chat (audit + $0 usage) — proving it landed there.
    demo_audit = await state._demo.audit.records_for_actor("chat", 200)
    assert any((a.get("action_type") == "prompt") for a in demo_audit), demo_audit
    demo_usage_rows = [
        d for idx in state._demo.es.docs for d in state._demo.es.docs[idx].values()
        if "pricing_source" in d
    ]
    assert demo_usage_rows, "expected the demo chat to write a usage row"
    assert {d["pricing_source"] for d in demo_usage_rows} == {"zero"}

    # Disable purges the demo audit/usage; the real state returns intact + untouched.
    await state.disable_demo()
    assert state.chat_engine is state._real_chat_engine
    real_usage2 = await state._real_usage_store.summary(window_hours=48)
    assert real_usage2["call_count"] == 0
    real_audit2 = await state._real_audit.records_for_actor("chat", 200)
    assert real_audit2 == []


@pytest.mark.asyncio
async def test_demo_in_case_chat_sees_demo_case_not_real(demo_state: AppState) -> None:
    state = demo_state
    # Seed a REAL case directly — it must stay HIDDEN from the demo chat.
    real_case = Case(
        case_id="case-real-77", cluster_signature="real-sig",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="9.9.9.9"),
    )
    await state._real_cases.save(real_case)

    await state.enable_demo(mode="seeded", seed=1337, history_days=3)
    # Pick a real demo case id to discuss.
    demo_cases, total = await state.cases.list(limit=5)
    assert total > 0 and demo_cases
    demo_case_id = demo_cases[0].case_id

    # The demo chat engine's case store IS the demo store: it RESOLVES the demo case
    # context (seed != "" only when the case is found) ...
    seed = await state.chat_engine._seed_context(demo_case_id)
    assert seed and demo_case_id in seed
    # ... and CANNOT see the real case (hidden during demo).
    assert await state.chat_engine._seed_context("case-real-77") == ""

    # A full in-case chat turn against the demo case still leaves the real store clean.
    resp = await state.chat_engine.chat("summarise this case", state.prefs, case_id=demo_case_id)
    assert resp.answer
    real_usage = await state._real_usage_store.summary(window_hours=48)
    assert real_usage["call_count"] == 0


@pytest.mark.asyncio
async def test_off_demo_chat_engine_is_the_real_engine(demo_state: AppState) -> None:
    # With demo OFF (the default), the property returns the real engine — the in-case
    # chat reads the REAL case store, exactly as before the switchable property.
    state = demo_state
    assert not state.demo_active
    assert state.chat_engine is state._real_chat_engine

    real_case = Case(
        case_id="case-real-11", cluster_signature="s",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
    )
    await state._real_cases.save(real_case)
    seed = await state.chat_engine._seed_context("case-real-11")
    assert seed and "case-real-11" in seed
