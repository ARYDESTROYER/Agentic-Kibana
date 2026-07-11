# Live multi-source demo: wire formats, scenario design, and reuse policy

Research date: 2026-07-11
Scope: Splunk-compatible HEC, IBM QRadar LEEF and offenses, Wazuh archives and
alerts, RFC 5424/3164 syslog, and permissively licensed generator/dataset
candidates.

## Executive recommendation

Build the live demo from **project-owned, deterministic synthetic facts**, then
serialize those facts into each vendor's real native envelope and pass the bytes
through the same parser and OCSF normalization path used in production. Do not
bundle copied vendor logs, documentation examples, rules, decoders, or a large
third-party dataset.

Four visible sources should be present:

| Demo source | Event feed | Native alert feed |
|---|---|---|
| Splunk-compatible | HEC JSON envelopes; use a documented sourcetype such as `access_combined` | HEC JSON risk/finding records using documented Splunk ES risk fields |
| IBM QRadar-compatible | LEEF 2.0, preferably carried in an RFC 5424 message | `/api/siem/offenses`-shaped JSON objects |
| Wazuh-compatible | `archives.json`-shaped JSON records | `alerts.json`-shaped JSON records with a `rule` object |
| Syslog | RFC 5424 plus a smaller RFC 3164 legacy stream | No invented vendor alert: repeated events should trigger a TLSOC system detection |

