"""Message-broker push receivers (QUEUE ingest mode).

Each class consumes a broker with durable offsets and normalises every message
through the shared :class:`PayloadReceiver` pipeline. The hard constraint
(non-negotiable for the test suite): **every broker client library is imported
LAZILY inside ``start()``** — never at module top level — so the suite passes
with zero optional deps installed. ``manifest()`` and ``parse()`` work with
nothing extra installed; the optional dep is declared in ``requires_pip``.

If a client lib is missing when ``start()`` runs, we raise a clear
:class:`ConnectionError` carrying the exact ``pip install`` hint instead of an
opaque ``ImportError`` at import time.

Offset semantics: brokers use :data:`CursorKind.OFFSET`. We consume in a loop and
let the broker track the durable offset (consumer-group commit / message
ack/delete), which is the broker-native equivalent of the suite's durable cursor
— no skip, no dup across restarts.
"""

from __future__ import annotations

import asyncio
from typing import Any

from ...config import Preferences
from ...models import Cursor
from ..base import AuthField, ConnectorManifest, EmitFn
from ...constants import CursorKind, IngestMode, SourceType
from .common import PayloadReceiver


def _require(module: str, pip_name: str) -> Any:
    """Import an optional broker client lazily, or raise a wizard-friendly error."""
    try:
        return __import__(module, fromlist=["*"])
    except ImportError as exc:  # pragma: no cover - exercised only with the dep absent
        raise ConnectionError(
            f"{module} is required for this connector. Install it with: pip install {pip_name}"
        ) from exc


# --------------------------------------------------------------------------- #
# Kafka / Redpanda / Confluent
# --------------------------------------------------------------------------- #
class KafkaReceiver(PayloadReceiver):
    """Consume a Kafka topic (Kafka / Redpanda / Confluent Cloud).

    Durable offsets via explicit consumer-group commits *after* successful emit.
    Uses ``confluent-kafka`` (librdkafka), imported lazily."""

    source_type = SourceType.KAFKA

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False
        self._consumer: Any = None

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.KAFKA,
            display_name="Apache Kafka / Redpanda",
            category="queue",
            description="Consume security events from a Kafka topic with durable consumer-group offsets.",
            ingest_modes=[IngestMode.QUEUE],
            capabilities=["subscribe", "test"],
            docs_url="https://kafka.apache.org/documentation/#security",
            setup_help=(
                "## Connect Apache Kafka / Redpanda\n"
                "1. **Bootstrap servers** — comma-separated `host:port` brokers.\n"
                "2. **Security** — pick the protocol (`SASL_SSL` for most managed "
                "clusters) and SASL mechanism; set the SASL username/password (the "
                "password goes in the secret tier).\n"
                "3. **Topic + consumer group** — the topic to consume and a stable "
                "group id. Offsets commit after successful processing; validate "
                "rebalance/retry behaviour for your deployment (no exactly-once claim).\n"
                "4. **Offset reset** — `latest` (only new events) or `earliest` "
                "(backfill the topic) on first connect.\n"
                "_Requires the `confluent-kafka` client to be installed on the backend._"
            ),
            auth_fields=[
                AuthField(key="bootstrap_servers", label="Bootstrap servers", type="string",
                          required=True, placeholder="broker1:9092,broker2:9092",
                          help="Comma-separated Kafka broker host:port list.",
                          help_link="https://kafka.apache.org/documentation/#producerconfigs_bootstrap.servers"),
                AuthField(key="security_protocol", label="Security protocol", type="select",
                          options=["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"],
                          default="PLAINTEXT"),
                AuthField(key="sasl_mechanism", label="SASL mechanism", type="select",
                          options=["", "PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"], default=""),
                AuthField(key="sasl_username", label="SASL username", type="string"),
                AuthField(key="sasl_password", label="SASL password", type="password", secret=True),
            ],
            config_fields=[
                AuthField(key="topic", label="Topic", type="string", required=True),
                AuthField(key="group_id", label="Consumer group", type="string",
                          default="tlsoc-agentic-triage"),
                AuthField(key="auto_offset_reset", label="Offset reset", type="select",
                          options=["latest", "earliest"], default="latest",
                          help="Where to start when the group has no committed offset."),
                AuthField(key="format_hint", label="Message format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                          default="auto"),
            ],
            requires_pip=["confluent-kafka"],
        )

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        ck = _require("confluent_kafka", "confluent-kafka")
        conf: dict[str, Any] = {
            "bootstrap.servers": self.config.get("bootstrap_servers", ""),
            "group.id": self.config.get("group_id", "tlsoc-agentic-triage"),
            "auto.offset.reset": self.config.get("auto_offset_reset", "latest"),
            # Never advance the durable cursor before the shared ingest path has
            # persisted its case/candidate effects. A raised IngestBatchError leaves
            # this message uncommitted for broker redelivery.
            "enable.auto.commit": False,
            "security.protocol": self.config.get("security_protocol", "PLAINTEXT"),
        }
        if self.config.get("sasl_mechanism"):
            conf["sasl.mechanism"] = self.config["sasl_mechanism"]
            conf["sasl.username"] = self.config.get("sasl_username", "")
            conf["sasl.password"] = self.config.get("sasl_password", "")
        self._consumer = ck.Consumer(conf)
        self._consumer.subscribe([self.config.get("topic", "")])
        self._running = True
        loop = asyncio.get_running_loop()
        while self._running:
            # confluent-kafka's poll is blocking; run it off the event loop.
            msg = await loop.run_in_executor(None, self._consumer.poll, 1.0)
            if msg is None:
                continue
            if msg.error():
                continue
            value = msg.value()
            if value is None:
                continue
            await self._emit_payload(value, prefs, emit)
            await loop.run_in_executor(
                None,
                lambda m=msg: self._consumer.commit(message=m, asynchronous=False),
            )

    async def stop(self) -> None:
        self._running = False
        if self._consumer is not None:
            try:
                self._consumer.close()
            except Exception:  # noqa: BLE001
                pass
            self._consumer = None


