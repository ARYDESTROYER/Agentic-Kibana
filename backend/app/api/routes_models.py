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
from urllib.parse import urlsplit

import httpx
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
from ..llm.providers import classify_http_error
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


async def _custom_catalog_rows(state: AppState, seen: set[str]) -> list[dict[str, Any]]:
    """Catalog rows for the operator's runtime-registered self-hosted / LiteLLM models,
    shaped like ``model_catalog()`` rows (so the merge is uniform) and tagged
    ``is_custom``. A local model is FREE ($0) with 'exact' provenance. Best-effort — a
    store glitch returns [] so the built-in catalog always stands."""
    rows: list[dict[str, Any]] = []
    try:
        registered = await state.custom_models.list_models()
    except Exception as exc:  # noqa: BLE001 — custom store is advisory to the catalog
        logger.warning("custom model list failed (%s); catalog shows built-ins only", exc)
        return rows
    for c in registered:
        cid = str(c.get("id", ""))
        if not cid or cid in seen:
            continue
        seen.add(cid)
        rows.append({
            "id": cid,
            "label": _safe(c.get("label") or cid),
            "provider": str(c.get("provider") or "openai_compatible"),
            "context_window": int(c.get("context_window", 0) or 0),
            "max_output": 0,
            "modalities": [],
            "capabilities": ["chat"],
            "input_per_million": float(c.get("input_per_million", 0.0) or 0.0),
            "output_per_million": float(c.get("output_per_million", 0.0) or 0.0),
            "cache_write_per_million": None,
            "cache_read_per_million": None,
            "batch_multiplier": 0.5,
            "base_url": _safe(c.get("base_url") or "") or None,
            "pricing_source": "exact",   # operator-supplied local model → real $0
            "is_custom": True,
        })
    return rows


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
    # Merge the operator's runtime-registered self-hosted / LiteLLM (OpenAI-compatible)
    # models into the bundled catalog so a locally-added model shows up in the picker.
    # A local model is FREE ($0) with 'exact' provenance (operator-supplied), carries its
    # base_url, and is tagged is_custom so the UI can badge + offer Remove. Best-effort:
    # a store glitch never blanks the built-in catalog. (#9: ids/labels are fenced/plain.)
    base_rows = model_catalog()
    seen = {str(r["id"]) for r in base_rows}
    custom_rows = await _custom_catalog_rows(state, seen)
    models: list[dict[str, Any]] = []
    for row in base_rows + custom_rows:
        mid = row["id"]
        ov = overlay.get(mid)
        enriched = dict(row)
        enriched["id"] = _safe(mid)
        enriched["assigned_roles"] = assigned.get(mid, [])
        enriched["is_custom"] = bool(row.get("is_custom"))
        if ov:
            enriched["input_per_million"] = float(ov.get("input", 0.0))
            enriched["output_per_million"] = float(ov.get("output", 0.0))
            enriched["pricing_source"] = "exact"  # operator-supplied contract rate
            # A custom model's $0 overlay is a shipped default, not a hand-set override —
            # don't flag it as an operator override (avoids a misleading override marker).
            enriched["price_overridden"] = not enriched["is_custom"]
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
    # A runtime-registered self-hosted / LiteLLM model routes over the openai_compatible
    # provider at ITS base_url (checked first so a bare custom id doesn't resolve to the
    # heuristic "other" — which has no provider factory — and so the endpoint is carried
    # onto the ModelConfig even without the gateway's store fallback).
    custom_base_url: str | None = None
    try:
        custom_row = await state.custom_models.get_model(mid)
    except Exception:  # noqa: BLE001 — custom store advisory to the test
        custom_row = None
    # Resolve the provider: explicit override → custom model → registry-declared → prefix.
    if body.provider:
        provider = body.provider.strip()
    elif custom_row:
        provider = str(custom_row.get("provider") or "openai_compatible")
        custom_base_url = str(custom_row.get("base_url") or "") or None
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
        cfg = ModelConfig(provider=provider, model=mid, max_tokens=16,  # type: ignore[arg-type]
                          base_url=custom_base_url)
    except Exception:  # noqa: BLE001 — a provider name outside the widened Literal
        cfg = ModelConfig.model_construct(
            provider=provider, model=mid, temperature=0.1, max_tokens=16,  # type: ignore[arg-type]
            base_url=custom_base_url,
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
# Custom (self-hosted / LiteLLM / OpenAI-compatible) models — runtime add/remove.
#
# Lets an operator register a SELF-HOSTED model (a LiteLLM alias / vLLM served name /
# Ollama tag) served at an OpenAI-compatible ``base_url``, at runtime, with no rebuild.
# The suite already speaks the wire (the ``openai_compatible`` provider IS the OpenAI
# httpx client pointed at a custom ``base_url``); these routes are the bookkeeping:
#   * config tier (#10): base_url / model id / label / context window / $0 rate → the
#     non-secret CustomModelStore. The optional endpoint API key → the SECRET tier
#     (``Secrets.litellm_api_key``, in-memory) via ``apply_secrets`` — NEVER the store.
#   * $0 pricing (belt-and-suspenders): the store row carries a 0/0 rate AND we set a $0
#     PriceOverlay, so ``cost_for`` meters a REAL $0 (never the conservative default),
#     and the gateway's ``_effective_price_tuple`` treats a registered model as free even
#     if the overlay write was lost.
#   * SSRF/scheme: the base_url scheme is restricted to http/https and must parse; a
#     LAN/loopback host (127.0.0.1 / 192.168.x / litellm:4000) is the LEGITIMATE use
#     case, so private ranges are NOT blocked — only malformed / non-http(s) is rejected.
#   * #9: label / model id / base_url are attacker-influenceable → fenced via ``_safe``
#     and returned PLAIN (the store also bounds + plain-coerces them).
# These routes NEVER touch ``case_manager.decide()`` (#3).
# --------------------------------------------------------------------------- #
def _validate_base_url(raw: str) -> str:
    """A parsed, bounded, http(s)-only ``base_url`` (#10 SSRF hardening: scheme-only —
    private/loopback hosts are allowed as the legitimate local-model case). Raises
    HTTPException(400) on a malformed / non-http(s) url."""
    url = _safe(raw).strip()
    if not url:
        raise HTTPException(status_code=400, detail="base_url is required")
    try:
        parts = urlsplit(url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="base_url is malformed") from exc
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise HTTPException(
            status_code=400,
            detail="base_url must be an http(s) URL (e.g. http://localhost:4000/v1)",
        )
    return url


def _bearer_key(explicit: str | None, state: AppState) -> str:
    """The Bearer key for an OpenAI-compatible reachability probe: an explicit key, else
    the configured LiteLLM/OpenAI secret, else a non-empty placeholder (a no-auth local
    server ignores it; empty is rejected by strict clients)."""
    key = (explicit or "").strip()
    if key:
        return key
    key = (getattr(state.secrets, "litellm_api_key", None)
           or getattr(state.secrets, "openai_api_key", None) or "").strip()
    return key or "sk-no-key"


class CustomModelBody(BaseModel):
    model_config = {"protected_namespaces": ()}

    model_id: str = Field(..., min_length=1, max_length=200)
    base_url: str = Field(..., min_length=1, max_length=2000)
    label: str = Field(default="", max_length=200)
    context_window: int = Field(default=0, ge=0)
    api_key: str | None = Field(default=None, max_length=4000)


@router.post("/llm/models/custom")
async def add_custom_model(
    body: CustomModelBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = _safe(body.model_id).strip()
    if not mid:
        raise HTTPException(status_code=400, detail="model_id is required")
    base_url = _validate_base_url(body.base_url)
    label = _safe(body.label).strip()
    try:
        row = await state.custom_models.add(
            mid, label=label, base_url=base_url, provider="openai_compatible",
            context_window=int(body.context_window or 0),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_safe(exc)) from exc
    # Belt-and-suspenders $0: a $0 PriceOverlay so cost_for meters a real $0 (the store
    # row + the gateway's _effective_price_tuple are the other belts). Best-effort.
    try:
        await state.price_overlay.set_price(mid, 0.0, 0.0)
    except Exception as exc:  # noqa: BLE001 — the store row + gateway fallback still guarantee $0
        logger.warning("setting $0 overlay for custom model %s failed (%s)", mid, exc)
    # The optional endpoint key → the SECRET tier (in-memory), NEVER the config store.
    if (body.api_key or "").strip():
        try:
            await state.apply_secrets({"litellm_api_key": body.api_key.strip()})
        except Exception as exc:  # noqa: BLE001 — model still added; key can be re-set
            logger.warning("storing litellm_api_key failed (%s)", exc)
    await _audit(state, request, "custom_model_add",
                 f"added {mid} @ {base_url} (provider=openai_compatible, $0)")
    return {"ok": True, "model": row, "configured": state.secrets.configured_status()}


@router.delete("/llm/models/custom/{model_id:path}")
async def remove_custom_model(
    model_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    mid = _safe(model_id).strip()
    removed = await state.custom_models.remove(mid)
    if removed:
        # Clear its $0 overlay so the id is fully forgotten (best-effort).
        try:
            await state.price_overlay.delete(mid)
        except Exception as exc:  # noqa: BLE001
            logger.warning("clearing overlay for removed custom model %s failed (%s)", mid, exc)
        await _audit(state, request, "custom_model_remove", f"removed {mid}")
    return {"ok": True, "model": _safe(mid), "removed": removed}


class ProviderTestBody(BaseModel):
    base_url: str = Field(..., min_length=1, max_length=2000)
    api_key: str | None = Field(default=None, max_length=4000)


@router.post("/llm/providers/test")
async def providers_test(
    body: ProviderTestBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    """A NON-metered reachability + "fetch models" probe for an OpenAI-compatible
    endpoint: ``GET {base_url}/models`` (falling back to ``/v1/models``) with a Bearer
    header. It does NOT touch the gateway / cost ledger (#6). Returns the discovered
    model ids so the Add-local-model dialog can populate a picker. Errors are PLAIN,
    bounded (#9)."""
    base_url = _validate_base_url(body.base_url)
    key = _bearer_key(body.api_key, state)
    headers = {"Authorization": f"Bearer {key}"}
    root = base_url.rstrip("/")
    candidates = [f"{root}/models"]
    # Fall back to /v1/models when the operator gave the bare host (no /v1 suffix).
    if not root.endswith("/v1"):
        candidates.append(f"{root}/v1/models")
    last_err = ""
    async with httpx.AsyncClient(timeout=10.0) as client:
        for url in candidates:
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                data = resp.json()
            except Exception as exc:  # noqa: BLE001 — classify + try the next candidate
                last_err = str(classify_http_error(exc))
                continue
            ids = _extract_model_ids(data)
            return {"ok": True, "models": [_safe(m) for m in ids][:200],
                    "message": f"Reached {_safe(root)} — {len(ids)} model(s)."}
    return {"ok": False, "models": [], "error": _safe(last_err or "unreachable")}


def _extract_model_ids(data: Any) -> list[str]:
    """Model ids from an OpenAI-compatible ``/models`` response (``{"data": [{"id": ...}]}``
    or a bare list). Tolerant of shape drift; returns [] on anything unexpected."""
    rows = data.get("data") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return []
    out: list[str] = []
    for r in rows:
        mid = r.get("id") if isinstance(r, dict) else r
        if mid:
            out.append(str(mid))
    return out


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
    await state.mutate_prefs(
        lambda current: current.model_copy(update={"budget": body})
    )
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
    audit = getattr(state, "control_audit", None)
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
