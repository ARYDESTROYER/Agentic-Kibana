"""Per-rule immutable VERSION ledger + one-click rollback (Round 5 / G6 R5).

This GENERALISES the Round-4 :mod:`app.stores.tuning` CAS-ledger pattern from the
nightly auto-tuner into a version history for EVERY operator rule edit — a detection
rule (:class:`app.config.RuleDefinition`), a correlation/threshold rule
(:class:`app.config.CorrelationRule`), or a case-automation rule
(:class:`app.config.CaseAutomationRule`).

It is a **config-adjacent audit ledger only** — it never writes ``Preferences``
itself (the config-writer route does that through ``update_prefs``), never touches a
case, a verdict, a risk weight, or a cluster signature, and it NEVER imports or calls
``case_manager.decide()`` (#3). Each version snapshots the WHOLE rule config (not one
field) so a rollback restores an entire prior rule — a scalar-only rollback is a false
safety net (RESEARCH_RULES_UX §6c).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.tuning` / :mod:`app.stores.dashboards`): the whole ledger is ONE KV
document (``ns=RULE_VERSIONS_NS``, ``key=RULE_VERSIONS_KEY``) persisted through the
existing :class:`KVStore` abstraction — so it needs NO new ES index / SQL table /
migration. The SQL backend uses ``SqlKVStore`` (the shared KV table); the ES backend
uses the thin :class:`app.stores.memory.EsKVStore` adapter (a doc in the existing
config index).

Writes go through :func:`app.stores.base.kv_mutate` (per-key lock + ``_rev``
compare-and-set) so a manual edit + the nightly tuner + a rollback never lost-update
each other. The store NEVER raises: a load/save failure degrades to an empty ledger /
best-effort write and is logged, so a versioning glitch can never break a rule edit or
a page.

The stored value shape::

    {"versions": [<RuleVersion json>, ...], "_rev": <int>}

Every version is APPEND-ONLY (immutable). A "rollback" appends a NEW version whose
``config`` is the restored snapshot (marked ``rolled_back_to``) — the history is never
mutated or truncated in place, mirroring the append-only audit discipline (#2).
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from ..utils import iso_now, new_id
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.rule_versions")

# The single-KV-document coordinates for the rule-version ledger. Defined HERE (not in
# constants.py) to keep the store self-contained; it follows the exact ``<NS>/<KEY>``
# convention every other Round-3/4/5 KV store uses, so it reuses the shared KV table /
# config index with no new index/table/migration.
RULE_VERSIONS_NS = "rule_versions"
RULE_VERSIONS_KEY = "versions"

# The rule families this ledger tracks. Matches the three config collections the rules
# API is a config-writer over.
RuleKind = Literal["detection", "correlation", "case_automation"]

# A defensive cap on the retained history per rule so a hot-edited rule can't grow the
# shared doc unbounded. The NEWEST N are kept (oldest snapshots are trimmed); the cap
# is generous — versioning is an operator-scale action, not log volume.
_MAX_VERSIONS_PER_RULE = 100


class RuleVersion:
    """One immutable snapshot of a rule's WHOLE config at a point in time.

    Pure data (a thin dict wrapper, dependency-light, mirroring the loose-JSON KV
    entries the other stores use). Fields:

    * ``id``          — stable version id (``rv-…``).
    * ``kind``        — ``detection`` | ``correlation`` | ``case_automation``.
    * ``rule_id``     — the rule key within its collection (a detection rule ``name``,
                        a ``correlation_rules`` map key, or a ``CaseAutomationRule.id``).
    * ``config``      — the FULL JSON snapshot of the rule config at this version (the
                        rollback restores this verbatim).
    * ``action``      — what produced the version:
                        ``create`` | ``update`` | ``enable`` | ``disable`` | ``rollback``.
    * ``actor``       — the authenticated username that made the change ("" when auth off).
    * ``summary``     — a short, plain, length-bounded human note (render-escaped, #9).
    * ``created_at``  — ISO timestamp of the version.
    * ``rolled_back_to`` — when ``action == "rollback"``, the version id this restored.
    """

    __slots__ = (
        "id", "kind", "rule_id", "config", "action", "actor",
        "summary", "created_at", "rolled_back_to",
    )

    def __init__(
        self,
        *,
        kind: RuleKind,
        rule_id: str,
        config: dict[str, Any],
        action: str = "update",
        actor: str = "",
        summary: str = "",
        id: str | None = None,
        created_at: str | None = None,
        rolled_back_to: str | None = None,
    ) -> None:
        self.id = id or new_id("rv-")
        self.kind = kind
        self.rule_id = str(rule_id)
        # Defensive copy so a caller mutation after add() can't retro-change history.
        self.config = dict(config or {})
        self.action = str(action or "update")
        self.actor = str(actor or "")
        # Bound the note so an attacker-influenceable rule name/desc can't bloat the doc.
        self.summary = str(summary or "")[:500]
        self.created_at = created_at or iso_now()
        self.rolled_back_to = rolled_back_to

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "rule_id": self.rule_id,
            "config": self.config,
            "action": self.action,
            "actor": self.actor,
            "summary": self.summary,
            "created_at": self.created_at,
            "rolled_back_to": self.rolled_back_to,
        }

    @classmethod
    def from_json(cls, raw: dict[str, Any]) -> "RuleVersion":
        return cls(
            id=str(raw.get("id") or "") or None,
            kind=raw.get("kind") or "detection",  # type: ignore[arg-type]
            rule_id=str(raw.get("rule_id") or ""),
            config=raw.get("config") if isinstance(raw.get("config"), dict) else {},
            action=str(raw.get("action") or "update"),
            actor=str(raw.get("actor") or ""),
            summary=str(raw.get("summary") or ""),
            created_at=str(raw.get("created_at") or "") or None,
            rolled_back_to=raw.get("rolled_back_to"),
        )


class RuleVersionStore:
    """CRUD over the rule-version ledger, persisted as one KV document.

    The KV value is ``{"versions": [<RuleVersion json>, ...]}``. Reads never raise (a
    failure logs + returns an empty list); writes go through the CAS ``mutate`` helper
    so a concurrent manual edit / tuner pass / rollback never lost-update each other."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    @staticmethod
    def _version_key(kind: str, rule_id: str) -> tuple[str, str]:
        return (str(kind), str(rule_id))

    async def _load(self) -> list[RuleVersion]:
        try:
            doc = await self._kv.get(RULE_VERSIONS_NS, RULE_VERSIONS_KEY)
        except Exception as exc:  # noqa: BLE001 — the ledger is best-effort
            logger.warning("Loading rule-version ledger failed (%s); using empty set", exc)
            return []
        if not doc:
            return []
        raw = doc.get("versions", []) if isinstance(doc, dict) else []
        out: list[RuleVersion] = []
        for item in raw or []:
            try:
                out.append(RuleVersion.from_json(item))
            except Exception:  # noqa: BLE001 — skip one corrupt entry, keep the rest
                continue
        return out

    async def list(
        self, *, kind: str | None = None, rule_id: str | None = None,
    ) -> list[RuleVersion]:
        """All versions, NEWEST first. Optionally scoped to one ``kind`` and/or
        ``rule_id`` (the History drawer for one rule passes both)."""
        entries = await self._load()
        if kind is not None:
            entries = [e for e in entries if e.kind == kind]
        if rule_id is not None:
            entries = [e for e in entries if e.rule_id == rule_id]
        return sorted(entries, key=lambda e: e.created_at, reverse=True)

    async def get(self, version_id: str) -> RuleVersion | None:
        for e in await self._load():
            if e.id == version_id:
                return e
        return None

    async def latest(self, kind: str, rule_id: str) -> RuleVersion | None:
        """The most recent version for a rule (the current baseline). None when the
        rule has no recorded history yet."""
        recs = [
            e for e in await self._load()
            if e.kind == kind and e.rule_id == str(rule_id)
        ]
        if not recs:
            return None
        return max(recs, key=lambda e: e.created_at)

    async def add(self, version: RuleVersion) -> RuleVersion:
        """Append one immutable version to the ledger (CAS-safe).

        Trims the per-rule history to the newest ``_MAX_VERSIONS_PER_RULE`` (oldest
        snapshots dropped) so a hot-edited rule can't grow the shared doc unbounded —
        but NEVER mutates a retained version in place (append-only, #2)."""
        key = self._version_key(version.kind, version.rule_id)

        def _mutate(cur: dict[str, Any] | None) -> dict[str, Any]:
            entries = list((cur or {}).get("versions", []) or [])
            entries.append(version.to_json())
            # Per-rule backstop trim: keep the newest-by-created_at N FOR THIS RULE,
            # leaving every other rule's history untouched.
            same = [e for e in entries if isinstance(e, dict)
                    and self._version_key(e.get("kind", ""), e.get("rule_id", "")) == key]
            if len(same) > _MAX_VERSIONS_PER_RULE:
                same_sorted = sorted(same, key=lambda e: str(e.get("created_at") or ""))
                drop = {id(e) for e in same_sorted[:-_MAX_VERSIONS_PER_RULE]}
                entries = [e for e in entries if id(e) not in drop]
            return {"versions": entries}

        try:
            await self._kv.mutate(RULE_VERSIONS_NS, RULE_VERSIONS_KEY, _mutate)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting rule version failed (%s); continuing", exc)
        return version

    async def record(
        self,
        *,
        kind: RuleKind,
        rule_id: str,
        config: dict[str, Any],
        action: str = "update",
        actor: str = "",
        summary: str = "",
        rolled_back_to: str | None = None,
    ) -> RuleVersion:
        """Convenience: build + append a version in one call. Returns the stored
        :class:`RuleVersion`."""
        version = RuleVersion(
            kind=kind, rule_id=rule_id, config=config, action=action,
            actor=actor, summary=summary, rolled_back_to=rolled_back_to,
        )
        return await self.add(version)