# --------------------------------------------------------------------------- #
# AWS SQS
# --------------------------------------------------------------------------- #
class AwsSqsReceiver(PayloadReceiver):
    """Long-poll an AWS SQS queue; delete each message after successful emit
    (delete == durable offset advance)."""

    source_type = SourceType.AWS_SQS

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.AWS_SQS,
            display_name="AWS SQS",
            category="queue",
            description="Consume an SQS queue by long-polling; messages are deleted after emit (offset advance).",
            ingest_modes=[IngestMode.QUEUE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="region", label="AWS region", type="string", required=True,
                          placeholder="us-east-1"),
                AuthField(key="access_key_id", label="Access key id", type="string"),
                AuthField(key="secret_access_key", label="Secret access key", type="password", secret=True),
                AuthField(key="session_token", label="Session token", type="password", secret=True),
            ],
            config_fields=[
                AuthField(key="queue_url", label="Queue URL", type="string", required=True),
                AuthField(key="max_messages", label="Batch size", type="number", default=10),
                AuthField(key="wait_seconds", label="Long-poll seconds", type="number", default=20),
                AuthField(key="format_hint", label="Message format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                          default="auto"),
            ],
            requires_pip=["boto3"],
        )

    def _client(self) -> Any:
        boto3 = _require("boto3", "boto3")
        kwargs: dict[str, Any] = {"region_name": self.config.get("region")}
        if self.config.get("access_key_id"):
            kwargs["aws_access_key_id"] = self.config["access_key_id"]
            kwargs["aws_secret_access_key"] = self.config.get("secret_access_key", "")
            if self.config.get("session_token"):
                kwargs["aws_session_token"] = self.config["session_token"]
        return boto3.client("sqs", **kwargs)

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        client = self._client()
        queue_url = self.config.get("queue_url", "")
        max_messages = int(self.config.get("max_messages", 10) or 10)
        wait = int(self.config.get("wait_seconds", 20) or 20)
        self._running = True
        loop = asyncio.get_running_loop()
        while self._running:
            resp = await loop.run_in_executor(
                None,
                lambda: client.receive_message(
                    QueueUrl=queue_url,
                    MaxNumberOfMessages=max_messages,
                    WaitTimeSeconds=wait,
                ),
            )
            for message in resp.get("Messages", []):
                body = message.get("Body", "")
                await self._emit_payload(body, prefs, emit)
                # Delete only after emit so a crash mid-batch re-delivers (no loss).
                await loop.run_in_executor(
                    None,
                    lambda r=message["ReceiptHandle"]: client.delete_message(
                        QueueUrl=queue_url, ReceiptHandle=r
                    ),
                )

    async def stop(self) -> None:
        self._running = False


