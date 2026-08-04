#!/usr/bin/env python3
"""Fail-closed structural policy for Agentic SOC GitHub Actions workflows."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_DIR = ROOT / ".github" / "workflows"
SHA_REF = re.compile(r"^[0-9a-f]{40}$")
IMAGE_REF = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
EXPECTED_WORKFLOWS = {"ci.yml", "docs.yml", "release.yml"}
SHIPPING_DOCKERFILES = (
    ROOT / "backend" / "Dockerfile",
    ROOT / "webui" / "Dockerfile",
    ROOT / "updater" / "Dockerfile",
)


class UniqueKeyLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects duplicate keys instead of keeping the last."""


def _construct_unique_mapping(
    loader: UniqueKeyLoader,
    node: yaml.nodes.MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            mark = key_node.start_mark
            raise ValueError(
                f"{mark.name}:{mark.line + 1}:{mark.column + 1}: duplicate key {key!r}"
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


def _load(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        document = yaml.load(handle, Loader=UniqueKeyLoader)
    if not isinstance(document, dict):
        raise ValueError(f"{path}: workflow root must be a mapping")
    return document


def _walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _workflow_paths() -> list[Path]:
    paths = sorted({*WORKFLOW_DIR.glob("*.yml"), *WORKFLOW_DIR.glob("*.yaml")})
    names = {path.name for path in paths}
    missing = sorted(EXPECTED_WORKFLOWS - names)
    unknown = sorted(names - EXPECTED_WORKFLOWS)
    if missing or unknown:
        raise ValueError(
            "workflow allowlist drift; "
            f"missing={missing}, unknown={unknown}. "
            "Add an explicit policy before changing the workflow surface."
        )
    return paths


def _assert_common(path: Path, workflow: dict[str, Any]) -> None:
    jobs = workflow.get("jobs")
    if not isinstance(jobs, dict) or not jobs:
        raise ValueError(f"{path}: jobs must be a non-empty mapping")
    for job_id, job in jobs.items():
        if not isinstance(job, dict):
            raise ValueError(f"{path}: job {job_id!r} must be a mapping")
        if "timeout-minutes" not in job:
            raise ValueError(f"{path}: job {job_id!r} has no timeout-minutes")

    for mapping in _walk(workflow):
        if "continue-on-error" in mapping:
            raise ValueError(f"{path}: continue-on-error is forbidden")
        uses = mapping.get("uses")
        if not isinstance(uses, str) or uses.startswith("./"):
            continue
        if "@" not in uses:
            raise ValueError(f"{path}: action reference lacks an immutable ref: {uses}")
        _action, ref = uses.rsplit("@", 1)
        if not SHA_REF.fullmatch(ref):
            raise ValueError(f"{path}: action must use a reviewed 40-char SHA: {uses}")


def _assert_ci(path: Path, workflow: dict[str, Any]) -> None:
    if workflow.get("permissions") != {"contents": "read"}:
        raise ValueError(f"{path}: CI permissions must be exactly contents: read")
    trigger = workflow.get("on", workflow.get(True))
    if not isinstance(trigger, dict) or "pull_request_target" in trigger:
        raise ValueError(f"{path}: unsafe or malformed CI trigger")
    if "pull_request" not in trigger or "push" not in trigger:
        raise ValueError(f"{path}: CI must run for pull_request and push")

    jobs = workflow["jobs"]
    container_images = jobs.get("container-images")
    if not isinstance(container_images, dict):
        raise ValueError(f"{path}: shipping-image acceptance job is missing")
    webui_smoke = next(
        (
            step
            for step in container_images.get("steps", [])
            if isinstance(step, dict)
            and step.get("name") == "Smoke the shipping Web Console health contract"
        ),
        None,
    )
    if not isinstance(webui_smoke, dict) or "matrix.component == 'webui'" not in str(
        webui_smoke.get("if", "")
    ):
        raise ValueError(f"{path}: shipping Web Console health smoke is missing or unscoped")
    webui_smoke_run = str(webui_smoke.get("run", ""))
    for marker in (
        "docker run --detach",
        "--health-interval",
        ".State.Health.Status",
        "curl --fail",
    ):
        if marker not in webui_smoke_run:
            raise ValueError(
                f"{path}: shipping Web Console health smoke lacks {marker!r}"
            )
    for job_id, job in jobs.items():
        services = job.get("services", {}) if isinstance(job, dict) else {}
        if not isinstance(services, dict):
            raise ValueError(f"{path}: job {job_id!r} services must be a mapping")
        for service_id, service in services.items():
            image_ref = service.get("image") if isinstance(service, dict) else None
            if not isinstance(image_ref, str) or not IMAGE_REF.fullmatch(image_ref):
                raise ValueError(
                    f"{path}: service {job_id}.{service_id} must use an image digest"
                )
    aggregate = jobs.get("ci")
    if not isinstance(aggregate, dict) or aggregate.get("name") != "CI passed":
        raise ValueError(f"{path}: fail-closed aggregate job 'ci' is missing")
    if "always()" not in str(aggregate.get("if", "")):
        raise ValueError(f"{path}: CI passed must run under always()")

    needs = aggregate.get("needs")
    if isinstance(needs, str):
        needs = [needs]
    if not isinstance(needs, list):
        raise ValueError(f"{path}: CI passed needs must be a list")
    required = set(jobs) - {"ci"}
    if set(needs) != required or len(needs) != len(required):
        missing = sorted(required - set(needs))
        extra = sorted(set(needs) - required)
        raise ValueError(f"{path}: CI passed dependency drift; missing={missing}, extra={extra}")

    run_text = "\n".join(
        str(step.get("run", ""))
        for step in aggregate.get("steps", [])
        if isinstance(step, dict)
    )
    for job_id in sorted(required):
        marker = f"needs.{job_id}.result"
        if marker not in run_text:
            raise ValueError(f"{path}: CI passed does not inspect {marker}")
    if '== "success"' not in run_text:
        raise ValueError(f"{path}: CI passed does not require explicit success")


def _assert_release(path: Path, workflow: dict[str, Any]) -> None:
    trigger = workflow.get("on", workflow.get(True))
    tags = ((trigger or {}).get("push") or {}).get("tags") if isinstance(trigger, dict) else None
    if tags != ["v*"]:
        raise ValueError(f"{path}: release publication must run only for v* tags")
    concurrency = workflow.get("concurrency")
    if not isinstance(concurrency, dict) or concurrency.get("cancel-in-progress") is not False:
        raise ValueError(f"{path}: Stable release publication must be non-cancellable")
    publish = (workflow.get("jobs") or {}).get("publish")
    run_text = _job_run_text(publish)
    for marker in ("workflows/ci.yml/runs", 'CI passed', 'conclusion == "success"'):
        if marker not in run_text:
            raise ValueError(f"{path}: Stable release does not prove exact tag CI: {marker}")

    steps = publish.get("steps") if isinstance(publish, dict) else None
    if not isinstance(steps, list):
        raise ValueError(f"{path}: Stable release steps are missing")

    def named_step(name: str) -> tuple[int, dict[str, Any]]:
        matches = [
            (index, step)
            for index, step in enumerate(steps)
            if isinstance(step, dict) and step.get("name") == name
        ]
        if len(matches) != 1:
            raise ValueError(
                f"{path}: Stable release requires exactly one {name!r} step"
            )
        return matches[0]

    candidate_marker = "candidate-${{ github.run_id }}-${{ github.run_attempt }}"
    build_steps = {
        "backend": "Build and publish backend by immutable digest",
        "webui": "Build and publish Web Console by immutable digest",
        "updater": "Build and publish update supervisor by immutable digest",
    }
    for component, name in build_steps.items():
        _index, step = named_step(name)
        with_config = step.get("with")
        tags = str(with_config.get("tags", "")) if isinstance(with_config, dict) else ""
        if (
            f"/{component}:{candidate_marker}" not in tags
            or "steps.release.outputs.tag" in tags
        ):
            raise ValueError(
                f"{path}: {component} must publish only a non-Stable candidate tag "
                "until every signed release artifact passes"
            )

    sign_index, _sign_step = named_step(
        "Sign new images and verify all immutable image signatures"
    )
    anonymous_index, anonymous_step = named_step(
        "Prove anonymous pullability and exact OCI release labels"
    )
    anonymous_run = str(anonymous_step.get("run", ""))
    anonymous_markers = (
        'anonymous_docker_config="$(mktemp -d)"',
        "unset DOCKER_AUTH_CONFIG REGISTRY_AUTH_FILE",
        'export DOCKER_CONFIG="${anonymous_docker_config}"',
        '[[ ! -e "${DOCKER_CONFIG}/config.json" ]]',
        "for platform in linux/amd64 linux/arm64",
        'docker pull --platform "${platform}" "${reference}"',
    )
    for marker in anonymous_markers:
        if marker not in anonymous_run:
            raise ValueError(
                f"{path}: anonymous image gate lacks isolated multi-platform pull "
                f"contract {marker!r}"
            )
    anonymous_env = anonymous_step.get("env", {})
    expected_anonymous_env = {
        "BACKEND",
        "WEBUI",
        "UPDATER",
        "EXPECTED_VERSION",
        "EXPECTED_CREATED",
    }
    if (
        not isinstance(anonymous_env, dict)
        or set(anonymous_env) != expected_anonymous_env
        or any(
            marker in anonymous_run
            for marker in ("docker login", "secrets.", "github.token")
        )
    ):
        raise ValueError(f"{path}: anonymous image gate may not receive publisher credentials")

    plan_index, _plan_step = named_step(
        "Verify the canonical upgrade plan before draft staging"
    )
    publish_index, _publish_step = named_step(
        "Stage, verify, and atomically publish the GitHub Release"
    )
    stable_index, stable_step = named_step(
        "Publish Stable convenience tags after release publication"
    )
    if stable_index <= max(sign_index, anonymous_index, plan_index, publish_index):
        raise ValueError(
            f"{path}: Stable convenience tags publish before images, anonymous pulls, "
            "the signed plan, and the GitHub Release are verified and published"
        )
    stable_run = str(stable_step.get("run", ""))
    for marker in (
        "for component in backend webui updater",
        'digest="${reference##*@}"',
        'docker buildx imagetools create --tag "${tagged}" "${reference}"',
        '[[ "${tagged_digest}" == "${digest}" ]]',
    ):
        if marker not in stable_run:
            raise ValueError(
                f"{path}: Stable convenience tags are not derived from exact plan "
                f"digests: missing {marker!r}"
            )


def _assert_docs(path: Path, workflow: dict[str, Any]) -> None:
    jobs = workflow.get("jobs") or {}
    publish = jobs.get("publish")
    if not isinstance(publish, dict):
        raise ValueError(f"{path}: documentation publication job is missing")
    if publish.get("permissions") != {"actions": "read", "contents": "write"}:
        raise ValueError(f"{path}: documentation publisher permissions drifted")
    run_text = _job_run_text(publish)
    for marker in ("workflows/ci.yml/runs", 'CI passed', 'conclusion == "success"'):
        if marker not in run_text:
            raise ValueError(f"{path}: documentation may publish before exact tag CI: {marker}")
    deploy = jobs.get("deploy")
    environment = deploy.get("environment") if isinstance(deploy, dict) else None
    if not isinstance(environment, dict) or environment.get("name") != "github-pages":
        raise ValueError(f"{path}: documentation deploy must use github-pages environment")
    if deploy.get("needs") != "publish":
        raise ValueError(f"{path}: documentation deploy must require the publisher")


def _job_run_text(job: Any) -> str:
    if not isinstance(job, dict):
        return ""
    return "\n".join(
        str(step.get("run", ""))
        for step in job.get("steps", [])
        if isinstance(step, dict)
    )


def _assert_dockerfile_bases(path: Path) -> None:
    stages: set[str] = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        match = re.match(
            r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$",
            line,
            flags=re.IGNORECASE,
        )
        if match is None:
            continue
        image_ref, stage_name = match.groups()
        if image_ref not in stages and not IMAGE_REF.fullmatch(image_ref):
            raise ValueError(
                f"{path}:{line_number}: external base image must use a reviewed digest: "
                f"{image_ref}"
            )
        if stage_name:
            stages.add(stage_name)


def main() -> int:
    paths = _workflow_paths()
    for path in paths:
        workflow = _load(path)
        _assert_common(path, workflow)
        if path.name == "ci.yml":
            _assert_ci(path, workflow)
        elif path.name == "release.yml":
            _assert_release(path, workflow)
        elif path.name == "docs.yml":
            _assert_docs(path, workflow)
    for path in SHIPPING_DOCKERFILES:
        _assert_dockerfile_bases(path)
    print(
        f"CI policy passed for {len(paths)} workflows and "
        f"{len(SHIPPING_DOCKERFILES)} shipping Dockerfiles"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, TypeError, ValueError, yaml.YAMLError) as exc:
        print(f"CI policy failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
