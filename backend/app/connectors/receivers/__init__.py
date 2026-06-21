"""Built-in push receivers — every common way logs are forwarded TO us.

This package implements the PUSH / QUEUE / OBJECT_STORE half of the connector SPI
(the PULL half lives elsewhere). The hard requirement: *every* common forward /
subscribe transport is supported, with NO new hard dependency — every optional
client library is imported lazily inside the receiver's ``start()``.

The orchestrator's registry imports :data:`BUILTIN_RECEIVERS` to discover the
receivers, and each receiver's :meth:`manifest` drives the first-run wizard.

Coverage matrix (SourceType → IngestMode(s)):
  * WEBHOOK / HEC          → PUSH_HTTP
  * SYSLOG                 → PUSH_SYSLOG, PUSH_SOCKET
  * KAFKA, AWS_SQS, AWS_KINESIS, AZURE_EVENT_HUB, GCP_PUBSUB, RABBITMQ, NATS,
    MQTT, REDIS_STREAMS    → QUEUE (Kinesis also STREAM)
  * S3, GCS, AZURE_BLOB    → OBJECT_STORE
  * FILE                   → OBJECT_STORE, PUSH_SOCKET (stdlib tail)
"""

from __future__ import annotations

from ..base import PushReceiver
from .common import PayloadReceiver
from .formats import (
    detect_format,
    parse_cef,
    parse_gelf,
    parse_json,
    parse_kv,
    parse_leef,
    parse_ndjson,
    parse_syslog_rfc3164,
    parse_syslog_rfc5424,
    records_from_payload,
)
from .objectstore import (
    AzureBlobReceiver,
    FileReceiver,
    GcsReceiver,
    S3Receiver,
)
from .queues import (
    AwsKinesisReceiver,
    AwsSqsReceiver,
    AzureEventHubReceiver,
    GcpPubSubReceiver,
    KafkaReceiver,
    MqttReceiver,
    NatsReceiver,
    RabbitMqReceiver,
    RedisStreamsReceiver,
)
from .syslog import SyslogReceiver
from .webhook import HECReceiver, WebhookReceiver

# The registry the orchestrator imports. Order = wizard listing order
# (universal transports first, then queues, then object stores/files).
BUILTIN_RECEIVERS: list[type[PushReceiver]] = [
    WebhookReceiver,
    HECReceiver,
    SyslogReceiver,
    KafkaReceiver,
    AwsSqsReceiver,
    AwsKinesisReceiver,
    AzureEventHubReceiver,
    GcpPubSubReceiver,
    RabbitMqReceiver,
    NatsReceiver,
    MqttReceiver,
    RedisStreamsReceiver,
    S3Receiver,
    GcsReceiver,
    AzureBlobReceiver,
    FileReceiver,
]

__all__ = [
    "BUILTIN_RECEIVERS",
    # bases
    "PayloadReceiver",
    # formats
    "detect_format",
    "records_from_payload",
    "parse_json",
    "parse_ndjson",
    "parse_cef",
    "parse_leef",
    "parse_syslog_rfc5424",
    "parse_syslog_rfc3164",
    "parse_gelf",
    "parse_kv",
    # receivers
    "WebhookReceiver",
    "HECReceiver",
    "SyslogReceiver",
    "KafkaReceiver",
    "AwsSqsReceiver",
    "AwsKinesisReceiver",
    "AzureEventHubReceiver",
    "GcpPubSubReceiver",
    "RabbitMqReceiver",
    "NatsReceiver",
    "MqttReceiver",
    "RedisStreamsReceiver",
    "S3Receiver",
    "GcsReceiver",
    "AzureBlobReceiver",
    "FileReceiver",
]
