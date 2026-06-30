"""Models / LLMs + cost-governance routes (Round 3, Feature 9).

A SEPARATE router module (the integrator mounts it with the same ``require_auth``
mount the monolith uses). It exposes:

* ``GET  /api/llm/models``            — the bundled model catalog enriched with
                                        capabilities / pricing / provenance + the
                                        per-role assignment from Preferences.
* ``GET  /api/llm/providers``         — the provider registry + configured-booleans.
* ``POST /api/llm/models/test``       — route a tiny prompt through the ONE gateway
                                        (still hits the ledger #6) to verify a model.
* ``PUT  /api/llm/models/{id}/pricing`` — set an operator price override
                                        (PriceOverlayStore; layered on the ledger).
* ``POST /api/cost/estimate``         — a pre-flight USD estimate for a prompt+budget.
* ``GET/PUT /api/budget``             — read / update the cost-budget ceiling config.
* ``GET  /api/budget/status``         — the live rolling spend vs the ceilings.

Every model id / error string returned to the client is treated as plain,
attacker-influenceable data (#9): we fence model/error text before it could reach a
prompt, and the values returned here are PLAIN (the UI renders them escaped). These
routes NEVER touch ``case_manager.decide()`` (#3); a budget block only governs
whether an LLM call RUNS — enforced in the gateway, which fails to NEEDS_HUMAN.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import BudgetConfig, ModelConfig
from ..llm.pricing import (
    base_url_for,
    model_catalog,
    models_by_provider,
    pricing_source,
    registry_entry,
)
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.models")

router = APIRouter(prefix="/api")

# The roles that map to a ModelConfig field on Preferences (mirrors model_for()).
_ROLE_FIELDS = (
    "router", "investigator", "formatter", "standup", "chat", "overview", "embedding",
)


def _safe(value: Any) -> str:
    """Return ``value`` as a plain, length-bounded string for the client (#9): the UI
    renders it escaped and we never feed it back into a prompt. Bounds runaway error
    bodies so a hostile upstream can't blow up the response."""
    return str(value)[:2000]


def _assigned_roles(prefs) -> dict[str, list[str]]:
    """model id -> the per-role slots it is assigned to in Preferences, so the catalog
    can show "investigator, chat" next to a model. Read-only over the config."""
    out: dict[str, list[str]] = {}
    for role in _ROLE_FIELDS:
        cfg = getattr(prefs, f"{role}_model", None)
        mid = getattr(cfg, "model", None)
        if mid:
            out.setdefault(str(mid), []).append(role)
    return out


# --------------------------------------------------------------------------- #
# GET /api/llm/models — catalog + capabilities + pricing + provenance + assignment
# --------------------------------------------------------------------------- #
@router.get("/llm/models")
async def llm_models(state: AppState = Depends(get_state)) -> dict[str, Any]:
    assigned = _assigned_roles(state.prefs)
    overlay: dict[str, dict[str, float]] = {}
    try:
        overlay = await state.price_overlay.get()
    except Exception as exc:  # noqa: BLE001 — overlay is advisory; catalog still lists rates
        logger.warning("price overlay read failed (%s); showing built-in rates", exc)
    models: list[dict[str, Any]] = []
    for row in model_catalog():
        mid = row["id"]
        ov = overlay.get(mid)
        enriched = dict(row)
        enriched["id"] = _safe(mid)
        enriched["assigned_roles"] = assigned.get(mid, [])
        if ov:
            enriched["input_per_million"] = float(ov.get("input", 0.0))
            enriched["output_per_million"] = float(ov.get("output", 0.0))
            enriched["pricing_source"] = "exact"  # operator-supplied contract rate
            enriched["price_overridden"] = True
        else:
            enriched["price_overridden"] = False
        models.append(enriched)
    return {
        "models": models,
        "providers": models_by_provider(),
        "configured": state.secrets.configured_status(),
        "overrides": overlay,
    }


# --------------------------------------------------------------------------- #
# GET /api/llm/providers — the provider registry + per-provider configured flag
# --------------------------------------------------------------------------- #
@router.get("/llm/providers")
async def llm_providers(state: AppState = Depends(get_state)) -> dict[str, Any]:
    from ..llm.providers import PROVIDER_REGISTRY

    configured = state.secrets.configured_status()
    # A provider is "configured" when EVERY credential it needs is set — reading from
    # the boolean ``configured_status`` map so there is one source of truth. The
    # OpenAI-compatible/self-hosted path needs no key (base_url drives it).
    #   * azure needs a key (its own, or the OpenAI key as a convenience per
    #     config.provider_key) AND a resource endpoint — without the endpoint a call
    #     would resolve to a placeholder host and DNS-fail, so endpoint is required.
    #   * vertex's credential field is ``vertex_api_key`` (a short-lived OAuth token),
    #     NOT ``vertex_access_token`` — the old read was permanently False.
    provider_configured = {
        "anthropic": bool(configured.get("anthropic_api_key")),
        "openai": bool(configured.get("openai_api_key")),
        "mock": True,
        "azure": bool(
            (configured.get("azure_openai_api_key") or configured.get("openai_api_key"))
            and configured.get("azure_openai_endpoint")
        ),
        "bedrock": bool(configured.get("aws_access_key_id")),
        "vertex": bool(configured.get("vertex_api_key")),
        "openai_compatible": True,
    }
    grouped = models_by_provider()
    return {
        "providers": [
            {
                "name": name,
                "configured": provider_configured.get(name, False),
                "models": grouped.get(name, []),
                "supports_base_url": name in ("openai", "openai_compatible", "azure",
                                              "bedrock", "vertex"),
            }
            for name in PROVIDER_REGISTRY
        ],
    }


# --------------------------------------------------------------------------- #
# POST /api/llm/models/test — verify a model THROUGH the one gateway (hits ledger)
# --------------------------------------------------------------------------- #
class ModelTestBody(BaseModel):
    model: str = Field(..., min_length=1, max_length=200)
    provider: str | None = None
    prompt: str = Field(default="Reply with the single word: ok", max_length=2000)


@router.post("/llm/models/test")
async def llm_model_test(
    body: ModelTestBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = body.model.strip()
    if not mid:
        raise HTTPException(status_code=400, detail="model is required")
    # Resolve the provider: explicit override → registry-declared → prefix heuristic.
    if body.provider:
        provider = body.provider.strip()
    else:
        entry = registry_entry(mid) or {}
        from ..llm.pricing import provider_for

        provider = str(entry.get("provider") or provider_for(mid))
    try:
        # The Provider Literal now includes the cloud providers
        # (azure/bedrock/vertex/openai_compatible) alongside anthropic/openai/mock, so a
        # standard, validated construction covers them directly — no model_construct
        # bypass. A provider name outside the Literal (e.g. ``other`` from the heuristic,
        # or an out-of-tree registry provider) still validates leniently so the gateway's
        # PROVIDER_REGISTRY can attempt to dispatch it.
        cfg = ModelConfig(provider=provider, model=mid, max_tokens=16)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 — a provider name outside the widened Literal
        cfg = ModelConfig.model_construct(
            provider=provider, model=mid, temperature=0.1, max_tokens=16,  # type: ignore[arg-type]
        )
    messages = [{"role": "user", "content": str(body.prompt)[:2000]}]
    try:
        result = await state.gateway.complete(
            "chat", messages, cfg, surface="model_test",
        )
    except Exception as exc:  # noqa: BLE001 — a GatewayError or provider failure
        # Plain, bounded error text (#9). If the provider ran and failed, the gateway
        # already recorded one ERROR ledger row; a budget BLOCK raised before the call
        # and recorded nothing (zero rows). Either way no OK row is written here.
        return {"ok": False, "model": _safe(mid), "provider": _safe(provider),
                "error": _safe(exc)}
    # Badge the price the same way the ledger row this call wrote did (gateway._record)
    # and the sibling /cost/estimate endpoint: an active operator overlay → 'exact',
    # else the built-in table provenance. Without this the dialog could show
    # 'heuristic'/'default' while the ledger row for the same call shows 'exact'.
    eff_model = result.model or mid
    overlay = None
    try:
        overlay = await state.price_overlay.as_price_tuple(eff_model)
    except Exception:  # noqa: BLE001 — overlay advisory; fall back to the table
        overlay = None
    return {
        "ok": True,
        "model": _safe(eff_model),
        "provider": _safe(provider),
        "reply": _safe(result.text),
        "prompt_tokens": result.prompt_tokens,
        "completion_tokens": result.completion_tokens,
        "cost": result.cost,
        "pricing_source": "exact" if overlay is not None else pricing_source(eff_model),
        "base_url": base_url_for(mid),
    }


# --------------------------------------------------------------------------- #
# PUT /api/llm/models/{id}/pricing — operator per-model price override
# --------------------------------------------------------------------------- #
class PricingBody(BaseModel):
    input_per_million: float = Field(..., ge=0.0)
    output_per_million: float = Field(..., ge=0.0)


@router.put("/llm/models/{model_id}/pricing")
async def llm_model_pricing(
    model_id: str,
    body: PricingBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = (model_id or "").strip()
    if not mid:
        raise HTTPException(status_code=400, detail="model id is required")
    try:
        row = await state.price_overlay.set_price(
            mid, body.input_per_million, body.output_per_million,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_safe(exc)) from exc
    await _audit(state, request, "model_pricing_set",
                 f"override {mid} -> in=${row['input']}/1M out=${row['output']}/1M")
    return {"ok": True, "model": _safe(mid), "pricing": row, "pricing_source": "exact"}


@router.delete("/llm/models/{model_id}/pricing")
async def llm_model_pricing_delete(
    model_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = (model_id or "").strip()
    removed = await state.price_overlay.delete(mid)
    if removed:
        await _audit(state, request, "model_pricing_clear", f"cleared override for {mid}")
    return {"ok": True, "model": _safe(mid), "removed": removed,
            "pricing_source": pricing_source(mid)}


# --------------------------------------------------------------------------- #
# POST /api/cost/estimate — a pre-flight USD estimate for a prompt + token budget
# --------------------------------------------------------------------------- #
class EstimateBody(BaseModel):
    model: str = Field(..., min_length=1, max_length=200)
    prompt: str = Field(default="", max_length=200000)
    prompt_chars: int | None = Field(default=None, ge=0)
    max_tokens: int = Field(default=1000, ge=0)


@router.post("/cost/estimate")
async def cost_estimate(
    body: EstimateBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    mid = body.model.strip()
    overlay = None
    try:
        overlay = await state.price_overlay.as_price_tuple(mid)
    except Exception:  # noqa: BLE001 — advisory; estimate falls back to the table
        overlay = None
    gate = _budget_gate(state)
    chars = body.prompt_chars if body.prompt_chars is not None else len(body.prompt)
    estimate = gate.estimate_cost(chars, body.max_tokens, mid, overlay)
    return {
        "model": _safe(mid),
        "prompt_chars": chars,
        "max_tokens": body.max_tokens,
        "estimated_cost": estimate,
        "currency": "USD",
        "pricing_source": "exact" if overlay is not None else pricing_source(mid),
    }


# --------------------------------------------------------------------------- #
# GET/PUT /api/budget — the LLM cost-budget ceiling config
# --------------------------------------------------------------------------- #
@router.get("/budget")
async def get_budget(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    budget = getattr(state.prefs, "budget", None) or BudgetConfig()
    return {"budget": budget.model_dump(mode="json")}


@router.put("/budget")
async def put_budget(
    body: BudgetConfig,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    prefs = state.prefs.model_copy(update={"budget": body})
    await state.update_prefs(prefs)
    await _audit(
        state, request, "budget_update",
        f"budget enabled={body.enabled} daily=${body.daily_usd} "
        f"monthly=${body.monthly_usd} on_exceed={body.on_exceed}",
    )
    return {"ok": True, "budget": body.model_dump(mode="json")}


@router.get("/budget/status")
async def budget_status(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    gate = _budget_gate(state)
    return await gate.status()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _budget_gate(state: AppState):
    """The shared BudgetGate if the integrator wired one onto AppState; else a
    transient gate built from the live prefs + the real usage store. Either way it is
    PURE (read-only) and never touches decide() (#3)."""
    gate = getattr(state, "budget_gate", None)
    if gate is not None:
        return gate
    from ..engine.budget import BudgetGate

    usage = getattr(state, "_real_usage_store", None) or getattr(state, "usage", None)
    return BudgetGate(get_budget=lambda: getattr(state.prefs, "budget", None), usage_store=usage)


async def _audit(state: AppState, request: Request, event: str, detail: str) -> None:
    """Append-only audit of a models/budget config mutation (#2). Best-effort.

    Uses ``USER_MGMT`` with ``surface="models"`` — the established action type for an
    operator settings-scope mutation (constants.py is frozen this wave, so no new
    ActionType is introduced). The actor is the authenticated username when present."""
    audit = getattr(state, "audit", None)
    if audit is None:
        return
    try:
        from ..constants import ActionType

        await audit.record(
            action_type=ActionType.USER_MGMT,
            surface="models",
            actor=current_username(request) or "",
            result_summary=f"{event}: {detail}"[:500],
        )
    except Exception:  # noqa: BLE001
        pass
