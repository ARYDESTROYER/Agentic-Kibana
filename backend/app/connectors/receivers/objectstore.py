"""Object-store and file push receivers (OBJECT_STORE ingest mode).

Cloud providers and SIEMs increasingly drop security events as objects in a
bucket: AWS Security Lake (OCSF Parquet) and CloudTrail/VPC-flow in S3, GCP
findings in GCS, Azure diagnostics in Blob. We poll the store, list objects after
a key marker, fetch + decompress (.gz) each one, parse the records and emit them.
The durable cursor is the last-processed object key (:data:`CursorKind.OBJECT_KEY`).

S3 additionally supports the common SQS-notification pattern: instead of listing,
consume an SQS queue of S3 ``ObjectCreated`` events and fetch exactly the objects
named in each notification (low-latency, no list throttling).

:class:`FileReceiver` is the stdlib path: it tails a local file or directory with
a byte offset (no dependency), which covers the on-box / mounted-volume case.

As always, every external client is imported LAZILY inside ``start()`` so the
suite passes with no optional deps installed; ``manifest()`` needs none.
"""

from __future__ import annotations

import asyncio
import gzip
import os
from typing import Any

from ...config import Preferences
from ..base import AuthField, ConnectorManifest, EmitFn
from ...constants import CursorKind, IngestMode, SourceType
from .common import PayloadReceiver
from .queues import _require


