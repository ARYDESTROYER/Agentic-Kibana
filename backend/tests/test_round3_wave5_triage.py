"""Round 3 / Wave 5 — triage-trace correctness fixes (2 MEDIUM audit findings).

Two ADVISORY, read-time surfaces that mislabelled real-world inputs:

1. **Severity chip mislabels real source scales.** ``severity_band_from_events``
   guessed the scale from the magnitude (``raw<=10 ? raw*10 : raw``), so an OCSF
   "Informational" score of 10 rendered HIGH and a Wazuh ``rule.level`` of 12
   (CRITICAL on a 0-15 ladder) rendered LOW. The fix carries the source's DECLARED
   scale (resolved from the case's ``source_id`` against ``prefs.sources``) and
   projects each native ladder deterministically. These tests pin both real scales
   through ``severity_band_from_events`` + a monotonicity guard so no future heuristic
   can re-introduce the 10→100 / 12→12 inversion. The severity chip stays ADVISORY and
   never feeds ``decide()`` (#3).

2. **Trace-timeline cost/token attribution double-counts a normal investigation and
   undercounts multi-step ReAct runs.** The per-span divisor was the ledger CALL count;
   a single-call run emits TWO audit LLM rows (PROMPT + VERDICT) so the role total was
   counted twice (0.02 → 0.04), and a 4-call ReAct run split the total across the same
   2 rows (0.08 → 0.04). The fix divides each role's ledger total by the per-role count
   of LLM audit rows, so ``sum over the role's spans == ledger total`` for any N. These
   tests assert EXACT reconciliation for both a single-call and a multi-call run.

Offline: fake ES + mock LLM via the shared ``app_state`` fixture.
"""

from __future__ import annotations

import pytest

