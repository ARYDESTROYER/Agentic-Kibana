"""Round-3 Wave-5 — models / budget / LLM-ledger honesty fixes (1 MEDIUM + LOW/INFO).

Offline (fake ES + mock LLM). Locks six correctness fixes so they cannot regress:

1. (MEDIUM) The window usage summary is EXACT regardless of row count — the old
   ``size:10000`` hit fetch silently under-counted a >10 000-row window and defeated
   the BudgetGate's monthly / high-volume-daily ceiling. The fix issues a ``sum``
   aggregation (real ES) or transparently pages every row (the aggregation-less test
   fake), and the ES + SQL backends now report identical totals.
2. (LOW) The ``vertex`` provider ``configured`` flag reads the credential that
   actually exists (``vertex_api_key``), not a non-existent ``vertex_access_token``.
3. (INFO) The ``azure`` provider is ``configured`` only when an endpoint exists, not
   on an OpenAI key alone (which would DNS-fail at a placeholder host).
4. (LOW) ``POST /api/llm/models/test`` badges ``pricing_source`` through the active
   operator price overlay, byte-identical to the ledger row the same call wrote.
5. (INFO) A budget-BLOCKED model test returns ``ok:false`` and writes ZERO ledger
   rows (the block raises before any provider call / ledger write).
6. (LOW) Demo-mode embedding rows carry the deterministic SYNTHETIC cost (matching
   their ``pricing_source='zero'`` "simulated" badge), not the real table rate.

None of this touches ``case_manager.decide()`` (#3); the ONE ledger write per call
(#6) is preserved end to end.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.config import BudgetConfig, ModelConfig, Secrets
from app.constants import Role, USAGE_READ_PATTERN, UsageOutcome
from app.engine.budget import BudgetGate
from app.es.fake import InMemoryESClient
from app.llm import pricing
from app.llm.gateway import GatewayError, LLMGateway
from app.llm.providers import CompletionResult, MockProvider
from app.models import UsageDoc
from app.stores.usage import UsageStore
from app.utils import now_utc, to_millis


# --------------------------------------------------------------------------- #
# Shared helpers / fakes
# --------------------------------------------------------------------------- #
class _FakeSecrets:
    """Mirrors config.Secrets' configured_status() for the provider-flag tests.

    The route reads ONLY the configured-boolean map (one source of truth), so a
    stub that returns the map is sufficient — and proves the route never reaches
    around the map to a wrong attribute name."""

    def __init__(self, **flags: bool) -> None:
        self._flags = flags

    def configured_status(self) -> dict[str, bool]:
        return dict(self._flags)


async def _usage_docs(es: InMemoryESClient) -> list[dict]:
    resp = await es.search(USAGE_READ_PATTERN, {"size": 10000, "query": {"match_all": {}}})
    return [h["_source"] for h in resp["hits"]["hits"]]


def _iso(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()


# --------------------------------------------------------------------------- #
# Finding 1 (MEDIUM) — usage summary is exact past the old 10 000-doc cap
# --------------------------------------------------------------------------- #
async def _seed_usage(store, n: int, *, per_cost: float, days_span: int) -> None:
    """Seed ``n`` usage rows of ``per_cost`` each, spread ascending over the last
    ``days_span`` days, through the real UsageStore.write() path (#6 ledger shape)."""
    now_ms = to_millis(now_utc())
    span_ms = days_span * 24 * 3600 * 1000
    for i in range(n):
        ts_ms = now_ms - span_ms + (span_ms * i) // max(1, n)
        await store.write(UsageDoc(
            ts=_iso(ts_ms), surface="investigate", role="investigator",
            model="gpt-4o", prompt_tokens=10, completion_tokens=0, total_tokens=10,
            cost=per_cost,
        ))


@pytest.mark.asyncio
async def test_summary_counts_every_row_past_the_10000_cap() -> None:
    es = InMemoryESClient()
    store = UsageStore(es)
    n = 12000
    await _seed_usage(store, n, per_cost=1.0, days_span=29)  # inside a 30-day window

    summ = await store.summary(window_hours=720)  # 30 days
    # The OLD size:10000 fetch capped this at ~10000.0 / call_count 10000 — under-count.
    assert summ["total_cost"] == pytest.approx(float(n))   # 12000.0, not ~10000.0
    assert summ["call_count"] == n
    assert summ["total_tokens"] == n * 10
    # The per-model breakdown is summed over EVERY row too (not the truncated head).
    by_model = {r["key"]: r for r in summ["by_model"]}
    assert by_model["gpt-4o"]["cost"] == pytest.approx(float(n))
    assert by_model["gpt-4o"]["calls"] == n


@pytest.mark.asyncio
async def test_budget_gate_blocks_on_full_monthly_spend_not_the_truncated_total() -> None:
    es = InMemoryESClient()
    store = UsageStore(es)
    await _seed_usage(store, 12000, per_cost=1.0, days_span=29)  # $12 000 in 30 days

    gate = BudgetGate(
        get_budget=lambda: BudgetConfig(enabled=True, monthly_usd=5000.0, on_exceed="block"),
        usage_store=store,
    )
    decision = await gate.check(prompt_chars=40, max_tokens=10, model="gpt-4o")
    # Monthly spend ($12 000) is WAY over the $5000 ceiling — the gate must block.
    # With the old 10 000-doc cap the monthly read returned only ~$10 000 (still over
    # here), but the cap defeats any ceiling between 10 000 and the true total; this
    # asserts the gate now sees the true, exact monthly figure.
    assert decision["action"] == "block"
    assert decision["window"] == "monthly"


@pytest.mark.asyncio
async def test_es_and_sql_usage_summaries_agree_past_the_cap() -> None:
    """Lock the two backends to identical totals so the truncation can't reappear on
    one side. The SQL repo already scans all rows; the ES repo now does too."""
    from app.stores.sql.engine import build_async_engine, create_all
    from app.stores.sql.repositories import SqlUsageRepository

    es = InMemoryESClient()
    es_store = UsageStore(es)
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    sql_store = SqlUsageRepository(engine)

    now_ms = to_millis(now_utc())
    span_ms = 29 * 24 * 3600 * 1000
    n = 11000
    for i in range(n):
        ts_ms = now_ms - span_ms + (span_ms * i) // n
        doc = UsageDoc(ts=_iso(ts_ms), surface="chat", role="chat", model="gpt-4o",
                       prompt_tokens=5, completion_tokens=0, total_tokens=5, cost=0.5)
        await es_store.write(doc)
        await sql_store.write(doc)

    es_summ = await es_store.summary(window_hours=720)
    sql_summ = await sql_store.summary(window_hours=720)
    assert es_summ["total_cost"] == pytest.approx(sql_summ["total_cost"])
    assert es_summ["call_count"] == sql_summ["call_count"] == n
    assert es_summ["total_tokens"] == sql_summ["total_tokens"]
    await engine.dispose()


@pytest.mark.asyncio
async def test_summary_today_window_is_exact_under_the_cap() -> None:
    """A small, today-only set is byte-identical to the legacy per-hit numbers (no
    regression on the common path); the fallback scan reproduces them exactly."""
    es = InMemoryESClient()
    store = UsageStore(es)
    now_ms = to_millis(now_utc())
    for i in range(5):
        await store.write(UsageDoc(
            ts=_iso(now_ms - i * 60_000), surface="standup", role="standup",
            model="claude-sonnet-4-6", prompt_tokens=3, completion_tokens=2,
            total_tokens=5, cost=0.01,
        ))
    summ = await store.summary(window_hours=24)
    assert summ["call_count"] == 5
    assert summ["total_cost"] == pytest.approx(0.05)
    assert summ["today_cost"] == pytest.approx(0.05)
    assert summ["total_tokens"] == 25


# --------------------------------------------------------------------------- #
# Findings 2 + 3 (LOW/INFO) — provider configured-flag correctness
# --------------------------------------------------------------------------- #
def _providers_payload(secrets) -> dict:
    """Invoke the llm_providers route handler with a minimal fake AppState."""
    from app.api import routes_models

    class _State:
        pass

    st = _State()
    st.secrets = secrets

    # The handler is async; drive it on a fresh loop with the fake state.
    import asyncio

    return asyncio.run(routes_models.llm_providers(state=st))


def _provider_entry(payload: dict, name: str) -> dict:
    return next(p for p in payload["providers"] if p["name"] == name)


def test_vertex_configured_reads_vertex_api_key() -> None:
    payload = _providers_payload(_FakeSecrets(vertex_api_key=True))
    assert _provider_entry(payload, "vertex")["configured"] is True


def test_vertex_not_configured_without_its_key() -> None:
    payload = _providers_payload(_FakeSecrets(vertex_api_key=False))
    assert _provider_entry(payload, "vertex")["configured"] is False
    # The OLD code read ``vertex_access_token`` — a field that does not exist on
    # Secrets — so it was permanently False; guard against re-introducing it.
    assert not hasattr(Secrets(_env_file=None), "vertex_access_token")


def test_azure_requires_endpoint_not_just_a_key() -> None:
    # Only an OpenAI key, no Azure endpoint → NOT configured (would DNS-fail).
    only_key = _providers_payload(_FakeSecrets(openai_api_key=True))
    assert _provider_entry(only_key, "azure")["configured"] is False
    # Azure key set but endpoint missing → still NOT configured.
    key_no_ep = _providers_payload(_FakeSecrets(azure_openai_api_key=True))
    assert _provider_entry(key_no_ep, "azure")["configured"] is False
    # Key (own or OpenAI) AND endpoint → configured.
    full = _providers_payload(_FakeSecrets(azure_openai_api_key=True,
                                           azure_openai_endpoint=True))
    assert _provider_entry(full, "azure")["configured"] is True
    on_oai = _providers_payload(_FakeSecrets(openai_api_key=True,
                                             azure_openai_endpoint=True))
    assert _provider_entry(on_oai, "azure")["configured"] is True


def test_anthropic_openai_bedrock_flags_use_the_configured_map() -> None:
    payload = _providers_payload(_FakeSecrets(
        anthropic_api_key=True, openai_api_key=False, aws_access_key_id=True))
    assert _provider_entry(payload, "anthropic")["configured"] is True
    assert _provider_entry(payload, "openai")["configured"] is False
    assert _provider_entry(payload, "bedrock")["configured"] is True
    # mock + openai_compatible are always usable (no credential needed).
    assert _provider_entry(payload, "mock")["configured"] is True
    assert _provider_entry(payload, "openai_compatible")["configured"] is True


# --------------------------------------------------------------------------- #
# Finding 4 (LOW) — model_test pricing_source honors the operator overlay
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def models_client(app_state):
    """A TestClient mounting only the models router over the offline AppState."""
    from app.api.deps import require_auth
    from app.api.routes_models import router

    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


# A model id that is NOT in PRICES and NOT in the registry, so its TABLE provenance
# is 'heuristic'/'default' — making an overlay's 'exact' badge unambiguous.
_UNKNOWN_MODEL = "selfhosted-llama-70b"


def test_unknown_model_table_provenance_is_not_exact() -> None:
    # Sanity: without an overlay this model is NOT 'exact', so the overlay test below
    # is meaningful (it must flip the badge).
    assert pricing.pricing_source(_UNKNOWN_MODEL) in ("heuristic", "default")


async def test_model_test_pricing_source_applies_overlay(models_client, app_state) -> None:
    # Set an operator price override for the unknown model, then test it.
    r0 = models_client.put(
        f"/api/llm/models/{_UNKNOWN_MODEL}/pricing",
        json={"input_per_million": 0.5, "output_per_million": 1.0},
    )
    assert r0.status_code == 200 and r0.json()["pricing_source"] == "exact"

    r = models_client.post("/api/llm/models/test",
                           json={"model": _UNKNOWN_MODEL, "provider": "mock"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    # The dialog badge must read 'exact' because an overlay is active — NOT the
    # table's 'heuristic'/'default' provenance.
    assert body["pricing_source"] == "exact"

    # ...and it must agree with the ledger row the SAME call wrote (#6 one row).
    docs = await _usage_docs(app_state._real_usage_store._es)  # type: ignore[attr-defined]
    rows = [d for d in docs if d.get("surface") == "model_test"]
    assert rows, "the model test must write exactly one ledger row"
    assert all(d["pricing_source"] == "exact" for d in rows)


async def test_model_test_pricing_source_without_overlay_matches_table(
    models_client, app_state
) -> None:
    # No override → the badge is the table provenance and matches the ledger row.
    r = models_client.post("/api/llm/models/test",
                           json={"model": _UNKNOWN_MODEL, "provider": "mock"})
    body = r.json()
    assert body["ok"] is True
    assert body["pricing_source"] == pricing.pricing_source(_UNKNOWN_MODEL)
    docs = await _usage_docs(app_state._real_usage_store._es)  # type: ignore[attr-defined]
    rows = [d for d in docs if d.get("surface") == "model_test"]
    assert rows and all(d["pricing_source"] == body["pricing_source"] for d in rows)


# --------------------------------------------------------------------------- #
# Finding 5 (INFO) — a budget-BLOCKED model test: ok:false + ZERO ledger rows
# --------------------------------------------------------------------------- #
class _PricedProvider(MockProvider):
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        return CompletionResult(text="ok", prompt_tokens=1_000_000, completion_tokens=0,
                                model=model)


class _BlockingUsage:
    async def summary(self, window_hours: int = 24, case_id=None):
        return {"today_cost": 1000.0, "total_cost": 1000.0}

    async def write(self, doc):  # never expected to be called on a block
        raise AssertionError("a budget BLOCK must not write any ledger row")


async def test_budget_block_writes_zero_ledger_rows() -> None:
    """A budget block raises in pre-flight BEFORE the provider call and BEFORE any
    ledger write — so zero rows, not one error row. (Locks the corrected comment.)"""
    es = InMemoryESClient()
    budget = BudgetConfig(enabled=True, daily_usd=0.000001, on_exceed="block")
    gate = BudgetGate(get_budget=lambda: budget, usage_store=_BlockingUsage())
    gw = LLMGateway(
        secrets=_FakeSecretsForGateway(), usage_store=UsageStore(es),
        provider_overrides={"openai": _PricedProvider()}, budget_gate=gate,
    )
    cfg = ModelConfig(provider="openai", model="gpt-4o")
    with pytest.raises(GatewayError):
        await gw.complete(Role.INVESTIGATOR, [{"role": "user", "content": "x" * 100}], cfg,
                          surface="investigate")
    docs = await _usage_docs(es)
    assert docs == [], "a budget BLOCK must write ZERO ledger rows (it raises pre-call)"


async def test_provider_failure_after_preflight_writes_exactly_one_error_row() -> None:
    """The OTHER branch the comment describes: a provider that runs and FAILS under an
    under-ceiling budget records exactly one ERROR row."""
    es = InMemoryESClient()
    budget = BudgetConfig(enabled=True, daily_usd=10_000.0, on_exceed="block")
    gate = BudgetGate(get_budget=lambda: budget,
                      usage_store=_UnderCeilingUsage())

    class _FailingProvider(MockProvider):
        async def complete(self, role, messages, model, temperature, max_tokens):
            raise RuntimeError("provider boom")

    gw = LLMGateway(
        secrets=_FakeSecretsForGateway(), usage_store=UsageStore(es),
        provider_overrides={"openai": _FailingProvider()}, budget_gate=gate,
    )
    cfg = ModelConfig(provider="openai", model="gpt-4o")
    with pytest.raises(GatewayError):
        await gw.complete(Role.INVESTIGATOR, [{"role": "user", "content": "hi"}], cfg,
                          surface="investigate")
    docs = await _usage_docs(es)
    assert len(docs) == 1 and docs[0]["outcome"] == UsageOutcome.ERROR.value


class _FakeSecretsForGateway:
    anthropic_api_key = "sk-ant"
    openai_api_key = "sk-oai"
    embedding_api_key = None

    def embedding_key(self):
        return self.openai_api_key


class _UnderCeilingUsage:
    async def summary(self, window_hours: int = 24, case_id=None):
        return {"today_cost": 0.0, "total_cost": 0.0}

    async def write(self, doc):
        return None


# --------------------------------------------------------------------------- #
# Finding 6 (LOW) — demo embedding rows carry the synthetic ($0) cost, not table cost
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def demo_state():
    from app.llm.providers import MockProvider as MP
    from app.state import AppState

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    es = InMemoryESClient()
    overrides = {"anthropic": MP(), "openai": MP(), "mock": MP()}
    state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    yield state
    await state.shutdown()


@pytest.mark.asyncio
async def test_demo_embedding_cost_is_synthetic_not_table_rate(demo_state) -> None:
    from app.llm.gateway import _DEMO_IN_RATE, _demo_synthetic_cost

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    demo_gw = demo_state._demo.gateway  # the deterministic demo gateway

    # Drive a real embedding through the demo gateway (input-only).
    text = "x" * 4000  # ~1000 tokens by the 4-chars/token estimator
    cfg = ModelConfig(provider="openai", model="text-embedding-3-small")
    await demo_gw.embed([text], cfg, surface="rag")

    demo_es = demo_state._demo.es
    rows = [d for idx in demo_es.docs for d in demo_es.docs[idx].values()
            if d.get("role") == Role.EMBEDDING.value]
    assert rows, "expected at least one demo embedding ledger row"
    for d in rows:
        # Every demo row is 'zero'-provenance (a $0 simulated run)...
        assert d["pricing_source"] == "zero"
        # ...and the cost is the DETERMINISTIC synthetic value, NOT the real
        # text-embedding-3-small table rate (prompt_tokens/1e6 * 0.02).
        ptoks = int(d["prompt_tokens"])
        assert d["cost"] == pytest.approx(_demo_synthetic_cost(ptoks, 0))
        real_table_cost = (ptoks / 1_000_000.0) * 0.02
        if ptoks > 0:
            assert d["cost"] != pytest.approx(real_table_cost)
        # The synthetic input rate is the blended demo rate, not the embed table rate.
        assert _DEMO_IN_RATE != 0.02 / 1_000_000.0
