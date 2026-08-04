"""Bounded client and public contracts for the external update supervisor.

The API backend is a policy/control plane only.  It has no Docker socket, shell,
registry credential, backup path, or host filesystem authority.  The separately
installed updater owns those capabilities and exposes a deliberately tiny HTTP
protocol on a private Unix socket.  There is no TCP fallback.

Only immutable Stable release IDs are accepted by the public API.  Canonical GitHub
Release asset URLs are derived server-side and handed to the supervisor, which still
independently verifies its fixed repository/workflow/Sigstore trust policy and every
image digest before changing the deployment.
"""

from __future__ import annotations

import json
import os
import stat
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..utils import iso_now

SUPERVISOR_PROTOCOL_MIN = "1"
MAX_SUPERVISOR_RESPONSE_BYTES = 1024 * 1024

UpdateJobStatus = Literal[
    "queued",
    "running",
    "succeeded",
    "failed",
    "rolling_back",
    "rolled_back",
    "cancelled",
]
UpdateJobStage = Literal[
    "validating",
    "verifying_artifacts",
    "pulling_images",
    "quiescing",
    "backing_up",
    "updating_backend",
    "verifying_backend",
    "updating_webui",
    "verifying_webui",
    "observing",
    "rolling_back",
    "restoring_release",
    "completed",
]


class StrictUpdateModel(BaseModel):
    """Versioned supervisor/API objects reject silent protocol drift."""

    model_config = ConfigDict(extra="forbid")


class UpdateIssue(StrictUpdateModel):
    code: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_]+$")
    message: str = Field(min_length=1, max_length=500)
    remediation: str | None = Field(default=None, max_length=500)


class UpdateRelease(StrictUpdateModel):
    """Release identity safe to return to the browser (no artifact URL inputs)."""

    release_id: str = Field(pattern=r"^v[0-9]+\.[0-9]+\.[0-9]+$")
    version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    tag: str = Field(pattern=r"^v[0-9]+\.[0-9]+\.[0-9]+$")
    commit_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    channel: Literal["stable"] = "stable"
    repository_url: str = Field(max_length=512)


class UpdateCheck(StrictUpdateModel):
    code: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1, max_length=160)
    status: Literal["pass", "fail", "warning"]
    detail: str = Field(min_length=1, max_length=500)


class UpdateComponent(StrictUpdateModel):
    id: Literal[
        "updater", "backend", "webui", "help_center", "postgres", "redis"
    ]
    label: str = Field(min_length=1, max_length=120)
    current_version: str | None = Field(default=None, max_length=80)
    target_version: str | None = Field(default=None, max_length=80)
    scope: Literal["updated", "bundled", "unchanged"]
    will_update: bool


class UpdateBackup(StrictUpdateModel):
    required: bool
    kind: Literal["postgres_custom_format", "none"]
    state: Literal["planned", "ready", "not_required", "unavailable"]
    verified: bool = False
    description: str = Field(min_length=1, max_length=500)


class UpdateRollback(StrictUpdateModel):
    automatic: bool
    supported: bool
    # A successful preflight has only verified that rollback is planned and
    # supported.  ``ready`` is reserved for a job that has captured and verified
    # the actual backup/snapshot it would restore.
    state: Literal["planned", "ready", "unavailable", "not_required"]
    description: str = Field(min_length=1, max_length=500)


class UpdateIdentity(StrictUpdateModel):
    version: str = Field(default="unknown", max_length=80)
    commit_sha: str = Field(default="unknown", max_length=128)


class UpdateReceipt(StrictUpdateModel):
    job_id: str = Field(pattern=r"^[A-Za-z0-9-]{1,80}$")
    release_id: str = Field(pattern=r"^v[0-9]+\.[0-9]+\.[0-9]+$")
    status: UpdateJobStatus
    before: UpdateIdentity
    after: UpdateIdentity
    components: list[Literal["updater", "backend", "webui", "help_center"]] = Field(
        default_factory=list, max_length=4
    )
    backup_id: str | None = Field(default=None, max_length=160)
    rollback_performed: bool = False
    started_at: str = Field(default="", max_length=80)
    completed_at: str = Field(default="", max_length=80)


class UpdateJobError(StrictUpdateModel):
    code: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_]+$")
    message: str = Field(min_length=1, max_length=500)
    remediation: str | None = Field(default=None, max_length=500)


class UpdateJob(StrictUpdateModel):
    job_id: str = Field(pattern=r"^[A-Za-z0-9-]{1,80}$")
    release_id: str = Field(pattern=r"^v[0-9]+\.[0-9]+\.[0-9]+$")
    status: UpdateJobStatus
    stage: UpdateJobStage
    progress: int = Field(ge=0, le=100)
    message: str = Field(default="", max_length=500)
    started_at: str | None = Field(default=None, max_length=80)
    updated_at: str | None = Field(default=None, max_length=80)
    error: UpdateJobError | None = None
    rollback: UpdateRollback | None = None
    receipt: UpdateReceipt | None = None
    # A post-success rollback is a second transaction. Keep the original
    # installation receipt immutable and expose separate rollback evidence.
    rollback_receipt: UpdateReceipt | None = None


