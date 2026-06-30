"""Notification body rendering (F5 / Wave 7).

Builds the subject + HTML + plain-text body for a :class:`NotificationEvent` from a
:class:`app.models.Case` and a trigger. ALL case/log-derived values are treated as
UNTRUSTED (#9): they are HTML-escaped before entering the HTML body and stripped of
control characters in the plain-text body, so an attacker-controlled rule name /
entity / summary can never inject markup or break the message. The structured
``meta`` carries only derived scalars (severity, risk, verdict, disposition,
case_url, entity) the channels surface; these too are escaped at HTML-render time.

Wave 7 adds:

* A tiny **stdlib mustache-subset renderer** (:func:`render_template`): ``{{var}}``
  is auto HTML-escaped (UNTRUSTED-safe), ``{{{var}}}`` passes through RAW **only for a
  closed WHITELIST of module-built presentation fragments** (``_RAW_TRUSTED_KEYS`` —
  the validated accent colour + the pre-escaped logo block); ANY other ``{{{key}}}``
  (e.g. an operator template referencing an UNTRUSTED case field) is escaped exactly
  like ``{{var}}``, so a malicious operator override can never emit raw case/log HTML.
  ``{{#section}}`` / ``{{^section}}`` are truthiness blocks, dotted dict lookup is
  supported. There is NO ``eval``/``getattr`` — lookups walk plain dicts only. In
  ``text_mode`` (the .txt body) ``{{var}}`` strips CR/LF/tab/control via
  :func:`text_safe`, closing the body line-injection vector.
* Five **preloaded default templates** (``case.new`` / ``case.escalation`` /
  ``case.resolved`` / ``digest.daily`` / ``test``), each with a good-looking HTML
  shell (consuming ``GET /api/branding`` tokens) + a plain-text alternative. An
  operator may override any of the {subject, html, text} parts per trigger via
  ``Preferences.notifications.templates``; a missing part falls back to the default.
* ``header_safe()`` (strip CRLF/control, cap 120) for the Subject + every header
  value, and ``text_safe()`` (strip newlines) for untrusted vars in the .txt part —
  closing header-injection / line-break vectors (#9).
* Deterministic threading headers (``Message-Id`` derived from ``case_id`` on a new
  case; ``In-Reply-To``/``References`` on escalation/resolved; ``X-TLSOC-Case-Id`` /
  ``-Severity`` / ``-Verdict``).

Stdlib ``html.escape`` + ``hashlib`` only — ZERO new deps, no third-party template
engine.
"""

from __future__ import annotations

import hashlib
import html
import re
from typing import Any

# A friendly label per trigger (drives the subject prefix + the default template).
_TRIGGER_LABEL = {
    "case_created": "New case",
    "escalated": "Case escalated",
    "true_positive": "True positive",
    "needs_human": "Needs human review",
    "closed": "Case closed",
    "manual": "Case notification",
    "digest_daily": "Daily digest",
    "test": "Test notification",
}

# Map a dispatch trigger id → the named built-in template id (the design names them
# case.new / case.escalation / case.resolved / digest.daily / test).
_TRIGGER_TEMPLATE = {
    "case_created": "case.new",
    "escalated": "case.escalation",
    "true_positive": "case.escalation",
    "needs_human": "case.escalation",
    "closed": "case.resolved",
    "manual": "case.new",
    "digest_daily": "digest.daily",
    "test": "test",
}

# severity label → Teams theme colour / accent fallback.
_THEME = {"critical": "B00020", "high": "D7263D", "medium": "E08A00", "low": "2E7D32"}


# --------------------------------------------------------------------------- #
# UNTRUSTED-safe scalar helpers.
# --------------------------------------------------------------------------- #
def _plain(value: Any, limit: int = 600) -> str:
    """A plain-text-safe scalar: stringified, control chars stripped, bounded.
    NOT HTML-escaped (used in text bodies + as the source for HTML escaping)."""
    s = "" if value is None else str(value)
    s = "".join(ch for ch in s if ch == "\n" or ch == "\t" or (ord(ch) >= 32))
    return s[:limit]


def _h(value: Any, limit: int = 600) -> str:
    """An HTML-escaped, bounded scalar (UNTRUSTED case/log text → safe HTML)."""
    return html.escape(_plain(value, limit))


