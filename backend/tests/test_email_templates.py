"""Offline tests for the Wave-7 email subsystem: Resend channel, the SES SMTP
password derivation, the mustache-subset template renderer, header/text safety, and
the 5 preloaded default templates.

No real network: the HTTP poster is injected (``poster=``) and the SMTP transport is
injected (``sender=``). Covers the #9 escaping invariants (auto-escape, header-injection,
text newline-stripping, the {{{raw}}} marker only for the trusted header) and the #10
secret invariant (the API key never leaks into ``SendResult.detail``).
"""

from __future__ import annotations

import base64

import pytest

from app.config import (
    BrandingConfig,
    NotificationTemplateOverride,
    NotificationTemplates,
)
from app.constants import EntityType, SourceSurface, Verdict
from app.models import Case, Entity
from app.notifications import templates
from app.notifications.channel import (
    NotificationEvent,
    channel_types,
    ensure_registered,
)
from app.notifications.email import derive_ses_smtp_password
from app.notifications.resend import ResendChannel


def _case(**over) -> Case:
    base = dict(
        case_id="c-7",
        cluster_signature="sig-7",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="9.9.9.9"),
        verdict=Verdict.TRUE_POSITIVE,
        confidence=0.88,
        risk_score=84.0,
        title="Suspicious login",
        rule_ids=["auth.bruteforce"],
        summary="Many failed logins.",
    )
    base.update(over)
    return Case(**base)


# --------------------------------------------------------------------------- #
# Mustache-subset renderer — auto-escape + sections + dotted lookup.
# --------------------------------------------------------------------------- #
def test_renderer_autoescapes_untrusted_var():
    out = templates.render_template("Hello {{x}}", {"x": "<script>alert(1)</script>"})
    assert "<script>" not in out
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in out


def test_renderer_escapes_mustache_in_untrusted_var():
    # A var whose VALUE contains {{ }} must NOT be re-interpreted as a token — it is
    # escaped as data, never parsed as a second pass.
    out = templates.render_template("{{x}}", {"x": "{{org_name}} and {{{logo_block}}}"})
    assert "{{org_name}}" in out  # the braces survive as literal data
    assert "org_name" in out and "logo_block" in out
    # nothing was substituted from the context
    assert out.count("{{") >= 1


def test_renderer_raw_marker_is_not_escaped():
    out = templates.render_template("{{{raw}}}", {"raw": "<b>ok</b>"})
    assert out == "<b>ok</b>"  # TRUSTED raw HTML passes through


def test_renderer_sections_truthy_and_inverted():
    # a is truthy, b is falsy: #a renders, ^a suppressed, #b suppressed.
    tpl = "{{#a}}A{{/a}}{{^a}}NOA{{/a}}{{#b}}B{{/b}}"
    assert templates.render_template(tpl, {"a": "x", "b": ""}) == "A"
    assert templates.render_template("{{#a}}A{{/a}}", {"a": True}) == "A"
    assert templates.render_template("{{#a}}A{{/a}}", {"a": False}) == ""
    assert templates.render_template("{{^a}}N{{/a}}", {"a": ""}) == "N"
    assert templates.render_template("{{^a}}N{{/a}}", {"a": "set"}) == ""


def test_renderer_dotted_lookup_dicts_only():
    out = templates.render_template("{{a.b}}", {"a": {"b": "deep"}})
    assert out == "deep"
    # a non-dict intermediate resolves to "" (no getattr / no crash)
    assert templates.render_template("{{a.b}}", {"a": "scalar"}) == ""
    assert templates.render_template("{{missing}}", {}) == ""


# --------------------------------------------------------------------------- #
# header_safe / text_safe — header-injection + newline stripping (#9).
# --------------------------------------------------------------------------- #
def test_header_safe_strips_crlf_header_injection():
    evil = "Subject line\r\nBcc: attacker@evil.com\nX-Injected: 1"
    safe = templates.header_safe(evil)
    assert "\r" not in safe and "\n" not in safe
    assert "Bcc:" in safe  # the text survives, but on ONE line (no new header)
    assert safe.count(":") >= 1
    # capped to 120 by default
    assert len(templates.header_safe("a" * 500)) <= 120


def test_text_safe_strips_newlines_from_untrusted():
    val = "line1\nline2\r\nline3\tafter-tab"
    safe = templates.text_safe(val)
    assert "\n" not in safe and "\r" not in safe and "\t" not in safe
    assert "line1" in safe and "line3" in safe


