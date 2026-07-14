"""Offline tests for the notification subsystem (F5 / Wave 4).

No real network: the SMTP transport is injected (``sender=``) and the HTTP poster is
injected (``poster=``). Covers channel rendering safety (#9), email preset resolution,
dispatch trigger evaluation, dedup, rate-limit, secret resolution, and the #3 invariant
that a send failure never raises into the caller.
"""

from __future__ import annotations

import asyncio

import pytest

from app.config import (
    NotificationChannelConfig,
    NotificationConfig,
    NotificationTriggers,
    Preferences,
    Secrets,
)
from app.constants import EntityType, SourceSurface, Verdict
from app.models import Case, Entity
from app.notifications import templates
from app.notifications.channel import NotificationEvent, build_channel, ensure_registered
from app.notifications.dispatch import (
    TRIGGER_CREATED,
    TRIGGER_ESCALATED,
    TRIGGER_MANUAL,
    NotificationService,
)
from app.notifications.email import EmailChannel, resolve_smtp
from app.notifications.webhook import SlackChannel, WebhookChannel


def _case(**over) -> Case:
    base = dict(
        case_id="c1",
        cluster_signature="sig-1",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        verdict=Verdict.TRUE_POSITIVE,
        confidence=0.9,
        risk_score=80.0,
        title="Suspicious login",
        rule_ids=["auth.bruteforce"],
        summary="Many failed logins.",
    )
    base.update(over)
    return Case(**base)


# --------------------------------------------------------------------------- #
# Templates — UNTRUSTED escaping (#9).
# --------------------------------------------------------------------------- #
def test_template_escapes_untrusted_html():
    case = _case(title="<script>alert(1)</script>", summary="<img src=x onerror=1>")
    body = templates.render(case, "case_created", base_url="https://soc.example", org_name="Acme")
    assert "<script>" not in body["html"]
    assert "&lt;script&gt;" in body["html"]
    # plain text keeps the literal but never becomes markup in HTML
    assert "<img" not in body["html"]
    assert body["meta"]["case_url"] == "https://soc.example/cases/c1"
    assert body["subject"].startswith("[Acme]")


def test_template_severity_label():
    assert templates.severity_label(90.0) == "critical"
    assert templates.severity_label(60.0) == "high"
    assert templates.severity_label(30.0) == "medium"
    assert templates.severity_label(5.0) == "low"


# --------------------------------------------------------------------------- #
# Email preset resolution.
# --------------------------------------------------------------------------- #
def test_email_preset_resolution():
    host, port, security, username = resolve_smtp({"provider": "gmail", "username": "me@gmail.com"})
    assert host == "smtp.gmail.com" and port == 587 and security == "starttls"
    assert username == "me@gmail.com"
    # SendGrid pins the username regardless of config.
    _, _, _, sg_user = resolve_smtp({"provider": "sendgrid", "username": "ignored"})
    assert sg_user == "apikey"
    # SES region placeholder filled.
    ses_host, _, _, _ = resolve_smtp({"provider": "ses", "region": "eu-west-1"})
    assert ses_host == "email-smtp.eu-west-1.amazonaws.com"
    # custom uses the explicit host/port/security.
    c_host, c_port, c_sec, _ = resolve_smtp(
        {"provider": "custom", "host": "mail.local", "port": 2525, "security": "none"}
    )
    assert (c_host, c_port, c_sec) == ("mail.local", 2525, "none")


@pytest.mark.asyncio
async def test_email_channel_uses_injected_sender():
    captured = {}

    def fake_sender(**kw):
        captured.update(kw)

    ch = EmailChannel(
        {"provider": "gmail", "from_addr": "soc@x.com", "recipients": ["a@x.com", "b@x.com"]},
        secret="app-password",
        sender=fake_sender,
    )
    body = templates.render(_case(), "case_created")
    ev = NotificationEvent(
        case=_case(), trigger="case_created", subject=body["subject"],
        html=body["html"], text=body["text"], meta=body["meta"],
    )
    res = await ch.send(ev)
    assert res.ok is True
    assert captured["password"] == "app-password"
    assert captured["recipients"] == ["a@x.com", "b@x.com"]
    # the secret never appears in the redacted detail
    assert "app-password" not in res.detail


@pytest.mark.asyncio
async def test_email_channel_missing_config_is_safe():
    ch = EmailChannel({"provider": "gmail"}, sender=lambda **k: None)
    res = await ch.send(NotificationEvent(case=_case(), trigger="t", subject="s", html="", text=""))
    assert res.ok is False
    assert "host" in res.detail or "recipient" in res.detail or "from" in res.detail


@pytest.mark.asyncio
async def test_email_send_failure_never_raises():
    def boom(**kw):
        raise RuntimeError("smtp down")

    ch = EmailChannel(
        {"provider": "gmail", "from_addr": "x@x.com", "recipients": ["a@x.com"]},
        secret="pw", sender=boom,
    )
    res = await ch.send(NotificationEvent(case=_case(), trigger="t", subject="s", html="", text=""))
    assert res.ok is False
    assert "smtp down" not in res.detail  # redacted — only the exception class


