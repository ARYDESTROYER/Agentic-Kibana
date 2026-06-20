"""Push/queue/object-store receivers — fully offline, no optional deps, no sockets.

Proves the ingestion framework supports every common forward/subscribe transport:
  1. Format detection + parsing for json/ndjson/CEF/LEEF/syslog-3164/syslog-5424/
     GELF/kv on realistic sample lines (asserts extracted fields).
  2. ``WebhookReceiver.handle_request`` with bearer + HMAC auth (valid + invalid)
     and JSON + NDJSON bodies → asserts RawEvents are normalised (ip/user/severity
     surface from generic_to_ocsf).
  3. ``HECReceiver`` unwraps the Splunk HEC ``event`` envelope.
  4. ``SyslogReceiver.parse`` on a raw syslog line → RawEvent.
  5. EVERY class in ``BUILTIN_RECEIVERS`` returns a valid ``manifest()`` with a
     non-empty ``ingest_modes`` WITHOUT importing any optional dep (so the wizard
     can list them, and the suite stays green with nothing extra installed).
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest

from app.config import Preferences
from app.connectors.base import ConnectorManifest, PushReceiver
from app.connectors.receivers import (
    BUILTIN_RECEIVERS,
    HECReceiver,
    SyslogReceiver,
    WebhookReceiver,
    detect_format,
    records_from_payload,
)
from app.connectors.receivers.formats import (
    parse_cef,
    parse_gelf,
    parse_kv,
    parse_leef,
    parse_ndjson,
    parse_syslog_rfc3164,
    parse_syslog_rfc5424,
)


@pytest.fixture
def prefs() -> Preferences:
    return Preferences()


# --------------------------------------------------------------------------- #
# 1. Format detection
# --------------------------------------------------------------------------- #
def test_detect_format():
    assert detect_format('{"a": 1}') == "json"
    assert detect_format('{"a":1}\n{"a":2}') == "ndjson"
    assert detect_format(
        'CEF:0|Vendor|Product|1.0|100|name|7|src=1.2.3.4'
    ) == "cef"
    assert detect_format("LEEF:1.0|IBM|QRadar|1.0|41|src=1.2.3.4") == "leef"
    assert detect_format("<165>1 2003-10-11T22:14:15Z host app - - - msg") == "syslog5424"
    assert detect_format("<34>Oct 11 22:14:15 host su: failed") == "syslog3164"
    assert detect_format(
        '{"version":"1.1","host":"h","short_message":"m"}'
    ) == "gelf"
    assert detect_format("level=error src_ip=1.2.3.4 user=root") == "kv"
    assert detect_format("just some free text") == "raw"
    assert detect_format("") == "raw"
    # A leading-syslog-wrapped CEF is still detected as CEF (search anywhere).
    assert detect_format("<13>Jun 20 10:00:00 host CEF:0|V|P|1|1|n|5|src=1.1.1.1") == "cef"


# --------------------------------------------------------------------------- #
# 1. JSON / NDJSON
# --------------------------------------------------------------------------- #
def test_parse_json_object_and_array():
    recs = records_from_payload('{"a": 1, "b": "x"}')
    assert recs == [{"a": 1, "b": "x"}]
    recs = records_from_payload('[{"a": 1}, {"a": 2}]')
    assert len(recs) == 2 and recs[1]["a"] == 2


def test_parse_ndjson():
    recs = parse_ndjson('{"a":1}\n\n{"a":2}\n')
    assert [r["a"] for r in recs] == [1, 2]


def test_parse_ndjson_bad_line_is_best_effort_not_dropped():
    recs = parse_ndjson('{"a":1}\nnot json\n{"a":2}')
    assert len(recs) == 3
    assert recs[1]["message"] == "not json"
    assert "_parse_error" in recs[1]
    # The good lines around the bad one still parse.
    assert recs[0]["a"] == 1 and recs[2]["a"] == 2


def test_malformed_json_never_raises():
    recs = records_from_payload("{not valid", hint="json")
    assert len(recs) == 1
    assert "_parse_error" in recs[0]


# --------------------------------------------------------------------------- #
# 1. CEF
# --------------------------------------------------------------------------- #
def test_parse_cef_arcsight_sample():
    line = (
        "CEF:0|Security|threatmanager|1.0|100|worm successfully stopped|10|"
        "src=10.0.0.1 dst=2.1.2.2 spt=1232 suser=alice msg=worm detected"
    )
    rec = parse_cef(line)[0]
    assert rec["cef_version"] == "0"
    assert rec["vendor"] == "Security"
    assert rec["product"] == "threatmanager"
    assert rec["signature_id"] == "100"
    assert rec["name"] == "worm successfully stopped"
    assert rec["severity"] == "10"
    assert rec["src"] == "10.0.0.1"
    assert rec["source_ip"] == "10.0.0.1"          # friendly alias
    assert rec["dest_ip"] == "2.1.2.2"
    assert rec["source_port"] == "1232"
    assert rec["username"] == "alice"
    assert rec["message"] == "worm detected"        # msg alias, value with a space


def test_parse_cef_escaped_pipe_and_equals():
    line = r"CEF:0|Ven\|dor|Prod|1|7|na\|me|5|src=1.2.3.4 cs1=a\=b"
    rec = parse_cef(line)[0]
    assert rec["vendor"] == "Ven|dor"
    assert rec["name"] == "na|me"
    assert rec["cs1"] == "a=b"


def test_parse_cef_with_syslog_prefix():
    line = "<13>Jun 20 10:00:00 fw CEF:0|V|P|1|1|alert|5|src=8.8.8.8"
    rec = parse_cef(line)[0]
    assert rec["vendor"] == "V"
    assert rec["source_ip"] == "8.8.8.8"


# --------------------------------------------------------------------------- #
# 1. LEEF
# --------------------------------------------------------------------------- #
def test_parse_leef_v1_tab_delimited():
    line = "LEEF:1.0|Lancope|StealthWatch|1.0|41|src=192.0.2.0\tdst=172.50.123.1\tsev=5\tusrName=joe"
    rec = parse_leef(line)[0]
    assert rec["leef_version"] == "1.0"
    assert rec["vendor"] == "Lancope"
    assert rec["event_id"] == "41"
    assert rec["src"] == "192.0.2.0"
    assert rec["source_ip"] == "192.0.2.0"
    assert rec["dest_ip"] == "172.50.123.1"
    assert rec["severity"] == "5"
    assert rec["username"] == "joe"


def test_parse_leef_v2_custom_delimiter():
    # LEEF 2.0 declares a custom delimiter (^) in the 6th header field.
    line = "LEEF:2.0|IBM|QRadar|3.0|99|^|src=10.1.1.1^dst=10.2.2.2^usrName=bob"
    rec = parse_leef(line)[0]
    assert rec["leef_version"] == "2.0"
    assert rec["source_ip"] == "10.1.1.1"
    assert rec["dest_ip"] == "10.2.2.2"
    assert rec["username"] == "bob"


# --------------------------------------------------------------------------- #
# 1. Syslog RFC 5424
# --------------------------------------------------------------------------- #
def test_parse_syslog_rfc5424_full():
    line = (
        '<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 '
        '[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"] '
        "BOM An application event log entry"
    )
    rec = parse_syslog_rfc5424(line)[0]
    assert rec["pri"] == 165
    assert rec["facility"] == 20
    assert rec["severity"] == 5
    assert rec["severity_label"] == "notice"
    assert rec["version"] == "1"
    assert rec["host"] == "mymachine.example.com"
    assert rec["app"] == "evntslog"
    assert rec["procid"] is None        # the '-' NILVALUE
    assert rec["msgid"] == "ID47"
    assert rec["message"] == "BOM An application event log entry"
    # Structured data parsed + flattened.
    assert rec["structured_data"]["exampleSDID@32473"]["eventID"] == "1011"
    assert rec["iut"] == "3"


def test_parse_syslog_rfc5424_no_structured_data():
    line = "<34>1 2026-06-20T10:00:00Z host app 4711 - - simple message here"
    rec = parse_syslog_rfc5424(line)[0]
    assert rec["procid"] == "4711"
    assert rec["message"] == "simple message here"
    assert "structured_data" not in rec


# --------------------------------------------------------------------------- #
# 1. Syslog RFC 3164
# --------------------------------------------------------------------------- #
def test_parse_syslog_rfc3164_full():
    line = "<34>Oct 11 22:14:15 mymachine su[1234]: su root failed for lonvick on /dev/pts/8"
    rec = parse_syslog_rfc3164(line)[0]
    assert rec["pri"] == 34
    assert rec["facility"] == 4
    assert rec["severity"] == 2
    assert rec["host"] == "mymachine"
    assert rec["tag"] == "su"
    assert rec["procid"] == "1234"
    assert rec["message"] == "su root failed for lonvick on /dev/pts/8"


def test_parse_syslog_rfc3164_no_pid():
    line = "<13>Aug  5 09:00:00 router1 kernel: link down"
    rec = parse_syslog_rfc3164(line)[0]
    assert rec["host"] == "router1"
    assert rec["tag"] == "kernel"
    assert rec["message"] == "link down"


# --------------------------------------------------------------------------- #
# 1. GELF / kv
# --------------------------------------------------------------------------- #
def test_parse_gelf():
    line = json.dumps({
        "version": "1.1", "host": "web01", "short_message": "auth failure",
        "level": 3, "_src_ip": "203.0.113.5", "_user": "root",
    })
    rec = parse_gelf(line)[0]
    assert rec["message"] == "auth failure"      # short_message surfaced
    assert rec["src_ip"] == "203.0.113.5"        # underscore stripped for aliasing
    assert rec["user"] == "root"
    assert rec["_src_ip"] == "203.0.113.5"       # original preserved too


def test_parse_kv_logfmt():
    line = 'time=2026-06-20 level=error src_ip=198.51.100.7 user=admin msg="login failed"'
    rec = parse_kv(line)[0]
    assert rec["level"] == "error"
    assert rec["src_ip"] == "198.51.100.7"
    assert rec["user"] == "admin"
    assert rec["msg"] == "login failed"          # quoted value with a space


# --------------------------------------------------------------------------- #
# 2. WebhookReceiver — auth + normalisation
# --------------------------------------------------------------------------- #
def _json_body() -> bytes:
    return json.dumps({
        "source": {"ip": "203.0.113.9"},
        "user": {"name": "root"},
        "event": {"severity": 8},
        "@timestamp": "2026-06-20T10:00:00Z",
    }).encode()


def test_webhook_bearer_auth_valid(prefs):
    wh = WebhookReceiver(config={"auth_mode": "bearer", "token": "sekret"})
    events = wh.handle_request(
        _json_body(),
        {"Authorization": "Bearer sekret", "Content-Type": "application/json"},
        prefs,
    )
    assert len(events) == 1
    assert events[0].ip == "203.0.113.9"
    assert events[0].user == "root"
    assert events[0].severity == 75.0       # severity_id 4 (High) -> 75.0


def test_webhook_bearer_auth_invalid(prefs):
    wh = WebhookReceiver(config={"auth_mode": "bearer", "token": "sekret"})
    with pytest.raises(PermissionError):
        wh.handle_request(_json_body(), {"Authorization": "Bearer wrong"}, prefs)
    # Missing header is also rejected.
    with pytest.raises(PermissionError):
        wh.handle_request(_json_body(), {}, prefs)


def test_webhook_hmac_auth_valid_and_invalid(prefs):
    secret = "shh"
    body = _json_body()
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    wh = WebhookReceiver(config={
        "auth_mode": "hmac", "shared_secret": secret, "signature_header": "X-Sig",
    })
    events = wh.handle_request(body, {"X-Sig": sig, "Content-Type": "application/json"}, prefs)
    assert len(events) == 1 and events[0].ip == "203.0.113.9"
    # Tolerate a "sha256=" prefixed signature.
    events2 = wh.handle_request(body, {"X-Sig": f"sha256={sig}"}, prefs)
    assert len(events2) == 1
    with pytest.raises(PermissionError):
        wh.handle_request(body, {"X-Sig": "deadbeef"}, prefs)


def test_webhook_auth_none(prefs):
    wh = WebhookReceiver(config={"auth_mode": "none"})
    events = wh.handle_request(_json_body(), {}, prefs)
    assert len(events) == 1


def test_webhook_ndjson_body(prefs):
    wh = WebhookReceiver(config={"auth_mode": "none"})
    nd = (
        json.dumps({"src_ip": "10.0.0.1", "username": "a", "severity": 9})
        + "\n"
        + json.dumps({"src_ip": "10.0.0.2", "username": "b", "severity": 2})
    ).encode()
    events = wh.handle_request(nd, {"Content-Type": "application/x-ndjson"}, prefs)
    assert len(events) == 2
    assert [e.ip for e in events] == ["10.0.0.1", "10.0.0.2"]
    assert events[0].user == "a"
    assert events[0].severity == 90.0       # severity 9 -> Critical -> 90.0


def test_webhook_cef_body(prefs):
    wh = WebhookReceiver(config={"auth_mode": "none", "format_hint": "cef"})
    body = b"CEF:0|V|P|1|100|alert|7|src=203.0.113.77 suser=svc"
    events = wh.handle_request(body, {}, prefs)
    assert len(events) == 1
    assert events[0].ip == "203.0.113.77"
    assert events[0].user == "svc"


# --------------------------------------------------------------------------- #
# 3. HECReceiver — unwrap the Splunk envelope
# --------------------------------------------------------------------------- #
def test_hec_unwraps_object_event(prefs):
    hec = HECReceiver(config={"auth_mode": "none"})
    body = json.dumps({
        "event": {"src_ip": "198.51.100.4", "username": "svc", "severity": 9},
        "fields": {"host": "h1"},
        "time": 1700000000,
        "host": "h1",
    }).encode()
    events = hec.handle_request(body, {}, prefs)
    assert len(events) == 1
    assert events[0].ip == "198.51.100.4"
    assert events[0].user == "svc"
    assert events[0].severity == 90.0


def test_hec_unwraps_string_event(prefs):
    hec = HECReceiver(config={"auth_mode": "none"})
    body = json.dumps({"event": "a raw syslog-ish line", "sourcetype": "syslog"}).encode()
    events = hec.handle_request(body, {}, prefs)
    assert len(events) == 1


def test_hec_splunk_authorization_header(prefs):
    hec = HECReceiver(config={"auth_mode": "bearer", "token": "hectoken"})
    body = json.dumps({"event": {"src_ip": "1.2.3.4"}}).encode()
    # HEC senders use "Authorization: Splunk <token>".
    events = hec.handle_request(body, {"Authorization": "Splunk hectoken"}, prefs)
    assert len(events) == 1 and events[0].ip == "1.2.3.4"


def test_hec_batched_newline_delimited(prefs):
    hec = HECReceiver(config={"auth_mode": "none"})
    body = (
        json.dumps({"event": {"src_ip": "10.0.0.1"}})
        + "\n"
        + json.dumps({"event": {"src_ip": "10.0.0.2"}})
    ).encode()
    events = hec.handle_request(body, {}, prefs)
    assert [e.ip for e in events] == ["10.0.0.1", "10.0.0.2"]


# --------------------------------------------------------------------------- #
# 4. SyslogReceiver.parse — raw line → RawEvent
# --------------------------------------------------------------------------- #
def test_syslog_receiver_parse(prefs):
    sr = SyslogReceiver()
    line = "<34>Oct 11 22:14:15 web01 sshd[1234]: Failed password for root from 203.0.113.55 port 22"
    events = sr.parse(line, prefs)
    assert len(events) == 1
    assert events[0].host == "web01"
    assert "Failed password" in events[0].source.get("message", "")


def test_syslog_receiver_parse_5424(prefs):
    sr = SyslogReceiver()
    line = '<165>1 2026-06-20T22:14:15Z fw01 evntslog - ID47 - firewall deny event'
    events = sr.parse(line, prefs)
    assert len(events) == 1
    assert events[0].host == "fw01"


# --------------------------------------------------------------------------- #
# 5. Every BUILTIN_RECEIVER has a valid manifest with NO optional deps imported
# --------------------------------------------------------------------------- #
def test_builtin_receivers_count():
    # Exactly the receivers the spec requires (16): webhook+hec, syslog,
    # 9 brokers, 3 object stores, file.
    assert len(BUILTIN_RECEIVERS) == 16


@pytest.mark.parametrize("cls", BUILTIN_RECEIVERS, ids=lambda c: c.__name__)
def test_receiver_manifest_valid(cls):
    assert issubclass(cls, PushReceiver)
    manifest = cls.manifest()
    assert isinstance(manifest, ConnectorManifest)
    # Non-empty ingest_modes so the wizard can list it.
    assert manifest.ingest_modes, f"{cls.__name__} has no ingest_modes"
    assert manifest.display_name
    assert manifest.source_type
    # Manifest must NOT require an instance or any credential.
    # Re-call to prove it is a pure classmethod (idempotent, side-effect free).
    assert cls.manifest().source_type == manifest.source_type


def test_receiver_source_types_are_unique():
    types = [c.manifest().source_type for c in BUILTIN_RECEIVERS]
    assert len(types) == len(set(types)), "duplicate source_type across receivers"


def test_broker_receivers_declare_pip_requirements():
    # The brokers/cloud receivers must declare their optional dep so the wizard
    # can surface "pip install ..." and the start() can fail clearly.
    from app.connectors.receivers import (
        AwsKinesisReceiver,
        AwsSqsReceiver,
        AzureBlobReceiver,
        AzureEventHubReceiver,
        GcpPubSubReceiver,
        GcsReceiver,
        KafkaReceiver,
        MqttReceiver,
        NatsReceiver,
        RabbitMqReceiver,
        RedisStreamsReceiver,
        S3Receiver,
    )

    need_dep = [
        KafkaReceiver, AwsSqsReceiver, AwsKinesisReceiver, AzureEventHubReceiver,
        GcpPubSubReceiver, RabbitMqReceiver, NatsReceiver, MqttReceiver,
        RedisStreamsReceiver, S3Receiver, GcsReceiver, AzureBlobReceiver,
    ]
    for cls in need_dep:
        assert cls.manifest().requires_pip, f"{cls.__name__} must declare requires_pip"

    # stdlib-only receivers must NOT require an optional dep.
    for cls in (WebhookReceiver, HECReceiver, SyslogReceiver):
        assert cls.manifest().requires_pip == []


def test_stdlib_receivers_importable_without_optional_deps():
    # Importing the package + calling manifest() must not pull in any optional
    # client lib. Assert the known-absent broker libs were NOT imported as a
    # side-effect of importing the receivers package.
    import sys

    for mod in ("confluent_kafka", "boto3", "azure", "google.cloud.pubsub_v1",
                "aio_pika", "nats", "paho"):
        assert mod not in sys.modules, f"{mod} should not be imported at manifest time"
