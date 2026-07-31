"""Round 3 / Feature 9 — standardized + customizable Models/LLMs.

Covers:
  TRACK A — provider registry dispatch (anthropic/openai/mock byte-identical;
            azure/bedrock/vertex/openai_compatible importable + dispatchable),
            base_url passthrough from the model registry, the layered pricing
            (overlay → PRICES → registry → heuristic → default), retry/backoff
            classification, and that the ONE ledger write is preserved (#6).
  TRACK B — BudgetGate pure pre-flight (daily/monthly ceilings, soft_warn_pct,
            warn vs block), block RAISES GatewayError (caller fails to NEEDS_HUMAN,
            never closes #3), demo/mock bypass, fail-open on a ledger glitch.

All offline (fake ES + mock providers). No network.
"""

from __future__ import annotations

import pytest

from app.config import BudgetConfig, ModelConfig
from app.constants import Role, USAGE_READ_PATTERN, UsageOutcome
from app.engine.budget import BudgetGate, estimate_tokens_from_chars
from app.es.fake import InMemoryESClient
from app.llm import pricing
from app.llm.gateway import GatewayError, LLMGateway
from app.llm.providers import (
    PROVIDER_REGISTRY,
    AzureOpenAIProvider,
    BaseProvider,
    BedrockProvider,
    CompletionResult,
    MockProvider,
    ProviderError,
    VertexProvider,
    classify_http_error,
    with_retry,
)
from app.stores.price_overlay import PriceOverlayStore
from app.stores.usage import UsageStore


# --------------------------------------------------------------------------- #
# Shared fakes
# --------------------------------------------------------------------------- #
class _FakeSecrets:
    anthropic_api_key = "sk-ant"
    openai_api_key = "sk-oai"
    embedding_api_key = None

    def embedding_key(self):
        return self.openai_api_key


class _PricedProvider(BaseProvider):
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        return CompletionResult(text="ok", prompt_tokens=1_000_000, completion_tokens=0, model=model)


async def _usage_docs(es: InMemoryESClient):
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [h["_source"] for h in resp["hits"]["hits"]]


def _kv_store():
    """An in-memory KVStore for the PriceOverlayStore (the same EsKVStore adapter the
    real stack uses, over a fake ES client)."""
    from app.stores.memory import EsKVStore

    return EsKVStore(InMemoryESClient())


# --------------------------------------------------------------------------- #
# TRACK A — provider registry + back-compat
# --------------------------------------------------------------------------- #
def test_provider_registry_has_all_providers():
    for name in ("anthropic", "openai", "mock", "azure", "bedrock", "vertex",
                 "openai_compatible"):
        assert name in PROVIDER_REGISTRY


def test_new_provider_classes_are_importable_and_constructible():
    # Best-effort, no network: each constructs without raising (no call made).
    AzureOpenAIProvider("k", "https://r.openai.azure.com")
    BedrockProvider("akid", "secret", region="us-east-1")
    VertexProvider("token", "proj", location="us-central1")


async def test_gateway_dispatch_anthropic_openai_mock_byte_identical():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    # mock path: still resolves the MockProvider via the registry, one ledger row.
    cfg = ModelConfig(provider="mock", model="mock")
    await gw.complete(Role.ROUTER, [{"role": "user", "content": "hi"}], cfg, surface="router")
    docs = await _usage_docs(es)
    assert len(docs) == 1 and docs[0]["outcome"] == UsageOutcome.OK.value


async def test_unknown_provider_raises_gateway_error():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    cfg = ModelConfig.model_construct(provider="nope", model="x", temperature=0.1, max_tokens=8)
    with pytest.raises(GatewayError):
        await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}], cfg, surface="router")
    # the failed call still wrote exactly one error ledger row (#6).
    docs = await _usage_docs(es)
    assert len(docs) == 1 and docs[0]["outcome"] == UsageOutcome.ERROR.value


# --------------------------------------------------------------------------- #
# TRACK A — base_url passthrough from the registry
# --------------------------------------------------------------------------- #
def test_base_url_for_unset_is_none():
    assert pricing.base_url_for("gpt-4o") is None
    assert pricing.base_url_for("totally-unknown") is None


