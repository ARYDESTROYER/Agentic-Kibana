---
title: Known limitations
description: Promotion blockers and explicit operating constraints for Agentic SOC 0.1.0.
---

# Known limitations

This list is part of the product contract for Agentic SOC `0.1.0`. It distinguishes
blockers to Stable promotion from documented version 0.1 constraints so a green
unit-test suite is never mistaken for production evidence.

## Stable-promotion blockers

### Stable branch topology is not provisioned

The release contract requires a protected literal `main` branch. The current
remote exposes `Testing` and legacy/default `claude/main`, but no `main`.
Consequently no current checkout or artifact is a supported Stable release.

**Required change:** create or rename and protect literal `main`, make it the
default branch, require the documented CI/promotion gates, and publish the first
tag from its verified commit. If the owner intentionally keeps `claude/main`,
change every workflow, link, branch protection, and release document to that one
canonical name before publication.

### No project license

The repository does not contain a `LICENSE` file. Publicly visible source is not
automatically open source and does not grant redistribution rights.

**Required decision:** choose and commit the intended license before publishing
binaries, containers, or an “open-source” announcement. Apache-2.0 is permissive and
patent-explicit; AGPL-3.0 requires network-service modifications to be offered to
users. This is an owner/product decision and must not be guessed by automation.

### Reproducible release publication is not automated

Direct Python and npm dependencies are version-pinned, and image metadata accepts
the version, revision, and build time. Transitive Python resolution and container
base images are not yet locked by hash/digest, and there is no tag workflow that
publishes signed images, an SBOM, provenance attestation, or checksums for one exact
commit. Rebuilding the same tag later could therefore produce different bits.

**Required change:** generate reviewed hash-locked Python constraints, pin base
images by digest with an update policy, build backend/web images and packages once
from the protected tag SHA, scan them, emit SBOM/provenance/checksums, and promote
those exact digests without rebuilding.

### Push receipt is not durable

Receivers currently normalise and process a batch in the backend process. Processing
errors propagate so retry-capable transports can avoid acknowledging failed work,
but there is no transactional receipt/inbox committed before correlation.

Consequences:

- a process or host loss inside the receipt/processing window can lose an HTTP or
  lossy-syslog event;
- there is no durable poison-event ledger or replay control;
- queue acknowledgement behaviour must be certified per adapter;
- receipt lag and oldest-unprocessed age cannot be measured centrally.

**Required change:** durable receipt + idempotency key + outbox, acknowledge only
after receipt commit, retry workers, and a bounded dead-letter/replay workflow.

### Receiver checkpoints are not uniformly durable

Durable brokers retain acknowledged offsets, and the ES-compatible pull path now has
a persisted cursor. Kinesis sequences and S3/GCS/Azure object markers now persist
through the configured StateStore after successful processing. Local-file byte
offsets and the default Event Hubs checkpoint path remain process-local. Restart can
therefore replay or miss file data depending on start settings, while Event Hubs
durability depends on wiring a supported checkpoint store.

**Required change:** persist per-source/partition/object/file checkpoints only after
durable receipt, or require a native durable consumer/checkpoint store. Test crash and
restart at every boundary, object overwrite/late arrival, file rotation, broker
rebalance/reshard, and checkpoint corruption. Publish the actual guarantee per
connector rather than one umbrella “durable” claim.

### Dynamic secrets do not survive restart

Per-source, notification, SSO, and locally registered model secrets entered through
the UI/API live in process memory. Their configured field names may persist, but the
values disappear when the backend restarts.

**Required change:** integrate a supported secret manager or encrypted secret store
with rotation, versioning, audit, and explicit backup/restore semantics. Environment
variables are a temporary boot-time path, not a complete multi-source lifecycle.

### No versioned database migrations

SQL state uses idempotent `create_all` and shared KV documents. There is no Alembic
or equivalent ordered schema/data migration ledger, compatibility gate, or downgrade
plan.

**Required change:** version every persisted schema and data transform; test clean
install, forward upgrade, backup/restore, interrupted migration, and supported
rollback for PostgreSQL. SQLite may remain a single-node evaluation profile.

### Open-case identity is too entity-centric

