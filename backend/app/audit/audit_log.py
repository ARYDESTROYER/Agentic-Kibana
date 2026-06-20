"""The auditability backbone (Section 7.2 / Non-negotiable #2).

Every agent action is appended here, from the first commit. Writes are
best-effort and never raise into the caller: a failed audit write must not break
an investigation, but it is logged loudly. Audit is append-only — documents are
never updated or deleted.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import AUDIT_READ_PATTERN, AUDIT_WRITE_ALIAS, ActionType
from ..es.base import BaseESClient
from ..models import AuditDoc
from ..stores.base import AuditRepository
from ..utils import truncate

logger = logging.getLogger("tlsoc.audit")


class AuditLogger(AuditRepository):
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def write(self, doc: AuditDoc) -> None:
        try:
            await self._es.index_doc(AUDIT_WRITE_ALIAS, doc.model_dump(mode="json"))
        except Exception as exc:  # noqa: BLE001
            logger.error("AUDIT WRITE FAILED (action=%s case=%s): %s",
                         doc.action_type, doc.case_id, exc)

    async def record(
        self,
        *,
        action_type: ActionType,
        surface: str = "",
        actor: str = "",
        case_id: str | None = None,
        model: str | None = None,
        prompt_excerpt: str | None = None,
        query_text: str | None = None,
        tool_name: str | None = None,
        tool_input: Any = None,
        tool_output_summary: str | None = None,
        result_summary: str | None = None,
    ) -> None:
        await self.write(
            AuditDoc(
                action_type=action_type,
                surface=surface,
                actor=actor,
                case_id=case_id,
                model=model,
                prompt_excerpt=truncate(prompt_excerpt, 1000) if prompt_excerpt else None,
                query_text=query_text,
                tool_name=tool_name,
                tool_input=tool_input,
                tool_output_summary=truncate(tool_output_summary, 1000) if tool_output_summary else None,
                result_summary=truncate(result_summary, 1000) if result_summary else None,
            )
        )

    async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        """Read all audit rows for a case, OLDEST first (C3-3 trace timeline).

        Read-only on the management-scoped audit index. Never raises — returns an
        empty list on any error so the trace endpoint NEVER 404s/500s."""
        try:
            resp = await self._es.search(
                AUDIT_READ_PATTERN,
                {
                    "query": {"term": {"case_id": case_id}},
                    "sort": [{"ts": {"order": "asc"}}],
                    "size": limit,
                },
            )
            return [h.get("_source", {}) or {} for h in resp.get("hits", {}).get("hits", [])]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Audit read for case %s failed: %s", case_id, exc)
            return []
