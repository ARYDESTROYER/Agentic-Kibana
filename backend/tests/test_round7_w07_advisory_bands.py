"""Round 7 / W0.7 — severity ladder + read-time advisory bands.

Covers the new 5-band SEVERITY ladder (``priority._severity_band_from_magnitude``,
mirroring the webui ``badges.tsx::severityBandFromNumber`` EXACTLY: 74/48/22/8), the
3-band 48/22 impact/urgency projection (``priority._band_from_magnitude``), the pure
``priority.advisory_bands`` derivation, and the READ-TIME population of the five
advisory fields on ``GET /api/cases`` + ``/api/cases/{id}``.

⛔ NON-NEGOTIABLE #3: none of these advisory bands ever feeds ``case_manager.decide()``.
They are derived AFTER the fact, purely for display / ordering. Offline: fake ES +
mock LLM via the shared ``app_state`` fixture.
"""

from __future__ import annotations

import pytest

from app.config import Preferences, PriorityMatrix, SourceInstance
from app.constants import CaseStatus, EntityType, SourceSurface, SourceType, Verdict
from app.engine.priority import (
    _band_from_magnitude,
    _severity_band_from_magnitude,
    advisory_bands,
    severity_band_from_events,
)
from app.models import Case, Entity, TriggerReason


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _case(
    *,
    case_id: str = "case-w07",
    ip: str = "203.0.113.50",
    risk: float = 72.0,
    severity_max: float | None = 8.0,
    escalation_level: int = 0,
    source_id: str | None = None,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=ip),
        risk_score=risk,
        verdict=Verdict.TRUE_POSITIVE,
        confidence=0.8,
        status=CaseStatus.OPEN,
        escalation_level=escalation_level,
        source_id=source_id,
        trigger_reason=(
            None
            if severity_max is None
            else TriggerReason(rule_value="r", severity_max=severity_max)
        ),
    )


# --------------------------------------------------------------------------- #
# 5-band SEVERITY ladder — mirrors badges.tsx::severityBandFromNumber EXACTLY
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("mag", "band"),
    [
        (100.0, "critical"),
        (74.0, "critical"),   # >= 74 critical cut
        (73.99, "high"),
        (48.0, "high"),       # >= 48 high cut
        (47.99, "medium"),
        (22.0, "medium"),     # >= 22 medium cut
        (21.99, "low"),
        (8.0, "low"),         # >= 8 low cut
        (7.99, "info"),
        (0.0, "info"),        # sub-8 magnitude reads INFO, not a low alert
    ],
)
def test_severity_band_5band_cuts_mirror_badges(mag: float, band: str) -> None:
    assert _severity_band_from_magnitude(mag) == band


@pytest.mark.parametrize(
    ("mag", "band"),
    [
        (100.0, "high"),
        (48.0, "high"),      # 3-band shares the 48 high cut
        (47.99, "medium"),
        (22.0, "medium"),    # 3-band shares the 22 medium cut
        (21.99, "low"),
        (0.0, "low"),        # no info band on the impact/urgency axis
    ],
)
def test_impact_urgency_3band_cuts(mag: float, band: str) -> None:
    assert _band_from_magnitude(mag) == band


# --------------------------------------------------------------------------- #
# advisory_bands — the five flat presentation fields
# --------------------------------------------------------------------------- #
def test_advisory_bands_returns_five_fields() -> None:
    prefs = Preferences(
        asset_criticality={"203.0.113.50": 90.0},
        priority_matrix=PriorityMatrix(enabled=True),
    )
    bands = advisory_bands(_case(risk=72.0, severity_max=8.0), prefs)
    assert set(bands) == {
        "severity_band",
        "severity_source",
        "impact_band",
        "urgency_band",
        "priority_level",
    }
    # severity_max 8.0 (unknown scale -> *10 -> 80) -> critical, source-asserted.
    assert bands["severity_band"] == "critical"
    assert bands["severity_source"] == "source_asserted"
    # asset criticality 90 -> high impact; risk 72 -> high urgency; high/high -> P1.
    assert bands["impact_band"] == "high"
    assert bands["urgency_band"] == "high"
    assert bands["priority_level"] == "P1"