Configured sources now scope the active signature by source, so the same entity from
source A and source B creates distinct cases that the related-case/campaign layer can
link. Within one source, however, identity is still essentially
`(source_id, entity_type, entity_value)`. While a case remains open, a later and
potentially unrelated rule family or distant episode on the same user, host, or
address can attach to it. The legacy unconfigured path remains entity-only. This can
over-merge distinct stories and distort evidence, risk, ownership, and timing.

**Required change:** version the case-signature policy and add a bounded incident
episode or strong native lineage within each source. Keep deterministic
event/detection idempotency separate from the decision to attach, relate, or open a
new case. Add tests for retries of one incident, distinct rules on the same entity,
NAT/shared IPs, distant/reopened activity, legacy migration, and cross-source
related-but-not-merged cases.

## Version 0.1 constraints

### Single replica only

Run exactly one backend replica. Signature locks, receiver ownership, schedulers,
recent-event buffers, and the realtime event bus are process-local. The storage
abstractions do not yet provide all of the leases, uniqueness constraints, and
atomic claims needed for active-active replicas.

Adding replicas now can duplicate cases or scheduled work, lose receiver ownership,
and deliver inconsistent live updates. The [scale-out roadmap](../architecture/ingestion.md#scale-out-roadmap)
defines the required worker/lease split.

### Volatile push evidence and realtime replay

Push-source browse/live-tail keeps only the latest 500 events per source in process
memory. Realtime SSE replay is also process-local. Restarting the backend clears
both, and another replica would not share them.

Cases retain selected event IDs and evidence, but the suite does not yet provide a
durable raw-event archive for pushed data. Keep the authoritative event in the
source/broker/object store during evaluation.

### Receiver supervision is process-local

Source create/update/delete and secret rotation now reconcile the live receiver set
with a coarse stop-and-rebuild cycle. A failed long-running receiver is restarted
with bounded exponential backoff, preserving broker redelivery after processing
errors. There is still no persisted last-error/restart state, lease, or distributed
ownership, and a permanently invalid configuration retries locally until corrected.
Verify the health/coverage surface after topology changes and alert on repeated
receiver restart logs during evaluation.

### Pull replay and late-arrival handling are bounded

Elasticsearch uses a PIT with `search_after` and a stable `_shard_doc` tie-breaker;
OpenSearch/Wazuh-compatible endpoints can fall back to offset paging when PIT is not
available. Each tick is bounded to 64 frontier pages and 32 late-overlap pages, with
remaining frontier rows continuing on the next tick. The late-event-time overlap is
five minutes and its exact recent-ID ledger is capped at 100,000 entries; saturation
disables optional late acceptance rather than risking replay.

The first-class Elasticsearch path uses PIT. The offset fallback is safe for a
quiescent view but is not claimed exactly-once while an index refreshes. Monitor
cursor saturation/catch-up lag and retain the source long enough to replay events
outside the five-minute overlap.

### Default event routing requires workload calibration

Source-native alert feeds are prioritised for investigation. Raw event feeds use a
pre-enrichment routing score normalised over the signals that are actually available,
plus per-tick and hard daily-budget bounds. Extreme zero-config bursts can now cross
the balanced floor while ordinary activity remains a candidate; the canonical
persisted risk score and deterministic case decision are unchanged. These profile
floors have not yet been benchmarked across representative source mixes. Candidates
deferred only by the per-tick cap are now read from durable case state and drained on
a later quiet tick; risk/policy candidates intentionally await operator action or new
evidence.

Do not assume “all events are read” means “all events receive an LLM call.” That
would be prohibitively expensive. Validate that enabled deterministic detectors,
baselines, and risk settings produce the expected candidates and latency for each
source.

### Baseline learning and anomaly promotion are separate

The normal pull/push path now observes and persists aggregate-only source and cluster
volume series, so the baseline genuinely warms across restarts without retaining raw
logs or affecting case decisions. Its realtime anomaly signal remains advisory. An
automatic anomaly detection is promoted through the separate event funnel only when
that funnel's baseline/batch gates are enabled.

Before treating adaptive detection as autonomous, validate warm-up, late data,
poisoning bounds, drift, false-positive feedback, candidate deduplication, and
rollback on a replayable workload. Keep baseline changes versioned and outside the
deterministic close/escalate policy.

### The daily budget is a preflight ceiling, not an atomic reservation

The default application budget is enabled at `$10/day`, warns at 80%, and blocks new
provider calls over the ceiling; a blocked investigation persists/fails safe to
`NEEDS_HUMAN`. The check does not reserve spend atomically, so calls already in flight
can finish above the boundary. It also cannot prevent costs created outside this
backend. Keep concurrency conservative, configure provider-side budgets/rate limits,
and alert on ledger/provider disagreement.

### Discounted inference depends on provider capacity and reporting

Compatible official OpenAI alert/case work prefers live Flex, but Flex is a
best-effort service tier. Eligibility is intentionally narrow and the configured
standard fallback may cost more than Flex. The Agentic SOC ledger records the tier
actually returned; it remains an estimate and must be reconciled with provider
billing. The separate asynchronous Batch queue is opt-in and can add material
latency or return results out of order.

### Portable export is not backup or tenant isolation

The Data export workflow is bounded to 5,000 items per selected scope and 25 MiB,
excludes secrets/users/sessions/raw logs/raw knowledge chunks, and has no import
endpoint. It is suitable for support and offline analysis, not disaster recovery.
`data_export:export` is also broad scope access rather than per-analyst row isolation;
grant it to custom roles only after reviewing the disclosure boundary.

### Mapping is not yet a versioned lifecycle

The current sample analyser offers deterministic suggestions from a pasted record;
it does not profile a representative sample, persist immutable mapping versions,
dual-run in shadow, monitor drift, or roll back automatically. Operators own field
validation and should start with synthetic data. The target workflow is documented
under [the mapping assistant](../architecture/ingestion.md#normalisation-and-the-mapping-assistant).

### Campaign scheduling and lifecycle are incomplete

Campaign correlation is deterministic and advisory, but the in-process scheduler
wakes every six hours without enforcing the configured hourly/daily/weekly/manual
cadence. It upserts campaigns returned by the latest trailing-window pass and does
not reconcile campaigns that have expired, split, or disappeared from that snapshot.

Treat campaigns as an exploratory related-case view in version 0.1. Dependable
scheduled operation requires scheduler leases/last-run state, enforcement of
`manual`, active-membership reconciliation without erased history, and coverage for
late cases, closed cases, split/merge, restart, and concurrent scheduler ownership.

### Connector-specific boundaries

- Syslog supports UDP and TCP; selecting `tls` currently does not enable encryption.
- S3 supports text formats and gzip, but not Security Lake OCSF Parquet.
- MQTT currently schedules processing from its client callback, so protocol
  acknowledgement can precede a successful ingest; exclude it from loss-intolerant
  evaluations until manual acknowledgement is implemented.
- Queue/cloud/object-store clients ship in the default `full` image but are absent
  from the explicitly lean `core` target; neither target implies live certification.
- Native pull/search connectors for Splunk, Sentinel, QRadar, Chronicle,
  CrowdStrike, SentinelOne, and Defender are reserved but not implemented.
- There is no published live-vendor, throughput, or long-duration soak matrix.

See the [source support matrix](../sources/support-matrix.md) for exact package and
protocol status.

### Deployment hardening is operator-owned

The Compose stack is an evaluation topology. Do not expose backend, database,
receiver, or web ports directly to the internet. Production work still needs a
trusted TLS ingress, network policy, secure-cookie/auth settings, credential
rotation, state backup/restore, log retention, monitoring, image scanning, and a
documented incident/upgrade procedure.

The project has not published a compliance certification or an independent
production security assessment for version 0.1.

## What is safe to evaluate

Use generated or non-sensitive data on one backend replica. Keep the original event
in a durable source, use least-privilege source credentials, enable authentication,
rotate default/demo credentials, and rehearse every documented upgrade or reset on a
backup before applying it to retained state.

Suitable evaluation goals include:

- UI and analyst workflow review;
- deterministic OCSF mapping checks;
- rule/correlation quality on replayable synthetic datasets;
- model quality and cost-ledger comparison;
- case provenance, audit, collaboration, and notification UX;
- fault-injection and performance work needed to close the blockers above.

Version 0.1 should not be marketed as lossless, horizontally scalable, production
certified, or independently assessed until the corresponding evidence is published.
