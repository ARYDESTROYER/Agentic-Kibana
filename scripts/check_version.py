#!/usr/bin/env python3
"""Fail when release metadata drifts from the root ``VERSION`` file.

This gate intentionally uses only the Python 3.11 standard library so it can run
before backend or web dependencies are installed.
"""

from __future__ import annotations

import ast
import json
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

    mkdocs_source = (ROOT / "mkdocs.yml").read_text(encoding="utf-8")
    for marker in (
        f'product_version: "{version}"',
        f'docs_version: "{docs_version}"',
        "provider: mike",
        "default: stable",
    ):
        if marker not in mkdocs_source:
            failures.append(f"mkdocs.yml: missing documentation-version marker {marker!r}")

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