# --------------------------------------------------------------------------- #
# AWS Kinesis
# --------------------------------------------------------------------------- #
class AwsKinesisReceiver(PayloadReceiver):
    """Consume an AWS Kinesis Data Stream shard-by-shard, advancing the shard
    iterator (the durable offset is the sequence number)."""

    source_type = SourceType.AWS_KINESIS

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.AWS_KINESIS,
            display_name="AWS Kinesis Data Streams",
            category="queue",
            description="Consume a Kinesis stream by iterating shards; offset is the record sequence number.",
            ingest_modes=[IngestMode.QUEUE, IngestMode.STREAM],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="region", label="AWS region", type="string", required=True),
                AuthField(key="access_key_id", label="Access key id", type="string"),
                AuthField(key="secret_access_key", label="Secret access key", type="password", secret=True),
                AuthField(key="session_token", label="Session token", type="password", secret=True),
            ],
            config_fields=[
                AuthField(key="stream_name", label="Stream name", type="string", required=True),
                AuthField(key="iterator_type", label="Start position", type="select",
                          options=["LATEST", "TRIM_HORIZON"], default="LATEST"),
                AuthField(key="poll_seconds", label="Poll interval (s)", type="number", default=1),
                AuthField(key="format_hint", label="Record format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                          default="auto"),
            ],
            requires_pip=["boto3"],
        )

    def _client(self) -> Any:
        boto3 = _require("boto3", "boto3")
        kwargs: dict[str, Any] = {"region_name": self.config.get("region")}
        if self.config.get("access_key_id"):
            kwargs["aws_access_key_id"] = self.config["access_key_id"]
            kwargs["aws_secret_access_key"] = self.config.get("secret_access_key", "")
            if self.config.get("session_token"):
                kwargs["aws_session_token"] = self.config["session_token"]
        return boto3.client("kinesis", **kwargs)

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        client = self._client()
        stream = self.config.get("stream_name", "")
        iterator_type = self.config.get("iterator_type", "LATEST")
        poll = float(self.config.get("poll_seconds", 1) or 1)
        self._running = True
        loop = asyncio.get_running_loop()

        # Resume from the durable per-shard sequence (audit #7): a restart continues
        # AFTER the last processed record instead of losing data (LATEST) or replaying
        # everything (TRIM_HORIZON).
        persisted = await self.load_cursor()
        shard_seq: dict[str, str] = dict(persisted.shard_markers) if persisted else {}

        desc = await loop.run_in_executor(None, lambda: client.describe_stream(StreamName=stream))
        shards = desc["StreamDescription"]["Shards"]
        iterators: dict[str, str] = {}
        for shard in shards:
            sid = shard["ShardId"]
            seq = shard_seq.get(sid)
            if seq:
                it = await loop.run_in_executor(
                    None,
                    lambda s=sid, q=seq: client.get_shard_iterator(
                        StreamName=stream, ShardId=s,
                        ShardIteratorType="AFTER_SEQUENCE_NUMBER",
                        StartingSequenceNumber=q,
                    ),
                )
            else:
                it = await loop.run_in_executor(
                    None,
                    lambda s=sid: client.get_shard_iterator(
                        StreamName=stream, ShardId=s, ShardIteratorType=iterator_type
                    ),
                )
            iterators[sid] = it["ShardIterator"]

        while self._running:
            for shard_id, shard_it in list(iterators.items()):
                if not shard_it:
                    continue
                resp = await loop.run_in_executor(
                    None, lambda it=shard_it: client.get_records(ShardIterator=it, Limit=100)
                )
                records = resp.get("Records", [])
                for record in records:
                    await self._emit_payload(record.get("Data", b""), prefs, emit)
                # Persist the last processed sequence AFTER emit (at-least-once).
                if records:
                    last_seq = str(records[-1].get("SequenceNumber", "") or "")
                    if last_seq:
                        shard_seq[shard_id] = last_seq
                        await self.save_cursor(Cursor(shard_markers=dict(shard_seq)))
                iterators[shard_id] = resp.get("NextShardIterator", "")
            await asyncio.sleep(poll)

    async def stop(self) -> None:
        self._running = False


