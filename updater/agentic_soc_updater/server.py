"""Minimal HTTP/1.1 control server bound only to a private Unix socket."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import socketserver
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .service import ServiceError, TERMINAL_STATUSES, UpdateService


JOB_PATH = re.compile(r"^/v1/jobs/([A-Za-z0-9-]{1,80})(?:/(cancel|rollback|receipt))?$")
MAX_TERMINAL_JOBS = 64


def terminal_page(service: UpdateService, limit: int) -> dict[str, Any]:
    """Return a bounded, credential-free replay window of terminal outcomes.

    The updater's durable job ledger is the authority for completion state.  This
    projection intentionally reuses ``public_job`` so host paths, image digests,
    repository coordinates, and runtime credentials can never cross the socket.
    """
    if not 1 <= limit <= MAX_TERMINAL_JOBS:
        raise ServiceError(
            f"limit must be between 1 and {MAX_TERMINAL_JOBS}", 422
        )
    jobs = (
        service.public_job(job)
        for job in service.store.list_jobs()
        if job.get("status") in TERMINAL_STATUSES
    )
    return {"jobs": [job for job in jobs if job is not None][:limit]}


def _terminal_limit(path: str) -> int:
    parsed = urlsplit(path)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if set(query) - {"limit"} or len(query.get("limit", [])) > 1:
        raise ServiceError("terminal query accepts only one limit value", 422)
    raw = query.get("limit", [str(MAX_TERMINAL_JOBS)])[0]
    if not raw.isascii() or not raw.isdigit():
        raise ServiceError("limit must be an integer", 422)
    limit = int(raw)
    if not 1 <= limit <= MAX_TERMINAL_JOBS:
        raise ServiceError(
            f"limit must be between 1 and {MAX_TERMINAL_JOBS}", 422
        )
    return limit


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "AgenticSOCUpdater/1"
    protocol_version = "HTTP/1.1"

    @property
    def service(self) -> UpdateService:
        return self.server.service  # type: ignore[attr-defined, no-any-return]

    def log_message(self, format: str, *args: Any) -> None:
        # The caller-facing API contains bounded messages. Do not persist request
        # bodies or release URLs in an ambient access log.
        return

    def _json(self, status: int, value: Any) -> None:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    def _body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ServiceError("invalid Content-Length") from exc
        if length <= 0 or length > 64 * 1024:
            raise ServiceError("request body must be between 1 and 65536 bytes", 413)
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ServiceError("request body must be a JSON object") from exc
        if not isinstance(value, dict):
            raise ServiceError("request body must be a JSON object")
        return value

    def _dispatch(self) -> tuple[int, Any]:
        if self.command == "GET" and self.path == "/v1/status":
            return 200, self.service.status()
        if self.command == "GET" and urlsplit(self.path).path == "/v1/terminals":
            return 200, terminal_page(self.service, _terminal_limit(self.path))
        if self.command == "POST" and self.path == "/v1/preflight":
            return 200, self.service.preflight(self._body())
        if self.command == "POST" and self.path == "/v1/jobs":
            return 202, self.service.start(self._body())
        match = JOB_PATH.fullmatch(self.path)
        if match:
            job_id, action = match.groups()
            if self.command == "GET" and action is None:
                return 200, self.service.get_job(job_id)
            if self.command == "GET" and action == "receipt":
                return 200, self.service.receipt(job_id)
            if self.command == "POST" and action == "cancel":
                return 202, self.service.cancel(job_id, self._body())
            if self.command == "POST" and action == "rollback":
                return 202, self.service.request_rollback(job_id, self._body())
        raise ServiceError("route not found", 404)

    def _handle(self) -> None:
        try:
            status, value = self._dispatch()
        except ServiceError as exc:
            self._json(exc.status, {"code": "request_rejected", "message": str(exc)})
        except Exception:
            self._json(500, {"code": "supervisor_error", "message": "Updater supervisor could not complete the request"})
        else:
            self._json(status, value)

    do_GET = _handle
    do_POST = _handle


def serve(socket_path: Path, socket_gid: int, service: UpdateService) -> None:
    socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    server = UnixHTTPServer(str(socket_path), Handler)
    server.service = service  # type: ignore[attr-defined]
    os.chown(socket_path, 0, socket_gid)
    os.chmod(socket_path, 0o660)
    try:
        service.resume()
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass
