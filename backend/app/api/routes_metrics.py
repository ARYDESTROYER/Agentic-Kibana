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

from fastapi import APIRouter, Depends, Query

from ..engine.clustering_explain import build_case_lineage
from ..engine.metrics import _window_filter, posture_metrics
from ..engine.mitre_coverage import compute_mitre_coverage, navigator_layer
from ..engine.noise_counters import build_noise_reduction
from ..state import AppState
from ..utils import iso_now
from .deps import get_state, require_permission

logger = logging.getLogger("tlsoc.api.metrics")
router = APIRouter(prefix="/api")

# How many cases we pull from the store before time-bounding in the pure functions.
# A generous server-side bound (not a 200 client sample) so the posture rollup is
# computed over up to the most-recent 5000 cases, then window-filtered
# deterministically. When the store holds MORE than this, the rollup is a partial
# (newest-N) view; the response carries a ``truncated``/``store_total``/``fetched``
# marker so a consumer can tell a lower-bound tally from a complete one rather than
# silently trusting a wrong number.
_STORE_FETCH_LIMIT = 5000


async def _load_cases(state: AppState) -> tuple[list, int]:
    """Fetch up to the most recent ``_STORE_FETCH_LIMIT`` cases (newest first) for the
    posture/coverage rollups, AND the store's reported total so the rollup can flag a
    truncated/partial result honestly instead of silently returning a number computed
    over only the newest N cases.

    Defensive: a store error degrades to an empty list (total 0) rather than failing
    the request (a dashboard query must never 500 on a transient store hiccup)."""
    try:
        cases, total = await state.cases.list(limit=_STORE_FETCH_LIMIT)
        return cases, int(total)
    except Exception as exc:  # noqa: BLE001 — dashboards degrade, never fail hard
        logger.warning("posture/coverage case load soft-failed: %s", exc)
        return [], 0


@router.get("/metrics/posture")
async def metrics_posture(
    window_hours: int = 24,
    compare: str = "",
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """The rich security-posture rollup over the last ``window_hours``, computed over
    up to the most-recent 5000 cases (the response's ``truncated`` flag is True when
    the store held more).

    ``compare=prev`` adds period-over-period deltas vs the immediately-preceding
    equal-length window. SLA targets come from ``Preferences.sla`` (advisory; #3)."""
    cases, store_total = await _load_cases(state)
    sla_policy = getattr(state.prefs, "sla", None)
    return posture_metrics(
        cases,
        sla_policy=sla_policy,
        window_hours=max(0, int(window_hours)),
        compare=(compare or "").strip().lower(),
        store_total=store_total,
    )


@router.get("/metrics/noise-reduction")
async def metrics_noise_reduction(
    window_hours: int = 24,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """The Noise-Reduction funnel over the last ``window_hours`` (default 24) — "total
    alerts by severity → what the AI reduced it to".

    ``ingested``/``clustered`` come from the DURABLE ``noise_counters`` store (raw-alert-by-
    severity, so they reflect the TRUE inbound volume even after low-value events are
    dropped at ingest); ``cases`` + the MECE outcomes (needs_human > escalated >
    auto_cleared > true_positive residual) come from a case tally computed over up to the
    most-recent 5000 cases (the ``cases_meta.truncated`` flag is True when the store held
    more — the outcome tallies are then a lower bound). When the counters are still warming
    up (``counters.available: false``) the ingested/clustered totals are ``null`` and the
    headline ``reduction.overall_pct`` is a DASH, so the UI degrades to a case-only funnel.

    DETERMINISTIC + advisory: nothing here is read by ``case_manager.decide()`` (#3); every
    band name is plain framework data the UI renders escaped."""
    cases, store_total = await _load_cases(state)
    wh = max(0, int(window_hours))
    try:
        counters = await state.noise_counters.read_window(wh)
    except Exception as exc:  # noqa: BLE001 — a counter glitch degrades to case-only funnel
        logger.warning("noise-reduction counter read soft-failed: %s", exc)
        counters = {"available": False}
    return build_noise_reduction(
        cases,
        counters,
        window_hours=wh,
        store_total=store_total,
        fetched_count=len(cases),
        prefs=getattr(state, "prefs", None),
        generated_at=iso_now(),
    )


@router.get("/metrics/noise-reduction/lineage")
async def metrics_noise_reduction_lineage(
    window_hours: int = 24,
    limit: int = Query(default=12, ge=1, le=25),
    state: AppState = Depends(get_state),
    _metrics_permission=Depends(require_permission("metrics", "view")),
    _cases_permission=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Bounded redacted alert → cluster → case → outcome lineages.

    This lazy drill-down complements the aggregate Noise Reduction endpoint.  It
    reuses the persisted Threat Context clustering projection, returns only the
    newest ``limit`` cases in the selected window, and never returns raw alert ids
    or payloads.  A store-page cap is reported explicitly so the Console cannot
    imply that a bounded sample represents every historical case.

    Read-only/advisory: no correlation is re-run and no value here participates in
    risk scoring or the deterministic close/escalate decision (#3).
    """
    cases, store_total = await _load_cases(state)
    wh = max(0, int(window_hours))
    window_cases = _window_filter(cases, window_hours=wh)
    rows = [build_case_lineage(case) for case in window_cases[:limit]]
    store_truncated = store_total > len(cases)
    return {
        "window_hours": wh,
        "generated_at": iso_now(),
        "rows": rows,
        "meta": {
            "returned": len(rows),
            # This is deliberately named as a count inside the fetched store page:
            # when the store itself was truncated, it is only a lower bound.
            "window_cases_in_fetched_page": len(window_cases),
            "fetched_cases": len(cases),
            "store_total": store_total,
            "limit": limit,
            "truncated": len(window_cases) > limit or store_truncated,
            "store_truncated": store_truncated,
        },
        "limitations": (
            "Rows are a bounded newest-case sample. Alert references are stable one-way "
            "identifiers for persisted case inputs; raw alerts and alerts that never formed "
            "a case are represented only by the aggregate counters."
        ),
    }


@router.get("/mitre/coverage")
async def mitre_coverage(
    window_hours: int = 0,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Per-tactic MITRE ATT&CK technique coverage tallied from our case load against
    the bundled corpus, over up to the most-recent 5000 cases (the response's
    ``truncated`` flag is True when the store held more — the covered tally is then a
    lower bound). ``window_hours=0`` (default) covers ALL fetched cases; a positive
    value time-bounds to created-within. Invalid/forged technique ids are dropped (#9).
    """
    cases, store_total = await _load_cases(state)
    fetched_count = len(cases)  # rows pulled from the store, BEFORE window-filtering
    if window_hours and window_hours > 0:
        from ..engine.metrics import _window_filter

        cases = _window_filter(cases, window_hours=int(window_hours))
    out = compute_mitre_coverage(cases, store_total=store_total, fetched_count=fetched_count)
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
    cases, store_total = await _load_cases(state)
    fetched_count = len(cases)  # rows pulled from the store, BEFORE window-filtering
    wh = int(window_hours) if window_hours and window_hours > 0 else 0
    if wh > 0:
        from ..engine.metrics import _window_filter

        cases = _window_filter(cases, window_hours=wh)
    return navigator_layer(
        cases, window_hours=wh or None, store_total=store_total, fetched_count=fetched_count
    )
