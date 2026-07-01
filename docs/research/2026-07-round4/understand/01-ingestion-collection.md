# Round 4 — Domain Map: Ingestion & Collection

Domain: **sources, poller, connectors, OCSF, ES clients, feeds, receivers, live-tail, GET /api/logs**.
This is GROUND ZERO for Round-4 bug **#1 (single-source poller → PollerManager fan-out)** and the primary
attach site for **#5 (two-tier alert/event + agent-driven event detection)** and **#8 (unified GET /api/logs)**.

> Verified against source 2026-07-01 on branch `Testing`. Line numbers are anchors, not guarantees — re-grep before editing.

---

## 1. How ingestion works today (end to end)

There are **two ingestion paths** that both funnel into ONE shared correlate→case path
(`engine/ingest.handle_clusters`), so PULL and PUSH behave identically:

### 1a. PULL path (the poller) — THE BUG LIVES HERE
```
AppState._wire (state.py:124)
  → self.log_source = self._build_log_source()          # state.py:203 — ONE connector from prefs.primary_source()
  → self.poller = Poller(es, cases, cursor_store, audit, pipeline, get_prefs, source=self.log_source)  # state.py:218
AppState.startup(start_poller=True) (state.py:716)
  → self.poller.start()   (state.py:758)                # background asyncio loop
Poller._run (poller.py:276)  [background loop]
  gate: prefs.polling_enabled AND prefs.setup_complete AND NOT caps.kill_switch AND NOT demo_active  (poller.py:287)
  → poll_once(prefs) (poller.py:157) every max(5, poll_interval_seconds)s
Poller.poll_once (poller.py:157):
  feeds = self._source_feeds()                          # connector.feeds() — enabled, non-ignore
  IF feeds:  per-feed loop (poller.py:178)
     key = _cursor_key(prefs, feed.id) = f"{source.connector_id}:{feed.id}"   (poller.py:116)
     fcursor = cursor_store.load_keyed(key)             (cursor_store.py:41)
     scan = _poll_feed_scan(...) → connector.poll_feed_scan → FeedScan(events, scan_max_ts, scan_boundary_ids)
     advanced = advance_cursor_to(fcursor, scan.scan_max_ts, scan.scan_boundary_ids)   # watermark advance (poller.py:51)
     new_events += [e for e in scan.events if not fcursor.should_skip(e)]
  ELSE (legacy/un-fed source):  single 'primary'-keyed union path (poller.py:201-205)
     cursor = cursor_store.load(); fetched = source.poll(prefs, cursor, cold_from)
     feed_state.append(("primary", cursor, advance_cursor(cursor, fetched)))
  IF new_events:
     lookback_ms = _correlation_lookback_seconds(prefs)*1000   # widest rule window + 2*interval slack (poller.py:96)
     window_fetched = source.poll(window_cursor, window_from)   # SECOND read-only correlation window (poller.py:226)
     window_events = dedup_by_id(window_fetched + new_events)
     strategy = prefs.entity_strategy_for(prefs.primary_source())          # ← BUG: always the PRIMARY (poller.py:232)
     clusters = correlate(window_events, prefs, entity_strategy=strategy)
     handle_clusters(clusters, prefs, cases, pipeline, source_surface=AUTOMATED_SCAN)   # SHARED ingest
     IF prefs.cross_source_correlation.enabled: link_cross_source(clusters, ...)        # opt-in RELATED, never merges
  persist EACH feed's advanced cursor via cursor_store.save_keyed(key, cursor)  (poller.py:257) — only when changed
  audit ActionType.POLL (actor='poller', surface='poller')   (poller.py:263)
```

### 1b. PUSH path (receivers) — already multi-source
`AppState._start_receivers` (state.py:784) iterates `prefs.sources` where `src.enabled AND reg.is_receiver(src.source_type)`,
skips `PUSH_HTTP` (route-driven), builds `cls(config=effective, connector_id=src.id)`, and starts a guarded asyncio task
whose `_emit` calls `self._real_ingest_service.ingest(events, prefs, source_id=src.id)`. **One bad source is logged + skipped**
(state.py:820) — this is the exact per-source isolation pattern a PollerManager must mirror for PULL. Receivers feed a
**live-tail ring** (`IngestService._recent`, cap 500/source, `recent_events_for_source`).

