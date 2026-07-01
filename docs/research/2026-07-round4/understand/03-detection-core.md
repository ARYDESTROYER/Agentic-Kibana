# 03 — Detection Core (correlation · signatures · risk · decide() · rules · priority · threat-context)

> Round-4 codebase map for the **deterministic detection spine**. Written for build
> agents. Everything below is verified against source (line numbers accurate as of
> branch `Testing`, 2026-07-01). This domain owns the hardest non-negotiables:
> **#3** (`decide()`/`apply()` byte-identical, the ONLY closer), **#4**
> (`cluster_signature` byte-identical idempotency), and it borders **#1/#6/#9**.

---

## 0. TL;DR for the impatient build agent

- **`decide()` and `apply()` are FROZEN.** Do not touch `engine/case_manager.py`.
  Guarded by `tests/test_wave6_decide_guard.py` which greps the *source text* for
  exact substrings AND asserts the literal word `"automation"` does **not** appear
  in either function. Auto-tuning / campaign passes must live in **new** modules and
  never `import ... decide`.
- **`cluster_signature(entity_type, value)` is FROZEN** (`engine/signatures.py:18`).
  It hashes only `("cluster", entity_type.value, entity_value)`. `n`, `window`,
  `severity_floor`, source_id, rule-diversity are **deliberately not inputs** — which
  is *exactly why* Round-4 adaptive tuning (raise `n` / raise `severity_floor`) is
  safe: it changes future case **volume**, never existing case **identity**.
- **Bug #3 (Acknowledge → None) is a ONE-LINE fix** at `api/routes.py:3136`:
  `"acknowledge": None` → `"acknowledge": CaseStatus.INVESTIGATING`. NOT in
  `case_manager.py`, NOT in `constants.py` (the enum value already exists).
- The **5 risk factors** (source for the (?) help): Volume, Velocity, Reputation,
  Diversity, Asset-criticality. **Default weights are 25/20/30/15/10 — reputation is
  the HEAVIEST (0.30), not volume.** The Round-4 assignment's "30/25/20/15/10" is
  WRONG; the code (`config.py:463-467`) is authoritative.
- Risk / priority / threat-context are **advisory only** and must NEVER reach
  `decide()`.

---

## 1. How the detection core works today, end to end

```
poll_once / ingest  →  correlate()  →  compute_risk()  →  [router→investigator→formatter]
   (poller/ingest)     (correlation)     (risk, advisory)        (agents, LLM)
        │                   │                                          │
        │                   └── cluster.signature = cluster_signature(entity_type,value)  (#4 key)
        │                                                              │
        └── handle_clusters(): drop(IGNORE|suppressed) · attach(by signature) · forward|candidate
                                                                       ▼
                                              CaseManager(prefs).apply(case)  ──▶  decide()   (#3 ONLY closer)
                                                                       │
                          threshold_automation.run() AFTER save (post-decision, #3-safe, never sets status)
```

### 1a. Correlation (`backend/app/engine/correlation.py`) — the clustering fn
Pure, no-LLM. `correlate(events, prefs, *, entity_strategy=None)`:
1. Bucket events by `ev.rule` (`by_rule`).
2. Resolve each rule name → `RuleDefinition` via `prefs.correlation_for_def(rd)`
   else legacy by-name `prefs.correlation_for(rule)`. **Skip `CorrelationMode.NEVER`.**
