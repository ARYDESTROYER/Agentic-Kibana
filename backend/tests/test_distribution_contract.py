"""Offline packaging and backend-image contract smoke tests."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

from app.connectors.registry import get_registry


BACKEND = Path(__file__).resolve().parents[1]


def _requirement_names(path: Path) -> set[str]:
    names: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        name = re.split(r"[<>=!~\[]", line, maxsplit=1)[0]
        names.add(re.sub(r"[-_.]+", "-", name).lower())
    return names


def test_all_manifest_connector_clients_ship_in_full_requirement_set() -> None:
    """The default full image must import every client its registry advertises."""
    required = {
        re.sub(r"[-_.]+", "-", dep).lower()
        for manifest in get_registry().manifests()
        for dep in manifest.requires_pip
    }
    available = _requirement_names(BACKEND / "requirements.txt") | _requirement_names(
        BACKEND / "requirements-connectors.txt"
    )
    assert required <= available, f"connector clients missing from full image: {required - available}"


def test_dockerfile_is_non_root_complete_and_explicitly_tiered() -> None:
    dockerfile = (BACKEND / "Dockerfile").read_text(encoding="utf-8")
    assert "FROM python:3.11.15-slim-bookworm AS runtime-base" in dockerfile
    assert "FROM runtime-base AS core" in dockerfile
    assert "FROM runtime-base AS full" in dockerfile
    assert "COPY --chown=tlsoc:tlsoc playbooks ./playbooks" in dockerfile
    assert "requirements-connectors.txt" in dockerfile
    assert dockerfile.rstrip().endswith("USER 10001:10001")
    assert "org.opencontainers.image.source" in dockerfile
    assert "org.opencontainers.image.licenses" not in dockerfile
    assert "/api/health/ready" in dockerfile


def test_docker_context_keeps_runtime_data() -> None:
    ignored = (BACKEND / ".dockerignore").read_text(encoding="utf-8").splitlines()
    assert "*.md" not in {line.strip() for line in ignored}
    assert (BACKEND / "app/runbooks/brute_force.md").is_file()
    assert (BACKEND / "playbooks/brute_force_login.md").is_file()
    assert (BACKEND / "app/threat/mitre_techniques.json").is_file()
    assert (BACKEND / "app/llm/model_registry.json").is_file()


def test_pyproject_discovers_subpackages_dependencies_and_data() -> None:
    data = tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))
    setuptools = data["tool"]["setuptools"]
    assert setuptools["packages"]["find"]["include"] == ["app*", "playbooks"]
    assert setuptools["dynamic"]["dependencies"]["file"] == ["requirements.txt"]
    assert setuptools["dynamic"]["optional-dependencies"]["connectors"]["file"] == [
        "requirements-connectors.txt"
    ]
    assert "runbooks/*.md" in setuptools["package-data"]["app"]
    assert setuptools["package-data"]["playbooks"] == ["*.md"]


def test_built_wheel_contains_all_python_modules_and_runtime_data(tmp_path: Path) -> None:
    """Build without isolation/network and inspect the actual wheel, not config intent."""
    out = tmp_path / "dist"
    env = {**os.environ, "PIP_NO_INDEX": "1"}
    subprocess.run(
        [sys.executable, "-m", "build", "--wheel", "--no-isolation", "--outdir", str(out)],
        cwd=BACKEND,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    wheels = list(out.glob("*.whl"))
    assert len(wheels) == 1

    with zipfile.ZipFile(wheels[0]) as archive:
        names = set(archive.namelist())
        expected_modules = {
            path.relative_to(BACKEND).as_posix()
            for path in (BACKEND / "app").rglob("*.py")
            if "__pycache__" not in path.parts
        }
        assert expected_modules <= names
        assert "app/llm/model_registry.json" in names
        assert "app/threat/mitre_techniques.json" in names
        assert "app/runbooks/brute_force.md" in names
        assert "playbooks/brute_force_login.md" in names
        assert "playbooks/phishing_reported_email.md" in names
        metadata_name = next(name for name in names if name.endswith(".dist-info/METADATA"))
        metadata = archive.read(metadata_name).decode("utf-8")
        assert "Provides-Extra: connectors" in metadata
        for dependency in _requirement_names(BACKEND / "requirements-connectors.txt"):
            assert f"requires-dist: {dependency}" in metadata.lower()

        extracted = tmp_path / "wheel"
        archive.extractall(extracted)

    smoke = (
        "from pathlib import Path; "
        "import app; "
        "from app.engine.runbooks import load_runbooks; "
        "from app.playbooks.registry import PlaybookRegistry; "
        "root=Path(app.__file__).resolve().parent; "
        "assert len(load_runbooks(root / 'runbooks')) == 7; "
        "summary=PlaybookRegistry(root.parent / 'playbooks').load(); "
            "assert summary['loaded'] == 6"
    )
    subprocess.run(
        [sys.executable, "-c", smoke],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(extracted)},
        check=True,
        capture_output=True,
        text=True,
    )
