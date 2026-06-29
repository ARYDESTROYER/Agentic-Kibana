"""Notification body rendering (F5).

Builds the subject + HTML + plain-text body for a :class:`NotificationEvent` from a
:class:`app.models.Case` and a trigger. ALL case/log-derived values are treated as
UNTRUSTED (#9): they are HTML-escaped before entering the HTML body and stripped of
control characters in the plain-text body, so an attacker-controlled rule name /
entity / summary can never inject markup or break the message. The structured
``meta`` carries only derived scalars (severity, risk, verdict, disposition,
case_url, entity) the channels surface; these too are escaped at HTML-render time.

Stdlib ``html.escape`` only — ZERO new deps, no template engine.
"""

from __future__ import annotations

import html
from typing import Any

# A friendly label per trigger (drives the subject prefix).
_TRIGGER_LABEL = {
    "case_created": "New case",
    "escalated": "Case escalated",
    "true_positive": "True positive",
    "needs_human": "Needs human review",
    "closed": "Case closed",
    "manual": "Case notification",
    "test": "Test notification",
}

# severity_id-ish 0..10 → label for PagerDuty severity + Teams theme colour.
_THEME = {"critical": "B00020", "high": "D7263D", "medium": "E08A00", "low": "2E7D32"}


def _plain(value: Any, limit: int = 600) -> str:
    """A plain-text-safe scalar: stringified, control chars stripped, bounded.
    NOT HTML-escaped (used in text bodies + as the source for HTML escaping)."""
    s = "" if value is None else str(value)
    s = "".join(ch for ch in s if ch == "\n" or ch == "\t" or (ord(ch) >= 32))
    return s[:limit]


def _h(value: Any, limit: int = 600) -> str:
    """An HTML-escaped, bounded scalar (UNTRUSTED case/log text → safe HTML)."""
    return html.escape(_plain(value, limit))


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


def render(case: Any, trigger: str, *, base_url: str = "", org_name: str = "TLSOC") -> dict[str, Any]:
    """Render the full body. Returns ``{subject, html, text, meta}`` — the body parts
    are already UNTRUSTED-safe; the channels deliver them verbatim."""
    meta = build_meta(case, trigger, base_url=base_url)
    label = _TRIGGER_LABEL.get(trigger, "Case notification")
    title = meta["title"] or meta["entity"] or meta["case_id"] or "case"
    subject = f"[{_plain(org_name, 60)}] {label}: {_plain(title, 160)}"

    def g(name: str, default: Any = "") -> Any:
        if isinstance(case, dict):
            return case.get(name, default)
        return getattr(case, name, default)

    summary = g("summary", "") or g("recommended_action", "")

    # --- plain text (escaped of control chars; safe everywhere) ---------------
    text_lines = [
        f"{label}",
        f"Case: {meta['case_id']}",
        f"Entity: {meta['entity']}",
        f"Verdict: {meta['verdict'] or '-'} (confidence {round(float(g('confidence', 0.0) or 0.0), 2)})",
        f"Disposition: {meta['disposition'] or '-'}",
        f"Status: {meta['status'] or '-'}",
        f"Risk score: {meta['risk_score']}",
        f"Rules: {meta['rule'] or '-'}",
    ]
    if summary:
        text_lines += ["", _plain(summary, 1000)]
    if meta["case_url"]:
        text_lines += ["", f"Open: {meta['case_url']}"]
    text = "\n".join(text_lines)

    # --- HTML (every interpolated value HTML-escaped via _h) ------------------
    link_html = (
        f'<p><a href="{_h(meta["case_url"], 2000)}">Open case</a></p>' if meta["case_url"] else ""
    )
    summary_html = f"<p>{_h(summary, 1000)}</p>" if summary else ""
    html_body = (
        f'<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif">'
        f'<h2 style="margin:0 0 8px">{_h(label, 60)}: {_h(title, 200)}</h2>'
        f'<table cellpadding="4" style="border-collapse:collapse">'
        f"<tr><td><b>Case</b></td><td>{_h(meta['case_id'], 120)}</td></tr>"
        f"<tr><td><b>Entity</b></td><td>{_h(meta['entity'], 200)}</td></tr>"
        f"<tr><td><b>Verdict</b></td><td>{_h(meta['verdict'] or '-', 60)}</td></tr>"
        f"<tr><td><b>Disposition</b></td><td>{_h(meta['disposition'] or '-', 60)}</td></tr>"
        f"<tr><td><b>Status</b></td><td>{_h(meta['status'] or '-', 60)}</td></tr>"
        f"<tr><td><b>Risk score</b></td><td>{_h(meta['risk_score'], 12)}</td></tr>"
        f"<tr><td><b>Rules</b></td><td>{_h(meta['rule'] or '-', 300)}</td></tr>"
        f"</table>{summary_html}{link_html}</div>"
    )

    return {"subject": subject, "html": html_body, "text": text, "meta": meta}
