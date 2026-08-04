"""Durable authorization bindings for retryable system-update operations."""

from __future__ import annotations

import hashlib
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..engine.update_supervisor import UpdateRelease
from ..utils import iso_now
from .base import KV_REV_FIELD, KVStore, kv_mutate_strict


UPDATE_OPERATIONS_NS = "system_update_operations"


class UpdateOperationConflict(RuntimeError):
    """An idempotency key is already bound to a different exact request."""


class UpdateOperationRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: Literal["preflight", "start"]
    release: UpdateRelease
    request_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    authorized_at: str = Field(min_length=1, max_length=80)


class UpdateOperationStore:
    """Strict, cross-process CAS journal over the existing state-backend KV.

    Raw idempotency keys and preflight tokens are never stored.  A SHA-256 key
    locates the record and a separate request fingerprint binds all material
    request fields.  Records are immutable authorization snapshots: they permit
    only an exact retry and never authorize a new release or changed token.
    """

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    @staticmethod
    def _key(idempotency_key: str) -> str:
        return hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()

    @staticmethod
    def _decode(value: dict | None) -> UpdateOperationRecord | None:
        if value is None:
            return None
        payload = {key: item for key, item in value.items() if key != KV_REV_FIELD}
        return UpdateOperationRecord.model_validate(payload)

    @staticmethod
    def _matches(
        record: UpdateOperationRecord,
        *,
        operation: Literal["preflight", "start"],
        release_id: str,
        request_fingerprint: str,
    ) -> bool:
        return (
            record.operation == operation
            and record.release.release_id == release_id
            and record.request_fingerprint == request_fingerprint
        )

    async def find_exact(
        self,
        *,
        operation: Literal["preflight", "start"],
        release_id: str,
        idempotency_key: str,
        request_fingerprint: str,
    ) -> UpdateOperationRecord | None:
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        record = self._decode(
            await getter(UPDATE_OPERATIONS_NS, self._key(idempotency_key))
        )
        if record is None:
            return None
        if not self._matches(
            record,
            operation=operation,
            release_id=release_id,
            request_fingerprint=request_fingerprint,
        ):
            raise UpdateOperationConflict(
                "idempotency key is already bound to a different update request"
            )
        return record

    async def reserve(
        self,
        *,
        operation: Literal["preflight", "start"],
        release: UpdateRelease,
        idempotency_key: str,
        request_fingerprint: str,
    ) -> UpdateOperationRecord:
        existing = await self.find_exact(
            operation=operation,
            release_id=release.release_id,
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
        )
        if existing is not None:
            return existing

        candidate = UpdateOperationRecord(
            operation=operation,
            release=release,
            request_fingerprint=request_fingerprint,
            authorized_at=iso_now(),
        )

        def bind(current: dict | None) -> dict:
            record = self._decode(current)
            if record is not None:
                if not self._matches(
                    record,
                    operation=operation,
                    release_id=release.release_id,
                    request_fingerprint=request_fingerprint,
                ):
                    raise UpdateOperationConflict(
                        "idempotency key is already bound to a different update request"
                    )
                return dict(current or {})
            return candidate.model_dump(mode="json")

        persisted = await kv_mutate_strict(
            self._kv,
            UPDATE_OPERATIONS_NS,
            self._key(idempotency_key),
            bind,
            lock=self._kv._lock_for(
                UPDATE_OPERATIONS_NS, self._key(idempotency_key)
            ),
        )
        record = self._decode(persisted)
        if record is None:
            raise RuntimeError("system update operation reservation was not persisted")
        return record
