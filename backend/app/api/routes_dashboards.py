"""Custom-dashboard persistence routes — Round 5 / G7 (custom dashboards, CD5).

A SEPARATE feature router (auto-mounted by the integrator with the same
``require_auth`` gate the monolith uses) that surfaces the per-user custom-dashboard
store (:class:`app.stores.dashboards.DashboardStore`) to an operator:

* ``GET    /api/dashboards``            — the caller's saved custom dashboards.
* ``POST   /api/dashboards``            — create (or replace by id) one dashboard.
* ``PUT    /api/dashboards/{id}``       — replace one dashboard (id from the path).
* ``DELETE /api/dashboards/{id}``       — drop one dashboard.
* ``POST   /api/dashboards/{id}/clone`` — copy an existing dashboard (or an org/role
                                          default) into the caller's PERSONAL set with
                                          a fresh id (clone-to-customize on first edit).

Everything is scoped to the AUTHENTICATED principal (``current_username`` → the shared
``default`` bucket when auth is OFF), so one user can never read or mutate another's
dashboards — the store keys every read/write on the normalised username.

⚠ NON-NEGOTIABLES held here:

* **#3** — a dashboard is ADVISORY presentation state only. NOTHING in this router
  imports or calls ``case_manager.decide()``; a layout never feeds the deterministic
  decision, never touches a case/verdict/signature.
* **#9** — every dashboard ``name`` and widget ``type``/``options`` value is UNTRUSTED,
  attacker-influenceable data. On every write we (a) ALLOWLIST-validate each widget
  ``type`` against the known ``WidgetType`` registry set — an unknown type is a hard
  400, never silently stored; (b) reject a ``name`` carrying control characters or over
  the length bound; and (c) clamp all grid coords into the 12-column grid. Names are
  returned as plain strings the UI render-escapes; they are never fed back into a prompt.
* **never-raise on reads** — a store/decode glitch degrades to a safe empty list, so a
  dashboard hiccup can never break the page. Writes surface an honest 4xx on bad input
  but never leak an internal error body verbatim.
* **bounded** — caps on dashboards/user + widgets/dashboard so a single principal can't
  grow the shared KV document without bound (the store keeps its own last-line backstop).

Debounce (one PUT per drag/resize settle rather than per pixel) is a CLIENT concern
(RGL ``onLayoutChange`` → ~500ms debounce); the server just persists whatever it is
handed after validating + clamping it.
"""

from __future__ import annotations

import logging
import unicodedata
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..constants import ActionType
from ..models import DashboardLayout, DashboardWidget
from ..state import AppState
from ..utils import new_id
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.dashboards")

router = APIRouter(prefix="/api")

# --------------------------------------------------------------------------- #
# Server-side widget-type ALLOWLIST (#9). The canonical set the client widget
# registry (``webui/src/soc/dashboard/registry.ts`` / ``RESEARCH_CUSTOM_DASHBOARDS``)
# defines. A ``type`` outside this set is rejected on write so a tampered prefs doc /
# rogue client can never inject an unknown widget kind. Kept a plain frozenset so it
# stays in lockstep with the FE union; extend BOTH together when a widget lands.
# --------------------------------------------------------------------------- #
WIDGET_TYPES: frozenset[str] = frozenset({
    # KPI tiles (KpiTile / StatCard bodies)
    "kpi.open_cases", "kpi.mtta", "kpi.mttr", "kpi.budget",
    # Timeseries / mix charts (charts.tsx bodies)
    "chart.cases_per_day", "chart.verdict_mix", "chart.cost_per_day",
    # Top-N lists (BarList bodies)
    "barlist.top_mitre", "barlist.top_sources", "barlist.top_verdicts",
    # Coverage / tables / triage queue
    "mitre.heatmap", "table.recent_cases", "table.campaigns", "queue.attention",
})

# Bounds (the API policy; the store keeps its own looser last-line backstop). MVP is a
# handful of dashboards each with a modest widget count.
_MAX_DASHBOARDS_PER_USER = 24
_MAX_WIDGETS_PER_DASHBOARD = 40
_MAX_NAME_LEN = 120
_MAX_OPTION_KEYS = 40          # per widget — a small, curated config bag (#9)
_MAX_OPTION_VALUE_LEN = 2000   # cap a single option string so options stay small
_GRID_COLS = 12                # the fixed 12-column grid (DashboardLayout.columns)
_MAX_ROWS = 1000               # a sane vertical ceiling so y can't run away
_MAX_BREAKPOINT_KEYS = 8       # lg/md/sm/xs/xxs + a little headroom


