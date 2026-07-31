"""Native Elasticsearch optimistic concurrency for shared strict KV state.

The Batch registry is one KV document.  Separate backend replicas have separate
``asyncio.Lock`` objects, so correctness must come from the state backend rather
than a process-local lock.  These tests exercise both the real client's
``_seq_no``/``_primary_term`` request shape and two independent BatchJobStore
instances sharing the fake Elasticsearch state.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest

from app.constants import BatchJobState, CONFIG_INDEX
from app.es.client import RealESClient
from app.es.fake import InMemoryESClient
from app.models import BatchJob
from app.stores.batch_jobs import BatchJobStore
from app.stores.memory import EsKVStore


class _HTTPError(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status_code = status


def _real_client(mgmt: object) -> RealESClient:
    client = object.__new__(RealESClient)
    client._mgmt = mgmt
    client._ro = None
    return client


@pytest.mark.asyncio
async def test_real_es_cas_fences_existing_write_with_seq_no_and_primary_term() -> None:
    mgmt = type("Mgmt", (), {})()
    mgmt.get = AsyncMock(
        return_value={
            "_source": {"_rev": 7, "jobs": {}},
            "_seq_no": 41,
            "_primary_term": 3,
        }
    )
    mgmt.index = AsyncMock(return_value={"_id": "batch_jobs"})
    client = _real_client(mgmt)

    assert await client.compare_and_set_doc(
        CONFIG_INDEX,
        "batch_jobs",
        {"_rev": 8, "jobs": {"batch-a": {}}},
        expected_rev=7,
        refresh=True,
    ) is True
    mgmt.index.assert_awaited_once_with(
        index=CONFIG_INDEX,
        id="batch_jobs",
        document={"_rev": 8, "jobs": {"batch-a": {}}},
        if_seq_no=41,
        if_primary_term=3,
        refresh=True,
    )


@pytest.mark.asyncio
async def test_real_es_cas_reports_revision_or_occ_conflict_without_overwrite() -> None:
    mgmt = type("Mgmt", (), {})()
    mgmt.get = AsyncMock(
        return_value={
            "_source": {"_rev": 9},
            "_seq_no": 44,
            "_primary_term": 3,
        }
    )
    mgmt.index = AsyncMock()
    client = _real_client(mgmt)

    assert await client.compare_and_set_doc(
        CONFIG_INDEX, "batch_jobs", {"_rev": 8}, expected_rev=7
    ) is False
    mgmt.index.assert_not_awaited()

    mgmt.get.return_value = {
        "_source": {"_rev": 7},
        "_seq_no": 45,
        "_primary_term": 3,
    }
    mgmt.index.side_effect = _HTTPError(409)
    assert await client.compare_and_set_doc(
        CONFIG_INDEX, "batch_jobs", {"_rev": 8}, expected_rev=7
    ) is False


@pytest.mark.asyncio
async def test_real_es_cas_uses_create_only_for_absent_document() -> None:
    mgmt = type("Mgmt", (), {})()
    mgmt.get = AsyncMock(side_effect=_HTTPError(404))
    mgmt.index = AsyncMock(return_value={"_id": "batch_jobs"})
    client = _real_client(mgmt)

    assert await client.compare_and_set_doc(
        CONFIG_INDEX,
        "batch_jobs",
        {"_rev": 1, "jobs": {}},
        expected_rev=0,
        refresh=True,
    ) is True
    mgmt.index.assert_awaited_once_with(
        index=CONFIG_INDEX,
        id="batch_jobs",
        document={"_rev": 1, "jobs": {}},
        op_type="create",
        refresh=True,
    )

    mgmt.index.reset_mock()
    mgmt.index.side_effect = _HTTPError(409)
    assert await client.compare_and_set_doc(
        CONFIG_INDEX, "batch_jobs", {"_rev": 1}, expected_rev=0
    ) is False

    mgmt.index.reset_mock(side_effect=True)
    assert await client.compare_and_set_doc(
        CONFIG_INDEX, "batch_jobs", {"_rev": 5}, expected_rev=4
    ) is False
    mgmt.index.assert_not_awaited()


@pytest.mark.asyncio
async def test_real_es_cas_propagates_non_conflict_backend_failure() -> None:
    mgmt = type("Mgmt", (), {})()
    mgmt.get = AsyncMock(
        return_value={
            "_source": {"_rev": 1},
            "_seq_no": 2,
            "_primary_term": 1,
        }
    )
    mgmt.index = AsyncMock(side_effect=_HTTPError(503))
    client = _real_client(mgmt)

    with pytest.raises(_HTTPError, match="503"):
        await client.compare_and_set_doc(
            CONFIG_INDEX, "batch_jobs", {"_rev": 2}, expected_rev=1
        )


class _BarrierES(InMemoryESClient):
    """Force two independent stores to read one identical KV snapshot."""

    def __init__(self) -> None:
        super().__init__()
        self._barrier: asyncio.Event | None = None
        self._barrier_reads = 0

    def arm(self) -> None:
        self._barrier = asyncio.Event()
        self._barrier_reads = 0

    async def get_doc_strict(self, index: str, doc_id: str):  # noqa: ANN201
        snapshot = deepcopy(await super().get_doc_strict(index, doc_id))
        barrier = self._barrier
        if barrier is not None and self._barrier_reads < 2:
            self._barrier_reads += 1
            if self._barrier_reads == 2:
                barrier.set()
            await barrier.wait()
        return snapshot


def _outbox(job_id: str) -> BatchJob:
    return BatchJob(
        id=job_id,
        provider="anthropic",
        model="claude-haiku-4-5",
        state=BatchJobState.SUBMITTED,
        requests=[{"custom_id": f"{job_id}-request", "params": {}}],
        custom_ids={f"{job_id}-request": {"retrieved": False}},
    )


@pytest.mark.asyncio
async def test_two_es_batch_stores_retry_lost_update_and_preserve_both_outboxes() -> None:
    es = _BarrierES()
    left = BatchJobStore(EsKVStore(es))
    right = BatchJobStore(EsKVStore(es))
    es.arm()

    (stored_a, created_a), (stored_b, created_b) = await asyncio.gather(
        left.create_if_absent(_outbox("batch-a")),
        right.create_if_absent(_outbox("batch-b")),
    )

    assert created_a is True and stored_a.id == "batch-a"
    assert created_b is True and stored_b.id == "batch-b"
    assert {job.id for job in await left.list_strict()} == {"batch-a", "batch-b"}


@pytest.mark.asyncio
async def test_two_es_batch_stores_issue_only_one_active_submission_claim() -> None:
    es = _BarrierES()
    left = BatchJobStore(EsKVStore(es))
    right = BatchJobStore(EsKVStore(es))
    await left.create_if_absent(_outbox("batch-shared"))
    es.arm()

    first, second = await asyncio.gather(
        left.claim_submission("batch-shared"),
        right.claim_submission("batch-shared"),
    )
    claims = [pair for pair in (first, second) if pair[1] is not None]
    assert len(claims) == 1

    durable = await left.get_strict("batch-shared")
    assert durable is not None
    assert durable.submit_attempts == 1
    assert durable.submission_lease_token == claims[0][1]


@pytest.mark.asyncio
async def test_two_es_batch_stores_issue_only_one_active_reentry_claim() -> None:
    es = _BarrierES()
    left = BatchJobStore(EsKVStore(es))
    right = BatchJobStore(EsKVStore(es))
    job = _outbox("batch-reentry")
    custom_id = "batch-reentry-request"
    job.provider_batch_id = "provider-batch-1"
    job.custom_ids[custom_id] = {
        "retrieved": True,
        "result_state": "succeeded",
        "reentry_state": "pending",
    }
    job.candidates[custom_id] = {"aggregate_summary": {"count": 3}}
    await left.create_if_absent(job)
    es.arm()

    first, second = await asyncio.gather(
        left.claim_reentries("batch-reentry", [custom_id]),
        right.claim_reentries("batch-reentry", [custom_id]),
    )
    claim_sets = [claims for claims in (first, second) if claims]
    assert len(claim_sets) == 1
    assert set(claim_sets[0]) == {custom_id}

    durable = await left.get_strict("batch-reentry")
    assert durable is not None
    assert durable.custom_ids[custom_id]["reentry_state"] == "processing"
    assert durable.custom_ids[custom_id]["reentry_token"] == claim_sets[0][custom_id]