def header_safe(value: Any, limit: int = 120) -> str:
    """An EMAIL-HEADER-safe scalar (Subject / X-headers). Strips CR/LF and ALL control
    chars (no header injection / folding), collapses runs of whitespace, caps length.
    The Subject is operator/case-derived → this is the only thing that protects the
    header block from a forged ``\\nBcc:`` etc. (#9)."""
    s = "" if value is None else str(value)
    # Drop every control char (incl. CR/LF/TAB) — headers are single-line.
    s = "".join(ch for ch in s if ord(ch) >= 32 and ord(ch) != 127)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def text_safe(value: Any, limit: int = 600) -> str:
    """A plain-text-PART-safe UNTRUSTED scalar: like :func:`_plain` but ALSO strips
    newlines/tabs so an attacker-controlled var cannot inject new lines into a
    structured ``key: value`` text body. Use for interpolated UNTRUSTED vars; the
    template's OWN literal newlines are added by the template, not the var."""
    s = "" if value is None else str(value)
    s = "".join(" " if ch in "\r\n\t" else ch for ch in s if ord(ch) >= 32 or ch in "\r\n\t")
    s = "".join(ch for ch in s if ord(ch) >= 32)
    return s[:limit]


# --------------------------------------------------------------------------- #
# Mustache-subset renderer (stdlib only — ~80 LOC, NO eval/getattr).
# --------------------------------------------------------------------------- #
# Tokens: {{{raw}}} (triple, raw — TRUSTED only), {{#sec}}…{{/sec}},
# {{^sec}}…{{/sec}} (inverted), {{var}} (escaped). Dotted lookup walks dicts only.
_TOKEN_RE = re.compile(r"\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([#^/]?)\s*([\w.]+)\s*\}\}")

# The ONLY context keys a {{{raw}}} (triple-mustache, unescaped) token may emit
# verbatim. These are presentation fragments this module BUILDS itself (a validated
# #RRGGBB accent colour token + a pre-escaped logo <img>) — never an attacker- or
# operator-supplied free-text field. ANY other {{{key}}} (incl. an operator-template
# referencing title/entity/summary/rule/source_name) is escaped exactly like a
# {{var}}, so a malicious operator override can never emit raw case/log HTML (#9).
_RAW_TRUSTED_KEYS: frozenset[str] = frozenset({"accent_color", "logo_block"})


def _lookup(ctx: dict[str, Any], dotted: str) -> Any:
    """Resolve a dotted key against a plain dict context. Walks DICTS only — never
    ``getattr`` — so a template can never reach into an arbitrary object."""
    cur: Any = ctx
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def _truthy(v: Any) -> bool:
    if v is None or v is False:
        return False
    if isinstance(v, (str, list, tuple, dict)):
        return len(v) > 0
    if isinstance(v, (int, float)):
        return v != 0
    return bool(v)


