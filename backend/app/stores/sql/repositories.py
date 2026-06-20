"""SQL implementations of the OWN-state repositories (Epoch A).

Each class reproduces the EXACT method signatures + query semantics of its
Elasticsearch counterpart (``CaseStore``/``AuditLogger``/``UsageStore``/
``ConfigStore``/``CursorStore``) so callers need no change. Rich docs are stored
as JSON; only the filter/sort columns are materialised + indexed.

Non-negotiable #2: :class:`SqlAuditRepository` is APPEND-ONLY — it exposes no
update/delete and never mutates a prior row.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from ...config import Preferences
from ...constants import CaseStatus, SourceSurface, ActionType
from ...models import AuditDoc, Case, Cursor, UsageDoc
from ...utils import now_utc, parse_es_timestamp, to_millis, truncate
from ..base import (
    AuditRepository,
    CaseRepository,
    ConfigRepository,
    CursorRepository,
    KVStore,
    UsageRepository,
)
from ..usage import _empty_summary, _top  # reuse the ES summary aggregation helpers
from .models import AuditRow, CaseRow, KVRow, UsageRow

logger = logging.getLogger("tlsoc.stores.sql")

_OPEN_STATUSES = [CaseStatus.OPEN.value, CaseStatus.NEEDS_HUMAN.value]

# Config/cursor namespaces + keys for the KV store (mirror the ES doc ids).
_CONFIG_NS = "config"
_CONFIG_KEY = "preferences"
_CURSOR_NS = "cursor"
_CURSOR_KEY = "primary"


def _sessionmaker(engine: AsyncEngine) -> async_sessionmaker:
    return async_sessionmaker(engine, expire_on_commit=False)


def _entity_value(case: Case) -> str:
    try:
        return case.entity.value or ""
    except Exception:  # noqa: BLE001
        return ""


class SqlCaseRepository(CaseRepository):
    """Cases persisted as JSON with materialised filter/sort columns."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = _sessionmaker(engine)

    async def save(self, case: Case) -> None:
        doc = case.model_dump(mode="json")
        async with self._sm() as session:
            row = await session.get(CaseRow, case.case_id)
            values = dict(
                cluster_signature=case.cluster_signature,
                status=case.status.value if case.status else "",
                source_surface=case.source_surface.value if case.source_surface else "",
                entity_value=_entity_value(case),
                created_at=case.created_at or "",
                updated_at=case.updated_at or "",
                doc=doc,
            )
            if row is None:
                session.add(CaseRow(case_id=case.case_id, **values))
            else:
                for k, v in values.items():
                    setattr(row, k, v)
            await session.commit()

    async def get(self, case_id: str) -> Case | None:
        async with self._sm() as session:
            row = await session.get(CaseRow, case_id)
            return Case.model_validate(row.doc) if row else None

    async def find_open_by_signature(self, signature: str) -> Case | None:
        stmt = (
            select(CaseRow)
            .where(CaseRow.cluster_signature == signature)
            .where(CaseRow.status.in_(_OPEN_STATUSES))
            .order_by(CaseRow.updated_at.desc())
            .limit(1)
        )
        async with self._sm() as session:
            row = (await session.execute(stmt)).scalars().first()
            return Case.model_validate(row.doc) if row else None

    async def list(
        self,
        *,
        status: str | None = None,
        source_surface: str | None = None,
        entity_value: str | None = None,
        limit: int = 50,
        offset: int = 0,
        sort_field: str = "created_at",
        sort_order: str = "desc",
    ) -> tuple[list[Case], int]:
        stmt = select(CaseRow)
        count_stmt = select(func.count()).select_from(CaseRow)
        if status:
            stmt = stmt.where(CaseRow.status == status)
            count_stmt = count_stmt.where(CaseRow.status == status)
        if source_surface:
            stmt = stmt.where(CaseRow.source_surface == source_surface)
            count_stmt = count_stmt.where(CaseRow.source_surface == source_surface)
        if entity_value:
            stmt = stmt.where(CaseRow.entity_value == entity_value)
            count_stmt = count_stmt.where(CaseRow.entity_value == entity_value)

        # Only the materialised columns are sortable; default (created_at) covers
        # the callers. An unknown sort_field falls back to created_at so the query
        # never errors (matching ES tolerance of a missing sort field).
        col = getattr(CaseRow, sort_field, None)
        if col is None or sort_field not in {"created_at", "updated_at", "risk_score"}:
            col = CaseRow.created_at
        stmt = stmt.order_by(col.desc() if sort_order == "desc" else col.asc())
        stmt = stmt.limit(limit).offset(offset)

        async with self._sm() as session:
            rows = (await session.execute(stmt)).scalars().all()
            total = int((await session.execute(count_stmt)).scalar() or 0)
        cases = [Case.model_validate(r.doc) for r in rows]
        return cases, total

    async def list_scans(self, limit: int = 50) -> tuple[list[Case], int]:
        return await self.list(
            source_surface=SourceSurface.AUTOMATED_SCAN.value, limit=limit
        )

    async def count_new_scans(self, since_iso: str) -> int:
        stmt = (
            select(func.count())
            .select_from(CaseRow)
            .where(CaseRow.source_surface == SourceSurface.AUTOMATED_SCAN.value)
            .where(CaseRow.created_at > since_iso)
        )
        async with self._sm() as session:
            return int((await session.execute(stmt)).scalar() or 0)


