"""Cross-case CAMPAIGN routes (Round 4, Wave 4).

READ-ONLY surfaces over the campaign list the deterministic clustering pass
(:mod:`app.engine.campaigns`) produces, plus a manual re-correlate trigger:

* ``GET  /api/campaigns``               — the running campaign list (newest first),
                                          each with its member case ids / entities /
                                          MITRE / severity rollup.
* ``GET  /api/campaigns/{id}``          — one campaign (404 when absent).
* ``GET  /api/cases/{id}/campaign``     — the campaign a case belongs to, or ``null``.
* ``POST /api/campaigns/recorrelate``   — trigger the deterministic pass ON DEMAND;
                                          returns the freshly-built campaigns. It is a
                                          READ-TIME AGGREGATOR — it NEVER investigates,
                                          mutates a case, closes/escalates one, or
                                          touches a ``cluster_signature``.

A SEPARATE router module (the integrator mounts it with the SAME ``require_auth``
mount the monolith uses). The GET routes gate on ``cases:read``; the non-GET
re-correlate gates on ``cases:read`` too — but see below: it is a state-changer in the
route-auth-coverage sense (non-GET), so it ALSO carries an explicit ``require_admin``
authZ dependency (a manual, tenant-wide re-correlate is an operator action).

⛔ NON-NEGOTIABLE #3: nothing here imports ``case_manager`` / calls ``decide()``. A
campaign is ADVISORY — it can never close or escalate a member case; a NEEDS_HUMAN
case that joins a campaign stays NEEDS_HUMAN.

⛔ NON-NEGOTIABLE #4: a campaign only REFERENCES ``case_ids`` and never recomputes /
mutates a case's ``cluster_signature``; re-correlating does not touch any case.

⛔ NON-NEGOTIABLE #9: every entity ``value`` / MITRE id / campaign name returned here
is source-derived PLAIN DATA — the UI render-escapes it and it is never interpolated
into a prompt. Values are returned as plain, length-bounded strings.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..constants import ActionType
from ..models import Campaign
from ..state import AppState
from .deps import current_username, get_state, require_admin, require_permission

logger = logging.getLogger("tlsoc.api.campaigns")

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# Helpers — plain-data serialisation (#9)
# --------------------------------------------------------------------------- #
def _safe(value: Any) -> str:
    """Return ``value`` as a plain, length-bounded string for the client (#9): the UI
    renders it escaped and it is never fed back into a prompt. Bounds a runaway,
    source-influenceable string so a hostile upstream can't blow up the response."""
    return str(value)[:2000]


def _campaign_json(campaign: Campaign) -> dict[str, Any]:
    """One campaign as a plain, #9-fenced dict.

    Entity ``value``s + MITRE ids + the display name are source-derived — each is
    coerced to a bounded plain string so nothing attacker-influenceable is echoed
    raw. Numeric/id fields pass through; ``case_ids`` are plain ids."""
    return {
        "id": _safe(campaign.id),
        "name": _safe(campaign.name),
        "status": str(getattr(campaign.status, "value", campaign.status)),
        "case_ids": [_safe(cid) for cid in campaign.case_ids],
        "case_count": len(campaign.case_ids),
        "entities": [
            {"entity_type": _safe(e.entity_type), "value": _safe(e.value)}
            for e in campaign.entities
        ],
        "mitre": [_safe(t) for t in campaign.mitre],
        "severity_rollup": _safe(campaign.severity_rollup) if campaign.severity_rollup else None,
        "first_seen": campaign.first_seen,
        "last_seen": campaign.last_seen,
        "created_at": campaign.created_at,
    }


# --------------------------------------------------------------------------- #
# GET /api/campaigns — the running campaign list (newest first)
# --------------------------------------------------------------------------- #
@router.get("/campaigns")
async def list_campaigns(
    status: str | None = None,
    limit: int = 0,
    offset: int = 0,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """The persisted campaign list, newest first (by ``last_seen`` then created).

    ``status`` filters by :class:`app.constants.CampaignStatus` value; ``limit`` (>0) /
    ``offset`` page. NEVER raises — a store glitch degrades to an empty list. Advisory,
    read-only (#3/#4)."""
    try:
        campaigns, total = await state.campaign_store.list(
            status=status, limit=max(int(limit), 0), offset=max(int(offset), 0),
        )
    except Exception as exc:  # noqa: BLE001 — campaigns are best-effort
        logger.warning("campaign list failed (%s); returning empty", exc)
        campaigns, total = [], 0
    return {
        "campaigns": [_campaign_json(c) for c in campaigns],
        "total": total,
        "enabled": bool(getattr(getattr(state.prefs, "campaign", None), "enabled", False)),
    }


# --------------------------------------------------------------------------- #
# GET /api/campaigns/{id} — one campaign + its member rollups
# --------------------------------------------------------------------------- #
@router.get("/campaigns/{campaign_id}")
async def get_campaign(
    campaign_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """One campaign by its (content-hash) id — its member case ids, shared entities,
    MITRE union and severity rollup. 404 when absent. Read-only advisory (#3/#4)."""
    try:
        campaign = await state.campaign_store.get(campaign_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("campaign get failed (%s)", exc)
        campaign = None
    if campaign is None:
        raise HTTPException(status_code=404, detail="campaign not found")
    return {"campaign": _campaign_json(campaign)}


# --------------------------------------------------------------------------- #
# GET /api/cases/{id}/campaign — the campaign a case belongs to (or null)
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/campaign")
async def case_campaign(
    case_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """The campaign this case is a member of, or ``null`` when it belongs to none.

    Scans the persisted campaign list for one whose ``case_ids`` contains this case —
    a case belongs to at most one campaign (a connected component is disjoint). NEVER
    404s: an unknown / uncampaigned case returns ``{"campaign": null}``. Read-only."""
    cid = (case_id or "").strip()
    try:
        campaigns, _total = await state.campaign_store.list()
    except Exception as exc:  # noqa: BLE001
        logger.warning("case-campaign lookup failed (%s)", exc)
        campaigns = []
    match = next((c for c in campaigns if cid and cid in c.case_ids), None)
    return {"case_id": _safe(cid), "campaign": _campaign_json(match) if match else None}


# --------------------------------------------------------------------------- #
# POST /api/campaigns/recorrelate — trigger the deterministic pass on demand
# --------------------------------------------------------------------------- #
@router.post("/campaigns/recorrelate")
async def recorrelate_campaigns(
    request: Request,
    state: AppState = Depends(get_state),
    _perm=Depends(require_permission("cases", "read")),
    _admin=Depends(require_admin),
) -> dict[str, Any]:
    """Run the deterministic cross-case CAMPAIGN pass NOW and return the campaigns.

    Pages the trailing window of already-persisted CASES, clusters them (shared
    cross-source entity OR MITRE, connected-component ≥2 with a shared entity),
    UPSERTS the result into ``campaign_store`` (idempotent — same members → same id),
    and returns them. It NEVER investigates a case, calls an LLM (#6), touches a
    ``cluster_signature`` (#4), or calls ``decide()`` (#3) — a case's status is
    untouched. Admin-gated (a tenant-wide manual re-correlate is an operator action);
    audited (#2). NEVER raises — a store glitch degrades to an empty result."""
    try:
        campaigns = await state.campaign_correlator(None, state.prefs)
    except Exception as exc:  # noqa: BLE001 — best-effort; degrade to empty
        logger.warning("campaign recorrelate failed (%s); returning empty", exc)
        campaigns = []
    stored: list[Campaign] = list(campaigns or [])
    try:
        if stored:
            stored = await state.campaign_store.upsert_many(stored)
    except Exception as exc:  # noqa: BLE001 — persistence is best-effort
        logger.warning("campaign upsert failed (%s)", exc)
    await _audit(
        state, request, "campaigns_recorrelate",
        f"built {len(stored)} campaign(s) over {sum(len(c.case_ids) for c in stored)} case-links",
    )
    return {"ok": True, "count": len(stored), "campaigns": [_campaign_json(c) for c in stored]}


# --------------------------------------------------------------------------- #
# Audit helper (#2 — append-only)
# --------------------------------------------------------------------------- #
async def _audit(state: AppState, request: Request, event: str, detail: str) -> None:
    """Append-only audit of an operator campaign action (#2). Best-effort.

    Uses ``USER_MGMT`` with ``surface="campaigns"`` — constants are frozen this wave so
    no new ActionType is introduced. The actor is the authenticated username when
    present. NEVER raises."""
    audit = getattr(state, "audit", None)
    if audit is None:
        return
    try:
        actor = current_username(request) or ""
    except Exception:  # noqa: BLE001 — no resolvable principal; audit anonymously
        actor = ""
    try:
        await audit.record(
            action_type=ActionType.USER_MGMT,
            surface="campaigns",
            actor=actor,
            result_summary=f"{event}: {detail}"[:500],
        )
    except Exception:  # noqa: BLE001
        pass
