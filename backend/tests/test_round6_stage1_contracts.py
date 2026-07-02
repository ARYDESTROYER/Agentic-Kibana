"""Round-6 Stage-1 backend-contract regressions (handoffs 10/15/16/20/21/37).

Fully offline (fake ES + mock LLM, auth OFF). Locks the additive backend contracts so
they cannot silently regress:

* #10 — a rule edited via ``PUT /api/settings`` (the DetectionRulesHome save path) now
  writes a ``RuleVersion`` per changed rule so the G6 ledger + rollback are real.
* #15 — ``CaseAutomationRule`` carries an optional DISPLAY ``name`` that round-trips.
* #16 — a ``RuleDefinition`` carries optional ``mitre``/``schedule``/``suppression``
  metadata that round-trips (advisory only; never feeds ``decide()``, #3).
* #20 — ``GET /api/roles`` also returns the RAW custom-role definitions.
* #21 — ``configured`` carries an additive per-provider ``sso_client_secrets_by_id``
  map (booleans only, #10) alongside the legacy scalar.
* #37 — ``GET /api/cases`` honours OPTIONAL ``from``/``to`` created-time-window params
  (default == byte-identical prior behaviour).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Secrets
from app.constants import EntityType, SourceSurface
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, CustomRole, Entity
from app.state import AppState


def _iso(dt: datetime) -> str:
    return dt.isoformat()


@pytest.fixture
def state_and_client():
    """Monolith + rules routers, auth OFF; seed 3 cases (staggered created_at) + a
    custom role inside the lifespan so tests can exercise the read contracts."""
    from app.api.routes import router as monolith_router
    from app.api.routes_rules import router as rules_router

    holder: dict[str, Any] = {}
    now = datetime.now(timezone.utc)

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
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        # 3 cases at now-1h / now-25h / now-72h (created_at desc order preserved).
        for cid, hours in (("case-recent", 1), ("case-mid", 25), ("case-old", 72)):
            await state.cases.save(Case(
                case_id=cid, cluster_signature=f"sig-{cid}",
                source_surface=SourceSurface.AUTOMATED_SCAN,
                entity=Entity(type=EntityType.IP, value="10.0.0.1"),
                created_at=_iso(now - timedelta(hours=hours)),
            ))
        # A stored custom role (out-of-band). RBAC on so it resolves into the matrix too.
        await state.custom_roles.put(CustomRole(
            name="tier1_plus", description="Tier-1 with cost view",
            inherits=["analyst_tier1"], grants={"cost": ["view"]},
            denies={"cases": ["close"]},
        ))
        await state.update_prefs(state.prefs.model_copy(
            update={"rbac": state.prefs.rbac.model_copy(update={"enabled": True})}))
        app.state.tlsoc = state
        holder["state"] = state
        holder["now"] = now
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    api.include_router(rules_router)
    with TestClient(api) as client:
        yield holder["state"], client, holder["now"]


def _get_prefs(client) -> dict[str, Any]:
    r = client.get("/api/settings")
    assert r.status_code == 200, r.text
    return r.json()["prefs"]


def _put(client, patch: dict[str, Any]) -> dict[str, Any]:
    r = client.put("/api/settings", json=patch)
    assert r.status_code == 200, r.text
    return r.json()["prefs"]


# --------------------------------------------------------------------------- #
# #10 — settings-save version recording (the G6 ledger becomes real).
# --------------------------------------------------------------------------- #
def test_settings_save_creates_rule_version(state_and_client) -> None:
    state, client, _ = state_and_client
    prefs = _get_prefs(client)
    catalog = list(prefs["rule_catalog"])
    new_rule = {
        "name": "r6_new_rule", "enabled": True,
        "match": {"field": "event.module", "op": "equals", "value": "brute_force"},
        "priority": 100,
    }
    _put(client, {"rule_catalog": catalog + [new_rule]})
    # The ledger now has a CREATE version for the new rule (via the settings path).
    r = client.get("/api/rules/detection/r6_new_rule/versions")
    assert r.status_code == 200, r.text
    versions = r.json()["versions"]
    assert len(versions) == 1
    assert versions[0]["action"] == "create"
    assert versions[0]["config"]["name"] == "r6_new_rule"
    assert "settings" in versions[0]["summary"]


def test_settings_save_records_enable_disable_action(state_and_client) -> None:
    state, client, _ = state_and_client
    prefs = _get_prefs(client)
    catalog = list(prefs["rule_catalog"])
    catalog.append({
        "name": "r6_toggle", "enabled": True,
        "match": {"field": "event.module", "op": "equals", "value": "x"},
    })
    _put(client, {"rule_catalog": catalog})
    # Now flip ONLY the enabled flag → recorded as a "disable" (not a generic update).
    prefs2 = _get_prefs(client)
    catalog2 = list(prefs2["rule_catalog"])
    for rd in catalog2:
        if rd["name"] == "r6_toggle":
            rd["enabled"] = False
    _put(client, {"rule_catalog": catalog2})
    versions = client.get("/api/rules/detection/r6_toggle/versions").json()["versions"]
    actions = [v["action"] for v in versions]
    assert "create" in actions and "disable" in actions


def test_settings_save_no_version_when_rules_unchanged(state_and_client) -> None:
    state, client, _ = state_and_client
    # Seed one rule so it has exactly ONE version, then prove an UNRELATED settings PUT
    # records no additional version for it (unchanged rules are never re-snapshotted).
    prefs = _get_prefs(client)
    catalog = list(prefs["rule_catalog"])
    catalog.append({
        "name": "r6_stable", "enabled": True,
        "match": {"field": "event.module", "op": "equals", "value": "z"},
    })
    _put(client, {"rule_catalog": catalog})
    before = len(client.get("/api/rules/detection/r6_stable/versions").json()["versions"])
    assert before == 1
    _put(client, {"rag": {"top_k": 9}})  # touches a NON-rule block
    after = len(client.get("/api/rules/detection/r6_stable/versions").json()["versions"])
    assert after == before  # unchanged rule → no new version


def test_case_automation_edit_via_settings_is_versioned(state_and_client) -> None:
    state, client, _ = state_and_client
    _put(client, {"threshold_automation": {"enabled": False, "rules": [
        {"id": "auto1", "name": "Tag brute force", "action": "tag",
         "conditions": {"verdict": "false_positive"}, "payload": {"tags": ["x"]}},
    ]}})
    versions = client.get("/api/rules/case_automation/auto1/versions").json()["versions"]
    assert len(versions) == 1 and versions[0]["action"] == "create"
    assert versions[0]["config"]["name"] == "Tag brute force"


# --------------------------------------------------------------------------- #
# #15 — CaseAutomationRule.name round-trips.
# --------------------------------------------------------------------------- #
def test_case_automation_name_round_trips(state_and_client) -> None:
    state, client, _ = state_and_client
    r = client.put("/api/rules/case-automation/auto_named", json={
        "id": "auto_named", "name": "My Nice Rule", "action": "tag",
        "conditions": {}, "payload": {"tags": ["t"]},
    })
    assert r.status_code == 200, r.text
    assert r.json()["rule"]["name"] == "My Nice Rule"
    # And it survives a re-GET through the rules home.
    rules = client.get("/api/rules").json()["case_automation"]
    named = next(x for x in rules if x["id"] == "auto_named")
    assert named["name"] == "My Nice Rule"


# --------------------------------------------------------------------------- #
# #16 — RuleDefinition mitre/schedule/suppression round-trip (advisory).
# --------------------------------------------------------------------------- #
def test_detection_rule_advisory_metadata_round_trips(state_and_client) -> None:
    state, client, _ = state_and_client
    body = {
        "name": "r6_meta", "enabled": True,
        "match": {"field": "event.module", "op": "equals", "value": "y"},
        "mitre": ["T1110", "T1078"],
        "schedule": {"interval_seconds": 300, "lookback_seconds": 60},
        "suppression": {"by": ["source.ip"], "scope": "per_window",
                        "window_seconds": 600, "missing_field": "keep"},
    }
    r = client.put("/api/rules/detection/r6_meta", json=body)
    assert r.status_code == 200, r.text
    stored = r.json()["rule"]
    assert stored["mitre"] == ["T1110", "T1078"]
    assert stored["schedule"] == {"interval_seconds": 300, "lookback_seconds": 60}
    assert stored["suppression"]["scope"] == "per_window"
    assert stored["suppression"]["missing_field"] == "keep"
    # Persisted on prefs (survives a settings re-GET).
    prefs = _get_prefs(client)
    got = next(rd for rd in prefs["rule_catalog"] if rd["name"] == "r6_meta")
    assert got["mitre"] == ["T1110", "T1078"]
    assert got["suppression"]["by"] == ["source.ip"]


# --------------------------------------------------------------------------- #
# #20 — GET /api/roles returns the raw custom-role definitions.
# --------------------------------------------------------------------------- #
def test_roles_returns_raw_custom_roles(state_and_client) -> None:
    state, client, _ = state_and_client
    body = client.get("/api/roles").json()
    assert "custom_roles" in body
    tier1_plus = next((r for r in body["custom_roles"] if r["name"] == "tier1_plus"), None)
    assert tier1_plus is not None, body["custom_roles"]
    # The RAW definition carries description + inherits + grants + denies (not just the
    # flattened resolved matrix).
    assert tier1_plus["description"] == "Tier-1 with cost view"
    assert tier1_plus["inherits"] == ["analyst_tier1"]
    assert tier1_plus["grants"] == {"cost": ["view"]}
    assert tier1_plus["denies"] == {"cases": ["close"]}
    # The resolved matrix still exists (back-compat).
    assert "matrix" in body


# --------------------------------------------------------------------------- #
# #21 — per-provider sso_client_secrets_by_id map (booleans only).
# --------------------------------------------------------------------------- #
def test_sso_client_secrets_by_id_map(state_and_client) -> None:
    state, client, _ = state_and_client
    state.secrets.sso_client_secrets = {"google": "s1", "azure": ""}
    body = client.get("/api/settings").json()
    configured = body["configured"]
    # Legacy scalar kept for compat (True iff ANY provider has a secret).
    assert configured["sso_client_secrets"] is True
    # Additive per-provider map — booleans only, never the value.
    by_id = configured["sso_client_secrets_by_id"]
    assert by_id == {"google": True, "azure": False}
    assert "s1" not in repr(body)


# --------------------------------------------------------------------------- #
# #37 — GET /api/cases from/to created-time window.
# --------------------------------------------------------------------------- #
def test_cases_default_no_window_returns_all(state_and_client) -> None:
    state, client, _ = state_and_client
    body = client.get("/api/cases").json()
    assert body["total"] == 3
    assert len(body["cases"]) == 3


def test_cases_from_window_filters_recent(state_and_client) -> None:
    state, client, _ = state_and_client
    # now-24h keeps only the now-1h case.
    body = client.get("/api/cases", params={"from": "now-24h"}).json()
    ids = {c["case_id"] for c in body["cases"]}
    assert ids == {"case-recent"}
    assert body["total"] == 1
    # now-48h keeps the now-1h + now-25h cases.
    body2 = client.get("/api/cases", params={"from": "now-48h"}).json()
    ids2 = {c["case_id"] for c in body2["cases"]}
    assert ids2 == {"case-recent", "case-mid"}
    assert body2["total"] == 2


def test_cases_to_window_filters_old(state_and_client) -> None:
    state, client, _ = state_and_client
    # to=now-48h keeps only the now-72h case.
    body = client.get("/api/cases", params={"to": "now-48h"}).json()
    ids = {c["case_id"] for c in body["cases"]}
    assert ids == {"case-old"}
    assert body["total"] == 1


def test_cases_iso_window_bounds(state_and_client) -> None:
    state, client, now = state_and_client
    lo = _iso(now - timedelta(hours=36))
    hi = _iso(now - timedelta(hours=12))
    body = client.get("/api/cases", params={"from": lo, "to": hi}).json()
    ids = {c["case_id"] for c in body["cases"]}
    assert ids == {"case-mid"}