class SqlAuditRepository(AuditRepository):
    """Append-only audit log. INSERT only — no update/delete path exists."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = _sessionmaker(engine)

    async def write(self, doc: AuditDoc) -> None:
        try:
            payload = doc.model_dump(mode="json")
            async with self._sm() as session:
                session.add(
                    AuditRow(
                        ts=payload.get("ts", "") or "",
                        case_id=payload.get("case_id"),
                        action_type=payload.get("action_type", "") or "",
                        doc=payload,
                    )
                )
                await session.commit()
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
        """All audit rows for a case, OLDEST first (ts asc, id asc tiebreaker)."""
        stmt = (
            select(AuditRow)
            .where(AuditRow.case_id == case_id)
            .order_by(AuditRow.ts.asc(), AuditRow.id.asc())
            .limit(limit)
        )
        try:
            async with self._sm() as session:
                rows = (await session.execute(stmt)).scalars().all()
            return [r.doc or {} for r in rows]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Audit read for case %s failed: %s", case_id, exc)
            return []


class SqlUsageRepository(UsageRepository):
    """Cost/token ledger. Summary aggregates in Python (same as the ES store)."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = _sessionmaker(engine)

    async def write(self, doc: UsageDoc) -> None:
        try:
            payload = doc.model_dump(mode="json")
            async with self._sm() as session:
                session.add(
                    UsageRow(
                        ts=payload.get("ts", "") or "",
                        case_id=payload.get("case_id"),
                        surface=payload.get("surface", "") or "",
                        role=payload.get("role", "") or "",
                        model=payload.get("model", "") or "",
                        cost=float(payload.get("cost", 0.0) or 0.0),
                        total_tokens=int(payload.get("total_tokens", 0) or 0),
                        doc=payload,
                    )
                )
                await session.commit()
        except Exception as exc:  # noqa: BLE001
            logger.error("USAGE WRITE FAILED (role=%s model=%s): %s", doc.role, doc.model, exc)

    async def summary(self, window_hours: int = 24, case_id: str | None = None) -> dict[str, Any]:
        from collections import defaultdict

        now = now_utc()
        from_millis = to_millis(now) - window_hours * 3600 * 1000
        today_start_millis = to_millis(now.replace(hour=0, minute=0, second=0, microsecond=0))

        stmt = select(UsageRow).order_by(UsageRow.ts.asc())
        if case_id:
            stmt = stmt.where(UsageRow.case_id == case_id)
        try:
            async with self._sm() as session:
                rows = (await session.execute(stmt)).scalars().all()
        except Exception as exc:  # noqa: BLE001
            logger.warning("usage summary query failed: %s", exc)
            return _empty_summary(window_hours)

        total_cost = 0.0
        total_tokens = 0
        today_cost = 0.0
        call_count = 0
        by_surface: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
        by_model: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
        by_role: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
        over_time: dict[int, float] = defaultdict(float)

        for row in rows:
            src = row.doc or {}
            ts = parse_es_timestamp(src.get("ts"))
            ts_millis = to_millis(ts) if ts else 0
            # Apply the window filter in Python over the ISO timestamp (ts column is
            # ISO text; we keep the exact ES semantics: ts >= from_millis).
            if ts_millis and ts_millis < from_millis:
                continue
            cost = float(src.get("cost", 0.0) or 0.0)
            tokens = int(src.get("total_tokens", 0) or 0)
            total_cost += cost
            total_tokens += tokens
            call_count += 1
            if ts_millis >= today_start_millis:
                today_cost += cost
            for bucket, key in (
                (by_surface, src.get("surface", "unknown")),
                (by_model, src.get("model", "unknown")),
                (by_role, src.get("role", "unknown")),
            ):
                bucket[key]["cost"] += cost
                bucket[key]["tokens"] += tokens
                bucket[key]["calls"] += 1
            hour = (ts_millis // 3_600_000) * 3_600_000
            over_time[hour] += cost

        return {
            "window_hours": window_hours,
            "total_cost": round(total_cost, 6),
            "total_tokens": total_tokens,
            "today_cost": round(today_cost, 6),
            "call_count": call_count,
            "currency": "USD",
            "by_surface": _top(by_surface),
            "by_model": _top(by_model),
            "by_role": _top(by_role),
            "cost_over_time": [
                {"ts": k, "cost": round(v, 6)} for k, v in sorted(over_time.items())
            ],
            "top_cost_drivers": _top(by_model, limit=5),
        }


class SqlKVStore(KVStore):
    """Single-document key/value persistence (config + cursor)."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = _sessionmaker(engine)

    async def get(self, namespace: str, key: str) -> dict[str, Any] | None:
        async with self._sm() as session:
            row = await session.get(KVRow, (namespace, key))
            return dict(row.value) if row and row.value is not None else None

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        async with self._sm() as session:
            row = await session.get(KVRow, (namespace, key))
            if row is None:
                session.add(KVRow(namespace=namespace, key=key, value=value))
            else:
                row.value = value
            await session.commit()


class SqlConfigStore(ConfigRepository):
    """Preference store over the KV table (mirrors ``ConfigStore``)."""

    def __init__(self, kv: SqlKVStore) -> None:
        self._kv = kv

    async def load(self) -> Preferences:
        try:
            doc = await self._kv.get(_CONFIG_NS, _CONFIG_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading preferences failed (%s); using defaults", exc)
            return Preferences()
        if not doc:
            return Preferences()
        try:
            return Preferences.model_validate(doc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Stored preferences invalid (%s); using defaults", exc)
            return Preferences()

    async def save(self, prefs: Preferences) -> None:
        await self._kv.put(_CONFIG_NS, _CONFIG_KEY, prefs.model_dump(mode="json"))

    async def seed_rule_catalog(self, prefs: Preferences) -> Preferences:
        """First-run seeding of the built-in rule catalog (C3-1). Idempotent."""
        changed = prefs.maybe_seed_rule_catalog()
        if changed:
            logger.info("Seeded built-in rule catalog (%d rules)", len(prefs.rule_catalog))
            try:
                await self.save(prefs)
            except Exception as exc:  # noqa: BLE001 — seeding is best-effort
                logger.warning("Persisting seeded rule catalog failed (%s); continuing", exc)
        return prefs


class SqlCursorStore(CursorRepository):
    """Durable polling cursor over the KV table (mirrors ``CursorStore``)."""

    def __init__(self, kv: SqlKVStore) -> None:
        self._kv = kv

    async def load(self) -> Cursor:
        try:
            doc = await self._kv.get(_CURSOR_NS, _CURSOR_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading cursor failed (%s); starting cold", exc)
            return Cursor()
        if not doc:
            return Cursor()
        try:
            return Cursor.model_validate(doc)
        except Exception:  # noqa: BLE001
            return Cursor()

    async def save(self, cursor: Cursor) -> None:
        await self._kv.put(_CURSOR_NS, _CURSOR_KEY, cursor.model_dump(mode="json"))