def _maybe_gunzip(key: str, data: bytes) -> bytes:
    """Transparently decompress a gzipped object (by extension or magic bytes)."""
    if key.endswith(".gz") or data[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(data)
        except OSError:
            return data
    return data


def _object_hint(key: str, configured: str | None) -> str | None:
    """Pick a parser hint from the object's extension when format is auto."""
    if configured and configured != "auto":
        return configured
    name = key.lower()
    for ext, fmt in ((".ndjson", "ndjson"), (".jsonl", "ndjson"),
                     (".json", "json"), (".cef", "cef"), (".leef", "leef")):
        if name.endswith(ext) or name.endswith(ext + ".gz"):
            return fmt
    return None


class _BaseObjectReceiver(PayloadReceiver):
    """Shared poll loop knobs for object stores. Concrete stores implement the
    list+get; this base owns the cadence and the per-object emit."""

    cursor_kind = CursorKind.OBJECT_KEY

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False
        self._marker: str = str((config or {}).get("start_after", "") or "")

    def _poll_seconds(self) -> float:
        return float(self.config.get("poll_seconds", 30) or 30)

    async def _emit_object(self, key: str, data: bytes, prefs: Preferences, emit: EmitFn) -> None:
        data = _maybe_gunzip(key, data)
        hint = _object_hint(key, self.config.get("format_hint"))
        # NB: Parquet (Security Lake) is declared but parsed lazily via pyarrow in
        # a follow-up; today we parse JSON/NDJSON/CEF/LEEF/gz objects natively.
        await self._emit_payload_with_hint(data, hint, prefs, emit)
        self._marker = key

    async def _emit_payload_with_hint(
        self, data: bytes, hint: str | None, prefs: Preferences, emit: EmitFn
    ) -> int:
        from .formats import records_from_payload
        from ...ocsf import generic_to_ocsf
        from ...models import RawEvent

        records = records_from_payload(data, hint=hint or self.default_hint)
        events: list[RawEvent] = []
        for record in records:
            if not isinstance(record, dict):
                record = {"message": str(record)}
            ev = generic_to_ocsf(record, prefs, source_type=self.source_type,
                                 connector_id=self.connector_id)
            events.append(RawEvent.from_ocsf(ev))
        if events:
            await emit(events)
        return len(events)


# --------------------------------------------------------------------------- #
# AWS S3 (+ Security Lake)
# --------------------------------------------------------------------------- #
class S3Receiver(_BaseObjectReceiver):
    """List+get S3 objects after a key marker (or consume an S3->SQS notification
    queue). Handles ``.gz`` transparently; OCSF/JSON/NDJSON/CEF/LEEF natively;
    Parquet (Security Lake) is declared (pyarrow) as a follow-up."""

    source_type = SourceType.S3

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.S3,
            display_name="AWS S3 / Security Lake",
            category="object_store",
            description=(
                "Poll an S3 bucket/prefix (cursor = last object key), or consume an "
                "S3 ObjectCreated SQS queue. Handles .gz; parses JSON/NDJSON/CEF/LEEF "
                "(OCSF Parquet from Security Lake is a declared follow-up)."
            ),
            ingest_modes=[IngestMode.OBJECT_STORE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="region", label="AWS region", type="string", required=True),
                AuthField(key="access_key_id", label="Access key id", type="string"),
                AuthField(key="secret_access_key", label="Secret access key", type="password", secret=True),
                AuthField(key="session_token", label="Session token", type="password", secret=True),
            ],
            config_fields=[
                AuthField(key="bucket", label="Bucket", type="string", required=True),
                AuthField(key="prefix", label="Key prefix", type="string", default=""),
                AuthField(key="mode", label="Discovery mode", type="select",
                          options=["list", "sqs-notification"], default="list",
                          help="'list' polls by key marker; 'sqs-notification' reads an S3 event queue."),
                AuthField(key="notification_queue_url", label="S3 notification SQS URL", type="string",
                          help="Required for mode=sqs-notification."),
                AuthField(key="start_after", label="Start after key", type="string", default=""),
                AuthField(key="poll_seconds", label="Poll interval (s)", type="number", default=30),
                AuthField(key="format_hint", label="Object format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "parquet"],
                          default="auto"),
            ],
            requires_pip=["boto3"],
        )

    def _client(self, service: str = "s3") -> Any:
        boto3 = _require("boto3", "boto3")
        kwargs: dict[str, Any] = {"region_name": self.config.get("region")}
        if self.config.get("access_key_id"):
            kwargs["aws_access_key_id"] = self.config["access_key_id"]
            kwargs["aws_secret_access_key"] = self.config.get("secret_access_key", "")
            if self.config.get("session_token"):
                kwargs["aws_session_token"] = self.config["session_token"]
        return boto3.client(service, **kwargs)

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        mode = str(self.config.get("mode", "list")).lower()
        self._running = True
        if mode == "sqs-notification":
            await self._run_sqs_notifications(emit, prefs)
        else:
            await self._run_list(emit, prefs)

    async def _run_list(self, emit: EmitFn, prefs: Preferences) -> None:
        client = self._client()
        bucket = self.config.get("bucket", "")
        prefix = self.config.get("prefix", "")
        loop = asyncio.get_running_loop()
        while self._running:
            kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
            if self._marker:
                kwargs["StartAfter"] = self._marker
            resp = await loop.run_in_executor(None, lambda: client.list_objects_v2(**kwargs))
            for obj in resp.get("Contents", []):
                if not self._running:
                    break
                key = obj["Key"]
                body = await loop.run_in_executor(
                    None, lambda k=key: client.get_object(Bucket=bucket, Key=k)["Body"].read()
                )
                await self._emit_object(key, body, prefs, emit)
            await asyncio.sleep(self._poll_seconds())

    async def _run_sqs_notifications(self, emit: EmitFn, prefs: Preferences) -> None:
        import json

        s3 = self._client("s3")
        sqs = self._client("sqs")
        queue_url = self.config.get("notification_queue_url", "")
        loop = asyncio.get_running_loop()
        while self._running:
            resp = await loop.run_in_executor(
                None,
                lambda: sqs.receive_message(
                    QueueUrl=queue_url, MaxNumberOfMessages=10, WaitTimeSeconds=20
                ),
            )
            for message in resp.get("Messages", []):
                try:
                    body = json.loads(message.get("Body", "{}"))
                    for record in body.get("Records", []):
                        s3info = record.get("s3", {})
                        bucket = s3info.get("bucket", {}).get("name", "")
                        key = s3info.get("object", {}).get("key", "")
                        if not bucket or not key:
                            continue
                        data = await loop.run_in_executor(
                            None, lambda b=bucket, k=key: s3.get_object(Bucket=b, Key=k)["Body"].read()
                        )
                        await self._emit_object(key, data, prefs, emit)
                except Exception:  # noqa: BLE001 - never let one bad notification stop the loop
                    pass
                await loop.run_in_executor(
                    None,
                    lambda r=message["ReceiptHandle"]: sqs.delete_message(
                        QueueUrl=queue_url, ReceiptHandle=r
                    ),
                )

    async def stop(self) -> None:
        self._running = False