def test_advisory_bands_severity_source_flip() -> None:
    prefs = Preferences()
    # A source-asserted severity flags source_asserted.
    asserted = advisory_bands(_case(severity_max=8.0), prefs)
    assert asserted["severity_source"] == "source_asserted"
    # No source severity -> DERIVED from the deterministic risk total.
    derived = advisory_bands(_case(severity_max=None, risk=45.0), prefs)
    assert derived["severity_source"] == "derived"
    assert derived["severity_band"] == "medium"   # risk 45 -> medium (5-band)


def test_native_demo_source_severity_is_already_ocsf_0_100() -> None:
    """Read-only demo overlays are absent from Preferences.sources by design.

    Their receiver path has already normalized severity to the OCSF 0-100 scale,
    so a low score of 10 must stay low instead of the unknown-scale fallback
    multiplying it to 100 (critical).
    """
    case = _case(severity_max=10.0, source_id="demo-wazuh")
    case.tags = ["demo"]
    result = severity_band_from_events(case, Preferences())
    assert result["scale"] == "ocsf_0_100"
    assert result["value"] == 10.0
    assert result["band"] == "low"


def test_real_source_with_demo_prefix_keeps_its_declared_native_scale() -> None:
    prefs = Preferences(sources=[SourceInstance(
        id="demo-wazuh",
        source_type=SourceType.WAZUH,
        display_name="Real production Wazuh",
    )])
    result = severity_band_from_events(
        _case(severity_max=10.0, source_id="demo-wazuh"), prefs,
    )
    assert result["scale"] == "wazuh_0_16"
    assert result["value"] == pytest.approx(62.5, abs=0.01)


def test_real_source_with_incidental_demo_tag_keeps_declared_scale() -> None:
    prefs = Preferences(sources=[SourceInstance(
        id="prod-wazuh",
        source_type=SourceType.WAZUH,
        display_name="Production Wazuh",
    )])
    case = _case(severity_max=10.0, source_id="prod-wazuh")
    case.tags = ["demo"]  # an analyst-authored tag alone is not an isolation invariant
    result = severity_band_from_events(case, prefs)
    assert result["scale"] == "wazuh_0_16"
    assert result["value"] == pytest.approx(62.5, abs=0.01)


def test_advisory_bands_priority_none_when_matrix_disabled() -> None:
    # A DISABLED matrix -> no effective priority level (agrees with #14). (Autopilot
    # overhaul flipped the DEFAULT to ON; pin it OFF here to exercise the disabled path.)
    prefs = Preferences(asset_criticality={"203.0.113.50": 90.0})
    prefs.priority_matrix.enabled = False
    bands = advisory_bands(_case(risk=72.0, severity_max=8.0), prefs)
    assert bands["impact_band"] == "high"
    assert bands["urgency_band"] == "high"
    assert bands["priority_level"] is None


def test_advisory_bands_no_prefs_resolves_only_severity() -> None:
    # prefs=None -> only the (prefs-free) severity axis resolves; the rest stay None.
    bands = advisory_bands(_case(severity_max=8.0), None)
    assert bands["severity_band"] == "critical"
    assert bands["severity_source"] == "source_asserted"
    assert bands["impact_band"] is None
    assert bands["urgency_band"] is None
    assert bands["priority_level"] is None


_FIVE_KEYS = {
    "severity_band",
    "severity_source",
    "impact_band",
    "urgency_band",
    "priority_level",
}


def test_advisory_bands_degrades_on_edge_values() -> None:
    # Edge case: no trigger_reason, zero risk, uncatalogued entity — must degrade cleanly.
    prefs = Preferences(priority_matrix=PriorityMatrix(enabled=True))
    bands = advisory_bands(_case(severity_max=None, risk=0.0), prefs)
    assert set(bands) == _FIVE_KEYS
    assert bands["severity_band"] == "info"       # risk 0 -> derived info
    assert bands["severity_source"] == "derived"