from app.api.routes_triage import case_timeline
from app.config import Preferences, SourceInstance
from app.constants import (
    ActionType,
    CaseStatus,
    EntityType,
    IngestMode,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine.case_manager import decide
from app.engine.priority import severity_band_from_events
from app.models import AuditDoc, Case, Entity, TriggerReason, UsageDoc


# --------------------------------------------------------------------------- #
# helpers — cases that carry source provenance so the severity scale resolves
# --------------------------------------------------------------------------- #
def _case(
    *,
    case_id: str = "case-w5",
    severity_max: float | None = 8.0,
    source_id: str | None = None,
    risk: float = 30.0,
    verdict: Verdict | None = Verdict.TRUE_POSITIVE,
    confidence: float = 0.8,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.50"),
        source_id=source_id,
        risk_score=risk,
        verdict=verdict,
        confidence=confidence,
        status=CaseStatus.OPEN,
        trigger_reason=(
            None
            if severity_max is None
            else TriggerReason(rule_value="r", severity_max=severity_max)
        ),
    )


def _wazuh_prefs() -> Preferences:
    """Preferences with a configured Wazuh source whose severity ladder is 0-15."""
    return Preferences(
        sources=[
            SourceInstance(
                id="wz1",
                source_type=SourceType.WAZUH,
                ingest_mode=IngestMode.PULL,
                display_name="Wazuh indexer",
            )
        ]
    )


def _ocsf_push_prefs() -> Preferences:
    """Preferences with a PUSH (webhook) source — records normalise to OCSF (0-100)."""
    return Preferences(
        sources=[
            SourceInstance(
                id="wh1",
                source_type=SourceType.GENERIC,
                ingest_mode=IngestMode.PUSH_HTTP,
                display_name="Webhook receiver",
            )
        ]
    )


def _wazuh_case(*, rule_level: float) -> Case:
    return _case(case_id=f"wz-{rule_level:g}", severity_max=rule_level, source_id="wz1")


# --------------------------------------------------------------------------- #
# FINDING 1 — severity chip is source-scale-aware (no magnitude guess)
# --------------------------------------------------------------------------- #
def test_ocsf_informational_is_not_high() -> None:
    """An OCSF "Informational" finding (severity_score=10.0 on a 0-100 ladder) must NOT
    render HIGH — the old heuristic scaled 10→100. With the push/OCSF source scale it is
    identity-clamped (10 → LOW)."""
    prefs = _ocsf_push_prefs()
    case = _case(case_id="ocsf-info", severity_max=10.0, source_id="wh1")
    sev = severity_band_from_events(case, prefs)
    assert sev["scale"] == "ocsf_0_100"
    assert sev["value"] == 10.0          # NOT 100.0 — no double-scale
    assert sev["band"] == "low"          # 8 <= 10 < 22 medium cut -> low (was 'high' pre-fix)
    assert sev["band"] != "high"


def test_ocsf_benign_zero_one_not_high() -> None:
    """A benign OCSF event (raw severity 0/1 -> score 0/10) does not surface HIGH."""
    prefs = _ocsf_push_prefs()
    for score in (0.0, 10.0):
        sev = severity_band_from_events(
            _case(severity_max=score, source_id="wh1"), prefs
        )
        assert sev["band"] != "high"


def test_wazuh_high_levels_render_high() -> None:
    """Wazuh ``rule.level`` 11/12/15 (the upper end of the 0-15 ladder) must render at or
    above HIGH — the old heuristic left 11-15 unscaled (LOW). On the 5-band severity ladder
    (74/48/22/8) the linear ``level/15*100`` projection lands level 11 (73.3) on HIGH and
    levels 12 (80) / 15 (100) on CRITICAL — never the LOW inversion the audit found. Level 7
    sits mid-ladder (46.67 -> MEDIUM), see the dedicated test below."""
    prefs = _wazuh_prefs()
    for lvl in (11, 12, 15):
        sev = severity_band_from_events(_wazuh_case(rule_level=lvl), prefs)
        assert sev["scale"] == "wazuh_0_15"
        assert sev["band"] in ("high", "critical"), (
            f"wazuh level {lvl} should be >= HIGH, got {sev}"
        )
    # level 12 -> 12/15*100 = 80.0 exactly -> CRITICAL (>= 74); the LOW inversion is gone.
    sev12 = severity_band_from_events(_wazuh_case(rule_level=12), prefs)
    assert sev12["value"] == 80.0
    assert sev12["band"] == "critical"


def test_wazuh_mid_ladder_is_medium_not_low() -> None:
    """Level 7 sits mid-ladder: 7/15*100 = 46.67 -> MEDIUM. The point of the fix is that
    it is NEVER inverted to LOW (the pre-fix 7 -> 7 magnitude) and never spuriously HIGH —
    it lands on the honest MEDIUM band for a linear 0-15 projection."""
    prefs = _wazuh_prefs()
    sev = severity_band_from_events(_wazuh_case(rule_level=7), prefs)
    assert sev["value"] == pytest.approx(46.67, abs=0.01)
    assert sev["band"] == "medium"


def test_wazuh_low_levels_render_low() -> None:
    """The low end of the Wazuh ladder stays low/info (no inversion the other way).

    On the 5-band ladder levels 0/1 (0 and 6.67) sit below the <8 info floor -> INFO,
    while 2/3 (13.3/20) land LOW — never HIGH."""
    prefs = _wazuh_prefs()
    for lvl in (0, 1, 2, 3):
        sev = severity_band_from_events(_wazuh_case(rule_level=lvl), prefs)
        assert sev["band"] in ("info", "low", "medium")
        assert sev["band"] != "high"


def test_severity_value_monotonic_across_wazuh_ladder() -> None:
    """The derived 0-100 value is non-decreasing across the full Wazuh ladder 0..15 —
    no future heuristic can re-introduce the 10→100 / 11→11 inversion."""
    prefs = _wazuh_prefs()
    vals = [
        severity_band_from_events(_wazuh_case(rule_level=lvl), prefs)["value"]
        for lvl in range(0, 16)
    ]
    assert vals == sorted(vals), f"Wazuh severity not monotonic: {vals}"
    # 15 maps to the ceiling, 0 to the floor.
    assert vals[0] == 0.0 and vals[15] == 100.0


def test_severity_value_monotonic_across_ocsf_scores() -> None:
    """Likewise non-decreasing across the OCSF score set {0,10,30,50,75,90,100}."""
    prefs = _ocsf_push_prefs()
    vals = [
        severity_band_from_events(_case(severity_max=s, source_id="wh1"), prefs)["value"]
        for s in (0.0, 10.0, 30.0, 50.0, 75.0, 90.0, 100.0)
    ]
    assert vals == sorted(vals)
    assert vals == [0.0, 10.0, 30.0, 50.0, 75.0, 90.0, 100.0]   # identity-clamped


def test_unknown_scale_preserves_legacy_heuristic() -> None:
    """No prefs / unconfigured source -> the legacy heuristic still applies, keeping old
    stored cases + the no-prefs callers byte-identical (back-compat)."""
    # severity_max=8.0, no prefs -> <=10 -> *10 -> 80 (critical on the 5-band ladder),
    # scale 'unknown'.
    sev = severity_band_from_events(_case(severity_max=8.0))
    assert sev["scale"] == "unknown"
    assert sev["value"] == 80.0 and sev["band"] == "critical"
    # An already-0-100 value with no provenance is not doubled.
    sev2 = severity_band_from_events(_case(severity_max=90.0))
    assert sev2["value"] == 90.0 and sev2["band"] == "critical"
    # An unconfigured source_id (not in prefs.sources) also falls back to legacy.
    sev3 = severity_band_from_events(
        _case(severity_max=8.0, source_id="ghost"), Preferences()
    )
    assert sev3["scale"] == "unknown" and sev3["value"] == 80.0


def test_severity_is_distinct_from_risk() -> None:
    """The severity chip reflects the SOURCE rating, not the computed risk score."""
    prefs = _ocsf_push_prefs()
    # Low OCSF severity (10) on a high-risk case -> still LOW severity (severity != risk).
    case = _case(severity_max=10.0, source_id="wh1", risk=95.0)
    sev = severity_band_from_events(case, prefs)
    assert sev["band"] == "low"
    assert sev["value"] != case.risk_score


def test_demo_source_uses_0_100_scale() -> None:
    """The seeded demo source emits a 0-100 severity regardless of connector type."""
    prefs = Preferences()  # demo resolves by id, no SourceInstance needed
    sev = severity_band_from_events(
        _case(severity_max=10.0, source_id="demo"), prefs
    )
    assert sev["scale"] == "ocsf_0_100"
    assert sev["value"] == 10.0 and sev["band"] == "low"


# --------------------------------------------------------------------------- #
# FINDING 1 — #3 invariance: no advisory band ever changes decide()
# --------------------------------------------------------------------------- #
def test_decide_invariant_to_severity_scale() -> None:
    """decide() is BYTE-IDENTICAL regardless of which severity scale the chip resolves —
    the severity chip is presentation-only and never feeds the deterministic decision."""
    prefs = Preferences()
    # Same verdict/confidence/risk; only the (advisory) severity scale differs.
    base = decide(Verdict.TRUE_POSITIVE, 0.8, 30.0, prefs.auto_close,
                  escalation_confidence=prefs.escalation_confidence,
                  critical_severity=prefs.critical_severity)
    wz = severity_band_from_events(_wazuh_case(rule_level=12), _wazuh_prefs())
    ocsf = severity_band_from_events(_case(severity_max=10.0, source_id="wh1"),
                                     _ocsf_push_prefs())
    assert wz["band"] == "critical" and ocsf["band"] == "low"   # bands genuinely differ
    again = decide(Verdict.TRUE_POSITIVE, 0.8, 30.0, prefs.auto_close,
                   escalation_confidence=prefs.escalation_confidence,
                   critical_severity=prefs.critical_severity)
    assert again == base   # the decision is invariant to the advisory band


# --------------------------------------------------------------------------- #
# FINDING 2 — trace-timeline cost/token attribution reconciles with the ledger
# --------------------------------------------------------------------------- #
async def test_timeline_totals_reconcile_single_call(app_state) -> None:
    """A NORMAL investigation = ONE strong-model call = ONE ledger row, but the
    investigator always records BOTH a PROMPT (pre-loop) and a VERDICT (post-loop) audit
    row. The timeline must report the LEDGER truth (0.02 / 150 tok), NOT 2x it."""
    state = app_state
    cid = "case-recon-single"
    await state.cases.save(_case(case_id=cid))
    await state.usage_store.write(UsageDoc(
        case_id=cid, role="investigator", model="mock",
        prompt_tokens=100, completion_tokens=50, total_tokens=150, cost=0.02))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:00+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.PROMPT, prompt_excerpt="p"))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:02+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.VERDICT, result_summary="verdict=TRUE_POSITIVE"))

    res = await case_timeline(cid, state)
    assert res["totals"]["cost"] == pytest.approx(0.02)   # was 0.04 (2x) pre-fix
    assert res["totals"]["tokens"] == 150                  # was 300 pre-fix
    # Each of the two investigator spans gets HALF the role total; they sum to the truth.
    inv_spans = [s for s in res["spans"] if s["name"] == "investigator"]
    assert len(inv_spans) == 2
    assert sum(s["cost"] for s in inv_spans) == pytest.approx(0.02)
    assert sum(s["tokens"] for s in inv_spans) == 150


