"""Batch-inference provider SPI (Round 4 — LLM economics).

Providers' async BATCH APIs (Anthropic Message Batches, OpenAI ``/v1/batches``)
run a large set of completions out-of-band at roughly HALF the synchronous price.
This module is the seam that submits a batch, polls it to completion, and streams
back per-request results — mirroring the enrichment-SPI ergonomics
(``manifest()`` descriptor + a ``PROVIDER_REGISTRY`` dispatch table) WITHOUT any
new runtime dependency.

Design invariants (the same non-negotiables the gateway enforces):

* **#6 (one UsageDoc per call).** A batch provider ONLY turns a batch of requests
  into a list of ``BatchResult`` (text + token usage per request). It NEVER writes
  the usage ledger — the ledger write is the gateway's job. The companion
  :class:`app.stores.batch_jobs.BatchJobStore` folds each result back through
  ``LLMGateway._record`` EXACTLY once (deduped by ``custom_id``), at the 0.5× batch
  rate, so a re-poll / restart can never double-write.
* **Unordered results.** Provider batch results arrive out of order; every result
  carries its ``custom_id`` and callers MUST key by it, never by position.
* **No network in tests.** The HTTP poster/client is INJECTED (``client=``) exactly
  like the enrichment providers + the Resend channel — the offline suite passes a
  fake client and never touches the wire.
* **#3 untouched.** A batch provider produces verdicts + token counts; it never
  imports ``case_manager`` and never calls ``decide()``. Folding results into cases
  (and the deterministic close/escalate) is the pipeline's job downstream.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator

import httpx

from ..constants import BatchJobState
from ..models import BatchJob
from ..utils import iso_now
from .providers import _estimate_tokens

logger = logging.getLogger("tlsoc.llm.batch")


# --------------------------------------------------------------------------- #
# Result carrier — one per submitted request, keyed by our custom_id.
# --------------------------------------------------------------------------- #
@dataclass
class BatchResult:
    """One request's outcome inside a batch. ``result_type`` is
    ``succeeded`` | ``errored`` | ``expired`` (mapped from the provider's per-request
    status). ``text`` + token counts are populated on success; ``error`` carries a
    short provider message otherwise. Results arrive UNORDERED — always key by
    ``custom_id``."""

    custom_id: str
    result_type: str = "succeeded"
    text: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    model: str = ""
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.result_type == "succeeded"


def batch_manifest() -> list[dict[str, Any]]:
    """A static descriptor of the batch providers available for discovery / the UI.

    Plain data (no secrets, no network): ``id`` + ``label`` + the ``discount``
    multiplier the ledger applies. Mirrors the enrichment ``manifest()`` shape so the
    Models page can list which providers support batch."""
    return [
        {"id": "anthropic", "label": "Anthropic Message Batches", "discount": 0.5,
         "endpoint": "/v1/messages/batches", "max_requests": 100_000, "max_bytes": 256 * 1024 * 1024},
        {"id": "openai", "label": "OpenAI Batch API", "discount": 0.5,
         "endpoint": "/v1/batches", "max_requests": 50_000, "max_bytes": 200 * 1024 * 1024},
    ]


# --------------------------------------------------------------------------- #
# SPI
# --------------------------------------------------------------------------- #
class BatchProvider:
    """Abstract batch worker. Subclasses implement submit/poll/results against a
    provider's async batch API. The HTTP client is injected so tests never hit the
    wire.

    * ``submit(model, requests) -> BatchJob`` — POST the batch, return a persistable
      :class:`BatchJob` (state ``submitted``/``polling``) carrying the provider batch
      id + a per-``custom_id`` tracking map.
    * ``poll(job) -> BatchJob`` — refresh ``job.state`` from the provider's
      ``processing_status``; returns the SAME job, mutated.
    * ``results(job) -> Iterator[BatchResult]`` — stream per-request results once the
      job has ended. Keyed by ``custom_id`` (unordered)."""

    name = "base"
    discount = 0.5  # 0.5 == 50% off; threaded onto the UsageDoc + cost_for(batch=True)

    def __init__(self, *, api_key: str = "", base_url: str = "",
                 client: httpx.AsyncClient | None = None) -> None:
        self._key = api_key
        self._base_url = base_url
        self._client = client or httpx.AsyncClient(base_url=base_url, timeout=120.0)
        self._owns_client = client is None

    async def submit(self, model: str, requests: list[dict[str, Any]]) -> BatchJob:  # noqa: D401
        raise NotImplementedError

    async def poll(self, job: BatchJob) -> BatchJob:
        raise NotImplementedError

    async def results(self, job: BatchJob) -> Iterator[BatchResult]:
        raise NotImplementedError

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # -- shared helpers ------------------------------------------------------ #
    @staticmethod
    def _seed_job(provider: str, model: str, provider_batch_id: str | None,
                  requests: Iterable[dict[str, Any]], state: BatchJobState) -> BatchJob:
        custom_ids: dict[str, dict[str, Any]] = {}
        for req in requests:
            cid = str(req.get("custom_id", "")).strip()
            if cid:
                custom_ids[cid] = {"retrieved": False, "result_state": None}
        return BatchJob(
            provider=provider, provider_batch_id=provider_batch_id, model=model,
            state=state, custom_ids=custom_ids, discount=0.5, submitted_at=iso_now(),
        )


# --------------------------------------------------------------------------- #
# Anthropic Message Batches — POST /v1/messages/batches, poll processing_status
# until 'ended', GET /{id}/results (JSONL). ≤100k requests / 256MB.
# --------------------------------------------------------------------------- #
class AnthropicBatchProvider(BatchProvider):
    name = "anthropic"

    def __init__(self, *, api_key: str = "", base_url: str = "https://api.anthropic.com",
                 client: httpx.AsyncClient | None = None) -> None:
        super().__init__(api_key=api_key, base_url=base_url, client=client)

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._key,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "message-batches-2024-09-24",
            "content-type": "application/json",
        }

    async def submit(self, model: str, requests: list[dict[str, Any]]) -> BatchJob:
        # Each request: {custom_id, params:{...Messages API body...}}. The model comes
        # from params.model when present, else the batch-level model.
        payload = {
            "requests": [
                {"custom_id": str(r["custom_id"]), "params": {"model": model, **(r.get("params") or {})}}
                for r in requests
            ]
        }
        resp = await self._client.post("/v1/messages/batches", headers=self._headers(), json=payload)
        resp.raise_for_status()
        data = resp.json()
        job = self._seed_job("anthropic", model, data.get("id"), requests, BatchJobState.POLLING)
        job.state = _anthropic_state(data.get("processing_status"))
        return job

    async def poll(self, job: BatchJob) -> BatchJob:
        if not job.provider_batch_id:
            return job
        resp = await self._client.get(
            f"/v1/messages/batches/{job.provider_batch_id}", headers=self._headers()
        )
        resp.raise_for_status()
        data = resp.json()
        job.state = _anthropic_state(data.get("processing_status"))
        job.polled_at = iso_now()
        return job

    async def results(self, job: BatchJob) -> Iterator[BatchResult]:
        if not job.provider_batch_id:
            return iter(())
        resp = await self._client.get(
            f"/v1/messages/batches/{job.provider_batch_id}/results", headers=self._headers()
        )
        resp.raise_for_status()
        out: list[BatchResult] = []
        for line in resp.text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            out.append(_parse_anthropic_result(row, job.model))
        return iter(out)


def _anthropic_state(status: str | None) -> BatchJobState:
    s = (status or "").strip().lower()
    if s in ("ended", "completed"):
        return BatchJobState.RETRIEVING
    if s in ("in_progress", "validating"):
        return BatchJobState.POLLING
    if s in ("canceling", "cancelled", "canceled", "errored", "failed"):
        return BatchJobState.ERRORED
    if s == "expired":
        return BatchJobState.EXPIRED
    return BatchJobState.POLLING


def _parse_anthropic_result(row: dict[str, Any], model: str) -> BatchResult:
    cid = str(row.get("custom_id", "")).strip()
    result = row.get("result") or {}
    rtype = str(result.get("type", "succeeded"))
    if rtype != "succeeded":
        # 'errored' | 'expired' | 'canceled' — normalise to our vocab.
        norm = "expired" if rtype in ("expired", "canceled", "cancelled") else "errored"
        err = ""
        try:
            err = json.dumps(result.get("error") or result.get("message") or {})[:300]
        except Exception:  # noqa: BLE001
            err = str(result)[:300]
        return BatchResult(custom_id=cid, result_type=norm, model=model, error=err)
    message = result.get("message") or {}
    text = "".join(
        b.get("text", "") for b in message.get("content", []) if b.get("type") == "text"
    )
    usage = message.get("usage", {}) or {}
    return BatchResult(
        custom_id=cid,
        result_type="succeeded",
        text=text,
        prompt_tokens=int(usage.get("input_tokens", _estimate_tokens(text)) or 0),
        completion_tokens=int(usage.get("output_tokens", _estimate_tokens(text)) or 0),
        cache_read_tokens=int(usage.get("cache_read_input_tokens", 0) or 0),
        cache_write_tokens=int(usage.get("cache_creation_input_tokens", 0) or 0),
        model=str(message.get("model") or model),
    )


# --------------------------------------------------------------------------- #
# OpenAI /v1/batches — upload a JSONL of {custom_id, method, url, body}, POST the
# batch, poll status until 'completed', GET the output file (JSONL keyed by
# custom_id). ≤50k requests / 200MB.
# --------------------------------------------------------------------------- #
class OpenAIBatchProvider(BatchProvider):
    name = "openai"

    def __init__(self, *, api_key: str = "", base_url: str = "https://api.openai.com",
                 client: httpx.AsyncClient | None = None) -> None:
        super().__init__(api_key=api_key, base_url=base_url, client=client)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._key}", "content-type": "application/json"}

    async def submit(self, model: str, requests: list[dict[str, Any]]) -> BatchJob:
        # 1) Upload the JSONL input file (purpose=batch). 2) POST the batch pointing at it.
        jsonl_lines = []
        for r in requests:
            jsonl_lines.append(json.dumps({
                "custom_id": str(r["custom_id"]),
                "method": "POST",
                "url": "/v1/chat/completions",
                "body": {"model": model, **(r.get("params") or {})},
            }))
        jsonl = "\n".join(jsonl_lines)
        up = await self._client.post(
            "/v1/files",
            headers={"Authorization": f"Bearer {self._key}"},
            files={"file": ("batch.jsonl", jsonl, "application/jsonl")},
            data={"purpose": "batch"},
        )
        up.raise_for_status()
        file_id = up.json().get("id")
        resp = await self._client.post(
            "/v1/batches",
            headers=self._headers(),
            json={"input_file_id": file_id, "endpoint": "/v1/chat/completions",
                  "completion_window": "24h"},
        )
        resp.raise_for_status()
        data = resp.json()
        job = self._seed_job("openai", model, data.get("id"), requests, BatchJobState.POLLING)
        job.state = _openai_state(data.get("status"))
        return job

    async def poll(self, job: BatchJob) -> BatchJob:
        if not job.provider_batch_id:
            return job
        resp = await self._client.get(f"/v1/batches/{job.provider_batch_id}", headers=self._headers())
        resp.raise_for_status()
        data = resp.json()
        job.state = _openai_state(data.get("status"))
        job.polled_at = iso_now()
        # Stash the output file id for results() (loose bag on custom_ids meta if absent).
        if data.get("output_file_id"):
            job.custom_ids.setdefault("__meta__", {})["output_file_id"] = data["output_file_id"]
        return job

    async def results(self, job: BatchJob) -> Iterator[BatchResult]:
        out_file = (job.custom_ids.get("__meta__") or {}).get("output_file_id")
        if not out_file:
            # Re-fetch the batch to discover the output file id.
            if not job.provider_batch_id:
                return iter(())
            r = await self._client.get(f"/v1/batches/{job.provider_batch_id}", headers=self._headers())
            r.raise_for_status()
            out_file = r.json().get("output_file_id")
        if not out_file:
            return iter(())
        content = await self._client.get(f"/v1/files/{out_file}/content", headers=self._headers())
        content.raise_for_status()
        out: list[BatchResult] = []
        for line in content.text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            out.append(_parse_openai_result(row, job.model))
        return iter(out)


def _openai_state(status: str | None) -> BatchJobState:
    s = (status or "").strip().lower()
    if s in ("completed",):
        return BatchJobState.RETRIEVING
    if s in ("validating", "in_progress", "finalizing"):
        return BatchJobState.POLLING
    if s in ("failed", "cancelling", "cancelled", "canceled"):
        return BatchJobState.ERRORED
    if s == "expired":
        return BatchJobState.EXPIRED
    return BatchJobState.POLLING


def _parse_openai_result(row: dict[str, Any], model: str) -> BatchResult:
    cid = str(row.get("custom_id", "")).strip()
    err = row.get("error")
    if err:
        try:
            msg = json.dumps(err)[:300]
        except Exception:  # noqa: BLE001
            msg = str(err)[:300]
        return BatchResult(custom_id=cid, result_type="errored", model=model, error=msg)
    resp = row.get("response") or {}
    status_code = int(resp.get("status_code", 200) or 200)
    body = resp.get("body") or {}
    if status_code >= 400:
        return BatchResult(custom_id=cid, result_type="errored", model=model,
                           error=json.dumps(body)[:300])
    choices = body.get("choices") or [{}]
    text = (choices[0].get("message") or {}).get("content") or ""
    usage = body.get("usage", {}) or {}
    details = usage.get("prompt_tokens_details") or {}
    cached = int(details.get("cached_tokens", 0) or 0) if isinstance(details, dict) else 0
    return BatchResult(
        custom_id=cid,
        result_type="succeeded",
        text=text,
        prompt_tokens=int(usage.get("prompt_tokens", _estimate_tokens(text)) or 0),
        completion_tokens=int(usage.get("completion_tokens", _estimate_tokens(text)) or 0),
        cache_read_tokens=cached,
        model=str(body.get("model") or model),
    )


# --------------------------------------------------------------------------- #
# name -> factory dispatch (mirrors providers.PROVIDER_REGISTRY). The HTTP client
# is injected for tests; the gateway/store passes credentials.
# --------------------------------------------------------------------------- #
def _make_anthropic_batch(*, api_key: str = "", base_url: str | None = None,
                          client: httpx.AsyncClient | None = None, **_: Any) -> BatchProvider:
    return AnthropicBatchProvider(api_key=api_key,
                                  base_url=base_url or "https://api.anthropic.com",
                                  client=client)


def _make_openai_batch(*, api_key: str = "", base_url: str | None = None,
                       client: httpx.AsyncClient | None = None, **_: Any) -> BatchProvider:
    return OpenAIBatchProvider(api_key=api_key,
                               base_url=base_url or "https://api.openai.com",
                               client=client)


BATCH_PROVIDER_REGISTRY: dict[str, Any] = {
    "anthropic": _make_anthropic_batch,
    "openai": _make_openai_batch,
}


def make_batch_provider(name: str, **kwargs: Any) -> BatchProvider:
    """Construct a batch provider by name (``anthropic`` | ``openai``). Raises
    ``KeyError`` on an unknown name."""
    factory = BATCH_PROVIDER_REGISTRY[str(name)]
    return factory(**kwargs)
