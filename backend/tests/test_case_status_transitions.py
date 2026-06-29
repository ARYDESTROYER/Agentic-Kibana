"""Case status taxonomy + lifecycle transitions (F8).

Covers the new analyst lifecycle actions on POST /cases/{id}/action (hold/resume/
resolve/set_disposition/escalate/deescalate/set_status), the transition guard
(illegal moves rejected; reopen allowed out of a terminal status), the appended
status_history, and that stored OLD-enum cases (open/needs_human/closed) load.
"""

from __future__ import annotations

import json

from app.constants import CaseStatus, Disposition, EntityType, SourceSurface
from app.models import Case, Entity
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event


def _seed(client, **kw) -> str:
    es = client.app.state.tlsoc.es
    return es.add_log("all-logs-2026.06.16", make_log_event(**kw))


def _ms_ago(hours: float = 0.0) -> int:
    return to_millis(now_utc()) - int(hours * 3600 * 1000)


def _create_case(client, mock_provider, ip: str) -> str:
    _seed(client, ip=ip, ts_millis=_ms_ago(hours=1))
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {
            "verdict": "NEEDS_HUMAN", "confidence": 0.2,
            "evidence": [{"summary": "e", "event_ids": []}],
            "mitre": [], "recommended_action": "review", "reproduce_query": 'source.ip : "x"',
        },
    }))
    r = client.post("/api/investigate",
                    json={"entity": {"type": "ip", "value": ip}, "source_surface": "investigate"})
    assert r.status_code == 200, r.text
    return r.json()["case_id"]


def _action(client, case_id, **body):
    return client.post(f"/api/cases/{case_id}/action", json=body)


# --- lifecycle actions ---------------------------------------------------------
def test_hold_resume_resolve_cycle(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.10")
    r = _action(client, cid, action="hold", reason="awaiting vendor")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "on_hold"
    assert body["status_reason"] == "awaiting vendor"
    assert body["status_history"][-1]["to_status"] == "on_hold"

    r = _action(client, cid, action="resume")
    assert r.json()["status"] == "open"

    r = _action(client, cid, action="resolve", reason="confirmed benign activity")
    assert r.json()["status"] == "resolved"


def test_set_disposition(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.11")
    r = _action(client, cid, action="set_disposition", disposition="benign", reason="known scanner")
    assert r.status_code == 200, r.text
    assert r.json()["disposition"] == "benign"
    # set_disposition does not move the lifecycle status by itself.


def test_set_disposition_rejects_unknown(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.12")
    r = _action(client, cid, action="set_disposition", disposition="nonsense")
    assert r.status_code == 400


def test_escalate_then_deescalate(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.13")
    r = _action(client, cid, action="escalate", level=3, reason="tier3")
    assert r.json()["status"] == "escalated"
    assert r.json()["escalation_level"] == 3
    r = _action(client, cid, action="deescalate")
    assert r.json()["status"] == "open"
    assert r.json()["escalation_level"] == 0


def test_set_status_arbitrary_legal(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.14")
    r = _action(client, cid, action="set_status", status="investigating")
    assert r.json()["status"] == "investigating"


def test_set_status_unknown_rejected(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.15")
    r = _action(client, cid, action="set_status", status="bogus")
    assert r.status_code == 400


def test_set_status_cannot_close(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.16")
    r = _action(client, cid, action="set_status", status="closed")
    assert r.status_code == 400  # must use close action


# --- transition guard ----------------------------------------------------------
def test_closed_cannot_move_without_reopen(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.17")
    assert _action(client, cid, action="close").json()["status"] == "closed"
    # A forward move out of terminal CLOSED is rejected unless via reopen.
    r = _action(client, cid, action="hold")
    assert r.status_code == 400
    # Reopen is explicitly allowed.
    assert _action(client, cid, action="reopen").json()["status"] == "open"


def test_confirm_fp_sets_disposition(client, mock_provider):
    cid = _create_case(client, mock_provider, "203.0.113.18")
    r = _action(client, cid, action="confirm_fp")
    assert r.json()["status"] == "closed"
    assert r.json()["disposition"] == "false_positive"


# --- back-compat: stored OLD-enum cases load -----------------------------------
def test_legacy_enum_values_load():
    for legacy in ("open", "needs_human", "closed"):
        c = Case(
            case_id=f"c-{legacy}", cluster_signature="sig",
            source_surface=SourceSurface.AUTOMATED_SCAN,
            entity=Entity(type=EntityType.IP, value="1.2.3.4"),
            status=CaseStatus(legacy),
        )
        # New fields default cleanly on an old-shaped doc.
        assert c.disposition is None
        assert c.status_reason == ""
        assert c.escalation_level == 0
        assert c.status_history == []
        assert c.case_number == ""


def test_case_number_generated_when_format_enabled(client, mock_provider):
    # Enable the F7 nomenclature, then create a case and assert it carries a
    # rendered case_number (case_id stays the immutable internal id).
    r = client.put("/api/settings", json={
        "case_id_format": {"enabled": True, "template": "CASE-{seq:06d}", "prefix": "CASE", "seq_start": 1},
    })
    assert r.status_code == 200, r.text
    cid = _create_case(client, mock_provider, "203.0.113.30")
    case = client.get(f"/api/cases/{cid}").json()
    assert case["case_id"].startswith("case-")          # immutable internal id unchanged
    assert case["case_number"].startswith("CASE-")       # rendered display id present
    assert len(case["case_number"]) == len("CASE-000001")


def test_case_number_empty_when_format_disabled(client, mock_provider):
    # Default (disabled) → case_number stays "" and the UI falls back to case_id.
    cid = _create_case(client, mock_provider, "203.0.113.31")
    case = client.get(f"/api/cases/{cid}").json()
    assert case["case_number"] == ""


def test_legacy_case_dict_without_new_fields_validates():
    # Simulate a stored doc predating F8 (no disposition / status_history / case_number).
    raw = {
        "case_id": "c-old", "cluster_signature": "sig",
        "source_surface": "automated_scan",
        "entity": {"type": "ip", "value": "1.2.3.4"},
        "status": "needs_human",
    }
    c = Case.model_validate(raw)
    assert c.status == CaseStatus.NEEDS_HUMAN
    assert c.disposition is None
    assert c.case_number == ""
