#!/usr/bin/env python3
"""Reject Journal-only changes to Agentic SOC protected branches."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
PROTECTED_BASES = frozenset(("main", "Testing"))
JOURNAL_PATH = "Journal.md"
SHA = re.compile(r"^[0-9a-f]{40}$")


class ScopeCheckError(ValueError):
    """The event identity or protected-branch change scope is unsafe."""


@dataclass(frozen=True)
class PullRequestIdentity:
    base_ref: str
    base_sha: str
    head_ref: str
    head_sha: str


@dataclass(frozen=True)
class PushIdentity:
    branch: str
    before_sha: str
    after_sha: str


def _required_string(mapping: Mapping[str, Any], key: str, context: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ScopeCheckError(f"{context}.{key} must be a non-empty string")
    return value


def _load_event(path: Path) -> Mapping[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ScopeCheckError(f"cannot read a valid GitHub event payload at {path}: {exc}") from exc
    if not isinstance(document, dict):
        raise ScopeCheckError("GitHub event payload must be a JSON object")
    return document


def _pull_request_identity(
    event: Mapping[str, Any], environment: Mapping[str, str]
) -> PullRequestIdentity:
    pull_request = event.get("pull_request")
    if not isinstance(pull_request, dict):
        raise ScopeCheckError("pull_request event payload is missing pull_request")
    base = pull_request.get("base")
    head = pull_request.get("head")
    if not isinstance(base, dict) or not isinstance(head, dict):
        raise ScopeCheckError("pull_request event payload is missing base/head identity")

    identity = PullRequestIdentity(
        base_ref=_required_string(base, "ref", "pull_request.base"),
        base_sha=_required_string(base, "sha", "pull_request.base"),
        head_ref=_required_string(head, "ref", "pull_request.head"),
        head_sha=_required_string(head, "sha", "pull_request.head"),
    )
    for label, value in (("base", identity.base_sha), ("head", identity.head_sha)):
        if SHA.fullmatch(value) is None:
            raise ScopeCheckError(f"pull request {label} SHA is not a canonical 40-char SHA")
    if identity.base_sha == identity.head_sha:
        raise ScopeCheckError("pull request base and head SHAs must differ")

    expected_base = environment.get("GITHUB_BASE_REF")
    expected_head = environment.get("GITHUB_HEAD_REF")
    if environment.get("GITHUB_ACTIONS") == "true" and (
        not expected_base or not expected_head
    ):
        raise ScopeCheckError(
            "GitHub Actions pull_request checks require GITHUB_BASE_REF and "
            "GITHUB_HEAD_REF"
        )
    if expected_base and expected_base != identity.base_ref:
        raise ScopeCheckError("GITHUB_BASE_REF disagrees with the event payload")
    if expected_head and expected_head != identity.head_ref:
        raise ScopeCheckError("GITHUB_HEAD_REF disagrees with the event payload")
    return identity


def _push_identity(
    event: Mapping[str, Any], environment: Mapping[str, str]
) -> PushIdentity | None:
    ref = _required_string(event, "ref", "push")
    prefix = "refs/heads/"
    if not ref.startswith(prefix) or ref.removeprefix(prefix) not in PROTECTED_BASES:
        return None
    branch = ref.removeprefix(prefix)
    before_sha = _required_string(event, "before", "push")
    after_sha = _required_string(event, "after", "push")
    for label, value in (("before", before_sha), ("after", after_sha)):
        if SHA.fullmatch(value) is None or value == "0" * 40:
            raise ScopeCheckError(
                f"protected push {label} SHA is not a canonical existing commit"
            )
    if before_sha == after_sha:
        raise ScopeCheckError("protected push before and after SHAs must differ")

    expected_ref = environment.get("GITHUB_REF")
    expected_sha = environment.get("GITHUB_SHA")
    if environment.get("GITHUB_ACTIONS") == "true" and (
        not expected_ref or not expected_sha
    ):
        raise ScopeCheckError(
            "GitHub Actions push checks require GITHUB_REF and GITHUB_SHA"
        )
    if expected_ref and expected_ref != ref:
        raise ScopeCheckError("GITHUB_REF disagrees with the event payload")
    if expected_sha and expected_sha != after_sha:
        raise ScopeCheckError("GITHUB_SHA disagrees with the event payload")
    return PushIdentity(branch, before_sha, after_sha)


def _run_git(repository: Path, arguments: Sequence[str]) -> bytes:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=repository,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = ""
        if isinstance(exc, subprocess.CalledProcessError):
            detail = exc.stderr.decode("utf-8", errors="replace").strip()
        suffix = f": {detail}" if detail else ""
        raise ScopeCheckError(f"git {' '.join(arguments)} failed{suffix}") from exc
    return completed.stdout


def _changed_paths(
    repository: Path,
    base_sha: str,
    head_sha: str,
    *,
    use_merge_base: bool,
) -> tuple[str, ...]:
    for sha in (base_sha, head_sha):
        _run_git(repository, ("cat-file", "-e", f"{sha}^{{commit}}"))
        journal_kind = _run_git(
            repository,
            ("cat-file", "-t", f"{sha}:{JOURNAL_PATH}"),
        ).decode("ascii", errors="strict").strip()
        if journal_kind != "blob":
            raise ScopeCheckError(
                f"canonical {JOURNAL_PATH} is not a regular tracked file at {sha}"
            )
    comparison = f"{base_sha}...{head_sha}" if use_merge_base else f"{base_sha}..{head_sha}"
    raw = _run_git(
        repository,
        (
            "diff",
            "--name-only",
            "--no-renames",
            "--diff-filter=ACDMRTUXB",
            "-z",
            comparison,
            "--",
        ),
    )
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ScopeCheckError(
            "protected change contains a path that is not valid UTF-8"
        ) from exc

    paths: list[str] = []
    for value in decoded.split("\0"):
        if not value:
            continue
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or str(path) != value:
            raise ScopeCheckError(f"git returned a non-canonical changed path: {value!r}")
        paths.append(value)
    if not paths:
        raise ScopeCheckError("protected change has no changed paths")
    return tuple(dict.fromkeys(paths))


def check_scope(
    *,
    event_name: str,
    event_path: Path | None,
    repository: Path,
    environment: Mapping[str, str],
) -> str:
    if not event_name:
        raise ScopeCheckError("GITHUB_EVENT_NAME is missing")
    if event_name not in {"pull_request", "push"}:
        return f"event {event_name!r} is not a protected change; scope guard is not applicable"
    if event_path is None:
        raise ScopeCheckError(f"GITHUB_EVENT_PATH is missing for a {event_name} event")

    event = _load_event(event_path)
    if event_name == "pull_request":
        pull_request = _pull_request_identity(event, environment)
        if pull_request.base_ref not in PROTECTED_BASES:
            return (
                f"pull request targets unprotected branch {pull_request.base_ref!r}; "
                "scope guard is not applicable"
            )
        base_sha = pull_request.base_sha
        head_sha = pull_request.head_sha
        target = pull_request.base_ref
        description = f"pull request {pull_request.head_ref} -> {target}"
        use_merge_base = True
    else:
        push = _push_identity(event, environment)
        if push is None:
            return "push does not target main or Testing; scope guard is not applicable"
        base_sha = push.before_sha
        head_sha = push.after_sha
        target = push.branch
        description = f"push to {target}"
        use_merge_base = False
    if not repository.is_dir():
        raise ScopeCheckError(f"repository path is not a directory: {repository}")

    paths = _changed_paths(
        repository,
        base_sha,
        head_sha,
        use_merge_base=use_merge_base,
    )
    if not paths:
        raise ScopeCheckError(f"protected {description} has no changed paths")
    if set(paths) == {JOURNAL_PATH}:
        raise ScopeCheckError(
            f"Journal-only changes to {target} are forbidden: "
            "release evidence must not create a new candidate SHA"
        )
    return (
        f"protected {description} changes {len(paths)} path(s) and is not Journal-only"
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event-name", default=os.environ.get("GITHUB_EVENT_NAME", ""))
    parser.add_argument("--event-path", type=Path)
    parser.add_argument("--repository", type=Path, default=ROOT)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    event_path = args.event_path
    if event_path is None and os.environ.get("GITHUB_EVENT_PATH"):
        event_path = Path(os.environ["GITHUB_EVENT_PATH"])
    try:
        result = check_scope(
            event_name=args.event_name,
            event_path=event_path,
            repository=args.repository.resolve(),
            environment=os.environ,
        )
    except ScopeCheckError as exc:
        print(f"Protected change scope check failed: {exc}", file=sys.stderr)
        return 1
    print(f"Protected change scope check passed: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