# --------------------------------------------------------------------------- #
# The 5 preloaded default templates render with a fixture.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "trigger",
    ["case_created", "escalated", "closed", "digest_daily", "test"],
)
def test_each_default_template_renders(trigger):
    branding = BrandingConfig(org_name="Acme", accent_color="#123456",
                              footer_text="CONFIDENTIAL")
    body = templates.render(
        _case(title="<script>x</script>"), trigger,
        base_url="https://soc.example", org_name="Acme", branding=branding,
    )
    assert body["subject"].startswith("[Acme]")
    assert "<script>" not in body["html"]  # untrusted title escaped
    assert "&lt;script&gt;" in body["html"]
    assert body["text"]  # a plain-text alternative exists
    assert "case-" in (body["headers"].get("Message-Id", "")
                       + body["headers"].get("In-Reply-To", ""))
    # X-headers present + machine-routable
    assert body["headers"].get("X-TLSOC-Severity")
    assert body["headers"].get("X-TLSOC-Verdict") == "TRUE_POSITIVE"


def test_builtin_template_ids_are_the_five():
    ids = set(templates.builtin_template_ids())
    assert ids == {"case.new", "case.escalation", "case.resolved", "digest.daily", "test"}


def test_default_html_uses_raw_only_for_trusted_shell():
    # The branded shell injects the accent colour + logo block via {{{raw}}}; a
    # case-derived title is NEVER raw. A malicious logo_data_url is rejected (no img).
    branding = BrandingConfig(org_name="Acme", accent_color="#abcdef")
    body = templates.render(_case(title="<img src=x onerror=alert(1)>"), "case_created",
                            branding=branding)
    # The dangerous title is HTML-escaped — there is NO live <img tag (the literal
    # "onerror" survives only as harmless escaped text, never inside a real element).
    assert "<img src=x onerror" not in body["html"]
    assert "&lt;img src=x onerror=alert(1)&gt;" in body["html"]
    assert "#abcdef" in body["html"]       # accent colour passed through the trusted shell


def test_logo_block_rejects_non_image_src():
    # A javascript:/text src is rejected (no <img>); a data:image/ src is allowed.
    assert templates._logo_block("javascript:alert(1)") == ""
    assert templates._logo_block("not a url") == ""
    img = templates._logo_block("data:image/png;base64,AAAA")
    assert img.startswith("<img") and "data:image/png" in img


def test_threading_headers_thread_under_root():
    new = templates.render(_case(), "case_created")
    esc = templates.render(_case(), "escalated")
    res = templates.render(_case(), "closed")
    root = new["headers"]["Message-Id"]
    assert esc["headers"]["In-Reply-To"] == root
    assert res["headers"]["References"] == root


def test_operator_override_falls_back_per_part():
    tpls = NotificationTemplates(overrides={
        "case_created": NotificationTemplateOverride(subject="CUSTOM {{title}}"),
    })
    body = templates.render(_case(title="hi"), "case_created", templates=tpls)
    assert body["subject"].startswith("CUSTOM hi")
    # html/text fall back to the built-in default (still escaped)
    assert "<table" in body["html"]


def test_operator_override_still_escapes_untrusted():
    # Even an operator template auto-escapes interpolated case vars (#9).
    tpls = NotificationTemplates(overrides={
        "case_created": NotificationTemplateOverride(html="<p>{{title}}</p>"),
    })
    body = templates.render(_case(title="<script>x</script>"), "case_created", templates=tpls)
    assert "<script>" not in body["html"]
    assert "&lt;script&gt;" in body["html"]


# --------------------------------------------------------------------------- #
# Resend channel — self-registers, sends via injected poster, never leaks key (#10).
# --------------------------------------------------------------------------- #
def test_resend_self_registers():
    ensure_registered()
    assert "resend" in channel_types()


@pytest.mark.asyncio
async def test_resend_send_ok_via_injected_poster():
    captured = {}

    async def poster(url, *, json=None, content=None, headers=None):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return 200, '{"id": "re_abc123"}'

    ch = ResendChannel(
        {"from_addr": "soc@acme.com", "recipients": ["a@x.com", "b@x.com"]},
        secret="re_SECRET_KEY",
        poster=poster,
    )
    body = templates.render(_case(), "case_created", org_name="Acme")
    ev = NotificationEvent(
        case=_case(), trigger="case_created", subject=body["subject"],
        html=body["html"], text=body["text"], meta=body["meta"],
        headers=body.get("headers") or {},
    )
    res = await ch.send(ev)
    assert res.ok is True
    assert captured["url"] == "https://api.resend.com/emails"
    assert captured["headers"]["Authorization"] == "Bearer re_SECRET_KEY"
    assert captured["headers"]["User-Agent"]
    assert captured["headers"]["Idempotency-Key"].startswith("case-notify/")
    assert captured["json"]["to"] == ["a@x.com", "b@x.com"]
    # #10: the API key NEVER appears in the audited detail; the message id MAY.
    assert "re_SECRET_KEY" not in res.detail
    assert "re_abc123" in res.detail