# --------------------------------------------------------------------------- #
# Azure Event Hubs
# --------------------------------------------------------------------------- #
class AzureEventHubReceiver(PayloadReceiver):
    """Consume an Azure Event Hub via the async client; checkpoints are the
    durable offset (in-memory by default — a real deployment wires a blob
    checkpoint store)."""

    source_type = SourceType.AZURE_EVENT_HUB

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False
        self._client: Any = None

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.AZURE_EVENT_HUB,
            display_name="Azure Event Hubs",
            category="queue",
            description="Consume an Azure Event Hub (Azure Monitor / Sentinel export) with consumer-group offsets.",
            ingest_modes=[IngestMode.QUEUE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="connection_string", label="Connection string", type="password",
                          secret=True, required=True),
            ],
            config_fields=[
                AuthField(key="eventhub_name", label="Event Hub name", type="string", required=True),
                AuthField(key="consumer_group", label="Consumer group", type="string",
                          default="$Default"),
                AuthField(key="starting_position", label="Start position", type="select",
                          options=["-1", "@latest"], default="@latest"),
                AuthField(key="format_hint", label="Body format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                          default="auto"),
            ],
            requires_pip=["azure-eventhub"],
        )

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        mod = _require("azure.eventhub.aio", "azure-eventhub")
        EventHubConsumerClient = mod.EventHubConsumerClient
        self._client = EventHubConsumerClient.from_connection_string(
            self.config.get("connection_string", ""),
            consumer_group=self.config.get("consumer_group", "$Default"),
            eventhub_name=self.config.get("eventhub_name", ""),
        )
        self._running = True

        async def on_event(partition_context: Any, event: Any) -> None:
            if event is None:
                return
            body = event.body_as_str() if hasattr(event, "body_as_str") else bytes(event.body_as_bytes())
            await self._emit_payload(body, prefs, emit)
            await partition_context.update_checkpoint(event)

        async with self._client:
            await self._client.receive(
                on_event=on_event,
                starting_position=self.config.get("starting_position", "@latest"),
            )

    async def stop(self) -> None:
        self._running = False
        if self._client is not None:
            try:
                await self._client.close()
            except Exception:  # noqa: BLE001
                pass
            self._client = None


