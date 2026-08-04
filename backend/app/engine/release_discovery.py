"""Bounded, read-only discovery of public upstream release metadata.

The service deliberately is *not* an updater.  It accepts a validated public
``github.com/{owner}/{repository}`` preference, derives fixed ``api.github.com``
requests itself, and returns the VERSION plus branch-head SHA for both channels
and the dereferenced annotated-tag commit for Stable. It never clones, pulls, downloads an
artifact, writes Git state, executes code, deploys, migrates, restarts, promotes or
activates a release.

Operational boundaries:

* GitHub is the only network origin and redirects are rejected.
* Each response, field and request deadline is bounded.
* Results are cached per configuration; manual refresh still has a short cooldown.
* One failed branch cannot hide a successful sibling branch.
* A transient refresh failure retains the last verified metadata and labels it stale.
* All errors are reduced to curated codes/copy; provider bodies never reach the API.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import ssl
import time
from dataclasses import dataclass
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from pydantic import BaseModel

from ..config import ReleaseUpdateConfig
from ..utils import iso_now

_API_ORIGIN = "https://api.github.com"
_REQUEST_TIMEOUT_SECONDS = 4.0
_OVERALL_REQUEST_DEADLINE_SECONDS = 5.0
_MAX_RESPONSE_BYTES = 256 * 1024
_MAX_VERSION_BYTES = 128
# One public check costs six unauthenticated GitHub API reads (VERSION + branch
# identity for two channels, plus Stable annotated-tag ref + object). A shared five-minute floor keeps manual clicks useful
# while staying below GitHub's anonymous hourly allowance for a normal single worker.
_MIN_MANUAL_REFRESH_SECONDS = 5 * 60
_MAX_CACHE_ENTRIES = 16
_VERSION_RE = re.compile(
    r"^v?(?P<version>[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$"
)
_COMMIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$")

ChannelName = Literal["stable", "testing"]
ChannelState = Literal["available", "unavailable", "disabled"]


class ReleaseChannelStatus(BaseModel):
    channel: ChannelName
    branch: str
    state: ChannelState
    version: str | None = None
    commit_sha: str | None = None
    commit_url: str | None = None
    release_commit_sha: str | None = None
    release_commit_url: str | None = None
    source_url: str | None = None
    checked_at: str | None = None
    stale: bool = False
    error_code: str | None = None
    error_message: str | None = None


class ReleaseCacheStatus(BaseModel):
    hit: bool
    stale: bool
    max_age_seconds: int


class ReleaseDiscoveryResponse(BaseModel):
    enabled: bool
    repository_url: str
    checked_at: str | None
    cache: ReleaseCacheStatus
    channels: dict[ChannelName, ReleaseChannelStatus]


class _ReleaseDiscoveryFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _NoRedirect(HTTPRedirectHandler):
    """Never follow a provider redirect away from the fixed API origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


def _trusted_tls_context() -> ssl.SSLContext:
    """Use platform trust plus httpx's installed CA bundle when available.

    The backend already depends on httpx (and therefore certifi). Loading that bundle
    keeps direct Python/macOS development consistent with the production container,
    while the stdlib trust store remains the fallback if certifi is ever absent.
    """
    context = ssl.create_default_context()
    try:
        import certifi

        context.load_verify_locations(cafile=certifi.where())
    except (ImportError, OSError):  # pragma: no cover - httpx installs certifi here
        pass
    return context


_TLS_CONTEXT = _trusted_tls_context()