def _reject(detail: str) -> HTTPException:
    """A plain, bounded 400 (#9): the body is short, escaped-by-the-client text."""
    return HTTPException(status_code=400, detail=str(detail)[:300])


def _clean_name(raw: Any, *, field: str = "name") -> str:
    """Validate a dashboard/widget NAME as a PLAIN string (#9).

    Rejects control characters (a name is single-line plain text — no CR/LF/NUL/etc.)
    and enforces the length bound. Whitespace is trimmed. An empty name is allowed
    (the UI shows a placeholder); a name that is ONLY control chars collapses to empty.
    Never raises for a valid string; raises a 400 for a disallowed one."""
    s = "" if raw is None else str(raw)
    # Reject any C0/C1 control char (category "Cc") EXCEPT plain spaces/tabs, which we
    # normalise. A tab is folded to a space; every other control char is a hard reject
    # so a name can't smuggle a newline/escape into a log line or SVG <text> node.
    for ch in s:
        if ch in ("\t",):
            continue
        if unicodedata.category(ch) in ("Cc", "Cf") and ch != " ":
            raise _reject(f"{field} contains a control character")
    cleaned = s.replace("\t", " ").strip()
    if len(cleaned) > _MAX_NAME_LEN:
        raise _reject(f"{field} too long (max {_MAX_NAME_LEN} characters)")
    return cleaned


