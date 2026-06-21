"""Pure-stdlib log FORMAT parsing → generic dict records.

Push transports (webhook, syslog, queues, object stores) deliver *bytes* in one
of a small set of real-world log formats. This module turns those bytes into a
``list[dict]`` of generic records, which the receivers then hand to
:func:`app.ocsf.generic_to_ocsf` for normalisation. It has ZERO third-party
dependencies — only the standard library — so it works in every environment and
keeps the offline test suite green.

The cardinal rule (non-negotiable #4 spirit: never drop data): a parser NEVER
raises on malformed input. Instead it returns a best-effort single record
``{"message": <raw>, "_parse_error": <reason>}`` so a bad line becomes a
low-fidelity alert rather than a silently-lost one.

Supported formats (the ``detect_format`` vocabulary):
  * ``json``       — a single JSON object/array.
  * ``ndjson``     — newline-delimited JSON (one object per line).
  * ``cef``        — ArcSight Common Event Format.
  * ``leef``       — IBM Log Event Extended Format (1.0 / 2.0).
  * ``syslog5424`` — RFC 5424 structured syslog.
  * ``syslog3164`` — RFC 3164 BSD syslog.
  * ``gelf``       — Graylog Extended Log Format (JSON).
  * ``kv``         — logfmt-style ``key=value`` pairs.
  * ``raw``        — anything else (wrapped as ``{"message": ...}``).
"""

from __future__ import annotations

import json
import re
from typing import Any

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _to_text(payload: str | bytes) -> str:
    """Decode bytes to text leniently (never raise on bad encoding)."""
    if isinstance(payload, bytes):
        return payload.decode("utf-8", errors="replace")
    return payload


def _error_record(raw: str, reason: str) -> dict[str, Any]:
    """A best-effort single record for input we could not parse cleanly."""
    return {"message": raw, "_parse_error": reason}


# --------------------------------------------------------------------------- #
# Detection
# --------------------------------------------------------------------------- #
_CEF_RE = re.compile(r"CEF:\d")
_LEEF_RE = re.compile(r"LEEF:\d")
# RFC 5424: "<PRI>VERSION " where VERSION is a digit, e.g. "<165>1 ".
_SYSLOG5424_RE = re.compile(r"^<\d{1,3}>\d ")
# Any priority-prefixed line "<PRI>" (3164 has no version after the PRI).
_PRI_RE = re.compile(r"^<(\d{1,3})>")


def detect_format(payload: str | bytes) -> str:
    """Best-effort sniff of a payload's log format.

    Returns one of: ``json``, ``ndjson``, ``cef``, ``leef``, ``syslog5424``,
    ``syslog3164``, ``gelf``, ``kv``, ``raw``. Detection is intentionally cheap
    and conservative; ambiguous input falls through to ``raw`` (which still
    yields a record). A ``format_hint`` from the transport always wins over this.
    """
    text = _to_text(payload).strip()
    if not text:
        return "raw"

    # JSON / NDJSON / GELF — structural.
    first = text[0]
    if first in "{[":
        # NDJSON if multiple lines each look like a JSON object.
        lines = [ln for ln in text.splitlines() if ln.strip()]
        if len(lines) > 1 and all(ln.lstrip().startswith("{") for ln in lines):
            # Could be NDJSON or a pretty-printed single object; try whole-parse.
            try:
                json.loads(text)
                obj = json.loads(text)
                return "gelf" if _looks_gelf(obj) else "json"
            except json.JSONDecodeError:
                return "ndjson"
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            return "ndjson" if len(lines) > 1 else "raw"
        return "gelf" if _looks_gelf(obj) else "json"

    # CEF / LEEF — both may be preceded by a syslog header; search anywhere.
    if _LEEF_RE.search(text):
        return "leef"
    if _CEF_RE.search(text):
        return "cef"

    # Syslog — 5424 has an explicit version digit after the PRI.
    if _SYSLOG5424_RE.match(text):
        return "syslog5424"
    if _PRI_RE.match(text):
        return "syslog3164"

    # logfmt — at least one unquoted/quoted key=value token and no spaces-only.
    if re.search(r"\b[\w.\-]+=", text):
        return "kv"

    return "raw"