### 1c. Connector layer (`ElasticConnector`, the reference PULL connector)
- Wraps a `BaseESClient`; **all reads go through `es.search_logs(index, body)` — the read-only `_ro` client (#1)**.
- `feeds()` (elastic.py:517) = enabled, non-ignore `IndexPattern`s from `config["index_patterns"]`.
- `poll_feed_scan` (elastic.py:536): builds `poll_query(fp, cursor, from_millis)`, applies the feed's operator `query`
  as a `query_string` filter, reads, computes `_scan_watermark` over **ALL scanned hits** (kept+dropped), keeps only hits
  this feed `_owns_index` (longest-pattern-wins), maps kept via `RawEvent.from_hit`, and `_tag_events`.
- `_tag_events` (elastic.py:251): stamps `ev.source_id = self.connector_id`, `ev.source_name`, `ev.feed_id`,
  `ev.index_role` (alerts/events), and sets `ev.auto_investigate_eligible=False` when below `severity_floor`
  (OCSF severity_id 1-6 comparison via `score_to_severity_id`) — **below-floor is NEVER dropped**, only marked ineligible.
- `test_connection` (elastic.py:703): does NOT gate on `ping()` (a scoped RO key cannot `HEAD /`); a cheap scoped read is
  authoritative (`ok:true, mode:"read_only"`), `ping()` is only an extra `cluster_monitor` signal (`mode:"full"`).

---

## 2. Exact symbols / files / wire keys / endpoints

### Files
| File | Role |
|---|---|
| `backend/app/state.py` | DI hub. `_wire` (:124), `_build_log_source` (:630), `es_client_for_source` (:600), `_source_es_overrides` (:1097), `_set_owned_log_client`/`_schedule_close` (:617/:623), `rebuild_log_source` (:689), `startup` (:716), `_start_receivers` (:784), `apply_secrets` (:861), `_build_es_client` (:1199). **poller built at :218; log_source built at :203.** |
| `backend/app/engine/poller.py` | `Poller` (:72), `poll_once` (:157), `_cursor_key` (:116), `_source_feeds` (:126), `_poll_feed_scan` (:137), `advance_cursor` (:36), `advance_cursor_to` (:51), `_run`/`start`/`stop` (:276/:297/:301). |
| `backend/app/connectors/elastic.py` | `ElasticConnector` + `FeedScan` (:46), `feeds` (:517), `poll` (:487), `poll_feed`/`poll_feed_scan` (:526/:536), `_tag_events` (:251), `_feed_for_index`/`_owns_index` (:235/:593), `test_connection` (:703). |
| `backend/app/connectors/registry.py` | `is_pull` (:117), `is_receiver` (:121), `get` (:48), `manifests` (:103), `_with_browse` (:52 — auto-adds `browse` cap to receivers). |
| `backend/app/connectors/base.py` | `PullConnector`/`PushReceiver`/`Connector` SPI, `ConnectionTest`, `ConnectorManifest`, `StructuredQuery`. |
| `backend/app/es/client.py` | `RealESClient._ro` (:47-50) / `_mgmt` (:48-54) — **the two physically separate connections (#1)**. `search_logs` → `_require_ro` (:64/:91). |
| `backend/app/stores/cursor_store.py` | `CursorStore.load/save` (alias of `load_keyed('primary')`), `load_keyed`/`save_keyed`, `_doc_id` (:21 — `''`/`'primary'` → `CURSOR_DOC_ID='primary'`, else `feed:<safe>`). |
| `backend/app/engine/ingest.py` | `handle_clusters`, `dedup_by_id`, `attach_cluster`, `link_cross_source`, `IngestService` (live-tail ring + push entry). |
| `backend/app/engine/correlation.py` | `correlate(events, prefs, entity_strategy=)` — the clustering fn. |
| `backend/app/api/routes.py` | `source_logs` GET `/sources/{id}/logs` (:512), `_log_row` (:492), manual poll GET `/poll` (:3987 → `state.poller.poll_once`), `_ACTION_STATUS` (:3127). |

### Config / model wire keys (do NOT rename — aliased at most)
- `SourceInstance` (config.py:1312): `ingest_mode: IngestMode = PULL`, `is_primary: bool = False` (:1315), `enabled`, `config`, `.feeds()` (:1348), `.index_patterns()` (:1321), `.auto_correlate()` (:1377).
- `Preferences.primary_source()` (config.py:1849): `is_primary` enabled → first enabled → `None`. **Keep signature + fallback order.**
- `Preferences.entity_strategy_for(source)` (config.py:1839) — per-source, must be called with THAT source in a fan-out.
- Feed (`IndexPattern`) config key = `config["index_patterns"]`; per-source override keys = `config["auto_correlate"]`, `config["data_view_pattern"]`, `config["entity_strategy"]`, `config["field_mappings_extra"]`.
- Cursor key format: **`f"{source.id}:{feed.id}"`**; legacy fallback `"primary"` → ES doc id `CURSOR_DOC_ID="primary"` (constants.py:38).
- `IngestMode` (constants.py:481): `PULL="pull"`, `PUSH_HTTP`, `PUSH_SYSLOG`, `PUSH_SOCKET`, `QUEUE`, `OBJECT_STORE`, `STREAM`.
- `IndexRole`: `events`/`alerts`/`ignore` (ignore is the only role dropped at ingest; alerts → per-alert auto-forward).

### Endpoints (domain)
- `GET /api/sources/{id}/logs?limit=&query=&from=&to=` (routes.py:512, perm `sources:read`) — PULL: bounded scoped search via `es_client_for_source`; PUSH: `recent_events_for_source` ring; `demo` special-cased. Row shape `_log_row`: `{id, ts, source_ip, user, host, rule, severity, message, _raw}` — **secrets never returned**.
- `GET /api/sources/{id}/feeds` (routes.py:589).
- `GET /api/poll` (routes.py:3987) → `state.poller.poll_once(state.prefs)` — manual trigger.

---

## 3. Round-4 bugs — exact fix surface (this domain owns #1; #8 attaches here)

### Bug #1 — single-source poller (THE domain-defining fix)
**Where:** `state.py:203` (`self.log_source = self._build_log_source()`, one connector from `prefs.primary_source()`) and
`state.py:218` (`self.poller = Poller(..., source=self.log_source)`). Only the primary enabled PULL source is ever
polled/correlated/triaged; every other enabled PULL source is silently never polled. `poller.py:232` also hardcodes
`prefs.entity_strategy_for(prefs.primary_source())`.

**Fix shape (a `PollerManager` that owns N per-source pollers):**
1. Enumerate PULL sources = `prefs.sources` where `src.enabled AND (registry.is_pull(src.source_type) OR src.ingest_mode==IngestMode.PULL)`.
   - Discriminator note: use **`registry.is_pull(src.source_type)`** (registry.py:117 — `issubclass(cls, PullConnector)`) as the
     authoritative check; `src.ingest_mode==PULL` is the config-declared intent. They agree for built-ins; prefer `is_pull`
     and skip receivers (`is_receiver`) so PUSH stays handled by `_start_receivers` — **never double-handle receivers**.
2. Build each source's connector exactly like `_build_log_source` (state.py:630): `es_client_for_source(src)` → OpenSearch/Wazuh/Elastic
   with `connector_id=src.id` and `display_name` threaded into `cfg`. **Track + close ALL owned clients** (today only `_owned_log_client`,
   ONE, is tracked — a manager leaks unless it mirrors `_set_owned_log_client`/`_schedule_close` for N).
3. Reuse `Poller` as the per-source unit (it is already fully parameterised by `self._source`). Each already fans out over its own
   feeds on `{source.id}:{feed.id}` cursors and has per-feed try/except isolation (poller.py:185). Add **per-source try/except**.
4. Inside `poll_once`, change `prefs.entity_strategy_for(prefs.primary_source())` → `prefs.entity_strategy_for(THAT source)` (poller.py:232).
5. **Single-poll fallback:** with 0/1 enabled PULL sources, behave byte-identically to today's single `Poller` (so all existing
   cursor/attach tests pass).
6. **`primary` shrinks to the default read/browse/chat surface only:** `self.log_source` must STILL be the primary connector
   (feeds `_real_pipeline._source`, `_real_chat_engine._source`, es_query tool). `rebuild_log_source` (state.py:689) keeps re-pointing it.
7. **Gate ALL children** on the same flags the `Poller._run` loop checks: `polling_enabled`, `setup_complete`, `not caps.kill_switch`,
   **`not demo_active`** (poller.py:287). Real pollers stay OFF during demo.
8. Preserve the poller lifecycle interface used externally: expose `start()`/`stop()`/`poll_once(prefs)`/`_source` (see §5). The manual
   `/poll` route (routes.py:3987) and `apply_secrets` (state.py:878/891) call `state.poller.stop()/.start()`.
   `apply_secrets` on ES-credential change calls `self._wire()` — rebuild the manager there.
9. New concurrency cap: `CapsConfig` has **no `max_concurrent`** field today (config.py); add one for fan-out (additive, defaulted).

### Bug #3 — Acknowledge maps to None (NOT this domain, but adjacent)
`routes.py:3136`: `"acknowledge": None` in `_ACTION_STATUS` → change to `CaseStatus.INVESTIGATING`. `INVESTIGATING` is non-terminal,
reached only via the analyst layer, never `decide()`. Do NOT add `acknowledge` to `_CLOSE_ACTIONS` (:3143) nor `INVESTIGATING` to
`_TERMINAL` (:3147).

### Bug #2 — LLM pricing (NOT this domain)
Lives in `llm/pricing.py` + `llm/model_registry.json`; nothing in ingestion.

### Feature #8 — GET /api/logs scatter-gather (attaches HERE)
Add a new `GET /api/logs` that fans out over browse-capable sources: reuse the exact per-source pattern already in
`source_logs` (routes.py:554) — `es_client_for_source(src)` per PULL source (close `owned` clients) + `recent_events_for_source`
per PUSH source. Gate on the `browse` capability (`registry.manifest(...).capabilities`; receivers auto-get `browse` via
`_with_browse`, registry.py:52). Return the same `_log_row` shape merged across sources.

### Feature #5 — two-tier + agent-driven event detection (attaches HERE)
- ALERT feeds already auto-forward per-alert through `handle_clusters` (alerts-role gate). The daily CAMPAIGN pass is a natural
  extension of `link_cross_source` (RELATED-only, never changes `cluster_signature`).
- EVENT-feed batched agent detection must create candidate clusters that re-enter the **same** `correlate → handle_clusters →
  pipeline` path (so they get the same `cluster_signature` + run `decide()` unchanged). Note: `poll_once` re-runs the wide
  correlation-window read whenever `new_events` is non-empty (poller.py:217) — keep high-volume EVENT feeds OUT of that realtime
  read (route them to the batch path).

---

## 4. Invariants this domain enforces (and exactly where)

- **#1 (two physically-separate ES clients).** `RealESClient._ro` (es_api_key, read-only `all-logs-*`) vs `_mgmt` (es_mgmt_api_key,
  `tlsoc-agent-*`) — client.py:47-54. Log reads go only through `search_logs` → `_require_ro` (client.py:91). Per-source clients are
  built by `es_client_for_source` (state.py:600) which **FORCES `overrides["es_mgmt_api_key"]=None`** (state.py:609) so a per-source
  log client can NEVER get a mgmt key. A PollerManager MUST build per-source clients via `es_client_for_source` — never hand-roll a
  `RealESClient` with a mgmt key.
