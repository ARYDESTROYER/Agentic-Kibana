"""BATCH-JOB store — durable, resume-safe tracking of async LLM batch jobs (Round 4).

An LLM batch job (Anthropic Message Batches / OpenAI ``/v1/batches``) is submitted,
polled, and retrieved OUT-OF-BAND — potentially across a process restart. This store
persists each :class:`app.models.BatchJob` so a fresh process can reload the open
jobs and finish polling + folding their results back through the ONE gateway ledger
(#6). It is the batch-side analogue of the durable poller cursor: nothing is lost,
nothing is double-billed.

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.price_overlay` / :mod:`app.stores.user_prefs`): the WHOLE job set is
ONE KV document (``ns=BATCH_JOBS_NS``, ``key=BATCH_JOBS_KEY``) whose value is
``{"jobs": {"<job_id>": <BatchJob json>, ...}}`` — so it needs NO new ES index / SQL
table / migration. All mutations go through :func:`app.stores.base.kv_mutate`
(compare-and-set, lost-update safe).

Exactly-once ledger semantics (#6): :meth:`process_results` writes EXACTLY ONE
``UsageDoc`` per returned result — at the 0.5× batch rate (``batch=True``) — and marks
that result's ``custom_id`` ``retrieved``. A result whose ``custom_id`` is ALREADY
retrieved is SKIPPED, so a re-poll / restart / duplicate result never double-writes.
The store NEVER calls ``case_manager.decide()`` (#3) — it only produces the ledger
rows + hands verdict text back to the caller; folding into cases is the pipeline's job.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Iterable, TypeVar

from ..constants import (
    BATCH_JOBS_KEY,
    BATCH_JOBS_NS,
    BatchJobState,
    UsageOutcome,
)
from ..models import BatchJob
from .base import KVStore, kv_mutate

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.batch_jobs")


class BatchJobStore:
    """CRUD + resume-safe result folding over the batch-job set, persisted as one KV
    doc. Methods are read-modify-write via :func:`kv_mutate`; none raises on a backend
    failure (a glitch degrades to an empty set / best-effort write, logged)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    # -- (de)serialisation --------------------------------------------------- #
    @staticmethod
    def _decode(doc: dict | None) -> dict[str, BatchJob]:
        raw = doc.get("jobs", {}) if isinstance(doc, dict) else {}
        out: dict[str, BatchJob] = {}
        for jid, item in (raw or {}).items():
            try:
                out[str(jid)] = BatchJob.model_validate(item)
            except Exception:  # noqa: BLE001 — skip a corrupt job, keep the rest
                continue
        return out

    async def _load_all(self) -> dict[str, BatchJob]:
        try:
            doc = await self._kv.get(BATCH_JOBS_NS, BATCH_JOBS_KEY)
        except Exception as exc:  # noqa: BLE001 — best-effort load
            logger.warning("Loading batch jobs failed (%s); using empty set", exc)
            return {}
        return self._decode(doc)

    async def _mutate(self, change: Callable[[dict[str, BatchJob]], _T]) -> _T:
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            jobs = self._decode(current)
            box["r"] = change(jobs)
            return {"jobs": {jid: j.model_dump(mode="json") for jid, j in jobs.items()}}

        await kv_mutate(self._kv, BATCH_JOBS_NS, BATCH_JOBS_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    # -- CRUD ---------------------------------------------------------------- #
    async def save(self, job: BatchJob) -> BatchJob:
        """Upsert a job (submit / after a poll). Returns the stored job."""
        def _change(jobs: dict[str, BatchJob]) -> BatchJob:
            jobs[job.id] = job
            return job
        return await self._mutate(_change)

    async def get(self, job_id: str) -> BatchJob | None:
        return (await self._load_all()).get((job_id or "").strip())

    async def list(self) -> list[BatchJob]:
        return list((await self._load_all()).values())

    async def delete(self, job_id: str) -> bool:
        jid = (job_id or "").strip()

        def _change(jobs: dict[str, BatchJob]) -> bool:
            if jid not in jobs:
                return False
            del jobs[jid]
            return True
        return await self._mutate(_change)

    async def load_open_jobs(self) -> list[BatchJob]:
        """Every job NOT yet fully retrieved — i.e. still ``submitted``/``polling``/
        ``retrieving`` OR ``retrieved`` but with a custom_id still un-retrieved. This
        is the resume seam: a fresh process reloads these and continues polling +
        folding results. A job whose state is a terminal ``retrieved`` with every
        custom_id retrieved (or ``errored``/``expired``) is considered closed."""
        open_jobs: list[BatchJob] = []
        for job in (await self._load_all()).values():
            if job.state in (BatchJobState.ERRORED, BatchJobState.EXPIRED):
                continue
            if job.state == BatchJobState.RETRIEVED and self._all_retrieved(job):
                continue
            open_jobs.append(job)
        return open_jobs

    @staticmethod
    def _all_retrieved(job: BatchJob) -> bool:
        tracked = {k: v for k, v in job.custom_ids.items() if k != "__meta__"}
        if not tracked:
            return False
        return all(bool(v.get("retrieved")) for v in tracked.values())

    async def is_retrieved(self, job_id: str, custom_id: str) -> bool:
        job = await self.get(job_id)
        if job is None:
            return False
        entry = job.custom_ids.get(custom_id) or {}
        return bool(entry.get("retrieved"))

    # -- result folding (exactly-once ledger, #6) ---------------------------- #
    async def process_results(
        self,
        job: BatchJob,
        results: Iterable[Any],
        gateway: Any,
        *,
        role: str = "investigator",
        surface: str = "batch",
    ) -> list[Any]:
        """Fold a batch's results back through the ONE gateway ledger, exactly once.

        For each result (a :class:`app.llm.batch.BatchResult`-shaped object keyed by
        ``custom_id``): if its ``custom_id`` is already marked ``retrieved`` on THIS
        job it is SKIPPED (dedup → exactly-once #6); otherwise ``gateway._record`` is
        called ONCE — OK rows at the 0.5× batch rate (``batch=True``) with the result's
        token + cache counts, error/expired rows as an ERROR outcome — and the
        custom_id is flagged ``retrieved``. Returns the list of results that were newly
        recorded (skipped duplicates excluded) so the caller can fold verdict text into
        cases. NEVER calls ``decide()`` (#3)."""
        # Snapshot which custom_ids are already retrieved (dedup gate) from the persisted
        # job, so a re-run over the same results writes zero new rows.
        stored = await self.get(job.id)
        already: set[str] = set()
        if stored is not None:
            already = {cid for cid, v in stored.custom_ids.items()
                       if cid != "__meta__" and v.get("retrieved")}

        recorded: list[Any] = []
        newly_retrieved: dict[str, str] = {}  # custom_id -> result_state
        for res in results:
            cid = str(getattr(res, "custom_id", "")).strip()
            if not cid or cid in already or cid in newly_retrieved:
                continue  # dedup: already billed (or a duplicate within this batch)
            rtype = str(getattr(res, "result_type", "succeeded"))
            case_id = self._case_id_for(job, cid)
            if rtype == "succeeded":
                await gateway._record(
                    role, surface, case_id, getattr(res, "model", "") or job.model,
                    int(getattr(res, "prompt_tokens", 0) or 0),
                    int(getattr(res, "completion_tokens", 0) or 0),
                    0, UsageOutcome.OK, None,
                    cache_read_tokens=int(getattr(res, "cache_read_tokens", 0) or 0),
                    cache_write_tokens=int(getattr(res, "cache_write_tokens", 0) or 0),
                    batch=True,
                )
                recorded.append(res)
            else:
                # errored / expired — still a resolved outcome; record ONE error row so
                # the ledger reflects the (free) failure and the custom_id is not retried.
                await gateway._record(
                    role, surface, case_id, getattr(res, "model", "") or job.model,
                    0, 0, 0, UsageOutcome.ERROR, 0.0, batch=True,
                )
            newly_retrieved[cid] = rtype

        if newly_retrieved:
            await self._mark_retrieved(job.id, newly_retrieved)
        return recorded

    @staticmethod
    def _case_id_for(job: BatchJob, custom_id: str) -> str | None:
        """The case_id a batch request maps to, if the submit recorded one under the
        custom_id tracking meta (``{case_id: ...}``). None otherwise — the ledger row
        is still written, just not case-scoped."""
        entry = job.custom_ids.get(custom_id) or {}
        cid = entry.get("case_id")
        return str(cid) if cid else None

    async def _mark_retrieved(self, job_id: str, states: dict[str, str]) -> None:
        def _change(jobs: dict[str, BatchJob]) -> None:
            job = jobs.get(job_id)
            if job is None:
                return None
            tracking = dict(job.custom_ids)
            for cid, rstate in states.items():
                entry = dict(tracking.get(cid) or {})
                entry["retrieved"] = True
                entry["result_state"] = rstate
                tracking[cid] = entry
            job.custom_ids = tracking
            # Flip the whole job to RETRIEVED once every tracked custom_id is in.
            if BatchJobStore._all_retrieved(job):
                job.state = BatchJobState.RETRIEVED
            jobs[job_id] = job
            return None
        await self._mutate(_change)
