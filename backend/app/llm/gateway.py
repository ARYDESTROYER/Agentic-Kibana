"""The single LLM gateway (Non-negotiable #6).

100% of model calls go through ``complete``/``embed``. The usage/cost ledger is
written here and ONLY here, so no call can escape the ledger. Errors are recorded
(outcome=error) and surfaced as ``GatewayError`` so callers can fail-to-human
rather than silently dropping an alert.
"""

from __future__ import annotations

import logging
import time

from ..config import ModelConfig, Provider, Secrets
from ..constants import Role, UsageOutcome
from ..models import UsageDoc
from ..stores.usage import UsageStore
from .pricing import cost_for, pricing_source
from .providers import (
    AnthropicProvider,
    BaseProvider,
    CompletionResult,
    MockProvider,
    OpenAIProvider,
)

logger = logging.getLogger("tlsoc.gateway")


class GatewayError(RuntimeError):
    """Raised when a model call cannot be completed. Triggers fail-to-human."""


class LLMGateway:
    def __init__(
        self,
        secrets: Secrets,
        usage_store: UsageStore,
        provider_overrides: dict[str, BaseProvider] | None = None,
    ) -> None:
        self._secrets = secrets
        self._usage = usage_store
        self._providers: dict[str, BaseProvider] = dict(provider_overrides or {})
        self._mock_fallback = MockProvider()

    # ----- provider resolution -----
    def _provider(self, name: Provider, *, for_embedding: bool = False) -> BaseProvider:
        if name in self._providers:
            return self._providers[name]
        if name == "mock":
            provider: BaseProvider = MockProvider()
        elif name == "anthropic":
            if not self._secrets.anthropic_api_key:
                raise GatewayError("Anthropic API key not configured")
            provider = AnthropicProvider(self._secrets.anthropic_api_key)
        elif name == "openai":
            key = self._secrets.embedding_key() if for_embedding else self._secrets.openai_api_key
            if not key:
                raise GatewayError("OpenAI API key not configured")
            provider = OpenAIProvider(key)
        else:
            raise GatewayError(f"Unknown provider: {name}")
        self._providers[name] = provider
        return provider

    # ----- completions -----
    async def complete(
        self,
        role: Role | str,
        messages: list[dict[str, str]],
        model_cfg: ModelConfig,
        *,
        surface: str = "",
        case_id: str | None = None,
    ) -> CompletionResult:
        role_str = role.value if isinstance(role, Role) else role
        started = time.perf_counter()
        try:
            provider = self._provider(model_cfg.provider)
            result = await provider.complete(
                role_str, messages, model_cfg.model, model_cfg.temperature, model_cfg.max_tokens
            )
        except Exception as exc:  # noqa: BLE001
            latency = int((time.perf_counter() - started) * 1000)
            await self._record(role_str, surface, case_id, model_cfg.model, 0, 0, latency,
                               UsageOutcome.ERROR)
            logger.warning("LLM call failed (role=%s model=%s): %s", role_str, model_cfg.model, exc)
            raise GatewayError(str(exc)) from exc

        latency = int((time.perf_counter() - started) * 1000)
        cost = cost_for(result.model or model_cfg.model, result.prompt_tokens, result.completion_tokens)
        result.cost = cost  # let callers roll up per-case cost (Case.token_cost)
        await self._record(
            role_str, surface, case_id, result.model or model_cfg.model,
            result.prompt_tokens, result.completion_tokens, latency, UsageOutcome.OK, cost,
        )
        return result

    # ----- embeddings (degrade gracefully to local hashing) -----
    async def embed(
        self,
        texts: list[str],
        model_cfg: ModelConfig,
        *,
        surface: str = "rag",
        case_id: str | None = None,
    ) -> list[list[float]]:
        started = time.perf_counter()
        try:
            provider = self._provider(model_cfg.provider, for_embedding=True)
            result = await provider.embed(texts, model_cfg.model)
            model_used = model_cfg.model
        except Exception as exc:  # noqa: BLE001
            logger.info("Embedding provider unavailable (%s); using local hash embeddings", exc)
            # Record the provider failure so the ledger shows the outage, then fall
            # back to local hashing so RAG keeps working (graceful degradation).
            await self._record(Role.EMBEDDING.value, surface, case_id,
                               model_cfg.model, 0, 0,
                               int((time.perf_counter() - started) * 1000),
                               UsageOutcome.ERROR, 0.0)
            result = await self._mock_fallback.embed(texts, "mock-embed")
            model_used = "mock-embed"
        latency = int((time.perf_counter() - started) * 1000)
        cost = cost_for(model_used, result.tokens, 0)
        await self._record(Role.EMBEDDING.value, surface, case_id, model_used,
                           result.tokens, 0, latency, UsageOutcome.OK, cost)
        return result.vectors

    # ----- ledger write (the ONE place) -----
    async def _record(
        self,
        role: str,
        surface: str,
        case_id: str | None,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        latency_ms: int,
        outcome: UsageOutcome,
        cost: float | None = None,
    ) -> None:
        total = prompt_tokens + completion_tokens
        doc = UsageDoc(
            surface=surface,
            case_id=case_id,
            role=role,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total,
            cost=cost if cost is not None else cost_for(model, prompt_tokens, completion_tokens),
            latency_ms=latency_ms,
            outcome=outcome,
            pricing_source=pricing_source(model),
        )
        await self._usage.write(doc)

    def reset_providers(self) -> None:
        """Drop cached provider clients so new secret values take effect.
        (Used after the wizard updates keys at runtime.)"""
        self._providers = {}

    async def aclose(self) -> None:
        for provider in self._providers.values():
            await provider.aclose()
