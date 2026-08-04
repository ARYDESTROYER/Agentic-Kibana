"""Small durable, atomic JSON ledger used across supervisor self-handoffs."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Iterator


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class JsonStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.jobs = root / "jobs"
        self.preflights = root / "preflights"
        self.artifacts = root / "artifacts"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.jobs.mkdir(mode=0o700, exist_ok=True)
        self.preflights.mkdir(mode=0o700, exist_ok=True)
        self.artifacts.mkdir(mode=0o700, exist_ok=True)
        self.lock_path = root / "supervisor.lock"
        self.lock_path.touch(mode=0o600, exist_ok=True)

    @contextmanager
    def locked(self) -> Iterator[None]:
        with self.lock_path.open("r+") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _write(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(value, handle, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @staticmethod
    def _read(path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        if not isinstance(value, dict):
            raise RuntimeError(f"invalid updater state file: {path.name}")
        return value

    def save_job(self, job: dict[str, Any]) -> None:
        self._write(self.jobs / f"{job['job_id']}.json", job)
        self._write(self.root / "last-job.json", {"job_id": job["job_id"]})

    def load_job(self, job_id: str) -> dict[str, Any] | None:
        return self._read(self.jobs / f"{job_id}.json")

    def list_jobs(self) -> list[dict[str, Any]]:
        jobs = [value for path in self.jobs.glob("*.json") if (value := self._read(path))]
        return sorted(jobs, key=lambda item: str(item.get("updated_at", "")), reverse=True)

    def save_preflight(self, token: str, value: dict[str, Any]) -> None:
        self._write(self.preflights / f"{token}.json", value)

    def load_preflight(self, token: str) -> dict[str, Any] | None:
        return self._read(self.preflights / f"{token}.json")

    def list_preflights(self) -> list[dict[str, Any]]:
        return [
            value
            for path in self.preflights.glob("*.json")
            if (value := self._read(path))
        ]

    def idempotency(self) -> dict[str, str]:
        return self._read(self.root / "idempotency.json") or {}

    def save_idempotency(self, value: dict[str, str]) -> None:
        self._write(self.root / "idempotency.json", value)
