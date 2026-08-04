"""Strict declarative release-plan and control-plane contracts.

The updater deliberately accepts data, never commands.  Every key is allow-listed,
every image is digest pinned, and the trusted repository/workflow is configured on
the host side rather than supplied by the browser.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import re
from typing import Any, Mapping
from urllib.parse import urlparse

from . import PROTOCOL_VERSION


SEMVER_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")


class ContractError(ValueError):
    """Raised when untrusted update metadata violates the fixed contract."""


def _object(value: Any, name: str, keys: set[str]) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{name} must be an object")
    actual = set(value)
    if actual != keys:
        unknown = sorted(actual - keys)
        missing = sorted(keys - actual)
        raise ContractError(f"{name} keys do not match contract; missing={missing}, unknown={unknown}")
    return value


def _text(value: Any, name: str, *, limit: int = 512) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ContractError(f"{name} must be non-empty text no longer than {limit} characters")
    if any(ord(character) < 32 for character in value):
        raise ContractError(f"{name} contains control characters")
    return value


def parse_semver(value: str) -> tuple[int, int, int]:
    match = SEMVER_RE.fullmatch(value)
    if not match:
        raise ContractError(f"invalid stable semantic version: {value!r}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def canonical_asset_urls(repository: str, version: str) -> tuple[str, str]:
    if not REPOSITORY_RE.fullmatch(repository):
        raise ContractError("trusted repository must be owner/name")
    parse_semver(version)
    base = f"https://github.com/{repository}/releases/download/v{version}"
    return f"{base}/upgrade-plan.json", f"{base}/upgrade-plan.sigstore.json"


def validate_release_request(value: Any, trusted_repository: str) -> dict[str, str]:
    release = _object(
        value,
        "release",
        {"release_id", "version", "tag", "commit_sha", "plan_url", "bundle_url", "repository"},
    )
    version = _text(release["version"], "release.version", limit=32)
    parse_semver(version)
    expected_tag = f"v{version}"
    repository = _text(release["repository"], "release.repository", limit=201)
    if repository != trusted_repository:
        raise ContractError("release repository is not trusted by this supervisor")
    expected_plan, expected_bundle = canonical_asset_urls(repository, version)
    normalized = {
        key: _text(release[key], f"release.{key}")
        for key in release
    }
    if normalized["tag"] != expected_tag:
        raise ContractError("release tag does not match version")
    if not SHA_RE.fullmatch(normalized["commit_sha"]):
        raise ContractError("release commit_sha must be a full lowercase SHA-1")
    if normalized["release_id"] != expected_tag:
        raise ContractError("release_id must be the immutable Stable tag")
    if normalized["plan_url"] != expected_plan or normalized["bundle_url"] != expected_bundle:
        raise ContractError("release assets are not the canonical GitHub Release URLs")
    return normalized


@dataclass(frozen=True)
class Component:
    name: str
    image: str
    digest: str
    labels: dict[str, str]


@dataclass(frozen=True)
class UpgradePlan:
    version: str
    tag: str
    commit_sha: str
    published_at: str
    min_version: str
    max_version_exclusive: str
    state_schema: int
    compose_sha256: str
    minimum_updater_protocol: int
    components: dict[str, Component]
    backend_timeout_seconds: int
    webui_timeout_seconds: int
    observation_seconds: int
    raw: dict[str, Any]


def validate_plan(value: Any, trusted_repository: str) -> UpgradePlan:
    root = _object(
        value,
        "plan",
        {"schema_version", "product", "release", "compatibility", "components", "rollout"},
    )
    if root["schema_version"] != 1 or root["product"] != "agentic-soc":
        raise ContractError("unsupported plan schema or product")

    release = _object(root["release"], "plan.release", {"version", "tag", "channel", "commit_sha", "published_at"})
    version = _text(release["version"], "plan.release.version", limit=32)
    parse_semver(version)
    tag = _text(release["tag"], "plan.release.tag", limit=33)
    commit_sha = _text(release["commit_sha"], "plan.release.commit_sha", limit=40)
    if tag != f"v{version}" or release["channel"] != "stable" or not SHA_RE.fullmatch(commit_sha):
        raise ContractError("release identity must be an exact Stable version tag and full commit SHA")
    published_at = _text(release["published_at"], "plan.release.published_at", limit=40)
    try:
        parsed_time = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContractError("published_at must be ISO-8601") from exc
    if parsed_time.tzinfo is None:
        raise ContractError("published_at must include a timezone")

    compatibility = _object(
        root["compatibility"],
        "plan.compatibility",
        {
            "from", "state_backends", "state_schema", "minimum_updater_protocol",
            "backup_required", "migration", "compose_sha256",
        },
    )
    version_range = _object(compatibility["from"], "plan.compatibility.from", {"min_inclusive", "max_exclusive"})
    min_version = _text(version_range["min_inclusive"], "plan.compatibility.from.min_inclusive", limit=32)
    max_version = _text(version_range["max_exclusive"], "plan.compatibility.from.max_exclusive", limit=32)
    if parse_semver(min_version) >= parse_semver(max_version):
        raise ContractError("compatibility range must be increasing")
    if compatibility["state_backends"] != ["postgres"]:
        raise ContractError("v1 updater supports only PostgreSQL-owned state")
    if not isinstance(compatibility["state_schema"], int) or compatibility["state_schema"] != 1:
        raise ContractError("unsupported state schema")
    compose_sha256 = _text(
        compatibility["compose_sha256"],
        "plan.compatibility.compose_sha256",
        limit=64,
    )
    if not re.fullmatch(r"[0-9a-f]{64}", compose_sha256):
        raise ContractError("plan compatibility must pin the canonical Compose file SHA-256")
    minimum_protocol = compatibility["minimum_updater_protocol"]
    if (
        not isinstance(minimum_protocol, int)
        or isinstance(minimum_protocol, bool)
        or minimum_protocol < 1
    ):
        raise ContractError("minimum updater protocol must be a positive integer")
    if minimum_protocol > PROTOCOL_VERSION:
        raise ContractError(
            f"signed plan requires updater protocol {minimum_protocol}; installed protocol is {PROTOCOL_VERSION}"
        )
    if compatibility["backup_required"] is not True:
        raise ContractError("v1 plans must require a backup")
    migration = _object(compatibility["migration"], "plan.compatibility.migration", {"strategy"})
    if migration["strategy"] != "none":
        raise ContractError("v1 updater does not execute database migrations")

    raw_components = _object(root["components"], "plan.components", {"updater", "backend", "webui"})
    repository_prefix = f"ghcr.io/{trusted_repository.lower()}/"
    components: dict[str, Component] = {}
    for name in ("updater", "backend", "webui"):
        item = _object(raw_components[name], f"plan.components.{name}", {"image", "digest", "labels"})
        image = _text(item["image"], f"plan.components.{name}.image", limit=512)
        digest = _text(item["digest"], f"plan.components.{name}.digest", limit=71)
        expected_prefix = f"{repository_prefix}{name}@"
        if not DIGEST_RE.fullmatch(digest) or image != f"{expected_prefix}{digest}":
            raise ContractError(f"{name} image must be the trusted GHCR repository pinned by its exact digest")
        labels = _object(
            item["labels"],
            f"plan.components.{name}.labels",
            {"org.opencontainers.image.version", "org.opencontainers.image.revision", "org.opencontainers.image.source", "dev.tlsoc.release.channel", "io.agentic-soc.state.schema"},
        )
        expected_labels = {
            "org.opencontainers.image.version": version,
            "org.opencontainers.image.revision": commit_sha,
            "org.opencontainers.image.source": f"https://github.com/{trusted_repository}",
            "dev.tlsoc.release.channel": "stable",
            "io.agentic-soc.state.schema": "1",
        }
        normalized_labels = {key: _text(labels[key], f"component label {key}") for key in labels}
        if normalized_labels != expected_labels:
            raise ContractError(f"{name} release labels do not match the signed release identity")
        components[name] = Component(name=name, image=image, digest=digest, labels=normalized_labels)

    rollout = _object(root["rollout"], "plan.rollout", {"backend_timeout_seconds", "webui_timeout_seconds", "observation_seconds"})
    bounded: dict[str, int] = {}
    for key, lower, upper in (
        ("backend_timeout_seconds", 30, 900),
        ("webui_timeout_seconds", 15, 600),
        ("observation_seconds", 5, 300),
    ):
        number = rollout[key]
        if not isinstance(number, int) or isinstance(number, bool) or not lower <= number <= upper:
            raise ContractError(f"plan.rollout.{key} must be between {lower} and {upper}")
        bounded[key] = number

    return UpgradePlan(
        version=version,
        tag=tag,
        commit_sha=commit_sha,
        published_at=published_at,
        min_version=min_version,
        max_version_exclusive=max_version,
        state_schema=1,
        compose_sha256=compose_sha256,
        minimum_updater_protocol=minimum_protocol,
        components=components,
        backend_timeout_seconds=bounded["backend_timeout_seconds"],
        webui_timeout_seconds=bounded["webui_timeout_seconds"],
        observation_seconds=bounded["observation_seconds"],
        raw=dict(root),
    )


def compatible(current_version: str, plan: UpgradePlan) -> bool:
    current = parse_semver(current_version)
    return parse_semver(plan.min_version) <= current < parse_semver(plan.max_version_exclusive)


def download_host_allowed(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname in {
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    }
