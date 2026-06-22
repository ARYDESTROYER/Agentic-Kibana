"""All backend HTTP routes (the plugin contract)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import __version__
from ..config import Preferences, SourceInstance
from ..connectors.registry import get_registry
from ..constants import CaseStatus, DecisionBy, EntityType, IngestMode, SourceSurface, SourceType
from ..engine.correlation import cluster_from_events
from ..es.querybuilder import entity_query, ids_query, scope_filters, scope_must_not
from ..llm.pricing import models_by_provider
from ..models import ChatRequest, Cluster, InvestigateRequest, RawEvent, TraceStep, TriggerReason
from ..state import AppState
from ..utils import iso_now, relative_to_millis
from .deps import _bearer, get_state

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
# Connectors + multi-source configuration (vendor-agnostic ingest).
#
# The first-run wizard lists connectors (each with its auth/config field schema),
# the operator configures one or more SOURCES, tests the connection, and saves.
# --------------------------------------------------------------------------- #
class SourceUpsert(BaseModel):
    """Add or update a configured log source (a connector instance)."""

    id: str
    source_type: str
    display_name: str = ""
    enabled: bool = True
    ingest_mode: str | None = None       # defaults to the connector's first mode
    is_primary: bool = False
    config: dict[str, Any] = Field(default_factory=dict)


class ConnectorTestRequest(BaseModel):
    """Test a source's connectivity. With no body, tests the wired primary source."""

    source_type: str | None = None


