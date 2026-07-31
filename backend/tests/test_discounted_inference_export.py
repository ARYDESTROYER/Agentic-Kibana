"""Discounted alert inference + portable data-export contracts (offline)."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes_export import _limit_grouped_rows, _plain, router as export_router
from app.config import BatchConfig, ModelConfig, Secrets
from app.constants import USAGE_READ_PATTERN, UserRole
from app.es.fake import InMemoryESClient
from app.llm.gateway import LLMGateway
from app.llm.providers import (
    PROVIDER_REGISTRY,
    BaseProvider,
    CompletionResult,
    OpenAIProvider,
    ProviderError,
)
from app.rbac.policy import can
from app.state import AppState
from app.stores.usage import UsageStore


class _FakeSecrets:
    anthropic_api_key = None
    openai_api_key = "sk-test"
    embedding_api_key = None

    def embedding_key(self):
        return self.openai_api_key


class _ResultProvider(BaseProvider):
    def __init__(self, tier: str) -> None:
        self.tier = tier

    async def complete(self, role, messages, model, temperature, max_tokens):
        return CompletionResult(
            text="ok", prompt_tokens=100, completion_tokens=20, model=model,
            batch=self.tier == "flex", processing_tier=self.tier,
        )


async def _usage_docs(es: InMemoryESClient) -> list[dict]:
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [hit["_source"] for hit in resp["hits"]["hits"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("surface", ["automated_scan", "investigate"])
async def test_every_live_alert_surface_prefers_openai_flex_and_is_truthfully_metered(
    monkeypatch, surface,
):
    captured: list[dict] = []

    def factory(**kwargs):
        captured.append(dict(kwargs))
        return _ResultProvider("flex" if kwargs.get("service_tier") == "flex" else "standard")

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", factory)
    es = InMemoryESClient()
    policy = BatchConfig(prefer_discounted_alerts=True, fallback_to_standard=True)
    gateway = LLMGateway(
        _FakeSecrets(), UsageStore(es), discounted_policy=lambda: policy,
    )
    result = await gateway.complete(
        "investigator", [{"role": "user", "content": "alert"}],
        ModelConfig(provider="openai", model="gpt-5.6-luna"),
        surface=surface, case_id=f"case-{surface}",
    )

    assert captured[0]["service_tier"] == "flex"
    assert captured[0]["fallback_to_standard"] is True
    assert result.processing_tier == "flex" and result.batch is True
    docs = await _usage_docs(es)
    assert len(docs) == 1
    assert docs[0]["processing_tier"] == "flex"
    assert docs[0]["batch"] is True
    # 100 input + 20 output tokens at Luna Standard ($0.20/M + $1.20/M),
    # discounted by 0.5 only because the provider confirmed the Flex tier.
    assert docs[0]["cost"] == pytest.approx(0.000022)


@pytest.mark.asyncio
async def test_flex_provider_cache_tracks_live_fallback_policy(monkeypatch):
    captured: list[dict] = []

    def factory(**kwargs):
        captured.append(dict(kwargs))
        return _ResultProvider("flex")

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", factory)
    policy = BatchConfig(prefer_discounted_alerts=True, fallback_to_standard=True)
    gateway = LLMGateway(
        _FakeSecrets(), UsageStore(InMemoryESClient()), discounted_policy=lambda: policy,
    )
    model = ModelConfig(provider="openai", model="gpt-5-mini")
    await gateway.complete(
        "investigator", [{"role": "user", "content": "one"}], model,
        surface="automated_scan",
    )
    policy.fallback_to_standard = False
    await gateway.complete(
        "investigator", [{"role": "user", "content": "two"}], model,
        surface="automated_scan",
    )

    assert [call["fallback_to_standard"] for call in captured] == [True, False]


@pytest.mark.asyncio
async def test_live_flex_is_independent_of_async_batch_provider_allow_list(monkeypatch):
    captured: list[dict] = []

    def factory(**kwargs):
        captured.append(dict(kwargs))
        return _ResultProvider("flex")

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", factory)
    policy = BatchConfig(
        providers=["anthropic"],
        prefer_discounted_alerts=True,
        fallback_to_standard=True,
    )
    gateway = LLMGateway(
        _FakeSecrets(), UsageStore(InMemoryESClient()), discounted_policy=lambda: policy,
    )
    await gateway.complete(
        "investigator", [{"role": "user", "content": "alert"}],
        ModelConfig(provider="openai", model="gpt-5-mini"),
        surface="investigate",
    )

    assert captured[0]["service_tier"] == "flex"


@pytest.mark.asyncio
async def test_unsupported_model_and_non_alert_surface_stay_standard(monkeypatch):
    captured: list[dict] = []

    def factory(**kwargs):
        captured.append(dict(kwargs))
        return _ResultProvider("standard")

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", factory)
    policy = BatchConfig(prefer_discounted_alerts=True)
    gateway = LLMGateway(
        _FakeSecrets(), UsageStore(InMemoryESClient()), discounted_policy=lambda: policy,
    )
    await gateway.complete(
        "router", [{"role": "user", "content": "alert"}],
        ModelConfig(provider="openai", model="gpt-4o"), surface="automated_scan",
    )
    await gateway.complete(
        "chat", [{"role": "user", "content": "question"}],
        ModelConfig(provider="openai", model="gpt-5-mini"), surface="chat",
    )
    assert all("service_tier" not in call for call in captured)


@pytest.mark.asyncio
async def test_flex_unavailable_falls_back_without_discount_stamp():
    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [{"message": {"content": "standard"}}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2},
                "service_tier": "default",
            }

    class _Client:
        def __init__(self) -> None:
            self.payloads: list[dict] = []

        async def post(self, _url, *, json=None, **_kwargs):  # noqa: A002
            self.payloads.append(dict(json or {}))
            if len(self.payloads) == 1:
                raise ProviderError(
                    "HTTP 400: service_tier flex not supported",
                    retryable=False,
                    status=400,
                )
            return _Response()

        async def aclose(self):
            return None

    provider = OpenAIProvider(
        api_key="sk-test", service_tier="flex", fallback_to_standard=True,
    )
    await provider._client.aclose()  # close the unused real client before injecting
    client = _Client()
    provider._client = client  # type: ignore[assignment]
    result = await provider.complete(
        "router", [{"role": "user", "content": "x"}], "gpt-5-mini", 0.0, 32,
    )
    assert client.payloads[0]["service_tier"] == "flex"
    assert "service_tier" not in client.payloads[1]
    assert result.processing_tier == "standard" and result.batch is False


def test_data_export_permission_is_owner_scoped():
    assert can(UserRole.SUPER_ADMIN, "data_export", "export") is True
    assert can(UserRole.SOC_MANAGER, "data_export", "export") is True
    assert can(UserRole.ANALYST_TIER2, "data_export", "export") is False
    assert can(UserRole.AUDITOR, "data_export", "export") is False


def test_export_sanitizer_omits_credentials_and_redacts_free_text():
    result = _plain({
        "api_key": "do-not-export",
        "nested": {"password_hash": "hash", "prompt_tokens": 42},
        "note": "Authorization Bearer abcdefghijklmnop and sk-abcdefghijklmnop",
    })
    assert "api_key" not in result
    assert "password_hash" not in result["nested"]
    assert result["nested"]["prompt_tokens"] == 42
    assert "abcdefghijklmnop" not in result["note"]
    assert result["note"].count("[REDACTED]") == 2


def test_grouped_export_limit_is_scope_wide_and_keeps_collections_represented():
    result = _limit_grouped_rows(
        {"proposals": [1, 2, 3], "campaigns": [4, 5], "jobs": [6, 7]}, 4,
    )
    assert sum(len(rows) for rows in result.values()) == 4
    assert result == {"proposals": [1, 2], "campaigns": [4], "jobs": [6]}


def test_export_endpoint_is_downloadable_canonical_json(mock_provider):
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=Secrets(_env_file=None), es=InMemoryESClient(),
            provider_overrides=overrides,
        )
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(export_router)
    with TestClient(api) as client:
        response = client.post(
            "/api/admin/export",
            json={"scopes": ["configuration"], "limit_per_scope": 25},
        )

    assert response.status_code == 200
    assert response.headers["content-disposition"] == (
        'attachment; filename="agentic-soc-export.json"'
    )
    body = response.json()
    assert body["format"] == "agentic-soc-portable-export"
    assert body["selection"] == {"scopes": ["configuration"]}
    assert body["limits"]["items_per_scope"] == 25
    assert body["manifest"]["configuration"] == {
        "count": 1, "total": 1, "truncated": False,
    }
    assert "preferences" in body["data"]["configuration"]
    # Canonical serialization: sorted keys + compact separators.
    assert response.content == json.dumps(
        body, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
