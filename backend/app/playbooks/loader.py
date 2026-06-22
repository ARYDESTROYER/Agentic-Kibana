"""Playbook loading: Markdown front-matter → ``Playbook``.

Reuses the dependency-free front-matter parser from ``engine.runbooks`` (the same
parser that powers plain-text runbooks) so we keep the "no new deps" rule and one
front-matter dialect across the codebase. Loading NEVER raises: a malformed file
is skipped with a ``logging.warning`` and returns ``None`` so a single bad file can
never break the whole set.
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..engine.runbooks import parse_frontmatter
from .manifest import Playbook, PlaybookManifest, PlaybookMatch

logger = logging.getLogger("tlsoc.playbooks.loader")

# Front-matter keys we understand. Unknown keys are logged (then ignored by the
# manifest's ``extra="ignore"``); listing them keeps the warning precise.
_KNOWN_TOP_KEYS = {
    "id",
    "name",
    "version",
    "description",
    "match",
    "priority",
    "suggested_tools",
    "rag_queries",
    "escalate_if",
    "suggested_verdict_bias",
    # match.* convenience keys may also appear at the top level (flat front-matter):
    "rule_ids",
    "entity_types",
    "mitre",
    "min_event_count",
    "any_tags",
}
_MATCH_KEYS = {"rule_ids", "entity_types", "mitre", "min_event_count", "any_tags"}


def _as_list(value: object) -> list[str]:
    """The front-matter parser yields tuples for lists; normalise to a list[str]."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(x) for x in value]
    if isinstance(value, str):
        return [value] if value else []
    return [str(value)]


def _coerce_int(value: object) -> object:
    """Best-effort int coercion (front-matter scalars arrive as strings)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        s = value.strip()
        try:
            return int(s)
        except (TypeError, ValueError):
            return value
    return value


def parse_playbook(text: str, fallback_id: str, source_path: str = "") -> Playbook | None:
    """Parse Markdown ``text`` into a ``Playbook`` (or ``None`` on any failure).

    The front-matter is split with ``engine.runbooks.parse_frontmatter`` and coerced
    into a ``PlaybookManifest``. Match criteria may be nested under ``match:`` or
    given flat at the top level. Unknown keys are warned about but do NOT fail the
    load. Any validation error → ``None`` + warning (never raises).
    """
    try:
        meta, body = parse_frontmatter(text)
    except Exception as exc:  # noqa: BLE001 — defensive: the parser claims it never raises
        logger.warning("Could not parse playbook front-matter for %s: %s", fallback_id, exc)
        return None

    if not isinstance(meta, dict):
        logger.warning("Playbook %s has non-dict front-matter; skipping", fallback_id)
        return None

    # Warn about unknown top-level keys (still loaded — manifest ignores extras).
    unknown = sorted(k for k in meta if k not in _KNOWN_TOP_KEYS)
    if unknown:
        logger.warning("Playbook %s has unknown front-matter keys %s (ignored)", fallback_id, unknown)

    # Build the match block from a nested ``match`` mapping and/or flat top keys.
    raw_match = meta.get("match")
    match_data: dict[str, object] = {}
    if isinstance(raw_match, dict):
        match_data.update(raw_match)
    for k in _MATCH_KEYS:
        if k in meta:
            match_data[k] = meta[k]

    match_kwargs: dict[str, object] = {}
    for k in ("rule_ids", "entity_types", "mitre", "any_tags"):
        if k in match_data:
            match_kwargs[k] = _as_list(match_data[k])
    if "min_event_count" in match_data and match_data["min_event_count"] is not None:
        match_kwargs["min_event_count"] = _coerce_int(match_data["min_event_count"])

    manifest_kwargs: dict[str, object] = {
        "id": str(meta["id"]).strip() if meta.get("id") is not None else "",
        "name": str(meta.get("name") or meta.get("id") or fallback_id),
        "description": str(meta.get("description") or ""),
        "escalate_if": str(meta.get("escalate_if") or ""),
        "suggested_verdict_bias": str(meta.get("suggested_verdict_bias") or ""),
    }
    if "version" in meta:
        manifest_kwargs["version"] = _coerce_int(meta["version"])
    if "priority" in meta:
        manifest_kwargs["priority"] = _coerce_int(meta["priority"])
    for k in ("suggested_tools", "rag_queries"):
        if k in meta:
            manifest_kwargs[k] = _as_list(meta[k])
    try:
        manifest_kwargs["match"] = PlaybookMatch(**match_kwargs)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Playbook %s has an invalid match block: %s", fallback_id, exc)
        return None

    try:
        manifest = PlaybookManifest(**manifest_kwargs)
    except Exception as exc:  # noqa: BLE001 — bad/missing id, bad version, etc.
        logger.warning("Skipping invalid playbook %s: %s", fallback_id, exc)
        return None

    return Playbook(manifest=manifest, body=body, source_path=source_path)


def load_playbooks(directory: Path) -> list[Playbook]:
    """Load every ``*.md`` playbook in ``directory`` (sorted). Never raises.

    Invalid files are skipped (logged). A missing directory returns ``[]``.
    """
    out: list[Playbook] = []
    if directory is None or not Path(directory).is_dir():
        return out
    for path in sorted(Path(directory).glob("*.md")):
        if path.stem.lower() in {"readme", "index"}:
            continue  # author docs, not a playbook
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            logger.warning("Could not read playbook %s: %s", path, exc)
            continue
        pb = parse_playbook(text, fallback_id=path.stem, source_path=str(path))
        if pb is not None:
            out.append(pb)
    return out
