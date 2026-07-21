#!/usr/bin/env python3
"""Fail when release metadata drifts from the root ``VERSION`` file.

This gate intentionally uses only the Python 3.11 standard library so it can run
before backend or web dependencies are installed.
"""

from __future__ import annotations

import ast
import json
import os
import re
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(
    r"^(0|[1-9]\d*)\."
    r"(0|[1-9]\d*)\."
    r"(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)


def _python_version(path: Path) -> str | None:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Constant):
            continue
        if any(
            isinstance(target, ast.Name) and target.id == "__version__"
            for target in node.targets
        ):
            return str(node.value.value)
    return None


def main() -> int:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    release_core = version.split("+", 1)[0].split("-", 1)[0]
    docs_version = ".".join(release_core.split(".")[:2])
    failures: list[str] = []
    if not SEMVER.fullmatch(version):
        failures.append(f"VERSION is not valid SemVer: {version!r}")

    backend_runtime = _python_version(ROOT / "backend/app/__init__.py")
    with (ROOT / "backend/pyproject.toml").open("rb") as fh:
        backend_package = tomllib.load(fh)["project"]["version"]
    web_package = json.loads((ROOT / "webui/package.json").read_text(encoding="utf-8"))
    web_lock = json.loads((ROOT / "webui/package-lock.json").read_text(encoding="utf-8"))
    openapi = json.loads((ROOT / "webui/openapi.json").read_text(encoding="utf-8"))

    observed = {
        "backend runtime": backend_runtime,
        "backend package": backend_package,
        "web package": web_package.get("version"),
        "web lock root": web_lock.get("version"),
        "web lock package": web_lock.get("packages", {}).get("", {}).get("version"),
        "OpenAPI info": openapi.get("info", {}).get("version"),
    }
    for label, value in observed.items():
        if value != version:
            failures.append(f"{label}: expected {version!r}, found {value!r}")

    # CI may provide a ref/channel pair to verify promotion semantics. Stable is
    # allowed only for the literal main branch or the exact canonical version tag;
    # pull requests, Testing, similarly named branches, and unknown refs are Testing.
    source_ref = os.getenv("TLSOC_SOURCE_REF", "").strip()
    configured_channel = os.getenv("TLSOC_RELEASE_CHANNEL", "").strip().lower()
    if source_ref:
        expected_channel = (
            "stable"
            if source_ref in {"refs/heads/main", f"refs/tags/v{version}"}
            else "testing"
        )
        if configured_channel not in {"testing", "stable"}:
            failures.append(
                "TLSOC_RELEASE_CHANNEL must be exactly 'testing' or 'stable' when "
                "TLSOC_SOURCE_REF is supplied"
            )
        elif configured_channel != expected_channel:
            failures.append(
                f"release channel/ref mismatch: {source_ref!r} requires "
                f"{expected_channel!r}, found {configured_channel!r}"
            )

    main_source = (ROOT / "backend/app/main.py").read_text(encoding="utf-8")
    if "version=__version__" not in main_source:
        failures.append("FastAPI application version must reference app.__version__")

    compose_expectations = {
        "deploy/docker-compose.agnostic.yml": (
            (
                f"tlsoc-agentic-triage-backend:${{TLSOC_VERSION:-{version}}}",
                f"tlsoc-agentic-triage-webui:${{TLSOC_VERSION:-{version}}}",
            ),
            2,
        ),
        "deploy/docker-compose.tlsoc.yml": (
            (f"tlsoc-agentic-triage-backend:${{TLSOC_VERSION:-{version}}}",),
            1,
        ),
    }
    for relative, (expected_tags, expected_build_arg_count) in compose_expectations.items():
        source = (ROOT / relative).read_text(encoding="utf-8")
        for expected in expected_tags:
            if expected not in source:
                failures.append(f"{relative}: missing default image tag {expected!r}")
        build_arg = f"TLSOC_VERSION: ${{TLSOC_VERSION:-{version}}}"
        actual_build_arg_count = source.count(build_arg)
        if actual_build_arg_count < expected_build_arg_count:
            failures.append(
                f"{relative}: expected {expected_build_arg_count} version build args, "
                f"found {actual_build_arg_count}"
            )
        channel_build_arg = "TLSOC_RELEASE_CHANNEL: ${TLSOC_RELEASE_CHANNEL:-testing}"
        actual_channel_count = source.count(channel_build_arg)
        if actual_channel_count < expected_build_arg_count:
            failures.append(
                f"{relative}: expected {expected_build_arg_count} release-channel "
                f"build args, found {actual_channel_count}"
            )

    for relative in ("backend/Dockerfile", "webui/Dockerfile"):
        source = (ROOT / relative).read_text(encoding="utf-8")
        for marker in (
            "ARG TLSOC_VERSION=unknown",
            "ARG TLSOC_RELEASE_CHANNEL=testing",
            'org.opencontainers.image.version="${TLSOC_VERSION}"',
            'dev.tlsoc.release.channel="${TLSOC_RELEASE_CHANNEL}"',
            'org.opencontainers.image.revision="${TLSOC_BUILD_SHA}"',
            'org.opencontainers.image.source="${TLSOC_SOURCE_URL}"',
        ):
            if marker not in source:
                failures.append(f"{relative}: missing release metadata marker {marker!r}")

    web_docker_source = (ROOT / "webui/Dockerfile").read_text(encoding="utf-8")
    for marker in (
        "ARG TLSOC_VERSION=unknown",
        "ARG TLSOC_RELEASE_CHANNEL=testing",
        "ARG TLSOC_BUILD_SHA=unknown",
        "ARG TLSOC_BUILD_DATE=unknown",
    ):
        # Web metadata is needed twice: in the Node stage for the immutable Vite
        # bundle and in the nginx stage for the OCI labels.
        count = web_docker_source.count(marker)
        if count < 2:
            failures.append(
                f"webui/Dockerfile: expected build + runtime metadata marker "
                f"{marker!r} twice, found {count}"
            )
    for marker in (
        "FROM python:3.11-alpine AS docs",
        "scripts/build_docs_bundle.py --output /artifact/docs",
        "COPY --from=docs /artifact/docs ./public/docs",
        "RUN npm run build:app",
    ):
        if marker not in web_docker_source:
            failures.append(
                f"webui/Dockerfile: missing installed documentation marker {marker!r}"
            )

    web_package_scripts = web_package.get("scripts", {})
    for script_name, marker in (
        ("predev", "docs:bundle"),
        ("build", "docs:bundle"),
        ("docs:bundle", "run_docs_bundle.py"),
        ("docs:check", "--check-only"),
    ):
        command = str(web_package_scripts.get(script_name, ""))
        if marker not in command:
            failures.append(
                f"webui/package.json: script {script_name!r} is missing {marker!r}"
            )

    nginx_source = (ROOT / "webui/nginx.conf").read_text(encoding="utf-8")
    for marker in ("location = /docs", "location ^~ /docs/", "=404"):
        if marker not in nginx_source:
            failures.append(f"webui/nginx.conf: missing documentation boundary {marker!r}")

    compose_source = (ROOT / "deploy/docker-compose.agnostic.yml").read_text(
        encoding="utf-8"
    )
    if "context: ..\n      dockerfile: webui/Dockerfile" not in compose_source:
        failures.append(
            "deploy/docker-compose.agnostic.yml: webui must use the repository-root "
            "build context so the image can compile docs/"
        )

    gitignore_source = (ROOT / ".gitignore").read_text(encoding="utf-8")
    if "/webui/public/docs/" not in gitignore_source:
        failures.append(".gitignore: generated /webui/public/docs/ must remain ignored")

    release_config_source = (ROOT / "webui/release.config.ts").read_text(encoding="utf-8")
    if "resolveBuildReleaseIdentity" not in release_config_source:
        failures.append("webui/release.config.ts: missing build identity resolver")
    for relative in ("webui/vite.config.ts", "webui/vitest.config.ts"):
        source = (ROOT / relative).read_text(encoding="utf-8")
        for marker in ("resolveBuildReleaseIdentity", "__TLSOC_RELEASE_IDENTITY__"):
            if marker not in source:
                failures.append(f"{relative}: missing browser release marker {marker!r}")

    shell_source = (ROOT / "webui/src/soc/AppShell.tsx").read_text(encoding="utf-8")
    for marker in ("ReleaseBadge", "api.buildInfo", "resolveReleasePresentation"):
        if marker not in shell_source:
            failures.append(f"webui/src/soc/AppShell.tsx: missing release marker {marker!r}")

    demo_source = (ROOT / "scripts/run-demo.sh").read_text(encoding="utf-8")
    for marker in (
        'SOURCE_BRANCH="$(git -C "${REPO_ROOT}" symbolic-ref',
        '[[ "${SOURCE_BRANCH}" == "main" ]]',
        "export TLSOC_VERSION TLSOC_RELEASE_CHANNEL TLSOC_BUILD_SHA TLSOC_BUILD_DATE",
    ):
        if marker not in demo_source:
            failures.append(f"scripts/run-demo.sh: missing release marker {marker!r}")

    mkdocs_source = (ROOT / "mkdocs.yml").read_text(encoding="utf-8")
    for marker in (
        "TLSOC_DOCS_SITE_URL",
        f'product_version: "{version}"',
        f'docs_version: "{docs_version}"',
        "provider: mike",
        "default: stable",
    ):
        if marker not in mkdocs_source:
            failures.append(f"mkdocs.yml: missing documentation-version marker {marker!r}")

    changelog_source = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    active_unreleased = re.findall(r"^## \[Unreleased\]\s*$", changelog_source, re.MULTILINE)
    if len(active_unreleased) != 1:
        failures.append(
            "CHANGELOG.md must contain exactly one active '## [Unreleased]' section; "
            f"found {len(active_unreleased)}"
        )
    if re.search(r"^## \[Unreleased-prev\]", changelog_source, re.MULTILINE):
        failures.append(
            "CHANGELOG.md contains a legacy [Unreleased-prev] section; historical "
            "unpublished work must be labelled Development snapshot"
        )

    # Release records use the machine-readable SemVer. The documentation selector
    # intentionally uses the stable major.minor line, so patch releases update the
    # same documentation version instead of multiplying nearly identical choices.
    for relative in (
        "CHANGELOG.md",
        f"docs/releases/{docs_version}.md",
    ):
        source = (ROOT / relative).read_text(encoding="utf-8")
        if version not in source:
            failures.append(f"{relative}: does not mention canonical version {version!r}")

    for relative in (
        "docs/index.md",
        "docs/releases/channels.md",
        "docs/releases/documentation-versions.md",
    ):
        source = (ROOT / relative).read_text(encoding="utf-8")
        if docs_version not in source:
            failures.append(
                f"{relative}: does not mention documentation version {docs_version!r}"
            )

    if failures:
        print("Version consistency check failed:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(f"Version metadata is consistent: app {version}; docs {docs_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
