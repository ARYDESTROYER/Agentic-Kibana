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
DOCS_PATHS = [
    "docs/**",
    "overrides/**",
    "mkdocs.yml",
    "VERSION",
    "scripts/check_version.py",
    "scripts/check_docs.py",
    ".github/workflows/docs.yml",
]
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
    if set(trigger) != {"pull_request", "push"}:
        raise ValueError(
            f"{path}: CI must run only for pull_request and protected push events"
        )
    pull_request = trigger.get("pull_request")
    if pull_request not in (None, {}):
        raise ValueError(
            f"{path}: CI pull_request must be unfiltered; path and branch filters "
            "can bypass exact-SHA acceptance"
        )
    push = trigger.get("push")
    if push != {"branches": ["main", "Testing"], "tags": ["v*"]}:
        raise ValueError(
            f"{path}: CI push must target exactly main, Testing, and v* without "
            "path filters"
        )

    jobs = workflow["jobs"]
    repository_contracts = jobs.get("repository-contracts")
    if not isinstance(repository_contracts, dict):
        raise ValueError(f"{path}: repository-contracts job is missing")
    repository_steps = repository_contracts.get("steps")
    if not isinstance(repository_steps, list):
        raise ValueError(f"{path}: repository-contracts steps are missing")
    checkout = next(
        (
            step
            for step in repository_steps
            if isinstance(step, dict)
            and str(step.get("uses", "")).startswith("actions/checkout@")
        ),
        None,
    )
    checkout_with = checkout.get("with") if isinstance(checkout, dict) else None
    if (
        not isinstance(checkout_with, dict)
        or checkout_with.get("fetch-depth") not in (0, "0")
    ):
        raise ValueError(
            f"{path}: protected-change scope guard requires full exact commit history"
        )
    scope_step = next(
        (
            step
            for step in repository_steps
            if isinstance(step, dict)
            and step.get("name") == "Reject Journal-only protected changes"
        ),
        None,
    )
    if not isinstance(scope_step, dict) or str(scope_step.get("run", "")).strip() != (
        "python scripts/check_protected_pr_scope.py"
    ):
        raise ValueError(
            f"{path}: Journal-only protected-change anti-loop guard is missing"
        )

    workflow_shell_contracts = jobs.get("workflow-shell-contracts")
    policy_run = _job_run_text(workflow_shell_contracts)
    if "python -m unittest scripts.test_check_protected_pr_scope -v" not in policy_run:
        raise ValueError(
            f"{path}: protected-change anti-loop guard regressions are not required"
        )

    bootstrap_bash32 = jobs.get("bootstrap-bash32")
    if not isinstance(bootstrap_bash32, dict):
        raise ValueError(f"{path}: macOS Bash 3.2 bootstrap gate is missing")
    if bootstrap_bash32.get("runs-on") != "macos-14":
        raise ValueError(f"{path}: bootstrap portability gate must run on macos-14")
    bootstrap_run = _job_run_text(bootstrap_bash32)
    for marker in (
        "/bin/bash -c",
        '= "3.2"',
        "/bin/bash -n scripts/bootstrap-updater.sh",
        "python3 scripts/test_bootstrap_bash32.py",
    ):
        if marker not in bootstrap_run:
            raise ValueError(
                f"{path}: macOS Bash 3.2 bootstrap gate lacks {marker!r}"
            )
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
    identity_step = next(
        (
            step
            for step in container_images.get("steps", [])
            if isinstance(step, dict)
            and step.get("name") == "Verify image identity and runtime contract"
        ),
        None,
    )
    identity_run = str(identity_step.get("run", "")) if isinstance(identity_step, dict) else ""
    if 'docker run --rm --entrypoint python "${IMAGE}" -m pip check' not in identity_run:
        raise ValueError(
            f"{path}: shipping backend image must pass its installed dependency contract"
        )
    if 'version("wheel") == "0.45.1"' not in identity_run:
        raise ValueError(
            f"{path}: shipping backend image must retain the reviewed Wheel version"
        )
    if '.Config.User == "0:10001"' not in identity_run:
        raise ValueError(
            f"{path}: shipping updater image must inherit the backend control-socket GID"
        )
    if (
        'index("TUF_ROOT=/var/lib/agentic-soc-updater/sigstore-root")'
        not in identity_run
    ):
        raise ValueError(
            f"{path}: shipping updater image must place Sigstore trust state "
            "on the writable updater-state volume"
        )
    updater_smoke = next(
        (
            step
            for step in container_images.get("steps", [])
            if isinstance(step, dict)
            and step.get("name")
            == "Smoke updater control socket without Linux capabilities"
        ),
        None,
    )
    if not isinstance(updater_smoke, dict) or "matrix.component == 'updater'" not in str(
        updater_smoke.get("if", "")
    ):
        raise ValueError(f"{path}: updater control-socket runtime smoke is missing or unscoped")
    updater_smoke_run = str(updater_smoke.get("run", ""))
    for marker in (
        "--read-only",
        "--cap-drop ALL",
        "--security-opt no-new-privileges:true",
        "--user 10001:10001",
        "stat.S_ISSOCK(details.st_mode)",
        "details.st_uid == 0",
        "details.st_gid == 10001",
        "stat.S_IMODE(details.st_mode) == 0o660",
        "GET /v1/status HTTP/1.1",
        'test "${TUF_ROOT}" = /var/lib/agentic-soc-updater/sigstore-root',
        'test -w "${TUF_ROOT}"',
    ):
        if marker not in updater_smoke_run:
            raise ValueError(
                f"{path}: updater control-socket runtime smoke lacks {marker!r}"
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
    expected_trigger = {"push": {"branches": ["main"], "tags": ["v*"]}}
    if trigger != expected_trigger:
        raise ValueError(
            f"{path}: signed release must run only for direct main and v* pushes; "
            "it may not depend on documentation publication or manual dispatch"
        )
    concurrency = workflow.get("concurrency")
    if not isinstance(concurrency, dict) or concurrency.get("cancel-in-progress") is not False:
        raise ValueError(f"{path}: Stable release publication must be non-cancellable")

    jobs = workflow.get("jobs")
    if not isinstance(jobs, dict) or set(jobs) != {"rehearse", "publish"}:
        raise ValueError(
            f"{path}: signed release requires exactly the rehearse and publish jobs"
        )
    rehearse = jobs.get("rehearse")
    publish = jobs.get("publish")
    if not isinstance(rehearse, dict) or not isinstance(publish, dict):
        raise ValueError(f"{path}: signed release jobs are malformed")
    if rehearse.get("if") != "github.ref == 'refs/heads/main'":
        raise ValueError(f"{path}: release rehearsal must be main-only")
    if publish.get("if") != "startsWith(github.ref, 'refs/tags/v')":
        raise ValueError(f"{path}: release publication must be v* tag-only")
    if "environment" in rehearse:
        raise ValueError(
            f"{path}: branch rehearsal is evidence-only and may not enter the "
            "Stable release environment"
        )
    if publish.get("environment") != "stable-release":
        raise ValueError(
            f"{path}: tag publication must retain the protected stable-release environment"
        )

    rehearsal_run_text = _job_run_text(rehearse)
    publish_run_text = _job_run_text(publish)
    all_run_text = f"{rehearsal_run_text}\n{publish_run_text}"
    if "workflows/docs.yml/runs" in all_run_text:
        raise ValueError(
            f"{path}: Stable release may not wait on documentation publication"
        )
    if re.search(r"\bgit\s+(?:tag|push|update-ref)\b", all_run_text) or any(
        marker in all_run_text for marker in ("/git/refs", "/git/tags")
    ):
        raise ValueError(
            f"{path}: workflow may not create, move, or push Git refs/tags; "
            "maintainers create the one immutable tag after rehearsal"
        )

    for label, text, markers in (
        (
            "main rehearsal",
            rehearsal_run_text,
            (
                "workflows/ci.yml/runs",
                'CI passed',
                ".conclusion",
                "== success",
                'head_sha == $sha',
                'head_branch == "main"',
            ),
        ),
        (
            "tag publication",
            publish_run_text,
            (
                "workflows/ci.yml/runs",
                'CI passed',
                ".conclusion",
                "== success",
                'head_sha == $sha',
                'head_branch == $tag',
            ),
        ),
    ):
        for marker in markers:
            if marker not in text:
                raise ValueError(
                    f"{path}: {label} does not prove exact-SHA CI: {marker}"
                )

    steps = publish.get("steps") if isinstance(publish, dict) else None
    rehearsal_steps = rehearse.get("steps") if isinstance(rehearse, dict) else None
    if not isinstance(steps, list) or not isinstance(rehearsal_steps, list):
        raise ValueError(f"{path}: Stable release steps are missing")

    def named_job_step(
        job_steps: list[Any],
        name: str,
        phase: str,
    ) -> tuple[int, dict[str, Any]]:
        matches = [
            (index, step)
            for index, step in enumerate(job_steps)
            if isinstance(step, dict) and step.get("name") == name
        ]
        if len(matches) != 1:
            raise ValueError(
                f"{path}: {phase} requires exactly one {name!r} step"
            )
        return matches[0]

    def named_step(name: str) -> tuple[int, dict[str, Any]]:
        return named_job_step(steps, name, "Stable publication")

    def named_rehearsal_step(name: str) -> tuple[int, dict[str, Any]]:
        return named_job_step(rehearsal_steps, name, "Stable rehearsal")

    def require_typed_release_booleans(
        step_name: str,
        fields: tuple[str, ...],
    ) -> None:
        _index, step = named_step(step_name)
        step_run = str(step.get("run", ""))
        for field in fields:
            if (
                "scripts/read_release_state_boolean.py" not in step_run
                or f"--field {field}" not in step_run
            ):
                raise ValueError(
                    f"{path}: {step_name} must read {field!r} through the typed "
                    "release-state boolean parser"
                )
        unsafe = re.search(
            r"jq\s+-[^\n]*r[^\n]*['\"]\."
            r"(?:release_exists|plan_exists|bundle_exists)['\"]",
            step_run,
        )
        if unsafe is not None:
            raise ValueError(
                f"{path}: {step_name} uses jq truthiness for a release-state "
                "boolean; valid false must not abort and untyped values must fail closed"
            )

    require_typed_release_booleans(
        "Inspect and safely recover an exact draft release",
        ("release_exists", "plan_exists", "bundle_exists"),
    )
    require_typed_release_booleans(
        "Stage, verify, and atomically publish the GitHub Release",
        ("plan_exists", "bundle_exists"),
    )

    boolean_reader = ROOT / "scripts" / "read_release_state_boolean.py"
    if not boolean_reader.is_file():
        raise ValueError(f"{path}: typed release-state boolean parser is missing")
    boolean_reader_source = boolean_reader.read_text(encoding="utf-8")
    for marker in (
        'BOOLEAN_FIELDS = frozenset(("release_exists", "plan_exists", "bundle_exists"))',
        "type(document[field]) is not bool",
        'print("true" if value else "false")',
    ):
        if marker not in boolean_reader_source:
            raise ValueError(
                f"{path}: typed release-state boolean parser contract drifted: "
                f"missing {marker!r}"
            )

    candidate_index, candidate_step = named_rehearsal_step(
        "Prove exact main candidate and canonical version"
    )
    candidate_run = str(candidate_step.get("run", ""))
    for marker in (
        '[[ "${GITHUB_REF}" == refs/heads/main ]]',
        '[[ "$(git rev-parse origin/main)" == "${GITHUB_SHA}" ]]',
        'git ls-remote --exit-code origin "refs/tags/${tag}"',
        "TLSOC_RELEASE_CHANNEL=stable",
        "python3 scripts/check_version.py",
        'test -f "docs/releases/${version}.md"',
    ):
        if marker not in candidate_run:
            raise ValueError(
                f"{path}: main rehearsal candidate proof lacks {marker!r}"
            )
    rehearsal_ci_index, _ = named_rehearsal_step(
        "Require the exact main CI run and its fail-closed aggregate"
    )
    if rehearsal_ci_index <= candidate_index:
        raise ValueError(f"{path}: main rehearsal CI must follow candidate identity proof")

    candidate_marker = "candidate-${{ github.run_id }}-${{ github.run_attempt }}"
    rehearsal_builds = {
        "backend": "Rehearsal build and publish backend by immutable digest",
        "webui": "Rehearsal build and publish Web Console by immutable digest",
        "updater": "Rehearsal build and publish update supervisor by immutable digest",
    }
    rehearsal_build_indices: list[int] = []
    for component, name in rehearsal_builds.items():
        index, step = named_rehearsal_step(name)
        rehearsal_build_indices.append(index)
        if step.get("id") != component or not str(step.get("uses", "")).startswith(
            "docker/build-push-action@"
        ):
            raise ValueError(f"{path}: {component} rehearsal build action drifted")
        with_config = step.get("with")
        if not isinstance(with_config, dict):
            raise ValueError(f"{path}: {component} rehearsal build is malformed")
        tags = str(with_config.get("tags", ""))
        build_args = str(with_config.get("build-args", ""))
        if (
            with_config.get("platforms") != "linux/amd64,linux/arm64"
            or with_config.get("push") is not True
            or with_config.get("provenance") != "mode=max"
            or with_config.get("sbom") is not True
            or f"/{component}:{candidate_marker}" not in tags
            or "steps.release.outputs.tag" in tags
            or "TLSOC_RELEASE_CHANNEL=stable" not in build_args
            or "TLSOC_BUILD_SHA=${{ github.sha }}" not in build_args
            or "TLSOC_BUILD_DATE=${{ steps.candidate.outputs.image_created_at }}"
            not in build_args
        ):
            raise ValueError(
                f"{path}: {component} rehearsal must produce the exact dual-platform "
                "non-Stable candidate with immutable release labels"
            )
    rehearsal_build_actions = [
        step
        for step in rehearsal_steps
        if isinstance(step, dict)
        and str(step.get("uses", "")).startswith("docker/build-push-action@")
    ]
    if len(rehearsal_build_actions) != 3:
        raise ValueError(f"{path}: rehearsal must contain exactly three image builds")
    rehearsal_qemu = [
        step
        for step in rehearsal_steps
        if isinstance(step, dict)
        and str(step.get("uses", "")).startswith("docker/setup-qemu-action@")
    ]
    if len(rehearsal_qemu) != 1:
        raise ValueError(f"{path}: dual-platform rehearsal requires exactly one QEMU setup")

    rehearsal_images_index, rehearsal_images = named_rehearsal_step(
        "Resolve rehearsal image digests"
    )
    if rehearsal_images.get("id") != "images":
        raise ValueError(f"{path}: rehearsal digest resolver must expose id 'images'")
    rehearsal_images_run = str(rehearsal_images.get("run", ""))
    for marker in (
        "steps.backend.outputs.digest",
        "steps.webui.outputs.digest",
        "steps.updater.outputs.digest",
        "^sha256:[0-9a-f]{64}$",
        'echo "${component}=${image}"',
        'echo "${component}_digest=${digest}"',
    ):
        if marker not in str(rehearsal_images.get("env", {})) + rehearsal_images_run:
            raise ValueError(f"{path}: rehearsal digest resolver lacks {marker!r}")

    rehearsal_sign_index, rehearsal_sign = named_rehearsal_step(
        "Sign and verify rehearsal images"
    )
    rehearsal_sign_run = str(rehearsal_sign.get("run", ""))
    rehearsal_identity = (
        "https://github.com/${GITHUB_REPOSITORY}/.github/workflows/"
        "release.yml@refs/heads/main"
    )
    for marker in (
        rehearsal_identity,
        'for image in "${BACKEND}" "${WEBUI}" "${UPDATER}"',
        "cosign sign --yes",
        "cosign verify",
        "https://token.actions.githubusercontent.com",
    ):
        if marker not in rehearsal_sign_run:
            raise ValueError(f"{path}: rehearsal image signature gate lacks {marker!r}")
    if rehearsal_sign.get("env") != {
        "BACKEND": "${{ steps.images.outputs.backend }}",
        "WEBUI": "${{ steps.images.outputs.webui }}",
        "UPDATER": "${{ steps.images.outputs.updater }}",
    }:
        raise ValueError(f"{path}: rehearsal signatures must use exact resolved digests")

    def assert_anonymous_gate(
        step: dict[str, Any],
        expected_env: dict[str, str],
        phase: str,
    ) -> None:
        anonymous_run = str(step.get("run", ""))
        anonymous_markers = (
            'anonymous_docker_config="$(mktemp -d)"',
            "unset DOCKER_AUTH_CONFIG REGISTRY_AUTH_FILE",
            'export DOCKER_CONFIG="${anonymous_docker_config}"',
            '[[ ! -e "${DOCKER_CONFIG}/config.json" ]]',
            "for platform in linux/amd64 linux/arm64",
            'docker pull --platform "${platform}" "${reference}"',
            'docker image rm "${reference}"',
            'EXPECTED_PLATFORMS = {("linux", "amd64"), ("linux", "arm64")}',
            "anonymous GHCR token unavailable",
            "require_digest(raw_index, digest",
            "raw_manifest, _ = fetch(",
            "raw_config, _ = fetch(",
            "OCI label mismatch",
        )
        for marker in anonymous_markers:
            if marker not in anonymous_run:
                raise ValueError(
                    f"{path}: {phase} anonymous image gate lacks isolated "
                    f"multi-platform pull and registry proof contract {marker!r}"
                )
        pull_index = anonymous_run.index(
            'docker pull --platform "${platform}" "${reference}"'
        )
        eviction_index = anonymous_run.index('docker image rm "${reference}"')
        if eviction_index <= pull_index:
            raise ValueError(
                f"{path}: {phase} anonymous image gate must evict the exact digest "
                "reference after each platform pull"
            )
        if (
            step.get("env") != expected_env
            or any(
                marker in anonymous_run
                for marker in ("docker login", "secrets.", "github.token")
            )
        ):
            raise ValueError(
                f"{path}: {phase} anonymous image gate may not receive "
                "publisher credentials"
            )

    rehearsal_anonymous_index, rehearsal_anonymous = named_rehearsal_step(
        "Rehearsal prove anonymous pullability and exact OCI release labels"
    )
    assert_anonymous_gate(
        rehearsal_anonymous,
        {
            "BACKEND": "${{ steps.images.outputs.backend }}",
            "WEBUI": "${{ steps.images.outputs.webui }}",
            "UPDATER": "${{ steps.images.outputs.updater }}",
            "EXPECTED_VERSION": "${{ steps.candidate.outputs.version }}",
            "EXPECTED_CREATED": "${{ steps.candidate.outputs.image_created_at }}",
        },
        "rehearsal",
    )

    rehearsal_plan_index, rehearsal_plan = named_rehearsal_step(
        "Generate and sign the rehearsal upgrade plan"
    )
    rehearsal_plan_run = str(rehearsal_plan.get("run", ""))
    for marker in (
        "scripts/build_upgrade_plan.py",
        '--commit-sha "${GITHUB_SHA}"',
        '--published-at "${{ steps.candidate.outputs.image_created_at }}"',
        "--output rehearsal-plan.json",
        "cosign sign-blob --yes",
        "--bundle rehearsal-plan.sigstore.json",
        "cosign verify-blob",
        rehearsal_identity,
        "cp rehearsal-plan.json upgrade-plan.json",
        "cp rehearsal-plan.sigstore.json upgrade-plan.sigstore.json",
    ):
        if marker not in rehearsal_plan_run:
            raise ValueError(f"{path}: signed rehearsal plan lacks {marker!r}")

    rehearsal_constrained_index, rehearsal_constrained = named_rehearsal_step(
        "Rehearsal verify the signed plan inside the constrained update supervisor"
    )
    rehearsal_constrained_run = str(rehearsal_constrained.get("run", ""))
    for marker in (
        "docker run --detach",
        "--read-only",
        "--cap-drop ALL",
        "--security-opt no-new-privileges:true",
        "target=/verification,readonly",
        "cosign verify-blob",
        'identity="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/release.yml@refs/heads/main"',
    ):
        if marker not in rehearsal_constrained_run:
            raise ValueError(
                f"{path}: constrained rehearsal updater evidence lacks {marker!r}"
            )
    if rehearsal_constrained.get("env") != {
        "UPDATER": "${{ steps.images.outputs.updater }}"
    } or rehearsal_constrained.get("continue-on-error") or "if" in rehearsal_constrained:
        raise ValueError(
            f"{path}: constrained rehearsal updater must be an unconditional "
            "exact-digest gate"
        )

    rehearsal_upload_index, rehearsal_upload = named_rehearsal_step(
        "Upload exact-SHA signed rehearsal plan"
    )
    upload_with = rehearsal_upload.get("with")
    if (
        not str(rehearsal_upload.get("uses", "")).startswith("actions/upload-artifact@")
        or not isinstance(upload_with, dict)
        or upload_with.get("name")
        != "stable-release-rehearsal-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}"
        or upload_with.get("path") != "rehearsal-plan.json\nrehearsal-plan.sigstore.json\n"
        or upload_with.get("if-no-files-found") != "error"
        or upload_with.get("retention-days") != 90
    ):
        raise ValueError(
            f"{path}: exact-SHA rehearsal evidence artifact contract drifted"
        )
    if not (
        rehearsal_ci_index
        < min(rehearsal_build_indices)
        <= max(rehearsal_build_indices)
        < rehearsal_images_index
        < rehearsal_sign_index
        < rehearsal_anonymous_index
        < rehearsal_plan_index
        < rehearsal_constrained_index
        < rehearsal_upload_index
    ):
        raise ValueError(
            f"{path}: rehearsal must prove CI, build, sign, anonymously inspect, "
            "verify the signed plan, then upload evidence in order"
        )
    for forbidden in (
        "release_asset_state.py",
        "releases/assets/",
        "docker buildx imagetools create",
        "@${GITHUB_REF}",
    ):
        if forbidden in rehearsal_run_text:
            raise ValueError(
                f"{path}: evidence-only rehearsal contains publication authority "
                f"marker {forbidden!r}"
            )

    if any(
        isinstance(step, dict)
        and (
            str(step.get("uses", "")).startswith("docker/build-push-action@")
            or str(step.get("uses", "")).startswith("docker/setup-qemu-action@")
        )
        for step in steps
    ):
        raise ValueError(
            f"{path}: tag publication must reuse rehearsal digests and may not "
            "run image builds or QEMU"
        )

    tag_proof_index, tag_proof = named_step(
        "Prove immutable tag, exact main commit, and canonical version"
    )
    tag_proof_run = str(tag_proof.get("run", ""))
    for marker in (
        'git cat-file -t "refs/tags/${tag}"',
        'git rev-parse "refs/tags/${tag}^{commit}"',
        '[[ "$(git rev-parse origin/main)" == "${GITHUB_SHA}" ]]',
        "TLSOC_RELEASE_CHANNEL=stable",
        "python3 scripts/check_version.py",
    ):
        if marker not in tag_proof_run:
            raise ValueError(f"{path}: immutable tag proof lacks {marker!r}")
    tag_ci_index, _ = named_step(
        "Require the exact tag CI run and its fail-closed aggregate"
    )
    rehearsal_gate_index, rehearsal_gate = named_step(
        "Require and verify the exact-SHA main rehearsal"
    )
    if rehearsal_gate.get("id") != "rehearsal":
        raise ValueError(f"{path}: exact rehearsal gate must expose id 'rehearsal'")
    rehearsal_gate_run = str(rehearsal_gate.get("run", ""))
    rehearsal_gate_markers = (
        "actions/workflows/release.yml/runs",
        '-f event=push -f branch=main',
        'head_branch == "main" and .head_sha == $sha',
        '.name == "Rehearse signed Stable release"',
        "status == \"completed\" and .conclusion == \"success\"",
        "stable-release-rehearsal-${GITHUB_SHA}-${rehearsal_run_id}-${rehearsal_attempt}",
        "actions/runs/${rehearsal_run_id}/artifacts",
        "actions/artifacts/${artifact_id}/zip",
        '[[ "${#rehearsal_files[@]}" == 2 ]]',
        'rehearsal_files[0]}" == rehearsal-plan.json',
        'rehearsal_files[1]}" == rehearsal-plan.sigstore.json',
        rehearsal_identity,
        "cosign verify-blob",
        "from agentic_soc_updater.contract import validate_plan",
        '"commit_sha": os.environ["GITHUB_SHA"]',
        "for component in backend webui updater",
        "cosign verify",
        'echo "${component}=${image}"',
        'echo "${component}_digest=${digest}"',
        'echo "run_id=${rehearsal_run_id}"',
        'echo "run_attempt=${rehearsal_attempt}"',
    )
    for marker in rehearsal_gate_markers:
        if marker not in rehearsal_gate_run:
            raise ValueError(
                f"{path}: tag publication exact-rehearsal gate lacks {marker!r}"
            )
    if rehearsal_gate.get("env") != {
        "GH_TOKEN": "${{ github.token }}",
        "EXPECTED_VERSION": "${{ steps.release.outputs.version }}",
        "EXPECTED_TAG": "${{ steps.release.outputs.tag }}",
        "EXPECTED_IMAGE_CREATED_AT": "${{ steps.release.outputs.image_created_at }}",
    }:
        raise ValueError(f"{path}: exact rehearsal gate environment drifted")

    inspection_index, _ = named_step("Inspect and safely recover an exact draft release")
    if not tag_proof_index < tag_ci_index < rehearsal_gate_index < inspection_index:
        raise ValueError(
            f"{path}: exact tag CI and exact-SHA rehearsal verification must "
            "precede every release mutation"
        )

    _reuse_index, prior_plan = named_step("Verify and reuse an exact prior upgrade plan")
    prior_env = prior_plan.get("env")
    expected_prior_images = {
        "EXPECTED_BACKEND": "${{ steps.rehearsal.outputs.backend }}",
        "EXPECTED_BACKEND_DIGEST": "${{ steps.rehearsal.outputs.backend_digest }}",
        "EXPECTED_WEBUI": "${{ steps.rehearsal.outputs.webui }}",
        "EXPECTED_WEBUI_DIGEST": "${{ steps.rehearsal.outputs.webui_digest }}",
        "EXPECTED_UPDATER": "${{ steps.rehearsal.outputs.updater }}",
        "EXPECTED_UPDATER_DIGEST": "${{ steps.rehearsal.outputs.updater_digest }}",
    }
    if not isinstance(prior_env, dict) or any(
        prior_env.get(key) != value for key, value in expected_prior_images.items()
    ) or "actual_components != expected_components" not in str(prior_plan.get("run", "")):
        raise ValueError(
            f"{path}: recovered plans must match every exact rehearsed image"
        )

    publish_images = next(
        (
            (index, step)
            for index, step in enumerate(steps)
            if isinstance(step, dict) and step.get("id") == "images"
        ),
        None,
    )
    if publish_images is None:
        raise ValueError(f"{path}: exact rehearsed digest resolver is missing")
    images_index, images_step = publish_images
    if images_step.get("name") != "Reuse the exact rehearsed component digests" or images_step.get(
        "env"
    ) != {
        "BACKEND": "${{ steps.rehearsal.outputs.backend }}",
        "BACKEND_DIGEST": "${{ steps.rehearsal.outputs.backend_digest }}",
        "WEBUI": "${{ steps.rehearsal.outputs.webui }}",
        "WEBUI_DIGEST": "${{ steps.rehearsal.outputs.webui_digest }}",
        "UPDATER": "${{ steps.rehearsal.outputs.updater }}",
        "UPDATER_DIGEST": "${{ steps.rehearsal.outputs.updater_digest }}",
    }:
        raise ValueError(
            f"{path}: tag publication digest outputs must come only from the "
            "exact-SHA rehearsal"
        )
    publish_images_run = str(images_step.get("run", ""))
    for marker in (
        "for component in backend webui updater",
        "^sha256:[0-9a-f]{64}$",
        'echo "${component}=${image}"',
        'echo "${component}_digest=${digest}"',
    ):
        if marker not in publish_images_run:
            raise ValueError(f"{path}: rehearsed digest resolver lacks {marker!r}")

    sign_index, sign_step = named_step(
        "Add and verify tag-identity signatures on the rehearsed images"
    )
    sign_run = str(sign_step.get("run", ""))
    for marker in (
        'identity="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/release.yml@${GITHUB_REF}"',
        'for image in "${BACKEND}" "${WEBUI}" "${UPDATER}"',
        "if ! cosign verify",
        "cosign sign --yes",
        "cosign verify",
        "https://token.actions.githubusercontent.com",
    ):
        if marker not in sign_run:
            raise ValueError(f"{path}: tag-identity image signature gate lacks {marker!r}")
    if sign_step.get("env") != {
        "BACKEND": "${{ steps.images.outputs.backend }}",
        "WEBUI": "${{ steps.images.outputs.webui }}",
        "UPDATER": "${{ steps.images.outputs.updater }}",
    }:
        raise ValueError(f"{path}: tag signatures must use exact rehearsed digests")

    anonymous_index, anonymous_step = named_step(
        "Prove anonymous pullability and exact OCI release labels"
    )
    assert_anonymous_gate(
        anonymous_step,
        {
            "BACKEND": "${{ steps.images.outputs.backend }}",
            "WEBUI": "${{ steps.images.outputs.webui }}",
            "UPDATER": "${{ steps.images.outputs.updater }}",
            "EXPECTED_VERSION": "${{ steps.release.outputs.version }}",
            "EXPECTED_CREATED": "${{ steps.release.outputs.image_created_at }}",
        },
        "publication",
    )

    generate_index, generate_step = named_step(
        "Generate the declarative upgrade plan when absent"
    )
    generate_run = str(generate_step.get("run", ""))
    if generate_step.get("if") != "steps.assets.outputs.plan_exists != 'true'":
        raise ValueError(f"{path}: canonical plan generation guard drifted")
    for marker in (
        "scripts/build_upgrade_plan.py",
        '--version "${{ steps.release.outputs.version }}"',
        '--tag "${{ steps.release.outputs.tag }}"',
        '--commit-sha "${GITHUB_SHA}"',
        '--published-at "${{ steps.release.outputs.published_at }}"',
        '--updater-image "${UPDATER}"',
        '--backend-image "${BACKEND}"',
        '--webui-image "${WEBUI}"',
        "--output upgrade-plan.json",
    ):
        if marker not in generate_run:
            raise ValueError(f"{path}: canonical release plan lacks {marker!r}")

    plan_sign_index, plan_sign_step = named_step(
        "Sign the declarative upgrade plan when its draft bundle is absent"
    )
    if (
        plan_sign_step.get("if")
        != "steps.assets.outputs.bundle_exists != 'true'"
        or "cosign sign-blob --yes" not in str(plan_sign_step.get("run", ""))
        or "--bundle upgrade-plan.sigstore.json" not in str(plan_sign_step.get("run", ""))
    ):
        raise ValueError(f"{path}: canonical plan signing contract drifted")

    plan_index, plan_step = named_step(
        "Verify the canonical upgrade plan before draft staging"
    )
    plan_run = str(plan_step.get("run", ""))
    for marker in (
        "cosign verify-blob",
        "--bundle upgrade-plan.sigstore.json",
        "release.yml@${GITHUB_REF}",
        "https://token.actions.githubusercontent.com",
        "upgrade-plan.json",
    ):
        if marker not in plan_run:
            raise ValueError(f"{path}: canonical tag-identity plan gate lacks {marker!r}")
    constrained_index, constrained_step = named_step(
        "Verify the signed plan inside the constrained update supervisor"
    )
    constrained_run = str(constrained_step.get("run", ""))
    permission_prep_markers = (
        'verification_dir="$(mktemp -d)"',
        "install -m 0444 upgrade-plan.json \\\n"
        '  "${verification_dir}/upgrade-plan.json"',
        "install -m 0444 upgrade-plan.sigstore.json \\\n"
        '  "${verification_dir}/upgrade-plan.sigstore.json"',
        'chmod 0555 "${verification_dir}"',
        "docker run --detach",
    )
    cleanup_guard = 'if [[ -d "${verification_dir}" ]]; then'
    cleanup_permission_restore = 'chmod 0700 "${verification_dir}"'
    cleanup_status_capture = "release_step_status=$?"
    cleanup_trap_disable = "trap - EXIT"
    cleanup_failure_state = "verification_cleanup_status=0"
    cleanup_remaining_init = 'remaining_container=""'
    cleanup_absence_probe = "docker container ls --all"
    cleanup_exact_name_filter = '--filter "name=^/${container}$"'
    cleanup_remaining_check = 'elif [[ -n "${remaining_container}" ]]; then'
    cleanup_safe_guard = "if (( verification_cleanup_status == 0 )); then"
    cleanup_failure_promotion = (
        "if (( release_step_status == 0 && verification_cleanup_status != 0 )); then"
    )
    cleanup_status_exit = 'exit "${release_step_status}"'
    cleanup_registration = "trap cleanup EXIT"
    if constrained_step.get("env") != {
        "UPDATER": "${{ steps.images.outputs.updater }}"
    }:
        raise ValueError(
            f"{path}: constrained updater verification must use the exact "
            "resolved updater digest"
        )
    if constrained_step.get("continue-on-error") or "if" in constrained_step:
        raise ValueError(
            f"{path}: constrained updater verification must be an "
            "unconditional fail-closed release gate"
        )
    for marker in (
        "docker run --detach",
        '--name "${container}"',
        "--read-only",
        "--cap-drop ALL",
        "--security-opt no-new-privileges:true",
        "target=/run/agentic-soc-updater",
        "target=/var/lib/agentic-soc-updater",
        "target=/var/backups/agentic-soc",
        "target=/deployment/host-runtime",
        "target=/verification,readonly",
        *permission_prep_markers[:-1],
        '"${UPDATER}"',
        ".State.Health.Status",
        "docker logs \"${container}\"",
        "exit 1",
        "docker exec \\",
        '--env EXPECTED_IDENTITY="${identity}"',
        'test "${TUF_ROOT}" = /var/lib/agentic-soc-updater/sigstore-root',
        'test -w "${TUF_ROOT}"',
        "test -r /verification/upgrade-plan.json",
        "test -r /verification/upgrade-plan.sigstore.json",
        "cosign verify-blob",
        "upgrade-plan.sigstore.json",
        "upgrade-plan.json",
        "certificate-identity",
        "token.actions.githubusercontent.com",
    ):
        if marker not in constrained_run:
            raise ValueError(
                f"{path}: constrained updater signed-plan verification lacks {marker!r}"
            )
    if any(constrained_run.count(marker) != 1 for marker in permission_prep_markers):
        raise ValueError(
            f"{path}: constrained updater verification preparation must contain "
            "each least-privilege operation exactly once"
        )
    if constrained_run.count(cleanup_permission_restore) != 1:
        raise ValueError(
            f"{path}: constrained updater verification cleanup must restore "
            "the runner-owned fixture's private mode exactly once"
        )
    if constrained_run.count(cleanup_guard) != 1:
        raise ValueError(
            f"{path}: constrained updater verification cleanup must guard the "
            "runner-owned fixture exactly once"
        )
    for marker in (
        cleanup_status_capture,
        cleanup_trap_disable,
        cleanup_failure_state,
        cleanup_remaining_init,
        cleanup_absence_probe,
        cleanup_exact_name_filter,
        cleanup_remaining_check,
        cleanup_safe_guard,
        cleanup_failure_promotion,
        cleanup_status_exit,
        cleanup_registration,
    ):
        if constrained_run.count(marker) != 1:
            raise ValueError(
                f"{path}: constrained updater verification cleanup must preserve "
                f"the release result with {marker!r} exactly once"
            )
    mktemp_index = constrained_run.index(permission_prep_markers[0])
    cleanup_registration_index = constrained_run.index(cleanup_registration)
    first_install_index = constrained_run.index(permission_prep_markers[1])
    if not mktemp_index < cleanup_registration_index < first_install_index:
        raise ValueError(
            f"{path}: constrained updater verification must register cleanup "
            "immediately after creating the runner-owned fixture"
        )
    cleanup_capture_index = constrained_run.index(cleanup_status_capture)
    cleanup_disable_index = constrained_run.index(cleanup_trap_disable)
    cleanup_docker_remove_index = constrained_run.index(
        'docker rm --force "${container}"'
    )
    cleanup_remaining_init_index = constrained_run.index(cleanup_remaining_init)
    cleanup_absence_probe_index = constrained_run.index(cleanup_absence_probe)
    cleanup_remaining_check_index = constrained_run.index(cleanup_remaining_check)
    cleanup_safe_guard_index = constrained_run.index(cleanup_safe_guard)
    cleanup_volume_remove_index = constrained_run.index(
        'docker volume rm --force "${volume}"'
    )
    cleanup_guard_index = constrained_run.index(cleanup_guard)
    cleanup_restore_index = constrained_run.index(cleanup_permission_restore)
    cleanup_remove_index = constrained_run.index('rm -rf -- "${verification_dir}"')
    cleanup_promotion_index = constrained_run.index(cleanup_failure_promotion)
    cleanup_exit_index = constrained_run.index(cleanup_status_exit)
    if not (
        cleanup_capture_index
        < cleanup_disable_index
        < cleanup_docker_remove_index
        < cleanup_remaining_init_index
        < cleanup_absence_probe_index
        < cleanup_remaining_check_index
        < cleanup_safe_guard_index
        < cleanup_volume_remove_index
        < cleanup_guard_index
        < cleanup_restore_index
        < cleanup_remove_index
        < cleanup_promotion_index
        < cleanup_exit_index
    ):
        raise ValueError(
            f"{path}: constrained updater verification cleanup must preserve the "
            "original result, prove the container and bind are absent, restore "
            "private mode, remove the guarded fixture, and return the correct result"
        )
    permission_prep_indices = [
        constrained_run.index(marker) for marker in permission_prep_markers
    ]
    if permission_prep_indices != sorted(permission_prep_indices):
        raise ValueError(
            f"{path}: constrained updater verification preparation must order "
            "mktemp, exact read-only installs, chmod 0555, then docker run"
        )
    for forbidden in (
        "--entrypoint",
        "--env TUF_ROOT",
        "--env HOME",
        "/var/run/docker.sock",
        "continue-on-error",
        "cp upgrade-plan.json upgrade-plan.sigstore.json",
        "chmod 0777",
        "chmod -R",
        "chown ",
    ):
        if forbidden in constrained_run:
            raise ValueError(
                f"{path}: constrained updater signed-plan verification includes "
                f"forbidden runtime override {forbidden!r}"
            )
    publish_index, publish_step = named_step(
        "Stage, verify, and atomically publish the GitHub Release"
    )
    publish_run = str(publish_step.get("run", ""))
    for marker in (
        "scripts/release_asset_state.py",
        "gh api --method POST",
        "draft:true",
        "prerelease:false",
        'gh release upload "${tag}" upgrade-plan.json',
        'gh release upload "${tag}" upgrade-plan.sigstore.json',
        "cosign verify-blob",
        "gh api --method PATCH",
        "-F draft=false",
        '.release_state == "published"',
        ".plan_exists == true",
        ".bundle_exists == true",
    ):
        if marker not in publish_run:
            raise ValueError(f"{path}: atomic GitHub Release publication lacks {marker!r}")
    if "if" in publish_step or publish_step.get("continue-on-error"):
        raise ValueError(f"{path}: GitHub Release publication must be fail-closed")
    stable_index, stable_step = named_step(
        "Publish Stable convenience tags after release publication"
    )
    if not (
        inspection_index
        < images_index
        < sign_index
        < anonymous_index
        < generate_index
        < plan_sign_index
        < plan_index
        < constrained_index
        < publish_index
        < stable_index
    ):
        raise ValueError(
            f"{path}: tag publication must reuse digests, sign, anonymously prove, "
            "verify the canonical plan in the constrained updater, publish the "
            "GitHub Release, then add Stable convenience tags"
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
    if stable_step.get("env") != {
        "IMAGE_PREFIX": "${{ steps.release.outputs.image_prefix }}",
        "STABLE_TAG": "${{ steps.release.outputs.tag }}",
        "BACKEND": "${{ steps.images.outputs.backend }}",
        "WEBUI": "${{ steps.images.outputs.webui }}",
        "UPDATER": "${{ steps.images.outputs.updater }}",
    }:
        raise ValueError(
            f"{path}: Stable convenience tags must use exact rehearsed digests"
        )


def _assert_docs(path: Path, workflow: dict[str, Any]) -> None:
    trigger = workflow.get("on", workflow.get(True))
    expected = {
        "pull_request": {"paths": DOCS_PATHS},
        "push": {
            "branches": ["main", "Testing"],
            "tags": ["v*"],
            "paths": DOCS_PATHS,
        },
        "workflow_dispatch": None,
    }
    if trigger != expected or "Journal.md" in str(trigger):
        raise ValueError(
            f"{path}: documentation triggers must retain the exact reviewed "
            "preview/publication paths and must not turn Journal-only changes into "
            "release evidence"
        )
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

    steps = publish.get("steps")
    if not isinstance(steps, list):
        raise ValueError(f"{path}: documentation publisher steps are missing")

    def named_step(name: str) -> tuple[int, dict[str, Any]]:
        matches = [
            (index, step)
            for index, step in enumerate(steps)
            if isinstance(step, dict) and step.get("name") == name
        ]
        if len(matches) != 1:
            raise ValueError(
                f"{path}: documentation publication requires exactly one {name!r} step"
            )
        return matches[0]

    ci_index, _ci_step = named_step(
        "Require the exact tag CI run and fail-closed aggregate"
    )
    release_index, release_step = named_step(
        "Require the exact signed Stable release before documentation publication"
    )
    mutate_index, _mutate_step = named_step("Update Stable version history")
    if not ci_index < release_index < mutate_index:
        raise ValueError(
            f"{path}: Stable documentation aliases may move only after exact tag CI "
            "and signed-release publication"
        )

    release_run = str(release_step.get("run", ""))
    release_markers = (
        "actions/workflows/release.yml/runs",
        '.event == "push" and .head_sha == $sha and .head_branch == $tag',
        'if [[ "${status}" != completed ]]',
        'if [[ "${conclusion}" != success ]]',
        '"repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}"',
        ".draft == false",
        ".prerelease == false",
        "(.published_at | type == \"string\" and length > 0)",
        "(.assets | length == 2)",
        '"upgrade-plan.json"',
        '"upgrade-plan.sigstore.json"',
        'all(.assets[]; .state == "uploaded" and .size > 0)',
        "scripts/release_asset_state.py",
        '--commit-sha "${GITHUB_SHA}"',
        '--release-notes "${release_notes}"',
        '.release_state == "published"',
        ".plan_exists == true",
        ".bundle_exists == true",
        ".delete_asset_ids == []",
    )
    for marker in release_markers:
        if marker not in release_run:
            raise ValueError(
                f"{path}: documentation signed Stable release gate lacks {marker!r}"
            )

    release_env = release_step.get("env")
    if not isinstance(release_env, dict) or set(release_env) != {
        "GH_TOKEN",
        "RELEASE_TAG",
    }:
        raise ValueError(f"{path}: documentation signed-release gate environment drifted")

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


def _assert_webui_build_platforms(path: Path) -> None:
    """Keep architecture-neutral Console builds native in multi-platform releases."""

    stages: list[tuple[str | None, str | None]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(
            r"^\s*FROM\s+(?:--platform=(\S+)\s+)?\S+(?:\s+AS\s+(\S+))?\s*$",
            line,
            flags=re.IGNORECASE,
        )
        if match is not None:
            platform, stage_name = match.groups()
            stages.append((stage_name.lower() if stage_name else None, platform))

    stage_platforms = {
        stage_name: platform for stage_name, platform in stages if stage_name is not None
    }
    for stage_name in ("docs", "build"):
        if stage_platforms.get(stage_name) != "$BUILDPLATFORM":
            raise ValueError(
                f"{path}: architecture-neutral {stage_name!r} stage must use "
                "--platform=$BUILDPLATFORM so package tools never run under target "
                "architecture emulation"
            )

    if not stages or stages[-1] != (None, None):
        raise ValueError(
            f"{path}: final Web Console runtime stage must be the unnamed last stage "
            "and inherit Docker's target platform without a --platform override"
        )


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
    _assert_webui_build_platforms(ROOT / "webui" / "Dockerfile")
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
