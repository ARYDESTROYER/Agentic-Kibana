"""Round 4 / Wave 3 — LLM economics: cache-rate pricing, cache-token extraction,
BatchProvider SPI + resume-safe BatchJobStore (exactly-once ledger, #6).

All offline (fake ES + injected fake HTTP clients). No network.

Coverage:
  * cost_for non-cache/non-batch math is BYTE-IDENTICAL to the historical two-term
    formula (hardcoded expected values).
  * cache-read 0.1×, 5-min cache-write 1.25×, 1-h cache-write 2×, batch 0.5× math.
  * providers parse cache tokens into CompletionResult; the gateway writes them onto
    ONE UsageDoc per call (#6) and prices the cache/batch dimension.
  * OpenAI service_tier='flex' injected into the realtime request when configured.
  * BatchProvider submit/poll/results via a fake client, results keyed by custom_id
    (unordered).
  * BatchJobStore idempotency (2 results -> 2 UsageDocs; re-process -> 0 new) and
    resume-safe reload of open jobs after a simulated restart.
"""

from __future__ import annotations

import json

import pytest

from app.config import ModelConfig
from app.constants import USAGE_READ_PATTERN, BatchJobState, Role, UsageOutcome
from app.es.fake import InMemoryESClient
from app.llm import pricing
from app.llm.batch import (
    BATCH_PROVIDER_REGISTRY,
    AnthropicBatchProvider,
    BatchResult,
    OpenAIBatchProvider,
    batch_manifest,
    make_batch_provider,
)
from app.llm.gateway import LLMGateway
from app.llm.pricing import cache_rates, cost_for
from app.llm.providers import AnthropicProvider, CompletionResult, OpenAIProvider
from app.models import BatchJob
from app.stores.batch_jobs import BatchJobStore
from app.stores.memory import EsKVStore
from app.stores.usage import UsageStore


# --------------------------------------------------------------------------- #
# Shared fakes
# --------------------------------------------------------------------------- #
class _FakeSecrets:
    anthropic_api_key = "sk-ant"
    openai_api_key = "sk-oai"
    embedding_api_key = None

    def embedding_key(self):
        return self.openai_api_key


async def _usage_docs(es: InMemoryESClient):
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [h["_source"] for h in resp["hits"]["hits"]]


def _kv() -> EsKVStore:
    return EsKVStore(InMemoryESClient())


class _Resp:
    """A minimal httpx-Response-shaped stub (json + text + raise_for_status)."""

    def __init__(self, payload=None, *, text: str = "", status: int = 200) -> None:
        self._payload = payload
        self.text = text
        self._status = status

    def raise_for_status(self) -> None:
        if self._status >= 400:  # pragma: no cover - not exercised here
            raise RuntimeError(f"HTTP {self._status}")

    def json(self):
        return self._payload


# --------------------------------------------------------------------------- #
# 1) cost_for — non-cache byte-identical + cache/batch math
# --------------------------------------------------------------------------- #
def test_cost_for_non_cache_byte_identical():
    # claude-opus-4-8 == (5.0, 25.0). 1M in + 1M out = 5.0 + 25.0 = 30.0.
    assert cost_for("claude-opus-4-8", 1_000_000, 1_000_000) == pytest.approx(30.0)
    # A partial-token case that exercises the round(...,8) — must equal the raw formula.
    expected = round((1234 / 1e6) * 5.0 + (567 / 1e6) * 25.0, 8)
    assert cost_for("claude-opus-4-8", 1234, 567) == expected
    # Unknown model -> default (1.0, 3.0): 1M+1M = 4.0.
    assert cost_for("zzz-unknown", 1_000_000, 1_000_000) == pytest.approx(4.0)
    # Zero cache tokens + batch=False must be the exact two-term result.
    assert cost_for("gpt-4o", 2_000_000, 500_000,
                    cache_read_tokens=0, cache_write_tokens=0, batch=False) == \
        cost_for("gpt-4o", 2_000_000, 500_000)


def test_cache_rates_default_and_registry():
    # opus-4-8 input rate is 5.0; registry declares read=0.5, write=6.25.
    read, w5m, w1h = cache_rates("claude-opus-4-8", 5.0)
    assert read == pytest.approx(0.5)      # 0.1x
    assert w5m == pytest.approx(6.25)      # 1.25x
    assert w1h == pytest.approx(10.0)      # 2.0x derived from input
    # A registry-unknown model falls back to multiples of the passed input rate.
    read2, w5m2, w1h2 = cache_rates("totally-unknown-xyz", 4.0)
    assert (read2, w5m2, w1h2) == pytest.approx((0.4, 5.0, 8.0))