# --------------------------------------------------------------------------- #
# HTTP channels (slack / webhook) with an injected poster.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_webhook_and_slack_post_with_injected_poster():
    calls = []

    async def poster(url, *, json=None, content=None, headers=None):
        calls.append((url, json))
        return 200, "ok"

    body = templates.render(_case(), "manual")
    ev = NotificationEvent(case=_case(), trigger="manual", subject=body["subject"],
                           html=body["html"], text=body["text"], meta=body["meta"])

    wh = WebhookChannel({"url": "https://hooks.example/x"}, poster=poster)
    assert (await wh.send(ev)).ok is True

    sl = SlackChannel({}, secret="https://hooks.slack.com/services/XXX", poster=poster)
    res = await sl.send(ev)
    assert res.ok is True
    # the secret URL is never echoed
    assert "hooks.slack.com" not in res.detail
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_http_channel_no_url_is_safe():
    wh = WebhookChannel({}, poster=None)
    res = await wh.send(NotificationEvent(case=_case(), trigger="t", subject="s", html="", text=""))
    assert res.ok is False


def test_registry_builds_all_channel_types():
    ensure_registered()
    for t in ("email", "resend", "slack", "teams", "webhook", "pagerduty", "telegram"):
        assert build_channel(t, {}) is not None
    assert build_channel("nope", {}) is None


def test_resend_in_channel_types():
    from app.notifications.channel import channel_types

    ensure_registered()
    assert "resend" in channel_types()


# --------------------------------------------------------------------------- #
# Dispatch — triggers, floors, dedup, rate-limit, secret resolution.
# --------------------------------------------------------------------------- #
def _prefs_with(channels, **notif_over) -> Preferences:
    notif = NotificationConfig(
        enabled=True,
        channels=channels,
        triggers=NotificationTriggers(**notif_over.pop("triggers", {})),
        **notif_over,
    )
    p = Preferences()
    p.notifications = notif
    return p


class _RecordingSecrets:
    """Minimal secrets stand-in exposing notification_channel_secrets."""

    def __init__(self, mapping):
        self._m = mapping

    def notification_channel_secrets(self, cid):
        return dict(self._m.get(cid, {}))


def _service(prefs, secrets):
    return NotificationService(get_prefs=lambda: prefs, secrets=secrets, cache=None, audit=None)


@pytest.mark.asyncio
async def test_dispatch_disabled_sends_nothing():
    p = Preferences()  # notifications default OFF
    svc = _service(p, _RecordingSecrets({}))
    sent = await svc.notify(_case())
    assert sent == []


@pytest.mark.asyncio
async def test_dispatch_true_positive_trigger_fires():
    captured = []

    async def poster(url, *, json=None, content=None, headers=None):
        captured.append(json)
        return 200, "ok"

    import app.notifications.webhook as wh
    orig = wh._httpx_post
    wh._httpx_post = poster
    try:
        ch = NotificationChannelConfig(id="w1", type="webhook", config={"url": "https://x/y"})
        p = _prefs_with([ch])
        svc = _service(p, _RecordingSecrets({}))
        sent = await svc.notify(_case(verdict=Verdict.TRUE_POSITIVE, risk_score=80.0))
        assert any(r["ok"] for r in sent)
        assert sent[0]["trigger"] == "true_positive"
    finally:
        wh._httpx_post = orig


@pytest.mark.asyncio
async def test_notify_merges_notifications_onto_fresh_case(monkeypatch):
    # audit #28: notify() runs detached, so its case snapshot can be stale. When a fetch
    # callback is provided it must merge notifications_sent onto the FRESH case, not
    # clobber a concurrent edit with the stale snapshot.
    async def poster(url, *, json=None, content=None, headers=None):
        return 200, "ok"

    import app.notifications.webhook as wh
    monkeypatch.setattr(wh, "_httpx_post", poster)
    ch = NotificationChannelConfig(id="w1", type="webhook", config={"url": "https://x/y"})
    p = _prefs_with([ch])
    svc = _service(p, _RecordingSecrets({}))

    stale = _case(verdict=Verdict.TRUE_POSITIVE, risk_score=80.0)
    # A concurrent analyst edit landed AFTER our stale snapshot was taken.
    store = {stale.case_id: stale.model_copy(update={"assignee": "alice"})}

    async def fetch(cid):
        return store.get(cid)

    async def save(c):
        store[c.case_id] = c

    sent = await svc.notify(stale, save=save, fetch=fetch)
    assert any(r["ok"] for r in sent)
    saved = store[stale.case_id]
    assert saved.assignee == "alice", "the concurrent edit was clobbered by the stale snapshot"
    assert saved.notifications_sent, "notifications_sent was not persisted"