# --------------------------------------------------------------------------- #
# Google Cloud Storage
# --------------------------------------------------------------------------- #
class GcsReceiver(_BaseObjectReceiver):
    """List+get GCS objects after a key marker (cursor = last object name)."""

    source_type = SourceType.GCS

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.GCS,
            display_name="Google Cloud Storage",
            category="object_store",
            description="Poll a GCS bucket/prefix (cursor = last object name); handles .gz; JSON/NDJSON/CEF/LEEF.",
            ingest_modes=[IngestMode.OBJECT_STORE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="credentials_json", label="Service account JSON", type="textarea",
                          secret=True, help="Service-account key JSON (or blank for ADC)."),
            ],
            config_fields=[
                AuthField(key="bucket", label="Bucket", type="string", required=True),
                AuthField(key="prefix", label="Prefix", type="string", default=""),
                AuthField(key="start_after", label="Start after name", type="string", default=""),
                AuthField(key="poll_seconds", label="Poll interval (s)", type="number", default=30),
                AuthField(key="format_hint", label="Object format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf"], default="auto"),
            ],
            requires_pip=["google-cloud-storage"],
        )

    def _client(self) -> Any:
        mod = _require("google.cloud.storage", "google-cloud-storage")
        creds_json = self.config.get("credentials_json")
        if creds_json:
            import json as _json

            info = _json.loads(creds_json) if isinstance(creds_json, str) else creds_json
            return mod.Client.from_service_account_info(info)
        return mod.Client()

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        client = self._client()
        bucket_name = self.config.get("bucket", "")
        prefix = self.config.get("prefix", "")
        loop = asyncio.get_running_loop()
        self._running = True
        bucket = await loop.run_in_executor(None, lambda: client.bucket(bucket_name))
        while self._running:
            blobs = await loop.run_in_executor(
                None,
                lambda: list(client.list_blobs(
                    bucket, prefix=prefix, start_offset=self._marker or None
                )),
            )
            for blob in blobs:
                if not self._running:
                    break
                if self._marker and blob.name <= self._marker:
                    continue
                data = await loop.run_in_executor(None, blob.download_as_bytes)
                await self._emit_object(blob.name, data, prefs, emit)
            await asyncio.sleep(self._poll_seconds())

    async def stop(self) -> None:
        self._running = False


# --------------------------------------------------------------------------- #
# Azure Blob Storage
# --------------------------------------------------------------------------- #
class AzureBlobReceiver(_BaseObjectReceiver):
    """List+get Azure Blob objects after a key marker (cursor = last blob name)."""

    source_type = SourceType.AZURE_BLOB

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.AZURE_BLOB,
            display_name="Azure Blob Storage",
            category="object_store",
            description="Poll an Azure Blob container/prefix (cursor = last blob name); handles .gz; JSON/NDJSON/CEF/LEEF.",
            ingest_modes=[IngestMode.OBJECT_STORE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="connection_string", label="Connection string", type="password",
                          secret=True, required=True),
            ],
            config_fields=[
                AuthField(key="container", label="Container", type="string", required=True),
                AuthField(key="prefix", label="Prefix", type="string", default=""),
                AuthField(key="start_after", label="Start after name", type="string", default=""),
                AuthField(key="poll_seconds", label="Poll interval (s)", type="number", default=30),
                AuthField(key="format_hint", label="Blob format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf"], default="auto"),
            ],
            requires_pip=["azure-storage-blob"],
        )

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        mod = _require("azure.storage.blob.aio", "azure-storage-blob")
        BlobServiceClient = mod.BlobServiceClient
        service = BlobServiceClient.from_connection_string(self.config.get("connection_string", ""))
        container = service.get_container_client(self.config.get("container", ""))
        prefix = self.config.get("prefix", "")
        self._running = True
        async with service:
            while self._running:
                async for blob in container.list_blobs(name_starts_with=prefix):
                    if not self._running:
                        break
                    if self._marker and blob.name <= self._marker:
                        continue
                    downloader = await container.download_blob(blob.name)
                    data = await downloader.readall()
                    await self._emit_object(blob.name, data, prefs, emit)
                await asyncio.sleep(self._poll_seconds())

    async def stop(self) -> None:
        self._running = False