3. Resolve each event to `(entity_type, value)` via `resolve_entity()` — entity-agnostic
   ladder `IP→HOST→USER→RULE` (`_AUTO_LADDER`); RULE is always resolvable, so an
   in-scope event is **never silently dropped** (#4 never-drop).
4. `_window_detail(group, cfg)` applies the trigger: `EVERY`/`n<=1` → any occurrence;
   `THRESHOLD` → sliding-window sweep for densest span `>= cfg.n`. **`cfg.n` is read
   here every poll** — this is where a tuner's raised `n` takes effect with zero
   correlation-code change.
5. Keep the PRIMARY rule (highest `observed_count`) per entity; **rebuild** each
   cluster from ALL events whose `entity_value(entity_type)==value` (line 136,
   O(entities×events)).
6. `_build_cluster()` sets `signature=cluster_signature(entity_type, value)`,
   derives `is_alert` (any member `index_role=="alerts"`), `auto_investigate_eligible`
   (any member eligible), `source_ids`, `feed_ids`, and a deterministic
   `TriggerReason` ("why fired": rule/mode/n/window/severity_min/max).

**RULE-grouped subtlety:** for `EntityType.RULE`, `value = "<rule>|<bucket>"` where
`bucket = timestamp_millis // (RULE_BUCKET_SECONDS*1000)`, `RULE_BUCKET_SECONDS=300`
(models.py). `display_value` strips `|<bucket>` for the UI, but **the bucket stays IN
the signature** (distinct time windows = distinct cases).

### 1b. Cross-source correlation (opt-in second pass, Wave 5 / F6)
`cross_source_correlate(items, prefs)` groups OPEN cases sharing an entity across
`>= min_sources` DISTINCT sources within a time bucket. Returns RELATED-metadata
groups `{cross_source_cluster_id, entity_type, entity_value, members}` and **MERGES
NOTHING**. Uses `cross_source_signature()` (namespace `"xsrc"`, source-agnostic,
time-bucketed — a *different namespace* from `"cluster"`, so it can never collide with
/ replace a cluster signature). Returns `[]` when `cfg.enabled` is False (default).
The **sole writer** is `engine/ingest.link_cross_source` (applies
`cross_source_cluster_id` + `related_case_ids` + `source_breakdown` onto Case,
best-effort/swallowed errors). Callers today: `poller.py:243`, `ingest.py`.

### 1c. Signatures (`backend/app/engine/signatures.py`)
- `cluster_signature(entity_type, entity_value)` → `stable_signature("cluster",
  entity_type.value, entity_value)`. **The #4 idempotency key.** 1 open case per
  `(entity_type, value)`. `stable_signature` = `sha256("|".join(parts))[:32]`
  (utils.py:92) — algorithm/delimiter/truncation ARE the wire contract.
- `cross_source_signature(entity_type|str, value, ts_millis, window_seconds)` →
  `stable_signature("xsrc", str(et), value, ts//(window*1000))`. Accepts `EntityType`
  OR str so `"ip"` == `EntityType.IP`. **Trap:** `ts` is epoch **millis**; passing
  seconds silently mis-buckets.

### 1d. Risk (`backend/app/engine/risk.py`) — advisory 0-100, the "5 factors"
`compute_risk(cluster, prefs, reputation=0.0) -> RiskBreakdown`. Pure, sync.
The five factors, **verbatim** (this is the source for the (?) help text):

| Factor | How | Ref const | Default weight |
|---|---|---|---|
| **Volume** | `_log_norm(cluster.count, 50)` | `_VOLUME_REF=50` | `0.25` |
| **Velocity** | events/min vs 10; **only if `count>=3` AND `window>=1s`** else 0 | `_VELOCITY_REF=10.0` | `0.20` |
| **Reputation** | passed-in IP enrichment score 0..100 (0 for non-IP / enrichment off) | — | **`0.30` (heaviest)** |
| **Diversity** | `100*len(cluster.rule_values)/5` | `_DIVERSITY_REF=5` | `0.15` |
| **Asset-criticality** | `_asset_criticality(entity.value, prefs)`: CIDR-max over `asset_networks`, then exact `asset_criticality` map; IP-only | — | `0.10` |

Total = weighted blend **normalised by `sum(weights) or 1.0`** (weights need NOT sum
to 1). Called **twice per case lifecycle**: `register_candidate` (pipeline.py:443,
`reputation=0.0`, $0/no-LLM) then the full investigate path (pipeline.py:263, real IP
reputation) — a candidate's risk can rise after investigation. Reputation feeds risk
**only via `agents/pipeline.py`** (`enrich.enrich_ip → reputation → compute_risk`);
`engine/threat_context.py` reads reputation for **display only** and never feeds risk.

### 1e. decide() / apply() (`backend/app/engine/case_manager.py`) — #3, the ONLY closer
`decide(verdict, confidence, risk_score, policy, *, escalation_confidence=0.6,
critical_severity=7.0) -> Decision` — **pure, side-effect-free truth table**:
- `_entry_for(policy, verdict)`: FP→`policy.false_positive`, TP→`policy.true_positive`,
  else `None` (NEEDS_HUMAN / None **never** auto-closable).
- `escalate = TRUE_POSITIVE and (confidence>=0.6 OR risk_score>=70.0)` — advisory
  prioritisation, **never closes**.
- If `entry is not None and entry.enabled:` and `confidence >= entry.min_confidence and
  risk_score <= entry.max_risk_score:` → `Decision(status=CLOSED, decision_by=AGENT,
  objection_window_expires_at=...)`. Every other path → `NEEDS_HUMAN / SYSTEM`.

`CaseManager(prefs).apply(case)` layers the additive F8 taxonomy on top of `decide()`
WITHOUT changing the close math:
- **Defence-in-depth assertion** (line 143-144): raises `AssertionError("Invariant
  violated: attempted to auto-close a NEEDS_HUMAN case")` if `verdict in (None,
  NEEDS_HUMAN)` and `decision.status==CLOSED`.
- escalate→`ESCALATED` mapping **only in the non-CLOSED branch** (line 158).
- `_VERDICT_TO_DISPOSITION` fills `case.disposition` **only when None** (never
  overrides analyst).
- Appends to `status_history` (typed) + `history` (dict).

Defaults (`config.AutoClosePolicy`): FP `enabled=True, min_conf=0.85, max_risk=30.0`;
TP `enabled=False` (opt-in OFF); needs_human never (code-enforced).

### 1f. The analyst action layer (`api/routes.py`, NOT decide())
`_ACTION_STATUS` (routes.py:3127) maps analyst UI actions → `CaseStatus | None`. This
is a **separate additive layer** that never calls `decide()`. `_guard_transition`
(routes.py:3150) only blocks terminal-status exits (`_TERMINAL={CLOSED,RESOLVED}`)
without reopen, and blocks `set_status→CLOSED` sidesteps. `_CLOSE_ACTIONS =
{close, confirm_fp, resolve, reopen}` require `cases:close`; everything else needs
`cases:write`.

### 1g. Priority / triage chips (`backend/app/engine/priority.py`) — read-time advisory
`derive_triage(case, prefs)` → the four honest chips `{risk, severity, impact,
priority}`, each with an `inputs` bag for a UI HelpTip. Pure, read-time, never feeds
`decide()` (guarded). Powers `GET /api/cases/{id}/triage`. `severity` is
**source-asserted** (`case.trigger_reason.severity_max`, scale-projected per source
native ladder); `impact` uses the SAME `risk._asset_criticality`; `priority` is an
ITIL P1..P4 matrix lookup. **The (?) risk help text lives at priority.py:262-265**
(`risk_chip.inputs.definition`), with a duplicated fallback string in
`webui/.../CaseTriageHeader.tsx:203` — edit BOTH.

### 1h. Threat-context (`backend/app/engine/threat_context.py`) — read-only, fail-open
`assemble(case, prefs, *, enrich, rag, cases)` builds an ADVISORY panel (IOC
reputation, MITRE, related resolved cases, asset context, evidence). Every section is
independently fail-open; makes **zero LLM calls**; never mutates the case; never feeds
`decide()`. `_related_section` is the read-side "we've seen this entity before" signal
(resolved-case RAG recall + closed-case scan) — the natural precedent for Round-4's
campaign pass.

---

## 2. Key symbols / files / wire keys / endpoints

### Files (all under `backend/app/`)
| File | Owns |
|---|---|
| `engine/correlation.py` | `correlate()`, `resolve_entity()`, `cluster_from_events()`, `_build_cluster()`, `cross_source_correlate()`, `cluster_cross_source_entities()`, `CrossSourceItem`, `_entity_keys()`, `_window_detail()` |
| `engine/signatures.py` | `cluster_signature()` (#4), `cross_source_signature()` |
| `engine/risk.py` | `compute_risk()`, `_log_norm()`, `_asset_criticality()`, refs `_VOLUME_REF=50`/`_VELOCITY_REF=10.0`/`_DIVERSITY_REF=5` |
| `engine/case_manager.py` | `decide()`, `Decision`, `_entry_for()`, `CaseManager.apply()`, `_VERDICT_TO_DISPOSITION` — **FROZEN (#3)** |
| `engine/priority.py` | `derive_triage()`, `severity_band_from_events()`, `impact_band()`, `urgency_band()`, `derive_priority()`, `_scale_for_case()`, `_normalise_severity()` |
| `engine/threat_context.py` | `assemble()` + `_ioc_section/_mitre_section/_related_section/_asset_section/_evidence_section` |
| `engine/threshold_automation.py` | post-decision `AutomationRule` (#3-safe); **template + naming source** for the Round-4 tuner |
| `engine/ingest.py` | `handle_clusters()` (drop/attach/forward/candidate), `passes_suppression`, `link_cross_source` |
| `config.py` | `RiskWeights` (:459), `CorrelationRule` (:390), `RuleDefinition`, `AutomationRule` (:887), `AutoClosePolicy`/`VerdictAutoClose`, `CrossSourceCorrelationConfig`, `AssetNetwork`, `PriorityMatrix`, `ThreatContextConfig` |

### Config / wire keys (must stay stable or aliased)
- `Preferences.risk_weights` → `{volume, velocity, reputation, diversity,
  asset_criticality}` defaults `0.25/0.20/0.30/0.15/0.10`.
- `Preferences.asset_criticality` (dict entity_value→0..100), `Preferences.asset_networks`
  (list[`AssetNetwork`]{`cidr`, `criticality`}).
- `CorrelationRule` = `{mode, n(ge=1), window_seconds, group_by}` — **tuner target: raise `n`**.
- `IndexPattern.severity_floor` (int 1-6, OCSF severity_id) — **tuner target: raise it**.
- `AutoClosePolicy.{false_positive, true_positive, needs_human}` +
  `VerdictAutoClose.{enabled, min_confidence, max_risk_score, objection_window_minutes}`
  — the ONLY data `decide()` consumes.
- `CrossSourceCorrelationConfig.{enabled(False), time_window_seconds, min_sources(>=2),
  entity_keys}`.
- `EntityType` values `ip/user/host/file_hash/domain/rule` — **load-bearing hash inputs**.

### Endpoints
| Method / path | Handler | Auth |
|---|---|---|
| `GET /api/cases/{id}/triage` | `routes_triage.case_triage` → `derive_triage` | `cases:read`, never 404s |
| `GET /api/cases/{id}/threat-context` | `routes.case_threat_context` → `assemble` | `cases:read` |
| `POST /api/cases/{id}/action` | `_perform_case_action` (uses `_ACTION_STATUS`) | `cases:write`/`cases:close` |
| `POST /api/proposals/{id}/approve` | routes.py:1066 | `require_admin` — **the single live-write path for suppressions** |

---

## 3. Round-4 bugs: exact location + fix surface (this domain)

### Bug #3 — "Acknowledge" maps to `None` (does nothing) → should be INVESTIGATING
- **Location:** `api/routes.py:3136`, `_ACTION_STATUS["acknowledge"] = None`.
- **Fix:** change to `CaseStatus.INVESTIGATING`. The enum value already exists
  (`constants.py`, wire value `"investigating"`, in `OPEN_CASE_STATUSES`).
- **Why #3-safe:** `INVESTIGATING` is a non-terminal analyst status reached only via the
  human-action layer; `_perform_case_action` NEVER calls `decide()`. `_guard_transition`
  passes it cleanly (not a terminal exit, not a `set_status→CLOSED` sidestep).
  **Do NOT add `acknowledge` to `_CLOSE_ACTIONS`** and **do NOT add `INVESTIGATING` to
  `_TERMINAL`.** RBAC stays `cases:write`.
- Optional polish (#10 cleaner case view): also stamp `case.acknowledged_at` on
  acknowledge (MTTA reads this) — but mind the `Case` str-vs-datetime asymmetry
  (`created_at:str`, `acknowledged_at:datetime|None`).

### The other Round-4 items in this domain are ADDITIVE, not bug-fixes
- **#4 adaptive threshold auto-tuning** — a **new, separate** nightly deterministic
  observer module. It reads recently-closed cases, computes **per-rule FP rate**
  (Wilson lower-bound + min-samples ~20-30 + EWMA volume trend — none of this exists
  yet; grep for `wilson`/`ewma`/`auto_tune` returns nothing), and auto-applies BOUNDED
  changes: **raise `CorrelationRule.n` by ≤1 step** or **raise a feed `severity_floor`**,
  with before/after audit + one-click rollback + shadow-eval. **Attach point:** a config
  writer only — it mutates `CorrelationRule.n` / `IndexPattern.severity_floor` in
  `Preferences`, which `correlate()` (`cfg.n` in `_window_detail`) and the connector /
  cluster gate read **live** on the next poll. **It must NEVER**: import/call `decide()`;
  set `status`/`disposition`; touch risk weights; alter `cluster_signature`.
  **Suppression DROPs** must route through the existing HITL Proposal queue
  (`threshold_automation._create_proposal` pattern → `ProposalStore.add` →
  `POST /api/proposals/{id}/approve`), NEVER auto-applied.
- **#5 two-tier + daily campaign correlation** — ALERT feeds already investigate
  per-alert via `is_alert→handle_clusters`. The daily CAMPAIGN pass must LINK related
  cases via the existing `cross_source_correlate` / `link_cross_source` machinery
  (RELATED metadata only, `"xsrc"` namespace) and **leave `cluster_signature`
  byte-identical**. Agent-driven EVENT DETECTION creates candidate clusters that must
  still flow through `correlate()`/`_build_cluster()` (or `cluster_from_events()`) so
  they get the SAME `cluster_signature` and run the SAME `decide()`.

---

## 4. Invariants this domain enforces, and exactly where

| # | Invariant | Enforced at |
|---|---|---|
| **#3** | `decide()`/`apply()` byte-identical; the ONLY producer of `CLOSED`; NEEDS_HUMAN never auto-closes | `case_manager.py` (whole file); assertion at `:143`; guarded by `tests/test_wave6_decide_guard.py` (greps source substrings + asserts `"automation"` absent) |
| **#3 (advisory boundary)** | risk / priority / threat-context never reach `decide()` | `risk.py`, `priority.py`, `threat_context.py` never import `case_manager`; `test_round3_wave2_triage.py::test_decide_is_invariant_to_priority` sweeps bands, asserts identical `decide()` output |
| **#4** | `cluster_signature` byte-identical; 1 case per `(entity_type,value)`; `find_open_by_signature` attach-not-duplicate | `signatures.py:18`; `_build_cluster` (correlation.py:211); `pipeline.find_open_by_signature`; cross-source pass MERGES NOTHING (`cross_source_correlate` returns groups only) |
| **#4 (never-drop)** | in-scope event always forms a cluster (RULE terminal); below-`severity_floor` → CANDIDATE not drop | `resolve_entity` RULE fallback; `handle_clusters` — ONLY drops are `_is_ignored_cluster` (all-IGNORE) + `not passes_suppression` (all-suppressed) |
| **#6** | this domain makes ZERO LLM calls; one ledger row per call happens later in `agents/pipeline`→`llm/gateway` | correlation/risk/signatures/priority/threat_context all LLM-free; `register_candidate` is explicitly $0 |
| **#9** | `TriggerReason.sentence`, entity values, provider results, evidence are UNTRUSTED; built as plain DATA, fenced/escaped at the prompt/UI boundary | `_build_trigger_reason` builds plain strings (no prompt interpolation); prompts.py fences; threat_context uses `fence_provider_result` on non-IP path; priority `inputs` bag rendered as plain text |
| **#1** | this domain reads already-persisted Cases; never opens an ES client / crosses `_ro`/`_mgmt` | priority/threat_context/risk/correlation/signatures/case_manager have no ES client |

---

## 5. Contracts a refactor MUST preserve (byte-identical or aliased)

**Frozen byte-identical (guarded by tests):**
- `decide()` source: name, signature `(verdict, confidence, risk_score, policy, *,
  escalation_confidence=0.6, critical_severity=7.0)`, the two load-bearing branch
  lines, `status=CaseStatus.CLOSED,`, `decision_by=DecisionBy.AGENT,`, and the comment
  `Class disabled, or NEEDS_HUMAN / unknown verdict → always a human.` — verbatim.
- `decide()` and `apply()` must contain **no** substring `"threshold_automation"` or
  `"automation"`.
- `apply()` assertion string `"Invariant violated: attempted to auto-close a
  NEEDS_HUMAN case"`.
- `cluster_signature = stable_signature("cluster", entity_type.value, entity_value)` —
  no added/removed/reordered parts, no changed prefix.
- `stable_signature` algorithm: `"|".join(_norm_part) → sha256 hexdigest[:32]`
  (changing hash/delimiter/normalisation/truncation re-keys EVERY case in ES + SQL).
- `cross_source_signature` `"xsrc"` prefix + `EntityType|str` acceptance + bucket math.
- `EntityType` values (`ip/user/host/file_hash/domain/rule`) + `RULE_BUCKET_SECONDS=300`
  + the `"<rule>|<bucket>"` RULE value format.
- Risk ref constants `50/10.0/5` + velocity floor (`count>=3 AND window>=1s`) — changing
  them changes stored `risk_score`s.

**Wire keys / API shapes (keep or alias):**
- `RiskWeights` field names + defaults `0.25/0.20/0.30/0.15/0.10`; `RiskBreakdown`
  fields `volume/velocity/reputation/diversity/asset_criticality/total`.
- Triage chip JSON: top-level `{risk, severity, impact, priority}`; `risk={value, band,
  breakdown, inputs}`; `severity={band, value, raw, source('source_asserted'|'derived'),
  scale, inputs}`; `impact={band, value, criticality, entity, inputs}`;
  `priority={level, impact, urgency{band,value,escalated}, matched, default, inputs}`.
- `AutoClosePolicy`/`VerdictAutoClose` wire keys (with legacy `fp_auto_close` migration).
- `CorrelationRule`/`AutomationRule`/`CrossSourceCorrelationConfig` field names.
- Cluster/Case fields `cross_source_cluster_id`, `related_case_ids`, `source_breakdown`,
  `source_ids`, `feed_ids`, `is_alert`, `auto_investigate_eligible`.

---

## 6. The 3-way "correlate" + 3-way "rule" collisions — safe rename plan

**"correlate" means 3 things** (Round-4 #11 cleanup is **UI/docs only** — keep all
code names/wire keys/aliases):
| Meaning | Symbol | Wire key |
|---|---|---|
| the clustering FN | `correlation.correlate()` | — |
| per-SOURCE toggle | `SourceInstance.auto_correlate()` | `config['auto_correlate']` |
| per-FEED toggle | `IndexPattern.correlate` (alias `.auto_correlate`) | legacy `auto_correlate` → `correlate` |

**"rule" means 3 things:**
| Meaning | Model | Round-4 rename? |
|---|---|---|
| classify | `RuleDefinition` (config.py) | keep |
| fire (correlation) | `CorrelationRule` (config.py) | keep — **tuner target** |
| post-decision | `AutomationRule` (config.py:887) | **rename → `CaseAutomationRule`, ALIAS `AutomationRule`** (Python + `webui/src/lib/types.ts`); keep wire key `threshold_automation` + rule shape byte-identical |

Safe-rename rule: disambiguate ONLY in UI copy / docs / help text. The `.auto_correlate`
property alias, `config['index_patterns']`, `config['auto_correlate']`,
`correlation_rules`, and `threshold_automation` are load-bearing and MUST NOT be renamed
in code. If `AutomationRule` is renamed, add a Python + TS alias so stored configs
round-trip verbatim (approve/reject branch at routes.py:1086-1149 must still handle it).

---

## 7. Where the metrics gap for #4 auto-tuning is (per-rule FP rate does NOT exist)

`engine/metrics.py::quality_metrics.false_positive_rate` is **verdict-level over ALL
cases** (`fp/verdicted`) — NOT per-rule/per-feed. Round-4 #4 needs a NEW per-rule FP
metric (Wilson lower-bound + min-samples + EWMA). The tuner should **reuse** the safe
patterns in `metrics.py` (`percentile()`, `_window_filter()` for the recently-closed
window, disposition/verdict tallying, `_parse_iso`/`_as_dt` time coercion) but live in
its own module and **never import `metrics` into a decision path**. `Case.rule_ids` is
what a per-rule FP metric keys on. Precedent for the closed-case read pattern:
`threat_context._related_section` (`cases.list(status=CLOSED, limit=200)`) and
`shift_report` — but page/aggregate, don't copy the naive 200-cap.

---

## 8. Risks / gotchas for build agents

1. **BIGGEST RISK:** the `test_wave6_decide_guard.py` guard asserts the literal word
   `"automation"` is absent from BOTH `decide()` and `apply()` source. Any Round-4 code
   that even *mentions* automation/tuning inside `case_manager.py` (a comment, a docstring
   line) breaks the guard. Keep the tuner and campaign pass in **new modules**; do not
   touch `case_manager.py` at all.
2. **Two signature namespaces:** `"cluster"` (per-case 1:1 #4 key, NO time component)
   vs `"xsrc"` (cross-source group, time-bucketed). The campaign pass MUST use xsrc-style
   RELATED links; computing a new `cluster_signature` would spawn/duplicate cases.
3. **RULE-grouped signature carries the `|<bucket>` suffix** even though the displayed
   entity strips it. Do NOT sign `display_value` — that collapses distinct time buckets
   into one case (a #4 regression).
4. **Doc-vs-code weight mismatch:** default risk weights are `25/20/30/15/10`
   (reputation heaviest), not the assignment's `30/25/20/15/10`. Code is authoritative;
   reconcile UI/docs, never "fix" the code to match the wrong doc.
5. **Risk help text is duplicated** — canonical `engine/priority.py:262`
   (`inputs.definition`) + hardcoded fallback `CaseTriageHeader.tsx:203`. Edit BOTH.
   Neither currently states the honest "ranks-but-never-closes" caveat on the risk chip
   (that caveat lives on the priority chip).
6. **Raising `severity_floor`/`n` indirectly changes Volume/Velocity/Diversity inputs**
   (fewer members). That is acceptable (risk is advisory) and MUST NOT be conflated with
   "the tuner touching risk weights" (which is forbidden).
7. **`cluster_from_events()` (correlation.py:177) passes `trigger_meta=None`** → no
   `TriggerReason`. Manual-investigate / agent-created clusters via this path have no
   "why fired" sentence and severity chips fall back. Set trigger meta if you need chips.
8. **`impact_band` requires non-None `prefs`** (reads `asset_networks`); `severity_band`
   tolerates `prefs=None`. `derive_triage` always passes real prefs.
9. **DUPLICATE `derive_priority`:** `priority.py` (rich dict, ignores `matrix.enabled`,
   always returns a level) vs `shift_report.py` (str|None, respects `matrix.enabled`).
   They can disagree; a consolidation must keep both call-site contracts.
10. **`Case.severity_band/severity_source/impact_band/urgency_band/priority_level` are
    STORED but NEVER written** by any pipeline code today — `metrics.sla_metrics` /
    `shift_report` read `priority_level` and get `None` (SLA scoring silently no-ops). If
    Round-4 populates them, use `priority.py` derivation and keep them out of `decide()`.
11. **`_related_section` / `cross_source_correlate` pool only 200 recent cases** — a daily
    campaign pass over a busy tenant misses cases beyond that page. Page/scope
    deliberately; don't reuse the 200-cap verbatim.
