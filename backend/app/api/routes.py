"""All backend HTTP routes (the plugin contract)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import __version__
from ..config import Preferences
from ..constants import CaseStatus, DecisionBy, EntityType, SourceSurface
from ..engine.correlation import cluster_from_events
from ..es.querybuilder import entity_query, ids_query, scope_filters, scope_must_not
from ..llm.pricing import models_by_provider
from ..models import ChatRequest, Cluster, InvestigateRequest, RawEvent, TriggerReason
from ..state import AppState
from ..utils import iso_now, relative_to_millis
from .deps import get_state

logger = logging.getLogger("tlsoc.api")
router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@router.get("/health")
async def health(state: AppState = Depends(get_state)) -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "es_connected": await state.es.ping(),
        "store_type": type(state.es).__name__,
        "setup_complete": state.prefs.setup_complete,
    }


# --------------------------------------------------------------------------- #
# Setup wizard
# --------------------------------------------------------------------------- #
class SecretsUpdate(BaseModel):
    es_api_key: str | None = None
    es_mgmt_api_key: str | None = None
    es_url: str | None = None
    es_ca_cert: str | None = None
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    abuseipdb_api_key: str | None = None
    virustotal_api_key: str | None = None
    embedding_api_key: str | None = None


@router.get("/setup/status")
async def setup_status(state: AppState = Depends(get_state)) -> dict[str, Any]:
    p = state.prefs
    return {
        "setup_complete": p.setup_complete,
        "configured": state.secrets.configured_status(),
        "data_view_pattern": p.data_view_pattern,
        "entity_mapping": {
            "source_ip_field": p.source_ip_field,
            "user_field": p.user_field,
            "host_field": p.host_field,
        },
        "es_connected": await state.es.ping(),
    }


@router.post("/setup/secrets")
async def setup_secrets(body: SecretsUpdate, state: AppState = Depends(get_state)) -> dict[str, Any]:
    # exclude_unset (not exclude_none) so an explicit null can CLEAR/revoke a key.
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No secret values provided")
    await state.apply_secrets(updates)
    return {"ok": True, "configured": state.secrets.configured_status()}


@router.post("/setup/complete")
async def setup_complete(state: AppState = Depends(get_state)) -> dict[str, Any]:
    prefs = state.prefs.model_copy(update={"setup_complete": True})
    await state.update_prefs(prefs)
    if prefs.polling_enabled:
        state.poller.start()
    return {"ok": True, "setup_complete": True}


# --------------------------------------------------------------------------- #
# Settings (Surface 5)
# --------------------------------------------------------------------------- #
@router.get("/settings")
async def get_settings(state: AppState = Depends(get_state)) -> dict[str, Any]:
    return {
        "prefs": state.prefs.model_dump(mode="json"),
        "configured": state.secrets.configured_status(),
        "read_only": state.prefs.read_only_settings_mode,
    }


@router.put("/settings")
async def put_settings(body: dict[str, Any], state: AppState = Depends(get_state)) -> dict[str, Any]:
    if state.prefs.read_only_settings_mode and body.get("read_only_settings_mode") is not False:
        raise HTTPException(status_code=403, detail="Settings are in read-only mode")
    merged = _deep_update(state.prefs.model_dump(mode="json"), body)
    try:
        prefs = Preferences.model_validate(merged)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Invalid settings: {exc}") from exc
    await state.update_prefs(prefs)
    if prefs.setup_complete and prefs.polling_enabled and not prefs.caps.kill_switch:
        state.poller.start()
    return {"ok": True, "prefs": prefs.model_dump(mode="json")}


# --------------------------------------------------------------------------- #
# Chat (Surface 1 + Surface 2 follow-up — one engine)
# --------------------------------------------------------------------------- #
@router.post("/chat")
async def chat(body: ChatRequest, state: AppState = Depends(get_state)) -> dict[str, Any]:
    resp = await state.chat_engine.chat(
        body.message, state.prefs, case_id=body.case_id, history=body.history,
        context=body.context,
    )
    return resp.model_dump(mode="json")


# --------------------------------------------------------------------------- #
# Investigate (Surface 2)
# --------------------------------------------------------------------------- #
@router.post("/investigate")
async def investigate(body: InvestigateRequest, state: AppState = Depends(get_state)) -> dict[str, Any]:
    cluster, widest = await _cluster_for_request(state, body)
    if cluster is None:
        # NEUTRAL, specific detail so the FE shows an empty-state, not a scary error.
        detail = _no_events_detail(body, widest)
        raise HTTPException(status_code=400, detail=detail)
    case = await state.pipeline.investigate_cluster(cluster, body.source_surface, state.prefs)
    return case.model_dump(mode="json")


# --------------------------------------------------------------------------- #
# Per-log AI overview (Feature 2) — single-event, cost-gated, read-only
# --------------------------------------------------------------------------- #
class OverviewRequest(BaseModel):
    source: dict[str, Any] = Field(default_factory=dict)
    index: str | None = None
    id: str | None = None
    data_view: str | None = None


@router.post("/overview")
async def overview(body: OverviewRequest, state: AppState = Depends(get_state)) -> dict[str, Any]:
    if not body.source:
        raise HTTPException(status_code=400, detail="No event source provided")
    return await state.overview_service.overview(
        body.source, state.prefs, index=body.index, id=body.id, data_view=body.data_view
    )


# --------------------------------------------------------------------------- #
# Model catalog (Feature 4) — for the settings per-role model pickers
# --------------------------------------------------------------------------- #
@router.get("/models")
async def models(state: AppState = Depends(get_state)) -> dict[str, Any]:
    return {"providers": models_by_provider(), "configured": state.secrets.configured_status()}


# --------------------------------------------------------------------------- #
# Cases
# --------------------------------------------------------------------------- #
@router.get("/cases")
async def list_cases(
    status: str | None = None,
    surface: str | None = None,
    entity: str | None = None,
    limit: int = 50,
    offset: int = 0,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    cases, total = await state.cases.list(
        status=status, source_surface=surface, entity_value=entity,
        limit=min(limit, 200), offset=offset,
    )
    return {"cases": [c.model_dump(mode="json") for c in cases], "total": total}


@router.get("/cases/{case_id}")
async def get_case(case_id: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    return case.model_dump(mode="json")


class CaseAction(BaseModel):
    action: str  # close | reopen | escalate | confirm_fp | acknowledge
    note: str = ""
    analyst: str = "analyst"


@router.post("/cases/{case_id}/action")
async def case_action(
    case_id: str, body: CaseAction, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    mapping = {
        "close": CaseStatus.CLOSED,
        "confirm_fp": CaseStatus.CLOSED,
        "reopen": CaseStatus.OPEN,
        "escalate": CaseStatus.NEEDS_HUMAN,
        "acknowledge": case.status,
    }
    if body.action not in mapping:
        raise HTTPException(status_code=400, detail=f"Unknown action: {body.action}")
    case.status = mapping[body.action]
    case.decision_by = DecisionBy.ANALYST
    case.updated_at = iso_now()
    case.history.append({
        "ts": case.updated_at, "event": "analyst_action", "action": body.action,
        "analyst": body.analyst, "note": body.note,
    })
    await state.cases.save(case)
    return case.model_dump(mode="json")


@router.post("/cases/{case_id}/investigate")
async def case_investigate(case_id: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Human-triggered (re-)investigation of a stored case (C3-4).

    Rebuilds the cluster from the case — preferring an exact id-based re-query,
    falling back to a config-windowed entity re-query — then re-runs the SAME
    shared pipeline with ``force=True`` so an already-investigated OPEN case is
    re-investigated in place. The case's ORIGINAL provenance (``source_surface`` /
    ``origin_surface``) is preserved by the pipeline, so an automated-scan case
    stays in the Automated Scans tab. Returns a NEUTRAL 400 if no events remain
    (the cluster aged out of the configured window).
    """
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    cluster = await _cluster_for_case(state, case)
    if cluster is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"No events remain for {case.entity.type.value} {case.entity.value} "
                f"in the last {state.prefs.investigate_lookback}; the activity may have "
                "aged out of the retained log window."
            ),
        )
    # force=True so an already-investigated OPEN case is genuinely re-investigated.
    updated = await state.pipeline.investigate_cluster(
        cluster, case.source_surface, state.prefs, force=True
    )
    return updated.model_dump(mode="json")