# --------------------------------------------------------------------------- #
# GCP Pub/Sub
# --------------------------------------------------------------------------- #
class GcpPubSubReceiver(PayloadReceiver):
    """Consume a GCP Pub/Sub subscription via streaming pull; ack each message
    after emit (ack == durable offset advance)."""

    source_type = SourceType.GCP_PUBSUB

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False
        self._future: Any = None

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.GCP_PUBSUB,
            display_name="Google Cloud Pub/Sub",
            category="queue",
            description="Consume a Pub/Sub subscription with streaming pull; messages acked after emit.",
            ingest_modes=[IngestMode.QUEUE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="credentials_json", label="Service account JSON", type="textarea",
                          secret=True, help="Service-account key JSON (or leave blank for ADC)."),
            ],
            config_fields=[
                AuthField(key="project_id", label="Project id", type="string", required=True),
                AuthField(key="subscription_id", label="Subscription id", type="string", required=True),
                AuthField(key="format_hint", label="Message format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                          default="auto"),
            ],
            requires_pip=["google-cloud-pubsub"],
        )

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        mod = _require("google.cloud.pubsub_v1", "google-cloud-pubsub")
        loop = asyncio.get_running_loop()

        creds_json = self.config.get("credentials_json")
        if creds_json:
            sa_mod = _require("google.oauth2.service_account", "google-auth")
            import json as _json

            info = _json.loads(creds_json) if isinstance(creds_json, str) else creds_json
            credentials = sa_mod.Credentials.from_service_account_info(info)
            subscriber = mod.SubscriberClient(credentials=credentials)
        else:
            subscriber = mod.SubscriberClient()

        sub_path = subscriber.subscription_path(
            self.config.get("project_id", ""), self.config.get("subscription_id", "")
        )
        self._running = True

        def callback(message: Any) -> None:
            fut = asyncio.run_coroutine_threadsafe(
                self._emit_payload(message.data, prefs, emit), loop
            )
            try:
                fut.result()
                message.ack()
            except Exception:  # noqa: BLE001
                message.nack()

        self._future = subscriber.subscribe(sub_path, callback=callback)
        try:
            await loop.run_in_executor(None, self._future.result)
        except Exception:  # noqa: BLE001
            pass

    async def stop(self) -> None:
        self._running = False
        if self._future is not None:
            try:
                self._future.cancel()
            except Exception:  # noqa: BLE001
                pass
            self._future = None


# --------------------------------------------------------------------------- #
# RabbitMQ (AMQP)
# --------------------------------------------------------------------------- #
class RabbitMqReceiver(PayloadReceiver):
    """Consume a RabbitMQ queue via aio-pika; ack after emit."""

    source_type = SourceType.RABBITMQ

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False
        self._connection: Any = None

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.RABBITMQ,
            display_name="RabbitMQ (AMQP)",
            category="queue",
            description="Consume a RabbitMQ queue over AMQP; messages acked after emit.",
            ingest_modes=[IngestMode.QUEUE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="url", label="AMQP URL", type="password", secret=True, required=True,
                          placeholder="amqp://user:pass@host:5672/vhost"),
            ],
            config_fields=[
                AuthField(key="queue", label="Queue name", type="string", required=True),
                AuthField(key="prefetch", label="Prefetch count", type="number", default=10),
                AuthField(key="format_hint", label="Body format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                          default="auto"),
            ],
            requires_pip=["aio-pika"],
        )

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        aio_pika = _require("aio_pika", "aio-pika")
        self._connection = await aio_pika.connect_robust(self.config.get("url", ""))
        self._running = True
        channel = await self._connection.channel()
        await channel.set_qos(prefetch_count=int(self.config.get("prefetch", 10) or 10))
        queue = await channel.declare_queue(self.config.get("queue", ""), durable=True)
        async with queue.iterator() as queue_iter:
            async for message in queue_iter:
                if not self._running:
                    break
                async with message.process():  # auto-ack on clean exit
                    await self._emit_payload(message.body, prefs, emit)

    async def stop(self) -> None:
        self._running = False
        if self._connection is not None:
            try:
                await self._connection.close()
            except Exception:  # noqa: BLE001
                pass
            self._connection = None