def render_template(template: str, ctx: dict[str, Any], *, text_mode: bool = False) -> str:
    """Render a mustache-subset ``template`` against the plain-dict ``ctx``.

    * ``{{var}}``  → escaped, UNTRUSTED-safe. In the default HTML mode that is
      ``html.escape(str(value))``; in ``text_mode`` it is :func:`text_safe` (strips
      CR/LF/tab/control) so an attacker-controlled var can never inject raw newlines
      into a structured ``key: value`` .txt body (the template's OWN literal newlines
      are added by the template, not by an interpolated var).
    * ``{{{var}}}`` → raw (NO escaping) ONLY for a tiny WHITELIST of module-built
      presentation fragments (``_RAW_TRUSTED_KEYS`` — the validated accent colour +
      the pre-escaped logo <img>). ANY other ``{{{key}}}`` (e.g. an operator template
      referencing an UNTRUSTED case field) is escaped exactly like a ``{{var}}`` — a
      malicious operator override can never emit raw case/log HTML (#9).
    * ``{{#sec}}…{{/sec}}`` → rendered iff ``sec`` is truthy (no list iteration — a
      truthy dict/str/number just gates the block; the inner context is unchanged).
    * ``{{^sec}}…{{/sec}}`` → rendered iff ``sec`` is FALSY (inverted).

    Missing variables render as the empty string. There is no recursion into objects
    beyond dict lookups, no arbitrary attribute access, and no code evaluation.
    """
    def _escape(val: Any) -> str:
        if val is None:
            return ""
        return text_safe(val) if text_mode else html.escape(str(val))

    out: list[str] = []
    # A stack of (is_rendering,) frames so nested sections suppress correctly.
    render_stack: list[bool] = [True]
    pos = 0
    for m in _TOKEN_RE.finditer(template):
        active = render_stack[-1]
        if active:
            out.append(template[pos:m.start()])
        pos = m.end()
        raw_name = m.group(1)
        sigil = m.group(2)
        name = m.group(3)
        if raw_name is not None:  # {{{raw}}}
            if active:
                val = _lookup(ctx, raw_name)
                # ONLY the module's own trusted presentation fragments pass through
                # unescaped; every other key (incl. operator-referenced UNTRUSTED
                # case fields) is escaped like a normal {{var}} (#9).
                if raw_name in _RAW_TRUSTED_KEYS:
                    out.append("" if val is None else str(val))
                else:
                    out.append(_escape(val))
            continue
        if sigil == "#":  # section open
            val = _lookup(ctx, name)
            render_stack.append(active and _truthy(val))
        elif sigil == "^":  # inverted section open
            val = _lookup(ctx, name)
            render_stack.append(active and not _truthy(val))
        elif sigil == "/":  # section close
            if len(render_stack) > 1:
                render_stack.pop()
        else:  # {{var}} — auto-escaped
            if active:
                out.append(_escape(_lookup(ctx, name)))
    if render_stack[-1]:
        out.append(template[pos:])
    return "".join(out)


def severity_label(risk_score: float, critical_threshold: float = 70.0) -> str:
    """Map a 0..100 risk score to a coarse severity label for routing/colour."""
    try:
        r = float(risk_score)
    except (TypeError, ValueError):
        r = 0.0
    if r >= critical_threshold:
        return "critical"
    if r >= 50.0:
        return "high"
    if r >= 25.0:
        return "medium"
    return "low"


def case_url(base_url: str, case_id: str) -> str:
    base = (base_url or "").rstrip("/")
    if not base:
        return ""
    return f"{base}/cases/{case_id}"


def build_meta(case: Any, trigger: str, *, base_url: str = "") -> dict[str, Any]:
    """Derive the structured scalars channels surface (all UNTRUSTED → plain-safe).
    Reads defensively from a Case (or dict) so a partial case never errors."""
    def g(name: str, default: Any = None) -> Any:
        if isinstance(case, dict):
            return case.get(name, default)
        return getattr(case, name, default)

    entity = g("entity")
    if entity is not None and not isinstance(entity, (str, int, float)):
        etype = getattr(getattr(entity, "type", None), "value", getattr(entity, "type", ""))
        entity_str = f"{etype}:{getattr(entity, 'value', '')}"
    elif isinstance(entity, dict):
        entity_str = f"{entity.get('type', '')}:{entity.get('value', '')}"
    else:
        entity_str = _plain(entity, 200)

    verdict = g("verdict")
    verdict_str = getattr(verdict, "value", verdict) or ""
    disposition = g("disposition")
    disposition_str = getattr(disposition, "value", disposition) or ""
    status = g("status")
    status_str = getattr(status, "value", status) or ""
    risk = g("risk_score", 0.0) or 0.0
    cid = _plain(g("case_id", ""), 120)
    sev_label = severity_label(risk)
    return {
        "case_id": cid,
        "trigger": trigger,
        "entity": entity_str,
        "verdict": _plain(verdict_str, 60),
        "disposition": _plain(disposition_str, 60),
        "status": _plain(status_str, 60),
        "risk_score": round(float(risk), 1),
        "severity": round(float(risk), 1),
        "severity_label": sev_label,
        "theme_color": _THEME.get(sev_label, "555555"),
        "title": _plain(g("title", ""), 300),
        "rule": _plain(", ".join(g("rule_ids", []) or []), 300),
        "source_name": _plain(g("source_name", "") or "", 120),
        "case_url": case_url(base_url, cid),
    }


# The WHITELISTED variable set an operator template may reference. Any key here is
# guaranteed to be derived (UNTRUSTED scalars already plain-cleaned by build_meta /
# escaped by the renderer); a template referencing anything else resolves to "".
_TEMPLATE_VARS = (
    "case_id", "trigger", "entity", "verdict", "disposition", "status",
    "risk_score", "severity", "severity_label", "title", "rule", "source_name",
    "case_url", "label", "confidence", "summary", "org_name", "product_name",
    "logo_data_url", "accent_color", "footer_text", "support_url", "now",
)

