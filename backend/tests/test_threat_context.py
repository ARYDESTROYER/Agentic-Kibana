"""Wave 6 / F11 — threat-context panel assembly + MITRE lookup.

Offline tests (fake ES + mock LLM). Cover the fail-open parallel assembly (a missing
enrichment / MITRE / related section still returns a panel), the
``ioc_malicious_threshold`` mapping, and the bundled-JSON MITRE lookup.
"""

from __future__ import annotations

import pytest

from app.config import Preferences, ThreatContextConfig
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine import mitre
from app.engine import threat_context as tc
from app.models import Case, Entity, EvidenceItem
from app.state import AppState
from app.tools.enrich import EnrichTool


def _case(
    *, case_id: str = "c1", ip: str = "203.0.113.5", entity_type: EntityType = EntityType.IP,
    mitre_ids: list[str] | None = None, verdict: Verdict = Verdict.TRUE_POSITIVE,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=entity_type, value=ip),
        rule_ids=["modsec_sqli"],
        risk_score=70.0,
        verdict=verdict,
        confidence=0.9,
        mitre=mitre_ids or ["T1110", "T1190"],
        evidence=[EvidenceItem(summary="6 failed logins then success", event_ids=["e1", "e2"], query="ip:x")],
    )


# --------------------------------------------------------------------------- #
# MITRE lookup from the bundled JSON
# --------------------------------------------------------------------------- #
def test_mitre_lookup_from_bundle() -> None:
    assert mitre.loaded_count() > 100  # the compact corpus is bundled
    bf = mitre.technique("T1110")
    assert bf is not None
    assert bf["id"] == "T1110"
    assert "Brute Force" in bf["name"]
    assert isinstance(bf["tactics"], list) and bf["tactics"]
    # Unknown / invalid ids return None.
    assert mitre.technique("T9999") is None
    assert mitre.technique("not-a-technique") is None
    assert mitre.technique(None) is None


def test_mitre_subtechnique_falls_back_to_parent() -> None:
    # A sub-technique not in the compact set still resolves to its parent.
    res = mitre.technique("T1110.999")
    assert res is not None
    assert res["id"] in ("T1110.999", "T1110")  # exact sub if present else parent


def test_mitre_map_many_dedups_and_drops_unknown() -> None:
    out = mitre.map_many(["T1110", "T1110", "T9999", "T1190"])
    ids = [t["id"] for t in out]
    assert ids == ["T1110", "T1190"]  # de-duped + unknown dropped, order preserved


# --------------------------------------------------------------------------- #
# Panel assembly — happy path
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_assemble_full_panel(app_state: AppState) -> None:
    case = _case(ip="8.8.8.8")  # a globally-routable (external) IP
    enrich = EnrichTool(app_state.secrets, app_state.prefs, app_state.cache)
    panel = await tc.assemble(
        case, app_state.prefs, enrich=enrich, rag=app_state.rag, cases=app_state.cases
    )
    assert panel.case_id == case.case_id
    # MITRE techniques resolved from the bundle.
    assert {t["id"] for t in panel.mitre_techniques} == {"T1110", "T1190"}
    # Evidence carried through.
    assert panel.evidence and panel.evidence[0]["summary"].startswith("6 failed logins")
    # Asset context computed (an external/public IP → not internal, criticality 0).
    assert panel.asset_context["entity"] == "ip:8.8.8.8"
    assert panel.asset_context["is_internal"] is False
    assert panel.generated_at


@pytest.mark.asyncio
async def test_ioc_threshold_maps_reputation_to_malicious(app_state: AppState, monkeypatch) -> None:
    case = _case(ip="198.51.100.20")
    enrich = EnrichTool(app_state.secrets, app_state.prefs, app_state.cache)

    from app.models import EnrichmentResult

    async def _fake_enrich(ip):
        return EnrichmentResult(ip=ip, reputation_score=60.0, is_malicious=True, country="US")

    monkeypatch.setattr(enrich, "enrich_ip", _fake_enrich)

    # Threshold 50 → 60 is malicious.
    prefs50 = app_state.prefs.model_copy(update={
        "threat_context": ThreatContextConfig(ioc_malicious_threshold=50)
    })
    panel = await tc.assemble(case, prefs50, enrich=enrich)
    assert panel.ioc_reputation[0]["score"] == 60.0
    assert panel.ioc_reputation[0]["is_malicious"] is True

    # Threshold 80 → 60 is NOT malicious (the panel's own tunable cut).
    prefs80 = app_state.prefs.model_copy(update={
        "threat_context": ThreatContextConfig(ioc_malicious_threshold=80)
    })
    panel2 = await tc.assemble(case, prefs80, enrich=enrich)
    assert panel2.ioc_reputation[0]["is_malicious"] is False


