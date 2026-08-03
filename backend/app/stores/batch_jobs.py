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
table / migration. All mutations go through
:func:`app.stores.base.kv_mutate_strict` (confirmed compare-and-set,
lost-update safe). Batch state is a durability boundary; it never reports an
unpersisted transition as successful.

Idempotent ledger semantics (#6): :meth:`process_results` writes one logical
``UsageDoc`` per returned result — at the 0.5× batch rate (``batch=True``) — and marks
that result's ``custom_id`` ``retrieved`` only after the write. Detection re-entry
has a separate durable lease/state so a temporary pipeline failure retries without
another ledger row.
The store NEVER calls ``case_manager.decide()`` (#3) — it only produces the ledger
rows + hands verdict text back to the caller; folding into cases is the pipeline's job.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Callable, Iterable, TypeVar

from ..constants import (
    BATCH_JOBS_KEY,
    BATCH_JOBS_NS,
    BatchJobState,
    UsageOutcome,
)
from ..models import BatchJob
from .base import KVStore, kv_mutate_strict

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.batch_jobs")

_RECORDING_LEASE_MILLIS = 5 * 60 * 1000
_SUBMISSION_LEASE_MILLIS = 5 * 60 * 1000


class BatchJobStore:
    """CRUD + resume-safe result folding over the batch-job set, persisted as one KV
    doc. Reads used by operator views remain best-effort; every write/state transition
    is strict and raises unless persistence is confirmed."""

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

    async def _load_all_strict(self) -> dict[str, BatchJob]:
        """Confirmed registry read for operator/API and durability boundaries."""
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(BATCH_JOBS_NS, BATCH_JOBS_KEY)
        if doc is None:
            return {}
        if not isinstance(doc, dict):
            raise ValueError("batch-job registry is not a JSON object")
        raw = doc.get("jobs", {})
        if not isinstance(raw, dict):
            raise ValueError("batch-job registry entries are not an object")
        decoded = self._decode(doc)
        if len(decoded) != len(raw):
            raise ValueError("batch-job registry contains an invalid entry")
        return decoded

    async def _mutate(self, change: Callable[[dict[str, BatchJob]], _T]) -> _T:
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            jobs = self._decode(current)
            box["r"] = change(jobs)
            return {"jobs": {jid: j.model_dump(mode="json") for jid, j in jobs.items()}}

        await kv_mutate_strict(
            self._kv, BATCH_JOBS_NS, BATCH_JOBS_KEY, _mutator, lock=self._lock
        )
        return box.get("r")  # type: ignore[return-value]

    # -- CRUD ---------------------------------------------------------------- #
    async def save(self, job: BatchJob) -> BatchJob:
        """Upsert a job (submit / after a poll). Returns the stored job."""
        def _change(jobs: dict[str, BatchJob]) -> BatchJob:
            jobs[job.id] = job
            return job
        return await self._mutate(_change)

    async def create_if_absent(self, job: BatchJob) -> tuple[BatchJob, bool]:
        """Atomically persist a new outbox intent.

        Returns ``(stored_job, created)``. The single-document strict CAS makes
        concurrent identical submitters converge before either calls the provider.
        """
        def _change(jobs: dict[str, BatchJob]) -> tuple[BatchJob, bool]:
            existing = jobs.get(job.id)
            if existing is not None:
                return existing, False
            jobs[job.id] = job
            return job, True

        return await self._mutate(_change)

    async def claim_submission(self, job_id: str) -> tuple[BatchJob | None, str | None]:
        """Atomically lease one unresolved local outbox for provider submission.

        Immediate ``submit()`` and scheduler ``poll()`` both enter through this
        transition.  Exactly one active claimant receives a token; every other worker
        receives the current durable row and performs no provider call.  A process
        crash leaves a bounded lease that a later scheduler pass may reclaim.
        ``submit_attempts`` counts actual leased provider attempts, not contenders.
        """
        jid = (job_id or "").strip()
        now_ms = int(time.time() * 1000)

        def _change(
            jobs: dict[str, BatchJob],
        ) -> tuple[BatchJob | None, str | None]:
            job = jobs.get(jid)
            if job is None or job.provider_batch_id or not job.requests:
                return job, None
            leased_at = int(job.submission_lease_at_millis or 0)
            active = bool(job.submission_lease_token) and (
                now_ms - leased_at < _SUBMISSION_LEASE_MILLIS
            )
            if active:
                return job, None
            token = uuid.uuid4().hex
            job.submission_lease_token = token
            job.submission_lease_at_millis = now_ms
            job.submit_attempts = int(job.submit_attempts or 0) + 1
            jobs[jid] = job
            return job, token

        return await self._mutate(_change)

    async def fail_submission(
        self, job_id: str, token: str, error: str
    ) -> BatchJob | None:
        """Release an owned submission lease after a provider failure.

        The outbox remains scheduler-open and the bounded error remains visible.  A
        stale worker cannot clear or overwrite a newer claimant's lease.
        """
        jid = (job_id or "").strip()
        message = str(error or "batch provider submission failed")[:500]

        def _change(jobs: dict[str, BatchJob]) -> BatchJob | None:
            job = jobs.get(jid)
            if job is None:
                return None
            if job.submission_lease_token != token:
                raise RuntimeError(
                    "batch submission lease ownership changed before failure was recorded"
                )
            job.state = BatchJobState.SUBMITTED
            job.last_error = message
            job.submission_lease_token = None
            job.submission_lease_at_millis = 0
            jobs[jid] = job
            return job

        return await self._mutate(_change)

    async def complete_submission(
        self, job_id: str, token: str, remote: BatchJob
    ) -> BatchJob | None:
        """Persist provider acceptance only for the worker owning ``token``.

        Provider state is merged into the latest durable outbox inside the same strict
        compare-and-set, preserving any tracking metadata added while the network call
        was in flight.  Storage errors propagate; an unconfirmed provider id is never
        reported as a successful local transition.
        """
        jid = (job_id or "").strip()

        def _change(jobs: dict[str, BatchJob]) -> BatchJob | None:
            job = jobs.get(jid)
            if job is None:
                return None
            if job.submission_lease_token != token:
                raise RuntimeError(
                    "batch submission lease ownership changed before acceptance was recorded"
                )
            job.provider = remote.provider or job.provider
            job.provider_batch_id = remote.provider_batch_id
            job.model = remote.model or job.model
            job.state = remote.state
            job.discount = remote.discount
            job.submitted_at = remote.submitted_at or job.submitted_at
            job.polled_at = remote.polled_at or job.polled_at
            merged_tracking: dict[str, dict[str, Any]] = {}
            for cid in set(job.custom_ids) | set(remote.custom_ids):
                merged_tracking[cid] = {
                    **dict(job.custom_ids.get(cid) or {}),
                    **dict(remote.custom_ids.get(cid) or {}),
                }
            job.custom_ids = merged_tracking
            job.last_error = None
            job.submission_lease_token = None
            job.submission_lease_at_millis = 0
            jobs[jid] = job
            return job

        return await self._mutate(_change)

    async def get(self, job_id: str) -> BatchJob | None:
        return (await self._load_all()).get((job_id or "").strip())

    async def get_strict(self, job_id: str) -> BatchJob | None:
        """Confirmed read for submission/re-entry decisions; errors propagate."""
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(BATCH_JOBS_NS, BATCH_JOBS_KEY)
        return self._decode(doc).get((job_id or "").strip())

    async def list(self) -> list[BatchJob]:
        return list((await self._load_all()).values())

    async def list_strict(self) -> list[BatchJob]:
        """List jobs or propagate storage failure; never confuse outage with empty."""
        return list((await self._load_all_strict()).values())

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
            if job.state == BatchJobState.RETRIEVED and self._all_complete(job):
                continue
            open_jobs.append(job)
        return open_jobs

    @staticmethod
    def _all_complete(job: BatchJob) -> bool:
        tracked = {k: v for k, v in job.custom_ids.items() if k != "__meta__"}
        if not tracked:
            return False
        return all(
            bool(v.get("retrieved"))
            and str(v.get("reentry_state") or "not_required")
            not in {"pending", "processing"}
            for v in tracked.values()
        )

    _all_retrieved = _all_complete

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
        token + cache counts, error/expired rows as an ERROR outcome. Returns the list of
        results that were newly recorded (skipped duplicates excluded) so the caller can
        fold verdict text into cases. NEVER calls ``decide()`` (#3).

        LEASED CLAIM (FINDING #3, #6): each unresolved id receives a short recording
        lease inside one KV compare-and-set. Crucially, ``retrieved`` remains False until
        the gateway's strict, idempotent ledger write succeeds. A write failure releases
        the lease so the result retries; a process crash leaves a bounded stale lease that
        can be reclaimed. Concurrent workers cannot record the same active lease, while
        the ledger idempotency key makes a post-write/pre-finalize retry safe."""
        # Index this batch's results by custom_id (first occurrence wins), so a claimed id
        # maps back to exactly one result to bill.
        by_id: dict[str, Any] = {}
        for res in results:
            cid = str(getattr(res, "custom_id", "")).strip()
            if cid and cid not in by_id:
                by_id[cid] = res
        if not by_id:
            return []

        states = {cid: str(getattr(res, "result_type", "succeeded")) for cid, res in by_id.items()}
        leases = await self._lease_claim(job.id, states)

        recorded: list[Any] = []
        for cid, lease_token in leases.items():
            res = by_id.get(cid)
            if res is None:
                await self._fail_ledger_lease(
                    job.id,
                    cid,
                    lease_token,
                    "provider result disappeared before ledger fold",
                )
                continue
            rtype = states.get(cid, "succeeded")
            case_id = self._case_id_for(job, cid)
            ledger_key = f"batch:{job.id}:{cid}"
            try:
                if rtype == "succeeded":
                    await gateway._record(
                        role, surface, case_id, getattr(res, "model", "") or job.model,
                        int(getattr(res, "prompt_tokens", 0) or 0),
                        int(getattr(res, "completion_tokens", 0) or 0),
                        0, UsageOutcome.OK, None,
                        cache_read_tokens=int(getattr(res, "cache_read_tokens", 0) or 0),
                        cache_write_tokens=int(getattr(res, "cache_write_tokens", 0) or 0),
                        batch=True,
                        idempotency_key=ledger_key,
                        require_persistence=True,
                    )
                else:
                    # errored / expired is still one resolved, metered outcome.
                    await gateway._record(
                        role, surface, case_id, getattr(res, "model", "") or job.model,
                        0, 0, 0, UsageOutcome.ERROR, 0.0,
                        batch=True,
                        idempotency_key=ledger_key,
                        require_persistence=True,
                    )
            except Exception as exc:  # noqa: BLE001 - leave unretrieved for retry
                logger.warning(
                    "Batch usage persistence failed (job=%s custom_id=%s): %s",
                    job.id,
                    cid,
                    exc,
                )
                await self._fail_ledger_lease(
                    job.id, cid, lease_token, f"usage persistence failed: {exc}"
                )
                continue
            finalised = await self._finalize_lease(
                job.id, cid, lease_token, rtype
            )
            if finalised and rtype == "succeeded":
                recorded.append(res)
        return recorded

    @staticmethod
    def _case_id_for(job: BatchJob, custom_id: str) -> str | None:
        """The case_id a batch request maps to, if the submit recorded one under the
        custom_id tracking meta (``{case_id: ...}``). None otherwise — the ledger row
        is still written, just not case-scoped."""
        entry = job.custom_ids.get(custom_id) or {}
        cid = entry.get("case_id")
        return str(cid) if cid else None

    async def _lease_claim(self, job_id: str, states: dict[str, str]) -> dict[str, str]:
        """Lease unresolved ids without marking them retrieved."""
        now_ms = int(time.time() * 1000)

        def _change(jobs: dict[str, BatchJob]) -> dict[str, str]:
            job = jobs.get(job_id)
            if job is None:
                return {}
            tracking = dict(job.custom_ids)
            claimed: dict[str, str] = {}
            for cid, rstate in states.items():
                entry = dict(tracking.get(cid) or {})
                if entry.get("retrieved"):
                    continue
                leased_at = int(entry.get("recording_at_millis", 0) or 0)
                active = bool(entry.get("recording_token")) and (
                    now_ms - leased_at < _RECORDING_LEASE_MILLIS
                )
                if active:
                    continue
                token = uuid.uuid4().hex
                entry["recording_token"] = token
                entry["recording_at_millis"] = now_ms
                entry["pending_result_state"] = rstate
                tracking[cid] = entry
                claimed[cid] = token
            if not claimed:
                return {}
            job.custom_ids = tracking
            jobs[job_id] = job
            return claimed
        return await self._mutate(_change)

    async def _release_lease(self, job_id: str, custom_id: str, token: str) -> bool:
        """Release only the lease owned by ``token``; leave the result retryable."""
        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("recording_token") != token or entry.get("retrieved"):
                return False
            entry.pop("recording_token", None)
            entry.pop("recording_at_millis", None)
            entry.pop("pending_result_state", None)
            tracking[custom_id] = entry
            job.custom_ids = tracking
            jobs[job_id] = job
            return True

        return await self._mutate(_change)

    async def _fail_ledger_lease(
        self, job_id: str, custom_id: str, token: str, error: str
    ) -> bool:
        """Release a failed ledger lease and expose the bounded failure on the job."""
        message = str(error or "batch ledger persistence failed")[:500]

        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("recording_token") != token or entry.get("retrieved"):
                return False
            entry.pop("recording_token", None)
            entry.pop("recording_at_millis", None)
            entry.pop("pending_result_state", None)
            entry["last_error"] = message
            tracking[custom_id] = entry
            job.custom_ids = tracking
            job.last_error = message
            jobs[job_id] = job
            return True

        return await self._mutate(_change)

    async def _finalize_lease(
        self, job_id: str, custom_id: str, token: str, result_state: str
    ) -> bool:
        """Mark retrieval complete only after the strict ledger write succeeded."""
        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("recording_token") != token or entry.get("retrieved"):
                return False
            entry["retrieved"] = True
            entry["result_state"] = result_state
            entry.pop("last_error", None)
            if result_state == "succeeded" and custom_id in job.candidates:
                entry["reentry_state"] = "pending"
            else:
                entry["reentry_state"] = "not_required"
            entry.pop("recording_token", None)
            entry.pop("recording_at_millis", None)
            entry.pop("pending_result_state", None)
            tracking[custom_id] = entry
            job.custom_ids = tracking
            # A retry that succeeds must clear the operator-visible failure. Preserve
            # another result's outstanding error, if any, instead of leaving this
            # job permanently red after recovery.
            job.last_error = next(
                (
                    str(item.get("last_error"))[:500]
                    for item in tracking.values()
                    if isinstance(item, dict) and item.get("last_error")
                ),
                None,
            )
            if BatchJobStore._all_complete(job):
                job.state = BatchJobState.RETRIEVED
            else:
                job.state = BatchJobState.RETRIEVING
            jobs[job_id] = job
            return True

        return await self._mutate(_change)

    async def claim_reentries(
        self, job_id: str, custom_ids: Iterable[str]
    ) -> dict[str, str]:
        """Lease ledger-recorded detection results that still need case re-entry."""
        wanted = {str(cid).strip() for cid in custom_ids if str(cid).strip()}
        now_ms = int(time.time() * 1000)

        def _change(jobs: dict[str, BatchJob]) -> dict[str, str]:
            job = jobs.get(job_id)
            if job is None:
                return {}
            tracking = dict(job.custom_ids)
            claimed: dict[str, str] = {}
            for cid in wanted:
                entry = dict(tracking.get(cid) or {})
                if not entry.get("retrieved") or cid not in job.candidates:
                    continue
                state = str(entry.get("reentry_state") or "pending")
                if state == "complete":
                    continue
                leased_at = int(entry.get("reentry_at_millis", 0) or 0)
                active = bool(entry.get("reentry_token")) and (
                    now_ms - leased_at < _RECORDING_LEASE_MILLIS
                )
                if active:
                    continue
                token = uuid.uuid4().hex
                entry["reentry_state"] = "processing"
                entry["reentry_token"] = token
                entry["reentry_at_millis"] = now_ms
                tracking[cid] = entry
                claimed[cid] = token
            if claimed:
                job.custom_ids = tracking
                jobs[job_id] = job
            return claimed

        return await self._mutate(_change)

    async def fail_reentry(
        self, job_id: str, custom_id: str, token: str, error: str
    ) -> bool:
        """Return an owned re-entry lease to pending and retain a visible error."""
        message = str(error or "detection re-entry failed")[:500]

        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("reentry_token") != token:
                return False
            entry["reentry_state"] = "pending"
            entry["last_error"] = message
            entry.pop("reentry_token", None)
            entry.pop("reentry_at_millis", None)
            tracking[custom_id] = entry
            job.custom_ids = tracking
            job.last_error = message
            job.state = BatchJobState.RETRIEVING
            jobs[job_id] = job
            return True

        return await self._mutate(_change)

    async def complete_reentry(
        self, job_id: str, custom_id: str, token: str
    ) -> bool:
        """Confirm case-pipeline handoff completion for one leased detection result."""
        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("reentry_token") != token:
                return False
            entry["reentry_state"] = "complete"
            entry.pop("reentry_token", None)
            entry.pop("reentry_at_millis", None)
            entry.pop("last_error", None)
            tracking[custom_id] = entry
            job.custom_ids = tracking
            if BatchJobStore._all_complete(job):
                job.state = BatchJobState.RETRIEVED
                job.last_error = None
            jobs[job_id] = job
            return True

        return await self._mutate(_change)