def _looks_gelf(obj: Any) -> bool:
    """GELF is a JSON object carrying the reserved ``version``/``host``/
    ``short_message`` triad (and conventionally underscore-prefixed extras)."""
    if not isinstance(obj, dict):
        return False
    return "short_message" in obj and ("version" in obj or "host" in obj)


# --------------------------------------------------------------------------- #
# JSON family
# --------------------------------------------------------------------------- #
def parse_json(payload: str | bytes) -> list[dict[str, Any]]:
    """Parse a single JSON document. An array yields one record per element; a
    bare object yields a single record; a JSON scalar is wrapped as a message."""
    text = _to_text(payload).strip()
    if not text:
        return []
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as exc:
        return [_error_record(text, f"json: {exc}")]
    return _coerce_json(obj)


def _coerce_json(obj: Any) -> list[dict[str, Any]]:
    if isinstance(obj, list):
        out: list[dict[str, Any]] = []
        for item in obj:
            if isinstance(item, dict):
                out.append(item)
            else:
                out.append({"message": item if isinstance(item, str) else json.dumps(item)})
        return out
    if isinstance(obj, dict):
        return [obj]
    # Scalar JSON (string/number/bool).
    return [{"message": obj if isinstance(obj, str) else json.dumps(obj)}]


def parse_ndjson(payload: str | bytes) -> list[dict[str, Any]]:
    """Parse newline-delimited JSON: one record per non-empty line.

    A line that is not valid JSON becomes a best-effort error record (the rest of
    the stream is still parsed — one bad line never poisons the batch)."""
    text = _to_text(payload)
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            out.append(_error_record(line, f"ndjson: {exc}"))
            continue
        out.extend(_coerce_json(obj))
    return out


def parse_gelf(payload: str | bytes) -> list[dict[str, Any]]:
    """Parse Graylog Extended Log Format (a JSON object).

    GELF reserves ``short_message``/``full_message``/``host``/``timestamp``/
    ``level`` and prefixes custom fields with ``_``. We surface ``short_message``
    as ``message`` and strip the leading underscore off extras so the generic
    OCSF aliases (``source_ip`` etc.) can find them, while keeping the originals."""
    text = _to_text(payload).strip()
    if not text:
        return []
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as exc:
        return [_error_record(text, f"gelf: {exc}")]
    records = _coerce_json(obj)
    out: list[dict[str, Any]] = []
    for rec in records:
        flat = dict(rec)
        if "short_message" in flat and "message" not in flat:
            flat["message"] = flat.get("short_message")
        # Expose underscore-prefixed GELF extras under their bare names too.
        for key, value in list(rec.items()):
            if key.startswith("_") and len(key) > 1:
                bare = key[1:]
                flat.setdefault(bare, value)
        out.append(flat)
    return out


# --------------------------------------------------------------------------- #
# CEF (ArcSight Common Event Format)
# --------------------------------------------------------------------------- #
# Header: CEF:Version|Device Vendor|Device Product|Device Version|
#         Signature ID|Name|Severity|Extension
# Pipes inside header fields are backslash-escaped; the extension is a sequence
# of key=value pairs where values may contain spaces (terminated by the next
# " key=").
_CEF_KV_RE = re.compile(r"([A-Za-z][\w.\[\]]*)=((?:[^\\=]|\\.)*?)(?=\s+[A-Za-z][\w.\[\]]*=|$)")

# CEF "extension" → friendly alias so generic_to_ocsf can find entities.
_CEF_ALIASES = {
    "src": "source_ip",
    "dst": "dest_ip",
    "dvc": "device_ip",
    "shost": "source_host",
    "dhost": "dest_host",
    "dvchost": "host",
    "suser": "username",
    "duser": "dest_user",
    "msg": "message",
    "act": "action",
    "proto": "protocol",
    "spt": "source_port",
    "dpt": "dest_port",
}


