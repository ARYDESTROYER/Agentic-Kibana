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

    for relative in ("backend/Dockerfile", "webui/Dockerfile"):
        source = (ROOT / relative).read_text(encoding="utf-8")
        for marker in (
            "ARG TLSOC_VERSION=unknown",
            'org.opencontainers.image.version="${TLSOC_VERSION}"',
            'org.opencontainers.image.revision="${TLSOC_BUILD_SHA}"',
            'org.opencontainers.image.source="${TLSOC_SOURCE_URL}"',
        ):
            if marker not in source:
                failures.append(f"{relative}: missing release metadata marker {marker!r}")

    # These public pages intentionally display the active prerelease. Keep them in
    # the same mechanical drift gate as package/image metadata until the docs site
    # adopts release-time templating/versioned builds.
    for relative in (
        "CHANGELOG.md",
        "docs/index.md",
        "docs/getting-started/quickstart.md",
        "docs/sources/support-matrix.md",
        "docs/releases/channels.md",
        "docs/releases/known-limitations.md",
    ):
        source = (ROOT / relative).read_text(encoding="utf-8")
        if version not in source:
            failures.append(f"{relative}: does not mention canonical version {version!r}")

    if failures:
        print("Version consistency check failed:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(f"Version metadata is consistent: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
