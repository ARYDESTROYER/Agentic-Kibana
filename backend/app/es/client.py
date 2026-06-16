"""Concrete Elasticsearch client backed by the official async driver.

Holds TWO physically separate connections:

* ``_ro`` authenticates with the read-only, log-scoped API key and backs
  ``search_logs`` only.
* ``_mgmt`` authenticates with the management key (scoped to ``tlsoc-agent-*``)
  and backs every write / bookkeeping operation.

If a key is missing the corresponding connection is ``None`` and its operations
raise a clear, actionable error rather than silently escalating.
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import Secrets
from .base import BaseESClient

logger = logging.getLogger("tlsoc.es")

try:  # The driver is optional at import time so tests can run with the fake.
    from elasticsearch import AsyncElasticsearch
    from elasticsearch import exceptions as es_exceptions

    _DRIVER_AVAILABLE = True
except Exception:  # pragma: no cover - exercised only when driver absent
    AsyncElasticsearch = None  # type: ignore[assignment]
    es_exceptions = None  # type: ignore[assignment]
    _DRIVER_AVAILABLE = False


class RealESClient(BaseESClient):
    def __init__(self, secrets: Secrets) -> None:
        if not _DRIVER_AVAILABLE:
            raise RuntimeError("elasticsearch driver not installed; install requirements.txt")
        self._secrets = secrets
        common: dict[str, Any] = {
            "request_timeout": secrets.es_request_timeout,
            "verify_certs": secrets.es_verify_certs,
        }
        if secrets.es_ca_cert:
            common["ca_certs"] = secrets.es_ca_cert

        self._ro: AsyncElasticsearch | None = None
        self._mgmt: AsyncElasticsearch | None = None
        if secrets.es_api_key:
            self._ro = AsyncElasticsearch(secrets.es_url, api_key=secrets.es_api_key, **common)
        if secrets.es_mgmt_api_key:
            self._mgmt = AsyncElasticsearch(
                secrets.es_url, api_key=secrets.es_mgmt_api_key, **common
            )
        elif secrets.es_api_key:
            # No dedicated management key: the suite cannot own its indices with a
            # read-only key. We do NOT silently fall back to a write credential.
            logger.warning(
                "ES_MGMT_API_KEY not set: the backend cannot persist its own indices. "
                "Provide a management key scoped to tlsoc-agent-* (see DEPLOY.md)."
            )

    # --- internals ---
    def _require_ro(self) -> "AsyncElasticsearch":
        if self._ro is None:
            raise RuntimeError(
                "Read-only ES API key (ES_API_KEY) is not configured; cannot read the log surface."
            )
        return self._ro

    def _require_mgmt(self) -> "AsyncElasticsearch":
        if self._mgmt is None:
            raise RuntimeError(
                "Management ES API key (ES_MGMT_API_KEY) is not configured; "
                "cannot write the suite's own indices."
            )
        return self._mgmt

    # --- health ---
    async def ping(self) -> bool:
        client = self._mgmt or self._ro
        if client is None:
            return False
        try:
            return bool(await client.ping())
        except Exception as exc:  # noqa: BLE001
            logger.warning("ES ping failed: %s", exc)
            return False

    # --- read-only log surface ---
    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        client = self._require_ro()
        resp = await client.search(index=index, body=body)
        return resp.body if hasattr(resp, "body") else dict(resp)

    # --- management ---
    async def index_template_exists(self, name: str) -> bool:
        client = self._require_mgmt()
        try:
            return bool(await client.indices.exists_index_template(name=name))
        except Exception:  # noqa: BLE001
            return False

    async def put_index_template(self, name: str, body: dict[str, Any]) -> None:
        client = self._require_mgmt()
        await client.indices.put_index_template(name=name, **body)

    async def index_exists(self, name: str) -> bool:
        client = self._require_mgmt()
        try:
            return bool(await client.indices.exists(index=name))
        except Exception:  # noqa: BLE001
            return False

    async def create_index(self, name: str, body: dict[str, Any] | None = None) -> None:
        client = self._require_mgmt()
        try:
            await client.indices.create(index=name, **(body or {}))
        except Exception as exc:  # noqa: BLE001
            # resource_already_exists is benign (idempotent bootstrap).
            if es_exceptions and isinstance(exc, es_exceptions.BadRequestError):
                if "resource_already_exists" in str(exc):
                    return
            raise

    async def index_doc(
        self,
        index: str,
        doc: dict[str, Any],
        doc_id: str | None = None,
        refresh: bool = False,
    ) -> str:
        client = self._require_mgmt()
        resp = await client.index(index=index, id=doc_id, document=doc, refresh=refresh)
        return str(resp["_id"])

    async def get_doc(self, index: str, doc_id: str) -> dict[str, Any] | None:
        client = self._require_mgmt()
        try:
            resp = await client.get(index=index, id=doc_id)
            return resp["_source"]
        except Exception as exc:  # noqa: BLE001
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return None
            logger.warning("get_doc(%s/%s) failed: %s", index, doc_id, exc)
            return None

    async def update_doc(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> None:
        client = self._require_mgmt()
        await client.update(
            index=index, id=doc_id, doc=doc, doc_as_upsert=True, refresh=refresh
        )

    async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        client = self._require_mgmt()
        try:
            resp = await client.search(index=index, body=body)
            return resp.body if hasattr(resp, "body") else dict(resp)
        except Exception as exc:  # noqa: BLE001
            if es_exceptions and isinstance(exc, es_exceptions.NotFoundError):
                return {"hits": {"hits": [], "total": {"value": 0}}, "aggregations": {}}
            raise

    async def count(self, index: str, body: dict[str, Any]) -> int:
        client = self._require_mgmt()
        try:
            resp = await client.count(index=index, query=body.get("query"))
            return int(resp["count"])
        except Exception:  # noqa: BLE001
            return 0

    async def close(self) -> None:
        for client in (self._ro, self._mgmt):
            if client is not None:
                try:
                    await client.close()
                except Exception:  # noqa: BLE001
                    pass
