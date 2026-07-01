"""Operator RESET route (Round 4, Wave 4 — the danger-zone endpoint).

``POST /api/admin/reset {scope, confirm}`` — a tiered, GitHub-style type-to-confirm
reset of the suite's OWN management state (cases / sources+logs / full factory→OOBE).
The heavy lifting lives in :func:`app.engine.reset.reset_service`; this router owns
the SAFETY envelope:

* **Double-gated** — ``require_admin`` (the ``users:manage`` privileged grant) AND
  ``require_fresh_auth`` (a step-up / sudo re-auth window). A non-admin is 403'd; a
  stale session is 401'd ``reauth_required`` before anything is cleared.
* **Type-to-confirm** — the ``confirm`` field MUST byte-match the per-scope phrase
  (``RESET CASES`` / ``RESET SOURCES`` / ``FACTORY RESET``); a mismatch is rejected
  **400** before any store is touched.
* **Audited BEFORE acting (#2)** — an append-only ``ActionType.RESET`` record is
  written to the REAL audit log FIRST, so even a factory reset (which then wipes the
  audit index) leaves the intent recorded up to the moment of the wipe on any
  operator who tails it, and every non-factory reset keeps a permanent trail.
* **Secret-safe (⛔ HARD RULE)** — env-provided secrets (``ES_API_KEY`` / the LLM
  keys / ``STATE_DB_URL`` / any ``TLSOC_*``) are NEVER read or written. Only the
  in-memory/wizard **per-source connector secrets** clear, and ONLY at the sources +
  factory tiers (a source's token has no meaning once the source is gone). The reset
  ENGINE touches only the StateStore; this route touches only ``connector_secrets``
  in the in-memory secret tier — never the env scalars.

Invariants: #1 (never touches the read-only log key / upstream ``all-logs-*``), #3
(never imports / calls ``case_manager.decide()`` — reset DESTROYS cases, it never
TRANSITIONS one), #4 (never recomputes a ``cluster_signature``), #6 (the cost ledger
survives a case/source reset; a factory reset makes no LLM call). Every string
returned is PLAIN data the UI renders escaped (#9).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..constants import ActionType, ResetScope
from ..engine.reset import reset_service
from ..state import AppState
from .deps import current_username, get_state, require_admin, require_fresh_auth

logger = logging.getLogger("tlsoc.api.reset")

router = APIRouter(prefix="/api")

# The exact type-to-confirm phrase required per scope (GitHub danger-zone pattern).
# The server VALIDATES the submitted ``confirm`` against this map — a mismatch 400s
# BEFORE any store is touched, so a fat-fingered scope can never wipe more than typed.
_CONFIRM_PHRASE: dict[ResetScope, str] = {
    ResetScope.CASES: "RESET CASES",
    ResetScope.SOURCES: "RESET SOURCES",
    ResetScope.FACTORY: "FACTORY RESET",
}


class ResetBody(BaseModel):
    scope: str
    confirm: str = ""


@router.post("/admin/reset")
async def admin_reset(
    body: ResetBody,
    request: Request,
    state: AppState = Depends(get_state),
    _admin=Depends(require_admin),                 # privileged grant (users:manage)
    _fresh=Depends(require_fresh_auth()),          # step-up / sudo re-auth
) -> dict:
    """Perform a tiered StateStore reset. Returns ``{ok, scope, cleared}``.

    ``scope`` ∈ {``cases``, ``sources``, ``factory``}; ``confirm`` must match the
    scope's phrase. Order of operations (fail-closed): validate scope → validate
    confirm → AUDIT (#2) → clear in-memory per-source secrets (tiers 2/3 only) →
    reset the StateStore. Nothing is cleared until BOTH gates + BOTH validations pass.
    """
    if state.prefs.read_only_settings_mode:
        raise HTTPException(status_code=403, detail="settings are read-only")

    # 1) Validate the scope enum (unknown → 400, no store touched).
    try:
        scope = ResetScope(str(body.scope))
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"invalid scope (must be one of {[s.value for s in ResetScope]})",
        ) from None

    # 2) Validate the type-to-confirm phrase (mismatch → 400, no store touched).
    expected = _CONFIRM_PHRASE[scope]
    if (body.confirm or "") != expected:
        raise HTTPException(
            status_code=400,
            detail=f"confirmation phrase must be exactly '{expected}' to reset scope '{scope.value}'",
        )

    actor = current_username(request) or "admin"

    # 3) Audit BEFORE acting (#2). On the REAL audit log so a demo-engaged session
    # still records the real admin action. Written first so a factory reset (which
    # then wipes the audit index) has recorded intent up to the wipe. A failed audit
    # write must NOT proceed to a destructive reset — fail closed.
    try:
        await state._real_audit.record(  # noqa: SLF001 — real-audit on a real admin action
            action_type=ActionType.RESET,
            surface="admin",
            actor=actor,
            result_summary=f"reset scope={scope.value} confirm=ok",
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("RESET audit write failed (%s); aborting reset", exc)
        raise HTTPException(status_code=500, detail="could not record the reset audit; aborted") from exc

    # 4) Clear the in-memory/wizard per-source connector secrets at the sources +
    # factory tiers (a removed source's token is meaningless). ENV-provided secrets
    # (ES/LLM keys, STATE_DB_URL, TLSOC_*) are NEVER touched — only this per-source
    # in-memory bucket. The reset ENGINE never sees Secrets at all.
    secrets_cleared = False
    if scope in (ResetScope.SOURCES, ResetScope.FACTORY):
        try:
            if getattr(state.secrets, "connector_secrets", None):
                state.secrets.connector_secrets.clear()
                secrets_cleared = True
        except Exception as exc:  # noqa: BLE001 — never fail the reset on the secret sweep
            logger.warning("per-source secret clear failed (%s); continuing", exc)

    # 5) Reset the StateStore (the destructive step). Idempotent + best-effort.
    result = await reset_service(state, scope)
    cleared = list(result.get("cleared", []))
    if secrets_cleared:
        cleared.append("connector_secrets")

    return {"ok": True, "scope": scope.value, "cleared": cleared}