def _unescape_cef(value: str) -> str:
    """Undo CEF backslash escaping (\\| \\= \\\\ \\n \\r)."""
    return (
        value.replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\=", "=")
        .replace("\\|", "|")
        .replace("\\\\", "\\")
    )


def _strip_syslog_prefix(line: str, marker: str) -> str:
    """Drop any leading syslog header so the ``marker`` (``CEF:``/``LEEF:``)
    begins the string we parse."""
    idx = line.find(marker)
    return line[idx:] if idx > 0 else line


def parse_cef(payload: str | bytes) -> list[dict[str, Any]]:
    """Parse one or more ArcSight CEF lines into generic records."""
    text = _to_text(payload)
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(_parse_cef_line(line))
    return out or [_error_record(text.strip(), "cef: empty")]


def _parse_cef_line(line: str) -> dict[str, Any]:
    raw = line
    line = _strip_syslog_prefix(line, "CEF:")
    if not line.startswith("CEF:"):
        return _error_record(raw, "cef: missing CEF: header")
    # Split the 7 header fields, respecting backslash-escaped pipes.
    parts = _split_escaped(line, "|", limit=8)
    if len(parts) < 8:
        return _error_record(raw, f"cef: expected 8 header fields, got {len(parts)}")
    version = parts[0][len("CEF:"):]
    rec: dict[str, Any] = {
        "cef_version": version,
        "vendor": _unescape_cef(parts[1]),
        "product": _unescape_cef(parts[2]),
        "device_version": _unescape_cef(parts[3]),
        "signature_id": _unescape_cef(parts[4]),
        "name": _unescape_cef(parts[5]),
        "severity": _unescape_cef(parts[6]),
        "_raw": raw,
    }
    # The 8th field is the extension (key=value space-separated).
    extension = parts[7]
    for match in _CEF_KV_RE.finditer(extension):
        key = match.group(1)
        value = _unescape_cef(match.group(2).strip())
        rec[key] = value
        alias = _CEF_ALIASES.get(key)
        if alias:
            rec.setdefault(alias, value)
    # CEF severity 0..10 → keep numeric for generic_to_ocsf's severity aliases.
    return rec


def _split_escaped(text: str, sep: str, limit: int) -> list[str]:
    """Split on ``sep`` ignoring backslash-escaped separators, up to ``limit``
    fields (the final field keeps any remaining text, including separators)."""
    out: list[str] = []
    buf: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            buf.append(text[i : i + 2])
            i += 2
            continue
        if ch == sep and len(out) < limit - 1:
            out.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    out.append("".join(buf))
    return out


# --------------------------------------------------------------------------- #
# LEEF (IBM Log Event Extended Format)
# --------------------------------------------------------------------------- #
# LEEF:1.0|Vendor|Product|Version|EventID|<TAB-delimited key=value attrs>
# LEEF:2.0|Vendor|Product|Version|EventID|<delim>|<delimited key=value attrs>
# where <delim> in 2.0 is an optional custom delimiter (default TAB).
_LEEF_ALIASES = {
    "src": "source_ip",
    "dst": "dest_ip",
    "srcPort": "source_port",
    "dstPort": "dest_port",
    "usrName": "username",
    "identSrc": "source_ip",
    "sev": "severity",
    "cat": "category",
    "proto": "protocol",
    "devTime": "timestamp",
}


def parse_leef(payload: str | bytes) -> list[dict[str, Any]]:
    """Parse one or more IBM LEEF (1.0 or 2.0) lines into generic records."""
    text = _to_text(payload)
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(_parse_leef_line(line))
    return out or [_error_record(text.strip(), "leef: empty")]