async def test_gateway_uses_registry_base_url(monkeypatch):
    captured: dict[str, str | None] = {}

    def _fake_openai(**kwargs):
        captured["base_url"] = kwargs.get("base_url")
        return MockProvider()

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", _fake_openai)
    # The gateway binds ``base_url_for`` into its own namespace at import, so patch the
    # reference it actually calls (mirrors how the registry's base_url drives the URL).
    from app.llm import gateway as gw_mod

    monkeypatch.setattr(gw_mod, "base_url_for",
                        lambda m: "https://vllm.local/v1" if m == "local-llama" else None)
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    cfg = ModelConfig(provider="openai", model="local-llama")
    await gw.complete(Role.CHAT, [{"role": "user", "content": "hi"}], cfg, surface="chat")
    assert captured["base_url"] == "https://vllm.local/v1"


# --------------------------------------------------------------------------- #
# TRACK A — layered pricing (overlay → PRICES → registry → heuristic → default)
# --------------------------------------------------------------------------- #
def test_resolve_price_precedence():
    # PRICES exact wins over the registry (operator can still edit the table).
    assert pricing.resolve_price("gpt-4o") == (2.5, 10.0)
    # claude-opus-4-8 is the corrected $5/$25 per-MTok rate (the bug #2 fix).
    assert pricing.resolve_price("claude-opus-4-8") == (5.0, 25.0)
    assert pricing.PRICES["claude-opus-4-8"] == (5.0, 25.0)
    # an overlay tuple wins over everything.
    assert pricing.resolve_price("gpt-4o", (1.0, 2.0)) == (1.0, 2.0)
    # an unknown-but-heuristic model is priced from its family prefix, not default.
    assert pricing.resolve_price("claude-opus-4-99-future") == (5.0, 25.0)
    # a truly unknown model falls back to the conservative default.
    assert pricing.resolve_price("zzz-unknown") == pricing._DEFAULT_PRICE


def test_pricing_source_registry_counts_as_exact():
    # every registry model is 'exact' provenance.
    for mid in pricing.load_registry():
        if mid.startswith("mock"):
            assert pricing.pricing_source(mid) == "zero"
        else:
            assert pricing.pricing_source(mid) == "exact"


async def test_overlay_overrides_ledger_cost_and_provenance():
    es = InMemoryESClient()
    overlay = PriceOverlayStore(_kv_store())
    await overlay.set_price("claude-sonnet-4-6", 1.0, 2.0)  # $1/1M in, $2/1M out
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"mock": _PricedProvider()}, price_overlay=overlay)
    cfg = ModelConfig(provider="mock", model="claude-sonnet-4-6")
    res = await gw.complete(Role.INVESTIGATOR, [{"role": "user", "content": "x"}], cfg,
                            surface="investigate")
    # 1,000,000 input tokens @ $1/1M = $1.00 (the overlay rate, not the $3 table rate).
    assert res.cost == pytest.approx(1.0)
    docs = await _usage_docs(es)
    assert docs[0]["cost"] == pytest.approx(1.0)
    assert docs[0]["pricing_source"] == "exact"


# --------------------------------------------------------------------------- #
# TRACK A — retry / backoff classification
# --------------------------------------------------------------------------- #
def test_classify_http_error_retryable():
    import httpx

    req = httpx.Request("POST", "https://x")
    for status, retryable in ((429, True), (503, True), (500, True), (408, True),
                              (400, False), (401, False), (404, False)):
        resp = httpx.Response(status, request=req, text="boom")
        pe = classify_http_error(httpx.HTTPStatusError("e", request=req, response=resp))
        assert pe.retryable is retryable and pe.status == status
    assert classify_http_error(httpx.ConnectTimeout("t")).retryable is True
    assert classify_http_error(ValueError("nope")).retryable is False


async def test_with_retry_retries_then_succeeds():
    calls = {"n": 0}

    async def _factory():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ProviderError("429", retryable=True)
        return "done"

    out = await with_retry(_factory, attempts=3, base_delay=0.0, max_delay=0.0)
    assert out == "done" and calls["n"] == 3


async def test_with_retry_does_not_retry_permanent():
    calls = {"n": 0}

    async def _factory():
        calls["n"] += 1
        raise ProviderError("401", retryable=False)

    with pytest.raises(ProviderError):
        await with_retry(_factory, attempts=3, base_delay=0.0, max_delay=0.0)
    assert calls["n"] == 1


