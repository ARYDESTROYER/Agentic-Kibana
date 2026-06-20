# AGNOSTIC_ARCHITECTURE.md — vendor-agnostic, self-hosted agentic SOC

> **Status:** design / proposal (approved direction, not yet implemented).
> **Owner decisions locked (2026-06-20):** canonical schema = **OCSF**; internal
> state = **decoupled from Elasticsearch (Postgres + pgvector)**; first new
> connector after ELK + OpenSearch = **Wazuh**; UI = **standalone web app**
> (retire the Kibana plugin).
>
> This document is the master plan for turning the TLSOC Agentic Triage Suite
> (today: an ELK/Kibana-coupled triage backend + Kibana plugin) into an
> **open-source, self-hosted, vendor-agnostic agentic SOC** that fetches alerts
> from any SIEM/EDR/XDR. It complements `CLAUDE.md` (process), `README.md`
> (overview) and `ROADMAP.md` (live tracking). Keep this in sync as we build.

---

## 1. Why this is smaller than it looks

A coupling audit of the current backend (see `Journal.md`, 2026-06-20) found that
**the reasoning/agent layer is already ~90% source-agnostic**:

- Every agent consumes a normalized **`RawEvent`** (`backend/app/models.py`), not
  raw Elasticsearch docs. `RawEvent.from_hit()` projects a hit into
  `(ip, user, host, rule, rule_name, severity, timestamp_millis)` using
  **operator-configurable field mappings** in `Preferences` (`config.py`), which
  already default to ECS but are not hardcoded.
- The tool layer (`tools/base.py`) is already **MCP-shaped** (`name`,
  `input_schema`, `run() -> ToolResult`); the `es_query` tool's *input* is a
  structured filter set (ip/user/host/rule/severity/contains/time), not raw DSL.
- The polling algorithm (`engine/poller.py`) relies only on "events have a
  monotonic timestamp + a stable id" — **not** on ES `search_after`. That is the
  most portable cursor shape there is.
- The cluster signature, correlation, risk gate, cost gate, case manager, and the
  router→investigator→formatter agents are all source-neutral.

The ELK coupling is therefore concentrated in **three seams**:

| Seam | State today | Difficulty | Target |
|---|---|---|---|
| **Log access / queries** | ES Query DSL passed straight through (poller, `es_query`, standup aggregations). No intermediate query model. | Hard | A query IR + a `LogSource` connector SPI each connector compiles |
| **Internal storage** | App's own state (cases/audit/usage/cursor/RAG) is 100% Elasticsearch; self-hosting *requires* an ES. | Medium | A `StateStore` abstraction → Postgres + pgvector |
| **UI is a Kibana plugin** | The whole frontend lives inside Kibana; outputs are KQL + Discover deep-links. | Conceptual | Standalone web UI served by the backend |

The third seam is the one the "make it agnostic" goal forces into the open: **if
the product requires the customer to run Kibana, it isn't agnostic.**

---

## 2. Target architecture

```
   Elastic   OpenSearch   Splunk   Sentinel   QRadar   CrowdStrike   Wazuh   syslog/Kafka/S3
      └──────────┴───────────┴─────────┴─────────┴──────────┴──────────┴────────┘
                          │  Connector SPI  (pull: poll() · push: subscribe())
                          ▼
                 ┌───── normalize → OCSF ──────┐     each connector owns its field-mapping
                 ▼
         [ ingest buffer:  in-proc queue now / Kafka|Redpanda later ]   decouples ingest from LLM
                 ▼
   dedup → correlate → risk-gate          deterministic; millions → tens happen HERE
                 ▼
   cheap router LLM → strong investigator (ReAct) → deterministic case manager
                 ▼
   StateStore  (Postgres + pgvector)        NOT a mandatory Elasticsearch
                 ▼
   Standalone web UI (reused React/EUI components)   ·   REST/streaming API   ·   (optional) MCP server
```

Two choices make the whole thing cohere: **OCSF as the internal lingua franca**
and a **pluggable connector SPI**.

---

## 3. Canonical schema — OCSF

Every connector normalizes its source-native records into **OCSF** (Open
Cybersecurity Schema Framework; Apache-2.0, Linux Foundation, ITU-track). The
engine and agents reason only over OCSF; raw vendor JSON never leaves the
connector.

**Why OCSF:** self-describing event classes (`category → class → type_uid →
activity_id`) give the LLM the semantics of an event *before* it reads a field —
the most LLM-friendly representation. Vendor-neutral governance. Broad ecosystem
(AWS Security Lake, OpenSearch Security Analytics, Tenzir, pySigma, Splunk via the
OCSF-CIM add-on).

