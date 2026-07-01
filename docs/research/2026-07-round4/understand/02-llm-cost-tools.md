# Round-4 Understand Map — 02: LLM Gateway, Pricing, Providers, Cost Gate/Budget & Tools

> **Domain:** `backend/app/llm/*`, `backend/app/engine/budget.py`, `backend/app/stores/price_overlay.py`,
> `backend/app/api/routes_models.py`, `backend/app/models.py::UsageDoc`, plus the tool-fencing seam
> (`backend/app/tools/*`). This is the cost-ledger spine (#6) and where Round-4 W0/W1/W3 land.
> Enrichment SPI is covered only as the *shape reference* the W3 BatchProvider should mirror — it is NOT an edit target.
>
> **Pricing verified against the `claude-api` skill catalog (2026-07-01), not from memory:**
> Fable 5 `$10/$50` (1M) · Opus 4.8 `$5/$25` (1M) · Opus 4.7 `$5/$25` (1M) · Sonnet 4.6 `$3/$15` (1M) ·
> Haiku 4.5 `$1/$5` (200K). Cache read `0.1×` input · 5-min cache write `1.25×` input · 1-h cache write `2.0×` input ·
> Batch API `0.5×` (both input+output). **This confirms the price bug: `claude-opus-4-8` is `(15.0, 75.0)` in code, must be `(5.0, 25.0)`.**

---

## 1. How it works today (end to end)

### 1.1 The single ledger path (#6)

Every LLM call flows through `LLMGateway.complete()` or `.embed()`
(`backend/app/llm/gateway.py`). Both funnel into `LLMGateway._record()`
(`gateway.py:294`), which is the **only** caller of `self._usage.write(doc)`
(`gateway.py:337`). One `UsageDoc` is written per completion, per embedding, and per
error path — this is non-negotiable #6.

`complete()` flow (`gateway.py:162`):
1. `await self._budget_preflight(...)` (`gateway.py:175→267`) — pure pre-flight ceiling
   check. On a `block` decision it **RAISES `GatewayError` BEFORE the provider call and
   BEFORE any ledger write** (#3: a blocked call fails to NEEDS_HUMAN, never closes a
   case). Demo/mock/$0 models bypass the gate.
2. `provider = self._provider(model_cfg.provider, model=..., endpoint=model_cfg)`
   (`gateway.py:178`) → resolves + caches the provider client.
3. `result = await provider.complete(...)` (`gateway.py:179`) — **direct call, NOT
   wrapped in `with_retry()`** (W0 seam).
4. On exception: write ONE `ERROR` `UsageDoc` (`gateway.py:184`) then `raise
   GatewayError`.
5. On success: compute `cost` (`gateway.py:191-196`), set `result.cost` (`gateway.py:197`
   — for `Case.token_cost` rollup), then `_record(...OK, cost)` (`gateway.py:198`).

`embed()` (`gateway.py:205`) is **metered but NOT budget-gated** (documented at
`gateway.py:213-224`); on provider failure it records an ERROR row then falls back to
local hash embeddings + records an OK row (two writes across two logical outcomes,
still one per outcome).

### 1.2 Cost computation

`_record()` (`gateway.py:294`) computes `pricing_source` in this precedence:
- `self._demo` → `"zero"` (`gateway.py:311-312`)
- else overlay present (`await self._overlay_tuple(model) is not None`) → `"exact"`
  (`gateway.py:313-314`) — **the overlay→exact stamping lives in the gateway, NOT in
  `pricing.pricing_source()`**
- else `pricing_source(model)` (`gateway.py:316`)

`cost` (if `None`) is `_demo_synthetic_cost(...)` when demo else
`cost_for(model, prompt, completion, await self._overlay_tuple(model))`
(`gateway.py:317-323`). Note: `complete()`/`embed()` also compute cost and pass it in, so
`_record()`'s own `cost is None` recompute is a secondary path — a batch path must decide
which computes it, to keep exactly one authoritative number per result.

### 1.3 Pricing resolution (`backend/app/llm/pricing.py`)

`cost_for(model, prompt_tokens, completion_tokens, overlay=None)` (`pricing.py:255-264`)
is THE cost fn:
```python
round((prompt_tokens/1e6)*in_price + (completion_tokens/1e6)*out_price, 8)
```
`mock*` → `0.0`. Uses `resolve_price(model, overlay)` (`pricing.py:239-252`):
`mock→(0,0)` → `overlay` → `PRICES` exact → `registry_price(model)` → `_heuristic_price`
→ `_DEFAULT_PRICE=(1.0,3.0)`. **`PRICES` is checked BEFORE the registry** — an operator
editing `pricing.py` wins over the bundled JSON.

`PRICES` (`pricing.py:28-49`) is the in-code `{model: (in,out)}` table.
`model_registry.json` (`backend/app/llm/model_registry.json`) layers per-model metadata
(context window, modalities, capabilities, `input/output_per_million`,
`cache_write_per_million`, `cache_read_per_million`, optional `base_url`) on top.
`registry_price()` (`pricing.py:114-124`) reads only input/output; **the cache_* fields
are read into `model_catalog()` (`pricing.py:159-160`) but NEVER applied by
`cost_for`/`resolve_price`** — cached-read tokens are billed at full input rate today.

`load_registry()` is `@lru_cache(maxsize=1)` (`pricing.py:91`) — after editing the JSON
in a long-lived process the cache is stale; a test mutating the file mid-process must
call `load_registry.cache_clear()`.

### 1.4 Providers (`backend/app/llm/providers.py`)

`CompletionResult` dataclass (`providers.py:89-95`): `text / prompt_tokens /
completion_tokens / model / cost`. **No cache/batch token fields** (W1 must add).
`gateway` sets `result.cost` after metering.

`AnthropicProvider.complete()` (`providers.py:144-179`) POSTs `/v1/messages` and reads
`usage.input_tokens / output_tokens` ONLY — **it drops
`cache_creation_input_tokens` + `cache_read_input_tokens`** the API returns (W1 source
for cache token counts). `OpenAIProvider.complete()` (`providers.py:193-219`) similarly
drops `prompt_tokens_details.cached_tokens`. Provider `.complete()`/`.embed()` call
`self._client.post(...)` **directly** — `with_retry()` is never invoked.

`PROVIDER_REGISTRY` (`providers.py:649-657`): `anthropic / openai / mock / azure /
bedrock / vertex / openai_compatible` → factory. The gateway resolves via this table
(`gateway.py:98`); explicit `provider_overrides` keyed by provider NAME win first
(`gateway.py:80`) — the mock/demo injection seam.

### 1.5 Budget gate (`backend/app/engine/budget.py`)

`BudgetGate` is PURE + read-only + fail-open. `estimate_cost()` (`budget.py:66-79`) uses
`resolve_price()` (same resolution as the ledger) — prompt priced as input tokens +
`max_tokens` as output tokens (worst case). `check()` (`budget.py:82-94`) → `allow / warn
/ block` dict; budget OFF → always `allow`. Reads rolling spend via `usage.summary()`
(`budget.py:124-140`); a read failure degrades to `$0` (fail-open governance). The
gateway turns a `block` into `GatewayError` → NEEDS_HUMAN (#3). **`estimate_cost` has no
cache dimension** — if `cost_for` gains cache pricing, the pre-flight estimate diverges
(acceptable: it is a conservative worst-case).

### 1.6 Routes (`backend/app/api/routes_models.py`, prefix `/api`)

- `GET /api/llm/models` (`:76`) → `{models[], providers, configured, overrides}`. Rows
  from `model_catalog()`, enriched with `assigned_roles`, `price_overridden`, and
  overlay-overridden `input/output_per_million` + `pricing_source:"exact"`. **Already
  emits `cache_write_per_million` + `cache_read_per_million`; add a batch column
  additively for W5.**
- `GET /api/llm/providers` (`:110`) → registry + per-provider `configured` booleans +
  `supports_base_url`.
- `POST /api/llm/models/test` (`:159`, perm `models:manage`) → routes a tiny prompt
  through the ONE gateway (hits the ledger #6); badges `pricing_source` the same way
  `_record` does.
- `PUT/DELETE /api/llm/models/{id}/pricing` (`:230/:252`, perm `models:manage`) →
  `PriceOverlayStore.set_price`/`delete`; audited via `USER_MGMT`/`surface="models"`.
- `POST /api/cost/estimate` (`:277`, perm `models:read`) → `BudgetGate.estimate_cost`.
- `GET/PUT /api/budget` (`:305/:314`) + `GET /api/budget/status` (`:331`).

### 1.7 Price overlay store (`backend/app/stores/price_overlay.py`)

`PriceOverlayStore` — one KV doc (`ns=PRICE_OVERLAY_NS`, `key=PRICE_OVERLAY_KEY`), value
`{"overlay": {"<scope>": {"<model>": {"input", "output"}}}}`, org-scoped
(`'default'`). `as_price_tuple(model)` (`:115`) is what the gateway passes as `overlay`.
Read-modify-write, never raises on backend failure. **No cache/batch dimension** — a
Round-4 addition is additive.

---

## 2. Round-4 changes — exact fix surface

### W0 — Fix the Opus-4.8 price bug (`$15/$75 → $5/$25`)

**Two files must be edited TOGETHER** (PRICES is checked before the registry, so editing
only the JSON does NOT change `cost_for`'s result for `claude-opus-4-8`):

| Location | Current | Correct |
|---|---|---|
| `pricing.py:30` `PRICES['claude-opus-4-8']` | `(15.0, 75.0)` | `(5.0, 25.0)` |
| `pricing.py:59` `_TIER_HEURISTIC` `("claude-opus", ...)` | `(15.0, 75.0)` | `(5.0, 25.0)` |
| `model_registry.json:23-24` `input/output_per_million` | `15.0 / 75.0` | `5.0 / 25.0` |
| `model_registry.json:25-26` `cache_write/cache_read_per_million` | `18.75 / 1.5` | `6.25 / 0.5` (1.25× / 0.1× of the corrected `5.0` input) |

If broadening the catalog: **no `claude-opus-4-7` or `claude-fable-5` rows exist yet** —
add them (`opus-4-7`: `(5.0, 25.0)`, cache `6.25/0.5`; `fable-5`: `(10.0, 50.0)`, cache
`12.5/1.0`; `sonnet-4-6` cache should be `3.75/0.3`, `haiku-4-5` `1.25/0.1`).

**Tests that hard-code the wrong price and WILL break (update to `(5.0,25.0)`):**
- `backend/tests/test_pricing_catalog.py:41` — `assert PRICES['claude-opus-4-8']==(15.0,75.0)`
- `backend/tests/test_round3_wave2_models.py:143-147` — asserts
  `resolve_price('claude-opus-4-99-future')==(15.0,75.0)` (the opus heuristic) + overlay
  precedence + `resolve_price('gpt-4o')==(2.5,10.0)` (leave that one).
- Still valid: `test_pricing_catalog.py:48` (unknown→`4.0` default),
  `test_vigil_wave1.py:291-293` (haiku heuristic), `test_round3_wave2_models.py:143` gpt-4o.

### W0 — Wire the dead `providers.with_retry()`

`with_retry(coro_factory, *, attempts=3, base_delay=0.5, max_delay=8.0)`
(`providers.py:62-86`) + `classify_http_error` (`:39-59`) + `ProviderError` (`:30-37`)
are **fully implemented and unit-tested but never invoked**. Wrap the raw
`self._client.post(...)` calls (or the whole `.complete()`/`.embed()` body up to
`raise_for_status`) in `with_retry(lambda: ...)` inside `AnthropicProvider.complete`
(`:161-169`), `OpenAIProvider.complete` (`:205-210`), `OpenAIProvider.embed` (`:222-227`),
and ideally the Azure/Bedrock/Vertex `.complete` methods. `with_retry` already re-raises
cleanly, so the gateway's ONE-error-row semantics (`gateway.py:184`) stay intact (#6).
The gateway does NOT need to change — it already calls `provider.complete` at
`gateway.py:179`.

### W0/W1 — Apply the stored cache rates in `cost_for`

Cache rates (`cache_read` 0.1×, 5-min `cache_write` 1.25×, 1-h `cache_write` 2×) are
stored in `model_registry.json` but never applied. This requires a **coordinated chain**:

1. **Provider usage extraction** — `AnthropicProvider.complete` (`providers.py:171-179`)
   read `usage.cache_read_input_tokens` + `usage.cache_creation_input_tokens` (absent →
   `0`). `OpenAIProvider` read `prompt_tokens_details.cached_tokens`.
2. **`CompletionResult`** (`providers.py:89-95`) — add
   `cache_read_input_tokens: int = 0` + `cache_creation_input_tokens: int = 0` (defaulted,
   additive).
3. **`cost_for`** (`pricing.py:255`) — add **keyword-only, defaulted** args
   (e.g. `*, cache_read_tokens=0, cache_write_tokens=0, cache_write_ttl="5m"`) OR a
   companion fn. **The non-cache math MUST stay byte-identical:**
   `round((prompt/1e6)*in + (completion/1e6)*out, 8)` — cache terms add
   `(cache_read/1e6)*cache_read_rate + (cache_write/1e6)*cache_write_rate`, rounding
   ONCE at the end. Read the cache rates from `registry_entry(model)`
   (`pricing.py:109`) — `cache_read_per_million` / `cache_write_per_million` — falling
   back to `0.1×`/`1.25×` of the resolved input rate when absent.
4. **`UsageDoc`** (`models.py:1009-1024`) — add additive, defaulted fields
   (`cache_read_tokens: int = 0`, `cache_write_tokens: int = 0`, and a `batch: bool = False`
   for W3). Zero-migration, matches the Round-3 additive pattern. `total_tokens`
   semantics must not change.
5. **Gateway `_record`/`complete`/`embed`** thread the new counts from `CompletionResult`
   into `cost_for` and onto the `UsageDoc`.

`cost_for`'s **positional signature must remain callable as today** — all existing callers
(`gateway.py:195/249/321`, `budget.estimate_cost` via `resolve_price`) must keep working.

### W3 — BatchProvider SPI (Anthropic Message Batches + OpenAI /v1/batches + flex)

Cleanest seam:
- **New module** (e.g. `backend/app/llm/batch.py`), mirroring the enrichment SPI shape
  (`backend/app/enrichment/{base,registry,dispatch}.py`) — a static
  `manifest()`-style descriptor for discovery/UI, a non-overridable fail-open wrapper
  around an abstract worker, and a `PROVIDER_REGISTRY`-style dispatch (Anthropic
  `/v1/messages/batches` @ 50% off, OpenAI `/v1/batches`, `service_tier:"flex"`). SPI:
  `submit(requests) → batch_id`, `poll(batch_id) → status`, `results(batch_id) →
  iterator`.
- **custom_id keying:** `custom_id = hash(cluster_signature)`. `cluster_signature` is the
  per-cluster 1:1 idempotency key — `Cluster.signature` (the `signature: str` field on the
  `Cluster` model) computed by
  `backend/app/engine/signatures.py::cluster_signature(entity_type, entity_value)`
  (`signatures.py:18`). Results arrive **UNORDERED** — key strictly by `custom_id`, never
  by position.
- **Ledger (#6):** the batch result loop must call `LLMGateway._record()` **exactly once
  per returned result** (never write to `UsageStore` directly). Cost uses the `0.5×` batch
  multiplier through the same `cost_for`. Add a `batch=True` flag on `UsageDoc` (W1). In
  demo mode the batch path must still respect `self._demo` (synthetic cost,
  `pricing_source="zero"`, budget bypass).
- Do NOT add a second ledger write; do NOT alter `case_manager.decide` (#3).

### W5 — Models catalog UI

`model_catalog()` (`pricing.py:139-177`) already emits `cache_write_per_million` +
`cache_read_per_million`. Add a **`batch_per_million`** (or `batch_multiplier`) field
additively; the webui Models page reads these row keys. Do NOT rename existing keys
(`id/label/provider/context_window/max_output/modalities/capabilities/input_per_million/
output_per_million/cache_write_per_million/cache_read_per_million/base_url/pricing_source`)
— that dict is the webui contract.

---

## 3. Invariants this domain enforces (and where)

- **#1 (two ES clients):** not owned here directly, but providers/gateway MUST NOT reach
  ES; providers "never touch Elasticsearch, never write the usage ledger, never make
  policy decisions" (`providers.py:3-5`).
- **#3 (deterministic decide() is the only closer):** the `BudgetGate` `block` →
  `GatewayError` → NEEDS_HUMAN is the ONLY way budget touches triage; `_budget_preflight`
  RAISES **before** the provider call and **before** any ledger write (`gateway.py:174-175,
  267-291`). Pricing/cost NEVER feeds `case_manager.decide()`. Demo uses a synthetic cost,
  never a silent close.
- **#6 (100% of LLM calls through ONE gateway → exactly one UsageDoc/call):** enforced by
  `_record()` being the sole `self._usage.write()` caller (`gateway.py:337`); every
  complete/embed/error path funnels here. A batch path MUST call `_record()` once per
  result.
- **#9 (untrusted text fenced):** model ids + provider error strings returned to the
  client are treated as attacker-influenceable — `_safe()` bounds them to 2000 chars
  (`routes_models.py:54-58`); `classify_http_error` truncates response bodies to 300 chars
  (`providers.py:52-56`); the route comment (`routes_models.py:18-22`) documents the
  fencing contract. Tool text (`es_query`/`enrich`/`rag`) must be fenced before prompts
  and rendered escaped in the UI (see §4).

---

## 4. Tools fencing + TRUSTED allowlist + prompt-prefix cacheability

- **es_query / enrich / rag are UNTRUSTED sources (#9):** log-derived values, enrichment
  results, and RAG-imported docs are attacker-influenceable and must be fenced via
  `app.agents.prompts.fence(source=..., tool=...)` before any prompt. Enrichment fencing
  lives in `backend/app/enrichment/aggregate.py::fence_provider_result` /
  `fence_provider_value` (delegating to `prompts.fence(source='enrichment', tool=provider)`).
  The `#6` one-UsageDoc invariant does **NOT** apply to tools — enrichment providers make
  FREE HTTP threat-intel calls and never write a `UsageDoc`. Only LLM gateway calls do.
- **TRUSTED allowlist (Round-3 security fix):** RAG-knowledge fencing was inverted to a
  TRUSTED allowlist — only built-in/verified corpus (`runbook/mitre/suppression/
  resolved_case`) is trusted; operator-imported docs are fenced UNTRUSTED (OWASP LLM01).
  Any Round-4 tool text must preserve this: default-untrusted, allowlist-trusted.
- **Prompt-prefix cacheability (Round-4 opportunity, not a hard requirement):** applying
  Anthropic prompt caching means the STABLE prefix (frozen system prompt, memory/playbook
  TRUSTED blocks, deterministic tool list) must come first, with volatile
  attacker-influenceable fenced UNTRUSTED evidence AFTER the last cache breakpoint. The
  cache read (`0.1×`) / write (`1.25×`/`2×`) rates that W0/W1 wire into `cost_for` are what
  make this measurable on the ledger — the two efforts are complementary: fence first
  (#9), then cache the stable trusted prefix.

---

## 5. Contracts a refactor MUST preserve

1. `cost_for(model, prompt_tokens, completion_tokens, overlay=None)->float` stays callable
   with today's positional args (`gateway.py:195/249/321`). Cache/batch args must be new
   keyword-only defaults, or a companion fn.
2. `cost_for` non-cache math byte-identical:
   `round((prompt/1e6)*in + (completion/1e6)*out, 8)`. Round ONCE at the end.
3. `resolve_price` precedence `mock→(0,0) / overlay / PRICES / registry / heuristic /
   default(1,3)` — `budget.estimate_cost` depends on it matching the ledger.
4. `pricing_source` enum `exact | heuristic | zero | default` is wire-visible on
   `UsageDoc.pricing_source` (`models.py:1024`, default `"exact"`) and in `routes_models`.
   Overlay-present → `"exact"` is stamped **in the gateway** (`gateway.py:313-314`,
   `routes_models.py:94`), not in `pricing.pricing_source()`.
5. `provider_for` prefix mapping (`claude-*→anthropic`, `gpt-*/o1/o3/o4/text-embedding-*→
   openai`, `mock→mock`) byte-identical (`pricing.py:197-223`).
6. `#6`: `_record()` is the ONLY `self._usage.write()` caller — exactly one `UsageDoc` per
   completion/embedding/error/batch-result.
7. `#3`: `_budget_preflight` raises BEFORE provider call AND ledger write; blocked → NEEDS_HUMAN.
8. Demo mode: `self._demo` → `pricing_source="zero"` + `_demo_synthetic_cost` always
   (`gateway.py:191-193, 307-323`); demo/mock bypass the BudgetGate. Do not touch this branch.
9. `model_registry.json` wire keys + `model_catalog()` row keys are the webui/route
   contract — ADD columns (batch), never rename.
10. `PriceOverlayStore` KV shape `{overlay:{scope:{model:{input,output}}}}` +
    `as_price_tuple`/`set_price`/`put`/`delete` signatures. Cache/batch overlay is additive.
11. `UsageDoc` existing field types/meanings unchanged; cache/batch fields additive+defaulted.
12. `GET /api/llm/models` response shape `{models, providers, configured, overrides}` +
    per-model `price_overridden`.

---

## 6. Risks & gotchas

- **Edit both price sources together.** `PRICES` (`pricing.py:30`) is checked BEFORE the
  registry, so fixing only `model_registry.json` does NOT change `cost_for` for
  `claude-opus-4-8`. Fix `PRICES` + `_TIER_HEURISTIC` (`:59`) + the JSON.
- **`load_registry` is `@lru_cache(maxsize=1)`** — tests mutating the file mid-process must
  `load_registry.cache_clear()`.
- **Cache tokens are dropped at the provider layer.** Even after fixing rates, there is no
  cache-token INPUT to price until `CompletionResult` + the Anthropic/OpenAI usage
  extraction are extended (W1). Fix rates and plumbing together.
- **Cost is computed in TWO places** — `complete()`/`embed()` pass it in; `_record()`
  recomputes when `cost is None` (`gateway.py:317`). A batch path must pick one to stay
  consistent per result.
- **`_overlay_tuple(model)` is awaited up to 3× per completion** (cost, pricing_source
  branch, inside `_record`) — a batch loop amplifies redundant store hits; consider
  resolving the overlay once per batch.
- **`pricing_source` treats `registry_price != None` as `"exact"`** (`pricing.py:190`) —
  a registry-only model with a heuristic-looking id still badges `"exact"`. Batch/overlay
  must not regress this.
- **`estimate_cost` (BudgetGate) has no cache dimension** — once `cost_for` gains cache
  pricing, the pre-flight estimate over-estimates vs the recorded cost. Acceptable
  (conservative worst-case), but note it.
- **Rounding drift:** cache-adjusted math must round ONCE at the end (`round(..., 8)`), not
  per-term, to avoid double-rounding drift.
- **`_DEFAULT_PRICE=(1.0,3.0)` backstop** (`pricing.py:51`) means an unknown model never
  prices at zero — keep this when adding batch rates.
- **BatchProvider naming collision:** "provider" in `backend/app/enrichment/` = threat-intel
  reputation provider (free HTTP, no UsageDoc). BatchProvider = LLM batch API. Copy the SPI
  ergonomics from enrichment; put the UsageDoc-per-result contract in `llm/gateway.py`.
  Do NOT add batch logic under `enrichment/`.
- **New KV store (if any):** mirror `backend/app/stores/user_prefs.py` / `price_overlay.py`
  single-KV-doc pattern — no new ES index / SQL table / migration.
