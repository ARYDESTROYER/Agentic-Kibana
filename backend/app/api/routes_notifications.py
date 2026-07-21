"""Notification routes — Round 5 (Coupling-E extraction).

A cohesive slice carved OUT of the ``routes.py`` monolith with **byte-identical
paths, methods, auth dependencies, request/response bodies**. Handlers moved verbatim
(imports re-homed); the router is mounted in ``main.py`` under the SAME ``require_auth``
gate the monolith uses, so ``test_route_auth_coverage`` stays green.

It owns the operator notification surface: the providers catalog, server-side template
preview, test-send, per-channel secret, and manual per-case notify. Notification
config itself rides ``PUT /api/settings`` (the ``notifications`` subtree) — that stays
in the settings router.

NON-NEGOTIABLES held: #3 — notification SENDS are fire-and-forget and never block or
alter a case decision. #9 — the preview render is the AUTHORITATIVE escaping/fencing
path (the UI shows exactly what ships). #10 — a channel secret goes to the SECRET tier
(in memory), never Preferences; only a configured-boolean / field-name list is returned.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..constants import ActionType
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.notifications")

router = APIRouter(prefix="/api")


class NotificationProvidersResponse(BaseModel):
    """The notification providers catalog envelope (no secrets — names/ids only)."""

    email_presets: list[dict[str, Any]] = Field(default_factory=list)
    channel_types: list[dict[str, Any]] = Field(default_factory=list)
    template_ids: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Notifications (F5 / Wave 4) — providers catalog, test-send, manual case notify,
# and per-channel secret. Config rides PUT /api/settings (notifications subtree).
# Notification SENDS are fire-and-forget and never block/alter a case decision (#3).
# --------------------------------------------------------------------------- #
@router.get("/notifications/providers", response_model=NotificationProvidersResponse)
async def notification_providers(
    _=Depends(require_permission("notifications", "read")),
) -> dict[str, Any]:
    """The email provider presets + the available channel types + the built-in
    template ids (for the Settings notification editor). No secrets; notifications:read.
    ``resend`` + ``ses`` (SMTP preset) both appear in the surfaced lists."""
    from ..notifications.channel import channel_types, ensure_registered
    from ..notifications.email import preset_list
    from ..notifications.templates import builtin_template_ids

    ensure_registered()
    return {
        "email_presets": preset_list(),
        "channel_types": channel_types(),
        "template_ids": builtin_template_ids(),
    }


class NotificationPreviewBody(BaseModel):
    # Optional per-trigger {subject, html, text} override to preview UNSAVED edits.
    subject: str | None = None
    html: str | None = None
    text: str | None = None


@router.post("/notifications/preview")
async def notification_preview(
    trigger: str = "case_created",
    body: NotificationPreviewBody | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("notifications", "manage")),
) -> dict[str, Any]:
    """Server-side render of a SAMPLE case for ``trigger`` → ``{subject, html, text}``
    (notifications:manage). The escaping/fencing is AUTHORITATIVE here — the UI shows
    exactly what would ship. An optional unsaved per-trigger override in the body is
    layered on top of the live operator templates so the editor can preview edits.
    No real case data, no real send, never leaks a secret."""
    from ..notifications.dispatch import _sample_case
    from ..notifications import templates as _tpl
    from ..config import NotificationTemplates, NotificationTemplateOverride

    cfg = getattr(state.prefs, "notifications", None)
    base_url = (getattr(cfg, "base_url", "") or "") if cfg else ""
    tpl = getattr(cfg, "templates", None) if cfg else None
    branding = getattr(state.prefs, "branding", None)
    org_name = (getattr(branding, "org_name", "") or "Agentic SOC") if branding else "Agentic SOC"

    # Layer an UNSAVED override (from the editor) over the live templates for preview.
    if body is not None and (body.subject or body.html or body.text):
        merged = dict(getattr(tpl, "overrides", {}) or {})
        merged[trigger] = NotificationTemplateOverride(
            subject=body.subject or "", html=body.html or "", text=body.text or "",
        )
        tpl = NotificationTemplates(overrides=merged)

    rendered = _tpl.render(
        _sample_case(), trigger, base_url=base_url, org_name=org_name,
        templates=tpl, branding=branding,
    )
    return {
        "trigger": trigger,
        "subject": rendered["subject"],
        "html": rendered["html"],
        "text": rendered["text"],
        "headers": rendered.get("headers") or {},
    }


class NotificationTestBody(BaseModel):
    channel_id: str


@router.post("/notifications/test")
async def notification_test(
    body: NotificationTestBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("notifications", "manage")),
) -> dict[str, Any]:
    """Send a SAMPLE notification to one configured channel (notifications:manage). The
    returned detail never leaks a secret."""
    # Demo Mode (Wave 5): a real outbound send is refused while demo is engaged — the
    # showcase must never deliver a real notification. (Demo cases already carry
    # synthetic notifications_sent records.)
    if state.demo_active:
        return {"ok": False, "channel_id": body.channel_id,
                "detail": "Demo mode is active — real notifications are disabled (simulated)."}
    return await state.notifications.test_channel(body.channel_id)


class NotificationChannelSecretBody(BaseModel):
    field: str = "secret"
    value: str | None = None


@router.post("/notifications/channels/{channel_id}/secret")
async def set_notification_channel_secret(
    channel_id: str,
    body: NotificationChannelSecretBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("notifications", "manage")),
) -> dict[str, Any]:
    """Set/clear one notification channel's secret field (notifications:manage). The value
    goes to the SECRET tier (in memory), NEVER to Preferences; only a configured-
    boolean is returned. Also stamps the channel's ``configured_secrets`` (names only)."""
    state.secrets.set_notification_secret(channel_id, body.field or "secret", body.value)
    configured = sorted(state.secrets.notification_channel_secrets(channel_id).keys())
    # Reflect the configured field NAMES (not values) onto the channel config so the
    # UI can show ✓ across reloads. Best-effort — never blocks the secret write.
    try:
        cfg = getattr(state.prefs, "notifications", None)
        if cfg is not None:
            channels = list(cfg.channels)
            for i, ch in enumerate(channels):
                if ch.id == channel_id:
                    channels[i] = ch.model_copy(update={"configured_secrets": configured})
                    new_notif = cfg.model_copy(update={"channels": channels})
                    await state.update_prefs(
                        state.prefs.model_copy(update={"notifications": new_notif})
                    )
                    break
    except Exception as exc:  # noqa: BLE001
        logger.warning("notification configured_secrets stamp failed for %s: %s", channel_id, exc)
    await state.control_audit.record(
        action_type=ActionType.NOTIFICATION, surface="notification",
        actor=current_username(request),
        result_summary=(
            f"channel secret '{body.field or 'secret'}' "
            f"{'set' if body.value else 'cleared'} for '{channel_id}'"
        ),
    )
    return {"ok": True, "configured": bool(configured), "configured_secrets": configured}


class NotifyCaseBody(BaseModel):
    channel_id: str | None = None


@router.post("/cases/{case_id}/notify")
async def notify_case(
    case_id: str,
    body: NotifyCaseBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "write")),
) -> dict[str, Any]:
    """Manually send a case notification to one channel (or all enabled when no
    channel_id). cases:write. Fire-and-forget semantics still apply (the send can
    never alter the case)."""
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    if state.demo_active:
        return {
            "ok": False,
            "sent": [],
            "simulated": True,
            "detail": "Demo mode is active — outbound case notifications are disabled.",
        }
    from ..notifications.dispatch import TRIGGER_MANUAL

    channel_ids = [body.channel_id] if body.channel_id else None
    sent = await state.notifications.dispatch(
        case, TRIGGER_MANUAL, channel_ids=channel_ids, check_triggers=False
    )
    return {"ok": True, "sent": sent}
