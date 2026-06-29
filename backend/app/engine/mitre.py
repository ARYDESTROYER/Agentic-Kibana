"""MITRE ATT&CK technique lookup over the bundled compact map (F11).

Loads ``app/threat/mitre_techniques.json`` ONCE (process-cached) and serves
technique metadata for the threat-context panel. The bundled map is a compact,
curated subset of MITRE ATT&CK Enterprise (``{technique_id: {name, tactics[],
platforms[], url, description}}``) — NOT the full STIX bundle. See
``app/threat/SOURCE.md`` for the source + the refresh script.

FAIL-OPEN: a missing / unparseable bundle degrades to an EMPTY map (every lookup
returns ``None``) — it never raises, so the threat-context panel never breaks just
because the corpus is absent or stale.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger("tlsoc.engine.mitre")

# The committed compact map lives beside the bundled corpus.
_BUNDLE_PATH = Path(__file__).resolve().parent.parent / "threat" / "mitre_techniques.json"

# A MITRE technique id: T#### optionally with a .### sub-technique suffix.
_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")

# Process-level cache (the bundle is read-only at runtime).
_CACHE: dict[str, dict[str, Any]] | None = None


def _load() -> dict[str, dict[str, Any]]:
    """Load + cache the compact technique map. Never raises (→ {} on any failure)."""
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    data: dict[str, dict[str, Any]] = {}
    try:
        raw = json.loads(_BUNDLE_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            for tid, meta in raw.items():
                if isinstance(meta, dict):
                    data[str(tid).upper()] = meta
        logger.info("Loaded %d MITRE techniques from %s", len(data), _BUNDLE_PATH)
    except FileNotFoundError:
        logger.warning("MITRE bundle not found at %s; technique lookups disabled", _BUNDLE_PATH)
    except Exception as exc:  # noqa: BLE001 — corpus must never break the panel
        logger.warning("Could not load MITRE bundle (%s); technique lookups disabled", exc)
    _CACHE = data
    return data


def _normalize(technique_id: str | None) -> str | None:
    """Canonicalise a technique id (uppercase, trimmed) or None if not a valid id."""
    if not technique_id:
        return None
    tid = str(technique_id).strip().upper()
    return tid if _TECHNIQUE_RE.match(tid) else None


def technique(technique_id: str | None) -> dict[str, Any] | None:
    """Return the compact metadata dict for ``technique_id`` (e.g. ``"T1110"``), or
    ``None`` when it is unknown / invalid.

    Falls back from a sub-technique (``T1110.001``) to its PARENT (``T1110``) when
    the sub-technique itself is not in the compact bundle, so a more-specific id
    still resolves to useful context. The returned dict always carries the resolved
    ``id`` so callers can show which technique matched."""
    data = _load()
    tid = _normalize(technique_id)
    if tid is None:
        return None
    meta = data.get(tid)
    if meta is None and "." in tid:
        parent = tid.split(".", 1)[0]
        meta = data.get(parent)
        if meta is not None:
            tid = parent
    if meta is None:
        return None
    return {"id": tid, **meta}


def map_many(technique_ids: list[str] | None) -> list[dict[str, Any]]:
    """Resolve a list of technique ids to their metadata, dropping unknowns and
    de-duplicating by resolved id (preserving first-seen order). Never raises."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in technique_ids or []:
        meta = technique(raw)
        if meta is None:
            continue
        if meta["id"] in seen:
            continue
        seen.add(meta["id"])
        out.append(meta)
    return out


def loaded_count() -> int:
    """Number of techniques currently loaded (0 when the bundle is absent)."""
    return len(_load())


def _reset_cache_for_tests() -> None:  # pragma: no cover - test helper
    """Clear the process cache (used by tests that patch the bundle path)."""
    global _CACHE
    _CACHE = None
