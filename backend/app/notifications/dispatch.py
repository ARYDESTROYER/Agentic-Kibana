"""Notification dispatch service (F5 / Wave 4).

``NotificationService`` is the one place that turns a (case, trigger) into zero or
more channel sends. It:

1. Evaluates the operator triggers (verdict/status/severity/risk floors) — does this
   trigger fire at all?
2. Renders the UNTRUSTED-safe body ONCE (:mod:`templates`) and reuses it per channel.
3. Per enabled+matching channel: DEDUPES (a hash of channel+case-signature+trigger
   over a time bucket; Redis-backed when available, in-memory fallback), RATE-LIMITS
   (per channel, per rolling hour), then DISPATCHES.
4. Audits every attempt (``ActionType.NOTIFICATION``) with channel + ok + a REDACTED
   detail (never a secret), and records a compact entry on ``case.notifications_sent``.

NON-NEGOTIABLE #3: ``notify(...)`` is invoked AFTER ``case_manager.apply()`` + save,
fire-and-forget. It NEVER raises into the caller and NEVER blocks the case flow — the
caller wraps the call in ``asyncio.create_task`` / a swallowed try/except, and every
internal failure here is caught and downgraded to an audited non-send. The case
decision is produced solely by ``decide()``; this module only OBSERVES the saved case.
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

from . import templates
from .channel import NotificationEvent, build_channel, ensure_registered

logger = logging.getLogger("tlsoc.notifications.dispatch")

# Trigger ids (mirrors templates._TRIGGER_LABEL keys the channels surface).
TRIGGER_CREATED = "case_created"
TRIGGER_ESCALATED = "escalated"
TRIGGER_TRUE_POSITIVE = "true_positive"
TRIGGER_NEEDS_HUMAN = "needs_human"
TRIGGER_CLOSED = "closed"
TRIGGER_MANUAL = "manual"
TRIGGER_TEST = "test"


def _val(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _enum_value(v: Any) -> str:
    return str(getattr(v, "value", v) or "")


class NotificationService:
    """Fire-and-forget notification dispatcher.

    ``cache`` is the app's :class:`app.cache.Cache` (Redis + in-memory fallback) used
    for dedup + rate-limit counters; when None a process-local dict is used. ``audit``
    is the append-only audit logger (best-effort). ``get_prefs`` returns the live
    ``Preferences`` (so config edits take effect without rebuilding the service).
    ``secrets`` is the SECRET tier (per-channel secrets resolved at send time)."""

    def __init__(self, *, get_prefs, secrets, cache=None, audit=None) -> None:
        self._get_prefs = get_prefs
        self._secrets = secrets
        self._cache = cache
        self._audit = audit
        # In-memory fallbacks (single-node) when no cache is wired.
        self._dedup_mem: dict[str, float] = {}
        self._rate_mem: dict[str, list[float]] = {}
        ensure_registered()

    # -- trigger evaluation -------------------------------------------------- #
    def _triggers_for_case(self, case: Any, cfg) -> list[str]:
        """Which configured triggers this saved case matches (verdict/status)."""
        t = cfg.triggers
        verdict = _enum_value(_val(case, "verdict"))
        status = _enum_value(_val(case, "status"))
        out: list[str] = []
        if t.on_escalated and status in ("escalated", "needs_human"):
            out.append(TRIGGER_ESCALATED)
        if t.on_true_positive and verdict == "TRUE_POSITIVE":
            out.append(TRIGGER_TRUE_POSITIVE)
        if t.on_needs_human and (verdict == "NEEDS_HUMAN" or status == "needs_human"):
            out.append(TRIGGER_NEEDS_HUMAN)
        if t.on_closed and status in ("closed", "resolved"):
            out.append(TRIGGER_CLOSED)
        return out

    def _passes_floors(self, case: Any, cfg) -> bool:
        t = cfg.triggers
        risk = float(_val(case, "risk_score", 0.0) or 0.0)
        if t.min_risk and risk < float(t.min_risk):
            return False
        if t.min_severity and risk < float(t.min_severity):
            return False
        return True

    # -- dedup + rate-limit -------------------------------------------------- #
    def _dedup_key(self, channel_id: str, case: Any, trigger: str, window: int) -> str:
        sig = _enum_value(_val(case, "cluster_signature")) or _val(case, "case_id", "")
        bucket = int(time.time() // window) if window > 0 else 0
        raw = f"{channel_id}|{sig}|{trigger}|{bucket}"
        return "tlsoc:notif:dedup:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]

    async def _is_duplicate(self, channel_id: str, case: Any, trigger: str, window: int) -> bool:
        if window <= 0:
            return False
        key = self._dedup_key(channel_id, case, trigger, window)
        if self._cache is not None:
            try:
                seen = await self._cache.get(key)
                if seen:
                    return True
                await self._cache.set(key, "1", window)
                return False
            except Exception:  # noqa: BLE001 — never let cache errors block a send decision
                pass
        # in-memory fallback
        now = time.time()
        exp = self._dedup_mem.get(key)
        if exp and exp > now:
            return True
        self._dedup_mem[key] = now + window
        return False

    async def _rate_limited(self, channel_id: str, per_hour: int) -> bool:
        if per_hour <= 0:
            return False
        now = time.time()
        if self._cache is not None:
            bucket = int(now // 3600)
            key = f"tlsoc:notif:rate:{channel_id}:{bucket}"
            try:
                raw = await self._cache.get(key)
                count = int(raw) if raw else 0
                if count >= per_hour:
                    return True
                await self._cache.set(key, str(count + 1), 3600)
                return False
            except Exception:  # noqa: BLE001
                pass
        # in-memory rolling window
        window_start = now - 3600
        hits = [t for t in self._rate_mem.get(channel_id, []) if t > window_start]
        if len(hits) >= per_hour:
            self._rate_mem[channel_id] = hits
            return True
        hits.append(now)
        self._rate_mem[channel_id] = hits
        return False

    # -- send one channel ---------------------------------------------------- #
    def _resolve_secret(self, channel_id: str) -> str:
        """The primary per-channel secret (password / api key / webhook url / token).

        Channels read one opaque ``secret`` string; we pick the channel's single
        secret value (the dict has one well-known field name per type)."""
        try:
            bucket = self._secrets.notification_channel_secrets(channel_id)
        except Exception:  # noqa: BLE001
            bucket = {}
        if not bucket:
            return ""
        # Convention: the primary credential is stored under "secret"; fall back to
        # other well-known field names, else the first value present.
        for field in ("secret", "password", "url", "api_key", "token",
                      "routing_key", "bot_token", "webhook_url"):
            if bucket.get(field):
                return str(bucket[field])
        return str(next(iter(bucket.values())))

    async def _send_one(self, ch_cfg, event: NotificationEvent) -> dict[str, Any]:
        secret = self._resolve_secret(ch_cfg.id)
        config = dict(ch_cfg.config or {})
        config.setdefault("name", ch_cfg.name or ch_cfg.id)
        config.setdefault("id", ch_cfg.id)
        channel = build_channel(ch_cfg.type, config, secret)
        if channel is None:
            return {"channel_id": ch_cfg.id, "type": ch_cfg.type, "ok": False,
                    "detail": f"unknown channel type: {ch_cfg.type}"}
        result = await channel.send(event)
        return {"channel_id": ch_cfg.id, "type": ch_cfg.type, "ok": result.ok, "detail": result.detail}

    async def _audit_send(self, case_id: str, rec: dict[str, Any], trigger: str) -> None:
        if self._audit is None:
            return
        try:
            from ..constants import ActionType

            await self._audit.record(
                action_type=ActionType.NOTIFICATION, surface="notification",
                actor="notification", case_id=case_id,
                result_summary=(
                    f"channel={rec.get('channel_id')} type={rec.get('type')} "
                    f"trigger={trigger} ok={rec.get('ok')} detail={rec.get('detail')}"
                ),
            )
        except Exception as exc:  # noqa: BLE001 — audit is best-effort
            logger.debug("notification audit failed: %s", exc)

    def _org_name(self, cfg) -> str:
        prefs = self._safe_prefs()
        branding = getattr(prefs, "branding", None)
        return (getattr(branding, "org_name", "") or "TLSOC") if branding else "TLSOC"

    def _branding(self):
        """The live BrandingConfig (or None) — feeds the email shell tokens (logo /
        accent / footer) into :func:`templates.render`. Best-effort; never raises."""
        prefs = self._safe_prefs()
        return getattr(prefs, "branding", None) if prefs else None

    def _safe_prefs(self):
        try:
            return self._get_prefs()
        except Exception:  # noqa: BLE001
            return None

    # -- public entrypoints -------------------------------------------------- #
    async def dispatch(self, case: Any, trigger: str, *, channel_ids: list[str] | None = None,
                       check_triggers: bool = True) -> list[dict[str, Any]]:
        """Render + dispatch ``case`` for ``trigger`` to matching channels.

        Returns a list of per-channel result dicts (also appended to
        ``case.notifications_sent`` by the caller / here). NEVER raises."""
        sent: list[dict[str, Any]] = []
        try:
            prefs = self._safe_prefs()
            cfg = getattr(prefs, "notifications", None) if prefs else None
            if cfg is None or not cfg.enabled:
                return sent
            ensure_registered()
            channels = cfg.enabled_channels() if hasattr(cfg, "enabled_channels") else [
                c for c in cfg.channels if c.enabled
            ]
            if channel_ids is not None:
                wanted = set(channel_ids)
                channels = [c for c in channels if c.id in wanted]
            if not channels:
                return sent

            body = templates.render(
                case, trigger, base_url=cfg.base_url or "", org_name=self._org_name(cfg),
                templates=getattr(cfg, "templates", None), branding=self._branding(),
            )
            event = NotificationEvent(
                case=case, trigger=trigger, subject=body["subject"],
                html=body["html"], text=body["text"], meta=body["meta"],
                headers=body.get("headers") or {},
            )
            case_id = _val(case, "case_id", "") or ""
            for ch in channels:
                try:
                    if check_triggers:
                        if await self._is_duplicate(ch.id, case, trigger, cfg.dedup_window_seconds):
                            continue
                        if await self._rate_limited(ch.id, cfg.rate_limit_per_hour):
                            sent.append({"channel_id": ch.id, "type": ch.type, "ok": False,
                                         "detail": "rate limit exceeded"})
                            continue
                    rec = await self._send_one(ch, event)
                except Exception as exc:  # noqa: BLE001 — one channel can't break the rest
                    rec = {"channel_id": ch.id, "type": ch.type, "ok": False,
                           "detail": f"dispatch error: {type(exc).__name__}"}
                rec["trigger"] = trigger
                rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                sent.append(rec)
                await self._audit_send(case_id, rec, trigger)
        except Exception as exc:  # noqa: BLE001 — fire-and-forget; never raise into the caller
            logger.warning("notification dispatch failed: %s", exc)
        return sent

    async def notify(self, case: Any, *, save=None) -> list[dict[str, Any]]:
        """Evaluate triggers for a freshly-saved case and dispatch all matches.

        Fire-and-forget: catches everything. When ``save`` is provided (a coroutine
        callable taking the case), the updated ``notifications_sent`` is persisted
        best-effort AFTER sending (so a failed save never blocks delivery)."""
        all_sent: list[dict[str, Any]] = []
        try:
            prefs = self._safe_prefs()
            cfg = getattr(prefs, "notifications", None) if prefs else None
            if cfg is None or not cfg.enabled:
                return all_sent
            if not self._passes_floors(case, cfg):
                return all_sent
            triggers = self._triggers_for_case(case, cfg)
            for trig in triggers:
                all_sent.extend(await self.dispatch(case, trig))
            if all_sent:
                try:
                    existing = list(_val(case, "notifications_sent", []) or [])
                    if isinstance(case, dict):
                        case["notifications_sent"] = existing + all_sent
                    else:
                        case.notifications_sent = existing + all_sent
                    if save is not None:
                        await save(case)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("persist notifications_sent failed: %s", exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("notify() failed: %s", exc)
        return all_sent

    async def test_channel(self, channel_id: str) -> dict[str, Any]:
        """Send a sample notification to ONE channel (the Settings 'Send test' button).
        Never leaks secrets in the returned detail."""
        prefs = self._safe_prefs()
        cfg = getattr(prefs, "notifications", None) if prefs else None
        if cfg is None:
            return {"ok": False, "detail": "notifications not configured"}
        ch = cfg.channel(channel_id) if hasattr(cfg, "channel") else next(
            (c for c in cfg.channels if c.id == channel_id), None
        )
        if ch is None:
            return {"ok": False, "detail": "channel not found"}
        ensure_registered()
        sample = _sample_case()
        body = templates.render(sample, TRIGGER_TEST, base_url=cfg.base_url or "",
                                org_name=self._org_name(cfg),
                                templates=getattr(cfg, "templates", None),
                                branding=self._branding())
        event = NotificationEvent(
            case=sample, trigger=TRIGGER_TEST, subject=body["subject"],
            html=body["html"], text=body["text"], meta=body["meta"],
            headers=body.get("headers") or {},
        )
        try:
            rec = await self._send_one(ch, event)
        except Exception as exc:  # noqa: BLE001
            rec = {"ok": False, "detail": f"test failed: {type(exc).__name__}"}
        await self._audit_send("", {**rec, "channel_id": channel_id, "type": ch.type}, TRIGGER_TEST)
        return {"ok": bool(rec.get("ok")), "detail": rec.get("detail", "")}


def _sample_case() -> dict[str, Any]:
    """A safe synthetic case for the 'Send test' path (no real data)."""
    return {
        "case_id": "case-test-0001",
        "cluster_signature": "test:notification",
        "title": "Test notification from the SOC console",
        "entity": {"type": "ip", "value": "203.0.113.10"},
        "verdict": "TRUE_POSITIVE",
        "confidence": 0.91,
        "disposition": "true_positive",
        "status": "escalated",
        "risk_score": 82.0,
        "rule_ids": ["sample.rule"],
        "summary": "This is a sample notification confirming the channel is configured correctly.",
        "source_name": "Test source",
    }
