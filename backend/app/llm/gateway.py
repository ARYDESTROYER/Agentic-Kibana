"""The single LLM gateway (Non-negotiable #6).

100% of model calls go through ``complete``/``embed``. The usage/cost ledger is
written here and ONLY here, so no call can escape the ledger. Errors are recorded
(outcome=error) and surfaced as ``GatewayError`` so callers can fail-to-human
rather than silently dropping an alert.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from ..config import ModelConfig, Provider, Secrets
from ..constants import Role, UsageOutcome
from ..models import UsageDoc
from ..stores.usage import UsageStore
from .pricing import base_url_for, cost_for, pricing_source, resolve_price
from .providers import (
    PROVIDER_REGISTRY,
    BaseProvider,
    CompletionResult,
    MockProvider,
)

logger = logging.getLogger("tlsoc.gateway")


class GatewayError(RuntimeError):
    """Raised when a model call cannot be completed. Triggers fail-to-human."""


# A plausible per-token blended rate for the Demo Mode cost page (Sonnet-ish).
# It is purely cosmetic — pricing_source is stamped 'zero' so the UI marks it
# "simulated" — and is DETERMINISTIC for a given token count ($0 real spend).
_DEMO_IN_RATE = 3.0 / 1_000_000.0      # $/input token
_DEMO_OUT_RATE = 15.0 / 1_000_000.0    # $/output token


def _demo_synthetic_cost(prompt_tokens: int, completion_tokens: int) -> float:
    return round(prompt_tokens * _DEMO_IN_RATE + completion_tokens * _DEMO_OUT_RATE, 8)


class LLMGateway:
    def __init__(
        self,
        secrets: Secrets,
        usage_store: UsageStore,
        provider_overrides: dict[str, BaseProvider] | None = None,
        *,
        demo: bool = False,
        price_overlay: Any = None,
        budget_gate: Any = None,
    ) -> None:
        self._secrets = secrets
        self._usage = usage_store
        self._providers: dict[str, BaseProvider] = dict(provider_overrides or {})
        self._mock_fallback = MockProvider()
        # Demo Mode (Wave 5): when set, EVERY usage row is tagged pricing_source='zero'
        # (it is a $0 mock run) but carries a small PLAUSIBLE synthetic cost so the cost
        # page has believable numbers. The provider itself is the deterministic
        # DemoMockProvider, injected via provider_overrides by the demo state stack.
        self._demo = bool(demo)
        # Feature 9 (optional, defaulted None so the 3-arg constructor is unchanged):
        # an operator PriceOverlayStore (per-model negotiated rates layered on top of
        # the built-in table) and a BudgetGate (pure pre-flight ceiling check that
        # RAISES GatewayError on block → caller fails to NEEDS_HUMAN, never closes #3).
        self._overlay = price_overlay
        self._budget = budget_gate

    # ----- provider resolution -----
    def _provider(
        self, name: Provider | str, *, for_embedding: bool = False, model: str = "",
        endpoint: ModelConfig | None = None,
    ) -> BaseProvider:
        # An explicit override (tests / demo) keyed by provider NAME wins, byte-identical
        # to the historical behaviour (mock/anthropic/openai injected by the test/demo
        # stack). The model-keyed cache below only applies to gateway-constructed clients.
        if name in self._providers:
            return self._providers[name]
        # A per-role ModelConfig.base_url (Wave 2b) pins this role's endpoint and wins
        # over the bundled registry's base_url_for(model); the registry remains the
        # fallback so an existing config with no per-role override is byte-identical.
        cfg_base = (endpoint.base_url or "").strip() if endpoint is not None else ""
        base_url = cfg_base or (base_url_for(model) if model else None) or None
        api_version = (endpoint.api_version or None) if endpoint is not None else None
        region = (endpoint.region or None) if endpoint is not None else None
        # Per-(provider, base_url, api_version, region) cache key so a registry/cfg
        # base_url (vLLM/Ollama/Azure/...) for a specific model gets its own client
        # without colliding with the default.
        cache_key = str(name)
        if base_url or api_version or region:
            cache_key = f"{name}@{base_url}|{api_version}|{region}"
        cached = self._providers.get(cache_key)
        if cached is not None:
            return cached
        factory = PROVIDER_REGISTRY.get(str(name))
        if factory is None:
            raise GatewayError(f"Unknown provider: {name}")
        kwargs = self._provider_kwargs(
            str(name), for_embedding=for_embedding, base_url=base_url,
            api_version=api_version, region=region,
        )
        provider = factory(**kwargs)
        self._providers[cache_key] = provider
        return provider

    def _provider_kwargs(self, name: str, *, for_embedding: bool, base_url: str | None,
                         api_version: str | None = None, region: str | None = None) -> dict[str, Any]:
        """Resolve the credential/endpoint kwargs a provider factory needs from
        ``Secrets`` (the anthropic/openai/mock paths are byte-identical to before;
        the new providers read best-effort secret attrs that may be unset → the
        factory still constructs, and the call fails cleanly on a missing key)."""
        if name == "mock":
            return {}
        if name == "anthropic":
            if not self._secrets.anthropic_api_key:
                raise GatewayError("Anthropic API key not configured")
            return {"api_key": self._secrets.anthropic_api_key, "base_url": base_url}
        if name in ("openai", "openai_compatible"):
            key = self._secrets.embedding_key() if for_embedding else self._secrets.openai_api_key
            # An OpenAI-compatible self-hosted endpoint (base_url set) may need no key.
            if not key and not base_url:
                raise GatewayError("OpenAI API key not configured")
            return {"api_key": key or "", "base_url": base_url}
        if name == "azure":
            key = getattr(self._secrets, "azure_openai_api_key", None) or self._secrets.openai_api_key
            kwargs: dict[str, Any] = {
                "api_key": key or "",
                "base_url": base_url or getattr(self._secrets, "azure_openai_endpoint", "") or "",
            }
            # Pass the api-version through to the Azure factory: the per-role
            # ModelConfig.api_version wins, then the operator-configured secret, else the
            # factory's stable default applies.
            eff_api_version = api_version or getattr(self._secrets, "azure_openai_api_version", None)
            if eff_api_version:
                kwargs["api_version"] = eff_api_version
            return kwargs
        if name == "bedrock":
            return {
                "access_key_id": getattr(self._secrets, "aws_access_key_id", "") or "",
                "secret_access_key": getattr(self._secrets, "aws_secret_access_key", "") or "",
                # Per-role ModelConfig.region wins over the secret default.
                "region": region or getattr(self._secrets, "aws_region", "") or "us-east-1",
                "session_token": getattr(self._secrets, "aws_session_token", None),
                "base_url": base_url,
            }
        if name == "vertex":
            return {
                # The Vertex credential is a short-lived OAuth access token (Bearer),
                # supplied by the operator as ``vertex_api_key``.
                "access_token": getattr(self._secrets, "vertex_api_key", "") or "",
                "project": getattr(self._secrets, "vertex_project", "") or "",
                "location": getattr(self._secrets, "vertex_location", "") or "us-central1",
                "base_url": base_url,
            }
        # Unknown-but-registered name: pass base_url only (OpenAI-flavoured fallback).
        return {"api_key": self._secrets.openai_api_key or "", "base_url": base_url}

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
        # Budget pre-flight (Feature 9, Track B): a PURE ceiling check that RAISES on
        # block BEFORE the provider call + BEFORE any ledger write, so a blocked call
        # fails to NEEDS_HUMAN and NEVER closes a case (#3). Demo/mock ($0) bypasses.
        await self._budget_preflight(role_str, messages, model_cfg)
        started = time.perf_counter()
        try:
            provider = self._provider(model_cfg.provider, model=model_cfg.model, endpoint=model_cfg)
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
        model_used = result.model or model_cfg.model
        cache_read = int(getattr(result, "cache_read_tokens", 0) or 0)
        cache_write = int(getattr(result, "cache_write_tokens", 0) or 0)
        is_batch = bool(getattr(result, "batch", False))
        if self._demo:
            # $0 mock run, but stamp a small PLAUSIBLE synthetic cost for the cost page.
            cost = _demo_synthetic_cost(result.prompt_tokens, result.completion_tokens)
        else:
            cost = cost_for(model_used, result.prompt_tokens, result.completion_tokens,
                            await self._overlay_tuple(model_used),
                            cache_read_tokens=cache_read, cache_write_tokens=cache_write,
                            batch=is_batch)
        result.cost = cost  # let callers roll up per-case cost (Case.token_cost)
        await self._record(
            role_str, surface, case_id, model_used,
            result.prompt_tokens, result.completion_tokens, latency, UsageOutcome.OK, cost,
            cache_read_tokens=cache_read, cache_write_tokens=cache_write, batch=is_batch,
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
        """Embed ``texts`` through the provider (then the ledger, #6).

        NOTE: embeddings are METERED but deliberately NOT pre-flight-gated by the
        BudgetGate. The gate's ``check`` is completion-shaped (it prices a prompt +
        ``max_tokens`` of OUTPUT) and embeddings have no output-token dimension and
        are 1-2 orders of magnitude cheaper per call; gating them would add no
        meaningful spend control while risking a hard-fail of a RAG import on a
        ceiling that the completion path is already enforcing. The cost still lands
        in the ledger, so the BudgetGate's rolling-spend read accounts for it on the
        NEXT completion pre-flight. (If an operator ever needs to cap embedding spend
        specifically, add an embed-shaped pre-flight here mirroring _budget_preflight.)
        """
        started = time.perf_counter()
        try:
            provider = self._provider(model_cfg.provider, for_embedding=True,
                                       model=model_cfg.model, endpoint=model_cfg)
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
        if self._demo:
            # $0 mock run — embeddings are input-only, so the synthetic cost mirrors
            # complete()'s demo branch (and _record's demo fallback) so a demo embed
            # row's cost matches its pricing_source='zero' "simulated" badge instead
            # of carrying the real $0.02/1M table rate.
            cost = _demo_synthetic_cost(result.tokens, 0)
        else:
            cost = cost_for(model_used, result.tokens, 0, await self._overlay_tuple(model_used))
        await self._record(Role.EMBEDDING.value, surface, case_id, model_used,
                           result.tokens, 0, latency, UsageOutcome.OK, cost)
        return result.vectors

    # ----- pricing overlay + budget pre-flight helpers (Feature 9) -----
    async def _overlay_tuple(self, model: str) -> tuple[float, float] | None:
        """The operator PriceOverlayStore override for ``model`` as a price tuple, or
        None (→ cost_for falls back to the built-in table / registry). Best-effort:
        a store glitch degrades to None so the ledger never loses a price source."""
        if self._overlay is None:
            return None
        try:
            return await self._overlay.as_price_tuple(model)
        except Exception as exc:  # noqa: BLE001 — overlay is advisory to the ledger
            logger.warning("price overlay lookup failed (%s); using built-in rate", exc)
            return None

    async def _budget_preflight(self, role: str, messages: list[dict[str, str]],
                                model_cfg: ModelConfig) -> None:
        """Run the optional BudgetGate BEFORE a billable call. On a ``block`` decision
        it RAISES GatewayError (caller fails to NEEDS_HUMAN — never closes #3). Demo/
        mock / $0 models bypass the gate. Best-effort: a gate evaluation glitch never
        hard-blocks a call (logged) — the budget is governance, not a safety stop."""
        if self._budget is None or self._demo:
            return
        if str(model_cfg.provider) == "mock" or model_cfg.model.startswith("mock"):
            return
        try:
            prompt_chars = sum(len(str(m.get("content", ""))) for m in messages)
            decision = await self._budget.check(
                prompt_chars=prompt_chars, max_tokens=model_cfg.max_tokens, model=model_cfg.model,
                overlay=await self._overlay_tuple(model_cfg.model),
            )
        except GatewayError:
            raise
        except Exception as exc:  # noqa: BLE001 — a gate glitch must not drop the alert
            logger.warning("budget pre-flight soft-failed (%s); allowing the call", exc)
            return
        if decision is not None and decision.get("action") == "block":
            reason = str(decision.get("reason", "budget ceiling exceeded"))
            logger.warning("budget BLOCK (role=%s model=%s): %s", role, model_cfg.model, reason)
            raise GatewayError(f"budget ceiling exceeded: {reason}")

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
        *,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        batch: bool = False,
    ) -> None:
        total = prompt_tokens + completion_tokens
        # Demo Mode: a $0 mock run — pricing_source is ALWAYS 'zero' (the cost is
        # synthetic, not a verified rate), so the cost page can badge it "simulated".
        # When an operator price overlay sets a rate, the provenance is 'exact' (a
        # verified, operator-supplied contract price) — it overrides the table source.
        if self._demo:
            price_src = "zero"
        elif await self._overlay_tuple(model) is not None:
            price_src = "exact"
        else:
            price_src = pricing_source(model)
        if cost is None:
            cost = (
                _demo_synthetic_cost(prompt_tokens, completion_tokens)
                if self._demo
                else cost_for(model, prompt_tokens, completion_tokens,
                              await self._overlay_tuple(model),
                              cache_read_tokens=cache_read_tokens,
                              cache_write_tokens=cache_write_tokens, batch=batch)
            )
        doc = UsageDoc(
            surface=surface,
            case_id=case_id,
            role=role,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total,
            cost=cost,
            latency_ms=latency_ms,
            outcome=outcome,
            pricing_source=price_src,
            cache_read_tokens=int(cache_read_tokens or 0),
            cache_write_tokens=int(cache_write_tokens or 0),
            batch=bool(batch),
        )
        await self._usage.write(doc)

    def reset_providers(self) -> None:
        """Drop cached provider clients so new secret values take effect.
        (Used after the wizard updates keys at runtime.)"""
        self._providers = {}

    async def aclose(self) -> None:
        for provider in self._providers.values():
            await provider.aclose()