- **#3 (decide() is the sole close authority).** The poller/ingest path NEVER imports `case_manager.decide`; it only calls
  `pipeline.investigate_cluster` (LLM verdict → later feeds decide) or `pipeline.register_candidate` (no verdict, $0). NEEDS_HUMAN
  candidates register OPEN. Fan-out must add no status/disposition logic.
- **#4 (no-skip/no-dup cursor + byte-identical cluster_signature).** `Cursor` = inclusive lower bound + `boundary_ids` dedup;
  `advance_cursor`/`advance_cursor_to` union same-ms boundary ids (poller.py:36/51). Per-feed cursor advances over the FULL SCANNED
  watermark (`FeedScan.scan_max_ts/scan_boundary_ids`, elastic.py:46), never only kept events. Cursor keys `{source.id}:{feed.id}`
  are already collision-free across sources because each connector has a distinct `connector_id`. `cluster.source_id` attribution
  chain: `_tag_events` stamps `ev.source_id=connector_id` → `correlation` sets `cluster.source_id` → `ingest._auto_correlate_allowed`/
  `_is_ignored_cluster` gate per source. **A per-source poller MUST build its connector with `connector_id=src.id`** or per-source
  auto_correlate/ignore/severity_floor gates silently break.
- **#6 (one LLM ledger).** The poller makes NO LLM calls; all model use is inside the SHARED `_real_pipeline` (one gateway,
  state.py:144). Fan-out pollers SHARE `_real_pipeline`/`_real_cases`/`_real_audit`/`cursor_store` — do NOT give per-source pollers
  their own gateway or pipeline.