# Email-header X-* names → meta keys (deterministic, machine-routable headers).
_X_HEADERS = (
    ("X-TLSOC-Case-Id", "case_id"),
    ("X-TLSOC-Severity", "severity_label"),
    ("X-TLSOC-Verdict", "verdict"),
)


def _message_id(case_id: str, domain: str = "tlsoc.local") -> str:
    """A DETERMINISTIC RFC-5322 Message-Id derived from the case id, so escalation /
    resolved emails for the SAME case thread under the new-case message (same id →
    same In-Reply-To). Empty case → a stable per-domain placeholder."""
    digest = hashlib.sha256((case_id or "no-case").encode("utf-8")).hexdigest()[:32]
    return f"<case-{digest}@{domain}>"


def threading_headers(meta: dict[str, Any], trigger: str) -> dict[str, str]:
    """Deterministic email threading + routing headers for the email channels.

    new-case → sets ``Message-Id`` (the thread root). escalation/resolved → sets
    ``In-Reply-To`` + ``References`` pointing at that same root so a mail client
    threads them under the original. All builds carry the machine ``X-TLSOC-*``
    headers (every value header-safe → no injection)."""
    cid = str(meta.get("case_id") or "")
    root = _message_id(cid)  # already CRLF-free (sha hex + fixed domain)
    headers: dict[str, str] = {}
    if trigger in ("case_created", "manual", "digest_daily", "test"):
        headers["Message-Id"] = root
    else:  # escalation / resolved / verdict transitions thread under the root
        headers["In-Reply-To"] = root
        headers["References"] = root
    # X-* values are case/meta-derived → header_safe each (no injection).
    for hname, key in _X_HEADERS:
        headers[hname] = header_safe(meta.get(key, ""))
    return headers


# --------------------------------------------------------------------------- #
# The 5 preloaded default templates (mustache-subset). Every interpolated case var
# is {{escaped}}; the only {{{raw}}} markers are pre-escaped branded-shell fragments
# (logo block / accent style) built by THIS module — never a raw case field.
# --------------------------------------------------------------------------- #
_SHELL_HEAD = (
    '<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;'
    'margin:0 auto;border:1px solid #e3e6eb;border-radius:10px;overflow:hidden">'
    '<div style="background:{{{accent_color}}};padding:16px 20px;color:#fff">'
    '{{{logo_block}}}<div style="font-size:13px;opacity:.85">{{org_name}} · {{product_name}}</div>'
    '<div style="font-size:20px;font-weight:600;margin-top:2px">{{label}}: {{title}}</div></div>'
    '<div style="padding:20px">'
)
_SHELL_TABLE = (
    '<table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:14px">'
    '<tr><td style="color:#697586"><b>Case</b></td><td>{{case_id}}</td></tr>'
    '<tr><td style="color:#697586"><b>Severity</b></td><td>{{severity_label}} ({{risk_score}})</td></tr>'
    '<tr><td style="color:#697586"><b>Verdict</b></td><td>{{verdict}}</td></tr>'
    '<tr><td style="color:#697586"><b>Disposition</b></td><td>{{disposition}}</td></tr>'
    '<tr><td style="color:#697586"><b>Status</b></td><td>{{status}}</td></tr>'
    '<tr><td style="color:#697586"><b>Entity</b></td><td>{{entity}}</td></tr>'
    '<tr><td style="color:#697586"><b>Rules</b></td><td>{{rule}}</td></tr>'
    "</table>"
)
_SHELL_SUMMARY = '{{#summary}}<p style="margin-top:14px;line-height:1.5">{{summary}}</p>{{/summary}}'
_SHELL_LINK = (
    '{{#case_url}}<p style="margin-top:18px">'
    '<a href="{{case_url}}" style="background:{{{accent_color}}};color:#fff;'
    'text-decoration:none;padding:9px 16px;border-radius:7px;font-size:14px">Open case</a>'
    "</p>{{/case_url}}"
)
_SHELL_FOOT = (
    '{{#footer_text}}<div style="margin-top:18px;padding-top:12px;border-top:1px solid #eee;'
    'color:#98a2b3;font-size:12px">{{footer_text}}</div>{{/footer_text}}</div></div>'
)