# --------------------------------------------------------------------------- #
# NATS / JetStream
# --------------------------------------------------------------------------- #
class NatsReceiver(PayloadReceiver):
    """Subscribe to a NATS subject (core NATS or JetStream durable consumer)."""

    source_type = SourceType.NATS

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False
        self._nc: Any = None

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.NATS,
            display_name="NATS / JetStream",
            category="queue",
            description="Subscribe to a NATS subject; JetStream durable consumers track offsets.",
            ingest_modes=[IngestMode.QUEUE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="servers", label="Servers", type="string", required=True,
                          placeholder="nats://host:4222"),
                AuthField(key="token", label="Auth token", type="password", secret=True),
                AuthField(key="user", label="User", type="string"),
                AuthField(key="password", label="Password", type="password", secret=True),
            ],
            config_fields=[
                AuthField(key="subject", label="Subject", type="string", required=True),
                AuthField(key="queue_group", label="Queue group", type="string"),
                AuthField(key="durable", label="JetStream durable name", type="string",
                          help="Set to use a durable JetStream consumer (offset tracking)."),
                AuthField(key="format_hint", label="Message format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                          default="auto"),
            ],
            requires_pip=["nats-py"],
        )

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        nats = _require("nats", "nats-py")
        connect_kwargs: dict[str, Any] = {"servers": self.config.get("servers", "").split(",")}
        if self.config.get("token"):
            connect_kwargs["token"] = self.config["token"]
        if self.config.get("user"):
            connect_kwargs["user"] = self.config["user"]
            connect_kwargs["password"] = self.config.get("password", "")
        self._nc = await nats.connect(**connect_kwargs)
        self._running = True

        async def handler(msg: Any) -> None:
            await self._emit_payload(msg.data, prefs, emit)

        durable = self.config.get("durable")
        if durable:
            js = self._nc.jetstream()
            await js.subscribe(self.config.get("subject", ""), durable=durable, cb=handler)
        else:
            await self._nc.subscribe(
                self.config.get("subject", ""),
                queue=self.config.get("queue_group", "") or "",
                cb=handler,
            )
        # Keep the connection alive until stopped.
        while self._running:
            await asyncio.sleep(0.5)

    async def stop(self) -> None:
        self._running = False
        if self._nc is not None:
            try:
                await self._nc.drain()
            except Exception:  # noqa: BLE001
                pass
            self._nc = None


# --------------------------------------------------------------------------- #
# MQTT
# --------------------------------------------------------------------------- #
class MqttReceiver(PayloadReceiver):
    """Subscribe to an MQTT topic (IoT / appliance log forwarding) via paho-mqtt.

    QoS>=1 + a persistent session id gives at-least-once delivery across
    restarts (the broker re-delivers unacked messages — the offset equivalent)."""

    source_type = SourceType.MQTT

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False
        self._client: Any = None

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.MQTT,
            display_name="MQTT",
            category="queue",
            description="Subscribe to an MQTT topic (QoS1+ for at-least-once) from IoT/appliances.",
            ingest_modes=[IngestMode.QUEUE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="host", label="Broker host", type="string", required=True),
                AuthField(key="port", label="Port", type="number", default=1883),
                AuthField(key="username", label="Username", type="string"),
                AuthField(key="password", label="Password", type="password", secret=True),
                AuthField(key="tls", label="Use TLS", type="bool", default=False),
            ],
            config_fields=[
                AuthField(key="topic", label="Topic filter", type="string", required=True,
                          placeholder="security/+/alerts"),
                AuthField(key="qos", label="QoS", type="select", options=["0", "1", "2"], default="1"),
                AuthField(key="client_id", label="Client id (persistent session)", type="string",
                          default="tlsoc-agentic-triage"),
                AuthField(key="format_hint", label="Payload format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                          default="auto"),
            ],
            requires_pip=["paho-mqtt"],
        )

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        mqtt = _require("paho.mqtt.client", "paho-mqtt")
        loop = asyncio.get_running_loop()
        client = mqtt.Client(client_id=self.config.get("client_id", "tlsoc-agentic-triage"),
                             clean_session=False)
        if self.config.get("username"):
            client.username_pw_set(self.config["username"], self.config.get("password", ""))
        if self.config.get("tls"):
            client.tls_set()

        def on_connect(c: Any, userdata: Any, flags: Any, rc: Any, *args: Any) -> None:
            c.subscribe(self.config.get("topic", ""), qos=int(self.config.get("qos", 1) or 1))

        def on_message(c: Any, userdata: Any, msg: Any) -> None:
            asyncio.run_coroutine_threadsafe(
                self._emit_payload(msg.payload, prefs, emit), loop
            )

        client.on_connect = on_connect
        client.on_message = on_message
        self._client = client
        client.connect(self.config.get("host", ""), int(self.config.get("port", 1883) or 1883))
        self._running = True
        client.loop_start()
        while self._running:
            await asyncio.sleep(0.5)

    async def stop(self) -> None:
        self._running = False
        if self._client is not None:
            try:
                self._client.loop_stop()
                self._client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._client = None


