"""Normalisation INTO OCSF.

``ecs_to_ocsf`` maps an Elasticsearch hit whose ``_source`` follows the Elastic
Common Schema (or the operator's configured field mapping) to an
:class:`OCSFEvent`. ``generic_to_ocsf`` is a best-effort mapper for arbitrary
JSON arriving over a webhook/queue: it reuses the ECS path when the record looks
ECS-shaped, otherwise it probes a wide set of common field aliases.

Both preserve the original record under ``raw_data`` so nothing is lost and the
event stays reproducible/auditable.
"""

from __future__ import annotations

from typing import Any

from ..config import Preferences
from ..constants import (
    OCSF_CAT_FINDINGS,
    OCSF_CAT_IAM,
    OCSF_CAT_NETWORK,
    OCSF_CAT_SYSTEM,
    OCSF_CLASS_AUTHENTICATION,
    OCSF_CLASS_DETECTION_FINDING,
    OCSF_CLASS_FILE_ACTIVITY,
    OCSF_CLASS_HTTP_ACTIVITY,
    OCSF_CLASS_NETWORK_ACTIVITY,
    OCSF_CLASS_PROCESS_ACTIVITY,
    OCSF_CLASS_SECURITY_FINDING,
    SourceType,
)
from ..utils import coerce_float, dotted_get, parse_es_timestamp, to_millis
from .model import Device, Endpoint, Metadata, OCSFEvent, Observable, Product, User, score_to_severity_id


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0] if value else None
    if value is None:
        return None
    return str(value)


def _category_tokens(src: dict[str, Any]) -> list[str]:
    """Lower-cased ECS event.category + event.action + event.type tokens."""
    toks: list[str] = []
    for path in ("event.category", "event.type", "event.action", "event.kind"):
        v = dotted_get(src, path)
        if isinstance(v, list):
            toks += [str(x).lower() for x in v]
        elif v is not None:
            toks.append(str(v).lower())
    return toks


def _classify(src: dict[str, Any]) -> tuple[int, int]:
    """Heuristically pick (category_uid, class_uid) from ECS category tokens.

    Defensive + conservative: unknown shapes fall back to a detection finding,
    which is the safest classification for an alert-centric triage tool.
    """
    toks = _category_tokens(src)
    has = lambda *needles: any(n in t for t in toks for n in needles)  # noqa: E731

    if has("authentication", "logon", "login", "session"):
        return OCSF_CAT_IAM, OCSF_CLASS_AUTHENTICATION
    if dotted_get(src, "url.original") is not None or dotted_get(src, "http.request.method") is not None or has("web", "http"):
        return OCSF_CAT_NETWORK, OCSF_CLASS_HTTP_ACTIVITY
    if has("network", "connection", "flow", "dns"):
        return OCSF_CAT_NETWORK, OCSF_CLASS_NETWORK_ACTIVITY
    if has("process"):
        return OCSF_CAT_SYSTEM, OCSF_CLASS_PROCESS_ACTIVITY
    if has("file"):
        return OCSF_CAT_SYSTEM, OCSF_CLASS_FILE_ACTIVITY
    if has("intrusion_detection", "malware", "threat", "alert"):
        return OCSF_CAT_FINDINGS, OCSF_CLASS_SECURITY_FINDING
    return OCSF_CAT_FINDINGS, OCSF_CLASS_DETECTION_FINDING


def _observables(ip: str | None, user: str | None, host: str | None) -> list[Observable]:
    obs: list[Observable] = []
    if ip:
        obs.append(Observable(name="src_endpoint.ip", type="IP Address", value=ip))
    if user:
        obs.append(Observable(name="actor_user.name", type="User", value=user))
    if host:
        obs.append(Observable(name="device.hostname", type="Hostname", value=host))
    return obs