_DEFAULT_HTML = _SHELL_HEAD + _SHELL_TABLE + _SHELL_SUMMARY + _SHELL_LINK + _SHELL_FOOT

# A digest variant (no per-case table — a heading + summary list placeholder).
_DIGEST_HTML = (
    _SHELL_HEAD
    + '<p style="line-height:1.5">{{summary}}</p>'
    + _SHELL_LINK
    + _SHELL_FOOT
)

_DEFAULT_TEXT = (
    "{{label}}: {{title}}\n"
    "Case: {{case_id}}\n"
    "Severity: {{severity_label}} ({{risk_score}})\n"
    "Verdict: {{verdict}}\n"
    "Disposition: {{disposition}}\n"
    "Status: {{status}}\n"
    "Entity: {{entity}}\n"
    "Rules: {{rule}}\n"
    "{{#summary}}\n{{summary}}\n{{/summary}}"
    "{{#case_url}}\nOpen: {{case_url}}{{/case_url}}"
)

_DIGEST_TEXT = (
    "{{label}} — {{org_name}}\n\n"
    "{{summary}}\n"
    "{{#case_url}}\nOpen: {{case_url}}{{/case_url}}"
)

_DEFAULT_SUBJECT = "[{{org_name}}] {{label}}: {{title}}"

# id → {subject, html, text}. case.new/escalation/resolved/test share the rich
# shell; digest.daily uses the digest variant.
_BUILTIN_TEMPLATES: dict[str, dict[str, str]] = {
    "case.new": {"subject": _DEFAULT_SUBJECT, "html": _DEFAULT_HTML, "text": _DEFAULT_TEXT},
    "case.escalation": {"subject": _DEFAULT_SUBJECT, "html": _DEFAULT_HTML, "text": _DEFAULT_TEXT},
    "case.resolved": {"subject": _DEFAULT_SUBJECT, "html": _DEFAULT_HTML, "text": _DEFAULT_TEXT},
    "digest.daily": {"subject": _DEFAULT_SUBJECT, "html": _DIGEST_HTML, "text": _DIGEST_TEXT},
    "test": {"subject": _DEFAULT_SUBJECT, "html": _DEFAULT_HTML, "text": _DEFAULT_TEXT},
}


def builtin_template_ids() -> list[str]:
    """The 5 preloaded built-in template ids (for the providers/preview UI)."""
    return list(_BUILTIN_TEMPLATES.keys())


def _logo_block(logo_data_url: str) -> str:
    """A pre-escaped (TRUSTED) logo <img> fragment for the branded shell, or "".

    The data URL is validated upstream (BrandingConfig allows only ``data:image/*``)
    and we ALSO guard here: only an ``http(s)``/``data:image/`` src is emitted, and
    the value is attribute-escaped, so this fragment is safe to inject via {{{raw}}}."""
    src = (logo_data_url or "").strip()
    if not (src.startswith("data:image/") or src.startswith("https://") or src.startswith("http://")):
        return ""
    safe = html.escape(src, quote=True)
    return (
        f'<img src="{safe}" alt="" style="max-height:32px;margin-bottom:6px;display:block">'
    )