class SupervisorTerminalPage(StrictUpdateModel):
    """Bounded replay window used to reconcile terminal audit evidence."""

    jobs: list[UpdateJob] = Field(default_factory=list, max_length=64)


class UpdatePreflight(StrictUpdateModel):
    preflight_token: str = Field(min_length=16, max_length=512)
    expires_at: str = Field(min_length=1, max_length=80)
    release: UpdateRelease
    checks: list[UpdateCheck] = Field(default_factory=list, max_length=64)
    blockers: list[UpdateIssue] = Field(default_factory=list, max_length=32)
    warnings: list[UpdateIssue] = Field(default_factory=list, max_length=32)
    components: list[UpdateComponent] = Field(default_factory=list, max_length=16)
    backup: UpdateBackup
    rollback: UpdateRollback


class SupervisorIdentity(StrictUpdateModel):
    available: bool = False
    protocol_version: str | None = Field(default=None, max_length=32)
    updater_version: str | None = Field(default=None, max_length=80)
    min_protocol_version: str = SUPERVISOR_PROTOCOL_MIN

    @field_validator("protocol_version", mode="before")
    @classmethod
    def _string_protocol(cls, value: Any) -> str | None:
        return None if value is None else str(value)


class SupervisorStatus(StrictUpdateModel):
    available: bool
    protocol_version: str | None = Field(default=None, max_length=32)
    updater_version: str | None = Field(default=None, max_length=80)
    state: str = Field(default="unavailable", max_length=80)
    active_job: UpdateJob | None = None
    last_job: UpdateJob | None = None
    capabilities: dict[str, bool] = Field(default_factory=dict)
    message: str | None = Field(default=None, max_length=500)

    @field_validator("protocol_version", mode="before")
    @classmethod
    def _string_protocol(cls, value: Any) -> str | None:
        return None if value is None else str(value)


class UpdateScope(StrictUpdateModel):
    deployment_profile: Literal["standalone_compose_postgres_v1"] = (
        "standalone_compose_postgres_v1"
    )
    state_backend: str = Field(max_length=40)
    components_updated: list[str] = Field(
        default_factory=lambda: ["updater", "backend", "webui", "help_center"]
    )
    infrastructure_not_updated: list[str] = Field(
        default_factory=lambda: ["postgres", "redis"]
    )


class UpdateCapability(StrictUpdateModel):
    supported: bool
    blockers: list[UpdateIssue] = Field(default_factory=list, max_length=32)
    warnings: list[UpdateIssue] = Field(default_factory=list, max_length=32)
    scope: UpdateScope
    supervisor: SupervisorIdentity
    bootstrap_required: bool = False


class CurrentReleaseIdentity(StrictUpdateModel):
    version: str = Field(max_length=80)
    channel: Literal["stable", "testing"]
    commit_sha: str = Field(max_length=128)


ReleaseDiscoveryState = Literal[
    "not_checked",
    "current",
    "candidate_observed",
    "unavailable",
    "stale",
    "error",
]


class ObservedStableRelease(StrictUpdateModel):
    """Untrusted discovery hint safe to show before signed preflight.

    The public projection intentionally omits repository/artifact URLs, commit and
    image digests, and component coordinates.  It is not an install authority.
    """

    release_id: str = Field(pattern=r"^v[0-9]+\.[0-9]+\.[0-9]+$")
    version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    channel: Literal["stable"] = "stable"
    provenance: Literal["mutable_stable_branch_metadata"] = (
        "mutable_stable_branch_metadata"
    )
    verification: Literal["signed_supervisor_preflight_required"] = (
        "signed_supervisor_preflight_required"
    )


class UpdateReleaseDiscovery(StrictUpdateModel):
    """Truthful browser projection of the last Stable metadata observation."""

    state: ReleaseDiscoveryState
    checked_at: str | None = Field(default=None, max_length=80)
    branch: str = Field(min_length=1, max_length=128)
    observed_release: ObservedStableRelease | None = None
    issue: UpdateIssue | None = None


class UpdateStatus(StrictUpdateModel):
    capability: UpdateCapability
    current: CurrentReleaseIdentity
    release_discovery: UpdateReleaseDiscovery
    active_job: UpdateJob | None = None
    last_job: UpdateJob | None = None
    checked_at: str = Field(default_factory=iso_now)


class SupervisorUnavailable(RuntimeError):
    """The private supervisor boundary is absent or could not be validated."""


