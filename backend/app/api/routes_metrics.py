"""Richer security-posture + MITRE ATT&CK coverage metrics (Round 3 / Feature 5).

ADDITIVE endpoints — the existing ``GET /api/metrics`` (in the monolith router) is
untouched. These serve the rich, server-side rollup the posture dashboards consume:

* ``GET /api/metrics/posture`` — lifecycle (MTTA/MTTR/dwell p50/p90/mean), quality
  rates (alert-to-incident / FP / escalation / containment / automation), aging
  (buckets + oldest-N + queue depth + closure-vs-arrival), SLA attainment vs
  ``Preferences.sla``, all with optional period-over-period deltas.
* ``GET /api/mitre/coverage`` — per-tactic technique coverage vs the bundled corpus.
* ``GET /api/mitre/coverage/navigator.layer.json`` — an ATT&CK Navigator v4.5 layer
  dict the UI can hand straight to the Navigator.

Every value is DETERMINISTIC + advisory: nothing here is read by
``case_manager.decide()`` (#3). Technique ids from case data are VALIDATED + dropped
when invalid (#9 — handled in ``engine/mitre_coverage``); we return plain framework
data (the UI renders escaped). All GETs inherit ``require_auth`` from the mount and
also assert the narrow ``metrics:view`` grant. No non-GET routes.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends

from ..engine.metrics import posture_metrics
from ..engine.mitre_coverage import compute_mitre_coverage, navigator_layer
from ..state import AppState
from .deps import get_state, require_permission

logger = logging.getLogger("tlsoc.api.metrics")
router = APIRouter(prefix="/api")

# How many cases we pull from the store before time-bounding in the pure functions.
# A generous server-side bound (not a 200 client sample) so the posture rollup is
# computed over the whole recent case load, then window-filtered deterministically.
_STORE_FETCH_LIMIT = 5000


async def _load_cases(state: AppState) -> list:
    """Fetch the recent case set (newest first) for the posture/coverage rollups.

    Defensive: a store error degrades to an empty list rather than failing the
    request (a dashboard query must never 500 on a transient store hiccup)."""
    try:
        cases, _total = await state.cases.list(limit=_STORE_FETCH_LIMIT)
        return cases
    except Exception as exc:  # noqa: BLE001 — dashboards degrade, never fail hard
        logger.warning("posture/coverage case load soft-failed: %s", exc)
        return []


@router.get("/metrics/posture")
async def metrics_posture(
    window_hours: int = 24,
    compare: str = "",
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """The rich security-posture rollup over the last ``window_hours``.

    ``compare=prev`` adds period-over-period deltas vs the immediately-preceding
    equal-length window. SLA targets come from ``Preferences.sla`` (advisory; #3)."""
    cases = await _load_cases(state)
    sla_policy = getattr(state.prefs, "sla", None)
    return posture_metrics(
        cases,
        sla_policy=sla_policy,
        window_hours=max(0, int(window_hours)),
        compare=(compare or "").strip().lower(),
    )


@router.get("/mitre/coverage")
async def mitre_coverage(
    window_hours: int = 0,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Per-tactic MITRE ATT&CK technique coverage tallied from our case load against
    the bundled corpus. ``window_hours=0`` (default) covers ALL cases; a positive
    value time-bounds to created-within. Invalid/forged technique ids are dropped (#9).
    """
    cases = await _load_cases(state)
    if window_hours and window_hours > 0:
        from ..engine.metrics import _window_filter

        cases = _window_filter(cases, window_hours=int(window_hours))
    out = compute_mitre_coverage(cases)
    out["window_hours"] = int(window_hours) if window_hours and window_hours > 0 else 0
    return out


@router.get("/mitre/coverage/navigator.layer.json")
async def mitre_coverage_navigator(
    window_hours: int = 0,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Return an ATT&CK **Navigator v4.5** layer dict for the case coverage. Pure
    JSON the UI hands straight to the Navigator; invalid ids never appear (#9)."""
    cases = await _load_cases(state)
    wh = int(window_hours) if window_hours and window_hours > 0 else 0
    if wh > 0:
        from ..engine.metrics import _window_filter

        cases = _window_filter(cases, window_hours=wh)
    return navigator_layer(cases, window_hours=wh or None)