@pytest.mark.asyncio
async def test_on_case_created_trigger_fires_once(monkeypatch):
    # audit #29: enabling on_case_created must actually send (it was dead), and only once
    # per case (a later notify doesn't re-fire it).
    async def poster(url, *, json=None, content=None, headers=None):
        return 200, "ok"

    import app.notifications.webhook as wh
    monkeypatch.setattr(wh, "_httpx_post", poster)
    ch = NotificationChannelConfig(id="w1", type="webhook", config={"url": "https://x/y"})
    # Turn OFF the other triggers so only case_created can fire.
    p = _prefs_with([ch], triggers={
        "on_case_created": True, "on_true_positive": False, "on_escalated": False,
        "on_needs_human": False, "on_closed": False,
    })
    svc = _service(p, _RecordingSecrets({}))
    case = _case()  # open, no prior notifications
    sent = svc._triggers_for_case(case, p.notifications)
    assert TRIGGER_CREATED in sent

    out = await svc.dispatch(case, TRIGGER_CREATED)
    assert any(r["ok"] for r in out)

    # Once a case_created notification is recorded, it must NOT re-fire.
    case.notifications_sent = [{"trigger": TRIGGER_CREATED, "channel_id": "w1", "ok": True}]
    assert TRIGGER_CREATED not in svc._triggers_for_case(case, p.notifications)


@pytest.mark.asyncio
async def test_dispatch_respects_min_risk_floor():
    ch = NotificationChannelConfig(id="w1", type="webhook", config={"url": "https://x/y"})
    p = _prefs_with([ch], triggers={"min_risk": 90.0})
    svc = _service(p, _RecordingSecrets({}))
    sent = await svc.notify(_case(risk_score=10.0))
    assert sent == []


@pytest.mark.asyncio
async def test_dispatch_dedup_within_window():
    async def poster(url, *, json=None, content=None, headers=None):
        return 200, "ok"

    ch = NotificationChannelConfig(id="w1", type="webhook", config={"url": "https://x/y"})
    p = _prefs_with([ch], dedup_window_seconds=300)
    svc = _service(p, _RecordingSecrets({}))
    case = _case()
    s1 = await svc.dispatch(case, TRIGGER_ESCALATED, channel_ids=None, check_triggers=True)
    s2 = await svc.dispatch(case, TRIGGER_ESCALATED, channel_ids=None, check_triggers=True)
    # first emits, second deduped (no record)
    assert len(s1) == 1
    assert len(s2) == 0


@pytest.mark.asyncio
async def test_dispatch_rate_limit():
    ch = NotificationChannelConfig(id="w1", type="webhook", config={"url": "https://x/y"})
    p = _prefs_with([ch], rate_limit_per_hour=1, dedup_window_seconds=0)
    svc = _service(p, _RecordingSecrets({}))
    # patch the channel send to always succeed by injecting a poster on the module
    import app.notifications.webhook as wh
    orig = wh._httpx_post

    async def poster(url, *, json=None, content=None, headers=None):
        return 200, "ok"

    wh._httpx_post = poster
    try:
        first = await svc.dispatch(_case(), TRIGGER_MANUAL, check_triggers=True)
        second = await svc.dispatch(_case(), TRIGGER_MANUAL, check_triggers=True)
        assert first and first[0]["ok"]
        assert second and second[0]["ok"] is False and "rate" in second[0]["detail"]
    finally:
        wh._httpx_post = orig


@pytest.mark.asyncio
async def test_dispatch_resolves_secret_for_slack():
    captured = {}

    async def poster(url, *, json=None, content=None, headers=None):
        captured["url"] = url
        return 200, "ok"

    import app.notifications.webhook as wh
    orig = wh._httpx_post
    wh._httpx_post = poster
    try:
        ch = NotificationChannelConfig(id="s1", type="slack", config={})
        p = _prefs_with([ch])
        secrets = _RecordingSecrets({"s1": {"secret": "https://hooks.slack.com/SECRET"}})
        svc = _service(p, secrets)
        sent = await svc.dispatch(_case(), TRIGGER_MANUAL, check_triggers=False)
        assert sent[0]["ok"] is True
        assert captured["url"] == "https://hooks.slack.com/SECRET"
        # secret never appears in the returned detail
        assert "SECRET" not in sent[0]["detail"]
    finally:
        wh._httpx_post = orig


@pytest.mark.asyncio
async def test_test_channel_sends_sample():
    captured = []

    async def poster(url, *, json=None, content=None, headers=None):
        captured.append(json)
        return 200, "ok"

    import app.notifications.webhook as wh
    orig = wh._httpx_post
    wh._httpx_post = poster
    try:
        ch = NotificationChannelConfig(id="w1", type="webhook", config={"url": "https://x/y"})
        p = _prefs_with([ch])
        svc = _service(p, _RecordingSecrets({}))
        res = await svc.test_channel("w1")
        assert res["ok"] is True
        assert captured and captured[0]["trigger"] == "test"
    finally:
        wh._httpx_post = orig


@pytest.mark.asyncio
async def test_notify_never_raises_on_bad_prefs():
    # get_prefs raises → notify swallows and returns []
    def boom():
        raise RuntimeError("nope")

    svc = NotificationService(get_prefs=boom, secrets=_RecordingSecrets({}), cache=None, audit=None)
    assert await svc.notify(_case()) == []