def ecs_to_ocsf(
    hit: dict[str, Any],
    prefs: Preferences,
    *,
    source_type: SourceType = SourceType.ELASTICSEARCH,
    connector_id: str | None = None,
) -> OCSFEvent:
    """Map one Elasticsearch hit (``{_id,_index,_source}``) to OCSF.

    Field extraction uses the SAME operator-configured mapping as
    ``RawEvent.from_hit`` (``prefs.source_ip_field`` etc.), so any ECS-divergent
    deployment is a config change, not a code change. The rule identity uses the
    rule catalog when present (parity with ``RawEvent.from_hit``).
    """
    src = hit.get("_source", {}) or {}
    uid = str(hit.get("_id", "") or "")
    ts_raw = dotted_get(src, prefs.time_field)
    ts = parse_es_timestamp(ts_raw)

    ip = _as_str(dotted_get(src, prefs.source_ip_field))
    user = _as_str(dotted_get(src, prefs.user_field))
    host = _as_str(dotted_get(src, prefs.host_field))

    fallback_rule = _as_str(dotted_get(src, prefs.rule_field))
    if prefs.rule_catalog:
        matched = prefs.match_rule(src)
        rule = matched.name if matched is not None else fallback_rule
    else:
        rule = fallback_rule
    rule_name = _as_str(dotted_get(src, prefs.rule_name_field))

    severity_score = coerce_float(dotted_get(src, prefs.severity_field), 0.0)
    category_uid, class_uid = _classify(src)
    message = _as_str(dotted_get(src, "message")) or _as_str(dotted_get(src, "event.original")) or ""

    return OCSFEvent(
        category_uid=category_uid,
        class_uid=class_uid,
        severity_id=score_to_severity_id(severity_score),
        time=to_millis(ts) if ts else 0,
        message=message,
        metadata=Metadata(
            source_type=source_type.value,
            connector=connector_id,
            uid=uid,
            original_time=_as_str(ts_raw),
            product=Product(
                name=_as_str(dotted_get(src, "observer.product")) or _as_str(dotted_get(src, "event.module")),
                vendor_name=_as_str(dotted_get(src, "observer.vendor")),
            ),
        ),
        src_endpoint=Endpoint(ip=ip, hostname=_as_str(dotted_get(src, "source.domain"))),
        device=Device(hostname=host, ip=_as_str(dotted_get(src, "host.ip"))),
        actor_user=User(name=user, domain=_as_str(dotted_get(src, "user.domain"))),
        observables=_observables(ip, user, host),
        finding_title=rule_name,
        rule_uid=rule,
        raw_data=src,
    )


# --------------------------------------------------------------------------- #
# Best-effort generic mapping for arbitrary JSON (webhooks / queues)
# --------------------------------------------------------------------------- #
_IP_ALIASES = ("source.ip", "src_endpoint.ip", "src_ip", "source_ip", "srcip", "ip", "client.ip")
_USER_ALIASES = ("user.name", "actor.user.name", "user", "username", "user_name", "account")
_HOST_ALIASES = ("host.name", "device.hostname", "host", "hostname", "computer", "agent.name")
_RULE_ALIASES = ("rule.id", "rule.name", "signature_id", "rule", "signature", "alert.signature", "event.action")
_RULENAME_ALIASES = ("rule.name", "rule.description", "alert.signature", "title", "name")
_SEV_ALIASES = ("event.severity", "severity", "risk_score", "score", "priority", "alert.severity")
_MSG_ALIASES = ("message", "msg", "event.original", "description", "summary", "alert.signature")
_TS_ALIASES = ("@timestamp", "timestamp", "time", "event.created", "eventTime", "_time")


def _first(record: dict[str, Any], aliases: tuple[str, ...]) -> Any:
    for a in aliases:
        v = dotted_get(record, a)
        if v not in (None, ""):
            return v
    return None


def _looks_ecs(record: dict[str, Any]) -> bool:
    return "@timestamp" in record or isinstance(record.get("event"), dict) or isinstance(record.get("source"), dict)


def generic_to_ocsf(
    record: dict[str, Any],
    prefs: Preferences,
    *,
    source_type: SourceType = SourceType.WEBHOOK,
    connector_id: str | None = None,
    uid: str | None = None,
) -> OCSFEvent:
    """Map an arbitrary JSON record to OCSF.

    If the record looks ECS-shaped we reuse the ECS path; otherwise we probe a
    wide alias set for the entities/severity/time the engine needs. The whole
    record is preserved under ``raw_data`` regardless.
    """
    if _looks_ecs(record):
        ev = ecs_to_ocsf({"_id": uid or "", "_source": record}, prefs,
                          source_type=source_type, connector_id=connector_id)
        return ev

    ip = _as_str(_first(record, _IP_ALIASES))
    user = _as_str(_first(record, _USER_ALIASES))
    host = _as_str(_first(record, _HOST_ALIASES))
    rule = _as_str(_first(record, _RULE_ALIASES))
    rule_name = _as_str(_first(record, _RULENAME_ALIASES))
    severity_score = coerce_float(_first(record, _SEV_ALIASES), 0.0)
    message = _as_str(_first(record, _MSG_ALIASES)) or ""
    ts_raw = _first(record, _TS_ALIASES)
    ts = parse_es_timestamp(ts_raw) if ts_raw is not None else None

    return OCSFEvent(
        category_uid=OCSF_CAT_FINDINGS,
        class_uid=OCSF_CLASS_DETECTION_FINDING,
        severity_id=score_to_severity_id(severity_score),
        time=to_millis(ts) if ts else 0,
        message=message,
        metadata=Metadata(
            source_type=source_type.value,
            connector=connector_id,
            uid=uid or _as_str(_first(record, ("id", "_id", "uuid", "event.id"))) or "",
            original_time=_as_str(ts_raw),
        ),
        src_endpoint=Endpoint(ip=ip),
        device=Device(hostname=host),
        actor_user=User(name=user),
        observables=_observables(ip, user, host),
        finding_title=rule_name,
        rule_uid=rule,
        raw_data=record,
    )
