"""Wave 6 / F10 — manual "run a playbook" (CONTEXT-ONLY, #3-safe).

Offline tests (fake ES + mock LLM). A manual playbook RUN re-investigates the case
with the chosen playbook FORCED as the injected TRUSTED procedure; it does not
bypass the deterministic decision (the playbook can only recommend). Deterministic
auto-selection (registry.select) is UNCHANGED by the forced-run path.
"""

from __future__ import annotations

from functools import partial

import pytest

from app.engine.correlation import cluster_from_events
from app.constants import EntityType, SourceSurface
from app.playbooks import Playbook, PlaybookManifest, PlaybookMatch, select_playbook
from app.state import AppState

from tests.conftest import make_log_event, make_raw_event


def _inject_test_playbook(state: AppState, id_: str = "zz_run_test", *, rule_ids=None) -> Playbook:
    """Inject a distinct test playbook into the live registry (no file needed)."""
    pb = Playbook(
        manifest=PlaybookManifest(
            id=id_, name="Run-test playbook", version=1, priority=999,
            description="A forced-run target.",
            match=PlaybookMatch(rule_ids=rule_ids or []),
        ),
        body="Step 1: confirm the activity. Step 2: contain if hostile.",
    )
    state.playbooks._playbooks = [*state.playbooks.all(), pb]
    return pb


async def _seed(state: AppState, *, rule: str, ip: str, n: int) -> list[str]:
    es = state.es
    ids = []
    for i in range(n):
        src = make_log_event(rule=rule, ip=ip)
        ids.append(es.add_log("all-logs-2026.06.16", src, doc_id=f"{rule}-{ip}-{i}"))
    return ids


# --------------------------------------------------------------------------- #
# registry.run — forces the playbook + reuses the pipeline
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_registry_run_forces_playbook_into_reinvestigation(app_state: AppState) -> None:
    pb = _inject_test_playbook(app_state)
    ids = await _seed(app_state, rule="modsec_sqli", ip="203.0.113.7", n=4)
    cluster = cluster_from_events(
        EntityType.IP, "203.0.113.7",
        [make_raw_event(id=i, ip="203.0.113.7", rule="modsec_sqli") for i in ids],
    )
    case = await app_state.playbooks.run(
        app_state.pipeline, cluster, SourceSurface.INVESTIGATE, app_state.prefs, pb.id
    )
    # The FORCED playbook is recorded on the case (not whatever auto-selection chose).
    assert case.playbook_id == pb.id
    # The audit reason marks it as forced.
    rows = await app_state.audit.records_for_case(case.case_id)
    reasons = [
        (r.get("result_summary") if isinstance(r, dict) else getattr(r, "result_summary", ""))
        for r in rows
        if (r.get("actor") if isinstance(r, dict) else getattr(r, "actor", "")) == "playbook_selector"
    ]
    assert any(f"forced:{pb.id}" in (s or "") for s in reasons)


@pytest.mark.asyncio
async def test_registry_run_unknown_playbook_raises_keyerror(app_state: AppState) -> None:
    ids = await _seed(app_state, rule="r", ip="10.0.0.4", n=2)
    cluster = cluster_from_events(
        EntityType.IP, "10.0.0.4",
        [make_raw_event(id=i, ip="10.0.0.4", rule="r") for i in ids],
    )
    with pytest.raises(KeyError):
        await app_state.playbooks.run(
            app_state.pipeline, cluster, SourceSurface.INVESTIGATE, app_state.prefs, "no_such_pb"
        )


# --------------------------------------------------------------------------- #
# Deterministic selection is UNCHANGED by the forced-run path
# --------------------------------------------------------------------------- #
def test_deterministic_selection_unchanged() -> None:
    cluster = cluster_from_events(
        EntityType.IP, "203.0.113.10",
        [make_raw_event(id=f"e{i}", ip="203.0.113.10", rule="mail_auth") for i in range(5)],
    )
    bf = Playbook(
        manifest=PlaybookManifest(
            id="mail_bruteforce", name="bf", priority=0,
            match=PlaybookMatch(rule_ids=["mail_auth", "waf_auth"], min_event_count=3),
        ),
        body="",
    )
    pb, reason = select_playbook(cluster, [bf])
    assert pb is bf
    assert "mail_auth" in reason


# --------------------------------------------------------------------------- #
# HTTP route — POST /api/cases/{id}/run-playbook
# --------------------------------------------------------------------------- #
def test_run_playbook_route(client) -> None:
    state: AppState = client.app.state.tlsoc
    pb = _inject_test_playbook(state, id_="zz_route_pb")
    # Keep the pipeline's registry pointer in sync with the injected playbook.
    state.pipeline._playbooks = state.playbooks

    ids = client.portal.call(partial(_seed, state, rule="modsec_sqli", ip="198.51.100.9", n=3))
    # Create a case via the investigate cluster path so it exists in the store.
    cluster = cluster_from_events(
        EntityType.IP, "198.51.100.9",
        [make_raw_event(id=i, ip="198.51.100.9", rule="modsec_sqli") for i in ids],
    )
    case = client.portal.call(
        partial(state.pipeline.investigate_cluster, cluster, SourceSurface.INVESTIGATE, state.prefs)
    )

    # Unknown playbook → 404.
    r404 = client.post(f"/api/cases/{case.case_id}/run-playbook", json={"playbook_id": "ghost"})
    assert r404.status_code == 404

    # Known playbook → 200; the forced playbook is recorded on the returned case.
    r = client.post(f"/api/cases/{case.case_id}/run-playbook", json={"playbook_id": pb.id})
    assert r.status_code == 200, r.text
    assert r.json()["playbook_id"] == pb.id

    # Unknown case → 404.
    assert client.post("/api/cases/nope/run-playbook", json={"playbook_id": pb.id}).status_code == 404