def test_cost_for_cache_read_is_0_1x():
    # 1M cache-read tokens at opus (input 5.0) -> 0.1 * 5.0 = 0.5 USD, on top of base.
    base = cost_for("claude-opus-4-8", 1_000_000, 0)  # 5.0
    with_read = cost_for("claude-opus-4-8", 1_000_000, 0, cache_read_tokens=1_000_000)
    assert with_read - base == pytest.approx(0.5)
    assert with_read == pytest.approx(5.5)


def test_cost_for_cache_write_5m_and_1h():
    base = cost_for("claude-opus-4-8", 0, 0)  # 0.0
    w5m = cost_for("claude-opus-4-8", 0, 0, cache_write_tokens=1_000_000, cache_write_ttl="5m")
    w1h = cost_for("claude-opus-4-8", 0, 0, cache_write_tokens=1_000_000, cache_write_ttl="1h")
    assert w5m - base == pytest.approx(6.25)   # 1.25x of 5.0
    assert w1h - base == pytest.approx(10.0)   # 2.0x of 5.0


def test_cost_for_batch_halves_everything():
    full = cost_for("claude-opus-4-8", 1_000_000, 1_000_000)  # 30.0
    batched = cost_for("claude-opus-4-8", 1_000_000, 1_000_000, batch=True)
    assert batched == pytest.approx(full * 0.5)
    assert batched == pytest.approx(15.0)
    # Batch also halves the cache dimension.
    b = cost_for("claude-opus-4-8", 1_000_000, 0, cache_read_tokens=1_000_000, batch=True)
    assert b == pytest.approx((5.0 + 0.5) * 0.5)


def test_cost_for_rounds_once_at_end():
    # A value where per-term rounding would drift from a single final round.
    got = cost_for("claude-opus-4-8", 333_333, 111_111,
                   cache_read_tokens=77_777, cache_write_tokens=55_555)
    read, w5m, _ = cache_rates("claude-opus-4-8", 5.0)
    expected = round(
        (333_333 / 1e6) * 5.0 + (111_111 / 1e6) * 25.0
        + (77_777 / 1e6) * read + (55_555 / 1e6) * w5m,
        8,
    )
    assert got == expected


def test_mock_model_is_free_regardless_of_cache():
    assert cost_for("mock", 1_000_000, 1_000_000, cache_read_tokens=1_000_000, batch=False) == 0.0


# --------------------------------------------------------------------------- #
# 2) provider extraction of cache tokens into CompletionResult
# --------------------------------------------------------------------------- #
async def test_anthropic_provider_parses_cache_tokens():
    provider = AnthropicProvider(api_key="sk-ant")

    class _Client:
        async def post(self, *_a, **_k):
            return _Resp({
                "content": [{"type": "text", "text": "hi"}],
                "usage": {"input_tokens": 100, "output_tokens": 20,
                          "cache_read_input_tokens": 40, "cache_creation_input_tokens": 15},
            })

        async def aclose(self):
            return None

    provider._client = _Client()  # type: ignore[assignment]
    res = await provider.complete("router", [{"role": "user", "content": "x"}],
                                  "claude-opus-4-8", temperature=0.1, max_tokens=8)
    assert res.cache_read_tokens == 40
    assert res.cache_write_tokens == 15
    assert res.prompt_tokens == 100 and res.completion_tokens == 20


async def test_openai_provider_parses_cached_tokens():
    provider = OpenAIProvider(api_key="sk-oai")

    class _Client:
        async def post(self, *_a, **_k):
            return _Resp({
                "choices": [{"message": {"content": "hi"}}],
                "usage": {"prompt_tokens": 200, "completion_tokens": 30,
                          "prompt_tokens_details": {"cached_tokens": 128}},
            })

        async def aclose(self):
            return None

    provider._client = _Client()  # type: ignore[assignment]
    res = await provider.complete("router", [{"role": "user", "content": "x"}],
                                  "gpt-4o", temperature=0.1, max_tokens=8)
    assert res.cache_read_tokens == 128
    assert res.cache_write_tokens == 0  # OpenAI caching is read-only