- **#9 (untrusted fencing).** `RawEvent` fields (ip/user/host/rule/message/severity/index) + OCSF `unmapped`/`raw_data` are UNTRUSTED.
  Ingestion only routes them (never prompts). A feed's operator `query` is TRUSTED config but still never interpolated into a prompt
  (elastic.py:602). `_log_row` returns only log fields — never secrets.

---

## 5. Contracts a refactor MUST preserve (byte-identical or aliased)

1. **`Poller.__init__(es, cases, cursor_store, audit, pipeline, get_prefs, source=None)`** (poller.py:72) — reused verbatim by
   `_wire` (state.py:218) and by `test_source_feeds.py:37`. A PollerManager should COMPOSE Pollers, not fork the class.
2. **`state.poller` must expose `.start()`, `.stop()` (async), `.poll_once(prefs)` (returns the stats dict), `._source`**. Callers that
   break otherwise: `routes.py:259,672` (`state.poller.start()`), `routes.py:3987` (`poll_once`), `state.py:697` (`poller._source=` in
   `rebuild_log_source`), `state.py:758,891` (`start`), `state.py:878,1065` (`stop`), and tests `test_cursor_poller.py`,
   `test_source_feeds.py` (`poll_once`), `test_state_backend_e2e.py` (`poll_once()` no-arg), `test_attach_note.py` (`poller._attach`).
   → Easiest: keep `state.poller` as a single manager object that also proxies these to the primary child (or expose them on the manager).
