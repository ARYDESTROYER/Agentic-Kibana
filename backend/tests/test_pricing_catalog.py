"""C3-6a: expanded OpenAI price catalog + per-model param quirks.

Asserts (a) the new OpenAI models are priced (not the default fallback),
(b) provider_for maps the o-series and gpt-5 to ``openai``, and (c) the
OpenAIProvider param-branching: reasoning/gpt-5 models omit ``temperature`` and
send ``max_completion_tokens``, while classic gpt-4o models keep
``temperature`` + ``max_tokens``. The HTTP call is mocked at the httpx boundary.
"""

from __future__ import annotations

import pytest

from app.llm.pricing import PRICES, _DEFAULT_PRICE, models_by_provider, provider_for
from app.llm.providers import OpenAIProvider, _is_reasoning_or_gpt5

NEW_OPENAI_MODELS = [
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4-turbo",
    "gpt-4",
    "o4-mini",
    "gpt-5",
    "gpt-5-mini",
]


# ---------- (a) catalog: new models priced, default path intact ----------
def test_new_openai_models_are_priced():
    for model in NEW_OPENAI_MODELS:
        assert model in PRICES, f"{model} missing from PRICES"
        price = PRICES[model]
        assert price != _DEFAULT_PRICE, f"{model} must have a non-default price"
        in_price, out_price = price
        assert in_price > 0 and out_price > 0


def test_existing_prices_unchanged():
    assert PRICES["gpt-4o"] == (2.5, 10.0)
    assert PRICES["gpt-4o-mini"] == (0.15, 0.60)
    assert PRICES["claude-opus-4-8"] == (5.0, 25.0)


def test_unknown_model_still_falls_back_to_default():
    from app.llm.pricing import cost_for

    # 1M prompt + 1M completion tokens at the default (1.0, 3.0) = 4.0 USD.
    assert cost_for("some-future-model", 1_000_000, 1_000_000) == pytest.approx(4.0)


# ---------- (b) provider_for: o-series + gpt-5 -> openai ----------
def test_provider_for_openai_models():
    assert provider_for("o4-mini") == "openai"
    assert provider_for("gpt-5") == "openai"
    assert provider_for("gpt-5-mini") == "openai"
    assert provider_for("gpt-4.1") == "openai"
    assert provider_for("o1") == "openai"
    assert provider_for("o3-mini") == "openai"
    # existing mappings untouched
    assert provider_for("gpt-4o") == "openai"
    assert provider_for("claude-sonnet-4-6") == "anthropic"
    assert provider_for("text-embedding-3-small") == "openai"
    assert provider_for("mock") == "mock"
    assert provider_for("something-weird") == "other"


def test_new_models_grouped_under_openai():
    grouped = models_by_provider()
    for model in NEW_OPENAI_MODELS:
        assert model in grouped["openai"]


def test_is_reasoning_or_gpt5_helper():
    for m in ("gpt-5", "gpt-5-mini", "o1", "o3-mini", "o4-mini"):
        assert _is_reasoning_or_gpt5(m) is True
    for m in ("gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo"):
        assert _is_reasoning_or_gpt5(m) is False


# ---------- (c) provider param-branching via mocked httpx ----------
class _FakeResponse:
    def __init__(self, data: dict) -> None:
        self._data = data

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._data


class _CapturingClient:
    """Stands in for httpx.AsyncClient: records the outgoing JSON payload."""

    def __init__(self) -> None:
        self.last_json: dict | None = None
        self.last_url: str | None = None

    async def post(self, url, headers=None, json=None):  # noqa: A002 - mirror httpx sig
        self.last_url = url
        self.last_json = json
        return _FakeResponse(
            {
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 7},
            }
        )

    async def aclose(self) -> None:
        return None


def _provider_with_capture() -> tuple[OpenAIProvider, _CapturingClient]:
    provider = OpenAIProvider(api_key="sk-test")
    fake = _CapturingClient()
    provider._client = fake  # type: ignore[assignment]
    return provider, fake


@pytest.mark.parametrize("model", ["gpt-5", "gpt-5-mini", "o4-mini"])
async def test_reasoning_models_omit_temperature_and_use_max_completion_tokens(model):
    provider, fake = _provider_with_capture()
    res = await provider.complete(
        "router", [{"role": "user", "content": "hi"}], model, temperature=0.4, max_tokens=512
    )
    assert fake.last_json is not None
    assert "temperature" not in fake.last_json
    assert "max_tokens" not in fake.last_json
    assert fake.last_json["max_completion_tokens"] == 512
    # response handling + usage extraction stay intact
    assert res.text == "ok"
    assert res.prompt_tokens == 11
    assert res.completion_tokens == 7
    assert res.model == model


@pytest.mark.parametrize("model", ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4-turbo"])
async def test_classic_models_keep_temperature_and_max_tokens(model):
    provider, fake = _provider_with_capture()
    res = await provider.complete(
        "router", [{"role": "user", "content": "hi"}], model, temperature=0.4, max_tokens=512
    )
    assert fake.last_json is not None
    assert fake.last_json["temperature"] == 0.4
    assert fake.last_json["max_tokens"] == 512
    assert "max_completion_tokens" not in fake.last_json
    assert res.text == "ok"