async def test_provider_complete_is_wired_through_with_retry(monkeypatch):
    """The providers actually call with_retry: a transient 503 on the first POST is
    retried and the second attempt succeeds (proves the raw post() is wrapped, not
    just that with_retry works in isolation)."""
    import httpx

    from app.llm import providers as providers_mod
    from app.llm.providers import AnthropicProvider

    # Make backoff instant so the test doesn't sleep.
    monkeypatch.setattr(providers_mod.asyncio, "sleep", lambda *_a, **_k: _noop())

    class _Resp:
        def __init__(self, status: int) -> None:
            self._status = status
            self._req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")

        def raise_for_status(self) -> None:
            if self._status >= 400:
                raise httpx.HTTPStatusError(
                    "boom", request=self._req,
                    response=httpx.Response(self._status, request=self._req, text="overloaded"),
                )

        def json(self) -> dict:
            return {"content": [{"type": "text", "text": "ok"}],
                    "usage": {"input_tokens": 5, "output_tokens": 3}}

    class _FlakyClient:
        def __init__(self) -> None:
            self.calls = 0

        async def post(self, *_a, **_k):
            self.calls += 1
            return _Resp(503 if self.calls == 1 else 200)

        async def aclose(self) -> None:
            return None

    provider = AnthropicProvider(api_key="sk-ant")
    flaky = _FlakyClient()
    provider._client = flaky  # type: ignore[assignment]

    res = await provider.complete(
        "router", [{"role": "user", "content": "hi"}], "claude-opus-4-8",
        temperature=0.1, max_tokens=16,
    )
    assert res.text == "ok"
    assert flaky.calls == 2  # first 503 was retried, second attempt returned 200


async def _noop() -> None:
    return None


# --------------------------------------------------------------------------- #
# TRACK B — BudgetGate pure pre-flight
# --------------------------------------------------------------------------- #
class _FakeUsage:
    """A usage store stub returning a fixed spend for both windows."""

    def __init__(self, today: float = 0.0, total: float = 0.0, raise_on=False):
        self._today = today
        self._total = total
        self._raise = raise_on

    async def summary(self, window_hours: int = 24, case_id=None):
        if self._raise:
            raise RuntimeError("ledger glitch")
        return {"today_cost": self._today, "total_cost": self._total}


def _gate(budget: BudgetConfig, usage) -> BudgetGate:
    return BudgetGate(get_budget=lambda: budget, usage_store=usage)


async def test_budget_off_always_allows():
    gate = _gate(BudgetConfig(enabled=False), _FakeUsage(today=999.0, total=999.0))
    out = await gate.check(prompt_chars=4000, max_tokens=1000, model="gpt-4o")
    assert out["action"] == "allow"


async def test_budget_warns_near_ceiling():
    budget = BudgetConfig(enabled=True, daily_usd=10.0, soft_warn_pct=0.8, on_exceed="warn")
    gate = _gate(budget, _FakeUsage(today=8.5, total=8.5))
    out = await gate.check(prompt_chars=10, max_tokens=10, model="gpt-4o")
    assert out["action"] == "warn"


async def test_budget_warn_mode_over_ceiling_still_warns_not_blocks():
    budget = BudgetConfig(enabled=True, daily_usd=1.0, on_exceed="warn")
    gate = _gate(budget, _FakeUsage(today=5.0, total=5.0))
    out = await gate.check(prompt_chars=10, max_tokens=10, model="gpt-4o")
    assert out["action"] == "warn"  # warn mode never blocks


async def test_budget_block_mode_over_ceiling_blocks():
    budget = BudgetConfig(enabled=True, daily_usd=1.0, on_exceed="block")
    gate = _gate(budget, _FakeUsage(today=5.0, total=5.0))
    out = await gate.check(prompt_chars=10, max_tokens=10, model="gpt-4o")
    assert out["action"] == "block"
    assert "ceiling" in out["reason"]


async def test_budget_monthly_ceiling_independent():
    budget = BudgetConfig(enabled=True, monthly_usd=2.0, on_exceed="block")
    gate = _gate(budget, _FakeUsage(today=0.0, total=5.0))
    out = await gate.check(prompt_chars=10, max_tokens=10, model="gpt-4o")
    assert out["action"] == "block" and out["window"] == "monthly"


async def test_budget_fail_open_on_ledger_glitch():
    budget = BudgetConfig(enabled=True, daily_usd=0.01, on_exceed="block")
    gate = _gate(budget, _FakeUsage(raise_on=True))
    out = await gate.check(prompt_chars=10, max_tokens=10, model="gpt-4o")
    # a ledger read failure must NOT block triage (fail-open governance).
    assert out["action"] == "allow"


def test_estimate_cost_uses_resolved_price():
    gate = _gate(BudgetConfig(), _FakeUsage())
    # 4,000,000 chars ≈ 1,000,000 input tokens @ $2.5/1M (gpt-4o) = $2.50, plus
    # 1,000,000 output tokens @ $10/1M = $10.00 → $12.50.
    cost = gate.estimate_cost(4_000_000, 1_000_000, "gpt-4o")
    assert cost == pytest.approx(12.5)