async def test_timeline_totals_reconcile_multistep_react(app_state) -> None:
    """A multi-step ReAct loop = N gateway calls = N ledger rows, but STILL only the
    PROMPT + VERDICT audit rows carry a cost slice. The total must equal the FULL ledger
    spend (4 x 0.02 = 0.08), not 50% of it."""
    state = app_state
    cid = "case-recon-multi"
    await state.cases.save(_case(case_id=cid))
    for _ in range(4):  # 4 gateway calls in the ReAct loop -> 4 ledger rows
        await state.usage_store.write(UsageDoc(
            case_id=cid, role="investigator", model="mock",
            prompt_tokens=100, completion_tokens=50, total_tokens=150, cost=0.02))
    # The intermediate tool calls also audit, but they are NOT LLM rows (no slice).
    await state.audit.write(AuditDoc(
        ts="2026-06-16T11:00:00+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.PROMPT, prompt_excerpt="p"))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T11:00:01+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.TOOL_CALL, tool_name="es_query", query_text="host:web01"))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T11:00:09+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.VERDICT, result_summary="verdict=TRUE_POSITIVE"))

    res = await case_timeline(cid, state)
    assert res["totals"]["cost"] == pytest.approx(0.08)    # 4 x 0.02, not 0.04
    assert res["totals"]["tokens"] == 600                   # 4 x 150,  not 300
    inv_llm = [
        s for s in res["spans"]
        if s["name"] == "investigator" and s["cost"] is not None
    ]
    assert len(inv_llm) == 2                                 # PROMPT + VERDICT only
    assert sum(s["cost"] for s in inv_llm) == pytest.approx(0.08)


async def test_timeline_attributes_cost_exactly_single_row(app_state) -> None:
    """Tighten the prior >= assertion to ==: a single VERDICT row for a role gets the
    role's FULL ledger total (one LLM row -> divisor 1)."""
    state = app_state
    cid = "case-recon-exact"
    await state.cases.save(_case(case_id=cid))
    await state.usage_store.write(UsageDoc(
        case_id=cid, role="investigator", model="mock",
        prompt_tokens=100, completion_tokens=50, total_tokens=150, cost=0.0123))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:00+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.VERDICT, result_summary="verdict=TRUE_POSITIVE"))
    res = await case_timeline(cid, state)
    inv = next(s for s in res["spans"] if s["name"] == "investigator")
    assert inv["cost"] == pytest.approx(0.0123)
    assert inv["tokens"] == 150
    assert res["totals"]["cost"] == pytest.approx(0.0123)    # EXACT, not >=