class SupervisorRejected(RuntimeError):
    """A curated supervisor rejection safe to map to the API."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = int(status_code)
        self.code = code
        self.message = message


class UpdateSupervisorClient:
    """Small HTTP-over-Unix-socket client; never accepts a network base URL."""

    def __init__(
        self,
        socket_path: str,
        *,
        timeout_seconds: float = 8.0,
        preflight_timeout_seconds: float = 180.0,
    ) -> None:
        self.socket_path = str(socket_path or "")
        self.timeout_seconds = min(30.0, max(1.0, float(timeout_seconds)))
        self.preflight_timeout_seconds = min(
            300.0, max(30.0, float(preflight_timeout_seconds))
        )

    def socket_is_available(self) -> bool:
        if not self.socket_path or not os.path.isabs(self.socket_path):
            return False
        try:
            return stat.S_ISSOCK(os.stat(self.socket_path).st_mode)
        except OSError:
            return False

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        if not self.socket_is_available():
            raise SupervisorUnavailable("update supervisor socket is unavailable")
        transport = httpx.AsyncHTTPTransport(uds=self.socket_path)
        try:
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://agentic-soc-updater",
                timeout=httpx.Timeout(timeout_seconds or self.timeout_seconds),
                follow_redirects=False,
            ) as client:
                async with client.stream(method, path, json=json_body) as response:
                    content_type = response.headers.get("content-type", "").lower()
                    if not content_type.startswith("application/json"):
                        raise SupervisorUnavailable(
                            "update supervisor returned an invalid response"
                        )
                    declared_length = response.headers.get("content-length")
                    if declared_length is not None:
                        try:
                            if int(declared_length) > MAX_SUPERVISOR_RESPONSE_BYTES:
                                raise SupervisorUnavailable(
                                    "update supervisor response exceeded the limit"
                                )
                        except ValueError as exc:
                            raise SupervisorUnavailable(
                                "update supervisor returned an invalid response"
                            ) from exc
                    chunks: list[bytes] = []
                    received = 0
                    async for chunk in response.aiter_bytes():
                        received += len(chunk)
                        if received > MAX_SUPERVISOR_RESPONSE_BYTES:
                            raise SupervisorUnavailable(
                                "update supervisor response exceeded the limit"
                            )
                        chunks.append(chunk)
                    status_code = response.status_code
                    content = b"".join(chunks)
        except (httpx.TimeoutException, httpx.RequestError, OSError) as exc:
            raise SupervisorUnavailable("update supervisor did not respond") from exc
        try:
            payload = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SupervisorUnavailable("update supervisor returned an invalid response") from exc
        if not isinstance(payload, dict):
            raise SupervisorUnavailable("update supervisor returned an invalid response")
        if not 200 <= status_code < 300:
            code = str(payload.get("code") or "supervisor_rejected")[:80]
            message = str(payload.get("message") or "The update supervisor rejected the request.")[
                :500
            ]
            raise SupervisorRejected(status_code, code, message)
        return payload

    async def status(self) -> SupervisorStatus:
        payload = await self._request("GET", "/v1/status")
        return SupervisorStatus.model_validate(payload)

    async def terminals(self, *, limit: int = 64) -> SupervisorTerminalPage:
        if not 1 <= int(limit) <= 64:
            raise ValueError("terminal replay limit must be between 1 and 64")
        payload = await self._request("GET", f"/v1/terminals?limit={int(limit)}")
        return SupervisorTerminalPage.model_validate(payload)

    async def preflight(self, payload: dict[str, Any]) -> UpdatePreflight:
        result = await self._request(
            "POST",
            "/v1/preflight",
            json_body=payload,
            timeout_seconds=self.preflight_timeout_seconds,
        )
        return UpdatePreflight.model_validate(result)

    async def start(self, payload: dict[str, Any]) -> UpdateJob:
        result = await self._request("POST", "/v1/jobs", json_body=payload)
        return UpdateJob.model_validate(result)

    async def job(self, job_id: str) -> UpdateJob:
        result = await self._request("GET", f"/v1/jobs/{job_id}")
        return UpdateJob.model_validate(result)

    async def cancel(self, job_id: str, *, idempotency_key: str) -> UpdateJob:
        result = await self._request(
            "POST",
            f"/v1/jobs/{job_id}/cancel",
            json_body={"idempotency_key": idempotency_key},
        )
        return UpdateJob.model_validate(result)

    async def rollback(self, job_id: str, *, idempotency_key: str) -> UpdateJob:
        result = await self._request(
            "POST",
            f"/v1/jobs/{job_id}/rollback",
            json_body={"idempotency_key": idempotency_key},
        )
        return UpdateJob.model_validate(result)

    async def receipt(self, job_id: str) -> UpdateReceipt:
        result = await self._request("GET", f"/v1/jobs/{job_id}/receipt")
        return UpdateReceipt.model_validate(result)
