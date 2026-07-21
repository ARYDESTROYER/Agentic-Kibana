#!/usr/bin/env python3
"""Run the docs bundler with a reproducible local MkDocs toolchain.

Normal Console commands stay one-step commands.  We first reuse an explicitly
configured Python, the project's backend virtualenv, or the current interpreter.
If none contains the pinned docs toolchain, a local ignored ``.docs-venv`` is
created from ``docs/requirements.txt`` and reused on subsequent builds.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build_docs_bundle.py"
DOCS_VENV = ROOT / ".docs-venv"
LOCK = ROOT / ".docs-venv.lock"


def _venv_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def _has_toolchain(python: Path) -> bool:
    if not python.is_file():
        return False
    result = subprocess.run(
        [str(python), "-c", "import mkdocs, material"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def _bootstrap_toolchain() -> Path:
    DOCS_VENV.parent.mkdir(parents=True, exist_ok=True)
    lock_fd: int | None = None
    deadline = time.monotonic() + 45
    while lock_fd is None:
        try:
            lock_fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            candidate = _venv_python(DOCS_VENV)
            if _has_toolchain(candidate):
                return candidate
            if time.monotonic() >= deadline:
                raise RuntimeError("timed out waiting for the documentation toolchain")
            time.sleep(0.25)

    try:
        python = _venv_python(DOCS_VENV)
        if not python.is_file():
            subprocess.run(
                [sys.executable, "-m", "venv", str(DOCS_VENV)],
                cwd=ROOT,
                check=True,
            )
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--requirement",
                str(ROOT / "docs" / "requirements.txt"),
            ],
            cwd=ROOT,
            check=True,
        )
        if not _has_toolchain(python):
            raise RuntimeError("documentation dependencies installed but cannot be imported")
        return python
    finally:
        os.close(lock_fd)
        LOCK.unlink(missing_ok=True)


def resolve_python() -> Path:
    configured = os.environ.get("TLSOC_DOCS_PYTHON", "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if not _has_toolchain(candidate):
            raise RuntimeError(
                f"TLSOC_DOCS_PYTHON does not provide MkDocs Material: {candidate}"
            )
        return candidate

    candidates = (
        _venv_python(ROOT / "backend" / ".venv"),
        Path(sys.executable).resolve(),
    )
    for candidate in candidates:
        if _has_toolchain(candidate):
            return candidate
    return _bootstrap_toolchain()


def normalize_arguments(arguments: list[str], origin: Path) -> list[str]:
    """Resolve a relative --output against the caller, not this wrapper's cwd."""

    normalized = list(arguments)
    for index, argument in enumerate(normalized):
        if argument == "--output" and index + 1 < len(normalized):
            output = Path(normalized[index + 1]).expanduser()
            if not output.is_absolute():
                normalized[index + 1] = str((origin / output).resolve())
            break
        if argument.startswith("--output="):
            output = Path(argument.split("=", 1)[1]).expanduser()
            if not output.is_absolute():
                normalized[index] = f"--output={(origin / output).resolve()}"
            break
    return normalized


def main() -> int:
    try:
        python = resolve_python()
        arguments = normalize_arguments(sys.argv[1:], Path.cwd())
        command = [str(python), str(BUILDER), *arguments]
        return subprocess.run(command, cwd=ROOT, check=False).returncode
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"Documentation toolchain failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
