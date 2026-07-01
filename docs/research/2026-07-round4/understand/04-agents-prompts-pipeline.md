# Round-4 Understand — Domain 04: Agents, Prompts, Pipeline, Knowledge

Scope: the LLM-facing spine — the investigation pipeline, the LangGraph flow, the
router/investigator/formatter roles, the ONE chat engine, the prompt-injection seam
(`prompts.py` #9), the RAG knowledge service, personas, and the standup aggregate
seam. Emphasis: **#9 fencing precedence**, **#5 one chat engine**, **#7
aggregate-then-summarise**, the **SSE decision-frame-after-save** ordering, and
where **Round-4 #5 batched EVENT agent-detection + the daily CAMPAIGN pass** will
plug in.

Files (all absolute):
`backend/app/agents/{prompts,pipeline,graph,investigator,router,formatter,chat,common,personas,standup}.py`,
`backend/app/tools/rag.py`, `backend/app/realtime.py`.

---

## 1. How it works today (end-to-end)

### 1.1 The ONE spine (`agents/pipeline.py` — `InvestigationPipeline`)
Every surface (poller / automated scan / manual investigate) funnels a `Cluster`
through the SAME method so behaviour is identical + auditable. Two entrypoints:

- **`register_candidate(cluster, source_surface, prefs)`** (pipeline.py:435) —
  **ZERO LLM cost**. Deterministic risk only (`compute_risk(cluster, prefs, 0.0)`),
  creates/refreshes an OPEN candidate `Case` (`verdict=None`,
  `status=CaseStatus.OPEN`), idempotent by `cluster.signature` via
  `find_open_by_signature`. Audits `ActionType.POLL`, actor `poller`. This is the
  **agent-EVENT-detection insertion point** for Round-4 #5 (see §3.5).
- **`investigate_cluster(cluster, source_surface, prefs, *, force, force_playbook_id)`**
  (pipeline.py:215) — the paid path. Sequence:
  1. `find_open_by_signature(cluster.signature)` → **P1 stability guard**
     (pipeline.py:237): an already-investigated OPEN case (`verdict is not None`)
     with **no new member event ids** and `force=False` is returned **UNCHANGED, no
     LLM calls** (stops poll/attach verdict drift). Audits `ActionType.DECISION`.
  2. `_emit_step(case_id, "router", …)` SSE frame (best-effort narration).
  3. `_build_investigator(prefs)` → `ToolRegistry([EsQueryTool(self._source, prefs),
     EnrichTool, RagTool])` + `Formatter` + `Investigator`.
  4. **Enrichment + risk**: IP-only + `prefs.enrichment.enabled` →
     `enrich.enrich_ip(value).reputation_score`; then
     `compute_risk(cluster, prefs, reputation)` → sets
     `cluster.risk_score`/`cluster.risk_breakdown`.
  5. `budget = CaseBudget(prefs.caps)` (token/tool caps + kill switch).
  6. **Persona + playbook selected deterministically**: `select_persona(cluster,
     prefs)` (personas.py:180); playbook via `force_playbook_id` OR
     `self._playbooks.select(cluster)`. Audits `ActionType.DECISION`, actor
     `playbook_selector`. `_emit_step("persona", …)`.
  7. **Operator MEMORY loaded** (best-effort): `self._memory.list(active_only=True)`.
  8. If `budget.kill_switch` → `VerdictResult(NEEDS_HUMAN)` directly, no LLM.
     Else `_emit_step("tools", …)` then
     **`asyncio.wait_for(run_investigation(...), timeout=prefs.caps.timeout_seconds)`**.
     A `TimeoutError` caps to `NEEDS_HUMAN` and accounts partial spend from
     `cost_accum` (the `cost_sink`, #6 reconciliation — see §4.4).
  9. `_emit_step("verdict", detail=verdict.verdict.value)`.
  10. `_allocate_case_number(...)` → `_assemble_case(...)` builds the `Case` →
      **`CaseManager(prefs).apply(case)`** (the ONLY close/escalate authority, #3) →
      `await self._cases.save(case)` → audit `ActionType.DECISION`, actor
      `case_manager`.
  11. **`_emit_step("decision", status="done", …)` — the TERMINAL SSE frame, emitted
      AFTER apply()+save+audit** (never before decide()). See §4.5.
  12. **Post-decision, #3-safe, error-isolated**: `_maybe_automate(case, prefs)`
      (threshold automation) → `_maybe_index_resolved(case)` (RAG resolved-case loop)
      → `_maybe_notify(case)` (fire-and-forget). None may set status/disposition.
  - Outer `except` → `_fail_to_human_case(...)` (pipeline.py:580): NEEDS_HUMAN,
    `DecisionBy.SYSTEM`, persisted + audited `ActionType.ERROR`. **Never drops an
    alert** (#3 spirit / never-raise).

`_assemble_case` (pipeline.py:483) preserves creating surface (`_preserved_surface`),
unions rules (`_merge_rules` — rules are NOT in the signature), appends
`verdict_history`, and normalises `reproduce_query` via
`normalize_kql(raw or entity_kql(cluster,prefs), prefs)`.

### 1.2 The flow (`agents/graph.py` — `run_investigation`)
LangGraph state graph **`triage → (benign shortcut | strong investigator) → verdict`**
with an **identical direct fallback** when LangGraph is unavailable/errors
(graph.py:109-113 `_run_with_langgraph` / `_run_direct`). Both call the SAME
router/investigator/RAG — no behavioural divergence. `do_investigate` (graph.py:87):
if `prefs.rag.enabled`, `rag.ensure_seeded()`, build queries = `[rag_query(cluster)]`
+ the selected playbook's canned `manifest.rag_queries`, retrieve per query, de-dupe
by `ch.text`, cap the union at `max(top_k*2, top_k)`. `cost_sink` (an optional
`list[float]`) mirrors each realised leaf cost as it lands (§4.4).

### 1.3 Roles
- **Router** (`agents/router.py`): cheap model classifies into
  `TriageBucket.{obviously_benign|needs_strong_model|uncertain}` (constants
  `BENIGN`/…). **On any `GatewayError` → `UNCERTAIN`** (never dismiss a real alert).
  Renders context via `render_cluster(cluster, enrichment, None, max_events=6)`.
  Audits `ActionType.PROMPT` then `ActionType.DECISION`.
- **Investigator** (`agents/investigator.py`): the **ReAct loop**. Builds the system
  prompt via `build_investigator_system(tool_defs_text(...), persona.system_addendum)`;
  context via `render_cluster(...)`. Emits ONE `ActionType.PROMPT` and ONE
  `ActionType.CONTEXT` record (the explainability "why", tool_input carries a bounded
  structured copy of memory/knowledge/enrichment). Loop bounded by
  `max_steps = prefs.caps.max_tool_calls + 3`; each step gated by `budget.exceeded()`
  / `budget.can_call_tool()`. **Capability firewall** (investigator.py:249): a tool
  with tier `FORBIDDEN`/`REQUIRES_APPROVAL` is NOT executed — the model is told to
  put it in `recommended_action` instead (#3 generalised). Tool results fenced via
  `fence(json.dumps(observation), source='tool', tool=name)`. Ends with
  `Formatter.format(...)` and a `ActionType.VERDICT` record carrying a reasoning
  excerpt. Any error/inconclusive → `_fail_to_human(...)` = `NEEDS_HUMAN`.
- **Formatter** (`agents/formatter.py`): PRESENTATION only — **preserves the
  investigator's `verdict` + `confidence` verbatim** (formatter.py:63), polishes
  evidence/mitre/recommended_action/reproduce_query. On `GatewayError` → returns the
  draft unchanged. This is a #3 guard: the label that feeds `decide()` is never
  re-authored by the formatter.

### 1.4 The ONE chat engine (`agents/chat.py` — `ChatEngine`) — #5
**One engine, two entry points** (Surface-1 empty; Surface-2 seeded with `case_id`).
READ-ONLY: turns intent into an `es_query`, renders a table + a Discover locator,
never mutates. `chat(...)` builds messages in a fixed precedence order:
`CHAT_SYSTEM` → **MEMORY block** (`_render_memory` → `render_memory`) → **case seed**
(`_seed_context`, fenced via `fence_block`) → **on-screen context** (`_render_context`,
fenced) → **knowledge** (`_render_knowledge`, trusted-allowlist) → history → the user
message. Two-turn: turn-1 decides `needs_query`; if a query runs, **turn-2**
(`_analyse_results`) re-prompts over a **COMPACT fenced aggregate** (`_aggregate_hits`
→ `fence_block`) — never raw rows (#7 spirit). Optional per-case source override
(`source` param) scopes the `EsQueryTool` for that turn only (multi-source). Memory
add/remove is explicit + deterministic (`_apply_memory_action`, source `agent`,
audited). Per-case turns persisted onto the case thread (`_persist_case_turn`,
`AuthorType.HUMAN`/`AI`) — advisory only, **NEVER touches the case decision (#3)**.

### 1.5 Knowledge / RAG (`tools/rag.py` — `RagService`)
In-process seed corpus (`SEED_RUNBOOKS`/`SEED_MITRE`/`SEED_SUPPRESSION_GUIDANCE`) +
runbook FILES (`runbook_corpus_items()`) + runtime `resolved_case` chunks +
`imported`/`threat_context` docs. `ensure_seeded()` idempotent + fail-closed;
`retrieve()` = vector floor (min_score on RAW vector score) + optional dependency-free
BM25 hybrid re-rank; **never raises → `[]`**. Embeddings go through the ONE gateway
(`gateway.embed`, surface `"rag"`, #6). `is_trusted_knowledge(source)` — the
**TRUSTED allowlist** (`TRUSTED_KNOWLEDGE_SOURCES = {runbook, mitre, suppression}`) —
is the #9 gate (see §4.1). `resolved_case` is deliberately NOT trusted (case text is
log-derived).

### 1.6 Standup aggregate seam (`agents/standup.py`) — #7
Aggregates the log surface + case stats in ES (no LLM), leads with the deterministic
`shift` block, sends ONLY the **compact fenced aggregate** to the cheap standup model.
`fence_block()` (standup.py:371) is the **load-bearing #7/#9 primitive**: it fences
the WHOLE structure (`max_chars=_FENCE_BLOCK_MAX_CHARS=16000`) scrubbing forged
markers per string leaf (`_fence_leaves`/`_neutralise_markers`/`_FORGED_MARKERS`),
**deliberately NOT** the per-value `prompts.fence()` 600-char cap (which silently
dropped 80-95% of the payload). `fence_block` is IMPORTED by `chat.py` too (its
`_analyse_results`/`_seed_context`).

---

## 2. Key symbols / files / wire keys / endpoints

### 2.1 The #9 seam — `agents/prompts.py`
- **Constants (must not drift):** `UNTRUSTED_OPEN='<<<UNTRUSTED_LOG_DATA>>>'` /
  `UNTRUSTED_CLOSE='<<<END_UNTRUSTED_LOG_DATA>>>'` (from `constants.py`);
  `MEMORY_OPEN='<<<MEMORY>>>'` / `MEMORY_CLOSE='<<<END_MEMORY>>>'` (prompts.py:23);
  playbook markers `<<<PLAYBOOK>>>`/`<<<END_PLAYBOOK>>>`. `_INJECTION_NOTE`
  (prompts.py:31) is appended to EVERY system prompt.
- **`fence(value, *, source='log', tool=None)`** (prompts.py:41) — wraps an
  attacker-influenceable value; neutralises forged fence/PLAYBOOK/MEMORY markers;
  **caps inner text at `truncate(text, 600)`**; adds `source=`/`tool=` provenance.
- **`render_memory(entries)`** (prompts.py:67) — TRUSTED durable-facts block
  (`_MEMORY_MAX_ENTRIES=20`, `_MEMORY_MAX_CHARS=2000`), scrubs forged markers.
- **`render_cluster(cluster, enrichment, rag_chunks, max_events=12, playbook, memory)`**
  (prompts.py:112) — the central renderer. Precedence order emitted: MEMORY
  (trusted) → PLAYBOOK (trusted, ≤2400 chars) → deterministic investigation context
  (entity/rules FENCED) → enrichment (score/malicious plain numeric; country + source
  string LEAVES fenced) → **Sample events FENCED** → **Retrieved knowledge**: trusted
  (allowlist) rendered plain `[source] text`, else `fence(ch.text, source=…)`;
  **Prior analyst decisions (`resolved_case`) always fenced**.
- **System prompts:** `ROUTER_SYSTEM`, `INVESTIGATOR_SYSTEM` (carries the PRECEDENCE
  ladder: deterministic policy > base rules > playbook > MEMORY > untrusted evidence;
  `{tool_defs}` placeholder), `FORMATTER_SYSTEM`, `CHAT_SYSTEM`, `STANDUP_SYSTEM`.
- **`build_investigator_system(tool_defs, persona_addendum='')`** (prompts.py:320) —
  persona only ADDS focus/methodology, never relaxes rules.
- **`tool_defs_text(definitions)`** (prompts.py:313).

### 2.2 Pipeline / flow
- `InvestigationPipeline.{investigate_cluster,register_candidate,_assemble_case,
  _build_investigator,_emit_step,_maybe_automate,_maybe_notify,_maybe_index_resolved,
  _allocate_case_number}` (pipeline.py). Wired singletons: `self.notifier`,
  `self.automation`, `self.event_bus` set by `AppState` AFTER construction.
- `run_investigation(router, investigator, rag, cluster, enrichment, prefs, budget,
  surface, case_id, persona, playbook, memory, cost_sink)` (graph.py:26) → returns
  `(VerdictResult, float)`.
- `common.py`: `coerce_verdict(obj)` (fail-safe to NEEDS_HUMAN, clamps confidence),
  `rag_query(cluster)`, `entity_kql(cluster, prefs)`, `normalize_kql(query, prefs)`
  (`_BARE_TOKEN_RE`, idempotent — maps `ip:x`→`source.ip : "x"`).
- `personas.py`: `PERSONAS`, `select_persona(cluster, prefs)`, `get_persona`,
  `all_personas`, `GENERALIST`. Selection: operator override by primary rule → first
  specialist whose keyword matches the rule haystack → generalist.

### 2.3 RAG wire keys / behaviour
- `SEED_SOURCES={runbook,mitre,suppression,resolved_case}` (delete-guarded);
  `TRUSTED_KNOWLEDGE_SOURCES={runbook,mitre,suppression}` (#9 allowlist);
  `THREAT_CONTEXT_SOURCE='imported'-family='threat_context'`.
- `RagService.{ensure_seeded,retrieve,import_document,import_threat_context,
  list_documents,get_document,delete_document,rag_stats,index_resolved_case,
  index_resolved_cases,set_prefs}`; `RagTool` (name `rag_retrieve`).

### 2.4 Chat wire keys / model contract
- `ChatResponse{answer,table,query,discover,case_id,cost,memory_action,
  memory_suggestion}`; step-1 model JSON `{answer, needs_query, query{ip,user,host,
  rule,contains,time_from,time_to,size}, memory_action{op,text,id},
  memory_suggestion{text,reason}}`; step-2 JSON `{answer}`.
- Investigator/formatter/router output JSON keys = `VERDICT_KEYS =
  (verdict,confidence,evidence,mitre,recommended_action,reproduce_query)`.
- `TriageBucket` values `obviously_benign|needs_strong_model|uncertain`.

### 2.5 Endpoints in this domain (routes surfaced by these modules)
- `POST /api/chat` (both surfaces) → `ChatEngine.chat`.
- `GET /api/standup`, `GET /api/standup/report` → `StandupService` (#7).
- RAG mgmt: `GET /api/rag/stats|documents|documents/{id}|search`, `POST /api/rag/import`,
  `DELETE /api/rag/documents/{id}?force=`, `POST /api/threat-context/import`.
- `GET /api/personas`, `GET /api/runbooks`, `GET /api/playbooks`,
  `POST /api/playbooks/reload`, `GET /api/playbooks/selection/{case_id}`.
- `GET /api/cases/{id}/rationale` (assembled from the `CONTEXT`/`VERDICT` audit
  records this domain emits).
- SSE `GET /api/events` (room `cases:{case_id}`, event `agent.step`) — `realtime.py`.

---

## 3. Round-4 bugs / where they live vs this domain

None of the four **confirmed Round-4 bugs live in this domain** — but this domain is
where **feature #5 (two-tier + batch detection + daily campaign)** integrates and
where **#9 must hold for raw batch-detected events**. Precise pointers:

### 3.1 Bug #1 (single-source poller) — NOT here
Lives in `state.py` (`_build_log_source`/`self.poller`) + `engine/poller.py`. This
domain's coupling: `self._source` on `InvestigationPipeline` (pipeline.py:69) and
`ChatEngine` (chat.py:65) STAYS the **primary** read/browse/chat surface after the
PollerManager fan-out. The shared `_real_pipeline` is reused by all fan-out pollers
(one ledger #6, one case store). `rebuild_log_source` re-points `pipeline._source` +
`chat._source` together — a manager must keep that.

### 3.2 Bug #2 (LLM pricing) — NOT here
Lives in `llm/pricing.py` + `model_registry.json`. This domain routes 100% of calls
through `gateway.complete(...)`/`gateway.embed(...)` (#6) and is unaffected — but the
pipeline's `cost_sink` reconciliation (§4.4) reflects whatever `cost` the gateway
returns, so a corrected price flows through automatically.

### 3.3 Bug #3 (Acknowledge→None) — NOT here
Lives in `routes.py` `_ACTION_STATUS['acknowledge']=None` → `CaseStatus.INVESTIGATING`.
No agent/pipeline change; the analyst-action layer never calls `decide()`.

### 3.4 Feature #4 (adaptive threshold auto-tuning) — must NOT touch this domain's
live path. The nightly deterministic observer reads closed cases; it must **NEVER
import decide()**, never call the pipeline, never make an LLM call. Suppression DROPs
route through the existing HITL Proposal queue.

### 3.5 Feature #5 (two-tier ALERT/EVENT + batch detection + campaign) — THE integration site
- **ALERT feeds (realtime per-alert)**: already flow `correlate → handle_clusters →
  investigate_cluster` (this pipeline). No new path.
- **EVENT feeds (batched agent-driven DETECTION)**: the agent creates its OWN
  candidate `Cluster`s from raw events; those candidates must **re-enter the SAME
  pipeline** — call `register_candidate(...)` (zero-cost) and/or `investigate_cluster(...)`
  so `find_open_by_signature` idempotency (#4) + `decide()` (#3) are unchanged. **Do
  NOT bypass** `handle_clusters` gates or add a bespoke close path. Every batch model
  call (Anthropic Message Batches / OpenAI Batch+flex) must still route through the
  ONE gateway keyed by `custom_id` = exactly one `UsageDoc` per result (#6).
- **#9 fencing for raw batch-detected events**: any prompt the batch detector builds
  over raw events MUST fence every attacker-influenceable leaf — reuse
  `prompts.fence()` for per-value and `standup.fence_block()` for whole compact
  structures. Never send raw event bodies un-fenced (mirror `render_cluster`'s
  "Sample events (raw log data — UNTRUSTED)").
- **Daily CAMPAIGN pass**: link RELATED cases WITHOUT changing `cluster_signature`
  (#4). It is a deterministic peer of `link_cross_source` — it should reuse the
  cross-source RELATED machinery, NOT re-cluster. It naturally feeds the forward
  standup `shift` block (add data additively, still through `fence_block`).
- **Concurrency / realtime-vs-batch partition**: realtime ALERT investigations stay
  the low-latency path (`asyncio.wait_for(..., timeout=caps.timeout_seconds)`); the
  batch EVENT path is submitted asynchronously and its results reconciled later —
  they share `_real_pipeline`/gateway/case store but must be bounded by a new
  `caps.max_concurrent` (added to `CapsConfig`) so fan-out doesn't overwhelm the
  provider. The pipeline itself makes no LLM call in `register_candidate`, so
  candidate creation for a whole batch is cheap.

---

## 4. Invariants this domain ENFORCES (and exactly where)

### 4.1 #9 — UNTRUSTED fencing precedence + TRUSTED allowlist (THE domain's core)
- **The seam is `prompts.py`.** Precedence ladder (declared in `INVESTIGATOR_SYSTEM`,
  enforced structurally in `render_cluster`): deterministic policy > base role rules >
  PLAYBOOK (trusted operator procedure) > MEMORY (trusted durable facts) > **UNTRUSTED
  evidence** (data, never instructions).
- **`fence()`** neutralises forged `UNTRUSTED_*`, `<<<PLAYBOOK>>>`, `<<<MEMORY>>>`
  markers so untrusted data can never impersonate a trusted block or close the fence
  early. **`render_memory()`** applies the same neutralisation to operator facts.
- **TRUSTED allowlist (`is_trusted_knowledge`, rag.py:71)**: default-DENY. Only
  `{runbook,mitre,suppression}` render un-fenced; `imported`/`threat_context`/
  `resolved_case`/unknown are FENCED. This inversion (Round-3 security fix, OWASP
  LLM01) is enforced in BOTH `render_cluster` (prompts.py:195-208) AND
  `chat._render_knowledge` (chat.py:318-323) — keep them in lockstep.
- **Enrichment leaves**: `score`/`is_malicious` are code-computed CONTROL values →
  plain; `country` + `sources` string values are provider-influenced → FENCED
  (prompts.py:155-163).
- **Tool results**: fenced via `fence(..., source='tool', tool=name)`
  (investigator.py:280).
- **Chat**: on-screen context, case seed, and the step-2 aggregate all fenced
  (`_render_context`, `_seed_context`, `_analyse_results` via `fence_block`).
- **Standup**: `fence_block()` is the #7+#9 primitive (whole compact aggregate,
  marker-scrubbed leaves, 16000-char net).

### 4.2 #5 — ONE chat engine
`ChatEngine.chat` is the single implementation; Surface-1/Surface-2 differ only by
starting `case_id`/seed. Investigate is folded into Chat in the UI. Do not fork it.

### 4.3 #7 — aggregate-then-summarise
Standup (`_aggregate_logs` in ES → compact `shift`/aggregate → ONE LLM call) and chat
turn-2 (`_aggregate_hits` → `fence_block` → ONE LLM call) NEVER send raw logs/full
case bodies to a model. `_AGG_TOP_N=5`, `_AGG_SAMPLE_ROWS=5`. Any Round-4 batch/campaign
data added to these prompts MUST go through the same compact + fenced level.

### 4.4 #6 — one ledger write per LLM call
100% of completions/embeddings go through `gateway.complete`/`gateway.embed`. The
pipeline does NOT double-write: `cost_sink` (`cost_accum`) is a **side-channel mirror**
of realised leaf costs (router call in `graph.do_triage._account`; per-ReAct-step +
formatter in `investigator._account`) so a **timeout that cancels the coroutine** can
still reconcile `Case.token_cost` with the ledger (pipeline.py:333-372). On the normal
path `sum(cost_sink) == returned flow_cost` — the sink is never a substitute. **Do not
re-account** at `_run_direct`/`_run_with_langgraph` (graph.py:117-119 comment). Batch
results (#5) must produce exactly one `UsageDoc` per `custom_id`.

### 4.5 #3 — decide() is the sole authority; SSE frame ordering
This domain NEVER imports/calls `case_manager.decide()` except via
`CaseManager(prefs).apply(case)` at the single site pipeline.py:386. The formatter
preserves the verdict label; the capability firewall blocks write tools; memory/RAG/
playbooks/personas can only INFORM. **SSE decision frame is published AFTER
apply()+save+audit** (`_emit_step("decision", status="done")`, pipeline.py:401) —
`realtime.py` publishes frames after save, never before decide(). `_emit_step` is
best-effort + fully isolated (a bus error can never break the flow) and carries only
short render-safe labels (persona id, verdict enum, status word) — never raw log/AI
text (#9). Post-decision hooks (`_maybe_automate`/`_maybe_index_resolved`/
`_maybe_notify`) run AFTER save and are error-isolated + #3-safe.

### 4.6 #1 — read-only surface
`self._source` (a `PullConnector`) is the read-only log surface (es_query tool). This
domain never touches the `_mgmt` client. `ChatEngine`/pipeline get a per-source client
built by `es_client_for_source` (mgmt key forced None) via the route/state.

---

## 5. Contracts a refactor MUST preserve (byte-identical or aliased)

1. **Fence delimiter literals** `UNTRUSTED_OPEN/CLOSE`, `MEMORY_OPEN/CLOSE`,
   `<<<PLAYBOOK>>>/<<<END_PLAYBOOK>>>` — matched-and-neutralised across `prompts.py`
   AND `standup._FORGED_MARKERS`. Changing one without the other reopens the injection
   hole. Detection strings in tests key on these.
2. **`is_trusted_knowledge` allowlist = `{runbook,mitre,suppression}`** (default-deny).
   Adding a source to the TRUSTED set is a deliberate security decision. A new Round-4
   corpus source (e.g. batch-detection notes) is UNTRUSTED until explicitly allow-listed.
3. **`fence()` vs `fence_block()` distinction**: `fence()` = per-value, 600-char cap;
   `fence_block()` = whole compact structure, 16000-char net, per-leaf scrub. Do NOT
   collapse `fence_block` back into `fence` (that truncation bug is why it exists).
4. **`render_cluster` output order + which leaves are fenced** — router, investigator
   both depend on it; tests assert the "Sample events … UNTRUSTED" + fenced entity.
5. **Formatter preserves `verdict`+`confidence`** (formatter.py:63) — the label into
   `decide()` must never be re-authored downstream of the investigator.
6. **`coerce_verdict` fails safe to `NEEDS_HUMAN`**; `router` fails to `UNCERTAIN`;
   `investigator`/pipeline fail to `NEEDS_HUMAN`. Never a silent close.
7. **P1 stability guard** (pipeline.py:237): already-investigated OPEN case + no new
   event ids + `!force` returns UNCHANGED with no LLM calls — preserve to stop drift.
8. **`register_candidate` is ZERO-cost** — no LLM call; batch EVENT detection must
   reuse this to stay $0 at candidacy.
9. **`run_investigation` signature** + `cost_sink` semantics (leaf-cost mirror, no
   re-accounting) — tests + timeout reconciliation depend on it.
10. **VERDICT_KEYS JSON shape** + `ChatResponse` fields + `TriageBucket` values +
    chat step-1/step-2 JSON contract — the webui consumes these verbatim.
11. **`normalize_kql` idempotence** (`ip:x`→`source.ip : "x"`; already-dotted left
    alone) — the `_BARE_TOKEN_RE` negative-lookbehind is load-bearing.
12. **Audit record shape**: `ActionType.PROMPT`/`CONTEXT`/`TOOL_CALL`/`VERDICT`/
    `DECISION`/`ES_QUERY`/`POLL`/`ERROR` with actor labels (`pipeline`,
    `case_manager`, `playbook_selector`, `context`, role values) — the
    `/rationale` endpoint rebuilds the "why" panel from these.
13. **SSE `agent.step` frames** (room `cases:{case_id}`, steps
    router/persona/tools/verdict/decision) — additive detail only; the terminal frame
    stays AFTER save.
14. **RAG `SEED_SOURCES` guard + `resolved_case` doc_id determinism**
    (`resolved_case:{case_id}` overwrites, never duplicates).

---

## 6. Risks / gotchas for build agents

- **The #9 allowlist is duplicated** in `prompts.render_cluster` and
  `chat._render_knowledge`. Any new corpus source (Round-4 batch/campaign notes) must
  be handled identically in BOTH or one path leaks unfenced text.
- **`fence()`'s 600-char cap silently truncates** — that is why `_seed_context`,
  `_render_context`(no) and `_analyse_results` use `fence_block`. If a Round-4 batch
  prompt uses `fence()` on a large structure it will drop most of it; use `fence_block`.
- **`resolved_case` is intentionally NOT trusted** even though it's "our own" data —
  its text is case-derived (log-derived). Do not add it to the allowlist.
- **cost_sink double-count trap**: leaf costs are appended inside `do_triage` and
  `investigator.investigate` ONLY. Never append again at the graph/flow level
  (graph.py:117-119) — you'd double-count on the timeout path.
- **The P1 stability guard means re-polling a settled case is a no-op** — a Round-4
  batch re-detection of the same signature will attach silently (correct), not
  re-investigate, unless `force=True` or new event ids appear.
- **LangGraph is optional/fragile**: the direct fallback must stay byte-behaviour-
  identical. Don't add logic to only one branch.
- **Chat turn-1 runs the model BEFORE any query data exists** (chat.py:181 "BUG-1"
  comment) — the analysis is turn-2 over the fenced aggregate. Preserve the two-turn
  shape; turn-2 degrades to `fallback + tr.summary` on any error (never drop a response).
- **`select_persona` matches on rule keywords only** (entity_types are advisory) —
  most clusters are IP-based, so an entity trigger would funnel everything to one
  specialist. Keep it rule-keyword-driven.
- **`_emit_step` detail must stay short + render-safe** — never pass raw log/AI text
  (the UI escapes regardless, but keep the label a persona/verdict/status word).
- **Biggest single risk (see below).**

---

## Biggest risk for this domain

**Feature #5's batched EVENT agent-detection is the #9 fencing weak point.** The
agent now builds prompts over RAW, attacker-controlled event bodies (not just
pre-correlated clusters), so any new batch-detection prompt path that forgets to route
every leaf through `fence()`/`fence_block()` (and to keep batch-created candidates on
the SAME `register_candidate`/`investigate_cluster` path so #3/#4/#6 hold) reopens the
prompt-injection hole this domain exists to close. Mandate: reuse `render_cluster`'s
fencing discipline verbatim, keep the TRUSTED allowlist default-deny, and never let a
batch model call bypass the ONE gateway or the deterministic `decide()`.