The product should label these as **Synthetic · protocol-compatible**. Splunk,
QRadar, and Wazuh are trademarks and the demo must not imply that a vendor
endorses it. Use `.example` hostnames and TEST-NET addresses only. `.example` is
reserved for examples by [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606.html),
and `192.0.2.0/24`, `198.51.100.0/24`, and `203.0.113.0/24` are reserved for
documentation by [RFC 5737](https://www.rfc-editor.org/rfc/rfc5737.html).

## 1. Splunk-compatible source

### What is actually standardized

There is no single “Splunk log format.” Splunk assigns a `sourcetype` to describe
the underlying content. The interoperable wire contract available here is the
HTTP Event Collector JSON event protocol. Splunk's current documentation defines
`event` as the payload and the optional envelope metadata `time`, `host`,
`source`, `sourcetype`, `index`, and `fields`; `fields` is a flat object and is
valid on the event endpoint. `event` itself may be a string, number, or JSON
object. See [Format events for HTTP Event Collector](https://help.splunk.com/en/splunk-enterprise/get-started/get-data-in/10.4/get-data-with-http-event-collector/format-events-for-http-event-collector).

Production HEC details worth preserving in fixtures:

- `POST /services/collector/event` with `Authorization: Splunk <token>`.
- `time` is Unix seconds and may contain a fractional component.
- Several event envelopes in one HEC request are **concatenated JSON objects**,
  not a JSON array.
- Indexer acknowledgement is optional. With an ACK-enabled token, a channel and
  returned `ackID` are used with `/services/collector/ack`; Splunk documents the
  acknowledgement exchange in its [input endpoint reference](https://help.splunk.com/en/splunk-enterprise/leverage-rest-apis/rest-api-reference/10.4/input-endpoints/input-endpoint-descriptions).

For the ordinary event stream, `access_combined` is a documented pretrained
sourcetype for NCSA combined web access logs. Splunk lists both its field meaning
and representative shape in the [pretrained sourcetype catalog](https://help.splunk.com/en/splunk-cloud-platform/get-started/get-data-in/9.3.2408/configure-source-types/list-of-pretrained-source-types).

Project-authored representative HEC event:

```json
{
  "time": 1783791600.125,
  "host": "web-portal.demo.example",
  "source": "/var/log/nginx/access.log",
  "sourcetype": "access_combined",
  "index": "web",
  "event": "198.51.100.42 - - [11/Jul/2026:17:40:00 +0000] \"POST /login HTTP/1.1\" 401 221 \"-\" \"Mozilla/5.0\""
}
```

The demo's native-alert feed can use the HEC envelope with an independently
defined demo sourcetype and documented Splunk ES risk semantics. Splunk describes
`risk_object`, `risk_object_type`, and `risk_score` as the minimum risk-modifier
fields, with `risk_message`, `src`, `dest`, and MITRE annotations providing useful
context. See [How risk modifiers impact risk scores](https://help.splunk.com/splunk-enterprise-security-7/risk-based-alerting/7.2/modify-risk/how-risk-modifiers-impact-risk-scores-in-splunk-enterprise-security)
and [Review risk-based findings](https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.3/risk-based-alerting/review-risk-based-findings-in-splunk-enterprise-security).

```json
{
  "time": 1783791615.500,
  "host": "splunk-es.demo.example",
  "source": "TLSOC Demo - Credential Spray",
  "sourcetype": "tlsoc:demo:splunk_es_risk",
  "index": "risk",
  "event": {
    "risk_object": "pnair",
    "risk_object_type": "user",
    "risk_score": 60,
    "risk_message": "Synthetic credential spray against pnair",
    "src": "198.51.100.42",
    "dest": "web-portal.demo.example",
    "annotations": {
      "mitre_attack": {"mitre_technique_id": ["T1110"]}
    }
  }
}
```

This second object is a valid HEC event using documented ES field semantics; it
must not be described as a universal Splunk output schema.

### OCSF projection

| Native value | OCSF intent |
|---|---|
| HEC `time` | event `time` |
| HEC `host` | device/host name |
| `source`, `sourcetype`, `index` | preserve in source metadata and `unmapped` |
| parsed access IP/method/path/status | source endpoint and HTTP activity fields |
| risk object/user, score, message | finding entity, severity/risk context, finding title |
| entire HEC envelope and inner event | `raw_data`/`unmapped`, always untrusted |

## 2. IBM QRadar-compatible source

### LEEF event contract

LEEF is QRadar's structured event format. IBM defines the required header as:

```text
LEEF:Version|Vendor|Product|ProductVersion|EventID|
```

LEEF 1.0 attributes are normally tab-delimited. LEEF 2.0 adds a delimiter field,
which may be a literal character or a hexadecimal token such as `x5E`. IBM's
[LEEF event components](https://www.ibm.com/docs/en/qradar-on-cloud?topic=overview-leef-event-components)
also documents an optional RFC 3164 or RFC 5424 syslog header in front of the
LEEF payload.

Prefer IBM's normalized names when available: `src`, `dst`, `srcPort`, `dstPort`,
`proto`, `usrName`, `cat`, `sev`, `devTime`, and `devTimeFormat`. `sev` ranges
from 1 through 10. A non-epoch `devTime` must be paired with `devTimeFormat`, and
IBM states that device time takes precedence over the syslog-header timestamp.
The complete contract is in [Predefined LEEF event attributes](https://www.ibm.com/docs/en/qradar-on-cloud?topic=overview-predefined-leef-event-attributes).

Project-authored LEEF 2.0 event carried by RFC 5424, using `^` as its declared
attribute separator:

```text
<166>1 2026-07-11T17:40:05.000Z qradar-gw.demo.example tlsoc-demo 4102 QR-AUTH-FAIL - LEEF:2.0|TLSOC Demo|Identity Gateway|1.0|AUTH_FAIL|^|devTime=2026-07-11T17:40:05.000Z^devTimeFormat=yyyy-MM-dd'T'HH:mm:ss.SSSX^cat=Authentication^sev=6^src=198.51.100.42^dst=10.20.0.10^srcPort=51832^dstPort=443^proto=TCP^usrName=pnair^action=failed^msg=Synthetic login failure
```

Values must not contain the selected delimiter unless the implementation has a
well-tested escaping policy. IBM recommends simple alphanumeric keys and avoiding
tab, pipe, or caret delimiter characters in values; see its [LEEF best-practice guidance](https://www.ibm.com/docs/en/qradar-on-cloud?topic=keys-best-practices-guidelines-leef-events).

### QRadar native alert contract

QRadar's native investigation object is an **offense**, retrieved from
`GET /api/siem/offenses`. IBM recommends explicitly pinning the API `Version`
header because using the implicit latest version can break integrations during an
upgrade. Current version/support guidance is maintained in IBM's [QRadar API
overview](https://www.ibm.com/docs/en/qradar-common?topic=api-endpoint-documentation-supported-versions).

The public endpoint schema includes `id`, `description`, `rules`, `event_count`,
`flow_count`, `log_sources`, `start_time`, `last_updated_time`, `credibility`,
`magnitude`, `severity`, `relevance`, `categories`, `offense_source`, `inactive`,
and `status`; see IBM's [GET /siem/offenses contract](https://ibmsecuritydocs.github.io/qradar_api_14.0/14.0--siem-offenses-GET.html).

Project-authored representative response projection:

```json
{
  "id": 70042,
  "description": "Synthetic credential spray followed by successful access",
  "rules": [{"id": 900042, "type": "CRE_RULE"}],
  "event_count": 48,
  "flow_count": 0,
  "log_sources": [{"id": 42, "name": "Identity Gateway", "type_id": 4001, "type_name": "Universal LEEF"}],
  "start_time": 1783791605000,
  "last_updated_time": 1783791625000,
  "credibility": 8,
  "magnitude": 7,
  "severity": 7,
  "relevance": 6,
  "categories": ["Authentication Failures"],
  "offense_source": "198.51.100.42",
  "inactive": false,
  "status": "OPEN"
}
```

QRadar calculates offense magnitude from relevance, severity, credibility, event
and flow counts, sources, age, asset weight, and other evidence; do not present the
demo's number as IBM's real calculation. The semantics are documented under
[Offense prioritization](https://www.ibm.com/docs/SS42VS_7.4/com.ibm.qradar.doc/c_qradar_ug_offense_magnitude.html).

### OCSF projection

| Native value | OCSF intent |
|---|---|
| syslog timestamp/host plus LEEF `devTime` | use validated `devTime` as event time; retain both |
| `src`, `dst`, ports, `proto` | network endpoints/activity |
| `usrName` | user entity |
| `EventID`, `cat`, `sev` | finding/rule identity, category, normalized severity |
| offense `id`, description, status, scores | source-native finding identity and context |
| complete LEEF line/offense object | `raw_data`/`unmapped`, always untrusted |

## 3. Wazuh-compatible source

Wazuh differentiates all received logs from generated alerts:

- `archives.json` contains raw events after reception/decoding when `logall_json`
  is enabled. Wazuh disables archive storage by default because retaining every raw
  event can consume substantial disk.
- `alerts.json` contains notifications created when the analysis engine matches a
  rule at or above the configured alert level.

Those behaviors are documented in [Event logging](https://documentation.wazuh.com/current/user-manual/manager/event-logging.html)
and [Alert management](https://documentation.wazuh.com/current/user-manual/manager/alert-management.html).

An archive record should preserve these native fields when available:
`timestamp`, `agent.{id,name,ip}`, `manager.name`, `id`, `full_log`,
`predecoder`, `decoder`, `data`, and `location`. An alert adds a `rule` object
with `level`, `description`, `id`, `firedtimes`, `mail`, `groups`, optional
`mitre`, and optional compliance arrays. Wazuh's own current examples show this
shape in [Command output analysis](https://documentation.wazuh.com/current/user-manual/capabilities/command-monitoring/command-output-analysis.html)
and [Journald log collection](https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/journald.html).

Project-authored `archives.json`-shaped record:

```json
{
  "timestamp": "2026-07-11T17:40:12.125+0000",
  "agent": {"id": "001", "name": "lp-api-01", "ip": "10.20.1.22"},
  "manager": {"name": "wazuh-manager.demo.example"},
  "id": "1783791612.424200",
  "full_log": "Jul 11 17:40:11 lp-api-01 sshd[4242]: Failed password for pnair from 198.51.100.42 port 52114 ssh2",
  "predecoder": {"program_name": "sshd", "timestamp": "Jul 11 17:40:11", "hostname": "lp-api-01"},
  "decoder": {"parent": "sshd", "name": "sshd"},
  "data": {"srcip": "198.51.100.42", "srcport": "52114", "dstuser": "pnair"},
  "location": "/var/log/auth.log"
}
```

Project-authored `alerts.json`-shaped record. `100201` is a synthetic demo rule
identifier and must not be advertised as a Wazuh built-in rule:

```json
{
  "timestamp": "2026-07-11T17:40:18.250+0000",
  "rule": {
    "level": 10,
    "description": "Synthetic repeated authentication failures",
    "id": "100201",
    "firedtimes": 8,
    "mail": false,
    "groups": ["synthetic_demo", "authentication_failed"],
    "mitre": {"id": ["T1110"], "tactic": ["Credential Access"], "technique": ["Brute Force"]}
  },
  "agent": {"id": "001", "name": "lp-api-01", "ip": "10.20.1.22"},
  "manager": {"name": "wazuh-manager.demo.example"},
  "id": "1783791618.424242",
  "full_log": "Jul 11 17:40:17 lp-api-01 sshd[4242]: Failed password for pnair from 198.51.100.42 port 52114 ssh2",
  "decoder": {"parent": "sshd", "name": "sshd"},
  "data": {"srcip": "198.51.100.42", "srcport": "52114", "dstuser": "pnair"},
  "location": "/var/log/auth.log"
}
```

### OCSF projection

| Native value | OCSF intent |
|---|---|
| `timestamp` | event time |
| `agent.name`, `agent.ip`, `agent.id` | device/agent identity |
| `data.srcip`, `data.srcport`, user fields | source endpoint and user entity |
| `rule.id`, `rule.description`, `rule.level` | source-native rule/finding and severity (Wazuh 0–15) |
| `rule.mitre` | MITRE technique/tactic evidence |
| `full_log`, decoder/predecoder/data/location | preserve as untrusted raw/unmapped evidence |

## 4. RFC syslog source

### RFC 5424

RFC 5424 is the standards-track message format. Its header order is:

```text
<PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA [MSG]
```

`PRI` ranges from 0 through 191 and is `facility * 8 + severity`; severity is
0 (emergency) through 7 (debug). Version 1 is current. The timestamp is an
RFC-3339-derived value with uppercase `T` and `Z`, and `-` is the NILVALUE for
absent header fields or structured data. Structured-data parameters must escape
`"`, `\`, and `]`. These requirements and field limits are in
[RFC 5424 section 6](https://www.rfc-editor.org/rfc/rfc5424.html#section-6).

Project-authored message:

```text
<165>1 2026-07-11T17:40:20.000Z web-portal.demo.example sshd 4242 AUTHFAIL [meta sequenceId="42"] Failed password for pnair from 198.51.100.42 port 52114 ssh2
```

### RFC 3164

RFC 3164 documents legacy BSD practice rather than a modern standards-track
protocol. The recognizable shape is `<PRI>Mmm dd hh:mm:ss HOSTNAME TAG[pid]:
CONTENT`; the timestamp has neither year nor timezone and a one-digit day is
space-padded. The packet limit is 1024 bytes. See [RFC 3164 sections 4.1.2 and
4.1.3](https://www.rfc-editor.org/rfc/rfc3164.html#section-4.1.2).

```text
<86>Jul 11 17:40:22 lp-api-01 sshd[4242]: Failed password for pnair from 198.51.100.42 port 52114 ssh2
```

For real TCP streams, test both framing styles. RFC 6587 describes octet counting
as `MSG-LEN SP SYSLOG-MSG` and also records the weaker newline/NUL-delimited
legacy method; see [RFC 6587 section 3.4](https://www.rfc-editor.org/rfc/rfc6587.html#section-3.4).
For production transport, RFC 5424 recommends TLS, and
[RFC 5425](https://www.rfc-editor.org/rfc/rfc5425.html) assigns TCP port 6514 to
syslog over TLS. The in-process demo need not bind any network port: it should
exercise the exact parser with the same bytes.

### OCSF projection

| Native value | OCSF intent |
|---|---|
| PRI facility/severity | facility metadata and normalized severity |
| timestamp | event time; infer RFC 3164 year only in a parser context and retain the original |
| hostname/app/procid/msgid | device, application/process, and event identity context |
| structured data | typed source extensions when known; otherwise `unmapped` |
| MSG and complete frame | message plus `raw_data`, always untrusted |

## 5. A compelling, deterministic SOC story

The demo should not be four independent random log fountains. It should be one
fictional organization observed through four systems, with shared stable entity
identifiers and a deterministic scenario clock.

### Primary storyline: credential spray to privileged access

| Relative time | Source | Native evidence | Expected product behavior |
|---:|---|---|---|
| 0s | syslog | RFC 3164/5424 SSH and application authentication failures from `198.51.100.42` | cheap correlation candidate; no vendor alert invented |
| 4s | Splunk-compatible | `access_combined` 401 burst for user `pnair` | link same IP/user/portal while retaining source ownership |
| 8s | QRadar-compatible | LEEF authentication/network events | enrich cross-source entity graph |
| 12s | Wazuh-compatible | archive events followed by a level-10 synthetic custom-rule alert | source-native alert enters ALERTS feed |
| 16s | Splunk-compatible | ES risk event for `pnair` | source-native alert enters ALERTS feed without duplicating the Wazuh case |
| 20s | QRadar-compatible | OPEN offense projection for the same source | related source-native case/campaign evidence |
| 24s | syslog/Wazuh | one successful login then privilege use | deterministic escalation evidence and system-generated detection |

Two shorter rotating stories should reuse the same estate:

1. **Web exploit then callback:** web access anomaly in Splunk; LEEF network deny
   and allow evidence; Wazuh file-integrity/process alert; syslog service error.
2. **Insider staging and exfiltration:** user/host activity in Splunk; large
   outbound LEEF transfer; Wazuh file/archive activity; syslog `sudo` and archive
   command evidence.

Use a cooldown so one incident does not continuously respawn. A live demo must
guarantee a visible incident soon after enable/reset; pure probability can produce
an embarrassingly quiet demonstration. A good schedule is:

- preseed 7–14 days of resolved history and a 10-minute recent window;
- emit bounded benign batches every tick with the existing 70/22/7/1 severity
  pyramid and diurnal weighting;
- guarantee the primary scenario during the first 20–30 seconds;
- then rotate scenarios on a deterministic seeded schedule with a several-minute
  cooldown;
- preserve a manual “Generate incident” action for presentations and tests;
- keep event IDs stable as `source + feed + scenario + sequence`, so resets replay
  predictably and retries never duplicate a case.

This follows the useful pattern in Splunk Eventgen: configuration-driven models,
time-aware token replacement, preservation of original timing intervals, and
multiple outputs. See [What is Eventgen?](https://splunk.github.io/eventgen/).
Splunk Attack Range similarly builds an instrumented production-like lab, executes
known simulations, and collects telemetry for detection testing rather than merely
spraying unrelated random lines; see [Splunk Attack Range](https://github.com/splunk/attack_range).

## 6. Open-source candidates and licensing

| Project | License evidenced upstream | Useful idea | Recommendation |
|---|---|---|---|
| [Splunk Eventgen](https://github.com/splunk/eventgen) | Apache-2.0 | time-aware templates, replay, HEC/file/REST outputs | Design reference or optional external validator; do not add its runtime to the app |
| [Flog](https://github.com/mingrammer/flog) | MIT | RFC 3164/5424 and web-log generation | Useful comparison corpus for parser tests; lacks SOC story semantics |
| [Swimlane soc-faker](https://github.com/swimlane/soc-faker) | MIT | synthetic users, hosts, hashes, Sysmon/Windows primitives | Inspiration only; its pinned dependency set is old and the project already has deterministic stdlib fixtures |
| [Splunk attack_data](https://github.com/splunk/attack_data) | Apache-2.0 | curated attack telemetry and replay-based detection tests | Optional developer-only validation; do not bundle its large LFS datasets in the demo |
| [OTRF Security-Datasets](https://github.com/OTRF/Security-Datasets) | MIT in the repository LICENSE | labeled benign/malicious replay scenarios | Optional offline research; verify provenance/license of each selected artifact before copying |
| [Atomic Red Team](https://github.com/redcanaryco/atomic-red-team) | MIT | small ATT&CK-mapped detection tests | Optional external integration for a real lab; never execute attack steps in the safe built-in demo |
| [Apache/MITRE Caldera](https://github.com/apache/caldera) | Apache-2.0 | deterministic adversary plans and operation timelines | External purple-team integration, not a bundled demo dependency |
| [OCSF schema](https://github.com/ocsf/ocsf-schema) | Apache-2.0 | vendor-neutral normalized event contract | Continue using OCSF internally and validate mappings against the version the product declares |
| [Wazuh](https://github.com/wazuh/wazuh/blob/main/LICENSE) | GPL-2.0; its notice expressly covers included rules, decoders, and data files | authoritative implementation behavior | Do not copy its rules, decoders, code, or sample data into a differently licensed product; independently generate records from the documented interface |

The preferred implementation therefore adds **no new runtime dependency and no
third-party corpus**. If future work copies any upstream code or dataset, pin the
exact revision, retain its copyright/license/NOTICE, record provenance per file,
and run a repository-wide license review first. The project's own public license
decision is still a prerequisite for redistribution.

## 7. Concrete integration guidance for this repository

### Native-first pipeline

The current demo generator produces ECS-shaped hits directly. For this upgrade,
introduce small, pure serializers that produce native records first:

```text
scenario facts
  -> splunk_hec / qradar_leef / qradar_offense / wazuh_json / syslog serializer
  -> existing HEC unwrap or formats.py parser
  -> generic_to_ocsf / connector-specific mapping
  -> RawEvent
  -> the real correlation, detection, investigation, and deterministic decide path
```

Do not add demo-only OCSF shortcuts. A demo is most valuable when it regression-
tests the same boundary operators rely on. Preserve the full native envelope in
`raw_data` and any unconsumed keys in `unmapped`; both remain untrusted prompt data.

Recommended source identities and feeds:

| ID | Display type | Feeds |
|---|---|---|
| `demo-splunk` | `SourceType.SPLUNK` / Splunk-compatible | `events` HEC access records; `alerts` HEC risk findings |
| `demo-qradar` | `SourceType.QRADAR` / QRadar-compatible | `events` LEEF; `alerts` offense JSON |
| `demo-wazuh` | `SourceType.WAZUH` | `events` archive JSON; `alerts` Wazuh alert JSON |
| `demo-syslog` | `SourceType.SYSLOG` | `events` RFC 5424 and RFC 3164; system detections arise in TLSOC |

The connectors may remain in-process and credential-free, but their manifests
should state “synthetic protocol-compatible simulation,” their source health rows
should move on every tick, and browse/search should expose the native raw record.
Do not open HEC/syslog ports or make external requests merely to make the demo look
live.

### Volume and memory

- Keep a bounded native-record ring per source for the Unified Logs view.
- Materialize only the bounded sample passed to correlation; represent the larger
  logical throughput with aggregate counters/sketches as the current demo does.
- Emit native alerts at a low ratio, but guarantee scenario milestones.
- Use one seeded `random.Random` plus an injected/fakeable clock. Never combine
  wall-clock and global randomness inside a reproducibility path.
- Keep source-native alerts and TLSOC-generated detections separate, connected by
  related-case/campaign links rather than merged into one evidence owner.

### Test matrix

At minimum, add these offline tests:

1. **Golden native syntax:** HEC metadata/event contract and concatenated batch;
   LEEF 1.0/tab plus 2.0/custom delimiters; Wazuh archive and alert nesting; RFC
   5424 NILVALUE/structured-data escaping/PRI bounds; RFC 3164 space-padded day and
   1024-byte ceiling.
2. **Production-parser round trip:** native bytes -> existing receiver parser ->
   OCSF, asserting IP/user/host/rule/severity/time and retention of raw data.
3. **Determinism:** same seed + injected time + tick number produces byte-identical
   payloads and stable IDs; a reset reproduces the scenario.
4. **Deduplication:** retry every native alert and verify one case/signature result.
5. **Cross-source story:** advance a fake clock through the credential-spray
   timeline and verify four sources, two kinds of alerts (native and TLSOC), related
   cases/campaign context, and no cross-source evidence leakage.
6. **Live lifecycle:** enable, tick, pause/disable, reset, re-enable; real tenant
   workload state/cost/cursors remain untouched, lifecycle actions leave the
   intentional real audit record, and the mock LLM remains the only model path.
7. **Quiet and noisy bounds:** the first-incident guarantee works even with
   `incident_rate=0`; that setting disables only later probabilistic storylines.
   The probability is evaluated once per alert interval, not per event/tick;
   maximum configured rates retain bounded memory and processing work.
8. **Safety fixtures:** all public-looking IPs are TEST-NET, all domains are
   `.example`, no token/secret/real PII exists, and every record is visibly tagged
   synthetic in non-protocol metadata.
9. **Contract/UI:** source overlay, source health/coverage, Unified Logs, case
   provenance, SSE refresh, and demo reset all expose four distinct source IDs.

## Decision

Use the established project-owned seeded generator as the scenario authority;
replace its direct ECS-only output at the demo boundary with small native-format
serializers and the existing real parsers. Learn from Eventgen, Attack Range,
Flog, soc-faker, OTRF, Atomic Red Team, and Caldera, but do not make the first-run
demo depend on them or copy their datasets. That yields an offline, fast, legally
clean, deterministic showcase while materially testing the production ingestion
surface.