**Plan:**
- Define an `OCSFEvent` Pydantic model, **pinned to a specific OCSF version**
  (store `ocsf_version` on every event; classes have been renumbered across minor
  versions). Wrap the 7 categories + the ~50 most-used classes first.
- `RawEvent` becomes a thin **projection over `OCSFEvent`** (keep the
  `ip/user/host/rule/severity/ts` accessors the agents already use, now reading
  OCSF paths: `src_endpoint.ip`, `user.name`, `severity_id`, `metadata`, …). This
  preserves the agent layer unchanged.
- Vendor fields with no OCSF home go in the first-class **`unmapped{}`** object.
  Document per-connector `unmapped` keys in a `mappings.yaml` and inject them into
  prompts **fenced as UNTRUSTED** (`unmapped` is attacker-influenceable log data —
  honours non-negotiable #9).
- **ECS migration:** the Elastic connector's `to_ocsf()` is essentially today's
  `RawEvent.from_hit()` extended with an ECS→OCSF field map (`event.action →
  activity_id`, `source.ip → src_endpoint.ip`, `event.severity → severity_id`,
  …). Original ECS fields are preserved under `unmapped`/`raw` during transition.

---

## 4. Connector SPI — "add the SIEM you wish"

Connectors are **pluggable, community-extensible units**, synthesising the
strongest prior art: pySigma's entry-point registry (discovery) + Cortex's
manifest contract (the unit) + StackStorm's pack layout (packaging) + OCSF as the
shared type (Tenzir).

**Interface:**

```python
class SourceConnector(ABC):
    async def test_connection(self, config: dict) -> bool: ...   # for the "add a source" wizard
    async def authenticate(self, config: dict) -> None: ...
    # PULL sources (Elastic, OpenSearch, Splunk, Sentinel, QRadar, Chronicle,
    # SentinelOne, Wazuh-indexer, Defender-hunting):
    async def poll(self, cursor: Cursor) -> tuple[list[OCSFEvent], Cursor]: ...
    async def search(self, q: StructuredQuery, time_range) -> list[OCSFEvent]: ...  # backs the agent's es_query tool
    # PUSH sources (Kafka, syslog, CrowdStrike streams, Event Hub, webhooks):
    def subscribe(self, handler) -> Subscription: ...
    # NORMALIZATION (always):
    async def to_ocsf(self, raw: dict) -> OCSFEvent: ...
```

**Discovery (no core changes to add a source):**

```ini
# a connector package's setup.cfg
[options.entry_points]
tlsoc.connectors =
    elastic    = tlsoc_connector_elastic:ElasticConnector
    opensearch = tlsoc_connector_opensearch:OpenSearchConnector
    wazuh      = tlsoc_connector_wazuh:WazuhConnector
```

The engine enumerates `importlib.metadata.entry_points(group="tlsoc.connectors")`
at startup. Community connectors install via `pip install
tlsoc-connector-<vendor>`. Each connector is a directory/package with
`connector.json` (manifest: name, version, source_type, auth schema, capabilities),
`connector.py` (the subclass), `mappings.yaml` (field map + `unmapped` docs),
`requirements.txt`, `tests/`.

**Query IR (`StructuredQuery`):** promote the implicit filter set already in the
`es_query` tool input into a typed IR. Each connector compiles it to its dialect
(ES/OpenSearch DSL, SPL, KQL, AQL). This also removes the current dual-dialect
duplication (DSL for execution + hand-built KQL for the Discover link). Standup
**aggregations** are the hardest to translate and may degrade gracefully
(client-side aggregation) on connectors that can't push them down.

**Auth** the framework must cover: API key (Elastic/SentinelOne/QRadar), OAuth2
client-creds (CrowdStrike/Microsoft), Google service-account JSON (Chronicle),
AWS SigV4 (OpenSearch-on-AWS / Security Lake), short-lived JWT w/ refresh
(Wazuh). Secrets stay **env/secret-manager only** (non-negotiable #10); the UI
shows `configured ✓`, never values. The read-only-scope principle
(non-negotiable #1) generalises: every connector authenticates with a
least-privilege, read-only credential.

**Optional MCP transport (additive, later):** expose `search`/`poll` as MCP tools
so any MCP-capable agent can use connectors. Treat every MCP/connector result as
untrusted input (fence it); 30+ MCP-server CVEs landed in early 2026.

---

## 5. Data ingestion — how data gets here

Sources split into two natures; the SPI supports both:

- **Pull** — poll a search API on a durable cursor (Elastic, OpenSearch, Splunk,
  Sentinel/Log Analytics, QRadar Ariel, Chronicle, SentinelOne, Wazuh-indexer,
  Defender hunting). This is what the poller already does.
- **Push** — receive a stream/webhook/queue (Kafka, syslog, CrowdStrike Event
  Streams, Sentinel/Defender → Event Hub, Wazuh integratord, Splunk
  saved-search webhooks).

**Cursor/checkpoint** has three shapes; persist the cursor **after** a batch is
fully processed, and dedup downstream by event id (at-least-once):
1. **Timestamp watermark + tiebreaker id** — ES `search_after`, Splunk
   `earliest_time`, QRadar `STARTTIME`, KQL `TimeGenerated >`. *The poller already
   uses this.* Add a small lookback overlap to catch late/indexing-lagged events.
2. **Opaque token** — `@odata.nextLink`, SentinelOne `nextCursor`, ES PIT id.
   Session-scoped, **not durable across restarts** — always keep a timestamp
   fallback.
3. **Queue offset** — Kafka, Event Hub, CrowdStrike stream offset. Truly durable;
   commit after processing.

**Normalization happens inside the connector** (`to_ocsf`), so the engine only
ever sees OCSF. Errors in a connector or normalization route the record to a
dead-letter path + `NEEDS_HUMAN` — **never silently dropped** (non-negotiable: an
error must not lose an alert).

**Source rollout:** ELK + **OpenSearch** first (OpenSearch's API is
ES-7.10-compatible → ~a rename + auth swap of the Elastic connector; proves the
abstraction cheaply). Then **Wazuh** (open-source, free to stand up; its indexer
*is* OpenSearch, so it reuses that connector plus an alert→OCSF mapper). Then
Splunk / Sentinel / CrowdStrike as demand dictates.

---

## 6. Scaling — millions of logs/day

The mental model: **the LLM never sees logs — it sees incidents.** Volume
collapses through a deterministic funnel *before* any model call:

```
~10M–10B raw events    the source SIEM already turns these into alerts (NOT our job)
~10K–100K alerts/day   dedup + suppress              40–60% gone
~500–5K incidents      deterministic correlate       10–30× collapse
~50–500 candidates     deterministic risk gate       auto-close below threshold
~10–200/day            cheap router LLM → strong investigator for the subset
~1–20/day              true positives → humans
```

Grounding: ~67% of SIEM alerts go uninvestigated today; an IBM study of 115M
alerts found ~0.01% were real compromises. The funnel is the entire game — and
the suite already has it (correlation, risk gate, router→investigator, and the
**aggregate-then-summarise, never raw logs to a model** rule, non-negotiable #7).

**Build now (handles <~50K alerts/day):** durable-cursor poller; Redis dedup;
deterministic correlate + risk gate; model tiering (cheap router + strong
investigator); one LLM gateway + cost ledger; `max_tokens` on every call; a
**daily budget circuit-breaker** (over budget → downgrade model → route to
`NEEDS_HUMAN`, never drop); prompt caching (structure the system prompt as a
stable prefix → ~90% off cached tokens).

**Build later (>100K/day or multi-tenant):** **Kafka/Redpanda** ingest buffer in
front of the engine (back-pressure: slow LLM workers fall behind and catch up,
ingest never blocks); **stateless workers** partitioned by tenant/source pulling
from the queue; **semantic caching** of similar incidents (30–60% hit rate on
repetitive alerts → large cost cut); **batch API** for low-urgency cases (~50%
off); usage/audit analytics → **ClickHouse**; per-tenant virtual keys + budgets
(e.g. via a LiteLLM proxy) for multi-tenant.

**Never:** re-store raw logs in the app (leave them in the source SIEM; keep only
references + the normalized incident + agent artifacts); per-alert LLM calls (if
you call the LLM per alert, the funnel is broken).

Reassurance: at small scale the LLM bill is ~$0.30–$1.50/day. The cost machinery
matters at thousands of incidents/day — it's a "later," not a "now."

---

## 7. Internal state — off Elasticsearch (Postgres + pgvector)

So self-hosting doesn't require running an ES, introduce a **`StateStore`**
abstraction (semantic methods, not `search(index, body)`):

- `CaseRepository` — `find_open_by_signature`, `list(filters)`, `upsert`, counts.
  Today's bool/term/range/sort queries map directly to SQL `WHERE`/`ORDER BY`.
  Idempotency key = `case_signature` (the existing cluster signature).
- `AuditRepository` — append-only table + `WHERE case_id ORDER BY ts`.
- `UsageRepository` — append table + `SELECT … WHERE ts >=` (usage already
  aggregates in Python today → easy).
- `KVStore` — config + cursor (single-doc gets/puts → trivial rows).
- **RAG** — implement the existing `VectorStore` ABC on **pgvector** (the ABC and
  a dynamic-selection wiring point already exist in `state.py`).

The ES implementation is kept as an optional backend; **Postgres + pgvector is the
default** for a clean single-container self-hosted deploy. Preserve the audit
append-only invariant (#2) and the read-only/scoped credential split philosophy
(#1) across the move.

---

## 8. UI — standalone web app (retire the Kibana plugin)

An agnostic product can't assume Kibana. Promote the existing React/EUI surfaces
(Chat · Investigate · Scans · Standup · Cost · Settings/Wizard) into a
**standalone single-page app served by the backend**, talking to the existing
FastAPI contract directly (the backend already owns its API; the Kibana server
proxy goes away). Consequences:

- Query-dialect-in-output (KQL `reproduce_query`, Discover deep-links,
  `meta.language="kuery"`) becomes **per-source**: render the *source's* native
  query language and a deep-link to *that* product's UI (Discover for Elastic, SPL
  search for Splunk, etc.) — driven by the active connector.
- EUI is usable outside Kibana (`@elastic/eui` standalone) so the component
  refresh and design system (`public/components/ui.tsx`, `public/lib/format.ts`,
  `public/index.scss`) carry over with little change. Confirm licensing/build for
  standalone EUI early.
- The **"add a source" wizard** becomes central: pick connector → enter config →
  `test_connection()` → save. This is the product's front door.

---

## 9. Phased roadmap (high level — tracked live in `ROADMAP.md`)

- **Epoch A — Decouple internal state (Postgres + pgvector).** `StateStore` SPI +
  Postgres impl + pgvector RAG; keep ES impl behind the abstraction. Unblocks
  ES-free self-hosting. *(Medium; do first — highest "self-hostable" payoff,
  contained blast radius.)*
- **Epoch B — Connector SPI + query IR + OCSF.** `OCSFEvent`; `RawEvent` as a
  projection over OCSF; `StructuredQuery` IR; `LogSource`/`SourceConnector` SPI +
  entry-point registry; refactor `es_query`/poller/standup onto it. Ship the
  **Elastic** connector (parity) + **OpenSearch** connector. *(Hard; the
  query-IR + DSL-removal is the riskiest refactor — keep `pytest -q` green at
  every step.)*
- **Epoch C — Wazuh connector.** Reuse the OpenSearch connector for the Wazuh
  indexer + an alert→OCSF mapper. Proves third-party breadth.
- **Epoch D — Standalone web UI.** Stand up the SPA from existing components;
  per-source query rendering + deep-links; the "add a source" wizard; retire the
  Kibana plugin (or demote to optional embed if we reverse course).
- **Epoch E — Scale-out (as needed).** Kafka/Redpanda buffer; stateless workers;
  semantic cache; batch API; multi-tenant keys/budgets; ClickHouse analytics.

Every epoch ends with: `pytest -q` green, offline build verified, docs + Journal
updated, commit + push. The 12 non-negotiables in `CLAUDE.md` still hold —
notably read-only scoped source access (#1), full audit (#2), LLM-verdict /
deterministic-close (#3), durable no-skip/no-dup cursor (#4), one LLM gateway +
ledger (#6), aggregate-then-summarise (#7), untrusted-data fencing (#9, now also
covering OCSF `unmapped`).

---

## 10. Risks & open questions

- **Query-IR translation correctness** (riskiest): the cost-gate's query-time
  scope filtering, the cursor's inclusive-lower-bound + same-millisecond dedup,
  and aggregations must survive translation to each dialect *exactly*. Aggregations
  may need graceful client-side fallback per connector.
- **OCSF version drift & `unmapped` opacity** — pin a version, store it per event;
  document `unmapped` keys per connector; fence them in prompts.
- **Licensing** — keep core Apache-2.0; ship connectors as separate packages
  (GPL/AGPL connectors must not be bundled into the core). Connectors are thin REST
  clients against vendor APIs (permitted) — do **not** derive from vendors'
  proprietary SDKs/MCP apps (e.g. Elastic's MCP security app is Elastic-2.0). Use
  descriptive, non-endorsing names + "not affiliated" disclaimers.
- **Standalone EUI** build/licensing outside Kibana — validate early.
- **Naming/branding** — "TLSOC … Kibana" branding is ELK-specific; an
  open-source agnostic product likely wants a neutral name. Deferred.