async def test_openai_service_tier_flex_injected_when_set():
    captured: dict = {}

    class _Client:
        async def post(self, url, *, json=None, **_k):  # noqa: A002
            captured["json"] = json
            return _Resp({"choices": [{"message": {"content": "ok"}}],
                          "usage": {"prompt_tokens": 1, "completion_tokens": 1}})

        async def aclose(self):
            return None

    flex = OpenAIProvider(api_key="sk-oai", service_tier="flex")
    flex._client = _Client()  # type: ignore[assignment]
    await flex.complete("router", [{"role": "user", "content": "x"}], "gpt-4o",
                        temperature=0.1, max_tokens=8)
    assert captured["json"].get("service_tier") == "flex"

    # Default (no service_tier) keeps the request shape byte-identical (no key).
    captured.clear()
    plain = OpenAIProvider(api_key="sk-oai")
    plain._client = _Client()  # type: ignore[assignment]
    await plain.complete("router", [{"role": "user", "content": "x"}], "gpt-4o",
                         temperature=0.1, max_tokens=8)
    assert "service_tier" not in captured["json"]


# --------------------------------------------------------------------------- #
# 3) gateway writes cache/batch onto ONE UsageDoc (#6) + prices them
# --------------------------------------------------------------------------- #
class _CacheProvider:
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        return CompletionResult(text="ok", prompt_tokens=1_000_000, completion_tokens=0,
                                model=model, cache_read_tokens=1_000_000)

    async def embed(self, *_a, **_k):  # pragma: no cover
        raise NotImplementedError

    async def aclose(self):
        return None


async def test_gateway_records_cache_tokens_one_write():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"anthropic": _CacheProvider()})
    cfg = ModelConfig(provider="anthropic", model="claude-opus-4-8")
    res = await gw.complete(Role.ROUTER, [{"role": "user", "content": "hi"}], cfg, surface="router")
    docs = await _usage_docs(es)
    assert len(docs) == 1  # #6: exactly one row
    d = docs[0]
    assert d["cache_read_tokens"] == 1_000_000
    assert d["cache_write_tokens"] == 0
    assert d["batch"] is False
    # cost = 5.0 (input) + 0.5 (0.1x cache read) = 5.5
    assert d["cost"] == pytest.approx(5.5)
    assert res.cost == pytest.approx(5.5)


# --------------------------------------------------------------------------- #
# 4) BatchProvider SPI — submit / poll / results via a fake client (unordered)
# --------------------------------------------------------------------------- #
def test_batch_manifest_and_registry():
    ids = {m["id"] for m in batch_manifest()}
    assert ids == {"anthropic", "openai"}
    assert set(BATCH_PROVIDER_REGISTRY) == {"anthropic", "openai"}
    assert isinstance(make_batch_provider("anthropic", client=object()), AnthropicBatchProvider)
    assert isinstance(make_batch_provider("openai", client=object()), OpenAIBatchProvider)


class _AnthropicBatchClient:
    """A fake Anthropic batch client: submit -> in_progress, poll -> ended,
    results -> JSONL keyed by custom_id (returned UNORDERED)."""

    def __init__(self) -> None:
        self.polls = 0

    async def post(self, url, *, headers=None, json=None, **_k):  # noqa: A002
        assert url == "/v1/messages/batches"
        return _Resp({"id": "msgbatch_1", "processing_status": "in_progress"})

    async def get(self, url, *, headers=None, **_k):
        if url.endswith("/results"):
            # Two results, returned in the OPPOSITE order to submission.
            lines = [
                json.dumps({"custom_id": "cid-B", "result": {"type": "succeeded", "message": {
                    "model": "claude-opus-4-8", "content": [{"type": "text", "text": "B"}],
                    "usage": {"input_tokens": 200, "output_tokens": 20}}}}),
                json.dumps({"custom_id": "cid-A", "result": {"type": "succeeded", "message": {
                    "model": "claude-opus-4-8", "content": [{"type": "text", "text": "A"}],
                    "usage": {"input_tokens": 100, "output_tokens": 10}}}}),
            ]
            return _Resp(text="\n".join(lines))
        self.polls += 1
        return _Resp({"id": "msgbatch_1", "processing_status": "ended"})

    async def aclose(self):
        return None