# --------------------------------------------------------------------------- #
# Redis Streams
# --------------------------------------------------------------------------- #
class RedisStreamsReceiver(PayloadReceiver):
    """Consume a Redis Stream via a consumer group (XREADGROUP); ack (XACK) after
    emit. The consumer-group last-delivered id is the durable offset."""

    source_type = SourceType.REDIS_STREAMS

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False
        self._client: Any = None

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.REDIS_STREAMS,
            display_name="Redis Streams",
            category="queue",
            description="Consume a Redis Stream via a consumer group (XREADGROUP/XACK) with durable offsets.",
            ingest_modes=[IngestMode.QUEUE],
            capabilities=["subscribe", "test"],
            auth_fields=[
                AuthField(key="url", label="Redis URL", type="password", secret=True, required=True,
                          placeholder="redis://host:6379/0"),
            ],
            config_fields=[
                AuthField(key="stream", label="Stream key", type="string", required=True),
                AuthField(key="group", label="Consumer group", type="string",
                          default="tlsoc-agentic-triage"),
                AuthField(key="consumer", label="Consumer name", type="string", default="tlsoc-1"),
                AuthField(key="field", label="Message field", type="string", default="message",
                          help="Stream entry field carrying the payload."),
                AuthField(key="format_hint", label="Payload format", type="select",
                          options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                          default="auto"),
            ],
            requires_pip=["redis"],
        )

    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        # redis ships with the suite, but import lazily anyway (the redis.asyncio
        # submodule is what we need and keeping all broker imports uniform).
        redis_asyncio = _require("redis.asyncio", "redis")
        client = redis_asyncio.from_url(self.config.get("url", ""))
        self._client = client
        stream = self.config.get("stream", "")
        group = self.config.get("group", "tlsoc-agentic-triage")
        consumer = self.config.get("consumer", "tlsoc-1")
        field = self.config.get("field", "message")
        try:
            await client.xgroup_create(stream, group, id="0", mkstream=True)
        except Exception:  # noqa: BLE001 - group may already exist (BUSYGROUP)
            pass
        self._running = True
        while self._running:
            resp = await client.xreadgroup(group, consumer, {stream: ">"}, count=10, block=1000)
            if not resp:
                continue
            for _stream_key, entries in resp:
                for entry_id, fields in entries:
                    payload = _pick_field(fields, field)
                    await self._emit_payload(payload, prefs, emit)
                    await client.xack(stream, group, entry_id)

    async def stop(self) -> None:
        self._running = False
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception:  # noqa: BLE001
                pass
            self._client = None


def _pick_field(fields: dict[Any, Any], field: str) -> bytes | str:
    """Extract the payload field from a Redis stream entry (bytes or str keys)."""
    for key in (field, field.encode("utf-8")):
        if key in fields:
            return fields[key]
    # No named field — serialise the whole entry so nothing is lost.
    import json

    decoded = {
        (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v)
        for k, v in fields.items()
    }
    return json.dumps(decoded)
