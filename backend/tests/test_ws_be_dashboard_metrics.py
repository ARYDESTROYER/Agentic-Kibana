"""WS-BE — dashboard metric plumbing (MTTD · burndown · timing-trend · first_seen).

Offline (no ES/LLM). Locks the additive, ADVISORY reporting metrics the new dashboard
consumes. None of these is EVER read by ``case_manager.decide()`` (#3): they are pure
read-time aggregations over stored ``Case`` objects (plus a pipeline creation check that
the new ``first_seen_millis`` is populated from the originating cluster).

* real MTTD (mean-time-to-detect = ``first_seen_millis`` → ``created_at``);
* the ``burndown`` opened-vs-resolved-per-day series in ``compute_metrics``;
* the ``timing_trend`` per-day mttd/respond/resolve series;
* ``Case.first_seen_millis`` populated at case creation from the cluster.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine import metrics as M
from app.engine.correlation import cluster_from_events
from app.models import Case, Entity, StatusHistoryEntry
from app.state import AppState
from tests.conftest import make_raw_event


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _case(
    cid: str,
    *,
    created: str,
    updated: str | None = None,
    status: CaseStatus = CaseStatus.OPEN,
    first_seen_millis: int = 0,
    history: list[tuple[str, str, str]] | None = None,
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
        status=status,
        first_seen_millis=first_seen_millis,
        status_history=sh,
        confidence=0.9,
        risk_score=50.0,
    )


# --------------------------------------------------------------------------- #
# MTTD — lifecycle_intervals over a set of cases with first-event instants.
# --------------------------------------------------------------------------- #
def test_lifecycle_mttd_from_first_seen_multiple_cases() -> None:
    # Two detected cases (10 min + 30 min latency) + one with no first-event instant.
    c1 = _case(
        "d1",
        created="2026-06-20T06:00:00+00:00",
        first_seen_millis=_ms(datetime(2026, 6, 20, 5, 50, 0, tzinfo=timezone.utc)),  # 10 min
    )
    c2 = _case(
        "d2",
        created="2026-06-20T06:00:00+00:00",
        first_seen_millis=_ms(datetime(2026, 6, 20, 5, 30, 0, tzinfo=timezone.utc)),  # 30 min
    )
    c3 = _case("d3", created="2026-06-20T06:00:00+00:00")  # no first_seen → skipped

    block = M.lifecycle_intervals([c1, c2, c3])["mttd_minutes"]
    assert block["available"] is True
    assert block["count"] == 2  # c3 contributes no sample
    assert block["mean"] == 20.0  # (10 + 30) / 2
    assert block["max"] == 30.0


def test_lifecycle_mttd_skips_backdated_negative_latency() -> None:
    # first_seen AFTER created_at (a backdated event) → no negative-latency sample.
    bad = _case(
        "neg",
        created="2026-06-20T06:00:00+00:00",
        first_seen_millis=_ms(datetime(2026, 6, 20, 7, 0, 0, tzinfo=timezone.utc)),  # 1h AFTER
    )
    block = M.lifecycle_intervals([bad])["mttd_minutes"]
    assert block["available"] is False
    assert block["count"] == 0


# --------------------------------------------------------------------------- #
# Burndown — opened vs resolved per UTC day in compute_metrics.
# --------------------------------------------------------------------------- #
def test_compute_metrics_burndown_opened_vs_resolved() -> None:
    cases = [
        # opened 06-20, closed (via history) 06-21.
        _case(
            "b1",
            created="2026-06-20T08:00:00+00:00",
            updated="2026-06-21T09:00:00+00:00",
            status=CaseStatus.CLOSED,
            history=[("open", "closed", "2026-06-21T09:00:00+00:00")],
        ),
        # opened 06-20, still open.
        _case("b2", created="2026-06-20T10:00:00+00:00", status=CaseStatus.OPEN),
        # opened 06-21, resolved same day (via history).
        _case(
            "b3",
            created="2026-06-21T07:00:00+00:00",
            updated="2026-06-21T11:00:00+00:00",
            status=CaseStatus.RESOLVED,
            history=[("open", "resolved", "2026-06-21T11:00:00+00:00")],
        ),
        # terminal WITHOUT a recorded transition → resolved day falls back to updated_at.
        _case(
            "b4",
            created="2026-06-19T07:00:00+00:00",
            updated="2026-06-22T07:00:00+00:00",
            status=CaseStatus.CLOSED,
        ),
    ]
    out = M.compute_metrics(cases)
    burndown = {row["date"]: row for row in out["burndown"]}
    assert burndown["2026-06-19"] == {"date": "2026-06-19", "opened": 1, "resolved": 0}
    assert burndown["2026-06-20"] == {"date": "2026-06-20", "opened": 2, "resolved": 0}
    assert burndown["2026-06-21"] == {"date": "2026-06-21", "opened": 1, "resolved": 2}
    # b4 resolved-day comes from updated_at (no history) on 06-22.
    assert burndown["2026-06-22"] == {"date": "2026-06-22", "opened": 0, "resolved": 1}


# --------------------------------------------------------------------------- #
# Timing trend — per-day mean detect/respond/resolve, null when no sample.
# --------------------------------------------------------------------------- #
def test_timing_trend_per_day_means_and_null_gaps() -> None:
    detected_and_worked = _case(
        "t1",
        created="2026-06-20T06:00:00+00:00",
        updated="2026-06-20T09:00:00+00:00",
        status=CaseStatus.CLOSED,
        first_seen_millis=_ms(datetime(2026, 6, 20, 5, 30, 0, tzinfo=timezone.utc)),  # 30 min MTTD
        history=[
            ("open", "investigating", "2026-06-20T07:00:00+00:00"),  # respond @ +60 min
            ("investigating", "closed", "2026-06-20T09:00:00+00:00"),  # resolve @ +180 min
        ],
    )
    # Only detected (mttd), never responded/resolved → respond/resolve null on 06-21.
    detected_only = _case(
        "t2",
        created="2026-06-21T06:00:00+00:00",
        first_seen_millis=_ms(datetime(2026, 6, 21, 5, 40, 0, tzinfo=timezone.utc)),  # 20 min MTTD
    )
    trend = {row["date"]: row for row in M.timing_trend([detected_and_worked, detected_only])}
    assert trend["2026-06-20"] == {"date": "2026-06-20", "mttd": 30.0, "respond": 60.0, "resolve": 180.0}
    assert trend["2026-06-21"] == {"date": "2026-06-21", "mttd": 20.0, "respond": None, "resolve": None}


def test_compute_metrics_exposes_burndown_and_timing_trend_keys() -> None:
    out = M.compute_metrics([_case("k", created="2026-06-20T06:00:00+00:00")])
    assert isinstance(out["burndown"], list)
    assert isinstance(out["timing_trend"], list)


# --------------------------------------------------------------------------- #
# Case creation — first_seen_millis populated from the originating cluster.
# --------------------------------------------------------------------------- #
def _cluster(ip: str = "1.2.3.4", n: int = 3):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events), base


async def test_register_candidate_populates_first_seen_from_cluster(app_state: AppState) -> None:
    cluster, base = _cluster()
    assert cluster.first_seen_millis == base  # sanity: correlation set it
    case = await app_state.pipeline.register_candidate(
        cluster, SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )
    assert case.first_seen_millis == base


async def test_investigate_cluster_populates_first_seen(app_state: AppState, mock_provider) -> None:
    cluster, base = _cluster("9.9.9.9")
    mock_provider.push(
        "router",
        json.dumps({"bucket": "obviously_benign", "confidence": 0.95, "reason": "noise"}),
    )
    case = await app_state.pipeline.investigate_cluster(
        cluster, SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )
    assert case.first_seen_millis == base