# --------------------------------------------------------------------------- #
# Automated scans (Surface 3)
# --------------------------------------------------------------------------- #
@router.get("/scans")
async def scans(limit: int = 50, state: AppState = Depends(get_state)) -> dict[str, Any]:
    cases, total = await state.cases.list_scans(limit=min(limit, 200))
    return {"cases": [c.model_dump(mode="json") for c in cases], "total": total}


@router.get("/scans/notifications")
async def scan_notifications(
    since: str = "now-24h", state: AppState = Depends(get_state)
) -> dict[str, Any]:
    since_iso = _millis_to_iso(relative_to_millis(since))
    new_count = await state.cases.count_new_scans(since_iso)
    return {"new_count": new_count, "since": since_iso, "now": iso_now()}


# --------------------------------------------------------------------------- #
# Standup (Surface 4)
# --------------------------------------------------------------------------- #
@router.get("/standup")
async def standup(
    window_hours: int | None = None, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    if not state.prefs.standup.enabled:
        return {"enabled": False, "summary": "Standup is disabled in settings.", "aggregate": {}}
    result = await state.standup_service.generate(state.prefs, window_hours=window_hours)
    result["enabled"] = True
    return result


# --------------------------------------------------------------------------- #
# Cost / usage (in-plugin panel)
# --------------------------------------------------------------------------- #
@router.get("/usage/summary")
async def usage_summary(
    window_hours: int = 24, case_id: str | None = None, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    return await state.usage_store.summary(window_hours=window_hours, case_id=case_id)


# --------------------------------------------------------------------------- #
# Manual poll trigger (demo / ops)
# --------------------------------------------------------------------------- #
@router.post("/poll")
async def poll_now(state: AppState = Depends(get_state)) -> dict[str, Any]:
    return await state.poller.poll_once(state.prefs)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _deep_update(dst: dict[str, Any], src: dict[str, Any]) -> dict[str, Any]:
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            dst[key] = _deep_update(dst[key], value)
        else:
            dst[key] = value
    return dst


def _millis_to_iso(millis: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(millis / 1000.0, tz=timezone.utc).isoformat()


# Auto-widen ladder (BUG-2): increasing windows tried IN ORDER on 0 hits. The
# configured/requested start window is always tried first; ladder rungs narrower
# than the start are skipped so we never shrink the search below what was asked.
# ``now-365d`` is the ~1-year widest rung (the relative-time parser supports
# s/m/h/d/w, not a ``y`` unit, so a year is expressed in days).
_WIDEN_LADDER = ("now-7d", "now-30d", "now-365d")


def _entity_field(prefs: Preferences, entity_type: EntityType) -> str:
    return {
        EntityType.IP: prefs.source_ip_field,
        EntityType.USER: prefs.user_field,
        EntityType.HOST: prefs.host_field,
    }[entity_type]


def _scoped_entity_body(prefs: Preferences, field: str, value: str, from_millis: int) -> dict[str, Any]:
    """Entity query with the SAME scope + suppression filters the poller uses, so a
    manual investigation never pulls out-of-scope or suppressed events."""
    body = entity_query(
        prefs, field, value, from_millis=from_millis, size=200,
        extra_filters=scope_filters(prefs),
    )
    must_not = scope_must_not(prefs)
    if must_not:
        body["query"]["bool"]["must_not"] = must_not
    return body


def _widen_windows(start_window: str) -> list[str]:
    """Ordered windows to try: the configured/requested start, then each ladder
    rung that is WIDER than (i.e. reaches further back than) the start."""
    windows = [start_window]
    start_ms = relative_to_millis(start_window)
    for rung in _WIDEN_LADDER:
        # A wider window resolves to an EARLIER epoch (further in the past).
        if relative_to_millis(rung) < start_ms:
            windows.append(rung)
    return windows


async def _entity_events_widening(
    state: AppState, entity_type: EntityType, value: str, start_window: str
) -> tuple[list[RawEvent], str]:
    """Fetch an entity's in-scope events, auto-widening the lookback on 0 hits.

    Returns (events, widest_window_tried). Stops at the first window that yields
    events; if all are empty the events list is empty and widest_window_tried is
    the broadest window attempted."""
    prefs = state.prefs
    field = _entity_field(prefs, entity_type)
    windows = _widen_windows(start_window)
    widest = windows[-1]
    for window in windows:
        body = _scoped_entity_body(prefs, field, value, relative_to_millis(window))
        resp = await state.es.search_logs(prefs.data_view_pattern, body)
        hits = resp.get("hits", {}).get("hits", [])
        events = [RawEvent.from_hit(h, prefs) for h in hits]
        if events:
            return events, window
    return [], widest


async def _cluster_for_request(
    state: AppState, req: InvestigateRequest
) -> tuple[Cluster | None, str]:
    """Resolve an InvestigateRequest to a Cluster (with a synthesized manual
    TriggerReason). Returns (cluster_or_None, widest_window_tried)."""
    prefs = state.prefs
    start_window = req.lookback or prefs.investigate_lookback

    if req.event_ids:
        resp = await state.es.search_logs(
            prefs.data_view_pattern, ids_query(req.event_ids, size=len(req.event_ids))
        )
        hits = resp.get("hits", {}).get("hits", [])
        events = [RawEvent.from_hit(h, prefs) for h in hits]
        if not events:
            return None, start_window
        entity_type = req.group_by
        value = events[0].entity_value(entity_type)
        if not value:
            return None, start_window
        members = [e for e in events if e.entity_value(entity_type) == value] or events
        window = start_window
    elif req.entity:
        entity_type, value = req.entity.type, req.entity.value
        events, window = await _entity_events_widening(state, entity_type, value, start_window)
        if not events:
            return None, window
        members = [e for e in events if e.entity_value(entity_type) == value] or events
    else:
        return None, start_window

    cluster = cluster_from_events(entity_type, value, members)
    cluster.trigger_reason = _manual_trigger_reason(cluster, window)
    return cluster, window


async def _cluster_for_case(state: AppState, case) -> Cluster | None:
    """Rebuild a cluster from a stored case for a human-triggered re-investigation.

    Prefers an exact id-based re-query of the case's member events; falls back to a
    config-windowed (``prefs.investigate_lookback``) entity re-query using the same
    scope filters as the manual investigate path. Read-only on the log surface.

    The original deterministic trigger reason (if the case has one) is PRESERVED so
    a re-investigate never overwrites a scan-derived "Why this fired"; only a case
    lacking one gets a synthesized MANUAL trigger reason."""
    prefs = state.prefs
    entity_type, value = case.entity.type, case.entity.value
    has_trigger = case.trigger_reason is not None

    def _finalize(cluster: Cluster, window: str) -> Cluster:
        # Only synthesize a manual reason when the case lacks one; otherwise leave
        # the cluster's reason None so the pipeline's _trigger() keeps the existing.
        if not has_trigger:
            cluster.trigger_reason = _manual_trigger_reason(cluster, window)
        else:
            cluster.trigger_reason = None
        return cluster

    # Preferred: re-fetch the exact member events by id (read-only).
    if case.member_event_ids:
        resp = await state.es.search_logs(
            prefs.data_view_pattern,
            ids_query(case.member_event_ids, size=len(case.member_event_ids)),
        )
        hits = resp.get("hits", {}).get("hits", [])
        events = [RawEvent.from_hit(h, prefs) for h in hits]
        members = [e for e in events if e.entity_value(entity_type) == value] or events
        if members:
            cluster = cluster_from_events(entity_type, value, members)
            return _finalize(cluster, prefs.investigate_lookback)

    # Fallback: re-query the entity over the configured window (with auto-widen).
    events, window = await _entity_events_widening(
        state, entity_type, value, prefs.investigate_lookback
    )
    if not events:
        return None
    members = [e for e in events if e.entity_value(entity_type) == value] or events
    cluster = cluster_from_events(entity_type, value, members)
    return _finalize(cluster, window)


def _manual_trigger_reason(cluster: Cluster, window: str) -> TriggerReason:
    """Synthesize a MANUAL TriggerReason so "Why this fired" renders for manually
    investigated cases (Feature 3 / IMPROVEMENT). Mode is ``manual``; structured
    fields are filled from the resolved cluster."""
    entity_type = cluster.entity.type.value
    entity_value = cluster.entity.value
    n = cluster.count
    rules = ", ".join(cluster.rule_values) or "no specific rule"
    sentence = (
        f"Manually investigated: {n} event{'s' if n != 1 else ''} for "
        f"{entity_type} {entity_value} in the last {window} across rules [{rules}]"
    )
    return TriggerReason(
        rule_value=(cluster.rule_values[0] if cluster.rule_values else ""),
        mode="manual",
        n=n,
        window_seconds=0,
        group_by=entity_type,
        observed_count=n,
        window_start=cluster.first_seen_millis,
        window_end=cluster.last_seen_millis,
        entity=f"{entity_type}:{entity_value}",
        rule_values=list(cluster.rule_values),
        sentence=sentence,
    )


def _no_events_detail(req: InvestigateRequest, widest: str) -> str:
    """NEUTRAL, specific 400 detail for an empty manual investigation."""
    if req.entity:
        return (
            f"No events found for {req.entity.type.value} {req.entity.value} "
            f"in the last {widest}"
        )
    if req.event_ids:
        return "No events found for the selected document ids"
    return "Could not resolve events for this request"