def _build_ctx(case: Any, trigger: str, meta: dict[str, Any], *, label: str,
               branding: dict[str, Any] | None) -> dict[str, Any]:
    """Assemble the WHITELISTED, already-plain-cleaned render context. Every value is
    a derived scalar from ``build_meta`` / branding; the renderer escapes each at
    interpolation, so even an UNTRUSTED title/entity/summary is safe in {{var}}."""
    def g(name: str, default: Any = "") -> Any:
        if isinstance(case, dict):
            return case.get(name, default)
        return getattr(case, name, default)

    b = branding or {}
    accent = str(b.get("accent_color") or "").strip()
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", accent):
        accent = "#" + (_THEME.get(meta.get("severity_label", "low"), "555555"))
    summary = _plain(g("summary", "") or g("recommended_action", ""), 1200)
    ctx = {
        # case/meta scalars (UNTRUSTED → escaped by the renderer per-interpolation)
        "case_id": meta["case_id"],
        "trigger": trigger,
        "entity": meta["entity"] or "-",
        "verdict": meta["verdict"] or "-",
        "disposition": meta["disposition"] or "-",
        "status": meta["status"] or "-",
        "risk_score": meta["risk_score"],
        "severity": meta["severity"],
        "severity_label": meta["severity_label"],
        "title": meta["title"] or meta["entity"] or meta["case_id"] or "case",
        "rule": meta["rule"] or "-",
        "source_name": meta["source_name"],
        "case_url": meta["case_url"],
        "label": _plain(label, 80),
        "confidence": round(float(g("confidence", 0.0) or 0.0), 2),
        "summary": summary,
        # branding scalars (operator-controlled, plain)
        "org_name": _plain(b.get("org_name") or "TLSOC", 80),
        "product_name": _plain(b.get("product_name") or "Agentic Triage", 80),
        "accent_color": accent,                       # used inside {{{accent_color}}} (a colour token)
        "footer_text": _plain(b.get("footer_text") or "", 400),
        "support_url": _plain(b.get("support_url") or "", 2000),
        # TRUSTED pre-escaped shell fragment (the ONLY {{{raw}}} HTML var)
        "logo_block": _logo_block(str(b.get("logo_data_url") or "")),
    }
    return ctx


def render(
    case: Any,
    trigger: str,
    *,
    base_url: str = "",
    org_name: str = "TLSOC",
    templates: Any = None,
    branding: Any = None,
) -> dict[str, Any]:
    """Render the full body. Returns ``{subject, html, text, meta, headers}`` — the
    body parts are already UNTRUSTED-safe; the channels deliver them verbatim.

    ``templates`` is the operator's :class:`app.config.NotificationTemplates` (or
    None → built-in defaults). ``branding`` is the :class:`app.config.BrandingConfig`
    (or None → ``org_name`` only). Both are OPTIONAL so existing callers keep working.
    """
    meta = build_meta(case, trigger, base_url=base_url)
    label = _TRIGGER_LABEL.get(trigger, "Case notification")

    # Resolve branding into a plain dict (org_name falls back to the legacy arg).
    if branding is not None:
        bget = (lambda n, d="": branding.get(n, d)) if isinstance(branding, dict) \
            else (lambda n, d="": getattr(branding, n, d))
        bdict = {
            "org_name": bget("org_name", org_name) or org_name,
            "product_name": bget("product_name", "Agentic Triage"),
            "logo_data_url": bget("logo_data_url", ""),
            "accent_color": bget("accent_color", ""),
            "footer_text": bget("footer_text", ""),
            "support_url": bget("support_url", ""),
        }
    else:
        bdict = {"org_name": org_name}

    ctx = _build_ctx(case, trigger, meta, label=label, branding=bdict)

    # Pick the built-in default template, then layer operator overrides per part.
    tid = _TRIGGER_TEMPLATE.get(trigger, "case.new")
    base_tpl = _BUILTIN_TEMPLATES.get(tid, _BUILTIN_TEMPLATES["case.new"])
    subject_tpl = base_tpl["subject"]
    html_tpl = base_tpl["html"]
    text_tpl = base_tpl["text"]
    override = None
    if templates is not None:
        try:
            override = templates.override_for(trigger) if hasattr(templates, "override_for") \
                else (templates.get("overrides", {}) or {}).get(trigger)
        except Exception:  # noqa: BLE001 — a malformed override never breaks rendering
            override = None
    if override is not None:
        oget = (lambda n: override.get(n)) if isinstance(override, dict) \
            else (lambda n: getattr(override, n, None))
        if oget("subject"):
            subject_tpl = str(oget("subject"))
        if oget("html"):
            html_tpl = str(oget("html"))
        if oget("text"):
            text_tpl = str(oget("text"))

    subject = header_safe(render_template(subject_tpl, ctx), 200)
    html_body = render_template(html_tpl, ctx)
    # The .txt body renders in text_mode so interpolated UNTRUSTED vars are run
    # through text_safe() (CR/LF/tab/control stripped) — closing the body line-
    # injection vector (a forged ``Status:``/``Bcc:`` line) the .txt path otherwise
    # left open (#9).
    text_body = render_template(text_tpl, ctx, text_mode=True)

    return {
        "subject": subject,
        "html": html_body,
        "text": text_body,
        "meta": meta,
        "headers": threading_headers(meta, trigger),
    }
