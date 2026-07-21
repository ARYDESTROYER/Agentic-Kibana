"""Privileged, portable application-state export.

The export is intentionally APPLICATION state, not a backup of credentials or raw
upstream logs. Operators select one or more bounded scopes and receive a canonical
JSON attachment that is useful for offline support/analysis. Environment secrets,
connector credentials, auth users/sessions, password/MFA material and raw log payloads
are never traversed. A final recursive guard omits credential-named keys and redacts
common bearer/API-key/private-key patterns from free text.

The endpoint is gated by the dedicated ``data_export:export`` permission (default:
super-admin and SOC manager only), size/count bounded, and append-only audited after
the snapshot is captured. It never calls an LLM and never touches deterministic case
authority (#3).
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, is_dataclass
from enum import Enum
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from ..constants import ActionType
from ..state import AppState
from .deps import current_username, get_state, require_permission

router = APIRouter(prefix="/api")

ExportScope = Literal[
    "all", "cases", "audit", "usage", "configuration", "automation", "knowledge"
]

_SCOPE_ORDER: tuple[str, ...] = (
    "cases", "audit", "usage", "configuration", "automation", "knowledge"
)
_MAX_ITEMS_PER_SCOPE = 5000
_MAX_EXPORT_BYTES = 25 * 1024 * 1024
_MAX_TEXT_CHARS = 250_000

# Exact/suffix checks avoid stripping harmless usage fields such as prompt_tokens.
_SENSITIVE_KEYS = {
    "password", "password_hash", "api_key", "access_key", "secret_access_key",
    "client_secret", "mfa_secret", "totp_secret", "recovery_codes", "credential",
    "credentials", "authorization", "cookie", "set_cookie", "refresh_token",
    "access_token", "id_token", "session_token", "private_key", "connector_secrets",
}
_SENSITIVE_SUFFIXES = (
    "_password", "_password_hash", "_api_key", "_client_secret", "_private_key",
    "_access_token", "_refresh_token", "_session_token",
)

_TEXT_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
)

_EXCLUDED = [
    "environment secrets and API keys",
    "connector credentials",
    "password hashes, MFA material, and recovery codes",
    "user and session registries",
    "browser cookies and bearer tokens",
    "upstream raw log payloads",
]


class DataExportRequest(BaseModel):
    """Selectable export request. ``all`` expands to every safe application scope."""

    scopes: list[ExportScope] = Field(default_factory=lambda: ["all"], min_length=1)
    limit_per_scope: int = Field(default=1000, ge=1, le=_MAX_ITEMS_PER_SCOPE)


def _redact_text(value: str) -> str:
    text = value[:_MAX_TEXT_CHARS]
    for pattern in _TEXT_SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


def _is_sensitive_key(key: Any) -> bool:
    normal = str(key).strip().lower().replace("-", "_")
    return normal in _SENSITIVE_KEYS or normal.endswith(_SENSITIVE_SUFFIXES)


def _plain(value: Any) -> Any:
    """Convert domain models/dataclasses/enums into deterministic JSON primitives."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _redact_text(value)
    if isinstance(value, Enum):
        return _plain(value.value)
    if hasattr(value, "model_dump"):
        return _plain(value.model_dump(mode="json"))
    if hasattr(value, "to_json") and callable(value.to_json):
        return _plain(value.to_json())
    if is_dataclass(value):
        return _plain(asdict(value))
    if isinstance(value, dict):
        return {
            str(key): _plain(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
            if not _is_sensitive_key(key)
        }
    if isinstance(value, (set, frozenset)):
        return [_plain(item) for item in sorted(value, key=lambda item: str(item))]
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return _redact_text(str(value))


def _select_scopes(requested: list[str]) -> list[str]:
    wanted = set(_SCOPE_ORDER if "all" in requested else requested)
    return [scope for scope in _SCOPE_ORDER if scope in wanted]


def _manifest(count: int, total: int | None = None) -> dict[str, Any]:
    known_total = int(total if total is not None else count)
    return {
        "count": int(count),
        "total": known_total,
        "truncated": known_total > int(count),
    }


def _limit_grouped_rows(
    groups: dict[str, list[Any]], limit: int,
) -> dict[str, list[Any]]:
    """Fairly cap a multi-collection scope to ``limit`` total records.

    A round-robin keeps every non-empty collection represented instead of allowing
    the first large collection to consume the whole scope allowance. Group/key order
    is fixed by the caller, so the result remains deterministic and canonical.
    """
    bounded = {name: [] for name in groups}
    if limit <= 0:
        return bounded
    index = 0
    remaining = int(limit)
    while remaining > 0:
        added = False
        for name, rows in groups.items():
            if index >= len(rows):
                continue
            bounded[name].append(rows[index])
            remaining -= 1
            added = True
            if remaining <= 0:
                break
        if not added:
            break
        index += 1
    return bounded


async def _collect_scope(
    scope: str, state: AppState, limit: int,
) -> tuple[Any, dict[str, Any]]:
    if scope == "cases":
        rows, total = await state.cases.list(limit=limit, offset=0)
        return rows, _manifest(len(rows), total)

    if scope == "audit":
        rows = await state.audit.records(limit=limit)
        # AuditRepository has no count query; reaching the hard cap is conservatively
        # marked truncated so an analyst never assumes this is the full ledger.
        meta = _manifest(len(rows), len(rows) + 1 if len(rows) >= limit else len(rows))
        return rows, meta

    if scope == "usage":
        rows = await state.usage_store.records(limit=limit)
        meta = _manifest(len(rows), len(rows) + 1 if len(rows) >= limit else len(rows))
        return rows, meta

    if scope == "configuration":
        # Preferences intentionally contain no secret values; recursive sanitisation
        # remains a second guard. Secrets/credential stores are never touched.
        row = {
            "preferences": state.prefs,
            "demo_active": bool(state.demo_active),
        }
        return row, _manifest(1)

    if scope == "automation":
        proposals = list(await state.proposals.list())
        tuning = list(await state.tuning_store.list())
        campaigns, campaign_total = await state.campaign_store.list(limit=limit)
        batch_jobs = sorted(
            list(await state.batch_job_store.list()),
            key=lambda job: str(getattr(job, "id", "")),
        )
        rule_versions = list(await state.rule_versions.list())
        groups = _limit_grouped_rows({
            "proposals": proposals,
            "tuning": tuning,
            "campaigns": list(campaigns),
            "batch_jobs": batch_jobs,
            "rule_versions": rule_versions,
        }, limit)
        total = (
            len(proposals) + len(tuning) + int(campaign_total) + len(batch_jobs)
            + len(rule_versions)
        )
        count = sum(len(rows) for rows in groups.values())
        return groups, _manifest(count, total)

    if scope == "knowledge":
        memories = list(await state.memory.list(active_only=False))
        documents = list(await state.rag_service.snapshot_documents())
        custom_models = list(await state.custom_models.list_models())
        groups = _limit_grouped_rows({
            "memory": memories,
            # Document metadata only; raw corpus chunks can contain upstream/log or
            # operator-pasted secrets and are deliberately outside portable export.
            "rag_documents": documents,
            "custom_models": custom_models,
        }, limit)
        total = len(memories) + len(documents) + len(custom_models)
        count = sum(len(rows) for rows in groups.values())
        return groups, _manifest(count, total)

    raise ValueError(f"unknown export scope: {scope}")


@router.post("/admin/export")
async def export_application_data(
    body: DataExportRequest,
    state: AppState = Depends(get_state),
    actor: str = Depends(current_username),
    _=Depends(require_permission("data_export", "export")),
) -> Response:
    """Download a bounded, secret-free, canonical JSON snapshot of selected state."""
    scopes = _select_scopes([str(scope) for scope in body.scopes])
    data: dict[str, Any] = {}
    manifest: dict[str, Any] = {}
    for scope in scopes:
        try:
            value, meta = await _collect_scope(scope, state, body.limit_per_scope)
            data[scope] = _plain(value)
            manifest[scope] = meta
        except Exception:  # noqa: BLE001 — one optional scope should not erase the snapshot
            data[scope] = None
            manifest[scope] = {
                "count": 0, "total": 0, "truncated": False, "status": "unavailable"
            }

    envelope = {
        "format": "agentic-soc-portable-export",
        "format_version": 1,
        "selection": {"scopes": scopes},
        "limits": {
            "items_per_scope": int(body.limit_per_scope),
            "max_bytes": _MAX_EXPORT_BYTES,
        },
        "excluded": _EXCLUDED,
        "manifest": manifest,
        "data": data,
    }
    payload = json.dumps(
        envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    if len(payload) > _MAX_EXPORT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                "export exceeds the 25 MiB safety limit; select fewer scopes or "
                "lower limit_per_scope"
            ),
        )

    # Append-only audit AFTER capture so this download does not unexpectedly add
    # itself to its own audit scope. A future export will include the event.
    try:
        await state.control_audit.record(
            action_type=ActionType.DATA_EXPORT,
            surface="settings",
            actor=actor or "local-operator",
            result_summary=f"exported scopes={','.join(scopes)} bytes={len(payload)}",
        )
    except Exception:  # noqa: BLE001 — audit logger is already best-effort
        pass

    return Response(
        content=payload,
        media_type="application/json",
        headers={
            "Content-Disposition": 'attachment; filename="agentic-soc-export.json"',
            "X-Content-Type-Options": "nosniff",
        },
    )
