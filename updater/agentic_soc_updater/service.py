"""Durable update orchestration; all host mutations stay behind this boundary."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import secrets
import threading
import time
from typing import Any
import uuid

from . import PROTOCOL_VERSION, UPDATER_VERSION
from .contract import ContractError, UpgradePlan, validate_plan, validate_release_request
from .runtime import ComposeRuntime, RuntimeFailure, download
from .store import JsonStore, now_iso


ACTIVE_STATUSES = {"queued", "running", "rolling_back"}
TERMINAL_STATUSES = {"succeeded", "failed", "rolled_back", "cancelled"}
STAGE_PROGRESS = {
    "validating": 0,
    "verifying_artifacts": 5,
    "pulling_images": 14,
    "quiescing": 22,
    "backing_up": 30,
    "updating_backend": 48,
    "verifying_backend": 62,
    "updating_webui": 72,
    "verifying_webui": 82,
    "observing": 92,
    "completed": 100,
    "rolling_back": 94,
    "restoring_release": 96,
}


class ServiceError(RuntimeError):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


class UpdateService:
    def __init__(self, store: JsonStore, runtime: ComposeRuntime, trusted_repository: str) -> None:
        self.store = store
        self.runtime = runtime
        self.trusted_repository = trusted_repository
        # Pending preflight reservations use this process-local identity to
        # distinguish a concurrent caller (wait for the in-flight result) from
        # a reservation whose owner disappeared during a process/host crash.
        self._instance_id = str(uuid.uuid4())
        self._workers: dict[str, threading.Thread] = {}

    def status(self) -> dict[str, Any]:
        jobs = self.store.list_jobs()
        active = next((job for job in jobs if job.get("status") in ACTIVE_STATUSES), None)
        last = jobs[0] if jobs else None
        return {
            "available": True,
            "protocol_version": PROTOCOL_VERSION,
            "updater_version": UPDATER_VERSION,
            "state": "busy" if active else "ready",
            "active_job": self.public_job(active) if active else None,
            "last_job": self.public_job(last) if last else None,
            "capabilities": {"preflight": True, "start": True, "cancel": True, "rollback": True},
            "message": "Supervised PostgreSQL Compose updates are available.",
        }

    @staticmethod
    def public_job(job: dict[str, Any] | None) -> dict[str, Any] | None:
        if not job:
            return None
        allowed = {
            "job_id", "release_id", "status", "stage", "progress", "message",
            "started_at", "updated_at", "error", "rollback", "receipt",
            "rollback_receipt",
        }
        return {key: job[key] for key in allowed if key in job}

    @staticmethod
    def _job_operation_bindings(job: dict[str, Any]) -> dict[str, str]:
        value = job.get("operation_idempotency")
        if not isinstance(value, dict):
            return {}
        return {
            str(key): str(binding)
            for key, binding in value.items()
            if isinstance(key, str) and isinstance(binding, str)
        }

    def _repair_idempotency_bindings(self, jobs: list[dict[str, Any]]) -> None:
        """Rebuild missing global lookup entries from atomic durable records.

        The global map is an index, never the sole proof that an operation was
        accepted. Each preflight/job record carries its request key in the same
        fsynced write as its intent. Startup and exact retries may therefore
        repair a missing map entry without replaying a mutation.
        """

        with self.store.locked():
            keys = self.store.idempotency()
            changed = False

            def bind(key: str, value: str) -> None:
                nonlocal changed
                existing = keys.get(key)
                if existing is not None and existing != value:
                    raise RuntimeError(
                        f"conflicting durable updater idempotency binding: {key}"
                    )
                if existing is None:
                    keys[key] = value
                    changed = True

            for preflight in self.store.list_preflights():
                key = preflight.get("idempotency_key")
                token = preflight.get("token")
                if isinstance(key, str) and key and isinstance(token, str) and token:
                    bind(f"preflight:{key}", token)
            for job in jobs:
                job_id = job.get("job_id")
                start_key = job.get("start_idempotency_key")
                if (
                    isinstance(job_id, str)
                    and isinstance(start_key, str)
                    and start_key
                ):
                    bind(f"job:{start_key}", job_id)
                if not isinstance(job_id, str):
                    continue
                for key, binding in self._job_operation_bindings(job).items():
                    bind(f"operation:{key}", binding)
            if changed:
                self.store.save_idempotency(keys)

    def _release_artifacts(self, release: dict[str, str]) -> tuple[Path, Path]:
        directory = self.store.artifacts / release["release_id"]
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        return directory / "upgrade-plan.json", directory / "upgrade-plan.sigstore.json"

    def _load_verified_plan(self, release: dict[str, str], *, refresh: bool) -> UpgradePlan:
        plan_path, bundle_path = self._release_artifacts(release)
        if refresh or not plan_path.exists() or not bundle_path.exists():
            download(release["plan_url"], plan_path, maximum_bytes=256 * 1024)
            download(release["bundle_url"], bundle_path, maximum_bytes=2 * 1024 * 1024)
        self.runtime.verify_plan_signature(plan_path, bundle_path, release["tag"])
        try:
            raw = json.loads(plan_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeFailure("signed upgrade plan is not valid JSON") from exc
        plan = validate_plan(raw, self.trusted_repository)
        if (plan.version, plan.tag, plan.commit_sha) != (
            release["version"], release["tag"], release["commit_sha"]
        ):
            raise RuntimeFailure("signed plan identity does not match the requested Stable release")
        self.runtime.verify_image_signatures(plan)
        return plan

    def preflight(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            release = validate_release_request(body.get("release"), self.trusted_repository)
        except ContractError as exc:
            raise ServiceError(str(exc)) from exc
        idempotency_key = str(body.get("idempotency_key", ""))
        if not idempotency_key or len(idempotency_key) > 160:
            raise ServiceError("idempotency_key is required")

        operation_key = f"preflight:{idempotency_key}"
        token = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(minutes=10)
        wait_for_token: str | None = None
        recovered_reservation = False
        with self.store.locked():
            keys = self.store.idempotency()
            existing = keys.get(operation_key)
            if existing is None:
                candidates = [
                    item
                    for item in self.store.list_preflights()
                    if item.get("idempotency_key") == idempotency_key
                ]
                if len(candidates) > 1:
                    raise ServiceError(
                        "multiple durable preflight reservations use this idempotency key",
                        409,
                    )
                if candidates:
                    saved = candidates[0]
                    if saved.get("release") != release:
                        raise ServiceError(
                            "idempotency key was already used for a different preflight release",
                            409,
                        )
                    existing = str(saved.get("token") or "")
                    if not existing:
                        raise ServiceError(
                            "durable preflight reservation is malformed", 409
                        )
                    keys[operation_key] = existing
                    self.store.save_idempotency(keys)
                    response = saved.get("response")
                    if isinstance(response, dict):
                        return response
                    # The only way a pending reservation can exist without its
                    # index binding is loss between those two fsynced writes.
                    # Claim that exact token and finish it rather than creating
                    # a second signed-release request.
                    token = existing
                    expires = datetime.now(timezone.utc) + timedelta(minutes=10)
                    saved.update(
                        {
                            "expires_at": expires.isoformat().replace(
                                "+00:00", "Z"
                            ),
                            "owner_id": self._instance_id,
                            "state": "pending",
                        }
                    )
                    self.store.save_preflight(token, saved)
                    recovered_reservation = True
            if existing:
                saved = self.store.load_preflight(existing)
                if not saved or saved.get("release") != release:
                    raise ServiceError(
                        "idempotency key was already used for a different preflight release",
                        409,
                    )
                response = saved.get("response")
                if isinstance(response, dict):
                    return response
                if not recovered_reservation:
                    if saved.get("owner_id") != self._instance_id:
                        # The prior updater process vanished after persisting
                        # the reservation. Claim its exact token and complete
                        # the same operation; never mint a parallel preflight.
                        expires = datetime.now(timezone.utc) + timedelta(minutes=10)
                        saved.update(
                            {
                                "expires_at": expires.isoformat().replace(
                                    "+00:00", "Z"
                                ),
                                "owner_id": self._instance_id,
                                "state": "pending",
                            }
                        )
                        self.store.save_preflight(existing, saved)
                        token = existing
                        recovered_reservation = True
                    else:
                        # The response expiry bounds how long a completed
                        # preflight may authorize Start; it is not permission to
                        # mint a parallel reservation while this process may
                        # still be verifying the original request. Preserve the
                        # exact token and wait for its one durable result. If the
                        # worker vanished without the process restarting, the
                        # bounded wait fails closed and a supervisor restart can
                        # reclaim the same reservation under a new owner_id.
                        wait_for_token = existing
            if wait_for_token is None and not recovered_reservation:
                # Persist the authoritative reservation before any network or
                # signature work, then publish its repairable lookup index. A
                # second caller can wait for this exact result but can never
                # rebind the same key or overwrite an in-flight response.
                reservation = {
                    "token": token,
                    "expires_at": expires.isoformat().replace("+00:00", "Z"),
                    "release": release,
                    "idempotency_key": idempotency_key,
                    "owner_id": self._instance_id,
                    "state": "pending",
                }
                self.store.save_preflight(token, reservation)
                keys[operation_key] = token
                self.store.save_idempotency(keys)

        if wait_for_token is not None:
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                saved = self.store.load_preflight(wait_for_token)
                response = saved.get("response") if saved else None
                if isinstance(response, dict):
                    return response
                time.sleep(0.05)
            raise ServiceError(
                "an identical preflight is still running or was interrupted; retry with a new key",
                409,
            )

        try:
            plan = self._load_verified_plan(release, refresh=True)
            report = self.runtime.preflight(plan)
        except (RuntimeFailure, ContractError) as exc:
            report = {
                "checks": [{"code": "signed_release", "status": "fail", "detail": str(exc), "label": "Signed Stable release"}],
                "blockers": [{"code": "signed_release", "message": str(exc), "remediation": "Use an immutable Stable GitHub Release produced by the trusted release workflow."}],
                "warnings": [],
                "current": {},
            }
            plan = None

        response = {
            "preflight_token": token,
            "expires_at": expires.isoformat().replace("+00:00", "Z"),
            "release": {
                "release_id": release["release_id"],
                "version": release["version"],
                "tag": release["tag"],
                "commit_sha": release["commit_sha"],
                "channel": "stable",
                "repository_url": f"https://github.com/{release['repository']}",
            },
            "checks": report["checks"],
            "blockers": report["blockers"],
            "warnings": report["warnings"],
            "components": (
                [
                    {
                        "id": "updater",
                        "label": "Update supervisor",
                        "current_version": UPDATER_VERSION,
                        "target_version": plan.version,
                        "scope": "updated",
                        "will_update": True,
                    },
                    {
                        "id": "backend",
                        "label": "Backend API",
                        "current_version": report.get("current", {}).get("version"),
                        "target_version": plan.version,
                        "scope": "updated",
                        "will_update": True,
                    },
                    {
                        "id": "webui",
                        "label": "Web Console",
                        "current_version": report.get("current", {}).get("version"),
                        "target_version": plan.version,
                        "scope": "updated",
                        "will_update": True,
                    },
                    {
                        "id": "help_center",
                        "label": "Bundled Help Center",
                        "current_version": report.get("current", {}).get("version"),
                        "target_version": plan.version,
                        "scope": "bundled",
                        "will_update": True,
                    },
                    {
                        "id": "postgres",
                        "label": "PostgreSQL infrastructure",
                        "current_version": None,
                        "target_version": None,
                        "scope": "unchanged",
                        "will_update": False,
                    },
                    {
                        "id": "redis",
                        "label": "Redis infrastructure",
                        "current_version": None,
                        "target_version": None,
                        "scope": "unchanged",
                        "will_update": False,
                    },
                ]
                if plan
                else []
            ),
            "backup": {
                "required": True,
                "kind": "postgres_custom_format",
                "state": "planned" if plan else "unavailable",
                "verified": False,
                "description": "A custom-format PostgreSQL backup is checksumed and catalog-verified before either application image is switched.",
            },
            "rollback": {
                "automatic": True,
                "supported": bool(plan),
                "state": "planned" if plan else "unavailable",
                "description": "Rollback becomes ready only after the prior image IDs and quiesced PostgreSQL backup have been captured and verified.",
            },
        }
        record = {
            "token": token,
            "expires_at": response["expires_at"],
            "release": release,
            "idempotency_key": idempotency_key,
            "owner_id": self._instance_id,
            "response": response,
            "plan": plan.raw if plan else None,
            "state": "complete",
        }
        with self.store.locked():
            keys = self.store.idempotency()
            if keys.get(operation_key) != token:
                raise ServiceError(
                    "preflight reservation changed before completion", 409
                )
            self.store.save_preflight(token, record)
        return response

    def start(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            release = validate_release_request(body.get("release"), self.trusted_repository)
        except ContractError as exc:
            raise ServiceError(str(exc)) from exc
        token = str(body.get("preflight_token", ""))
        idempotency_key = str(body.get("idempotency_key", ""))
        if not token or not idempotency_key or len(idempotency_key) > 160:
            raise ServiceError("preflight_token and idempotency_key are required")
        operation_key = f"job:{idempotency_key}"
        with self.store.locked():
            keys = self.store.idempotency()
            existing_id = keys.get(operation_key)
            if existing_id is None:
                candidates = [
                    item
                    for item in self.store.list_jobs()
                    if item.get("start_idempotency_key") == idempotency_key
                ]
                if len(candidates) > 1:
                    raise ServiceError(
                        "multiple durable update jobs use this idempotency key", 409
                    )
                if candidates:
                    candidate = candidates[0]
                    candidate_id = candidate.get("job_id")
                    if not isinstance(candidate_id, str):
                        raise ServiceError("durable update reservation is malformed", 409)
                    if candidate.get("release") != release:
                        raise ServiceError(
                            "idempotency key was already used for a different request",
                            409,
                        )
                    keys[operation_key] = candidate_id
                    self.store.save_idempotency(keys)
                    if candidate.get("status") in ACTIVE_STATUSES:
                        self.runtime.begin_lifecycle(candidate_id)
                        self._launch(
                            candidate_id,
                            rollback_only=candidate.get("status") == "rolling_back",
                        )
                    return self.public_job(candidate) or {}
            if existing_id:
                existing = self.store.load_job(existing_id)
                if existing and existing.get("release") == release:
                    if existing.get("status") in ACTIVE_STATUSES:
                        self.runtime.begin_lifecycle(existing_id)
                        self._launch(
                            existing_id,
                            rollback_only=existing.get("status") == "rolling_back",
                        )
                    return self.public_job(existing) or {}
                raise ServiceError("idempotency key was already used for a different request", 409)
            preflight = self.store.load_preflight(token)
            if not preflight or preflight.get("release") != release:
                raise ServiceError("preflight token is invalid or belongs to another release", 409)
            try:
                expires = datetime.fromisoformat(str(preflight["expires_at"]).replace("Z", "+00:00"))
            except (ValueError, KeyError) as exc:
                raise ServiceError("preflight token is invalid", 409) from exc
            if expires <= datetime.now(timezone.utc):
                raise ServiceError("preflight token expired; run preflight again", 409)
            if preflight["response"].get("blockers"):
                raise ServiceError("preflight has blocking checks", 409)
            active = next((job for job in self.store.list_jobs() if job.get("status") in ACTIVE_STATUSES), None)
            if active:
                raise ServiceError("another update job is active", 409)
            job_id = f"update-{uuid.uuid4()}"
            job = {
                "job_id": job_id,
                "release_id": release["release_id"],
                "release": release,
                "status": "queued",
                "stage": "validating",
                "progress": 0,
                "message": "Update queued",
                "started_at": now_iso(),
                "updated_at": now_iso(),
                "cancel_requested": False,
                "switch_started": False,
                "plan": preflight["plan"],
                "start_idempotency_key": idempotency_key,
            }
            # Persist the recoverable queued reservation before publishing the
            # host marker. A process or host loss at any later instruction can
            # therefore be resumed from durable truth; it can never leave an
            # orphan marker with no corresponding job. The worker acquires the
            # same lifecycle lock first and then re-runs deployment preflight,
            # so a wrapper command completed in this tiny job-first interval is
            # serialized and included in the worker's fresh host assessment.
            try:
                self.store.save_job(job)
                keys[operation_key] = job_id
                self.store.save_idempotency(keys)
                self.runtime.begin_lifecycle(job_id)
            except Exception as exc:
                # If the durable reservation exists, make the failed start
                # terminal so it neither wedges resume nor masquerades as an
                # in-flight update. begin_lifecycle cleans its own partial lock;
                # release is a no-op unless this process actually owns it.
                current = self.store.load_job(job_id)
                if current is not None:
                    current.update(
                        {
                            "status": "failed",
                            "message": "Update could not reserve the host lifecycle",
                            "updated_at": now_iso(),
                            "error": {
                                "code": "lifecycle_reservation_failed",
                                "message": str(exc)[:500],
                                "remediation": "Reconcile the reported host lifecycle state, then run a new preflight.",
                            },
                        }
                    )
                    self.store.save_job(current)
                self.runtime.release_lifecycle(job_id, terminal=True)
                raise
        self._launch(job_id)
        return self.public_job(job) or {}

    def get_job(self, job_id: str) -> dict[str, Any]:
        job = self.store.load_job(job_id)
        if not job:
            raise ServiceError("update job not found", 404)
        return self.public_job(job) or {}

    def cancel(self, job_id: str, body: dict[str, Any]) -> dict[str, Any]:
        idempotency_key = str(body.get("idempotency_key", ""))
        if not idempotency_key or len(idempotency_key) > 160:
            raise ServiceError("idempotency_key is required")
        with self.store.locked():
            keys = self.store.idempotency()
            operation_key = f"operation:{idempotency_key}"
            binding = f"cancel:{job_id}"
            job = self.store.load_job(job_id)
            if not job:
                raise ServiceError("update job not found", 404)
            durable_bindings = self._job_operation_bindings(job)
            durable_binding = durable_bindings.get(idempotency_key)
            indexed_binding = keys.get(operation_key)
            if durable_binding is not None:
                if durable_binding != binding or indexed_binding not in {
                    None,
                    binding,
                }:
                    raise ServiceError(
                        "idempotency key was already used for another operation", 409
                    )
                if indexed_binding is None:
                    keys[operation_key] = binding
                    self.store.save_idempotency(keys)
                return self.public_job(job) or {}
            if indexed_binding is not None and indexed_binding != binding:
                raise ServiceError(
                    "idempotency key was already used for another operation", 409
                )
            if job.get("switch_started"):
                raise ServiceError("update cannot be cancelled after deployment switching starts", 409)
            if job.get("status") in ACTIVE_STATUSES:
                job["cancel_requested"] = True
                job["message"] = "Cancellation requested"
            durable_bindings[idempotency_key] = binding
            job["operation_idempotency"] = durable_bindings
            job["updated_at"] = now_iso()
            # The operation proof and cancellation intent share one atomic job
            # write. The global map is only a repairable lookup index.
            self.store.save_job(job)
            keys[operation_key] = binding
            self.store.save_idempotency(keys)
        return self.public_job(job) or {}

    def request_rollback(self, job_id: str, body: dict[str, Any]) -> dict[str, Any]:
        idempotency_key = str(body.get("idempotency_key", ""))
        if not idempotency_key or len(idempotency_key) > 160:
            raise ServiceError("idempotency_key is required")
        launch_rollback = False
        with self.store.locked():
            keys = self.store.idempotency()
            operation_key = f"operation:{idempotency_key}"
            binding = f"rollback:{job_id}"
            job = self.store.load_job(job_id)
            if not job:
                raise ServiceError("update job not found", 404)
            durable_bindings = self._job_operation_bindings(job)
            durable_binding = durable_bindings.get(idempotency_key)
            indexed_binding = keys.get(operation_key)
            if durable_binding is not None:
                if durable_binding != binding or indexed_binding not in {
                    None,
                    binding,
                }:
                    raise ServiceError(
                        "idempotency key was already used for another operation", 409
                    )
                if indexed_binding is None:
                    keys[operation_key] = binding
                    self.store.save_idempotency(keys)
                if job.get("status") == "rolling_back":
                    launch_rollback = True
                elif job.get("status") not in TERMINAL_STATUSES:
                    raise ServiceError(
                        "durable rollback intent has inconsistent job state", 409
                    )
            else:
                if indexed_binding is not None and indexed_binding != binding:
                    raise ServiceError(
                        "idempotency key was already used for another operation", 409
                    )
                # Repair a legacy job that persisted rolling_back after the old
                # map-first ordering but before it could embed durable intent.
                if (
                    indexed_binding == binding
                    and job.get("status") == "rolling_back"
                    and job.get("rollback_operator_requested") is True
                ):
                    durable_bindings[idempotency_key] = binding
                    job["operation_idempotency"] = durable_bindings
                    self.store.save_job(job)
                    launch_rollback = True
                else:
                    active = next(
                        (
                            candidate
                            for candidate in self.store.list_jobs()
                            if candidate.get("job_id") != job_id
                            and candidate.get("status") in ACTIVE_STATUSES
                        ),
                        None,
                    )
                    if active:
                        raise ServiceError(
                            "another update or rollback job is active", 409
                        )
                    if job.get("status") != "succeeded" or not job.get("snapshot"):
                        raise ServiceError(
                            "this job has no rollbackable deployment snapshot", 409
                        )
                    target_identity = job.get("installed_target")
                    if not isinstance(target_identity, dict):
                        raise ServiceError(
                            "this job predates exact installed-release rollback evidence",
                            409,
                        )
                    started_at = str(job.get("started_at", ""))
                    superseding = next(
                        (
                            candidate
                            for candidate in self.store.list_jobs()
                            if candidate.get("job_id") != job_id
                            and str(candidate.get("started_at", "")) > started_at
                            and candidate.get("switch_started") is True
                        ),
                        None,
                    )
                    if superseding:
                        raise ServiceError(
                            "this update was superseded by a later deployment transaction",
                            409,
                        )
                    try:
                        current_identity = self.runtime.installed_identity()
                    except RuntimeFailure as exc:
                        raise ServiceError(
                            f"current installed release could not be verified: {exc}",
                            409,
                        ) from exc
                    if not self._same_installed_identity(
                        current_identity, target_identity
                    ):
                        raise ServiceError(
                            "the running release no longer matches this job's verified target",
                            409,
                        )
                    job["status"] = "rolling_back"
                    job["stage"] = "rolling_back"
                    job["progress"] = STAGE_PROGRESS["rolling_back"]
                    job["message"] = "Operator-requested rollback started"
                    # v1 release plans never migrate the schema. An operator
                    # rollback changes images only and preserves later DB writes.
                    job["rollback_restore_database"] = False
                    job["rollback_automatic"] = False
                    job["rollback_operator_requested"] = True
                    job["rollback_terminal_status"] = "rolled_back"
                    # Rechecked by the rollback worker after lifecycle locking.
                    job["rollback_authorized_identity"] = current_identity
                    durable_bindings[idempotency_key] = binding
                    job["operation_idempotency"] = durable_bindings
                    job["updated_at"] = now_iso()
                    # Intent and idempotency proof are one atomic job write. The
                    # global map is a repairable lookup index written second.
                    self.store.save_job(job)
                    keys[operation_key] = binding
                    self.store.save_idempotency(keys)
                    launch_rollback = True
        if launch_rollback:
            # If the host dies after the durable intent but before this lock,
            # resume() launches the same rollback. The worker rechecks the exact
            # installed identity after acquiring the lifecycle lock.
            self.runtime.begin_lifecycle(job_id)
            self._launch(job_id, rollback_only=True)
        return self.public_job(job) or {}

    @staticmethod
    def _same_installed_identity(
        current: dict[str, Any], expected: dict[str, Any]
    ) -> bool:
        keys = (
            "version",
            "channel",
            "commit_sha",
            "state_schema",
            "backend_image_id",
            "webui_image_id",
        )
        return all(
            isinstance(current.get(key), str)
            and current.get(key) == expected.get(key)
            for key in keys
        )

    @staticmethod
    def _raise_runtime_blockers(report: Any, *, context: str) -> None:
        blockers = report.get("blockers") if isinstance(report, dict) else None
        if not blockers:
            return
        codes = sorted(
            {
                str(item.get("code") or "runtime_preflight")[:80]
                for item in blockers
                if isinstance(item, dict)
            }
        )
        if not codes:
            codes = ["runtime_preflight"]
        raise RuntimeError(f"{context}: " + ", ".join(codes))

    def receipt(self, job_id: str) -> dict[str, Any]:
        job = self.store.load_job(job_id)
        if not job:
            raise ServiceError("update job not found", 404)
        # A post-success rollback is a distinct deployment transaction. Keep
        # both receipts on the job for audit history, while the receipt endpoint
        # returns the latest terminal truth for callers that only consume one.
        receipt = job.get("rollback_receipt") or job.get("receipt")
        if not isinstance(receipt, dict):
            raise ServiceError("update receipt is not available yet", 409)
        return receipt

    def _save_stage(self, job: dict[str, Any], stage: str, message: str, *, status: str = "running") -> None:
        job.update({
            "status": status,
            "stage": stage,
            "progress": STAGE_PROGRESS[stage],
            "message": message,
            "updated_at": now_iso(),
        })
        self._save_worker_job(job)

    def _save_worker_job(self, job: dict[str, Any]) -> None:
        """Persist worker progress without losing an API cancellation race."""

        with self.store.locked():
            current = self.store.load_job(job["job_id"])
            if current and current.get("cancel_requested"):
                job["cancel_requested"] = True
            self.store.save_job(job)

    def _cancel_if_requested(self, job: dict[str, Any]) -> bool:
        current = self.store.load_job(job["job_id"]) or job
        if current.get("cancel_requested") and not current.get("switch_started"):
            job.update(current)
            if job.get("snapshot") and job.get("override_started"):
                job["rollback_restore_database"] = False
                job["rollback_automatic"] = False
                job["rollback_operator_requested"] = False
                job["rollback_terminal_status"] = "cancelled"
                self._save_stage(
                    job,
                    "rolling_back",
                    "Cancellation requested; restoring the prior application images",
                    status="rolling_back",
                )
                self._rollback_worker(job["job_id"])
            else:
                self._save_stage(job, job.get("stage", "validating"), "Update cancelled before deployment switching", status="cancelled")
            return True
        return False

    def _begin_switch(self, job: dict[str, Any]) -> bool:
        """Atomically close the cancellation window and claim deployment switching.

        The API and worker share the store lock for this transition. A cancel
        accepted first is honored before any service switch; once this claim is
        durable, the API rejects cancellation and the rollback state machine owns
        recovery. This prevents a stale worker copy from crossing the boundary.
        """

        with self.store.locked():
            current = self.store.load_job(job["job_id"])
            if not current:
                raise RuntimeError("update job disappeared before deployment switching")
            if current.get("cancel_requested"):
                job.update(current)
                return False
            current["switch_started"] = True
            current["updated_at"] = now_iso()
            self.store.save_job(current)
            job.update(current)
            return True

    def _launch(self, job_id: str, *, rollback_only: bool = False) -> None:
        worker = self._workers.get(job_id)
        if worker and worker.is_alive():
            return
        target = self._rollback_worker if rollback_only else self._worker
        worker = threading.Thread(target=target, args=(job_id,), daemon=True, name=f"updater-{job_id}")
        self._workers[job_id] = worker
        worker.start()

    def resume(self) -> None:
        jobs = self.store.list_jobs()
        self._repair_idempotency_bindings(jobs)
        # Recover the narrow crash window after a terminal job record was
        # fsynced but before the process removed its host lifecycle marker.
        # Runtime reconciliation takes the shared advisory lock and clears only
        # a marker naming one exact durable terminal job. Every other marker is
        # deliberately preserved so supported host mutations remain blocked.
        self.runtime.reconcile_terminal_lifecycle(
            {
                str(job["job_id"])
                for job in jobs
                if job.get("status") in TERMINAL_STATUSES and job.get("job_id")
            }
        )
        for job in jobs:
            if job.get("status") == "rolling_back":
                self._launch(job["job_id"], rollback_only=True)
            elif job.get("status") in ACTIVE_STATUSES:
                self._launch(job["job_id"])

    def _worker(self, job_id: str) -> None:
        job = self.store.load_job(job_id)
        if not job:
            return
        try:
            # Reentrant in the original process and reacquired by a replacement
            # updater after self-handoff.  The durable marker bridges the short
            # interval in which neither process owns the advisory descriptor.
            self.runtime.begin_lifecycle(job_id)
            resumed_after_handoff = job.get("stage") in {
                "quiescing", "backing_up", "updating_backend", "verifying_backend",
                "updating_webui", "verifying_webui", "observing",
            }
            if not resumed_after_handoff:
                self._save_stage(job, "verifying_artifacts", "Re-verifying signed release and deployment preconditions")
            # A replacement updater never trusts only the durable JSON job. It
            # re-verifies the persisted Sigstore bundle, plan identity and all
            # three image signatures before resuming at the handoff checkpoint.
            plan = self._load_verified_plan(job["release"], refresh=False)
            if not resumed_after_handoff:
                # The signed release remains immutable, but the host can drift
                # during the short-lived preflight-token window. Re-evaluate
                # every supported-topology and installed-identity check in the
                # worker immediately before the first host mutation. A resumed
                # post-handoff worker intentionally skips this: by then the
                # updater/override transition has changed the very state those
                # initial checks describe and recovery is checkpoint-driven.
                report = self.runtime.preflight(plan)
                self._raise_runtime_blockers(
                    report, context="runtime preflight changed before update"
                )
                initial_fingerprint = self.runtime.deployment_fingerprint()
                if self._cancel_if_requested(job):
                    return
                self._save_stage(job, "pulling_images", "Pulling and validating all digest-pinned images")
                self.runtime.pull_and_validate(plan)
                # Pulls can be slow. The deployment files, environment, topology,
                # and current containers are untrusted mutable host state, so prove
                # them again immediately before recording the recovery snapshot or
                # preparing the target override.
                post_pull_report = self.runtime.preflight(plan)
                self._raise_runtime_blockers(
                    post_pull_report,
                    context="runtime preflight changed while images were pulled",
                )
                if self.runtime.deployment_fingerprint() != initial_fingerprint:
                    raise RuntimeError(
                        "deployment identity changed while images were pulled"
                    )
                job["snapshot"] = self.runtime.capture_snapshot(job_id)
                # The exact old image IDs are durable before target pins are
                # prepared privately.  Preparation never changes the active
                # internal or host-visible Compose inputs.
                self._save_worker_job(job)
                if self._cancel_if_requested(job):
                    return
                job["override_started"] = True
                self._save_worker_job(job)
                self.runtime.prepare_target_override(plan)
                job["override_written"] = True
                self._save_worker_job(job)
                if self._cancel_if_requested(job):
                    return
                if self.runtime.updater_handoff_required(plan):
                    job["handoff_attempts"] = int(job.get("handoff_attempts", 0)) + 1
                    self._save_stage(job, "quiescing", "Handing off to the signed target updater before application changes")
                    self.runtime.handoff_updater()
                    return

            if job.get("handoff_attempts") and not job.get("handoff_complete"):
                if self.runtime.updater_handoff_required(plan):
                    raise RuntimeError(
                        "signed target updater did not become healthy; the prior supervisor was restored"
                    )
                job["handoff_complete"] = True
                self._save_worker_job(job)

            if self._cancel_if_requested(job):
                return
            if not job.get("quiesced"):
                job["quiesce_started"] = True
                self._save_stage(job, "quiescing", "Stopping the backend writer before the rollback snapshot")
                self.runtime.quiesce_backend()
                job["quiesced"] = True
                job["quiesced_at"] = now_iso()
                self._save_worker_job(job)
            if self._cancel_if_requested(job):
                return

            if not job.get("backup"):
                self._save_stage(job, "backing_up", "Creating and verifying the PostgreSQL rollback backup")
                job["backup"] = self.runtime.backup_postgres(job_id)
                job["backup"]["writer_quiesced"] = True
                job["backup"]["quiesced_at"] = job["quiesced_at"]
                self._save_worker_job(job)
            if self._cancel_if_requested(job):
                return

            if not self._begin_switch(job):
                self._cancel_if_requested(job)
                return
            # This is the sole release-override publication boundary.  The
            # backend writer is stopped, the PostgreSQL dump is verified, and
            # cancellation is atomically closed before target pins become input
            # to either updater-internal or host-wrapper Compose commands.
            job["override_activation_started"] = True
            self._save_worker_job(job)
            self.runtime.activate_target_override(plan)
            job["override_activated"] = True
            self._save_worker_job(job)
            self._save_stage(job, "updating_backend", "Switching the backend to the signed target image")
            self.runtime.switch_backend()
            self._save_stage(job, "verifying_backend", "Waiting for target backend readiness and release identity")
            self.runtime.verify_backend(plan)
            self._save_stage(job, "updating_webui", "Switching the Console and bundled Help Center")
            self.runtime.switch_webui()
            self._save_stage(job, "verifying_webui", "Verifying Console health and release identity")
            self.runtime.verify_webui(plan)
            self._save_stage(job, "observing", "Observing the coherent target deployment")
            self.runtime.observe(plan)
            installed_target = self.runtime.installed_identity()
            if (
                installed_target.get("version") != plan.version
                or installed_target.get("commit_sha") != plan.commit_sha
                or installed_target.get("channel") != "stable"
                or installed_target.get("state_schema") != str(plan.state_schema)
            ):
                raise RuntimeError(
                    "observed deployment does not match the signed target identity"
                )
            # Exact local image IDs bind any later operator rollback to this one
            # still-running target, not merely to the same semantic version.
            job["installed_target"] = installed_target
            job["receipt"] = {
                "job_id": job["job_id"],
                "release_id": job["release_id"],
                "status": "succeeded",
                "before": {
                    "version": job["snapshot"].get("version", "unknown"),
                    "commit_sha": job["snapshot"].get("commit_sha", "unknown"),
                },
                "after": {"version": plan.version, "commit_sha": plan.commit_sha},
                "components": ["updater", "backend", "webui", "help_center"],
                "backup_id": job["job_id"],
                "rollback_performed": False,
                "started_at": job["started_at"],
                "completed_at": now_iso(),
            }
            self._save_stage(job, "completed", "Update completed and verified", status="succeeded")
        except Exception as exc:  # noqa: BLE001 - every failure must enter rollback
            job = self.store.load_job(job_id) or job
            job["error"] = {"code": "update_failed", "message": str(exc)[:500], "remediation": "Review the durable job and rollback receipt, then retry preflight after correcting the reported condition."}
            if job.get("snapshot") and job.get("override_started"):
                # v1 plans are schema-preserving. The target backend may have
                # accepted legitimate writes after readiness, so an automatic
                # snapshot restore could silently discard operator work. Always
                # preserve PostgreSQL and restore only the exact prior images.
                # The verified dump remains a break-glass recovery artifact.
                job["rollback_restore_database"] = False
                job["rollback_automatic"] = True
                job["rollback_terminal_status"] = "rolled_back"
                self._save_stage(job, "rolling_back", "Update failed; automatic rollback started", status="rolling_back")
                self._rollback_worker(job_id)
            else:
                self._save_stage(job, job.get("stage", "validating"), "Update failed before deployment switching", status="failed")
        finally:
            current = self.store.load_job(job_id)
            terminal = bool(current and current.get("status") in TERMINAL_STATUSES)
            self.runtime.release_lifecycle(job_id, terminal=terminal)

    def _rollback_worker(self, job_id: str) -> None:
        job = self.store.load_job(job_id)
        if not job:
            return
        try:
            self.runtime.begin_lifecycle(job_id)
            if bool(job.get("rollback_operator_requested", False)):
                expected = job.get("rollback_authorized_identity")
                current = self.runtime.installed_identity()
                if not isinstance(expected, dict) or not self._same_installed_identity(
                    current, expected
                ):
                    raise RuntimeError(
                        "running release changed after rollback authorization"
                    )
            self._save_stage(
                job,
                "restoring_release",
                "Restoring the prior application images; PostgreSQL is preserved",
                status="rolling_back",
            )
            # Never restore PostgreSQL automatically. A durable job written by
            # an older supervisor may still contain `true`; ignoring it is the
            # data-preserving v1 compatibility behavior.
            restore_database = False
            job["rollback_restore_database"] = False
            self.runtime.rollback(job["snapshot"], job.get("backup"), restore_database=restore_database)
            terminal_status = str(job.get("rollback_terminal_status") or "rolled_back")
            if terminal_status not in {"rolled_back", "cancelled"}:
                terminal_status = "rolled_back"
            job["rollback"] = {
                "automatic": bool(job.get("rollback_automatic", True)),
                "supported": True,
                "state": "ready",
                "description": "The exact prior backend/Web images were restored without discarding later PostgreSQL writes.",
            }
            snapshot = job["snapshot"]
            rollback_origin = job.get("rollback_authorized_identity")
            if not isinstance(rollback_origin, dict):
                rollback_origin = job.get("installed_target")
            if not isinstance(rollback_origin, dict):
                # An automatic rollback can start from a partially switched
                # deployment without one coherent target identity. In that case
                # the prior snapshot is the only identity we can state exactly.
                rollback_origin = snapshot
            rollback_receipt = {
                "job_id": job["job_id"],
                "release_id": job["release_id"],
                "status": terminal_status,
                "before": {
                    "version": rollback_origin.get("version", "unknown"),
                    "commit_sha": rollback_origin.get("commit_sha", "unknown"),
                },
                "after": {
                    "version": snapshot.get("version", "unknown"),
                    "commit_sha": snapshot.get("commit_sha", "unknown"),
                },
                "components": ["backend", "webui", "help_center"],
                "backup_id": job["job_id"] if job.get("backup") else None,
                "rollback_performed": True,
                "started_at": job["started_at"],
                "completed_at": now_iso(),
            }
            if isinstance(job.get("receipt"), dict):
                # Post-success rollback is a second transaction. Preserve the
                # immutable success receipt and publish distinct rollback evidence.
                job["rollback_receipt"] = rollback_receipt
            else:
                job["receipt"] = rollback_receipt
            self._save_stage(
                job,
                "completed",
                "Prior backend and Web were restored; PostgreSQL is preserved",
                status=terminal_status,
            )
        except Exception as exc:  # noqa: BLE001 - recovery failure must be durable
            automatic = bool(job.get("rollback_automatic", True))
            operator_requested = bool(job.get("rollback_operator_requested", False))
            if automatic:
                kind = "Automatic"
            elif operator_requested:
                kind = "Operator-requested"
            else:
                kind = "Cancellation recovery"
            job["rollback"] = {
                "automatic": automatic,
                "supported": True,
                "state": "unavailable",
                "description": f"{kind} rollback failed; use the retained backup and snapshot receipt for manual recovery.",
            }
            job["error"] = {
                "code": "rollback_failed",
                "message": f"{kind} rollback failed; manual recovery is required",
                "remediation": "Use the retained custom-format backup and prior image IDs from the host updater ledger.",
            }
            self._save_stage(
                job,
                "completed",
                f"{kind} rollback failed; manual recovery is required",
                status="failed",
            )
        finally:
            current = self.store.load_job(job_id)
            terminal = bool(current and current.get("status") in TERMINAL_STATUSES)
            self.runtime.release_lifecycle(job_id, terminal=terminal)
