"""Coverage for the four backend additions (offline, fake ES + mock LLM):

1. POST /cases/{id}/reinvestigate — re-runs the shared pipeline on a stored case
   with force=True; 404 for an unknown case; the optional ``model`` override path
   does not error; the deterministic Case Manager decision (#3) is untouched.
2. POST /cases/{id}/action — the additive resolution/assignee/priority/tags fields
   are persisted, the deterministic status transition is unchanged, and omitting
   them stays back-compatible.
3. POST /chat — the optional per-call ``model`` override does not break chat.
4. GET /standup — robust: returns HTTP 200 with a graceful ``degraded: true``
   payload (never a 500) on an aggregation failure, and a clear disabled payload.
"""

from __future__ import annotations

import json

from app.constants import SourceSurface
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event


def _seed(client, **kw) -> str:
    es = client.app.state.tlsoc.es
    return es.add_log("all-logs-2026.06.16", make_log_event(**kw))


def _ms_ago(days: float = 0.0, hours: float = 0.0) -> int:
    return to_millis(now_utc()) - int((days * 86400 + hours * 3600) * 1000)


def _route_to_investigator(mock_provider) -> None:
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}
    ))


def _final_verdict(verdict: str, confidence: float, reproduce_query: str = 'source.ip : "x"') -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted evidence", "event_ids": []}],
            "mitre": ["T1110"], "recommended_action": "block the source",
            "reproduce_query": reproduce_query,
        },
    })


def _create_case(client, mock_provider, ip: str, *, verdict: str = "NEEDS_HUMAN",
                 confidence: float = 0.2, surface: str = "investigate") -> str:
    _seed(client, ip=ip, ts_millis=_ms_ago(hours=1))
    _seed(client, ip=ip, ts_millis=_ms_ago(hours=2))
    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict(verdict, confidence))
    r = client.post(
        "/api/investigate",
        json={"entity": {"type": "ip", "value": ip}, "source_surface": surface},
    )
    assert r.status_code == 200, r.text
    return r.json()["case_id"]


# --------------------------------------------------------------------------- #
# 1. /cases/{id}/reinvestigate
# --------------------------------------------------------------------------- #
def test_reinvestigate_reruns_with_force_and_updates_verdict(client, mock_provider):
    ip = "192.0.2.31"
    case_id = _create_case(client, mock_provider, ip, verdict="NEEDS_HUMAN", confidence=0.2)
    n_before = len(client.get(f"/api/cases/{case_id}").json()["verdict_history"])

    # A DIFFERENT verdict on the re-run proves the pipeline genuinely ran (force).
    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.9))
    r = client.post(f"/api/cases/{case_id}/reinvestigate")
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["case_id"] == case_id                 # same case, in place
    assert body["verdict"] == "TRUE_POSITIVE"          # genuinely re-investigated
    assert len(body["verdict_history"]) == n_before + 1
    assert body["verdict_history"][-1]["verdict"] == "TRUE_POSITIVE"


def test_reinvestigate_preserves_provenance(client, mock_provider):
    ip = "192.0.2.32"
    case_id = _create_case(client, mock_provider, ip, surface="automated_scan")

    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("FALSE_POSITIVE", 0.99))
    r = client.post(f"/api/cases/{case_id}/reinvestigate")
    assert r.status_code == 200, r.text
    body = r.json()
    # An automated_scan case stays a scan after a manual reinvestigation.
    assert body["source_surface"] == SourceSurface.AUTOMATED_SCAN.value
    assert body["origin_surface"] == SourceSurface.AUTOMATED_SCAN.value


def test_reinvestigate_writes_audit_record(client, mock_provider):
    ip = "192.0.2.33"
    case_id = _create_case(client, mock_provider, ip)

    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.3))
    assert client.post(f"/api/cases/{case_id}/reinvestigate").status_code == 200

    # The manual reinvestigation trigger is audited (actor="reinvestigate"),
    # surfaced through the public trace endpoint (projects the audit rows).
    r = client.get(f"/api/cases/{case_id}/trace")
    assert r.status_code == 200, r.text
    actors = {s.get("actor") for s in r.json()["steps"]}
    assert "reinvestigate" in actors


def test_reinvestigate_model_override_does_not_error(client, mock_provider):
    ip = "192.0.2.34"
    case_id = _create_case(client, mock_provider, ip)

    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.85))
    # The override id is routed via the mock provider overrides, so it must not error.
    r = client.post(f"/api/cases/{case_id}/reinvestigate", json={"model": "claude-opus-4-8"})
    assert r.status_code == 200, r.text
    assert r.json()["case_id"] == case_id


def test_reinvestigate_404_for_unknown_case(client):
    r = client.post("/api/cases/nope-404/reinvestigate")
    assert r.status_code == 404