# --------------------------------------------------------------------------- #
# FAIL-OPEN — a missing/erroring section never blanks the whole panel
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_fail_open_missing_enrichment_still_returns_panel(app_state: AppState) -> None:
    case = _case()
    # No enrich tool at all → ioc section empty, the rest still assembles.
    panel = await tc.assemble(case, app_state.prefs, enrich=None, rag=app_state.rag, cases=app_state.cases)
    assert panel.ioc_reputation == []
    assert {t["id"] for t in panel.mitre_techniques} == {"T1110", "T1190"}
    assert panel.evidence  # still there


@pytest.mark.asyncio
async def test_fail_open_enrichment_raises(app_state: AppState, monkeypatch) -> None:
    case = _case()
    enrich = EnrichTool(app_state.secrets, app_state.prefs, app_state.cache)

    async def _boom(ip):
        raise RuntimeError("enrichment provider down")

    monkeypatch.setattr(enrich, "enrich_ip", _boom)
    panel = await tc.assemble(case, app_state.prefs, enrich=enrich, rag=app_state.rag, cases=app_state.cases)
    # IOC section degraded to empty; MITRE + evidence intact.
    assert panel.ioc_reputation == []
    assert panel.mitre_techniques


@pytest.mark.asyncio
async def test_fail_open_mitre_disabled(app_state: AppState) -> None:
    case = _case()
    prefs = app_state.prefs.model_copy(update={
        "threat_context": ThreatContextConfig(mitre_enabled=False)
    })
    panel = await tc.assemble(case, prefs, enrich=None, rag=app_state.rag, cases=app_state.cases)
    assert panel.mitre_techniques == []  # disabled → empty, panel still returns


@pytest.mark.asyncio
async def test_disabled_panel_returns_empty_base(app_state: AppState) -> None:
    case = _case()
    prefs = app_state.prefs.model_copy(update={
        "threat_context": ThreatContextConfig(enabled=False)
    })
    panel = await tc.assemble(case, prefs, enrich=None, rag=app_state.rag, cases=app_state.cases)
    assert panel.case_id == case.case_id
    assert panel.mitre_techniques == [] and panel.ioc_reputation == [] and panel.evidence == []


# --------------------------------------------------------------------------- #
# Related cases — internal asset + prior closed case scan
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_related_cases_surfaces_prior_closed_case(app_state: AppState) -> None:
    # A prior CLOSED case for the same internal entity.
    prior = Case(
        case_id="prior-1",
        cluster_signature="sig:prior-1",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="10.1.2.3"),
        rule_ids=["ssh_bruteforce"],
        verdict=Verdict.FALSE_POSITIVE,
        status=CaseStatus.CLOSED,
        summary="prior benign scanner",
    )
    await app_state.cases.save(prior)

    # Disable RAG so we exercise the direct closed-case fallback deterministically.
    prefs = app_state.prefs.model_copy(update={
        "rag": app_state.prefs.rag.model_copy(update={"enabled": False}),
    })
    case = _case(case_id="cur", ip="10.1.2.3")
    panel = await tc.assemble(case, prefs, enrich=None, rag=app_state.rag, cases=app_state.cases)
    assert any(rc["case_id"] == "prior-1" for rc in panel.related_cases)
    # The current entity is internal (10.x is private).
    assert panel.asset_context["is_internal"] is True


# --------------------------------------------------------------------------- #
# HTTP route — GET /api/cases/{id}/threat-context
# --------------------------------------------------------------------------- #
def test_threat_context_route(client) -> None:
    from functools import partial

    state: AppState = client.app.state.tlsoc
    case = _case(case_id="ctc")
    client.portal.call(partial(state.cases.save, case))
    r = client.get(f"/api/cases/ctc/threat-context")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["case_id"] == "ctc"
    assert {t["id"] for t in body["mitre_techniques"]} == {"T1110", "T1190"}
    # Unknown case → 404.
    assert client.get("/api/cases/nope/threat-context").status_code == 404
