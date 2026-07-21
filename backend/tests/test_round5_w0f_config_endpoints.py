"""Round 5 · W0-F F5 — typed config GET/PUT endpoints for baseline/campaign/batch.

Mirrors ``routes_tuning``'s ``GET/PUT /tuning/config`` (the ONLY feature that shipped a
config endpoint before this wave). Each new endpoint:

* ``GET  /api/{feature}/config`` — return the live ``Preferences.<feature>`` block.
* ``PUT  /api/{feature}/config`` — DEEP-MERGE only the keys the caller sent, validate
  against the Pydantic model, persist, and write an append-only audit row (#2).

Also re-locks ``routes_tuning``'s config round-trip for the 3 previously-untested tuner
fields (``max_n_step`` / ``wilson_z`` / ``ewma_alpha``) so they are demonstrably exposed
and round-trip through ``GET`` → ``PUT`` → ``GET``.

NON-NEGOTIABLES exercised: #2 (every PUT writes an append-only audit row), #3 (nothing
here calls ``decide()`` — these are advisory config writers), #9 (bodies are plain data),
#10 (no secret is ever returned — the config blocks carry only tuning knobs). The PUT is
a deep-merge (partial body → only changed keys) matching the ``PUT /api/settings``
contract. Fully network-free (fake ES + mock LLM).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes_baseline import router as baseline_router
from app.api.routes_batch import router as batch_router
from app.api.routes_campaigns import router as campaign_router
from app.api.routes_tuning import router as tuning_router
from app.config import BaselineConfig, BatchConfig, CampaignConfig, Secrets
from app.constants import ActionType
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState


# --------------------------------------------------------------------------- #
# Harness — auth OFF (the default) so we exercise the routes directly. The
# admin-gated campaign PUT is a no-op gate when auth is off (same as recorrelate).
# --------------------------------------------------------------------------- #
@pytest.fixture
def state_and_client():
    holder: dict[str, Any] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None, es_store_enabled=False, redis_url="",
            anthropic_api_key=None, openai_api_key=None,
        )
        mock = MockProvider()
        overrides = {"anthropic": mock, "openai": mock, "mock": mock}
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        holder["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for r in (baseline_router, campaign_router, batch_router, tuning_router):
        api.include_router(r, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        yield holder["state"], client


def _run(client: TestClient, coro):
    return client.portal.call(lambda: coro)  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# BASELINE — GET/PUT /api/baseline/config
# --------------------------------------------------------------------------- #
def test_baseline_config_get_defaults(state_and_client) -> None:
    _state, client = state_and_client
    r = client.get("/api/baseline/config")
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    # Matches BaselineConfig() defaults — Autopilot overhaul: the baseline PRODUCER
    # defaults ON.
    assert cfg == BaselineConfig().model_dump(mode="json")
    assert cfg["enabled"] is True


def test_baseline_config_put_deep_merges_only_changed_keys(state_and_client) -> None:
    state, client = state_and_client
    # Send a PARTIAL body — only two keys. Everything else must keep its default.
    r = client.put("/api/baseline/config", json={"enabled": True, "warmup_multiplier": 5})
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    assert cfg["enabled"] is True
    assert cfg["warmup_multiplier"] == 5
    # Untouched keys retain the model default (deep-merge, not replace).
    assert cfg["half_life_days"] == BaselineConfig().half_life_days
    assert cfg["seasonality"] == BaselineConfig().seasonality
    assert cfg["modified_z_threshold"] == BaselineConfig().modified_z_threshold
    # Persisted onto live prefs.
    assert state.prefs.baseline.enabled is True
    assert state.prefs.baseline.warmup_multiplier == 5

    # A second partial PUT keeps the first change (merge, not clobber).
    r2 = client.put("/api/baseline/config", json={"seasonality": "hour_of_day"})
    assert r2.status_code == 200, r2.text
    cfg2 = r2.json()["config"]
    assert cfg2["seasonality"] == "hour_of_day"
    assert cfg2["enabled"] is True  # preserved from the prior PUT
    assert cfg2["warmup_multiplier"] == 5  # preserved


def test_baseline_config_put_audits_appendonly(state_and_client) -> None:
    state, client = state_and_client
    assert client.put("/api/baseline/config", json={"enabled": True}).status_code == 200
    rows = _run(client, state._real_audit.records(surface="baseline", limit=50))
    assert rows, "a PUT baseline/config must write an append-only audit row (#2)"
    assert any("baseline_config_update" in (r.get("result_summary") or "") for r in rows)
    assert all(r.get("action_type") == ActionType.USER_MGMT.value for r in rows)


def test_baseline_config_put_rejects_invalid(state_and_client) -> None:
    _state, client = state_and_client
    # warmup_multiplier has ge=1; 0 must 422 (validated by the Pydantic model).
    assert client.put("/api/baseline/config", json={"warmup_multiplier": 0}).status_code == 422


# --------------------------------------------------------------------------- #
# CAMPAIGN — GET/PUT /api/campaigns/config
# --------------------------------------------------------------------------- #
def test_campaign_config_get_defaults(state_and_client) -> None:
    _state, client = state_and_client
    r = client.get("/api/campaigns/config")
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    assert cfg == CampaignConfig().model_dump(mode="json")
    assert cfg["enabled"] is True   # Autopilot overhaul: campaign clustering defaults ON
    assert cfg["cadence"] == "daily"


def test_campaign_config_put_deep_merges_and_persists(state_and_client) -> None:
    state, client = state_and_client
    r = client.put("/api/campaigns/config", json={"enabled": True})
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    assert cfg["enabled"] is True
    # Untouched cadence keeps its default (deep-merge).
    assert cfg["cadence"] == CampaignConfig().cadence
    assert state.prefs.campaign.enabled is True

    r2 = client.put("/api/campaigns/config", json={"cadence": "weekly"})
    assert r2.status_code == 200, r2.text
    cfg2 = r2.json()["config"]
    assert cfg2["cadence"] == "weekly"
    assert cfg2["enabled"] is True  # preserved from the prior PUT


def test_campaign_config_put_audits_appendonly(state_and_client) -> None:
    state, client = state_and_client
    assert client.put("/api/campaigns/config", json={"enabled": True}).status_code == 200
    rows = _run(client, state._real_audit.records(surface="campaigns", limit=50))
    assert rows, "a PUT campaigns/config must write an append-only audit row (#2)"
    assert any("campaign_config_update" in (r.get("result_summary") or "") for r in rows)


def test_campaign_config_put_rejects_invalid(state_and_client) -> None:
    _state, client = state_and_client
    # cadence is a Literal; a bad value must 422.
    assert client.put("/api/campaigns/config", json={"cadence": "yearly"}).status_code == 422


# --------------------------------------------------------------------------- #
# BATCH — GET/PUT /api/batch/config
# --------------------------------------------------------------------------- #
def test_batch_config_get_defaults(state_and_client) -> None:
    _state, client = state_and_client
    r = client.get("/api/batch/config")
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    assert cfg == BatchConfig().model_dump(mode="json")
    assert cfg["enabled"] is False
    # No secret ever appears — only routing knobs (#10).
    assert set(cfg) == {
        "enabled", "severity_floor", "providers", "flex",
        "prefer_discounted_alerts", "fallback_to_standard",
    }
    assert cfg["prefer_discounted_alerts"] is True
    assert cfg["fallback_to_standard"] is True


def test_batch_config_put_deep_merges_and_persists(state_and_client) -> None:
    state, client = state_and_client
    r = client.put("/api/batch/config", json={"enabled": True, "severity_floor": 5})
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    assert cfg["enabled"] is True
    assert cfg["severity_floor"] == 5
    # Untouched list keeps its default (deep-merge).
    assert cfg["providers"] == BatchConfig().providers
    assert cfg["flex"] is False
    assert state.prefs.batch.enabled is True
    assert state.prefs.batch.severity_floor == 5

    # A partial PUT of providers REPLACES the list (a list is a leaf value, not merged)
    # but leaves the other keys intact.
    r2 = client.put("/api/batch/config", json={"providers": ["anthropic"], "flex": True})
    assert r2.status_code == 200, r2.text
    cfg2 = r2.json()["config"]
    assert cfg2["providers"] == ["anthropic"]
    assert cfg2["flex"] is True
    assert cfg2["enabled"] is True  # preserved
    assert cfg2["severity_floor"] == 5  # preserved


def test_batch_config_put_audits_appendonly(state_and_client) -> None:
    state, client = state_and_client
    assert client.put("/api/batch/config", json={"enabled": True}).status_code == 200
    rows = _run(client, state._real_audit.records(surface="batch", limit=50))
    assert rows, "a PUT batch/config must write an append-only audit row (#2)"
    assert any("batch_config_update" in (r.get("result_summary") or "") for r in rows)


def test_batch_config_put_rejects_invalid(state_and_client) -> None:
    _state, client = state_and_client
    # severity_floor is 1..6; 9 must 422.
    assert client.put("/api/batch/config", json={"severity_floor": 9}).status_code == 422


# --------------------------------------------------------------------------- #
# TUNING — the 3 previously-untested fields (max_n_step / wilson_z / ewma_alpha)
# are EXPOSED and round-trip through GET → PUT → GET.
# --------------------------------------------------------------------------- #
def test_tuning_config_exposes_and_roundtrips_all_three_missing_fields(state_and_client) -> None:
    _state, client = state_and_client
    # GET exposes all three fields (they were never asserted before this wave).
    g0 = client.get("/api/tuning/config")
    assert g0.status_code == 200, g0.text
    cfg0 = g0.json()["config"]
    for field in ("max_n_step", "wilson_z", "ewma_alpha"):
        assert field in cfg0, f"tuning config must expose {field}"

    # PUT round-trips non-default values for all three.
    r = client.put("/api/tuning/config", json={
        "enabled": True, "max_n_step": 3, "wilson_z": 2.58, "ewma_alpha": 0.5,
    })
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    assert cfg["max_n_step"] == 3
    assert cfg["wilson_z"] == 2.58
    assert cfg["ewma_alpha"] == 0.5

    # A fresh GET confirms they persisted (round-trip through the store).
    g1 = client.get("/api/tuning/config").json()["config"]
    assert g1["max_n_step"] == 3
    assert g1["wilson_z"] == 2.58
    assert g1["ewma_alpha"] == 0.5


def test_tuning_config_validates_the_missing_fields(state_and_client) -> None:
    _state, client = state_and_client
    # ewma_alpha is gt=0.0, le=1.0 — 0 and >1 must 422.
    assert client.put("/api/tuning/config", json={"ewma_alpha": 0.0}).status_code == 422
    assert client.put("/api/tuning/config", json={"ewma_alpha": 1.5}).status_code == 422
    # max_n_step is ge=0 — a negative must 422.
    assert client.put("/api/tuning/config", json={"max_n_step": -1}).status_code == 422
    # wilson_z is ge=0.0 — a negative must 422.
    assert client.put("/api/tuning/config", json={"wilson_z": -0.1}).status_code == 422


# --------------------------------------------------------------------------- #
# deny-by-default authZ — a non-GET config route is 401'd with auth ON, no token.
# --------------------------------------------------------------------------- #
def test_config_puts_rejected_when_auth_on_without_token() -> None:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None, es_store_enabled=False, redis_url="",
            anthropic_api_key=None, openai_api_key=None,
            auth_enabled=True, auth_jwt_secret="r5-w0f-secret",
        )
        mock = MockProvider()
        overrides = {"anthropic": mock, "openai": mock, "mock": mock}
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for r in (baseline_router, campaign_router, batch_router):
        api.include_router(r, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        assert client.put("/api/baseline/config", json={"enabled": True}).status_code == 401
        assert client.put("/api/campaigns/config", json={"enabled": True}).status_code == 401
        assert client.put("/api/batch/config", json={"enabled": True}).status_code == 401


# --------------------------------------------------------------------------- #
# Every non-GET config route carries an authZ gate (route-auth-coverage discipline).
# --------------------------------------------------------------------------- #
def test_every_non_get_config_route_carries_an_authz_gate() -> None:
    from fastapi.routing import APIRoute

    _AUTHZ = {
        "require_permission.<locals>._dep", "require_role.<locals>._dep",
        "require_fresh_auth.<locals>._dep", "require_admin",
    }

    def _calls(dependant) -> set:
        out = set()
        for dep in dependant.dependencies:
            if dep.call is not None:
                out.add(dep.call)
            out |= _calls(dep)
        return out

    for r in (*baseline_router.routes, *campaign_router.routes, *batch_router.routes):
        if not isinstance(r, APIRoute):
            continue
        if "GET" in r.methods and r.methods <= {"GET", "HEAD"}:
            continue  # reads need only require_auth (mounted by the integrator)
        gated = any(
            getattr(c, "__module__", "") == "app.api.deps"
            and getattr(c, "__qualname__", "") in _AUTHZ
            for c in _calls(r.dependant)
        )
        assert gated, f"non-GET route lacks an authZ gate: {sorted(r.methods)} {r.path}"