3. **Cursor key format** `f"{source.id}:{feed.id}"` + legacy `"primary"` fallback (`_cursor_key` poller.py:116, `_doc_id`
   cursor_store.py:21). An existing single-source cursor MUST keep reading the legacy `primary` doc (no migration, #4).
   Two un-fed sources both taking the legacy path would BOTH write the single `primary` cursor doc → **collision** (see §6).
4. **`CursorStore` SPI:** `load()`/`save()` (alias `load_keyed('primary')`), `load_keyed(key)`/`save_keyed(key, cursor)` signatures
   round-trip keys like `srcA:fast`.
5. **`advance_cursor` (batch) vs `advance_cursor_to` (watermark) are NOT interchangeable** — the feed path MUST use
   `advance_cursor_to` over the scanned window or a broad feed skips its own newer events forever.
6. **`es_client_for_source` (state.py:600) returns `(client, owned)`** and drops the mgmt key; a manager must track+close ALL owned
   clients (mirror `_set_owned_log_client`/`_schedule_close` for N).
7. **`self.log_source` stays the primary read/browse/chat surface** feeding `_real_pipeline._source`, `_real_chat_engine._source`,
   es_query. `rebuild_log_source` keeps re-pointing it (state.py:689).
8. **Demo isolation:** while `prefs.demo.active`, every real poller stays OFF (gate in `_run`, poller.py:287). Demo uses a SEPARATE
   `DemoSimulator`/`DemoStack` (no poller) surfaced via the active-store `@property` indirection (state.py:84-122).
9. **Connector SPI:** `PullConnector.poll/feeds/poll_feed/poll_feed_scan` + `FeedScan(events, scan_max_ts, scan_boundary_ids)` shape.
   New PULL sources must implement them.
10. **`ConnectionTest`** gained `mode`/`cluster_monitor`; test_connection stays ping-independent for RO keys (elastic.py:703).
11. **`handle_clusters(..., source_surface=SourceSurface.AUTOMATED_SCAN)`** call shape shared with push receivers — keep it.
    `IngestService(cases, audit, pipeline, get_prefs)` constructor is reused by `demo_runtime.py` — keep it.

---

## 6. Risks / gotchas

- **`_source` mutation:** `rebuild_log_source` sets `poller._source = self.log_source` directly (state.py:697). A manager must
  re-point ALL per-source children consistently on rewire, and keep a `._source` attribute pointing at the primary for compatibility.
- **Legacy-cursor collision (real #4 hazard):** an un-fed source (only `data_view_pattern`, no `index_patterns`) takes the legacy
  union path → cursor key `"primary"` → ES doc `CURSOR_DOC_ID`. TWO un-fed sources under a naive fan-out would BOTH write the same
  `primary` doc and stomp each other. The manager MUST give each non-default source a distinct key even on the legacy path (e.g.
  fall back to `f"{source.id}:primary"` for non-primary un-fed sources; keep the true primary on `"primary"` for no-migration).
- **`_build_log_source` may fall back to `ElasticConnector(self.es)`** when `primary_source()` is None, and `self.es` may be an
  `InMemoryESClient` in no-key deployments. Fan-out enumeration must handle sources whose `es_client_for_source` falls back to
  `self.es` without duplicately polling the same physical index.
- **Owned-client leak:** `es_client_for_source(src)` returns `owned=True` clients the caller must close; today ONE is tracked. Fan-out
  over N sources leaks connections unless ALL owned clients are tracked + closed on rewire/shutdown.
- **`severity_floor` unit trap:** it is OCSF `severity_id` (1-6); raw native severity (0..100 / 0..10) must be mapped via
  `score_to_severity_id` before comparison (elastic.py:284). Any new severity_floor consumer (auto-tuner #4) must use the same mapping.
- **Second correlation read cost:** `poll_once` re-reads the full lookback window (`source.poll` over `_correlation_lookback_seconds`)
  whenever `new_events` is non-empty (poller.py:217-226). For a batched high-volume EVENT feed (#5) this is expensive — the two-tier
  design should keep EVENT feeds OUT of this realtime read.
- **`main.py` builds a SECOND `Secrets()` at import time** (line ~56, `_sec`) for middleware toggles, separate from the lifespan
  `Secrets`. Keep in mind when reasoning about which secrets object drives what.
- **cross_source linking within one tick:** fanning out means `link_cross_source` may now see clusters from multiple sources in one
  manager tick — verify it still only links across DISTINCT `source_id`s (a single source's own clusters never self-link).
- **`is_pull` vs `ingest_mode`:** `registry.is_pull` is class-based (authoritative); `SourceInstance.ingest_mode` is config-declared.
  A source configured with `ingest_mode=PULL` but a source_type whose class is a receiver would disagree — trust `is_pull`.