def _read_json_sync(url: str) -> dict[str, Any]:
    """Fetch one small GitHub JSON document from the hard-coded API origin."""
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "api.github.com":
        raise _ReleaseDiscoveryFailure("invalid_target", "Release checks are limited to GitHub.")
    request = Request(
        url,
        method="GET",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "Agentic-SOC-release-discovery/0.1",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    opener = build_opener(_NoRedirect(), HTTPSHandler(context=_TLS_CONTEXT))
    try:
        with opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            payload = response.read(_MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        if exc.code == 404:
            raise _ReleaseDiscoveryFailure(
                "not_found", "Repository, branch, or VERSION file was not found."
            ) from exc
        if exc.code in (403, 429):
            raise _ReleaseDiscoveryFailure(
                "rate_limited", "GitHub rate limiting or access policy prevented this check."
            ) from exc
        if 300 <= exc.code < 400:
            raise _ReleaseDiscoveryFailure(
                "redirect_rejected",
                "GitHub redirected the release check; no redirect was followed.",
            ) from exc
        raise _ReleaseDiscoveryFailure(
            "github_error", "GitHub could not complete the release check."
        ) from exc
    except (TimeoutError, URLError, OSError) as exc:
        raise _ReleaseDiscoveryFailure(
            "unreachable", "GitHub could not be reached before the release check deadline."
        ) from exc
    if len(payload) > _MAX_RESPONSE_BYTES:
        raise _ReleaseDiscoveryFailure(
            "response_too_large", "GitHub returned an unexpectedly large release response."
        )
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _ReleaseDiscoveryFailure(
            "invalid_response", "GitHub returned invalid release metadata."
        ) from exc
    if not isinstance(value, dict):
        raise _ReleaseDiscoveryFailure(
            "invalid_response", "GitHub returned invalid release metadata."
        )
    return value


def _coordinates(repository_url: str) -> tuple[str, str]:
    """Extract already-validated coordinates, with defense-in-depth checks."""
    parsed = urlsplit(repository_url)
    parts = [part for part in parsed.path.split("/") if part]
    if parsed.scheme != "https" or parsed.netloc.lower() != "github.com" or len(parts) != 2:
        raise _ReleaseDiscoveryFailure(
            "invalid_config", "The configured GitHub repository is invalid."
        )
    return parts[0], parts[1]


def _disabled_channel(channel: ChannelName, branch: str) -> ReleaseChannelStatus:
    return ReleaseChannelStatus(channel=channel, branch=branch, state="disabled")


@dataclass(slots=True)
class _CacheEntry:
    fetched_monotonic: float
    response: ReleaseDiscoveryResponse


class ReleaseDiscoveryService:
    """In-process, configuration-keyed release metadata cache and fetch coordinator."""

    def __init__(self) -> None:
        self._cache: dict[tuple[str, str, str, int], _CacheEntry] = {}
        self._lock = asyncio.Lock()

    async def _fetch_json(self, url: str) -> dict[str, Any]:
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_read_json_sync, url),
                timeout=_OVERALL_REQUEST_DEADLINE_SECONDS,
            )
        except asyncio.TimeoutError as exc:
            raise _ReleaseDiscoveryFailure(
                "timeout", "GitHub did not respond before the release check deadline."
            ) from exc

    @staticmethod
    def _cache_key(config: ReleaseUpdateConfig) -> tuple[str, str, str, int]:
        return (
            config.repository_url,
            config.stable_branch,
            config.testing_branch,
            int(config.check_interval_minutes),
        )

    @staticmethod
    def _with_cache(
        response: ReleaseDiscoveryResponse, *, hit: bool, stale: bool | None = None
    ) -> ReleaseDiscoveryResponse:
        cache = response.cache.model_copy(
            update={"hit": hit, "stale": response.cache.stale if stale is None else stale}
        )
        return response.model_copy(update={"cache": cache})

    async def discover(
        self, config: ReleaseUpdateConfig, *, force: bool = False
    ) -> ReleaseDiscoveryResponse:
        """Return both branch heads, refreshing only when the cache policy permits."""
        max_age_seconds = int(config.check_interval_minutes) * 60
        if not config.enabled:
            return ReleaseDiscoveryResponse(
                enabled=False,
                repository_url=config.repository_url,
                checked_at=None,
                cache=ReleaseCacheStatus(
                    hit=False, stale=False, max_age_seconds=max_age_seconds
                ),
                channels={
                    "stable": _disabled_channel("stable", config.stable_branch),
                    "testing": _disabled_channel("testing", config.testing_branch),
                },
            )

        key = self._cache_key(config)
        threshold = _MIN_MANUAL_REFRESH_SECONDS if force else max_age_seconds
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached is not None and (now - cached.fetched_monotonic) < threshold:
            return self._with_cache(cached.response, hit=True)

        # Coalesce concurrent browser tabs / workers inside this process. Recheck after
        # acquiring the lock because another caller may have refreshed while we waited.
        async with self._lock:
            now = time.monotonic()
            cached = self._cache.get(key)
            if cached is not None and (now - cached.fetched_monotonic) < threshold:
                return self._with_cache(cached.response, hit=True)
            response = await self._refresh(config, previous=cached.response if cached else None)
            self._cache[key] = _CacheEntry(time.monotonic(), response)
            while len(self._cache) > _MAX_CACHE_ENTRIES:
                oldest = min(self._cache, key=lambda item: self._cache[item].fetched_monotonic)
                self._cache.pop(oldest, None)
            return response

    async def _refresh(
        self,
        config: ReleaseUpdateConfig,
        *,
        previous: ReleaseDiscoveryResponse | None,
    ) -> ReleaseDiscoveryResponse:
        checked_at = iso_now()
        stable, testing = await asyncio.gather(
            self._check_channel(
                config.repository_url, "stable", config.stable_branch, checked_at
            ),
            self._check_channel(
                config.repository_url, "testing", config.testing_branch, checked_at
            ),
        )
        channels: dict[ChannelName, ReleaseChannelStatus] = {
            "stable": stable,
            "testing": testing,
        }
        stale = False
        if previous is not None:
            for name in ("stable", "testing"):
                current = channels[name]
                prior = previous.channels.get(name)
                if (
                    current.state == "unavailable"
                    and prior is not None
                    and prior.state == "available"
                ):
                    channels[name] = prior.model_copy(
                        update={
                            "stale": True,
                            "error_code": current.error_code,
                            "error_message": (
                                "Latest GitHub check failed; showing the last verified metadata."
                            ),
                        }
                    )
                    stale = True
        return ReleaseDiscoveryResponse(
            enabled=True,
            repository_url=config.repository_url,
            checked_at=checked_at,
            cache=ReleaseCacheStatus(
                hit=False,
                stale=stale,
                max_age_seconds=int(config.check_interval_minutes) * 60,
            ),
            channels=channels,
        )

    async def _check_channel(
        self,
        repository_url: str,
        channel: ChannelName,
        branch: str,
        checked_at: str,
    ) -> ReleaseChannelStatus:
        try:
            owner, repository = _coordinates(repository_url)
            owner_path = quote(owner, safe="")
            repository_path = quote(repository, safe="")
            ref_path = quote(branch, safe="")
            commit_url = (
                f"{_API_ORIGIN}/repos/{owner_path}/{repository_path}/git/ref/heads/{ref_path}"
            )
            version_url = (
                f"{_API_ORIGIN}/repos/{owner_path}/{repository_path}/contents/VERSION?"
                + urlencode({"ref": branch})
            )
            fetched = await asyncio.gather(
                self._fetch_json(commit_url),
                self._fetch_json(version_url),
                return_exceptions=True,
            )
            failure = next((item for item in fetched if isinstance(item, BaseException)), None)
            if failure is not None:
                if isinstance(failure, _ReleaseDiscoveryFailure):
                    raise failure
                raise _ReleaseDiscoveryFailure(
                    "unexpected_error", "Release metadata could not be checked."
                ) from failure
            commit_doc, version_doc = fetched
            if not isinstance(commit_doc, dict) or not isinstance(version_doc, dict):
                raise _ReleaseDiscoveryFailure(
                    "invalid_response", "GitHub returned invalid release metadata."
                )
            commit_object = commit_doc.get("object")
            sha = str(commit_object.get("sha") or "") if isinstance(commit_object, dict) else ""
            if not _COMMIT_SHA_RE.fullmatch(sha):
                raise _ReleaseDiscoveryFailure(
                    "invalid_commit", "GitHub returned an invalid branch commit identity."
                )
            if version_doc.get("encoding") != "base64":
                raise _ReleaseDiscoveryFailure(
                    "invalid_version", "The upstream VERSION file is not a supported text file."
                )
            try:
                content = "".join(str(version_doc.get("content") or "").split())
                decoded = base64.b64decode(content, validate=True)
            except (ValueError, TypeError) as exc:
                raise _ReleaseDiscoveryFailure(
                    "invalid_version", "The upstream VERSION file could not be decoded."
                ) from exc
            if not decoded or len(decoded) > _MAX_VERSION_BYTES:
                raise _ReleaseDiscoveryFailure(
                    "invalid_version", "The upstream VERSION file is empty or too large."
                )
            try:
                raw_version = decoded.decode("ascii").strip()
            except UnicodeDecodeError as exc:
                raise _ReleaseDiscoveryFailure(
                    "invalid_version", "The upstream VERSION file is not ASCII text."
                ) from exc
            matched = _VERSION_RE.fullmatch(raw_version)
            if matched is None:
                raise _ReleaseDiscoveryFailure(
                    "invalid_version", "The upstream VERSION file is not a supported version."
                )
            version = matched.group("version")
            release_commit_sha: str | None = None
            release_commit_url: str | None = None
            if channel == "stable":
                tag = f"v{version}"
                tag_ref_url = (
                    f"{_API_ORIGIN}/repos/{owner_path}/{repository_path}/git/ref/tags/"
                    f"{quote(tag, safe='')}"
                )
                tag_ref = await self._fetch_json(tag_ref_url)
                tag_ref_object = tag_ref.get("object")
                if (
                    not isinstance(tag_ref_object, dict)
                    or tag_ref_object.get("type") != "tag"
                    or not re.fullmatch(
                        r"[0-9a-fA-F]{40}", str(tag_ref_object.get("sha") or "")
                    )
                ):
                    raise _ReleaseDiscoveryFailure(
                        "invalid_release_tag",
                        "Stable VERSION does not resolve through an annotated release tag.",
                    )
                tag_object_sha = str(tag_ref_object["sha"]).lower()
                tag_object_url = (
                    f"{_API_ORIGIN}/repos/{owner_path}/{repository_path}/git/tags/"
                    f"{quote(tag_object_sha, safe='')}"
                )
                tag_object = await self._fetch_json(tag_object_url)
                tagged_object = tag_object.get("object")
                tagged_sha = (
                    str(tagged_object.get("sha") or "")
                    if isinstance(tagged_object, dict)
                    else ""
                )
                if (
                    not isinstance(tagged_object, dict)
                    or tagged_object.get("type") != "commit"
                    or not re.fullmatch(r"[0-9a-fA-F]{40}", tagged_sha)
                ):
                    raise _ReleaseDiscoveryFailure(
                        "invalid_release_tag",
                        "The Stable annotated tag does not resolve to an immutable commit.",
                    )
                release_commit_sha = tagged_sha.lower()
                release_commit_url = (
                    f"https://github.com/{owner}/{repository}/commit/{release_commit_sha}"
                )
            source_ref = quote(branch, safe="/")
            return ReleaseChannelStatus(
                channel=channel,
                branch=branch,
                state="available",
                version=version,
                commit_sha=sha.lower(),
                commit_url=f"https://github.com/{owner}/{repository}/commit/{sha.lower()}",
                release_commit_sha=release_commit_sha,
                release_commit_url=release_commit_url,
                source_url=f"https://github.com/{owner}/{repository}/tree/{source_ref}",
                checked_at=checked_at,
            )
        except _ReleaseDiscoveryFailure as exc:
            return ReleaseChannelStatus(
                channel=channel,
                branch=branch,
                state="unavailable",
                checked_at=checked_at,
                error_code=exc.code,
                error_message=exc.message,
            )
        except Exception:  # noqa: BLE001 — discovery always degrades to typed unavailable
            return ReleaseChannelStatus(
                channel=channel,
                branch=branch,
                state="unavailable",
                checked_at=checked_at,
                error_code="unexpected_error",
                error_message="Release metadata could not be checked.",
            )
