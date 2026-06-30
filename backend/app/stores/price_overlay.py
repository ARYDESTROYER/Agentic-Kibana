"""PRICE-OVERLAY store — operator per-model price overrides (Round 3 cost control).

The LLM cost ledger (#6) prices every call against the built-in
``app.llm.pricing.PRICES`` table (USD per 1,000,000 tokens, as
``(input_per_million, output_per_million)``). An operator may want to override a
model's rate to match their NEGOTIATED contract price (or to price a private/self-
hosted model the table doesn't know). This store keeps those overrides — a thin
per-model map LAYERED ON TOP of the shipped table — out-of-band from the code so a
deploy needn't edit ``pricing.py`` and rebuild.

Org-scoped (one shared ``'default'`` bucket — pricing is org-wide). The overlay is
PLAIN config data and is advisory to the LEDGER only — it never touches
``case_manager.decide()`` (#3).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory`): the WHOLE overlay is ONE KV document
(``ns=PRICE_OVERLAY_NS``, ``key=PRICE_OVERLAY_KEY``) whose value is
``{"overlay": {"<model>": {"input": <usd/1M>, "output": <usd/1M>}, ...}}`` — so it
needs NO new ES index / SQL table / migration. The SQL backend uses ``SqlKVStore``;
the ES backend uses the thin :class:`app.stores.memory.EsKVStore` adapter.

Reads + writes are read-modify-write. The store NEVER raises: a failure degrades to
an empty overlay (the built-in table stands) / best-effort write and is logged.
``set_price`` raises ValueError only on a caller error (empty model / negative rate).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, TypeVar

from ..constants import PRICE_OVERLAY_KEY, PRICE_OVERLAY_NS
from .base import KVStore, kv_mutate

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.price_overlay")

_DEFAULT_SCOPE = "default"


def _coerce_rate(value: object) -> float:
    """A non-negative float rate. Raises ValueError on a non-number / negative."""
    try:
        rate = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError("price rate must be a number") from exc
    if rate < 0:
        raise ValueError("price rate must be non-negative")
    return rate


class PriceOverlayStore:
    """Operator per-model price overrides, persisted as one KV document.

    The KV value is ``{"overlay": {"default": {"<model>": {"input", "output"}}}}``.
    Methods are read-modify-write; none raises on a backend failure. Rates are
    USD per 1,000,000 tokens, matching the built-in ``pricing.PRICES`` table so the
    gateway can apply ``override or builtin`` per model."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode(doc: dict | None) -> dict[str, dict[str, dict[str, float]]]:
        raw = doc.get("overlay", {}) if isinstance(doc, dict) else {}
        out: dict[str, dict[str, dict[str, float]]] = {}
        for scope, models in (raw or {}).items():
            bucket: dict[str, dict[str, float]] = {}
            for model, rates in (models or {}).items():
                if not isinstance(rates, dict):
                    continue
                try:
                    bucket[str(model)] = {
                        "input": float(rates.get("input", 0.0) or 0.0),
                        "output": float(rates.get("output", 0.0) or 0.0),
                    }
                except (TypeError, ValueError):
                    continue  # skip a corrupt entry, keep the rest
            out[str(scope)] = bucket
        return out

    async def _load_all(self) -> dict[str, dict[str, dict[str, float]]]:
        try:
            doc = await self._kv.get(PRICE_OVERLAY_NS, PRICE_OVERLAY_KEY)
        except Exception as exc:  # noqa: BLE001 — overlay is best-effort to LOAD
            logger.warning("Loading price overlay failed (%s); using empty overlay", exc)
            return {}
        return self._decode(doc)

    async def _mutate(self, change: Callable[[dict[str, dict[str, dict[str, float]]]], _T]) -> _T:
        """Atomic read-modify-write over the shared overlay doc (lost-update safe)."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            overlay = self._decode(current)
            box["r"] = change(overlay)
            return {"overlay": overlay}

        await kv_mutate(self._kv, PRICE_OVERLAY_NS, PRICE_OVERLAY_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    async def get(self, scope: str = _DEFAULT_SCOPE) -> dict[str, dict[str, float]]:
        """The whole per-model override map for the (org) scope — ``{model:
        {input, output}}`` in USD/1M tokens. Empty when nothing is overridden (the
        built-in table stands)."""
        return dict((await self._load_all()).get(scope, {}))

    async def get_model(self, model: str, scope: str = _DEFAULT_SCOPE) -> dict[str, float] | None:
        """The override for ONE model, or None (→ the gateway uses the built-in rate)."""
        return (await self._load_all()).get(scope, {}).get((model or "").strip())

    async def as_price_tuple(self, model: str, scope: str = _DEFAULT_SCOPE) -> tuple[float, float] | None:
        """The override as a ``(input_per_million, output_per_million)`` tuple matching
        ``pricing.PRICES`` — or None if the model is not overridden. Convenience for
        the gateway's ``overlay.as_price_tuple(model) or PRICES.get(model)`` lookup."""
        row = await self.get_model(model, scope)
        if not row:
            return None
        return (float(row.get("input", 0.0)), float(row.get("output", 0.0)))

    async def set_price(self, model: str, input_per_million: float, output_per_million: float,
                        scope: str = _DEFAULT_SCOPE) -> dict[str, float]:
        """Set (upsert) one model's override rate (USD per 1,000,000 tokens). Raises
        ValueError on an empty model or a negative rate (caller errors). Returns the
        stored ``{input, output}``."""
        m = (model or "").strip()
        if not m:
            raise ValueError("model is required")
        row = {"input": _coerce_rate(input_per_million), "output": _coerce_rate(output_per_million)}

        def _change(overlay: dict[str, dict[str, dict[str, float]]]) -> dict[str, float]:
            bucket = dict(overlay.get(scope, {}))
            bucket[m] = row
            overlay[scope] = bucket
            return row

        return await self._mutate(_change)

    async def put(self, overrides: dict[str, dict[str, float]],
                  scope: str = _DEFAULT_SCOPE) -> dict[str, dict[str, float]]:
        """Replace the WHOLE override map for the scope (the route validates the body).
        Each entry is coerced to non-negative ``{input, output}``; an invalid entry is
        skipped. Returns the stored map."""
        bucket: dict[str, dict[str, float]] = {}
        for model, rates in (overrides or {}).items():
            m = (model or "").strip()
            if not m or not isinstance(rates, dict):
                continue
            try:
                bucket[m] = {
                    "input": _coerce_rate(rates.get("input", 0.0)),
                    "output": _coerce_rate(rates.get("output", 0.0)),
                }
            except ValueError:
                continue  # skip an invalid override, keep the rest

        def _change(overlay: dict[str, dict[str, dict[str, float]]]) -> dict[str, dict[str, float]]:
            overlay[scope] = bucket
            return bucket

        return await self._mutate(_change)

    async def delete(self, model: str, scope: str = _DEFAULT_SCOPE) -> bool:
        """Drop one model's override (→ the built-in rate applies again). Returns True
        if it existed."""
        m = (model or "").strip()

        def _change(overlay: dict[str, dict[str, dict[str, float]]]) -> bool:
            bucket = overlay.get(scope, {})
            if m not in bucket:
                return False
            overlay[scope] = {k: v for k, v in bucket.items() if k != m}
            return True

        return await self._mutate(_change)
