"""P1 — case/verdict stability + provenance (Area A).

A re-investigation of an already-investigated OPEN case with no material change
makes ZERO new gateway calls and preserves the verdict; a manual investigate of an
automated_scan case keeps source_surface=automated_scan (so the Automated Scans
tab is not emptied) while origin_surface tracks the first surface; verdict_history
grows with each real investigation.
"""

from __future__ import annotations

import json

from app.constants import EntityType, SourceSurface, Verdict
from app.engine.correlation import cluster_from_events
from app.state import AppState
from tests.conftest import make_raw_event


def _cluster(ip: str = "5.5.5.5", ids: list[str] | None = None):
    base = 1_700_000_000_000
    ids = ids or ["e0", "e1", "e2"]
    events = [make_raw_event(id=i, ip=ip, ts_millis=base + n * 1000) for n, i in enumerate(ids)]
    return cluster_from_events(EntityType.IP, ip, events)


def _final_verdict(verdict: str, confidence: float) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted", "event_ids": ["e0"]}],
            "mitre": ["T1110"], "recommended_action": "block",
            "reproduce_query": 'source.ip : "5.5.5.5"',
        },
    })


async def test_reinvestigate_unchanged_open_case_makes_no_gateway_calls(app_state: AppState, mock_provider):
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.8))

    c1 = await app_state.pipeline.investigate_cluster(_cluster(), SourceSurface.INVESTIGATE, app_state.prefs)
    assert c1.verdict == Verdict.TRUE_POSITIVE
    calls_after_first = len(mock_provider.calls)
    assert calls_after_first > 0

    # Same cluster, same event ids, no force -> short-circuit, no new model calls.
    c2 = await app_state.pipeline.investigate_cluster(_cluster(), SourceSurface.INVESTIGATE, app_state.prefs)
    assert c2.case_id == c1.case_id
    assert c2.verdict == Verdict.TRUE_POSITIVE
    assert len(mock_provider.calls) == calls_after_first  # ZERO new gateway calls


async def test_force_reinvestigates_and_grows_verdict_history(app_state: AppState, mock_provider):
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2))
    c1 = await app_state.pipeline.investigate_cluster(_cluster("6.6.6.6"), SourceSurface.INVESTIGATE, app_state.prefs)
    assert len(c1.verdict_history) == 1

    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.9))
    calls_before = len(mock_provider.calls)
    c2 = await app_state.pipeline.investigate_cluster(
        _cluster("6.6.6.6"), SourceSurface.INVESTIGATE, app_state.prefs, force=True
    )
    assert c2.case_id == c1.case_id
    assert len(mock_provider.calls) > calls_before  # force made real calls
    assert c2.verdict == Verdict.TRUE_POSITIVE
    assert len(c2.verdict_history) == 2
    assert c2.verdict_history[-1]["verdict"] == "TRUE_POSITIVE"


async def test_new_events_trigger_reinvestigation(app_state: AppState, mock_provider):
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2))
    c1 = await app_state.pipeline.investigate_cluster(
        _cluster("7.7.7.7", ids=["a", "b", "c"]), SourceSurface.INVESTIGATE, app_state.prefs
    )
    calls_before = len(mock_provider.calls)

    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.9))
    # New member event id "d" -> material change -> re-investigates without force.
    c2 = await app_state.pipeline.investigate_cluster(
        _cluster("7.7.7.7", ids=["a", "b", "c", "d"]), SourceSurface.INVESTIGATE, app_state.prefs
    )
    assert c2.case_id == c1.case_id
    assert len(mock_provider.calls) > calls_before
    assert c2.verdict == Verdict.TRUE_POSITIVE


async def test_manual_investigate_keeps_automated_scan_provenance(app_state: AppState, mock_provider):
    # First create the case via an automated scan.
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2))
    c1 = await app_state.pipeline.investigate_cluster(
        _cluster("8.8.8.8"), SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )
    assert c1.source_surface == SourceSurface.AUTOMATED_SCAN
    assert c1.origin_surface == SourceSurface.AUTOMATED_SCAN

    # A manual investigate (force) must NOT flip the surface away from automated_scan.
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.9))
    c2 = await app_state.pipeline.investigate_cluster(
        _cluster("8.8.8.8"), SourceSurface.INVESTIGATE, app_state.prefs, force=True
    )
    assert c2.case_id == c1.case_id
    assert c2.source_surface == SourceSurface.AUTOMATED_SCAN  # provenance preserved
    assert c2.origin_surface == SourceSurface.AUTOMATED_SCAN