async def test_anthropic_batch_submit_poll_results_keyed_by_custom_id():
    client = _AnthropicBatchClient()
    provider = AnthropicBatchProvider(api_key="sk-ant", client=client)
    requests = [
        {"custom_id": "cid-A", "params": {"messages": [{"role": "user", "content": "a"}]}},
        {"custom_id": "cid-B", "params": {"messages": [{"role": "user", "content": "b"}]}},
    ]
    job = await provider.submit("claude-opus-4-8", requests)
    assert job.provider_batch_id == "msgbatch_1"
    assert job.state == BatchJobState.POLLING
    assert set(k for k in job.custom_ids if k != "__meta__") == {"cid-A", "cid-B"}

    job = await provider.poll(job)
    assert job.state == BatchJobState.RETRIEVING  # 'ended' -> ready to retrieve

    results = {r.custom_id: r for r in await provider.results(job)}
    assert set(results) == {"cid-A", "cid-B"}
    assert results["cid-A"].text == "A" and results["cid-A"].prompt_tokens == 100
    assert results["cid-B"].text == "B" and results["cid-B"].completion_tokens == 20
    assert all(r.ok for r in results.values())


class _OpenAIBatchClient:
    def __init__(self) -> None:
        self.status = "validating"

    async def post(self, url, *, headers=None, json=None, files=None, data=None, **_k):  # noqa: A002
        if url == "/v1/files":
            return _Resp({"id": "file_in"})
        assert url == "/v1/batches"
        return _Resp({"id": "batch_1", "status": "validating"})

    async def get(self, url, *, headers=None, **_k):
        if url.endswith("/content"):
            lines = [
                json.dumps({"custom_id": "cid-2", "response": {"status_code": 200, "body": {
                    "model": "gpt-4o", "choices": [{"message": {"content": "two"}}],
                    "usage": {"prompt_tokens": 50, "completion_tokens": 5}}}}),
                json.dumps({"custom_id": "cid-1", "response": {"status_code": 200, "body": {
                    "model": "gpt-4o", "choices": [{"message": {"content": "one"}}],
                    "usage": {"prompt_tokens": 40, "completion_tokens": 4}}}}),
            ]
            return _Resp(text="\n".join(lines))
        # batch status poll -> completed + output file id
        return _Resp({"id": "batch_1", "status": "completed", "output_file_id": "file_out"})

    async def aclose(self):
        return None


async def test_openai_batch_submit_poll_results():
    provider = OpenAIBatchProvider(api_key="sk-oai", client=_OpenAIBatchClient())
    requests = [
        {"custom_id": "cid-1", "params": {"messages": [{"role": "user", "content": "1"}]}},
        {"custom_id": "cid-2", "params": {"messages": [{"role": "user", "content": "2"}]}},
    ]
    job = await provider.submit("gpt-4o", requests)
    assert job.provider_batch_id == "batch_1"
    job = await provider.poll(job)
    assert job.state == BatchJobState.RETRIEVING
    results = {r.custom_id: r for r in await provider.results(job)}
    assert set(results) == {"cid-1", "cid-2"}
    assert results["cid-1"].text == "one" and results["cid-2"].prompt_tokens == 50


# --------------------------------------------------------------------------- #
# 5) BatchJobStore — persistence, exactly-once ledger, resume-safe
# --------------------------------------------------------------------------- #
def _job() -> BatchJob:
    return BatchJob(
        id="batch-x", provider="anthropic", provider_batch_id="msgbatch_1",
        model="claude-opus-4-8", state=BatchJobState.RETRIEVING,
        custom_ids={"cid-A": {"retrieved": False, "result_state": None},
                    "cid-B": {"retrieved": False, "result_state": None}},
    )


def _results():
    return [
        BatchResult(custom_id="cid-A", text="A", prompt_tokens=100, completion_tokens=10,
                    model="claude-opus-4-8"),
        BatchResult(custom_id="cid-B", text="B", prompt_tokens=200, completion_tokens=20,
                    model="claude-opus-4-8"),
    ]


async def test_batch_store_save_get_list():
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)
    got = await store.get("batch-x")
    assert got is not None and got.provider_batch_id == "msgbatch_1"
    assert len(await store.list()) == 1


async def test_process_results_writes_one_usagedoc_each_at_batch_rate():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)

    recorded = await store.process_results(job, _results(), gw)
    assert len(recorded) == 2

    docs = await _usage_docs(es)
    assert len(docs) == 2  # exactly one UsageDoc per result (#6)
    for d in docs:
        assert d["batch"] is True
        assert d["outcome"] == UsageOutcome.OK.value
    # cid-A: 100 in + 10 out at opus (5.0/25.0), halved by batch.
    by_case = {d["prompt_tokens"]: d for d in docs}
    a = by_case[100]
    expected_a = round(((100 / 1e6) * 5.0 + (10 / 1e6) * 25.0) * 0.5, 8)
    assert a["cost"] == pytest.approx(expected_a)

    # Both custom_ids flagged retrieved; job flips to RETRIEVED.
    reloaded = await store.get("batch-x")
    assert reloaded.state == BatchJobState.RETRIEVED
    assert all(reloaded.custom_ids[c]["retrieved"] for c in ("cid-A", "cid-B"))


