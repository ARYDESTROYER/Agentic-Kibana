"""Durable, bounded, per-user Workspace chat history.

Workspace transcripts are intentionally separate from case-scoped collaboration
threads.  Every normalized principal owns a hashed KV partition, so one user's
history read/write never loads every other user's transcript.  The legacy shared
document is read lazily and migrated one principal at a time.

Unlike the platform's best-effort auxiliary stores, chat persistence is part of the
send contract: a saved turn must really be durable.  This module therefore uses the
strict KV hooks when a backend exposes them, verifies every compare-and-set, and
raises :class:`ChatHistoryUnavailable` instead of returning optimistic success.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Literal, TypeVar

from ..constants import (
    CHAT_CONVERSATIONS_KEY,
    CHAT_CONVERSATIONS_NS,
    USER_PREFS_DEFAULT_BUCKET,
)
from ..models import ChatConversation, ChatConversationMessage, ChatConversationSummary
from ..utils import iso_now, new_id
from .base import KVStore

_T = TypeVar("_T")

MAX_CONVERSATIONS_PER_USER = 50
MAX_MESSAGES_PER_CONVERSATION = 100
MAX_CONVERSATION_BYTES = 256_000
MAX_USER_MESSAGE_CHARS = 12_000
MAX_ASSISTANT_MESSAGE_CHARS = 24_000
MAX_RESPONSE_BYTES = 64_000
MAX_TITLE_CHARS = 80
MAX_PREVIEW_CHARS = 160
MAX_IDEMPOTENCY_RECORDS = 256
IDEMPOTENCY_PENDING_TTL_SECONDS = 10 * 60
CAS_RETRIES = 8

_SCHEMA_VERSION = 2
_PARTITION_PREFIX = "user-"


class ChatHistoryUnavailable(RuntimeError):
    """The history backend could not prove that a read or write succeeded."""


class ChatRequestInProgress(RuntimeError):
    """The same idempotency key currently owns an unexpired model invocation."""


class ChatRequestCapacityBusy(RuntimeError):
    """A principal already owns the maximum number of live request leases."""


class ChatIdempotencyConflict(RuntimeError):
    """An idempotency key was reused for a materially different request."""


class ChatConversationMissing(RuntimeError):
    """A requested owned conversation no longer exists."""


@dataclass(frozen=True)
class ChatHistoryPage:
    conversations: list[ChatConversationSummary]
    total: int
    history_truncated: bool
    total_conversation_count: int
    oldest_retained_at: str | None


@dataclass(frozen=True)
class ChatExchangeReservation:
    status: Literal["reserved", "completed"]
    idempotency_key: str
    conversation_id: str
    conversation: ChatConversation | None = None
    assistant_message: ChatConversationMessage | None = None
    conversation_title: str | None = None
    lease_token: str | None = None


def normalize_user_id(user_id: str | None) -> str:
    uid = (user_id or "").strip().lower()
    return uid or USER_PREFS_DEFAULT_BUCKET


def partition_key_for_user(user_id: str | None) -> str:
    """Opaque deterministic key; raw usernames never appear in KV document ids."""
    digest = hashlib.sha256(normalize_user_id(user_id).encode("utf-8")).hexdigest()
    return f"{_PARTITION_PREFIX}{digest}"


def derive_title(message: str) -> str:
    title = " ".join(str(message or "").split()).strip()
    if not title:
        return "New conversation"
    if len(title) <= MAX_TITLE_CHARS:
        return title
    return title[: MAX_TITLE_CHARS - 1].rstrip() + "\u2026"


def _clip(value: str, limit: int) -> tuple[str, bool]:
    text = str(value or "")
    if len(text) <= limit:
        return text, False
    marker = "\n\u2026 [truncated in saved history]"
    return text[: max(0, limit - len(marker))].rstrip() + marker, True


def _bounded_response(value: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
    if not isinstance(value, dict):
        return None, False
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    except Exception:  # noqa: BLE001 -- malformed optional presentation data is omitted
        return None, True
    if len(encoded.encode("utf-8")) <= MAX_RESPONSE_BYTES:
        return copy.deepcopy(value), bool(value.get("truncated"))
    compact = {
        key: value.get(key)
        for key in (
            "query", "discover", "case_id", "cost", "idempotency_key",
            "effective_model", "effective_source_id", "effective_source_name",
        )
        if value.get(key) is not None
    }
    compact["truncated"] = True
    return compact, True


def _conversation_size(messages: list[ChatConversationMessage]) -> int:
    try:
        return len(json.dumps(
            [m.model_dump(mode="json") for m in messages],
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8"))
    except Exception:  # noqa: BLE001
        return MAX_CONVERSATION_BYTES + 1


def _trim_messages(
    messages: list[ChatConversationMessage],
) -> tuple[list[ChatConversationMessage], bool]:
    kept = list(messages[-MAX_MESSAGES_PER_CONVERSATION:])
    truncated = len(kept) < len(messages)
    # Prefer dropping complete oldest exchanges. The one-row fallback tolerates a
    # corrupt/legacy odd-length history without looping forever.
    while len(kept) > 2 and _conversation_size(kept) > MAX_CONVERSATION_BYTES:
        drop = 2 if len(kept) >= 4 else 1
        kept = kept[drop:]
        truncated = True
    return kept, truncated


def _summary(conversation: ChatConversation) -> ChatConversationSummary:
    return ChatConversationSummary(**conversation.model_dump(exclude={"messages"}))


def _empty_partition() -> dict[str, Any]:
    return {
        "schema": _SCHEMA_VERSION,
        "conversations": {},
        "requests": {},
        "history_truncated": False,
        "total_conversation_count": 0,
    }


def _rev(doc: dict[str, Any] | None) -> int:
    try:
        return max(0, int((doc or {}).get("_rev", 0)))
    except (TypeError, ValueError):
        return 0


def _parse_time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _is_stale(value: Any) -> bool:
    timestamp = _parse_time(value)
    if timestamp is None:
        return True
    return (datetime.now(timezone.utc) - timestamp).total_seconds() >= (
        IDEMPOTENCY_PENDING_TTL_SECONDS
    )


def _normalize_conversation(raw: Any, cid: str) -> ChatConversation | None:
    try:
        conversation = ChatConversation.model_validate(raw)
    except Exception:  # noqa: BLE001 -- one corrupt row must not hide valid siblings
        return None
    messages = list(conversation.messages)
    retained = len(messages)
    total = max(int(conversation.total_message_count or 0), retained)
    return conversation.model_copy(update={
        "id": str(cid),
        "message_count": retained,
        "total_message_count": total,
        "history_truncated": bool(conversation.history_truncated or total > retained),
        "oldest_retained_at": messages[0].created_at if messages else None,
    })


def _decode_partition(doc: dict[str, Any] | None) -> dict[str, Any]:
    decoded = _empty_partition()
    if not isinstance(doc, dict):
        return decoded
    rows: dict[str, ChatConversation] = {}
    for cid, raw in (doc.get("conversations") or {}).items():
        conversation = _normalize_conversation(raw, str(cid))
        if conversation is not None:
            rows[str(cid)] = conversation
    requests = {
        str(key): copy.deepcopy(value)
        for key, value in (doc.get("requests") or {}).items()
        if isinstance(value, dict)
    }
    retained = len(rows)
    decoded.update({
        "conversations": rows,
        "requests": requests,
        "history_truncated": bool(doc.get("history_truncated", False)),
        "total_conversation_count": max(
            retained, int(doc.get("total_conversation_count", retained) or retained),
        ),
    })
    return decoded


def _encode_partition(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": _SCHEMA_VERSION,
        "conversations": {
            cid: conversation.model_dump(mode="json")
            for cid, conversation in data["conversations"].items()
        },
        "requests": copy.deepcopy(data.get("requests", {})),
        "history_truncated": bool(data.get("history_truncated", False)),
        "total_conversation_count": max(
            len(data["conversations"]),
            int(data.get("total_conversation_count", 0) or 0),
        ),
    }


class ChatConversationStore:
    """Strict CRUD and retry-safe sends over per-principal KV partitions."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._locks: dict[str, asyncio.Lock] = {}
        self._index_lock = asyncio.Lock()

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def _strict_get(self, key: str) -> dict[str, Any] | None:
        getter = getattr(self._kv, "get_strict", None)
        try:
            value = (
                await getter(CHAT_CONVERSATIONS_NS, key)
                if callable(getter)
                else await self._kv.get(CHAT_CONVERSATIONS_NS, key)
            )
        except Exception as exc:  # noqa: BLE001
            raise ChatHistoryUnavailable("Chat history could not be read.") from exc
        if value is not None and not isinstance(value, dict):
            raise ChatHistoryUnavailable("Chat history returned an invalid document.")
        return copy.deepcopy(value)

    async def _strict_put_if(
        self, key: str, value: dict[str, Any], expected_rev: int
    ) -> bool:
        writer = getattr(self._kv, "put_if_strict", None)
        try:
            return bool(
                await writer(CHAT_CONVERSATIONS_NS, key, value, expected_rev)
                if callable(writer)
                else await self._kv.put_if(
                    CHAT_CONVERSATIONS_NS, key, value, expected_rev
                )
            )
        except Exception as exc:  # noqa: BLE001
            raise ChatHistoryUnavailable("Chat history could not be saved.") from exc

    async def _strict_mutate(
        self,
        key: str,
        change: Callable[[dict[str, Any] | None], tuple[dict[str, Any], _T]],
        *,
        lock: asyncio.Lock | None = None,
    ) -> _T:
        async with (lock or self._lock_for(key)):
            for _attempt in range(CAS_RETRIES):
                current = await self._strict_get(key)
                expected = _rev(current)
                proposed, result = change(copy.deepcopy(current))
                saved = copy.deepcopy(proposed)
                saved["_rev"] = expected + 1
                if not await self._strict_put_if(key, saved, expected):
                    continue
                confirmed = await self._strict_get(key)
                if _rev(confirmed) < expected + 1:
                    raise ChatHistoryUnavailable(
                        "Chat history storage did not confirm the write."
                    )
                return result
        raise ChatHistoryUnavailable("Chat history changed too quickly; retry the request.")

    async def _register_partition(self, partition_key: str) -> None:
        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            doc = copy.deepcopy(current or {})
            partitions = {str(item) for item in (doc.get("partitions") or [])}
            partitions.add(partition_key)
            doc["schema"] = _SCHEMA_VERSION
            doc["partitions"] = sorted(partitions)
            return doc, None

        await self._strict_mutate(
            CHAT_CONVERSATIONS_KEY, _change, lock=self._index_lock
        )

    async def _migrate_legacy(
        self, uid: str, partition_key: str, legacy: dict[str, Any]
    ) -> dict[str, Any] | None:
        raw_rows = (legacy.get("conversations") or {}).get(uid)
        if not isinstance(raw_rows, dict) or not raw_rows:
            return None
        migrated_rows: dict[str, ChatConversation] = {}
        for cid, raw in raw_rows.items():
            conversation = _normalize_conversation(raw, str(cid))
            if conversation is not None:
                migrated_rows[str(cid)] = conversation
        if not migrated_rows:
            return None

        await self._register_partition(partition_key)

        def _create(current: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]]:
            data = _decode_partition(current)
            if not data["conversations"]:
                data["conversations"] = dict(migrated_rows)
                data["total_conversation_count"] = len(migrated_rows)
            return _encode_partition(data), data

        migrated = await self._strict_mutate(partition_key, _create)

        # Cleanup is deliberately second phase: a failed partition write leaves the
        # legacy copy intact. A failed cleanup is safe and the next read is idempotent.
        def _cleanup(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            doc = copy.deepcopy(current or {})
            conversations = dict(doc.get("conversations") or {})
            conversations.pop(uid, None)
            doc["conversations"] = conversations
            partitions = {str(item) for item in (doc.get("partitions") or [])}
            partitions.add(partition_key)
            doc["partitions"] = sorted(partitions)
            doc["schema"] = _SCHEMA_VERSION
            return doc, None

        await self._strict_mutate(
            CHAT_CONVERSATIONS_KEY, _cleanup, lock=self._index_lock
        )
        return migrated

    async def _load_partition(self, user_id: str | None) -> tuple[str, dict[str, Any]]:
        uid = normalize_user_id(user_id)
        key = partition_key_for_user(uid)
        current = await self._strict_get(key)
        if current is not None:
            return key, _decode_partition(current)
        legacy = await self._strict_get(CHAT_CONVERSATIONS_KEY)
        migrated = await self._migrate_legacy(uid, key, legacy or {})
        return key, migrated if migrated is not None else _empty_partition()

    async def _ensure_partition(self, user_id: str | None) -> tuple[str, dict[str, Any]]:
        key, data = await self._load_partition(user_id)
        await self._register_partition(key)
        return key, data

    async def list_page(
        self, user_id: str | None, *, limit: int = 30, offset: int = 0
    ) -> ChatHistoryPage:
        _key, data = await self._load_partition(user_id)
        rows = list(data["conversations"].values())
        rows.sort(key=lambda item: (item.updated_at, item.id), reverse=True)
        retained = len(rows)
        start = max(0, int(offset))
        end = start + max(0, int(limit))
        total_lifetime = max(retained, int(data.get("total_conversation_count", retained)))
        return ChatHistoryPage(
            conversations=[_summary(item) for item in rows[start:end]],
            total=retained,
            history_truncated=bool(
                data.get("history_truncated", False) or total_lifetime > retained
            ),
            total_conversation_count=total_lifetime,
            oldest_retained_at=min(
                (item.created_at for item in rows), default=None
            ),
        )

    async def list_for_user(
        self, user_id: str | None, *, limit: int = 30, offset: int = 0
    ) -> tuple[list[ChatConversationSummary], int]:
        page = await self.list_page(user_id, limit=limit, offset=offset)
        return page.conversations, page.total

    async def get(self, user_id: str | None, conversation_id: str) -> ChatConversation | None:
        _key, data = await self._load_partition(user_id)
        return data["conversations"].get(str(conversation_id))

    @staticmethod
    def _prune_requests(data: dict[str, Any]) -> None:
        requests = data.get("requests", {})
        if len(requests) <= MAX_IDEMPOTENCY_RECORDS:
            return
        # Completed receipts are the safest records to age out.  Abandoned leases
        # must also be reclaimable, otherwise a sequence of crashed workers can grow
        # one user's partition without bound.  Never evict a live lease: its worker
        # still needs the token to complete or abort the exact request safely.
        evictable = sorted(
            (
                (key, value)
                for key, value in requests.items()
                if value.get("status") == "completed"
                or (
                    value.get("status") == "in_progress"
                    and _is_stale(value.get("updated_at"))
                )
            ),
            key=lambda item: (
                0 if item[1].get("status") == "completed" else 1,
                str(item[1].get("updated_at") or ""),
                item[0],
            ),
        )
        excess = max(0, len(requests) - MAX_IDEMPOTENCY_RECORDS)
        for key, _value in evictable[:excess]:
            requests.pop(key, None)

    @staticmethod
    def _append_to_data(
        data: dict[str, Any],
        *,
        conversation_id: str,
        require_existing: bool,
        user_content: str,
        assistant_content: str,
        response: dict[str, Any] | None,
        model: str | None,
        source_id: str | None,
        source_name: str | None,
        idempotency_key: str | None,
        now: str,
    ) -> tuple[ChatConversation | None, str | None]:
        rows: dict[str, ChatConversation] = dict(data["conversations"])
        existing = rows.get(conversation_id)
        if require_existing and existing is None:
            return None, None
        is_new = existing is None
        if existing is None:
            existing = ChatConversation(
                id=conversation_id,
                title=derive_title(user_content),
                preview="",
                created_at=now,
                updated_at=now,
                message_count=0,
                total_message_count=0,
                messages=[],
            )

        saved_user, user_truncated = _clip(user_content, MAX_USER_MESSAGE_CHARS)
        saved_assistant, assistant_truncated = _clip(
            assistant_content, MAX_ASSISTANT_MESSAGE_CHARS
        )
        bounded_response, response_truncated = _bounded_response(response)
        if bounded_response is not None and (
            user_truncated or assistant_truncated or response_truncated
        ):
            bounded_response["truncated"] = True
        user_message = ChatConversationMessage(
            id=new_id("chatmsg-"),
            role="user",
            content=saved_user,
            created_at=now,
            idempotency_key=idempotency_key,
        )
        assistant_message = ChatConversationMessage(
            id=new_id("chatmsg-"),
            role="assistant",
            content=saved_assistant,
            created_at=now,
            response=bounded_response,
            model=(str(model).strip() or None) if model is not None else None,
            source_id=(str(source_id).strip() or None) if source_id is not None else None,
            source_name=(str(source_name).strip() or None)
            if source_name is not None else None,
            idempotency_key=idempotency_key,
        )
        candidate = [*existing.messages, user_message, assistant_message]
        messages, retention_truncated = _trim_messages(candidate)
        total_messages = max(existing.total_message_count, len(existing.messages)) + 2
        history_truncated = bool(
            existing.history_truncated
            or retention_truncated
            or user_truncated
            or assistant_truncated
            or response_truncated
        )
        preview, _ = _clip(assistant_content, MAX_PREVIEW_CHARS)
        stored = existing.model_copy(update={
            "messages": messages,
            "message_count": len(messages),
            "total_message_count": total_messages,
            "history_truncated": history_truncated,
            "oldest_retained_at": messages[0].created_at if messages else None,
            "preview": " ".join(preview.split()),
            "updated_at": now,
            "model": assistant_message.model or existing.model,
            "source_id": assistant_message.source_id
            if source_id is not None else existing.source_id,
            "source_name": assistant_message.source_name
            if source_name is not None else existing.source_name,
        })
        rows[conversation_id] = stored
        if is_new:
            data["total_conversation_count"] = max(
                len(rows), int(data.get("total_conversation_count", 0)) + 1
            )
        if len(rows) > MAX_CONVERSATIONS_PER_USER:
            keep = sorted(
                rows.values(), key=lambda item: (item.updated_at, item.id), reverse=True
            )[:MAX_CONVERSATIONS_PER_USER]
            kept_ids = {item.id for item in keep}
            rows = {item.id: item for item in keep}
            data["history_truncated"] = True
            # Completed receipts remain bounded independently of transcript rows.
            # Keeping them allows a lost-response retry to replay after the original
            # assistant message (or entire old conversation) ages out of retention.
        data["conversations"] = rows
        return stored, assistant_message.id

    async def append_exchange(
        self,
        user_id: str | None,
        *,
        conversation_id: str | None,
        user_content: str,
        assistant_content: str,
        response: dict[str, Any] | None = None,
        model: str | None = None,
        source_id: str | None = None,
        source_name: str | None = None,
        idempotency_key: str | None = None,
    ) -> ChatConversation | None:
        key, _data = await self._ensure_partition(user_id)
        cid = str(conversation_id or new_id("chat-"))
        now = iso_now()

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], ChatConversation | None]:
            data = _decode_partition(current)
            stored, _assistant_id = self._append_to_data(
                data,
                conversation_id=cid,
                require_existing=conversation_id is not None,
                user_content=user_content,
                assistant_content=assistant_content,
                response=response,
                model=model,
                source_id=source_id,
                source_name=source_name,
                idempotency_key=idempotency_key,
                now=now,
            )
            return _encode_partition(data), stored

        return await self._strict_mutate(key, _change)

    async def reserve_exchange(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        conversation_id: str | None,
    ) -> ChatExchangeReservation:
        key, _data = await self._ensure_partition(user_id)
        cid = str(conversation_id or new_id("chat-"))
        now = iso_now()

        def _change(
            current: dict[str, Any] | None,
        ) -> tuple[dict[str, Any], ChatExchangeReservation]:
            data = _decode_partition(current)
            rows: dict[str, ChatConversation] = data["conversations"]
            request = data["requests"].get(idempotency_key)
            if request is not None:
                if request.get("fingerprint") != request_fingerprint:
                    raise ChatIdempotencyConflict(
                        "The idempotency key belongs to a different chat request."
                    )
                request_cid = str(request.get("conversation_id") or cid)
                if request.get("status") == "completed":
                    conversation = rows.get(request_cid)
                    assistant_id = str(request.get("assistant_message_id") or "")
                    assistant = next(
                        (
                            item
                            for item in (conversation.messages if conversation else [])
                            if item.id == assistant_id
                        ),
                        None,
                    )
                    if assistant is None and request.get("assistant_content") is not None:
                        assistant = ChatConversationMessage(
                            id=assistant_id or new_id("chatmsg-replay-"),
                            role="assistant",
                            content=str(request.get("assistant_content") or ""),
                            created_at=str(request.get("updated_at") or now),
                            response=copy.deepcopy(request.get("assistant_response")),
                            model=request.get("model"),
                            source_id=request.get("source_id"),
                            source_name=request.get("source_name"),
                            idempotency_key=idempotency_key,
                        )
                    if assistant is None:
                        raise ChatHistoryUnavailable(
                            "The completed chat receipt could not be restored."
                        )
                    return _encode_partition(data), ChatExchangeReservation(
                        status="completed",
                        idempotency_key=idempotency_key,
                        conversation_id=request_cid,
                        conversation=conversation,
                        assistant_message=assistant,
                        conversation_title=str(
                            request.get("conversation_title")
                            or (conversation.title if conversation else "Conversation")
                        ),
                    )
                if conversation_id is not None and request_cid not in rows:
                    raise ChatConversationMissing("conversation not found")
                if not _is_stale(request.get("updated_at")):
                    raise ChatRequestInProgress("This chat request is already in progress.")
                # A crashed worker's bounded lease may be reclaimed only by the exact
                # same request fingerprint and conversation target.
                lease_token = new_id("chatlease-")
                request["updated_at"] = now
                request["status"] = "in_progress"
                request["lease_token"] = lease_token
                data["requests"][idempotency_key] = request
                return _encode_partition(data), ChatExchangeReservation(
                    status="reserved",
                    idempotency_key=idempotency_key,
                    conversation_id=request_cid,
                    lease_token=lease_token,
                )

            if conversation_id is not None and conversation_id not in rows:
                raise ChatConversationMissing("conversation not found")

            lease_token = new_id("chatlease-")
            data["requests"][idempotency_key] = {
                "status": "in_progress",
                "fingerprint": request_fingerprint,
                "conversation_id": cid,
                "created_at": now,
                "updated_at": now,
                "lease_token": lease_token,
            }
            self._prune_requests(data)
            if len(data["requests"]) > MAX_IDEMPOTENCY_RECORDS:
                raise ChatRequestCapacityBusy(
                    "Too many chat requests are in progress; retry shortly."
                )
            return _encode_partition(data), ChatExchangeReservation(
                status="reserved",
                idempotency_key=idempotency_key,
                conversation_id=cid,
                lease_token=lease_token,
            )

        return await self._strict_mutate(key, _change)

    async def complete_exchange(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        conversation_id: str,
        lease_token: str,
        requested_existing_conversation: bool,
        user_content: str,
        assistant_content: str,
        response: dict[str, Any] | None,
        model: str | None,
        source_id: str | None,
        source_name: str | None,
    ) -> ChatExchangeReservation:
        key, _data = await self._ensure_partition(user_id)
        now = iso_now()

        def _change(
            current: dict[str, Any] | None,
        ) -> tuple[dict[str, Any], ChatExchangeReservation]:
            data = _decode_partition(current)
            request = data["requests"].get(idempotency_key)
            if request is None or request.get("fingerprint") != request_fingerprint:
                raise ChatIdempotencyConflict("The chat reservation no longer matches.")
            if str(request.get("conversation_id") or "") != conversation_id:
                raise ChatIdempotencyConflict("The chat reservation target changed.")
            if request.get("status") == "completed":
                conversation = data["conversations"].get(conversation_id)
                assistant_id = str(request.get("assistant_message_id") or "")
                assistant = next(
                    (
                        item
                        for item in (conversation.messages if conversation else [])
                        if item.id == assistant_id
                    ),
                    None,
                )
                if assistant is None and request.get("assistant_content") is not None:
                    assistant = ChatConversationMessage(
                        id=assistant_id or new_id("chatmsg-replay-"),
                        role="assistant",
                        content=str(request.get("assistant_content") or ""),
                        created_at=str(request.get("updated_at") or now),
                        response=copy.deepcopy(request.get("assistant_response")),
                        model=request.get("model"),
                        source_id=request.get("source_id"),
                        source_name=request.get("source_name"),
                        idempotency_key=idempotency_key,
                    )
                if assistant is None:
                    raise ChatHistoryUnavailable(
                        "The completed chat receipt could not be restored."
                    )
                return _encode_partition(data), ChatExchangeReservation(
                    status="completed",
                    idempotency_key=idempotency_key,
                    conversation_id=conversation_id,
                    conversation=conversation,
                    assistant_message=assistant,
                    conversation_title=str(
                        request.get("conversation_title")
                        or (conversation.title if conversation else "Conversation")
                    ),
                )
            if request.get("lease_token") != lease_token:
                raise ChatRequestInProgress(
                    "This chat request is owned by a newer retry lease."
                )
            conversation, assistant_id = self._append_to_data(
                data,
                conversation_id=conversation_id,
                require_existing=requested_existing_conversation,
                user_content=user_content,
                assistant_content=assistant_content,
                response=response,
                model=model,
                source_id=source_id,
                source_name=source_name,
                idempotency_key=idempotency_key,
                now=now,
            )
            if conversation is None or assistant_id is None:
                raise ChatConversationMissing("conversation not found")
            assistant = next(item for item in conversation.messages if item.id == assistant_id)
            data["requests"][idempotency_key] = {
                **request,
                "status": "completed",
                "updated_at": now,
                "assistant_message_id": assistant_id,
                "assistant_content": assistant.content,
                "assistant_response": copy.deepcopy(assistant.response),
                "conversation_title": conversation.title,
                "model": assistant.model,
                "source_id": assistant.source_id,
                "source_name": assistant.source_name,
            }
            self._prune_requests(data)
            return _encode_partition(data), ChatExchangeReservation(
                status="completed",
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                conversation=conversation,
                assistant_message=assistant,
                conversation_title=conversation.title,
                lease_token=lease_token,
            )

        return await self._strict_mutate(key, _change)

    async def abort_exchange(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        lease_token: str,
    ) -> None:
        key, _data = await self._load_partition(user_id)

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            data = _decode_partition(current)
            request = data["requests"].get(idempotency_key)
            if (
                request is not None
                and request.get("status") == "in_progress"
                and request.get("fingerprint") == request_fingerprint
                and request.get("lease_token") == lease_token
            ):
                data["requests"].pop(idempotency_key, None)
            return _encode_partition(data), None

        await self._strict_mutate(key, _change)

    async def rename(
        self, user_id: str | None, conversation_id: str, title: str
    ) -> ChatConversation | None:
        key, _data = await self._load_partition(user_id)
        cid = str(conversation_id)
        cleaned = " ".join(str(title).split()).strip()[:MAX_TITLE_CHARS]

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], ChatConversation | None]:
            data = _decode_partition(current)
            existing = data["conversations"].get(cid)
            if existing is None:
                return _encode_partition(data), None
            stored = existing.model_copy(update={"title": cleaned, "updated_at": iso_now()})
            data["conversations"][cid] = stored
            return _encode_partition(data), stored

        return await self._strict_mutate(key, _change)

    async def delete(self, user_id: str | None, conversation_id: str) -> bool:
        key, _data = await self._load_partition(user_id)
        cid = str(conversation_id)

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], bool]:
            data = _decode_partition(current)
            if cid not in data["conversations"]:
                return _encode_partition(data), False
            data["conversations"].pop(cid, None)
            # This count means retained + retention-evicted conversations, not a
            # lifetime audit counter. An explicit delete therefore decrements it,
            # while any prior retention gap remains intact.
            data["total_conversation_count"] = max(
                len(data["conversations"]),
                int(data.get("total_conversation_count", 0)) - 1,
            )
            data["requests"] = {
                key: value
                for key, value in data["requests"].items()
                if value.get("conversation_id") != cid
            }
            return _encode_partition(data), True

        return await self._strict_mutate(key, _change)

    async def clear(self, user_id: str | None) -> int:
        key, data = await self._load_partition(user_id)
        count = len(data["conversations"])

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], int]:
            current_count = len(_decode_partition(current)["conversations"])
            return _empty_partition(), current_count

        return await self._strict_mutate(key, _change) if count else 0

    async def clear_all(self) -> int:
        """Factory-reset every registered hashed partition plus the legacy index."""
        index = await self._strict_get(CHAT_CONVERSATIONS_KEY) or {}
        keys = sorted({str(item) for item in (index.get("partitions") or [])})
        cleared = 0
        for key in keys:
            def _clear(current: dict[str, Any] | None) -> tuple[dict[str, Any], int]:
                count = len(_decode_partition(current)["conversations"])
                return _empty_partition(), count

            cleared += await self._strict_mutate(key, _clear)

        def _clear_index(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            return {"schema": _SCHEMA_VERSION, "partitions": [], "conversations": {}}, None

        await self._strict_mutate(
            CHAT_CONVERSATIONS_KEY, _clear_index, lock=self._index_lock
        )
        return cleared