def _parse_leef_line(line: str) -> dict[str, Any]:
    raw = line
    line = _strip_syslog_prefix(line, "LEEF:")
    if not line.startswith("LEEF:"):
        return _error_record(raw, "leef: missing LEEF: header")
    parts = line.split("|")
    if len(parts) < 5:
        return _error_record(raw, f"leef: expected >=5 header fields, got {len(parts)}")
    version = parts[0][len("LEEF:"):]
    rec: dict[str, Any] = {
        "leef_version": version,
        "vendor": parts[1],
        "product": parts[2],
        "device_version": parts[3],
        "event_id": parts[4],
        "_raw": raw,
    }
    delimiter = "\t"
    attr_start = 5
    if version.startswith("2"):
        # 2.0 may carry an explicit delimiter as the 6th header field.
        if len(parts) >= 6 and len(parts[5]) <= 4 and "=" not in parts[5]:
            delimiter = _resolve_delim(parts[5])
            attr_start = 6
    attrs = "|".join(parts[attr_start:]) if len(parts) > attr_start else ""
    out_pairs = _split_leef_attrs(attrs, delimiter)
    for key, value in out_pairs.items():
        rec[key] = value
        alias = _LEEF_ALIASES.get(key)
        if alias:
            rec.setdefault(alias, value)
    return rec


def _resolve_delim(token: str) -> str:
    """LEEF 2.0 delimiter token → literal char ("x09"/"\\t"/"^"/single char)."""
    token = token.strip()
    if not token:
        return "\t"
    low = token.lower()
    if low in ("\\t", "x09", "0x09", "\\u0009"):
        return "\t"
    if low.startswith("x") and len(low) == 3:
        try:
            return chr(int(low[1:], 16))
        except ValueError:
            return "\t"
    return token[0]


def _split_leef_attrs(attrs: str, delimiter: str) -> dict[str, Any]:
    """Split LEEF attributes on the delimiter (default TAB); fall back to spaces
    when the delimiter is absent (some senders emit space-delimited attrs)."""
    if not attrs:
        return {}
    if delimiter in attrs:
        tokens = attrs.split(delimiter)
    elif "\t" in attrs:
        tokens = attrs.split("\t")
    else:
        # Space-delimited fallback: reuse the logfmt splitter for "k=v k=v".
        return parse_kv(attrs)[0] if parse_kv(attrs) else {}
    out: dict[str, Any] = {}
    for tok in tokens:
        tok = tok.strip()
        if not tok or "=" not in tok:
            continue
        key, _, value = tok.partition("=")
        out[key.strip()] = value.strip()
    return out


# --------------------------------------------------------------------------- #
# Syslog
# --------------------------------------------------------------------------- #
_SEVERITY_NAMES = [
    "emergency", "alert", "critical", "error",
    "warning", "notice", "informational", "debug",
]


def _decode_pri(pri: int) -> tuple[int, int]:
    """A syslog PRI → (facility, severity)."""
    return pri // 8, pri % 8


# RFC 5424: <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP
#           MSGID SP STRUCTURED-DATA [SP MSG]
_SYSLOG5424_HEADER_RE = re.compile(
    r"^<(?P<pri>\d{1,3})>(?P<version>\d)\s+"
    r"(?P<timestamp>\S+)\s+(?P<host>\S+)\s+(?P<app>\S+)\s+"
    r"(?P<procid>\S+)\s+(?P<msgid>\S+)\s+"
)


def parse_syslog_rfc5424(payload: str | bytes) -> list[dict[str, Any]]:
    """Parse one or more RFC 5424 syslog lines into generic records."""
    text = _to_text(payload)
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.rstrip("\n")
        if not line.strip():
            continue
        out.append(_parse_5424_line(line))
    return out or [_error_record(text.strip(), "syslog5424: empty")]


def _parse_5424_line(line: str) -> dict[str, Any]:
    m = _SYSLOG5424_HEADER_RE.match(line)
    if not m:
        return _error_record(line, "syslog5424: header mismatch")
    pri = int(m.group("pri"))
    facility, severity = _decode_pri(pri)
    rest = line[m.end():]
    structured, msg = _split_structured_data(rest)
    rec: dict[str, Any] = {
        "pri": pri,
        "facility": facility,
        "severity": severity,
        "severity_label": _SEVERITY_NAMES[severity] if 0 <= severity < 8 else None,
        "version": m.group("version"),
        "host": _nil(m.group("host")),
        "hostname": _nil(m.group("host")),
        "app": _nil(m.group("app")),
        "appname": _nil(m.group("app")),
        "procid": _nil(m.group("procid")),
        "msgid": _nil(m.group("msgid")),
        "message": msg.strip(),
        "_raw": line,
    }
    ts = _nil(m.group("timestamp"))
    if ts:
        rec["timestamp"] = ts
    if structured:
        rec["structured_data"] = structured
        # Flatten SD-PARAMs to top level for alias discovery.
        for sd_id, params in structured.items():
            for key, value in params.items():
                rec.setdefault(key, value)
    return rec


