"""Per-case TASK / checklist store — case action items (Round 3 collaboration).

A case TASK (:class:`app.models.CaseTask`) is one checklist item on a case
(open→in_progress→done/blocked) with a stable manual ``order`` and an append-only
``logs`` note trail. It is operator collaboration data — advisory only, it NEVER
feeds ``case_manager.decide()`` (#3), and every ``title``/log ``note`` is plain,
render-escaped data (#9).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory`): the WHOLE task set is ONE KV document
(``ns=CASE_TASKS_NS``, ``key=CASE_TASKS_KEY``) whose value is
``{"tasks": {"<case_id>": [<CaseTask json>, ...], ...}}`` — so it needs NO new ES
index / SQL table / migration. The SQL backend uses ``SqlKVStore``; the ES backend
uses the thin :class:`app.stores.memory.EsKVStore` adapter.

Reads + writes are read-modify-write over the single dict. The store NEVER raises:
a failure degrades to an empty task list / best-effort write and is logged.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import CASE_TASKS_KEY, CASE_TASKS_NS
from ..models import CaseTask
from ..utils import iso_now
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.case_tasks")


def _norm_case_id(case_id: str | None) -> str:
    return (case_id or "").strip()


class CaseTaskStore:
    """CRUD + reorder + log over per-case task lists, persisted as one KV document.

    The KV value is ``{"tasks": {"<case_id>": [<CaseTask json>, ...]}}``. Methods are
    read-modify-write; none raises (a failure logs + returns a safe default). Tasks
    within a case are kept sorted by ``order`` (stable, then by creation)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def _load_all(self) -> dict[str, list[CaseTask]]:
        try:
            doc = await self._kv.get(CASE_TASKS_NS, CASE_TASKS_KEY)
        except Exception as exc:  # noqa: BLE001 — tasks are best-effort
            logger.warning("Loading case tasks failed (%s); using empty set", exc)
            return {}
        if not doc:
            return {}
        raw = doc.get("tasks", {}) if isinstance(doc, dict) else {}
        out: dict[str, list[CaseTask]] = {}
        for cid, items in (raw or {}).items():
            tasks: list[CaseTask] = []
            for item in items or []:
                try:
                    tasks.append(CaseTask.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt task, keep the rest
                    continue
            out[str(cid)] = tasks
        return out

    async def _save_all(self, all_tasks: dict[str, list[CaseTask]]) -> None:
        try:
            await self._kv.put(
                CASE_TASKS_NS, CASE_TASKS_KEY,
                {"tasks": {cid: [t.model_dump(mode="json") for t in tasks]
                           for cid, tasks in all_tasks.items()}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting case tasks failed (%s); continuing", exc)

    @staticmethod
    def _sorted(tasks: list[CaseTask]) -> list[CaseTask]:
        # Stable sort by manual order, then creation time — a fresh task (order=0)
        # appended after others keeps a deterministic position until reordered.
        return sorted(tasks, key=lambda t: (t.order, t.created_at))

    async def list_for_case(self, case_id: str | None) -> list[CaseTask]:
        """Every task for a case, sorted by manual ``order`` then creation time."""
        cid = _norm_case_id(case_id)
        if not cid:
            return []
        return self._sorted(list((await self._load_all()).get(cid, [])))

    async def get(self, case_id: str | None, task_id: str) -> CaseTask | None:
        for t in await self.list_for_case(case_id):
            if t.id == task_id:
                return t
        return None

    async def add(self, case_id: str | None, title: str, *, assignee: str | None = None,
                  status: str = "open") -> CaseTask:
        """Create a task on a case (appended at the END — its ``order`` is set past the
        current max so it lands last). ``title`` is plain data (#9)."""
        cid = _norm_case_id(case_id)
        if not cid:
            raise ValueError("case_id is required")
        all_tasks = await self._load_all()
        tasks = list(all_tasks.get(cid, []))
        next_order = (max((t.order for t in tasks), default=-1) + 1) if tasks else 0
        task = CaseTask(
            case_id=cid, title=(title or "").strip(), assignee=assignee,
            status=status if status in ("open", "in_progress", "done", "blocked") else "open",
            order=next_order,
        )
        tasks.append(task)
        all_tasks[cid] = tasks
        await self._save_all(all_tasks)
        return task

    async def update(self, case_id: str | None, task_id: str, **fields: Any) -> CaseTask | None:
        """Patch the provided (non-None) fields on a task. Allowed: ``title``,
        ``assignee``, ``status``, ``order``. Returns the updated task, or None."""
        cid = _norm_case_id(case_id)
        all_tasks = await self._load_all()
        tasks = list(all_tasks.get(cid, []))
        allowed = {"title", "assignee", "status", "order"}
        updated: CaseTask | None = None
        for idx, t in enumerate(tasks):
            if t.id != task_id:
                continue
            patch = {k: v for k, v in fields.items() if k in allowed and v is not None}
            if "status" in patch and patch["status"] not in ("open", "in_progress", "done", "blocked"):
                patch.pop("status")
            updated = t.model_copy(update=patch)
            tasks[idx] = updated
            break
        if updated is not None:
            all_tasks[cid] = tasks
            await self._save_all(all_tasks)
        return updated

    async def delete(self, case_id: str | None, task_id: str) -> bool:
        """Delete a task. Returns True if it existed."""
        cid = _norm_case_id(case_id)
        all_tasks = await self._load_all()
        tasks = list(all_tasks.get(cid, []))
        remaining = [t for t in tasks if t.id != task_id]
        if len(remaining) == len(tasks):
            return False
        all_tasks[cid] = remaining
        await self._save_all(all_tasks)
        return True

    async def reorder(self, case_id: str | None, ordered_ids: list[str]) -> list[CaseTask]:
        """Reassign ``order`` from a caller-supplied id sequence (drag-and-drop). Ids
        not present in ``ordered_ids`` keep their relative position AFTER the ordered
        ones. Returns the case's tasks in the new order."""
        cid = _norm_case_id(case_id)
        all_tasks = await self._load_all()
        tasks = list(all_tasks.get(cid, []))
        rank = {tid: i for i, tid in enumerate(ordered_ids)}
        tail = len(ordered_ids)
        # Assign new order: listed ids by their position; the rest appended in their
        # current sorted order.
        leftovers = [t for t in self._sorted(tasks) if t.id not in rank]
        for i, t in enumerate(leftovers):
            rank[t.id] = tail + i
        new_tasks = [t.model_copy(update={"order": rank.get(t.id, t.order)}) for t in tasks]
        all_tasks[cid] = new_tasks
        await self._save_all(all_tasks)
        return self._sorted(new_tasks)

    async def log(self, case_id: str | None, task_id: str, note: str,
                  *, by: str = "") -> CaseTask | None:
        """Append a ``{ts, by, note}`` entry to a task's append-only ``logs`` trail.
        ``note`` is plain data (#9). Returns the updated task, or None."""
        cid = _norm_case_id(case_id)
        all_tasks = await self._load_all()
        tasks = list(all_tasks.get(cid, []))
        updated: CaseTask | None = None
        for idx, t in enumerate(tasks):
            if t.id != task_id:
                continue
            logs = list(t.logs)
            logs.append({"ts": iso_now(), "by": (by or "").strip(), "note": (note or "").strip()})
            updated = t.model_copy(update={"logs": logs})
            tasks[idx] = updated
            break
        if updated is not None:
            all_tasks[cid] = tasks
            await self._save_all(all_tasks)
        return updated

    async def delete_case(self, case_id: str | None) -> bool:
        """Drop an entire case's task list (e.g. on case purge). Returns True if it
        existed."""
        cid = _norm_case_id(case_id)
        all_tasks = await self._load_all()
        if cid not in all_tasks:
            return False
        del all_tasks[cid]
        await self._save_all(all_tasks)
        return True
