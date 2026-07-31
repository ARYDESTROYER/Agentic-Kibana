"""Round-3 Wave-2 Feature 5 — richer security-posture metrics + MITRE coverage.

Offline (no ES/LLM): exercises the pure engine functions
(``engine/metrics`` extensions + ``engine/mitre_coverage``) and the additive router
(``api/routes_metrics``). Asserts:

* MTTA/MTTR/dwell are derived from ``status_history`` transitions as p50/p90/mean,
  with an honest labelled DASH (+ reason) when a transition never occurred.
* Quality rates (alert-to-incident / FP / escalation / containment / automation) are
  COUNTED from verdict/status/decision_by — never decided.
* Aging buckets / oldest-N / queue-depth / closure-vs-arrival.
* SLA metrics vs ``Preferences.sla`` (breached + at-risk; off → enabled:false).
* MITRE coverage validates + drops invalid technique ids (#9), normalises case,
  resolves sub-techniques, tallies per-tactic, stamps the corpus version, and emits a
  Navigator v4.5 layer.
* Period-over-period (value/prev/delta_pct).
* The existing ``compute_metrics``/``feedback_stats`` signatures still work unchanged.
* The three new GET endpoints return the expected shape (mounted on a tiny app).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import SlaPolicy
from app.constants import (
    CaseStatus,
    DecisionBy,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine import metrics as M
from app.engine import mitre_coverage as MC
from app.engine.metrics import compute_metrics, feedback_stats  # back-compat imports
from app.models import Case, Entity, StatusHistoryEntry

NOW = datetime(2026, 6, 30, 12, 0, 0, tzinfo=timezone.utc)


def _case(
    cid: str,
    *,
    created: str,
    updated: str | None = None,
    verdict: Verdict | None = None,
    status: CaseStatus = CaseStatus.OPEN,
    decision_by: DecisionBy | None = None,
    priority: str | None = None,
    mitre: list[str] | None = None,
    history: list[tuple[str, str, str]] | None = None,
    escalation_level: int = 0,
) -> Case:
    sh = [
        StatusHistoryEntry(from_status=f, to_status=t, by="alice", at=at)
        for (f, t, at) in (history or [])
    ]
    return Case(
        case_id=cid,
        cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        created_at=created,
        updated_at=updated or created,
        verdict=verdict,
        status=status,
        decision_by=decision_by,
        priority_level=priority,
        mitre=mitre or [],
        status_history=sh,
        escalation_level=escalation_level,
        confidence=0.9,
        risk_score=50.0,
    )


# --------------------------------------------------------------------------- #
# percentile helper
# --------------------------------------------------------------------------- #
def test_percentile_helper() -> None:
    assert M.percentile([], 50) is None
    assert M.percentile([42.0], 90) == 42.0
    assert M.percentile([1, 2, 3, 4], 50) == 2.5  # mean of middles
    assert M.percentile([1, 2, 3, 4], 0) == 1.0
    assert M.percentile([1, 2, 3, 4], 100) == 4.0
    # clamps out-of-range pct
    assert M.percentile([10, 20], 200) == 20.0


# --------------------------------------------------------------------------- #
# lifecycle intervals (MTTA / MTTR / dwell) from status_history
# --------------------------------------------------------------------------- #
def test_lifecycle_intervals_from_history() -> None:
    # created 00:00 → investigating 00:30 (ack+response) → closed 01:30 (resolve)
    c = _case(
        "c1",
        created="2026-06-30T00:00:00+00:00",
        updated="2026-06-30T01:30:00+00:00",
        status=CaseStatus.CLOSED,
        history=[
            ("new", "investigating", "2026-06-30T00:30:00+00:00"),
            ("investigating", "closed", "2026-06-30T01:30:00+00:00"),
        ],
    )
    out = M.lifecycle_intervals([c])
    assert out["mtta_minutes"]["p50"] == 30.0 and out["mtta_minutes"]["available"]
    assert out["mttr_minutes"]["p50"] == 90.0
    assert out["dwell_minutes"]["p50"] == 30.0
    # p90/mean/max present
    assert out["mttr_minutes"]["mean"] == 90.0 and out["mttr_minutes"]["max"] == 90.0


def test_lifecycle_missing_transition_is_labelled_dash() -> None:
    # A brand-new, never-touched case: no ack / response / resolution happened.
    c = _case("c-fresh", created="2026-06-30T11:00:00+00:00", status=CaseStatus.NEW)
    out = M.lifecycle_intervals([c])
    for key in ("mtta_minutes", "mttr_minutes", "dwell_minutes"):
        block = out[key]
        assert block["p50"] == M.DASH and block["available"] is False
        assert block["reason"]  # an honest explanation, not a fake 0


def test_lifecycle_terminal_without_history_falls_back_to_updated_at() -> None:
    c = _case(
        "c-term",
        created="2026-06-30T00:00:00+00:00",
        updated="2026-06-30T02:00:00+00:00",
        status=CaseStatus.RESOLVED,  # terminal, but no status_history transition recorded
    )
    out = M.lifecycle_intervals([c])
    assert out["mttr_minutes"]["p50"] == 120.0


# --------------------------------------------------------------------------- #
# quality metrics — counted, never decided
# --------------------------------------------------------------------------- #
def test_quality_metrics_counts() -> None:
    cases = [
        _case("q1", created="2026-06-30T00:00:00+00:00", verdict=Verdict.TRUE_POSITIVE,
              status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST),
        _case("q2", created="2026-06-30T00:00:00+00:00", verdict=Verdict.FALSE_POSITIVE,
              status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT),  # auto-closed
        _case("q3", created="2026-06-30T00:00:00+00:00", verdict=Verdict.NEEDS_HUMAN,
              status=CaseStatus.ESCALATED, escalation_level=2),
        _case("q4", created="2026-06-30T00:00:00+00:00", verdict=None, status=CaseStatus.NEW),
    ]
    q = M.quality_metrics(cases)
    assert q["total_cases"] == 4 and q["verdicted_cases"] == 3
    assert q["alert_to_incident_ratio"] == round(1 / 4, 4)
    assert q["false_positive_rate"] == round(1 / 3, 4)  # of VERDICTED cases
    assert q["escalation_rate"] == round(1 / 4, 4)
    assert q["containment_rate"] == round(2 / 4, 4)  # two terminal (q1,q2)
    assert q["automation_rate"] == round(1 / 2, 4)  # one of two terminal auto-closed


# --------------------------------------------------------------------------- #
# aging
# --------------------------------------------------------------------------- #
def test_aging_buckets_and_oldest() -> None:
    cases = [
        _case("a-young", created="2026-06-30T11:30:00+00:00", status=CaseStatus.OPEN),  # 0.5h
        _case("a-mid", created="2026-06-30T06:00:00+00:00", status=CaseStatus.OPEN),    # 6h
        _case("a-old", created="2026-06-25T12:00:00+00:00", status=CaseStatus.OPEN),    # 5d
        _case("a-closed", created="2026-06-25T12:00:00+00:00", status=CaseStatus.CLOSED),
    ]
    age = M.aging(cases, now=NOW, oldest_n=2)
    assert age["queue_depth"] == 3  # the closed one is excluded
    buckets = {b["bucket"]: b["count"] for b in age["age_buckets"]}
    assert buckets["<1h"] == 1 and buckets["4-24h"] == 1 and buckets["3-7d"] == 1
    assert age["oldest"][0]["case_id"] == "a-old"  # oldest first
    assert len(age["oldest"]) == 2
    assert age["arrivals"] == 4 and age["closures"] == 1


# --------------------------------------------------------------------------- #
# SLA metrics
# --------------------------------------------------------------------------- #
def test_sla_disabled_is_byte_compatible() -> None:
    c = _case("s1", created="2026-06-30T00:00:00+00:00", priority="P1", status=CaseStatus.OPEN)
    out = M.sla_metrics([c], SlaPolicy(enabled=False), now=NOW)
    assert out["enabled"] is False and out["evaluated"] == 0


def test_sla_breach_and_at_risk() -> None:
    # P1 targets: response 15m, resolve 240m. Open, never responded, created 5h ago.
    c = _case("s-breach", created="2026-06-30T07:00:00+00:00", priority="P1", status=CaseStatus.OPEN,
              verdict=Verdict.NEEDS_HUMAN)
    out = M.sla_metrics([c], SlaPolicy(enabled=True), now=NOW)
    assert out["enabled"] is True and out["evaluated"] == 1
    assert out["response_breached"] == 1  # 300m elapsed > 15m, unresponded
    assert out["resolve_breached"] == 1   # 300m elapsed > 240m, still open
    assert any(b["clock"] == "response" and b["state"] == "breached" for b in out["breaching"])

    # A P3 case (resolve 1440m): 5h in → not breached; well under at-risk too.
    c3 = _case("s-ok", created="2026-06-30T07:00:00+00:00", priority="P3", status=CaseStatus.OPEN)
    out3 = M.sla_metrics([c3], SlaPolicy(enabled=True), now=NOW)
    assert out3["resolve_breached"] == 0


def test_sla_unmatched_priority_not_scored() -> None:
    c = _case("s-nop", created="2026-06-30T00:00:00+00:00", priority=None, status=CaseStatus.OPEN)
    out = M.sla_metrics([c], SlaPolicy(enabled=True), now=NOW)
    assert out["evaluated"] == 0  # no priority → no SLA target → not scored


# --------------------------------------------------------------------------- #
# MITRE coverage — validation (#9) + tally + Navigator layer
# --------------------------------------------------------------------------- #
def test_mitre_coverage_validates_and_tallies() -> None:
    cases = [
        _case("m1", created="2026-06-30T00:00:00+00:00",
              mitre=["T1110", "t1003", "BOGUS", "T9999", "T1059.001"]),
        _case("m2", created="2026-06-30T00:00:00+00:00", mitre=["T1110", "T1110"]),  # dup in one case
    ]
    cov = MC.compute_mitre_coverage(cases)
    # BOGUS (malformed) + T9999 (unknown) dropped → invalid_dropped == 2.
    assert cov["invalid_dropped"] == 2
    # t1003 normalises to T1003; T1059.001 resolves; T1110 covered. 3 distinct.
    assert cov["covered_techniques"] == 3
    assert cov["total_techniques"] > 600  # the bundled corpus
    assert 0.0 <= cov["coverage_pct"] <= 100.0
    assert cov["corpus_version"] == MC.CORPUS_VERSION
    # T1110 seen in both cases (dup within a case counts once) → case_count 2, ranked top.
    top_ids = {t["id"]: t["case_count"] for t in cov["top_techniques"]}
    assert top_ids.get("T1110") == 2
    # per-tactic rollup has honest denominators
    assert any(v["total"] > 0 for v in cov["by_tactic"].values())


def test_mitre_coverage_empty() -> None:
    cov = MC.compute_mitre_coverage([])
    assert cov["covered_techniques"] == 0 and cov["invalid_dropped"] == 0
    assert cov["coverage_pct"] == 0.0
    assert cov["total_techniques"] > 0  # the framework denominator still loads


def test_navigator_layer_v45_shape() -> None:
    cases = [_case("n1", created="2026-06-30T00:00:00+00:00", mitre=["T1110", "T1059.001"])]
    layer = MC.navigator_layer(cases, window_hours=24)
    assert layer["versions"]["layer"] == "4.5"
    assert layer["domain"] == "enterprise-attack"
    tids = {t["techniqueID"] for t in layer["techniques"]}
    assert tids == {"T1110", "T1059.001"}
    for t in layer["techniques"]:
        assert t["score"] >= 1 and t["enabled"] is True and "comment" in t
    # corpus stamped into metadata
    assert any(m["name"] == "corpus" for m in layer["metadata"])
    # invalid ids never leak into the layer
    bad = MC.navigator_layer([_case("nb", created="2026-06-30T00:00:00+00:00", mitre=["BOGUS"])])
    assert bad["techniques"] == []


# --------------------------------------------------------------------------- #
# period-over-period + posture rollup
# --------------------------------------------------------------------------- #
def test_delta_pct_dash_safe() -> None:
    assert M._delta_pct(120.0, 100.0) == 20.0
    assert M._delta_pct(M.DASH, 100.0) == M.DASH  # gap → dash
    assert M._delta_pct(5.0, 0) is None  # growth from zero is undefined (None)
    assert M._delta_pct(0, 0) == M.DASH


def test_posture_rollup_with_compare() -> None:
    # current-window case (within last 24h of NOW)
    cur = _case("p-cur", created="2026-06-30T06:00:00+00:00", verdict=Verdict.TRUE_POSITIVE,
                status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT, priority="P1",
                updated="2026-06-30T07:00:00+00:00",
                history=[("new", "investigating", "2026-06-30T06:15:00+00:00"),
                         ("investigating", "closed", "2026-06-30T07:00:00+00:00")])
    # previous-window case (24-48h before NOW)
    prev = _case("p-prev", created="2026-06-29T06:00:00+00:00", verdict=Verdict.FALSE_POSITIVE,
                 status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT)
    roll = M.posture_metrics([cur, prev], sla_policy=SlaPolicy(enabled=True),
                             window_hours=24, compare="prev", now=NOW)
    assert roll["window_hours"] == 24
    assert roll["case_count"] == 1  # only the current-window case
    assert "lifecycle" in roll and "quality" in roll and "aging" in roll and "sla" in roll
    assert roll["compare"]["mode"] == "prev"
    assert roll["compare"]["case_count"] == {"value": 1, "prev": 1, "delta_pct": 0.0}
    # the current window has a TP → alert_to_incident 1.0; prev had none → 0.0
    cmp = roll["compare"]["alert_to_incident_ratio"]
    assert cmp["value"] == 1.0 and cmp["prev"] == 0.0


def test_window_filter() -> None:
    inside = _case("w-in", created="2026-06-30T06:00:00+00:00")
    outside = _case("w-out", created="2026-06-01T06:00:00+00:00")
    got = M._window_filter([inside, outside], window_hours=24, now=NOW)
    assert [c.case_id for c in got] == ["w-in"]
    # 0 → no filter
    assert len(M._window_filter([inside, outside], window_hours=0, now=NOW)) == 2


# --------------------------------------------------------------------------- #
# back-compat — existing functions still work unchanged
# --------------------------------------------------------------------------- #
def test_existing_compute_metrics_unchanged() -> None:
    c = _case("legacy", created="2026-06-20T00:00:00+00:00", updated="2026-06-20T01:00:00+00:00",
              verdict=Verdict.FALSE_POSITIVE, status=CaseStatus.CLOSED)
    m = compute_metrics([c])
    assert m["total_cases"] == 1 and m["mttr_minutes"] == 60.0
    assert feedback_stats([c])["feedback_count"] == 0


# --------------------------------------------------------------------------- #
# router — the three new GET endpoints (mounted on a tiny app w/ the app_state)
# --------------------------------------------------------------------------- #
@pytest.fixture
def metrics_client(app_state):
    """A TestClient mounting ONLY the new metrics router over the shared app_state.
    Mirrors how the integrator wires it (router + require_auth dep) without the monolith."""
    from app.api.deps import require_auth
    from app.api.routes_metrics import router

    api = FastAPI()
    api.state.tlsoc = app_state
    from fastapi import Depends

    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


async def test_posture_endpoint(metrics_client, app_state) -> None:
    created = datetime.now(timezone.utc) - timedelta(hours=2)
    closed = created + timedelta(hours=1)
    await app_state.cases.save(
        _case("ep1", created=created.isoformat(), verdict=Verdict.TRUE_POSITIVE,
              status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT, priority="P1",
              history=[("new", "closed", closed.isoformat())])
    )
    r = metrics_client.get("/api/metrics/posture?window_hours=720&compare=prev")
    assert r.status_code == 200
    body = r.json()
    for key in ("lifecycle", "quality", "aging", "sla", "case_count", "compare"):
        assert key in body, key
    assert body["quality"]["total_cases"] >= 1


async def test_mitre_coverage_endpoint(metrics_client, app_state) -> None:
    await app_state.cases.save(
        _case("ep2", created="2026-06-30T06:00:00+00:00", mitre=["T1110", "BOGUS"])
    )
    r = metrics_client.get("/api/mitre/coverage")
    assert r.status_code == 200
    body = r.json()
    assert body["covered_techniques"] >= 1 and body["invalid_dropped"] >= 1
    assert body["corpus_version"] == MC.CORPUS_VERSION


async def test_navigator_layer_endpoint(metrics_client, app_state) -> None:
    await app_state.cases.save(
        _case("ep3", created="2026-06-30T06:00:00+00:00", mitre=["T1059.001"])
    )
    r = metrics_client.get("/api/mitre/coverage/navigator.layer.json")
    assert r.status_code == 200
    body = r.json()
    assert body["versions"]["layer"] == "4.5"
    assert any(t["techniqueID"] == "T1059.001" for t in body["techniques"])