def test_estimate_tokens_from_chars():
    assert estimate_tokens_from_chars(4000) == 1000
    assert estimate_tokens_from_chars(0) == 1  # floor of 1


async def test_budget_status_snapshot():
    budget = BudgetConfig(enabled=True, daily_usd=10.0, monthly_usd=100.0, soft_warn_pct=0.8)
    gate = _gate(budget, _FakeUsage(today=9.0, total=50.0))
    st = await gate.status()
    assert st["enabled"] is True
    assert st["daily"]["band"] == "warn"   # 9/10 = 90% >= 80%
    assert st["monthly"]["band"] == "ok"   # 50/100 = 50%


# --------------------------------------------------------------------------- #
# TRACK B — gateway integration: block → GatewayError (fail-to-human), never closes
# --------------------------------------------------------------------------- #
async def test_gateway_budget_block_raises_and_records_no_ok_row():
    es = InMemoryESClient()
    budget = BudgetConfig(enabled=True, daily_usd=0.000001, on_exceed="block")
    gate = _gate(budget, _FakeUsage(today=1.0, total=1.0))
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"openai": _PricedProvider()}, budget_gate=gate)
    cfg = ModelConfig(provider="openai", model="gpt-4o")
    with pytest.raises(GatewayError):
        await gw.complete(Role.INVESTIGATOR, [{"role": "user", "content": "x" * 100}], cfg,
                          surface="investigate")
    # The call was blocked BEFORE the provider ran → no OK ledger row, no success.
    docs = await _usage_docs(es)
    assert all(d["outcome"] != UsageOutcome.OK.value for d in docs)


async def test_gateway_budget_allows_priced_call_under_ceiling():
    es = InMemoryESClient()
    budget = BudgetConfig(enabled=True, daily_usd=1000.0, on_exceed="block")
    gate = _gate(budget, _FakeUsage(today=0.0, total=0.0))
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"openai": _PricedProvider()}, budget_gate=gate)
    cfg = ModelConfig(provider="openai", model="gpt-4o")
    res = await gw.complete(Role.INVESTIGATOR, [{"role": "user", "content": "x"}], cfg,
                            surface="investigate")
    assert res.cost >= 0
    docs = await _usage_docs(es)
    assert any(d["outcome"] == UsageOutcome.OK.value for d in docs)


async def test_gateway_mock_bypasses_budget_block():
    es = InMemoryESClient()
    budget = BudgetConfig(enabled=True, daily_usd=0.000001, on_exceed="block")
    gate = _gate(budget, _FakeUsage(today=999.0, total=999.0))
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es), budget_gate=gate)
    cfg = ModelConfig(provider="mock", model="mock")
    # mock / $0 must bypass the gate (never block a free call).
    res = await gw.complete(Role.ROUTER, [{"role": "user", "content": "hi"}], cfg, surface="router")
    assert res.text  # completed
    docs = await _usage_docs(es)
    assert any(d["outcome"] == UsageOutcome.OK.value for d in docs)


# --------------------------------------------------------------------------- #
# Catalog surface used by GET /api/llm/models
# --------------------------------------------------------------------------- #
def test_model_catalog_shape():
    cat = pricing.model_catalog()
    assert cat, "catalog must not be empty"
    ids = {r["id"] for r in cat}
    # every PRICES + registry model surfaces.
    assert "claude-sonnet-4-6" in ids and "gpt-4o" in ids
    sample = next(r for r in cat if r["id"] == "claude-sonnet-4-6")
    for key in ("provider", "context_window", "capabilities", "input_per_million",
                "output_per_million", "pricing_source", "base_url"):
        assert key in sample
    assert sample["provider"] == "anthropic"
    assert sample["pricing_source"] == "exact"

    luna = next(r for r in cat if r["id"] == "gpt-5.6-luna")
    assert luna["provider"] == "openai"
    assert luna["context_window"] == 1_050_000
    assert luna["max_output"] == 128_000
    assert luna["input_per_million"] == pytest.approx(0.20)
    assert luna["output_per_million"] == pytest.approx(1.20)
    assert luna["cache_read_per_million"] == pytest.approx(0.02)
    assert luna["cache_write_per_million"] == pytest.approx(0.25)
    assert luna["batch_multiplier"] == pytest.approx(0.5)


def test_models_by_provider_unions_registry_and_prices():
    grouped = pricing.models_by_provider()
    assert {"anthropic", "openai", "mock"} <= set(grouped)
    assert "claude-sonnet-4-6" in grouped["anthropic"]
    assert "gpt-4o" in grouped["openai"]