def test_reinvestigate_400_when_events_aged_out(client, mock_provider):
    ip = "192.0.2.35"
    eid = _seed(client, ip=ip, ts_millis=_ms_ago(hours=1))
    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2))
    r1 = client.post("/api/investigate", json={"event_ids": [eid], "group_by": "ip"})
    case_id = r1.json()["case_id"]

    es = client.app.state.tlsoc.es
    for index in list(es.docs.keys()):
        es.docs[index].pop(eid, None)

    r2 = client.post(f"/api/cases/{case_id}/reinvestigate")
    assert r2.status_code == 400
    assert "No events remain" in r2.json()["detail"]


# --------------------------------------------------------------------------- #
# 2. /cases/{id}/action — additive optional fields
# --------------------------------------------------------------------------- #
def test_action_persists_resolution_assignee_tags_and_keeps_status(client, mock_provider):
    ip = "192.0.2.40"
    case_id = _create_case(client, mock_provider, ip)

    r = client.post(f"/api/cases/{case_id}/action", json={
        "action": "close",
        "note": "benign scan",
        "resolution": "false positive — internal scanner",
        "assignee": "alice",
        "priority": "low",
        "tags": ["benign", "scanner", "benign"],  # dup is de-duped
    })
    assert r.status_code == 200, r.text
    body = r.json()

    # Deterministic status mapping unchanged: close -> CLOSED, decided by analyst.
    assert body["status"] == "closed"
    assert body["decision_by"] == "analyst"
    # Additive fields persisted.
    assert body["assignee"] == "alice"
    assert body["tags"] == ["benign", "scanner"]
    hist = body["history"][-1]
    assert hist["action"] == "close"
    assert hist["resolution"] == "false positive — internal scanner"
    assert hist["priority"] == "low"
    assert hist["note"] == "benign scan"


def test_action_merges_tags_into_existing(client, mock_provider):
    ip = "192.0.2.41"
    case_id = _create_case(client, mock_provider, ip)
    client.post(f"/api/cases/{case_id}/tags", json={"tags": ["existing"]})

    r = client.post(f"/api/cases/{case_id}/action", json={
        "action": "acknowledge", "tags": ["new", "existing"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["tags"] == ["existing", "new"]  # merged, de-duped, order kept


def test_action_back_compat_without_extra_fields(client, mock_provider):
    ip = "192.0.2.42"
    case_id = _create_case(client, mock_provider, ip)

    # The original minimal contract still works and transitions deterministically.
    r = client.post(f"/api/cases/{case_id}/action", json={"action": "escalate", "note": "hi"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "needs_human"
    assert body["decision_by"] == "analyst"
    hist = body["history"][-1]
    assert hist["action"] == "escalate"
    assert "resolution" not in hist and "priority" not in hist  # not added when omitted


def test_action_unknown_action_400(client, mock_provider):
    ip = "192.0.2.43"
    case_id = _create_case(client, mock_provider, ip)
    r = client.post(f"/api/cases/{case_id}/action", json={"action": "frobnicate"})
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# 3. /chat — per-call model override
# --------------------------------------------------------------------------- #
def test_chat_with_model_override_ok(client, mock_provider):
    r = client.post("/api/chat", json={
        "message": "summarise recent activity",
        "model": "claude-opus-4-8",
    })
    assert r.status_code == 200, r.text
    assert "answer" in r.json()


def test_chat_without_model_override_still_ok(client):
    r = client.post("/api/chat", json={"message": "hello"})
    assert r.status_code == 200
    assert "answer" in r.json()


# --------------------------------------------------------------------------- #
# 4. /standup — robustness
# --------------------------------------------------------------------------- #
def test_standup_degraded_on_aggregation_failure(client, monkeypatch):
    """A failing log aggregation yields HTTP 200 + degraded:true + a summary, never
    a 500."""
    state = client.app.state.tlsoc

    async def boom(*_a, **_k):
        raise RuntimeError("es unavailable")

    # Make BOTH the log search and the case stats search raise — the service must
    # still produce a renderable, degraded payload.
    monkeypatch.setattr(state.es, "search_logs", boom)
    monkeypatch.setattr(state.es, "search", boom)

    r = client.get("/api/standup")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    assert body["degraded"] is True
    assert isinstance(body.get("error"), str) and body["error"]
    assert isinstance(body["summary"], str) and body["summary"]
    assert "aggregate" in body and "cases" in body


def test_standup_happy_path_not_degraded(client):
    r = client.get("/api/standup")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    assert body["degraded"] is False
    assert isinstance(body["summary"], str) and body["summary"]
    assert "aggregate" in body and "window_hours" in body


def test_standup_disabled_returns_clear_payload(client):
    # Disable standup; the route must return a clear {enabled:false} shape (no 500).
    r0 = client.put("/api/settings", json={"standup": {"enabled": False}})
    assert r0.status_code == 200, r0.text

    r = client.get("/api/standup")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is False
    assert body["degraded"] is False
    assert "summary" in body and "aggregate" in body
