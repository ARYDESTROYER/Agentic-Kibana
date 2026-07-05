"""CUSTOM-MODELS store — operator-registered self-hosted / LiteLLM models.

Lets an operator add a SELF-HOSTED model served behind a LiteLLM router (or vLLM /
Ollama / LM Studio) — any OpenAI-compatible endpoint (``base_url`` + model id) — at
RUNTIME from the UI, with no rebuild. The suite already supports this at the wire
level (the ``openai_compatible`` provider IS the OpenAI httpx client pointed at a
custom ``base_url``); this store is the missing bookkeeping so a runtime-added model
appears in the catalog / per-role picker and is priced correctly.

CONFIG tier (project rule #10): the ``base_url`` / model id / label / context window /
price are ALL NON-SECRET, UI-editable config data. The optional endpoint API key is
the SECRET tier (``Secrets.litellm_api_key`` — env / in-memory only, NEVER persisted
here, surfaced only as a ``configured`` boolean). A local model is FREE ($0): the
stored row carries a 0/0 rate AND the add flow sets a $0 PriceOverlay so the cost
ledger meters a real $0 (never the conservative default rate).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.price_overlay`): the WHOLE model set is ONE KV document
(``ns=CUSTOM_MODELS_NS``, ``key=CUSTOM_MODELS_KEY``) whose value is
``{"models": {"<id>": {"label", "base_url", "provider", "context_window",
"input_per_million", "output_per_million"}}}`` — so it needs NO new ES index / SQL
table / migration. The SQL backend uses ``SqlKVStore``; the ES backend uses the thin
:class:`app.stores.memory.EsKVStore` adapter.

Reads + writes are read-modify-write and NEVER raise on a backend failure: a load
glitch degrades to an empty set, a write is best-effort. ``add`` raises ValueError
only on a caller error (empty id / empty base_url). This store holds ONLY plain
config data — it NEVER feeds ``case_manager.decide()`` (#3); every string it persists
is bounded + PLAIN, so the UI render-escapes it (#9).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, TypeVar

from ..constants import CUSTOM_MODELS_KEY, CUSTOM_MODELS_NS
from .base import KVStore, kv_mutate

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.custom_models")

# Bounds so a corrupt/hostile value can't bloat the config doc (plain data, but
# bounded — #9/#10 discipline). Ids/labels/urls are short; the map is small.
_MAX_ID_LEN = 200
_MAX_LABEL_LEN = 200
_MAX_URL_LEN = 2000
_MAX_MODELS = 200


def _clip(value: Any, limit: int) -> str:
    """A plain, whitespace-trimmed, length-bounded string (#9)."""
    return str(value or "").strip()[:limit]


def _coerce_int(value: Any, default: int = 0) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return n if n >= 0 else default


class CustomModelStore:
    """Operator-registered OpenAI-compatible models, persisted as one KV document.

    The KV value is ``{"models": {"<id>": <row>}}`` where each ``<row>`` is
    ``{label, base_url, provider, context_window, input_per_million,
    output_per_million}``. Methods are read-modify-write; none raises on a backend
    failure."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode_row(model_id: str, row: Any) -> dict[str, Any] | None:
        if not isinstance(row, dict):
            return None
        base_url = _clip(row.get("base_url"), _MAX_URL_LEN)
        if not model_id or not base_url:
            return None
        # provider defaults to the OpenAI-compatible path; never trust a stray value
        # to name a provider that could route a call somewhere unexpected.
        provider = _clip(row.get("provider"), 64) or "openai_compatible"
        try:
            in_p = float(row.get("input_per_million", 0.0) or 0.0)
            out_p = float(row.get("output_per_million", 0.0) or 0.0)
        except (TypeError, ValueError):
            in_p, out_p = 0.0, 0.0
        return {
            "label": _clip(row.get("label"), _MAX_LABEL_LEN) or model_id,
            "base_url": base_url,
            "provider": provider,
            "context_window": _coerce_int(row.get("context_window")),
            "input_per_million": max(0.0, in_p),
            "output_per_million": max(0.0, out_p),
        }

    @classmethod
    def _decode(cls, doc: dict | None) -> dict[str, dict[str, Any]]:
        raw = doc.get("models", {}) if isinstance(doc, dict) else {}
        out: dict[str, dict[str, Any]] = {}
        for mid, row in (raw or {}).items():
            key = _clip(mid, _MAX_ID_LEN)
            decoded = cls._decode_row(key, row)
            if decoded is not None:
                out[key] = decoded
        return out

    async def _load_all(self) -> dict[str, dict[str, Any]]:
        try:
            doc = await self._kv.get(CUSTOM_MODELS_NS, CUSTOM_MODELS_KEY)
        except Exception as exc:  # noqa: BLE001 — best-effort to LOAD
            logger.warning("Loading custom models failed (%s); using empty set", exc)
            return {}
        return self._decode(doc)

    async def _mutate(self, change: Callable[[dict[str, dict[str, Any]]], _T]) -> _T:
        """Atomic read-modify-write over the shared doc (lost-update safe)."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            models = self._decode(current)
            box["r"] = change(models)
            return {"models": models}

        await kv_mutate(self._kv, CUSTOM_MODELS_NS, CUSTOM_MODELS_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    # ---- reads ----
    async def get(self) -> dict[str, dict[str, Any]]:
        """The whole ``{id: row}`` map (empty when none registered)."""
        return await self._load_all()

    async def get_model(self, model_id: str) -> dict[str, Any] | None:
        """The row for ONE model id, or None."""
        return (await self._load_all()).get(_clip(model_id, _MAX_ID_LEN)) or None

    async def base_url_for(self, model_id: str) -> str | None:
        """The registered ``base_url`` for ``model_id``, or None — lets the gateway
        resolve a self-hosted endpoint for a bare custom model id even when the
        per-role ModelConfig didn't carry one."""
        row = await self.get_model(model_id)
        return (row or {}).get("base_url") or None

    async def list_models(self) -> list[dict[str, Any]]:
        """The registered models as a sorted list of rows, each carrying its ``id``.
        Ready to merge into the ``GET /api/llm/models`` catalog + per-role picker."""
        models = await self._load_all()
        rows = [{"id": mid, **row} for mid, row in models.items()]
        rows.sort(key=lambda r: str(r["id"]))
        return rows

    # ---- writes ----
    async def add(
        self,
        model_id: str,
        *,
        label: str = "",
        base_url: str,
        provider: str = "openai_compatible",
        context_window: int = 0,
        input_per_million: float = 0.0,
        output_per_million: float = 0.0,
    ) -> dict[str, Any]:
        """Register (upsert) one OpenAI-compatible model. Raises ValueError on an empty
        id / base_url (caller errors). Returns the stored row. Defaults to a FREE $0
        rate (a self-hosted model bills nothing); the route ALSO sets a $0 PriceOverlay
        so the ledger meters a real $0."""
        mid = _clip(model_id, _MAX_ID_LEN)
        url = _clip(base_url, _MAX_URL_LEN)
        if not mid:
            raise ValueError("model id is required")
        if not url:
            raise ValueError("base_url is required")
        row = {
            "label": _clip(label, _MAX_LABEL_LEN) or mid,
            "base_url": url,
            "provider": _clip(provider, 64) or "openai_compatible",
            "context_window": _coerce_int(context_window),
            "input_per_million": max(0.0, float(input_per_million or 0.0)),
            "output_per_million": max(0.0, float(output_per_million or 0.0)),
        }

        def _change(models: dict[str, dict[str, Any]]) -> dict[str, Any]:
            if mid not in models and len(models) >= _MAX_MODELS:
                raise ValueError(f"too many custom models (max {_MAX_MODELS})")
            models[mid] = row
            return {"id": mid, **row}

        return await self._mutate(_change)

    async def remove(self, model_id: str) -> bool:
        """Drop one registered model. Returns True if it existed."""
        mid = _clip(model_id, _MAX_ID_LEN)

        def _change(models: dict[str, dict[str, Any]]) -> bool:
            if mid not in models:
                return False
            models.pop(mid, None)
            return True

        return await self._mutate(_change)

    async def put(self, models: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """Replace the WHOLE model map (each entry coerced/validated; invalid dropped).
        Returns the stored map."""
        bucket: dict[str, dict[str, Any]] = {}
        for mid, row in (models or {}).items():
            key = _clip(mid, _MAX_ID_LEN)
            decoded = self._decode_row(key, row)
            if decoded is not None and len(bucket) < _MAX_MODELS:
                bucket[key] = decoded

        def _change(current: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
            current.clear()
            current.update(bucket)
            return bucket

        return await self._mutate(_change)