def test_advisory_bands_fail_open_when_internal_raises(monkeypatch) -> None:
    # If an internal axis derivation blows up, advisory_bands swallows it: the axis reads
    # None while the others still resolve — it NEVER propagates the exception (never 500).
    import app.engine.priority as priority_mod

    def _boom(*_a, **_k):  # noqa: ANN002, ANN003
        raise RuntimeError("boom")

    monkeypatch.setattr(priority_mod, "impact_band", _boom)
    prefs = Preferences(
        asset_criticality={"203.0.113.50": 90.0},
        priority_matrix=PriorityMatrix(enabled=True),
    )
    bands = advisory_bands(_case(risk=72.0, severity_max=8.0), prefs)
    assert set(bands) == _FIVE_KEYS
    assert bands["severity_band"] == "critical"   # severity axis still resolves
    assert bands["impact_band"] is None           # the raising axis degrades to None
    # priority needs impact -> also None (no impact band to look up).
    assert bands["priority_level"] is None


# --------------------------------------------------------------------------- #
# routes — GET /api/cases + /api/cases/{id} populate the advisory bands
# --------------------------------------------------------------------------- #
async def test_list_cases_populates_advisory_bands(app_state) -> None:
    from app.api.routes import list_cases

    state = app_state
    prefs = state.prefs.model_copy(update={
        "asset_criticality": {"203.0.113.50": 90.0},
        "priority_matrix": PriorityMatrix(enabled=True),
    })
    await state.update_prefs(prefs)
    await state.cases.save(_case(case_id="case-list-1", risk=72.0, severity_max=8.0))

    res = await list_cases(state=state, from_=None, to=None)
    case = next(c for c in res.cases if c.case_id == "case-list-1")
    assert case.severity_band == "critical"
    assert case.severity_source == "source_asserted"
    assert case.impact_band == "high"
    assert case.urgency_band == "high"
    assert case.priority_level == "P1"


async def test_get_case_populates_advisory_bands(app_state) -> None:
    from app.api.routes import get_case

    state = app_state
    prefs = state.prefs.model_copy(update={
        "asset_criticality": {"203.0.113.50": 90.0},
        "priority_matrix": PriorityMatrix(enabled=True),
    })
    await state.update_prefs(prefs)
    await state.cases.save(_case(case_id="case-get-1", risk=72.0, severity_max=8.0))

    case = await get_case("case-get-1", state=state)
    assert case.severity_band == "critical"
    assert case.impact_band == "high"
    assert case.priority_level == "P1"


async def test_read_time_bands_never_mutate_the_stored_case(app_state) -> None:
    # The advisory bands are a model_copy on the RESPONSE only — the stored case stays
    # clean (default None) so nothing downstream (or decide()) ever sees them.
    from app.api.routes import get_case

    state = app_state
    await state.cases.save(_case(case_id="case-clean", risk=72.0, severity_max=8.0))
    await get_case("case-clean", state=state)
    stored = await state.cases.get("case-clean")
    assert stored.severity_band is None
    assert stored.priority_level is None


async def test_get_case_is_fail_open_when_derivation_raises(app_state, monkeypatch) -> None:
    # If band derivation blows up, the endpoint must still return 200 with the case
    # (bands unpopulated) — a malformed case can never 500 the endpoint.
    import app.api.routes as routes_mod

    state = app_state
    await state.cases.save(_case(case_id="case-boom", risk=72.0, severity_max=8.0))

    def _boom(_case_arg, _prefs):  # noqa: ANN001
        raise RuntimeError("boom")

    monkeypatch.setattr(routes_mod, "advisory_bands", _boom)
    case = await routes_mod.get_case("case-boom", state=state)
    assert case.case_id == "case-boom"
    assert case.severity_band is None        # derivation swallowed -> unchanged case


# --------------------------------------------------------------------------- #
# ⛔ #3 — the read-time bands never change the deterministic decision
# --------------------------------------------------------------------------- #
def test_advisory_bands_invariant_to_decide() -> None:
    from app.engine.case_manager import decide

    prefs = Preferences(priority_matrix=PriorityMatrix(enabled=True))
    base = decide(Verdict.TRUE_POSITIVE, 0.8, 72.0, prefs.auto_close,
                  escalation_confidence=prefs.escalation_confidence,
                  critical_severity=prefs.critical_severity)
    advisory_bands(_case(risk=72.0, severity_max=8.0), prefs)   # derive (side-effect free)
    again = decide(Verdict.TRUE_POSITIVE, 0.8, 72.0, prefs.auto_close,
                   escalation_confidence=prefs.escalation_confidence,
                   critical_severity=prefs.critical_severity)
    assert again == base