@pytest.mark.asyncio
async def test_resend_missing_key_is_safe():
    ch = ResendChannel({"from_addr": "x@x.com", "recipients": ["a@x.com"]}, secret="")
    res = await ch.send(NotificationEvent(case=_case(), trigger="t", subject="s",
                                          html="", text=""))
    assert res.ok is False
    assert "API key" in res.detail
    assert "re_" not in res.detail


@pytest.mark.asyncio
async def test_resend_does_not_retry_on_4xx():
    calls = {"n": 0}

    async def poster(url, *, json=None, content=None, headers=None):
        calls["n"] += 1
        return 422, '{"name": "validation_error"}'

    ch = ResendChannel({"from_addr": "x@x.com", "recipients": ["a@x.com"]},
                       secret="k", poster=poster)
    res = await ch.send(NotificationEvent(case=_case(), trigger="t", subject="s",
                                          html="", text=""))
    assert res.ok is False
    assert calls["n"] == 1  # NO retry on a 4xx config/quota error
    assert "HTTP 422" in res.detail


@pytest.mark.asyncio
async def test_resend_retries_on_429_then_succeeds():
    seq = [(429, '{"name":"rate_limit_exceeded"}'), (200, '{"id":"re_ok"}')]
    calls = {"n": 0}

    async def poster(url, *, json=None, content=None, headers=None):
        s, t = seq[min(calls["n"], len(seq) - 1)]
        calls["n"] += 1
        return s, t

    async def no_sleep(_):  # don't actually wait
        return None

    ch = ResendChannel({"from_addr": "x@x.com", "recipients": ["a@x.com"]},
                       secret="k", poster=poster, sleeper=no_sleep)
    res = await ch.send(NotificationEvent(case=_case(), trigger="t", subject="s",
                                          html="", text=""))
    assert res.ok is True
    assert calls["n"] == 2  # one retry after the 429


@pytest.mark.asyncio
async def test_resend_send_never_raises_on_poster_error():
    async def boom(url, *, json=None, content=None, headers=None):
        raise RuntimeError("connreset")

    ch = ResendChannel({"from_addr": "x@x.com", "recipients": ["a@x.com"]},
                       secret="k", poster=boom)
    res = await ch.send(NotificationEvent(case=_case(), trigger="t", subject="s",
                                          html="", text=""))
    assert res.ok is False
    assert "connreset" not in res.detail  # redacted


# --------------------------------------------------------------------------- #
# SES SMTP-password derivation — matches a known stdlib HMAC vector.
# --------------------------------------------------------------------------- #
def _reference_ses_password(secret: str, region: str) -> str:
    import hashlib
    import hmac

    def sign(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    sig = sign(("AWS4" + secret).encode("utf-8"), "11111111")
    sig = sign(sig, region)
    sig = sign(sig, "ses")
    sig = sign(sig, "aws4_request")
    sig = sign(sig, "SendRawEmail")
    return base64.b64encode(bytes([0x04]) + sig).decode("ascii")


def test_ses_smtp_password_matches_reference_vector():
    secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    region = "us-east-1"
    derived = derive_ses_smtp_password(secret, region)
    assert derived == _reference_ses_password(secret, region)
    # A different region yields a different password (the ladder includes region).
    assert derive_ses_smtp_password(secret, "eu-west-1") != derived
    # Always a base64 string with the version-byte prefix decoding to 0x04.
    raw = base64.b64decode(derived)
    assert raw[0] == 0x04 and len(raw) == 33  # 1 version byte + 32-byte HMAC


@pytest.mark.asyncio
async def test_ses_email_channel_derives_password():
    from app.notifications.email import EmailChannel

    captured = {}

    def fake_sender(**kw):
        captured.update(kw)

    ch = EmailChannel(
        {"provider": "ses", "region": "us-east-1",
         "aws_access_key_id": "AKIAEXAMPLE",
         "from_addr": "soc@acme.com", "recipients": ["a@x.com"]},
        secret="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        sender=fake_sender,
    )
    body = templates.render(_case(), "case_created")
    ev = NotificationEvent(case=_case(), trigger="case_created", subject=body["subject"],
                           html=body["html"], text=body["text"], meta=body["meta"],
                           headers=body.get("headers") or {})
    res = await ch.send(ev)
    assert res.ok is True
    # username = the access-key id; password = the DERIVED SMTP password (not the IAM key)
    assert captured["username"] == "AKIAEXAMPLE"
    assert captured["password"] == _reference_ses_password(
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1")
    assert captured["password"] != "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    # threading headers reached the sender
    assert captured["headers"].get("Message-Id", "").startswith("<case-")