def _clamp_int(value: Any, *, lo: int, hi: int, default: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _clean_widget(w: DashboardWidget, columns: int) -> DashboardWidget:
    """Allowlist-validate + coord-clamp ONE widget (#9).

    Raises a 400 for an unknown ``type`` (allowlist enforcement); otherwise clamps the
    grid geometry into the ``columns``-wide grid so a tampered/oversized placement can't
    escape the canvas, bounds the options bag, and validates any ``options.title`` as a
    plain name. The widget ``i`` (its stable id + RGL key) is preserved (a fresh id is
    minted only when it is blank)."""
    wtype = str(w.type or "").strip()
    if wtype not in WIDGET_TYPES:
        raise _reject(f"unknown widget type: {wtype[:60]!r}")

    cols = max(1, min(_GRID_COLS, int(columns or _GRID_COLS)))
    # width in [1, cols]; x so the widget fits; height/row bounded.
    wdt = _clamp_int(w.w, lo=1, hi=cols, default=min(4, cols))
    hgt = _clamp_int(w.h, lo=1, hi=_MAX_ROWS, default=4)
    x = _clamp_int(w.x, lo=0, hi=cols - wdt, default=0)
    y = _clamp_int(w.y, lo=0, hi=_MAX_ROWS, default=0)
    min_w = None if w.minW is None else _clamp_int(w.minW, lo=1, hi=cols, default=1)
    min_h = None if w.minH is None else _clamp_int(w.minH, lo=1, hi=_MAX_ROWS, default=1)

    options = _clean_options(w.options)
    i = str(w.i or "").strip() or new_id("w-")
    return DashboardWidget(
        i=i, type=wtype, x=x, y=y, w=wdt, h=hgt,
        minW=min_w, minH=min_h, static=bool(w.static), options=options,
    )


def _clean_options(raw: Any) -> dict[str, Any]:
    """Bound a widget's declarative options bag (#9): drop non-dict input, cap the key
    count, validate an embedded ``title`` as a plain name, and truncate a runaway string
    value. Values stay free-form PLAIN data the UI render-escapes; nothing here is ever
    interpolated unfenced into a prompt."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in list(raw.keys())[:_MAX_OPTION_KEYS]:
        k = str(key)[:120]
        val = raw[key]
        if k == "title":
            out[k] = _clean_name(val, field="widget title")
        elif isinstance(val, str):
            out[k] = val[:_MAX_OPTION_VALUE_LEN]
        else:
            out[k] = val
    return out


def _sanitize_layout(
    body: DashboardLayout, *, dashboard_id: str | None = None
) -> DashboardLayout:
    """Validate + normalise a whole submitted dashboard into a safe stored shape.

    Enforces the widgets/dashboard cap, allowlist-validates every widget type,
    coord-clamps every placement (both the primary ``widgets`` list AND every
    per-breakpoint override in ``layouts``), and validates the dashboard ``name``. When
    ``dashboard_id`` is given (a PUT), the path id is authoritative and overrides the
    body id. Timestamps are left to the store (it stamps ``updated_at`` / preserves
    ``created_at``). Raises a 400 for any invalid input."""
    name = _clean_name(body.name, field="dashboard name")
    columns = _clamp_int(body.columns, lo=1, hi=_GRID_COLS, default=_GRID_COLS)

    widgets = list(body.widgets or [])
    if len(widgets) > _MAX_WIDGETS_PER_DASHBOARD:
        raise _reject(f"too many widgets (max {_MAX_WIDGETS_PER_DASHBOARD})")
    clean_widgets = [_clean_widget(w, columns) for w in widgets]

    # Per-breakpoint override map (RGL responsive). Bound the breakpoint count + each
    # list; clamp every placement the same way as the primary list.
    layouts: dict[str, list[DashboardWidget]] = {}
    src_layouts = body.layouts if isinstance(body.layouts, dict) else {}
    for bp in list(src_layouts.keys())[:_MAX_BREAKPOINT_KEYS]:
        items = src_layouts.get(bp) or []
        if len(items) > _MAX_WIDGETS_PER_DASHBOARD:
            raise _reject(f"too many widgets in breakpoint {str(bp)[:20]!r}")
        layouts[str(bp)[:20]] = [_clean_widget(w, columns) for w in items]

    did = str(dashboard_id).strip() if dashboard_id else (str(body.id).strip() or new_id("dash-"))
    return DashboardLayout(
        id=did, name=name, schema_version=int(body.schema_version or 1),
        columns=columns, widgets=clean_widgets, layouts=layouts,
    )


async def _audit(state: AppState, request: Request, event: str, detail: str) -> None:
    """Best-effort append-only audit of a dashboard mutation (#2). Never raises."""
    audit = getattr(state, "_real_audit", None) or getattr(state, "audit", None)
    if audit is None:
        return
    try:
        await audit.record(
            # A dashboard write is ADVISORY presentation state — audited with the
            # additive CONTEXT type (never DECISION/STATUS; it never feeds decide(), #3).
            action_type=ActionType.CONTEXT,
            surface="dashboards",
            actor=current_username(request) or "",
            result_summary=f"{event}: {detail}"[:500],
        )
    except Exception:  # noqa: BLE001 — audit is best-effort, never breaks the write
        pass


def _dash_json(layout: DashboardLayout) -> dict[str, Any]:
    return layout.model_dump(mode="json")


# --------------------------------------------------------------------------- #
# GET /api/dashboards — the caller's saved custom dashboards (NEVER raises)
# --------------------------------------------------------------------------- #
@router.get("/dashboards")
async def list_dashboards(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """The authenticated caller's saved dashboards (created-oldest first). Read-only;
    degrades to an empty list on any store glitch so a dashboard hiccup never breaks
    the page."""
    user = current_username(request)
    try:
        boards = await state.dashboards.list_for_user(user)
    except Exception as exc:  # noqa: BLE001 — dashboards are best-effort
        logger.warning("list dashboards soft-failed (%s); returning empty", exc)
        boards = []
    return {"dashboards": [_dash_json(b) for b in boards]}


# --------------------------------------------------------------------------- #
# POST /api/dashboards — create (or replace by id) one dashboard
# --------------------------------------------------------------------------- #
@router.post("/dashboards")
async def create_dashboard(
    body: DashboardLayout,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Create one dashboard for the caller (id minted if absent). Allowlist-validates
    every widget type, clamps coords, validates the name, and enforces the per-user cap
    (#9/#10). Returns the stored dashboard."""
    user = current_username(request)
    layout = _sanitize_layout(body)

    # Per-user cap: a brand-new id must not push the user over the ceiling (a REPLACE of
    # an existing id is always allowed — it does not grow the set).
    try:
        existing = await state.dashboards.list_for_user(user)
    except Exception:  # noqa: BLE001 — a read glitch shouldn't block a create
        existing = []
    existing_ids = {b.id for b in existing}
    if layout.id not in existing_ids and len(existing_ids) >= _MAX_DASHBOARDS_PER_USER:
        raise _reject(f"dashboard limit reached (max {_MAX_DASHBOARDS_PER_USER})")

    stored = await state.dashboards.save(user, layout)
    await _audit(state, request, "dashboard_create", f"id={stored.id} widgets={len(stored.widgets)}")
    return _dash_json(stored)


# --------------------------------------------------------------------------- #
# PUT /api/dashboards/{dashboard_id} — replace one dashboard (path id wins)
# --------------------------------------------------------------------------- #
@router.put("/dashboards/{dashboard_id}")
async def update_dashboard(
    dashboard_id: str,
    body: DashboardLayout,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Replace the dashboard at ``dashboard_id`` (the PATH id is authoritative and
    overrides any id in the body). Allowlist-validates widget types + clamps coords +
    validates the name (#9). Creating-by-PUT is allowed but still honours the per-user
    cap when the id is new."""
    did = (dashboard_id or "").strip()
    if not did:
        raise _reject("dashboard id is required")
    user = current_username(request)
    layout = _sanitize_layout(body, dashboard_id=did)

    try:
        existing = await state.dashboards.list_for_user(user)
    except Exception:  # noqa: BLE001
        existing = []
    existing_ids = {b.id for b in existing}
    if layout.id not in existing_ids and len(existing_ids) >= _MAX_DASHBOARDS_PER_USER:
        raise _reject(f"dashboard limit reached (max {_MAX_DASHBOARDS_PER_USER})")

    stored = await state.dashboards.save(user, layout)
    await _audit(state, request, "dashboard_update", f"id={stored.id} widgets={len(stored.widgets)}")
    return _dash_json(stored)


# --------------------------------------------------------------------------- #
# DELETE /api/dashboards/{dashboard_id} — drop one dashboard
# --------------------------------------------------------------------------- #
@router.delete("/dashboards/{dashboard_id}")
async def delete_dashboard(
    dashboard_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Drop one of the caller's dashboards. Idempotent-ish: a 404 if it did not exist
    so the caller gets an honest signal rather than a silent no-op."""
    did = (dashboard_id or "").strip()
    if not did:
        raise _reject("dashboard id is required")
    user = current_username(request)
    try:
        removed = await state.dashboards.delete(user, did)
    except Exception as exc:  # noqa: BLE001 — a store glitch is a 500, not a crash
        logger.warning("delete dashboard %s soft-failed (%s)", did, exc)
        raise HTTPException(status_code=500, detail="delete failed") from exc
    if not removed:
        raise HTTPException(status_code=404, detail=f"no dashboard {str(did)[:80]}")
    await _audit(state, request, "dashboard_delete", f"id={did}")
    return {"ok": True, "id": did}


# --------------------------------------------------------------------------- #
# POST /api/dashboards/{dashboard_id}/clone — copy into the caller's set
# --------------------------------------------------------------------------- #
@router.post("/dashboards/{dashboard_id}/clone")
async def clone_dashboard(
    dashboard_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Copy an existing dashboard into the caller's PERSONAL set under a fresh id
    (clone-to-customize). The source is looked up FIRST in the caller's own set, then in
    the org/role ``CustomizationConfig.default_dashboards`` map — so a read-only role
    default can be cloned into an editable personal copy on first edit. The clone is
    re-sanitised (widget allowlist + coord clamp + name validation) before storing, so
    a tampered stored default can't inject a rogue widget. 404 when the source is
    unknown."""
    src_id = (dashboard_id or "").strip()
    if not src_id:
        raise _reject("dashboard id is required")
    user = current_username(request)

    source: DashboardLayout | None = None
    try:
        source = await state.dashboards.get(user, src_id)
    except Exception as exc:  # noqa: BLE001 — degrade to the default-map lookup
        logger.warning("clone source read soft-failed (%s)", exc)
        source = None
    if source is None:
        source = _default_dashboard(state, src_id)
    if source is None:
        raise HTTPException(status_code=404, detail=f"no dashboard {str(src_id)[:80]}")

    # Enforce the per-user cap BEFORE minting the clone.
    try:
        existing = await state.dashboards.list_for_user(user)
    except Exception:  # noqa: BLE001
        existing = []
    if len(existing) >= _MAX_DASHBOARDS_PER_USER:
        raise _reject(f"dashboard limit reached (max {_MAX_DASHBOARDS_PER_USER})")

    clone_name = _clean_name(f"{source.name} (copy)".strip() or "Copy", field="dashboard name")
    clone = _sanitize_layout(
        source.model_copy(update={"id": new_id("dash-"), "name": clone_name})
    )
    stored = await state.dashboards.save(user, clone)
    await _audit(state, request, "dashboard_clone", f"from={src_id} id={stored.id}")
    return _dash_json(stored)


def _default_dashboard(state: AppState, dashboard_id: str) -> DashboardLayout | None:
    """Resolve an org/role default dashboard by id from
    ``CustomizationConfig.default_dashboards`` (role → serialised layout). Best-effort:
    a malformed default entry is skipped (returns None), never raises."""
    cust = getattr(state.prefs, "customization", None)
    defaults = getattr(cust, "default_dashboards", None) or {}
    if not isinstance(defaults, dict):
        return None
    for raw in defaults.values():
        if not isinstance(raw, dict):
            continue
        if str(raw.get("id", "")).strip() != dashboard_id:
            continue
        try:
            return DashboardLayout.model_validate(raw)
        except Exception:  # noqa: BLE001 — a corrupt default is skipped, not fatal
            return None
    return None