def _nil(value: str | None) -> str | None:
    """RFC 5424 uses ``-`` for an absent field."""
    if value is None or value == "-":
        return None
    return value


def _split_structured_data(rest: str) -> tuple[dict[str, dict[str, str]], str]:
    """Split the STRUCTURED-DATA element(s) from the trailing MSG.

    Returns ``({sd_id: {param: value, ...}, ...}, msg)``. ``-`` means no SD."""
    rest = rest.lstrip()
    if rest.startswith("-"):
        return {}, rest[1:].lstrip()
    if not rest.startswith("["):
        return {}, rest
    structured: dict[str, dict[str, str]] = {}
    i = 0
    n = len(rest)
    while i < n and rest[i] == "[":
        depth = 0
        start = i
        while i < n:
            ch = rest[i]
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            i += 1
        element = rest[start:i]
        sd_id, params = _parse_sd_element(element)
        if sd_id:
            structured[sd_id] = params
        # Skip optional whitespace between SD elements.
        while i < n and rest[i] == " ":
            i += 1
            break
    msg = rest[i:].lstrip()
    return structured, msg


_SD_PARAM_RE = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')


def _parse_sd_element(element: str) -> tuple[str, dict[str, str]]:
    """Parse one ``[SD-ID param="value" ...]`` element."""
    inner = element.strip()
    if inner.startswith("[") and inner.endswith("]"):
        inner = inner[1:-1]
    inner = inner.strip()
    if not inner:
        return "", {}
    sd_id, _, rest = inner.partition(" ")
    params: dict[str, str] = {}
    for m in _SD_PARAM_RE.finditer(rest):
        params[m.group(1)] = m.group(2).replace('\\"', '"').replace("\\]", "]").replace("\\\\", "\\")
    return sd_id, params


# RFC 3164: <PRI>TIMESTAMP HOSTNAME TAG: MSG
#   where TIMESTAMP is "Mmm dd hh:mm:ss" (BSD) and TAG is "app[pid]".
_SYSLOG3164_RE = re.compile(
    r"^<(?P<pri>\d{1,3})>"
    r"(?P<timestamp>[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+"
    r"(?P<host>\S+)\s+"
    r"(?P<rest>.*)$"
)
_TAG_RE = re.compile(r"^(?P<tag>[\w./\-]+)(?:\[(?P<pid>\d+)\])?:?\s*(?P<msg>.*)$", re.DOTALL)


def parse_syslog_rfc3164(payload: str | bytes) -> list[dict[str, Any]]:
    """Parse one or more RFC 3164 (BSD) syslog lines into generic records.

    Tolerates a missing PRI (some relays strip it) and a missing tag."""
    text = _to_text(payload)
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.rstrip("\n")
        if not line.strip():
            continue
        out.append(_parse_3164_line(line))
    return out or [_error_record(text.strip(), "syslog3164: empty")]


