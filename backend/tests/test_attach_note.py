"""Cycle-2 NOTE: an automated attach surfaces trigger_reason on a non-scan case."""

from __future__ import annotations

from app.constants import CaseStatus, EntityType, SourceSurface
from app.engine.correlation import cluster_from_events
from app.models import Case, Entity, TriggerReason

from tests.conftest import make_raw_event


async def test_attach_surfaces_trigger_reason_on_manual_case(app_state):
    state = app_state
    # A case opened MANUALLY (origin_surface=investigate) with NO trigger_reason —
    # exactly the live situation where "Why this fired" never rendered.
    case = Case(
        case_id="m1",
        cluster_signature="sig:m1",
        source_surface=SourceSurface.INVESTIGATE,
        origin_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.77"),
        member_event_ids=["e1"],
        status=CaseStatus.OPEN,
        trigger_reason=None,
    )
    await state.cases.save(case)

    # An automated burst cluster (with a deterministic trigger_reason) attaches.
    cluster = cluster_from_events(
        EntityType.IP, "203.0.113.77", [make_raw_event(id="e2", ip="203.0.113.77")]
    )
    cluster.trigger_reason = TriggerReason(
        rule_value="waf-nginx-access", mode="threshold",
        sentence="5 'waf-nginx-access' events from ip 203.0.113.77 within 120s",
    )
    await state.poller._attach(case, cluster)

    updated = await state.cases.get("m1")
    assert updated is not None
    assert "e2" in updated.member_event_ids
    assert updated.trigger_reason is not None
    assert updated.trigger_reason.sentence.startswith("5 'waf-nginx-access'")


async def test_attach_does_not_overwrite_existing_trigger_reason(app_state):
    state = app_state
    case = Case(
        case_id="m2",
        cluster_signature="sig:m2",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        origin_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.9"),
        member_event_ids=["a1"],
        status=CaseStatus.OPEN,
        trigger_reason=TriggerReason(sentence="ORIGINAL reason", rule_value="modsec_xss"),
    )
    await state.cases.save(case)

    cluster = cluster_from_events(
        EntityType.IP, "198.51.100.9", [make_raw_event(id="a2", ip="198.51.100.9")]
    )
    cluster.trigger_reason = TriggerReason(sentence="NEW reason", rule_value="waf_auth")
    await state.poller._attach(case, cluster)

    updated = await state.cases.get("m2")
    assert updated.trigger_reason.sentence == "ORIGINAL reason"  # preserved, not clobbered
    assert "a2" in updated.member_event_ids


async def test_attach_idempotent_no_new_events(app_state):
    state = app_state
    case = Case(
        case_id="m3",
        cluster_signature="sig:m3",
        source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.80"),
        member_event_ids=["x1"],
        status=CaseStatus.OPEN,
        trigger_reason=None,
    )
    await state.cases.save(case)
    # A cluster whose only member is already attached → no-op, trigger stays None.
    cluster = cluster_from_events(
        EntityType.IP, "203.0.113.80", [make_raw_event(id="x1", ip="203.0.113.80")]
    )
    cluster.trigger_reason = TriggerReason(sentence="should not apply")
    await state.poller._attach(case, cluster)
    updated = await state.cases.get("m3")
    assert updated.trigger_reason is None  # nothing new attached → unchanged