@router.get("/connectors")
async def list_connectors(state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Every available connector + its wizard field schema (auth/config)."""
    reg = get_registry()
    return {"connectors": [m.model_dump(mode="json") for m in reg.manifests()]}


@router.get("/connectors/{source_type}")
async def get_connector(source_type: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    reg = get_registry()
    try:
        st = SourceType(source_type)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown source type: {source_type}") from exc
    manifest = reg.manifest(st)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"No connector for: {source_type}")
    return manifest.model_dump(mode="json")


@router.post("/connectors/test")
async def test_connector(
    body: ConnectorTestRequest, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Validate connectivity. Currently tests the live primary log source (the
    agent's read surface) — the wizard's 'Test connection' for the main source."""
    result = await state.log_source.test_connection(state.prefs)
    return result.model_dump(mode="json")


@router.get("/sources")
async def list_sources(state: AppState = Depends(get_state)) -> dict[str, Any]:
    return {"sources": [s.model_dump(mode="json") for s in state.prefs.sources]}


@router.post("/sources")
async def upsert_source(body: SourceUpsert, state: AppState = Depends(get_state)) -> dict[str, Any]:
    reg = get_registry()
    try:
        st = SourceType(body.source_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown source type: {body.source_type}") from exc
    manifest = reg.manifest(st)
    if manifest is None:
        raise HTTPException(status_code=400, detail=f"No connector for: {body.source_type}")

    if body.ingest_mode:
        try:
            mode = IngestMode(body.ingest_mode)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid ingest_mode: {body.ingest_mode}") from exc
    else:
        mode = manifest.ingest_modes[0] if manifest.ingest_modes else IngestMode.PULL

    instance = SourceInstance(
        id=body.id,
        source_type=st,
        display_name=body.display_name or manifest.display_name,
        enabled=body.enabled,
        ingest_mode=mode,
        is_primary=body.is_primary,
        config=body.config,
    )
    # Upsert by id; a new primary unsets any previous primary.
    others = [s for s in state.prefs.sources if s.id != body.id]
    if instance.is_primary:
        for s in others:
            s.is_primary = False
    prefs = state.prefs.model_copy(update={"sources": others + [instance]})
    await state.update_prefs(prefs)
    state.rebuild_log_source()
    return {"ok": True, "sources": [s.model_dump(mode="json") for s in prefs.sources]}


@router.delete("/sources/{source_id}")
async def delete_source(source_id: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    remaining = [s for s in state.prefs.sources if s.id != source_id]
    if len(remaining) == len(state.prefs.sources):
        raise HTTPException(status_code=404, detail="Source not found")
    prefs = state.prefs.model_copy(update={"sources": remaining})
    await state.update_prefs(prefs)
    state.rebuild_log_source()
    return {"ok": True, "sources": [s.model_dump(mode="json") for s in remaining]}


@router.post("/sources/{source_id}/secrets")
async def set_source_secrets(
    source_id: str, body: dict[str, str | None], state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Set/clear a source's secret fields (e.g. a webhook token, a Splunk key).

    Values go to the secret tier (in memory), NEVER to the persisted config; only
    the configured field NAMES are recorded on the SourceInstance (#10)."""
    src = next((s for s in state.prefs.sources if s.id == source_id), None)
    if src is None:
        raise HTTPException(status_code=404, detail="Source not found")
    for field, value in body.items():
        state.secrets.set_source_secret(source_id, field, value)
    configured = sorted(state.secrets.source_secrets(source_id).keys())
    updated = src.model_copy(update={"configured_secrets": configured})
    others = [s for s in state.prefs.sources if s.id != source_id]
    await state.update_prefs(state.prefs.model_copy(update={"sources": others + [updated]}))
    return {"ok": True, "configured_secrets": configured}


@router.post("/ingest/{source_id}")
async def ingest_push(
    source_id: str, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """HTTP push ingestion endpoint for a configured webhook/HEC source.

    A source/SIEM/EDR/SOAR POSTs alerts here; the matching receiver verifies auth,
    parses + normalises to OCSF, and the events flow into the SAME correlate→case
    pipeline the poller feeds. Per-source secrets (token/HMAC) are merged from the
    secret tier at call time (never persisted)."""
    src = next((s for s in state.prefs.sources if s.id == source_id and s.enabled), None)
    if src is None:
        raise HTTPException(status_code=404, detail="No enabled source with that id")
    reg = get_registry()
    cls = reg.get(src.source_type)
    if cls is None or not reg.is_receiver(src.source_type):
        raise HTTPException(status_code=400, detail="Source is not a push receiver")
    receiver = cls(config={**src.config, **state.secrets.source_secrets(source_id)}, connector_id=src.id)
    if not hasattr(receiver, "handle_request"):
        raise HTTPException(status_code=400, detail="Source is not an HTTP push receiver")
    body = await request.body()
    headers = {k: v for k, v in request.headers.items()}
    try:
        events = receiver.handle_request(body, headers, state.prefs)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    stats = await state.ingest_service.ingest(events, state.prefs)
    return {"ok": True, **stats}


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
# Agent personas (multi-agent roster) + plain-text runbooks — read-only catalog
# for the settings/console surfaces. Selection itself is deterministic in code.
# --------------------------------------------------------------------------- #
@router.get("/personas")
async def personas(state: AppState = Depends(get_state)) -> dict[str, Any]:
    from ..agents.personas import all_personas

    return {
        "enabled": state.prefs.personas.enabled,
        "personas": [
            {
                "id": p.id,
                "label": p.label,
                "specialization": p.specialization,
                "focus_tools": list(p.focus_tools),
                "keywords": list(p.keywords),
            }
            for p in all_personas()
        ],
    }


@router.get("/runbooks")
async def runbooks(state: AppState = Depends(get_state)) -> dict[str, Any]:
    from ..engine.runbooks import load_runbooks

    return {
        "enabled": state.prefs.runbooks.enabled,
        "runbooks": [
            {
                "id": rb.id,
                "title": rb.title,
                "summary": rb.summary,
                "persona": rb.persona,
                "applies_to_rules": list(rb.applies_to_rules),
                "applies_to_techniques": list(rb.applies_to_techniques),
            }
            for rb in load_runbooks()
        ],
    }


@router.get("/playbooks")
async def playbooks(state: AppState = Depends(get_state)) -> dict[str, Any]:
    pbs = state.playbooks.all()
    return {
        "enabled": state.prefs.playbooks.enabled,
        "count": len(pbs),
        "playbooks": [
            {
                "id": p.id,
                "name": p.name,
                "version": p.version,
                "description": p.manifest.description,
                "priority": p.manifest.priority,
                "match": {
                    "rule_ids": list(p.manifest.match.rule_ids),
                    "entity_types": list(p.manifest.match.entity_types),
                    "mitre": list(p.manifest.match.mitre),
                    "min_event_count": p.manifest.match.min_event_count,
                    "any_tags": list(p.manifest.match.any_tags),
                },
                "suggested_tools": list(p.manifest.suggested_tools),
                "rag_queries": list(p.manifest.rag_queries),
            }
            for p in pbs
        ],
    }


@router.post("/playbooks/reload")
async def playbooks_reload(state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Hot-reload playbooks from disk (atomic; a broken file never replaces a good
    live set). Returns the load summary."""
    return state.reload_playbooks()


@router.get("/playbooks/selection/{case_id}")
async def playbook_selection(case_id: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Why a given case selected the playbook it did (from the audit trail)."""
    case = await state.cases.get(case_id)
    reason = ""
    try:
        records = await state.audit.records_for_case(case_id)
        for r in records:
            actor = r.get("actor") if isinstance(r, dict) else getattr(r, "actor", "")
            if actor == "playbook_selector":
                reason = r.get("result_summary") if isinstance(r, dict) else getattr(r, "result_summary", "")
                break
    except Exception:  # noqa: BLE001 — explainability is best-effort
        reason = ""
    return {
        "case_id": case_id,
        "playbook_id": (case.playbook_id if case else ""),
        "reason": reason,
    }


# --------------------------------------------------------------------------- #
# Auth (Wave 2; OPTIONAL — the gate is a no-op when auth is disabled). The
# no-auth "old version" remains the default and fully available.
# --------------------------------------------------------------------------- #
class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/auth/login")
async def auth_login(
    body: LoginBody, response: Response, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    auth = state.auth
    if not auth.is_enabled:
        raise HTTPException(status_code=400, detail="authentication is disabled")
    token = auth.authenticate(body.username, body.password)
    if not token:
        raise HTTPException(status_code=401, detail="invalid credentials")
    response.set_cookie(
        "tlsoc_token", token, httponly=True, samesite="lax",
        secure=state.secrets.auth_cookie_secure,
        max_age=state.secrets.auth_token_hours * 3600,
    )
    return {"ok": True, "user": {"username": body.username}}


@router.get("/auth/me")
async def auth_me(request: Request, state: AppState = Depends(get_state)) -> dict[str, Any]:
    auth = state.auth
    if not auth.is_enabled:
        return {"enabled": False, "authenticated": False, "user": None}
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    user = auth.verify(token) if token else None
    return {
        "enabled": True,
        "authenticated": user is not None,
        "user": ({"username": user.username} if user else None),
    }


@router.post("/auth/logout")
async def auth_logout(response: Response, state: AppState = Depends(get_state)) -> dict[str, Any]:
    # Mirror the set_cookie attributes so the cookie is reliably cleared.
    response.delete_cookie("tlsoc_token", samesite="lax", secure=state.secrets.auth_cookie_secure)
    return {"ok": True}


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
    # On close / confirm-FP, index the resolved case as RAG baseline memory (C3-5)
    # so future investigations of similar entities learn from this decision + note.
    # Fail-safe: a RAG/embedding failure must NEVER break the analyst's action.
    if body.action in ("close", "confirm_fp"):
        try:
            await state.rag.index_resolved_case(case, note=body.note)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Resolved-case RAG index failed for %s: %s", case_id, exc)
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


@router.get("/cases/{case_id}/trace")
async def case_trace(case_id: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Ordered agent-pipeline trace for a case (C3-3).

    Projects the already-recorded ``tlsoc-agent-audit`` rows (router → investigator
    → tool calls → verdict → formatter → case-manager decision) into a timeline.
    Read-only on the management-scoped audit index. NEVER 404s — an unknown or
    not-yet-investigated case simply returns empty ``steps``. ``prompt_excerpt`` is
    omitted when ``prefs.trace.include_prompts`` is false."""
    rows = await state.audit.records_for_case(case_id)
    include_prompts = state.prefs.trace.include_prompts
    steps = [_trace_step(row, include_prompts) for row in rows]
    return {
        "case_id": case_id,
        "steps": [s.model_dump(mode="json") for s in steps],
        "total": len(steps),
    }


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


def _trace_step(row: dict[str, Any], include_prompts: bool) -> TraceStep:
    """Project a raw audit row into a TraceStep (C3-3). Honors the include_prompts
    toggle by dropping the (untrusted) prompt excerpt when disabled."""
    return TraceStep(
        ts=str(row.get("ts", "")),
        actor=str(row.get("actor", "")),
        action_type=row.get("action_type"),
        model=row.get("model"),
        query_text=row.get("query_text"),
        tool_name=row.get("tool_name"),
        tool_input=row.get("tool_input"),
        tool_output_summary=row.get("tool_output_summary"),
        result_summary=row.get("result_summary"),
        prompt_excerpt=(row.get("prompt_excerpt") if include_prompts else None),
    )