async def test_process_results_idempotent_no_double_write():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)

    await store.process_results(job, _results(), gw)
    assert len(await _usage_docs(es)) == 2

    # Re-process the SAME results (a re-poll / restart) -> zero new ledger rows.
    reloaded = await store.get("batch-x")
    newly = await store.process_results(reloaded, _results(), gw)
    assert newly == []
    assert len(await _usage_docs(es)) == 2  # still exactly two (#6 exactly-once)


async def test_process_results_partial_then_remainder():
    """Only cid-A comes back first (partial retrieval); cid-B later. Each is billed
    exactly once and only the newly-seen result writes a row."""
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)

    first = [BatchResult(custom_id="cid-A", text="A", prompt_tokens=100, completion_tokens=10,
                         model="claude-opus-4-8")]
    await store.process_results(await store.get("batch-x"), first, gw)
    assert len(await _usage_docs(es)) == 1
    mid = await store.get("batch-x")
    assert mid.custom_ids["cid-A"]["retrieved"] is True
    assert mid.custom_ids["cid-B"]["retrieved"] is False
    assert mid.state == BatchJobState.RETRIEVING  # not all retrieved yet

    # Now the FULL set arrives; only cid-B is new.
    newly = await store.process_results(await store.get("batch-x"), _results(), gw)
    assert {r.custom_id for r in newly} == {"cid-B"}
    assert len(await _usage_docs(es)) == 2
    done = await store.get("batch-x")
    assert done.state == BatchJobState.RETRIEVED


async def test_error_result_records_error_row_and_marks_retrieved():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)

    results = [
        BatchResult(custom_id="cid-A", text="A", prompt_tokens=100, completion_tokens=10,
                    model="claude-opus-4-8"),
        BatchResult(custom_id="cid-B", result_type="errored", error="boom",
                    model="claude-opus-4-8"),
    ]
    recorded = await store.process_results(job, results, gw)
    assert {r.custom_id for r in recorded} == {"cid-A"}  # only the OK one is returned
    docs = await _usage_docs(es)
    assert len(docs) == 2  # one OK + one ERROR row, still one per result (#6)
    outcomes = sorted(d["outcome"] for d in docs)
    assert outcomes == sorted([UsageOutcome.OK.value, UsageOutcome.ERROR.value])
    # The errored custom_id is still marked retrieved so it is not retried.
    reloaded = await store.get("batch-x")
    assert reloaded.custom_ids["cid-B"]["retrieved"] is True
    assert reloaded.custom_ids["cid-B"]["result_state"] == "errored"


async def test_load_open_jobs_resume_after_restart():
    kv = _kv()
    store = BatchJobStore(kv)
    # A still-polling job + a fully-retrieved job + an errored job.
    await store.save(BatchJob(id="batch-open", provider="anthropic",
                              model="claude-opus-4-8", state=BatchJobState.POLLING,
                              custom_ids={"c1": {"retrieved": False}}))
    await store.save(BatchJob(id="batch-done", provider="anthropic",
                              model="claude-opus-4-8", state=BatchJobState.RETRIEVED,
                              custom_ids={"c2": {"retrieved": True}}))
    await store.save(BatchJob(id="batch-err", provider="anthropic",
                              model="claude-opus-4-8", state=BatchJobState.ERRORED,
                              custom_ids={"c3": {"retrieved": False}}))

    # Simulate a restart: a fresh store over the SAME KV backend.
    resumed = BatchJobStore(kv)
    open_ids = {j.id for j in await resumed.load_open_jobs()}
    assert open_ids == {"batch-open"}  # done + errored are closed


async def test_retrieved_but_incomplete_job_is_still_open():
    """A job stamped RETRIEVED but with a custom_id still un-retrieved (e.g. a partial
    provider result) is still returned by load_open_jobs so the remainder gets folded."""
    kv = _kv()
    store = BatchJobStore(kv)
    await store.save(BatchJob(id="batch-partial", provider="anthropic",
                              model="claude-opus-4-8", state=BatchJobState.RETRIEVED,
                              custom_ids={"c1": {"retrieved": True},
                                          "c2": {"retrieved": False}}))
    open_ids = {j.id for j in await BatchJobStore(kv).load_open_jobs()}
    assert open_ids == {"batch-partial"}
