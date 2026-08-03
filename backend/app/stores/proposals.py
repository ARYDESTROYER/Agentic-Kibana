"""Agent-DRAFTED PROPOSAL store — pending recommendations awaiting human approval.

A PROPOSAL is work the agent has DRAFTED but never applied: a suppression rule,
Memory fact, bounded tuning change, or acknowledgement-only automation checkpoint.
It sits ``pending`` until a human explicitly approves or rejects it. Drafting one
NEVER mutates live configuration, Memory, or case state — that is the point of HITL.

Backend-agnostic by construction (cloned verbatim from :mod:`app.stores.memory`):
the whole proposal set is ONE JSON list persisted through the existing
:class:`KVStore` abstraction (``ns="proposals"``, ``key="entries"``) — so it needs
NO new ES index / SQL table / migration. The SQL backend uses ``SqlKVStore`` (the
shared KV table); the ES backend uses the thin :class:`app.stores.memory.EsKVStore`
adapter (a doc in the existing config index).

Reads + ordinary drafting writes are read-modify-write over the single list — fine at
our scale (operator/agent-authored proposals, not log volume). Ordinary workflows never raise:
a load/save failure degrades to an empty list / best-effort write and is logged, so a
proposal glitch can never drop an alert or break the analyst's close action. Evidence
exports opt into the separate strict read seam and propagate uncertainty. Approval
and rejection transitions are stricter: confirmed CAS is required because no side
effect may run before a durable ``pending -> applying`` claim.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from ..constants import PROPOSALS_KEY, PROPOSALS_NS
from ..models import Proposal
from ..utils import iso_now
from .base import KVStore, kv_mutate, kv_mutate_strict

logger = logging.getLogger("tlsoc.stores.proposals")

_APPROVAL_LEASE_SECONDS = 30


class ProposalStore:
    """CRUD over the proposal list, persisted as one KV document.

    The KV value is ``{"entries": [<Proposal json>, ...]}``. Ordinary methods are
    fail-soft; :meth:`list_strict` is the evidence/export boundary."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        # Per-store lock so kv_mutate serialises concurrent read-modify-write over the
        # single proposal doc + a _rev CAS covers the multi-process race — so a concurrent
        # add and set_status can't drop an in-flight proposal or revert an approved one to
        # pending (audit #26).
        self._lock = asyncio.Lock()

    async def _mutate(self, apply: Callable[[list[Proposal]], Any]) -> Any:
        """Run ``apply(entries)`` under kv_mutate (per-store lock + _rev CAS). ``apply``
        mutates the fresh list in place and returns an auxiliary result; the persisted
        attempt's result is returned. Never raises."""
        box: dict[str, Any] = {}

        def mutator(current: dict[str, Any] | None) -> dict[str, Any]:
            raw = current.get("entries", []) if isinstance(current, dict) else []
            entries: list[Proposal] = []
            for item in (raw or []):
                try:
                    entries.append(Proposal.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt entry, keep the rest
                    continue
            box["result"] = apply(entries)
            return {"entries": [p.model_dump(mode="json") for p in entries]}

        await kv_mutate(self._kv, PROPOSALS_NS, PROPOSALS_KEY, mutator, lock=self._lock)
        return box.get("result")

    async def _mutate_strict(self, apply: Callable[[list[Proposal]], Any]) -> Any:
        """Confirmed CAS mutation for the approval/rejection durability boundary."""
        box: dict[str, Any] = {}

        def mutator(current: dict[str, Any] | None) -> dict[str, Any]:
            entries = self._decode_entries_strict(current)
            box["result"] = apply(entries)
            # Preserve opaque top-level siblings written by a newer compatible
            # deployment. Individual unknown proposal fields fail closed in the
            # strict decoder below, so this older process can never erase them.
            updated = dict(current or {})
            updated["entries"] = [p.model_dump(mode="json") for p in entries]
            return updated

        await kv_mutate_strict(
            self._kv,
            PROPOSALS_NS,
            PROPOSALS_KEY,
            mutator,
            lock=self._lock,
        )
        return box.get("result")

    @staticmethod
    def _decode_entries_strict(current: dict[str, Any] | None) -> list[Proposal]:
        """Decode the complete registry or fail before a strict CAS write.

        Fail-soft reads intentionally skip a damaged proposal so case handling can
        continue. A decision mutation is different: rewriting only the valid rows
        would silently delete an opaque/malformed sibling. Reject the whole write
        instead and leave the persisted document byte-for-byte untouched.
        """
        if current is None:
            return []
        if not isinstance(current, dict):
            raise ValueError("proposal registry is not a JSON object")
        raw = current.get("entries", [])
        if not isinstance(raw, list):
            raise ValueError("proposal registry entries are not a list")
        known_fields = set(Proposal.model_fields)
        entries: list[Proposal] = []
        for item in raw:
            if not isinstance(item, dict) or set(item) - known_fields:
                raise ValueError("proposal registry contains an invalid entry")
            try:
                entries.append(Proposal.model_validate(item))
            except Exception as exc:  # noqa: BLE001 — strict writes fail closed
                raise ValueError("proposal registry contains an invalid entry") from exc
        return entries

    async def _load(self) -> list[Proposal]:
        try:
            doc = await self._kv.get(PROPOSALS_NS, PROPOSALS_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading proposals failed (%s); using empty set", exc)
            return []
        if not doc:
            return []
        raw = doc.get("entries", []) if isinstance(doc, dict) else []
        out: list[Proposal] = []
        for item in raw or []:
            try:
                out.append(Proposal.model_validate(item))
            except Exception:  # noqa: BLE001 — skip a single corrupt entry, keep the rest
                continue
        return out

    async def _load_strict(self) -> list[Proposal]:
        """Load every persisted proposal or raise when completeness is unknown.

        Ordinary proposal workflows intentionally fail soft so a review-queue outage
        cannot stop case handling. Portable export is different: returning ``[]`` on
        a failed read would create a false lifetime-complete claim, so it uses this
        confirmed projection instead.
        """
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(PROPOSALS_NS, PROPOSALS_KEY)
        return self._decode_entries_strict(doc)

    # No plain _save — every mutation goes through _mutate (kv_mutate: lock + _rev CAS)
    # so a write can't clobber a concurrent one (audit #26).

    async def list(self, status: str | None = None) -> list[Proposal]:
        entries = await self._load()
        if status == "pending":
            # Keep an in-flight/stale approval visible in the operator queue. The UI
            # distinguishes ``applying`` and the strict claim controls safe recovery.
            entries = [p for p in entries if p.status in {"pending", "applying"}]
        elif status:
            entries = [p for p in entries if p.status == status]
        # Newest first so the review queue surfaces fresh proposals at the top.
        return sorted(entries, key=lambda p: p.created_at, reverse=True)

    async def list_strict(self, status: str | None = None) -> list[Proposal]:
        """Newest-first proposals, raising on unavailable or malformed persistence."""
        entries = await self._load_strict()
        if status:
            entries = [p for p in entries if p.status == status]
        return sorted(entries, key=lambda p: p.created_at, reverse=True)

    async def get(self, proposal_id: str) -> Proposal | None:
        for p in await self._load():
            if p.id == proposal_id:
                return p
        return None

    async def add(self, proposal: Proposal) -> Proposal:
        def apply(entries: list[Proposal]) -> Proposal:
            entries.append(proposal)
            return proposal

        await self._mutate(apply)
        return proposal

    async def add_unique(self, proposal: Proposal, dedupe_key: str) -> tuple[Proposal, bool]:
        """Atomically add ``proposal`` unless its stable payload key already exists.

        The check covers every status, not only pending rows: rejecting or approving
        an exact recommendation is itself a decision and the next scheduler tick must
        not recreate the same work. A materially changed recommendation carries a new
        key and remains eligible for review. Returns ``(row, created)``.
        """
        key = str(dedupe_key or "").strip()
        if not key:
            return await self.add(proposal), True

        def apply(entries: list[Proposal]) -> tuple[Proposal, bool]:
            for existing in entries:
                if str((existing.payload or {}).get("dedupe_key") or "") == key:
                    return existing, False
            payload = dict(proposal.payload or {})
            payload["dedupe_key"] = key
            created = proposal.model_copy(update={"payload": payload})
            entries.append(created)
            return created, True

        result = await self._mutate(apply)
        if isinstance(result, tuple) and len(result) == 2:
            return result
        return proposal, False

    @staticmethod
    def _fixed_decision_actor(proposal: Proposal, by: str) -> str:
        """Return the immutable first actor, including pre-field applying rows."""
        if proposal.decision_actor is not None:
            return proposal.decision_actor
        if proposal.decided_by is not None:
            return proposal.decided_by.strip()
        return (by or "").strip()

    async def set_status(self, proposal_id: str, status: str, by: str) -> Proposal | None:
        """Transition a proposal's status (approve/reject) + record who decided it.

        Returns the updated proposal, or ``None`` if the id is unknown."""
        def apply(entries: list[Proposal]) -> Proposal | None:
            for idx, p in enumerate(entries):
                if p.id != proposal_id:
                    continue
                actor = self._fixed_decision_actor(p, by)
                updated = p.model_copy(update={
                    "status": status,
                    "decided_by": actor or None,
                    "decided_at": iso_now(),
                    "decision_actor": actor,
                })
                entries[idx] = updated
                return updated
            return None

        return await self._mutate(apply)

    @staticmethod
    def _lease_is_stale(proposal: Proposal) -> bool:
        raw = str(proposal.applying_at or "").strip()
        if not raw:
            return True
        try:
            started = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if started.tzinfo is None:
                started = started.replace(tzinfo=timezone.utc)
        except ValueError:
            return True
        return started <= datetime.now(timezone.utc) - timedelta(seconds=_APPROVAL_LEASE_SECONDS)

    async def _claim_decision(
        self, proposal_id: str, *, by: str, token: str, action: str
    ) -> tuple[Proposal | None, str]:
        """CAS-claim ``pending -> applying``; stale leases may be resumed safely.

        Returns ``(proposal, outcome)`` where outcome is ``claimed``, ``missing`` or
        ``conflict``. A durable claim always exists before any side effect runs. The
        first claim also fixes the decision actor, intent, and audit timestamp so a
        retry is idempotent across both the materialised effect and append-only
        evidence, even when a different operator resumes a stale lease.
        """
        if action not in {"approve", "reject"}:  # defensive internal contract
            raise ValueError(f"unsupported proposal decision action: {action}")

        def apply(entries: list[Proposal]) -> tuple[Proposal | None, str]:
            for idx, proposal in enumerate(entries):
                if proposal.id != proposal_id:
                    continue
                if proposal.decision_intent not in {None, action}:
                    return proposal, "conflict"
                if proposal.status == "pending" or (
                    proposal.status == "applying" and self._lease_is_stale(proposal)
                ):
                    actor = self._fixed_decision_actor(proposal, by)
                    claimed = proposal.model_copy(update={
                        "status": "applying",
                        "decision_actor": actor,
                        "decision_intent": proposal.decision_intent or action,
                        "decision_audit_at": proposal.decision_audit_at or iso_now(),
                        "applying_token": token,
                        "applying_at": iso_now(),
                        "approval_error": None,
                        "decided_by": actor or None,
                        "decided_at": None,
                    })
                    entries[idx] = claimed
                    return claimed, "claimed"
                return proposal, "conflict"
            return None, "missing"

        return await self._mutate_strict(apply)

    async def claim_approval(
        self, proposal_id: str, *, by: str, token: str
    ) -> tuple[Proposal | None, str]:
        """Strictly claim a proposal for approval."""
        return await self._claim_decision(
            proposal_id, by=by, token=token, action="approve"
        )

    async def claim_rejection(
        self, proposal_id: str, *, by: str, token: str
    ) -> tuple[Proposal | None, str]:
        """Strictly claim a proposal for rejection."""
        return await self._claim_decision(
            proposal_id, by=by, token=token, action="reject"
        )

    async def _finalize_decision(
        self, proposal_id: str, *, by: str, token: str, action: str
    ) -> Proposal | None:
        """Strictly finalise the caller's applying lease."""
        status = "approved" if action == "approve" else "rejected"

        def apply(entries: list[Proposal]) -> Proposal | None:
            for idx, proposal in enumerate(entries):
                if proposal.id != proposal_id:
                    continue
                if (
                    proposal.status != "applying"
                    or proposal.applying_token != token
                    or proposal.decision_intent != action
                ):
                    return None
                updated = proposal.model_copy(update={
                    "status": status,
                    "applying_token": None,
                    "applying_at": None,
                    "approval_error": None,
                    "decided_by": self._fixed_decision_actor(proposal, by) or None,
                    "decided_at": iso_now(),
                })
                entries[idx] = updated
                return updated
            return None

        return await self._mutate_strict(apply)

    async def finalize_approval(
        self, proposal_id: str, *, by: str, token: str
    ) -> Proposal | None:
        """Strictly finalise the caller's applying lease as approved."""
        return await self._finalize_decision(
            proposal_id, by=by, token=token, action="approve"
        )

    async def finalize_rejection(
        self, proposal_id: str, *, by: str, token: str
    ) -> Proposal | None:
        """Strictly finalise the caller's applying lease as rejected."""
        return await self._finalize_decision(
            proposal_id, by=by, token=token, action="reject"
        )

    async def release_approval(
        self, proposal_id: str, *, token: str, error: str
    ) -> Proposal | None:
        """Return this caller's failed lease to pending with a visible bounded error."""
        detail = str(error or "Approval failed").strip()[:500]

        def apply(entries: list[Proposal]) -> Proposal | None:
            for idx, proposal in enumerate(entries):
                if proposal.id != proposal_id:
                    continue
                if proposal.status != "applying" or proposal.applying_token != token:
                    return None
                updated = proposal.model_copy(update={
                    "status": "pending",
                    "applying_token": None,
                    "applying_at": None,
                    "approval_error": detail,
                    "decided_by": None,
                    "decided_at": None,
                })
                entries[idx] = updated
                return updated
            return None

        return await self._mutate_strict(apply)

    async def reject_pending(self, proposal_id: str, *, by: str) -> tuple[Proposal | None, str]:
        """Strict pending->rejected transition that cannot race an approval claim."""
        def apply(entries: list[Proposal]) -> tuple[Proposal | None, str]:
            for idx, proposal in enumerate(entries):
                if proposal.id != proposal_id:
                    continue
                if proposal.status != "pending":
                    return proposal, "conflict"
                actor = self._fixed_decision_actor(proposal, by)
                updated = proposal.model_copy(update={
                    "status": "rejected",
                    "approval_error": None,
                    "decided_by": actor or None,
                    "decided_at": iso_now(),
                    "decision_actor": actor,
                })
                entries[idx] = updated
                return updated, "rejected"
            return None, "missing"

        return await self._mutate_strict(apply)
