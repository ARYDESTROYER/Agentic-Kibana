"""Ingestion acknowledgement is coupled to successful persistence.

These tests protect the transport boundary: HTTP must return a retryable failure
and Kafka must leave its offset uncommitted when the shared ingest path raises.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.config import Preferences
from app.connectors.receivers import queues
from app.connectors.receivers.queues import KafkaReceiver
from app.engine.ingest import IngestBatchError
from app.constants import EntityType, SourceSurface
from app.models import Cluster, Entity, RawEvent


@pytest.fixture
def prefs() -> Preferences:
    return Preferences()


def _events(count: int = 5) -> list[RawEvent]:
    return [
        RawEvent(
            id=f"event-{i}",
            index="push",
            source={},
            timestamp_millis=1_700_000_000_000 + i,
            ip="203.0.113.25",
            rule="failed_login",
            rule_name="failed_login",
            severity=8.0,
        )
        for i in range(count)
    ]


@pytest.mark.asyncio
async def test_ingest_service_raises_retryable_error_on_store_failure(app_state, monkeypatch):
    async def fail_lookup(_signature: str):
        raise RuntimeError("state store unavailable")

    monkeypatch.setattr(
        app_state.ingest_service._cases, "find_open_by_signature", fail_lookup
    )

    with pytest.raises(IngestBatchError, match="retry the batch"):
        await app_state.ingest_service.ingest(_events(), app_state.prefs)


@pytest.mark.asyncio
async def test_pipeline_does_not_return_an_unpersisted_fail_to_human_case(
    app_state, monkeypatch
):
    event = _events(1)[0]
    cluster = Cluster(
        signature="persist-failure",
        entity=Entity(type=EntityType.IP, value=event.ip),
        group_by=EntityType.IP,
        rule_values=[event.rule],
        member_event_ids=[event.id],
        member_events=[event],
        first_seen_millis=event.timestamp_millis,
        last_seen_millis=event.timestamp_millis,
        count=1,
        is_alert=True,
    )

    async def fail_save(_case):
        raise RuntimeError("state store unavailable")

    monkeypatch.setattr(app_state.pipeline._cases, "save", fail_save)

    with pytest.raises(RuntimeError, match="could not persist fail-to-human"):
        await app_state.pipeline.investigate_cluster(
            cluster, SourceSurface.AUTOMATED_SCAN, app_state.prefs
        )


def test_http_ingest_returns_503_when_processing_fails(client, monkeypatch):
    created = client.post(
        "/api/sources",
        json={"id": "retry-webhook", "source_type": "webhook", "config": {}},
    )
    assert created.status_code == 200

    async def fail_ingest(*_args, **_kwargs):
        raise IngestBatchError("retry")

    monkeypatch.setattr(client.app.state.tlsoc.ingest_service, "ingest", fail_ingest)
    response = client.post(
        "/api/ingest/retry-webhook",
        json={"id": "vendor-1", "message": "alert"},
    )

    assert response.status_code == 503
    assert response.headers["retry-after"] == "1"
    assert "retry" in response.json()["detail"].lower()


class _KafkaMessage:
    def error(self):
        return None

    def value(self):
        return b'{"id":"k-1","message":"alert"}'


class _KafkaConsumer:
    instances: list["_KafkaConsumer"] = []

    def __init__(self, config):
        self.config = config
        self.commits: list[tuple[object, bool]] = []
        self._delivered = False
        self.receiver: KafkaReceiver | None = None
        self.__class__.instances.append(self)

    def subscribe(self, _topics):
        return None

    def poll(self, _timeout):
        if self._delivered:
            return None
        self._delivered = True
        return _KafkaMessage()

    def commit(self, *, message, asynchronous):
        self.commits.append((message, asynchronous))
        if self.receiver is not None:
            self.receiver._running = False

    def close(self):
        return None


@pytest.mark.asyncio
async def test_kafka_disables_auto_commit_and_commits_after_success(prefs, monkeypatch):
    _KafkaConsumer.instances.clear()
    monkeypatch.setattr(
        queues,
        "_require",
        lambda *_args: SimpleNamespace(Consumer=_KafkaConsumer),
    )
    receiver = KafkaReceiver(config={"topic": "alerts"}, connector_id="kafka-a")

    async def emit(events):
        assert len(events) == 1

    # Make the fake commit stop the otherwise continuous consumer loop.
    original_init = _KafkaConsumer.__init__

    def init_with_receiver(consumer, config):
        original_init(consumer, config)
        consumer.receiver = receiver

    monkeypatch.setattr(_KafkaConsumer, "__init__", init_with_receiver)
    await receiver.start(emit, prefs)

    consumer = _KafkaConsumer.instances[0]
    assert consumer.config["enable.auto.commit"] is False
    assert len(consumer.commits) == 1
    assert consumer.commits[0][1] is False


@pytest.mark.asyncio
async def test_kafka_does_not_commit_when_emit_fails(prefs, monkeypatch):
    _KafkaConsumer.instances.clear()
    monkeypatch.setattr(
        queues,
        "_require",
        lambda *_args: SimpleNamespace(Consumer=_KafkaConsumer),
    )
    receiver = KafkaReceiver(config={"topic": "alerts"}, connector_id="kafka-a")

    async def fail_emit(_events):
        raise IngestBatchError("not persisted")

    with pytest.raises(IngestBatchError):
        await receiver.start(fail_emit, prefs)

    consumer = _KafkaConsumer.instances[0]
    assert consumer.config["enable.auto.commit"] is False
    assert consumer.commits == []