async def test_timeline_multi_role_each_reconciles(app_state) -> None:
    """Two roles (router + investigator) each reconcile independently — the router's one
    PROMPT row gets its full total; the investigator's PROMPT+VERDICT split its total."""
    state = app_state
    cid = "case-recon-roles"
    await state.cases.save(_case(case_id=cid))
    await state.usage_store.write(UsageDoc(
        case_id=cid, role="router", model="mock",
        prompt_tokens=20, completion_tokens=5, total_tokens=25, cost=0.001))
    await state.usage_store.write(UsageDoc(
        case_id=cid, role="investigator", model="mock",
        prompt_tokens=100, completion_tokens=50, total_tokens=150, cost=0.04))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:00+00:00", case_id=cid, actor="router",
        action_type=ActionType.PROMPT, prompt_excerpt="router"))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:01+00:00", case_id=cid, actor="router",
        action_type=ActionType.DECISION, result_summary="bucket=uncertain"))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:02+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.PROMPT, prompt_excerpt="inv"))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:05+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.VERDICT, result_summary="verdict=TRUE_POSITIVE"))

    res = await case_timeline(cid, state)
    router_cost = sum(
        s["cost"] for s in res["spans"]
        if s["name"] == "router" and s["cost"] is not None
    )
    inv_cost = sum(
        s["cost"] for s in res["spans"]
        if s["name"] == "investigator" and s["cost"] is not None
    )
    assert router_cost == pytest.approx(0.001)   # one LLM row -> full total
    assert inv_cost == pytest.approx(0.04)        # two LLM rows -> sum reconciles
    # The router DECISION span carries no cost slice (it is not an LLM row).
    router_decision = next(
        s for s in res["spans"]
        if s["name"] == "router" and s["payload_ref"]["action_type"] == ActionType.DECISION.value
    )
    assert router_decision["cost"] is None
    # Grand total == ledger total for the case.
    assert res["totals"]["cost"] == pytest.approx(0.041)


async def test_timeline_ledger_miss_degrades_to_no_cost(app_state) -> None:
    """A ledger with no rows for the case still produces spans (no cost shown), never
    raises — the defensive empty-map degrade is preserved."""
    state = app_state
    cid = "case-noledger"
    await state.cases.save(_case(case_id=cid))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:00+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.VERDICT, result_summary="verdict=TRUE_POSITIVE"))
    res = await case_timeline(cid, state)
    inv = next(s for s in res["spans"] if s["name"] == "investigator")
    assert inv["cost"] is None and inv["tokens"] is None
    assert res["totals"]["cost"] == 0.0