# --------------------------------------------------------------------------- #
# Local file / directory tail (stdlib — no dependency)
# --------------------------------------------------------------------------- #
class FileReceiver(PayloadReceiver):
    """Tail a local file (or every file in a directory) from a byte offset.

    Pure stdlib — covers the on-box agent / mounted-volume case (e.g. a Filebeat
    target file, a /var/log path). The cursor is the byte offset per file; on
    truncation/rotation the offset resets to 0 so nothing is missed."""

    source_type = SourceType.FILE
    cursor_kind = CursorKind.OBJECT_KEY

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False
        self._offsets: dict[str, int] = {}

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.FILE,
            display_name="Local file / directory tail",
            category="file",
            description="Tail a file or directory from a byte offset (stdlib; rotation-aware). On-box/mounted logs.",
            ingest_modes=[IngestMode.OBJECT_STORE, IngestMode.PUSH_SOCKET],
            capabilities=["subscribe"],
            auth_fields=[],
            config_fields=[
                AuthField(key="path", label="File or directory path", type="string", required=True,
                          placeholder="/var/log/security/events.ndjson"),
                AuthField(key="glob", label="Filename glob (dir mode)", type="string", default="*",
                          help="When path is a directory, only files matching this glob are tailed."),
                AuthField(key="from_start", label="Read existing content first", type="bool",
                          default=False, help="False = tail new lines only; True = read the whole file first."),
                AuthField(key="poll_seconds", label="Poll interval (s)", type="number", default=2),
                AuthField(key="format_hint", label="Line format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "syslog3164",
                                   "syslog5424", "kv"],
                          default="auto"),
            ],
            requires_pip=[],  # stdlib only
        )

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        import glob as globmod

        path = self.config.get("path", "")
        pattern = self.config.get("glob", "*")
        from_start = bool(self.config.get("from_start", False))
        poll = float(self.config.get("poll_seconds", 2) or 2)
        self._running = True
        loop = asyncio.get_running_loop()

        def _files() -> list[str]:
            if os.path.isdir(path):
                return sorted(globmod.glob(os.path.join(path, pattern)))
            return [path] if os.path.exists(path) else []

        # Initialise offsets to EOF unless reading from start.
        for fpath in _files():
            self._offsets[fpath] = 0 if from_start else os.path.getsize(fpath)

        while self._running:
            for fpath in _files():
                try:
                    size = os.path.getsize(fpath)
                except OSError:
                    continue
                offset = self._offsets.get(fpath, 0 if from_start else size)
                if size < offset:  # truncated / rotated
                    offset = 0
                if size <= offset:
                    self._offsets[fpath] = size
                    continue
                chunk = await loop.run_in_executor(None, self._read_chunk, fpath, offset, size)
                self._offsets[fpath] = size
                for line in chunk.splitlines():
                    if line.strip():
                        await self._emit_payload(line, prefs, emit)
            await asyncio.sleep(poll)

    @staticmethod
    def _read_chunk(path: str, offset: int, size: int) -> str:
        with open(path, "rb") as fh:
            fh.seek(offset)
            data = fh.read(size - offset)
        return data.decode("utf-8", errors="replace")

    async def stop(self) -> None:
        self._running = False
