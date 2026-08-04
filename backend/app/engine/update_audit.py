"""Durable, replay-safe audit projection for updater terminal outcomes."""

from __future__ import annotations

from typing import TYPE_CHECKING, Iterable

from ..constants import ActionType
from .update_supervisor import UpdateJob

if TYPE_CHECKING:
    from ..stores.base import AuditRepository


TERMINAL_JOB_STATUSES = frozenset(
    {"succeeded", "failed", "rolled_back", "cancelled"}
)


async def audit_terminal_job(audit: "AuditRepository", job: UpdateJob) -> bool:
    """Mirror one terminal supervisor state into append-only application audit.

    The supervisor preserves the immutable installation receipt when a later
    rollback transaction changes the job's current status. Reconstruct both
    transitions from those receipts before falling back to the current state so
    a fast rollback cannot erase the successful-install evidence merely because
    no browser or background poll observed it first.

    The deterministic event id makes browser polling, process restart replay, and
    the background reconciler converge on one immutable row per job transition.
    Supervisor error messages and host/runtime details are deliberately excluded.
    """
    if job.status not in TERMINAL_JOB_STATUSES:
        return False

    transitions: list[tuple[str, str]] = []
    seen: set[str] = set()
    fallback_timestamp = (
        job.updated_at or job.started_at or "1970-01-01T00:00:00Z"
    )
    for receipt in (job.receipt, job.rollback_receipt):
        if receipt is None or receipt.status not in TERMINAL_JOB_STATUSES:
            continue
        if receipt.job_id != job.job_id or receipt.release_id != job.release_id:
            raise RuntimeError(
                "system-update receipt identity does not match its durable job"
            )
        if receipt.status in seen:
            continue
        transitions.append(
            (receipt.status, receipt.completed_at or fallback_timestamp)
        )
        seen.add(receipt.status)

    if job.status not in seen:
        transitions.append((job.status, fallback_timestamp))

    for status, timestamp in transitions:
        await audit.record_strict(
            action_type=ActionType.SYSTEM_UPDATE,
            event_id=f"system-update:terminal:{job.job_id}:{status}"[:512],
            ts=timestamp,
            surface="system_updates",
            actor="update_supervisor",
            result_summary=(
                f"terminal job_id={job.job_id} release_id={job.release_id} "
                f"status={status}"
            )[:500],
        )
    return True


async def audit_terminal_jobs(
    audit: "AuditRepository", jobs: Iterable[UpdateJob]
) -> int:
    """Replay terminal jobs oldest-first; strict persistence fails closed."""
    ordered = sorted(
        jobs,
        key=lambda job: job.updated_at or job.started_at or "",
    )
    mirrored = 0
    for job in ordered:
        if await audit_terminal_job(audit, job):
            mirrored += 1
    return mirrored