def _parse_3164_line(line: str) -> dict[str, Any]:
    m = _SYSLOG3164_RE.match(line)
    if not m:
        # No PRI/BSD-timestamp: still salvage a record so nothing is dropped.
        pri_m = _PRI_RE.match(line)
        rec: dict[str, Any] = {"message": line, "_raw": line}
        if pri_m:
            pri = int(pri_m.group(1))
            facility, severity = _decode_pri(pri)
            rec.update(
                pri=pri, facility=facility, severity=severity,
                severity_label=_SEVERITY_NAMES[severity] if 0 <= severity < 8 else None,
                message=line[pri_m.end():].strip(),
            )
        else:
            rec["_parse_error"] = "syslog3164: header mismatch"
        return rec
    pri = int(m.group("pri"))
    facility, severity = _decode_pri(pri)
    rec = {
        "pri": pri,
        "facility": facility,
        "severity": severity,
        "severity_label": _SEVERITY_NAMES[severity] if 0 <= severity < 8 else None,
        "timestamp": m.group("timestamp"),
        "host": m.group("host"),
        "hostname": m.group("host"),
        "_raw": line,
    }
    tag_m = _TAG_RE.match(m.group("rest"))
    if tag_m:
        rec["tag"] = tag_m.group("tag")
        rec["app"] = tag_m.group("tag")
        if tag_m.group("pid"):
            rec["procid"] = tag_m.group("pid")
        rec["message"] = tag_m.group("msg").strip()
    else:
        rec["message"] = m.group("rest").strip()
    return rec


# --------------------------------------------------------------------------- #
# logfmt-style key=value
# --------------------------------------------------------------------------- #
# key=value | key="quoted value" | bare keys ignored. Values may be quoted to
# include spaces; numbers are left as strings (generic_to_ocsf coerces).
_KV_RE = re.compile(r'([\w.\-]+)=("(?:[^"\\]|\\.)*"|\'[^\']*\'|[^\s]*)')


def parse_kv(payload: str | bytes) -> list[dict[str, Any]]:
    """Parse logfmt-style ``key=value`` lines (one record per line)."""
    text = _to_text(payload)
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        rec: dict[str, Any] = {}
        for m in _KV_RE.finditer(line):
            key = m.group(1)
            value = m.group(2)
            if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
                value = value[1:-1]
            value = value.replace('\\"', '"').replace("\\\\", "\\")
            rec[key] = value
        if not rec:
            rec = {"message": line}
        else:
            rec.setdefault("_raw", line)
        out.append(rec)
    return out


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #
_PARSERS = {
    "json": parse_json,
    "ndjson": parse_ndjson,
    "cef": parse_cef,
    "leef": parse_leef,
    "syslog5424": parse_syslog_rfc5424,
    "syslog3164": parse_syslog_rfc3164,
    "gelf": parse_gelf,
    "kv": parse_kv,
}

# Friendly hint aliases (Content-Type derived / wizard select values).
_HINT_ALIASES = {
    "auto": None,
    "application/json": "json",
    "text/json": "json",
    "application/x-ndjson": "ndjson",
    "application/ndjson": "ndjson",
    "ndjson": "ndjson",
    "json": "json",
    "cef": "cef",
    "leef": "leef",
    "gelf": "gelf",
    "syslog": "syslog3164",
    "syslog5424": "syslog5424",
    "rfc5424": "syslog5424",
    "syslog3164": "syslog3164",
    "rfc3164": "syslog3164",
    "kv": "kv",
    "logfmt": "kv",
    "raw": "raw",
}


def records_from_payload(payload: str | bytes, hint: str | None = None) -> list[dict[str, Any]]:
    """Turn a raw pushed payload into a list of generic dict records.

    ``hint`` (a Content-Type, a wizard ``format_hint`` value, or a format name)
    forces a parser; ``None``/``auto`` falls back to :func:`detect_format`. The
    result is ALWAYS a non-empty list for non-empty input (malformed bytes yield a
    best-effort record) so no data is ever dropped on the floor.
    """
    fmt = _resolve_hint(hint)
    if fmt is None:
        fmt = detect_format(payload)
    parser = _PARSERS.get(fmt)
    if parser is None:
        # "raw" or unknown — wrap as a single message record.
        text = _to_text(payload).strip()
        return [{"message": text}] if text else []
    records = parser(payload)
    return records


def _resolve_hint(hint: str | None) -> str | None:
    """Normalise a transport hint to a parser key (or ``None`` for auto)."""
    if not hint:
        return None
    h = hint.strip().lower()
    # A Content-Type may carry parameters: "application/json; charset=utf-8".
    h = h.split(";", 1)[0].strip()
    if h in _HINT_ALIASES:
        return _HINT_ALIASES[h]
    if h in _PARSERS:
        return h
    return None
