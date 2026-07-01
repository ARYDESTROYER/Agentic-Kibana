# Round 5 · P2 External Research — Rules Customization UX

**Target:** TLSOC Agentic Triage Suite — a data-dense SOC triage console (standalone
Vite + React + TS + Tailwind + shadcn/Radix SPA; FastAPI + LangGraph backend).
**Scope of this doc:** a concrete, implementable **rules customization UI** — which rule
types to expose, how to build the condition/editor surface (build vs. buy), how to design
the threshold/numeric config UX, and how to run the rule lifecycle (enable → test →
version → audit → rollback).
**Author stance:** opinionated + implementation-ready. Every recommendation below maps to
an existing wire key / component in this repo where possible, and the default rule editor
adds **zero new npm deps** (only a *nested* AND/OR builder and an optional YAML surface
would add deps, each explicitly gated and justified).

---

## 0. TL;DR — the decisions

| Question | Decision |
|---|---|
| **Rule types to expose** | Three tiers, mapping to code we already have: **(A) Detection rules** (`RuleDefinition` — classify a raw event → named rule) → threshold/correlation; **(B) Case-automation rules** (`CaseAutomationRule` — post-decision, HITL-safe); **(C) Tuning** (the auto-tuner, surfaced as *suggestions* on A). Do **not** build all 7 Elastic rule types. |
| **Editor shell** | Elastic's **four-section** editor: **Define → About → Schedule → Actions**, as Radix `Tabs`. The **Define** section is **polymorphic on rule type** (discriminated union). Zero new deps. |
| **Condition builder (simple, all-AND)** | **BUILD** — a flat list of `{field, op, value}` rows over existing Radix `Select`/`Input`. This is what `RuleMatch` already is. Zero deps. |
| **Condition builder (nested AND/OR)** | **BUY, gated** — `react-querybuilder` v8 via its **official shadcn registry** (`npx shadcn add …/r/query-builder.json`). Only ship where real nesting is needed (a future visual detection-rule editor). MIT. |
| **Threshold / numeric UX** | Build **one `NumberField`** (stepper + clamp-on-blur + unit + reset) and **one `LabeledSlider`** (Radix slider ⇄ linked input + ticks). **Never slider-only** for load-bearing values. Zero new deps. |
| **Lifecycle** | Three states **enabled / disabled / shadow(preview)**; a **Test/Preview against recent data** panel (read-only, no `decide()`, no LLM); an immutable **version ledger + diff + one-click rollback**; risky changes routed through the existing **Approvals/Proposals** HITL queue; a per-rule **health chip** (last-run status). |
| **Import/export** | Optional **Sigma import/export on the backend** via `pySigma` (server-side Python dep only) for portability + the public SigmaHQ library. Frontend needs nothing. |
| **Validation** | A small **zod** schema (~13 KB) mirroring `config.py` Pydantic models as the single source of truth for client-side validation + defaults. Gates Save. Justified small dep. |

Bundle-budget rule for the whole feature: **the guided form is dep-free.** New deps are
opt-in and lazy-loaded — `react-querybuilder` (only for the nested builder), `pySigma`
(backend only), `zod` (small, shared with the wider settings-validation effort).

---

## 1. Context — what this app already has (do not re-roll)

The rules surface is **~70% built** in the backend already; this is mostly a UI
consolidation + a preview/versioning layer, not a rewrite.

**Backend models (`backend/app/config.py`):**
- `RuleMatch` — `{field, op: equals|prefix|tag|exists, value}` — **this is our predicate row.**
- `RuleDefinition` — `{name, enabled, description, match, correlation?, model_override, priority}` — a **pre-baked-but-editable detection rule** (the "A" tier).
- `CorrelationRule` — `{mode, n (≥1), window_seconds (≥1), group_by: EntityType}` — the **threshold/suppression** knobs (n = "trigger after N", window = suppression window, group_by = the grouping entity).
- `CaseAutomationRule` — `{id, enabled, priority, conditions{}, action: tag|recommend|notify|run_playbook|request_approval, payload{}}` — the **post-decision, HITL-safe** rule (the "B" tier). Wire key `threshold_automation`; alias `AutomationRule` kept.
- `ThresholdTuningConfig` — `{enabled(OFF), min_samples=25, max_n_step, fp_rate_target=0.30, wilson_z, …}` — the auto-tuner (the "C" tier).
- `IndexPattern` (feed) — carries per-feed `severity_floor` (OCSF 1–6), `query`, `field_mapping`, schedule, `correlate`/`auto_investigate`.
- `CapsConfig.max_concurrent`, `AutoClosePolicy.min_confidence/max_risk_score`, `CampaignConfig`, `BaselineConfig`, `BatchConfig` — additional numeric knobs.

**Frontend (`webui/`):**
- `recharts` **is already a dep** (`charts.tsx` = theme-aware recharts wrappers) → the preview histogram is free.
- `@radix-ui/react-slider` present (`ui/slider.tsx`); shadcn `Input`/`Select`/`Switch`/`Tabs`/`Dialog`/`Sheet`/`Popover`/`Badge` all present; `DataTable`, `SettingsGrid/Card`, `SettingsTOC`, `StickySaveBar`, `MitreHeatmap`, `TraceTimeline`, `Can` (RBAC), `FeedPreviewChip`, `RoleSegmented` all present.
- `Tuning.tsx` already does per-rule Apply/Rollback, a before→after chip, "Safe-to-apply" vs "Needs approval" badges, and a "Why" column — **generalize this into the rules lifecycle UI.**
- React **18.3.1** (satisfies `react-querybuilder`'s React-18 minimum), Vite 5.4.11.

**Backend spine already present for lifecycle:**
- `stores/tuning.py` — a before/after ledger with `applied_at`, `rolled_back`, optimistic-concurrency via `KVStore.mutate` (`_rev` compare-and-set, fail-safe). **Generalize this into a per-rule change/version ledger.**
- `engine/threshold_automation.py` routes risky changes → a HITL `Proposal`.
- `GET /api/logs` (scatter-gather, hard-capped 200) + `GET /api/sources/{id}/logs` (per-source scoped read-only browse) — **the read paths the preview runs on.**
- Append-only audit index (`tlsoc-agent-audit-*`) — lifecycle events go here (#2).
- Per-user KV prefs store (zero-migration) — saved views, table sort/filter, and **rule test fixtures** live here.

**The non-negotiables this feature must never break:**
- **#1** read-only scoped ES key — preview/test runs on the RO key only, capped.
- **#2** every lifecycle action audited, append-only.
- **#3** `decide()` is the *only* close/escalate authority — the builder produces *config*, never a decision; preview never calls `decide()`; rule actions are proposal/HITL-only.
- **#4** durable `{source.id}:{feed.id}` cursor — no skip/no dup; `severity_floor` blocks forward but **never drops** the candidate.
- **#9** log-derived / user-entered values are UNTRUSTED — render as plain text / `InlineCode`, never interpolated into HTML or ES DSL by string concat.
- **#10** sane defaults — advanced overrides stay under "Advanced"; defaults visible + resettable.

---

## 2. Rule types to expose (the taxonomy)

Elastic ships **7** rule types (custom query/KQL, EQL, threshold, indicator-match,
new-terms, ES|QL, ML). **Do not copy all 7.** Model the **Define** section as a
discriminated union and expose only the types we can actually evaluate today, adding more
behind the same union later.

**Ship now — three families, each already backed by code:**

| UI rule type | Backend model | Define-section fields | Notes |
|---|---|---|---|
| **Detection rule — Match + Threshold** (default) | `RuleDefinition` + `CorrelationRule` | predicate rows (`RuleMatch[]`) → *Group by* (`group_by`) + *Trigger after N* (`n`) + *Within window* (`window_seconds`) | The bread-and-butter SOC rule. `n=1` = a simple match rule; `n>1` = a threshold/brute-force rule. |
| **Detection rule — Anomaly / Baseline** | `BaselineConfig` (per cluster-signature EWMA/EWMV) | *Group by* + *sensitivity* (modified-z, default \|M\|>3.5) + warm-up | Fire when a signature deviates from its learned hour-of-week baseline. Advisory input to a candidate, never `decide()`. |
| **Case-automation rule** (post-decision) | `CaseAutomationRule` | `conditions{}` (verdict / min_risk / status / source_id / rule_name / entity_type) → one `action` (tag/recommend/notify/run_playbook/request_approval) | Fires **after** `decide()`+save. **Never** sets status/disposition (#3). "request_approval" → HITL Proposal. |

**Cross-cutting concepts — expose as distinct, clearly-labeled controls (Elastic keeps
these separate; conflating them is a known analyst pitfall):**

1. **Threshold** = *group-by field(s)* + *count N* (`CorrelationRule.n/group_by`). "Fire when ≥ N events share these fields."
2. **Suppression** = collapse alert storms. *Suppress by* up-to-3 fields + *per-rule-run vs per-time-window(duration)* + *missing-field: suppress / do-not-suppress*. Maps to `window_seconds` + `group_by`. **Copy Splunk/Elastic labels** ("Fields to group by", "suppression window") — analysts already know them.
3. **Exceptions** = allow-list conditions (AND/OR/nested, optional expiry, "close matching alerts"). *Per-rule default list* vs *shared reusable lists* (shared is a footgun — see §7). This is the one place the **nested** builder earns its keep.
4. **MITRE mapping** = cascading `tactic → technique → sub-technique` selects (bundled 697-technique corpus). Feeds `mitre_coverage` + Navigator export. **Advisory only** (#3). Keep in **About (advanced)**.
5. **Severity/risk override** = power-user only; keep under **Advanced** (#10).

> **Do NOT** overload the word "rule." Keep the Round-4 terminology
> (**detection-rule** vs **case-automation**; detection vs alert vs case vs campaign).
> Adopt Elastic's *Suppression / Exception / Threshold* labels because analysts know
> them — but not Elastic's overloaded "rule" for both logic and action-scheduling.

---

## 3. Editor shell — the four-section pattern

**Adopt Elastic's four-section editor**, built entirely from existing primitives:

```
┌ Rule editor (Sheet or full page) ───────────────────────────────────┐
│  [ Define ] [ About ] [ Schedule ] [ Actions ]     ← Radix Tabs      │
│                                                                      │
│  Define   → polymorphic on rule type (discriminated union)           │
│             · type picker (Match+Threshold / Anomaly / Case-auto)    │
│             · predicate rows / conditions                            │
│             · Threshold: Group-by + N + Window (LabeledSlider/NumberField) │
│             · Suppression sub-card (up-to-3 group-by + window + missing-field) │
│  About    → name, description, severity/risk (advanced), tags,       │
│             references, false-positive notes, investigation guide,   │
│             MITRE cascade (advanced)                                 │
│  Schedule → "runs every {interval}" + "additional look-back time"    │
│             (reuse per-feed schedule + {source.id}:{feed.id} cursor) │
│  Actions  → ordered list bound to threshold_automation HITL actions; │
│             frequency (per-run / per-alert / summary) + snooze       │
│             ("Proposal only" badge; auto-close is code-forbidden #3) │
└──────────────────────────────────────────────────────────────────────┘
```

**Why tabs, not one long form:** familiar to any SOC analyst; cleanly separates *logic*
(Define) from *metadata* (About) from *ops* (Schedule/Actions). Mitigate the "heavy for
simple rules" con with **sane defaults + collapsed Advanced** — a simple match rule needs
only Define.

**Define as a discriminated union (TS shape):**

```ts
type RuleType = 'detection_match' | 'detection_anomaly' | 'case_automation';

type RuleForm =
  | { type: 'detection_match';  match: Predicate[]; threshold: { groupBy: EntityType; n: number; windowSeconds: number };
      suppression?: { by: string[]; scope: 'per_run' | 'per_window'; windowSeconds?: number; missingField: 'suppress' | 'keep' } }
  | { type: 'detection_anomaly'; groupBy: EntityType; sensitivity: number /* modified-z */; warmupMultiplier: number }
  | { type: 'case_automation'; conditions: Record<string, unknown>; action: AutomationAction; payload: Record<string, unknown> };
// Predicate = { field: string; op: 'equals'|'prefix'|'tag'|'exists'; value?: string }  ← exactly RuleMatch
```

The form is **UI-only**: a thin deterministic adapter maps `RuleForm` ↔ existing wire
keys (`RuleDefinition` / `CorrelationRule` / `CaseAutomationRule`). This keeps
`case_manager.decide()` and backend contracts **byte-identical** (#3) — the builder never
feeds `decide()`.

---

## 4. Condition builder — build vs. buy

### 4a. Simple, all-AND predicates → **BUILD** (zero deps)

Most SOC threshold rules are a flat AND-list of predicates — which is *exactly* what
`RuleMatch[]` already is. Render repeatable rows:

```
[ field ▾ ]  [ op ▾ ]  [ value ]  [ × ]      ← shadcn Select + Select + Input + ghost Button
                                    [ + Add condition ]
             ▲ implicit AND (label it)
```

- **field** — a typed select constrained to the **OCSF schema** (with per-field operators + value-editor types: enum select for verdict/severity, IP validator for indicators, date picker for timestamps). This prevents invalid rules.
- **op** — the existing four: `equals | prefix | tag | exists` (hide the value input when `op = exists`).
- **value** — plain-text `Input`, rendered as untrusted everywhere it's echoed (#9).

This is the same shape as the app's search/filter UI. **No query-builder dep needed.**
Cap the common case here; do not drop a heavy builder on it.

### 4b. Nested AND/OR (exceptions, complex detection logic) → **BUY, gated**

For **nested boolean groups** (AND/OR/nested, "1 of …") — needed for exception lists and
future complex detection logic — flat rows fall apart. **Do not hand-roll recursive
group state, drag-reorder, validation, and (de)serialization** — that is exactly the
fiddly, well-solved work `react-querybuilder` gives you.

**Decision: adopt `react-querybuilder` (RQB) v8 (MIT), via its official shadcn registry.**

- **Why RQB:** the category standard (~400k weekly downloads, 14× its nearest rival), TS-native, tree-shakeable, and it now ships a **first-party shadcn registry**:
  ```
  npx shadcn add https://react-querybuilder.js.org/r/query-builder.json
  npm i react-querybuilder
  ```
  The registry **copies source components into our repo** (shadcn-native, editable, no style-lib runtime dep) and auto-pulls only shadcn primitives we already own (`button/checkbox/input/label/radio-group/select/switch/textarea`). **Net new runtime deps ≈ RQB core only** (immer + a small parser + Redux Toolkit for its internal state).
  > **Verify at install time:** the registry asset 404'd to a raw curl in a prior sandbox (likely a CDN/bot quirk). If the CLI can't resolve it, fall back to copying from `website/registry/default/query-builder/` in the RQB repo, or the community `react-querybuilder-shadcn` npm package. Prefer the official registry (source-in, no style-lib dep) over the community npm package (which pulls `react-day-picker`/`cmdk`).
- **Avoid `react-awesome-query-builder`** — it drags in `immutable.js`, `lodash`, `i18next`, `spel2js`, and the **deprecated `moment.js`**, has ~4× fewer downloads, and has no shadcn story. Wrong fit.
- **Tree-shake the formatters:** import only what you use — `formatQuery(query, 'elasticsearch')` (or `'jsonlogic'`) — each is a separate entry point. Import parsers (`parseSQL`, etc.) only when needed (they add ~50% to the bundle otherwise).
- **Skip `@react-querybuilder/dnd`** unless drag-reorder is a real requirement — it adds a DnD peer dep (dnd-kit). Basic add/remove/nest AND/OR needs no DnD.
- **Store** the query as RQB's native `RuleGroupType` JSON (additive field in the per-user KV / saved-views store — zero migration). **Cap nesting depth at 3** (Zapier's proven cap) and disable "add group" past it. Feed RQB a **typed fields array derived from OCSF** so only valid conditions can be built.
- **Gate it behind a flag** (opt-in/experimental Settings surface, like Round-4 features) so the simple flat editor stays the default and the dep footprint is scoped.
- **Restyle** the copied components to `theme.css` tokens + `palette.ts`; place them as a `condition-builder` SOC-domain component under `webui/src/soc/components/`.

### 4c. Escape hatch (raw YAML/query) → **optional, lazy-loaded**

Splunk's dual-mode (guided form default + raw escape hatch) is the right end state, but
**only ship the raw surface if power-users actually need free-form YAML.** If you do:

- Use **CodeMirror 6** (`~300 KB`, tree-shakeable) + `codemirror-json-schema` for YAML/JSON-Schema validation — **not Monaco** (`~2–5 MB`, a bundle trap for a data-dense console). **Lazy-load** it so form-only users (the 90%) pay nothing.
- Keep **one canonical model** (`RuleForm`/`RuleDefinition`) and generate *both* views from it. When a hand-edited raw rule can't be represented in the form, show Splunk's **grayed-out "guided editing disabled for this rule"** notice instead of silently dropping fields.
- **Do not build a homegrown DSL.** Borrow Sigma as interchange (§8); keep compilation on the backend.

---

## 5. Threshold / numeric config UX

The load-bearing values are `n` (correlation), `window_seconds`, `severity_floor` (OCSF
1–6), `min_confidence`/`fp_rate_target`/`max_risk_score` (0..1 rates), `min_samples`,
`max_concurrent`, poll intervals.

**Cross-industry consensus (Baymard, NN/g, Carbon, Chakra, MDN): never make the analyst
choose slider *or* number — pair them, bidirectionally linked.** A bare slider is *wrong*
for exact, safety-critical values: *"for precise input a slider can never beat a regular
input field."*

**Build exactly two reusable components** (`webui/src/soc/components/`), both zero-dep
(Radix Slider + shadcn Input already present):

### 5a. `NumberField` (the primary control for most values)

```ts
<NumberField value={} onChange={} min={} max={} step={} unit? default? help? />
```
Behavior: `type=number` with min/max/step; **clamp to [min,max] on blur/Enter** (not
mid-typing); unit as a right-adornment; helper text stating **safe range + consequence**
("1–20; default 5"); **disable (never hide)** the +/- buttons at a bound; round to the
step (kill `0.7000000001` artifacts); `tabular-nums` on the readout to avoid layout shift;
show an inline **Reset** when `value !== default`.

Use for: `n`, `min_sources`, `max_concurrent`, `min_samples` (integers); and as a
**percent field** (edit "70%", store `0.7`, step 5) for `min_confidence`,
`fp_rate_target`, `max_risk_score`.

### 5b. `LabeledSlider` (for ordinal + exploration-friendly ranges)

Pairs the Radix slider with a **linked `NumberField`** (bidirectional), a live value
readout, **tick labels** for discrete scales, and a reset. Use for:
- **`severity_floor`** (OCSF 0=None … 6=Fatal) with tick labels — *or* reuse the existing `RoleSegmented` 6-way control from `SourceEditor.tsx`.
- window/duration values where coarse exploration helps.

### 5c. Control-per-field-type (don't default to sliders)

| Field kind | Control | Reason |
|---|---|---|
| Small-range **integers** (`n` 1–20, `min_sources` 2–5, `max_concurrent`) | `NumberField` stepper | NN/g: steppers for small adjustments around a clear default; sliders bad for precise ints |
| **Ordinal** bounded (`severity_floor` 1–6) | `LabeledSlider` w/ ticks **or** `RoleSegmented` | bounded, immediate feedback, ordinal meaning visible |
| **Wide-range durations** (`window_seconds`, `poll_interval_seconds`, `objection_window_minutes`) | `NumberField` with unit suffix, edit in min/hr store seconds | avoid "900 seconds" cognitive load; **never a linear seconds slider** (log-distributed range) |
| **0..1 rates** (`min_confidence`, `fp_rate_target`) | percent `NumberField` (+ optional linked slider) | analysts read %, floats leak artifacts |

### 5d. Safety framing + live preview

- **Enforce bounds in the UI, not just the backend** — an analyst must never be able to save a window of 0 or a severity floor of 9.
- **Surface the tuner's suggestion inline** — next to the operator-editable `n`/`severity_floor`, show a "tuner recommends N" chip (from `threshold_tuner`'s bounded +1 proposal). Advisory; the operator still owns the value.
- **Keep the live "effective config" preview** (`FeedPreviewChip` already does this: "floor ≥ High (below: candidate only)") and **extend it** to Tuning + correlation config: a one-line human summary that updates on every change ("Auto-forward every cluster of ≥ 5 events within 15 min"). Where cheap, add an **estimated-impact** readout ("~N of the last 1000 events would auto-forward at this floor") via `GET /api/logs` — **read-only, never `decide()`**.
- **Preserve the non-destructive copy:** `severity_floor` must keep "below: candidate only — never dropped" (#4); Tuning must keep "tuning never closes a case / suppression routes to Approvals" (#3). A prettier slider must not *imply* data loss.

---

## 6. Rule lifecycle — enable / test / version / audit / rollback

Mature SIEM/detection products (Elastic, Datadog, Panther) converge on a
**detection-as-code lifecycle even in the GUI.** The five pieces:

### 6a. Explicit state machine (not just a boolean)

**`enabled | disabled | shadow(preview)`.** Shadow = *evaluates against live data but
creates no real cases/alerts* (degrades to advisory/NEEDS_HUMAN, consistent with #3). Let
a new or retuned rule run in shadow for N days before it can escalate.

- Per-row **Switch** (already used in `Tuning.tsx`) + a **bulk-action bar** (`DataTable` selection): enable/disable, add/remove tags, snooze, run-now/preview.
- **Gate "Disable" behind approval + a coverage warning** — disabling a noisy rule instead of tuning it is the #1 SIEM anti-pattern (CardinalOps). Make **"Tune" the primary CTA**.

### 6b. Test / Preview against recent data (the single highest-value trust feature)

Before enabling, run the rule read-only over a historical window (**default 7–14 days** to
capture weekday+weekend, per Elastic) and show:
- **count** of would-be matches,
- a **time-bucketed histogram** (reuse `charts.tsx` — recharts already a dep),
- explicit **warnings** when volume is far above/below the recorded baseline,
- for suppression, **what would collapse**.

**Guardrails (mandatory):** runs on the **RO scoped key only** (#1); **hard-cap** the
window + result count (browse already caps 200); renders every log-derived value as
**plain text / `InlineCode`** (#9); **never** calls `decide()`, **never** creates a case,
**never** bills an LLM (#3). Build on the existing `GET /api/logs` scatter-gather +
`GET /api/sources/{id}/logs`. Also expose an inline **"Test rule" fixtures** panel
(Panther-style): paste a sample OCSF/JSON event → a backend endpoint evaluates
`RuleMatch.matches()` → pass/fail; store fixtures **with the rule** via the zero-migration
KV pattern. Zero LLM cost, huge trust win.

### 6c. Immutable version history + diff + one-click rollback

**Generalize the existing `stores/tuning.py` ledger** (before/after + `applied_at` +
`rolled_back` + `_rev` CAS) into a **per-rule change ledger for ALL rule edits** (not just
the auto-tuner). Surface a **"History" drawer** on the rule row:
- list of versions with **author + timestamp**,
- a **red/green field-level diff** — reuse the existing `before→after` chip for scalars; for query text add a **tiny (~1–2 KB) inline word/line-diff** — **do NOT add a diff library** (honors "no heavy deps"),
- **"Restore this version"** — version the **whole rule config**, not just the one tuned knob (a scalar-only rollback is a false safety net).

### 6d. Route risky changes through HITL Approvals

Reuse the existing Approvals/Proposals queue (`threshold_automation` → Proposal). Apply
the same gate to **disable / delete / promote shadow→enabled** when the change would
**reduce coverage**. Show the existing **"Needs approval" vs "Safe to apply"** badge; keep
the server authoritative.

### 6e. Per-rule health + audit

- **"Last response" health chip** (Succeeded / Failed / Warning) + last-run time + duration + **gap/skip indicator** on the rule row and detail (Elastic's Execution-results tab + fleet-wide monitoring dashboard). A rule that suddenly goes silent is a top breakage signal — capture last-run + volume-vs-baseline so silence is **visible**. Cheap given we already audit every action + have durable cursors. Reuse `KpiTile`/`StatCard` + `charts.tsx`.
- **Write every lifecycle event** (enable/disable/edit/rollback/promote) to the **append-only audit index** (#2) so the audit viewer (`GET /api/audit`) reflects them and rollback/attribution is verifiable.
- **Preserve optimistic concurrency** (`KVStore.mutate` `_rev` CAS) on the generalized version store — the nightly tuner + a manual edit + a rollback must not lost-update.

### 6f. Rules management table (the home surface)

Reuse `DataTable`: columns `[enabled toggle · name · type badge · severity/risk chip ·
tags · last-run health · last-run time]`; filters `(type, enabled, tags, MITRE — use
fuzzy/contains, NOT Elastic's exact-case match)`; bulk-actions menu; **persist sort+filter
via `UserPrefsStore`** (saved views exist). Add a **MITRE ATT&CK coverage heatmap**
(extend `MitreHeatmap` + `engine/mitre_coverage.py` + Navigator export): tactics ×
techniques, cell shading by rule density, expandable to enabled/disabled counts, filter,
jump-to-rule. **Nudge MITRE mapping at creation time** and flag unmapped rules (an
unmapped rule looks like a false coverage gap).

---

## 7. Pitfalls to design against (the analyst-facing footguns)

1. **Conflating Suppression / Exceptions / Threshold** — they solve different problems (collapse noise vs. allow-list vs. count-gate). Keep them **distinct sections + labels** (Elastic does).
2. **Suppression can silently hide TPs** if the group-by window is too long — make duration + missing-field behavior **explicit**; never let suppression become a silent drop (#4: severity_floor blocks forward but never drops).
3. **Shared exception lists fan out** — editing one changes every rule that references it. **Show which rules a shared list is attached to** before editing; warn on destructive edits.
4. **MITRE coverage only reflects *mapped* rules** — nudge mapping at creation, flag unmapped in the table.
5. **Preview cost/latency** — bound the window, sample results, RO key only, never `decide()`, never create cases.
6. **Rule actions must never change disposition** — Splunk/Panther happily auto-alert; #3 forbids it. Actions are **proposal/HITL-only** with a "Proposal only" badge; **code-forbid** any auto-close action.
7. **Attacker-influenceable values** — anything from a log that lands in a preview/prompt stays **UNTRUSTED-fenced**; render sample-event previews as plain text/code, never interpolated (#9).
8. **Two-view desync** — one canonical model; generate both the form and any YAML/query view from it; lock guided mode on hand-edit rather than drifting into two sources of truth.
9. **Over-engineering the common case** — most rules are a flat AND-list; don't drop a heavy nested builder everywhere. Reserve RQB for real nesting.
10. **Sigma round-trips are lossy** — import must produce a coverage/validation report and fall back to raw + "partially imported," never silently discard logic.
11. **Monaco / heavy diff libs** — bundle traps for a data-dense console. CodeMirror 6 lazy-loaded (if any); tiny inline diff (not a library).
12. **Severity/risk overrides by default** — clutter that violates sane-defaults (#10). Keep under Advanced.

---

## 8. Import / export (portability)

**Adopt Sigma as the interchange format — on the BACKEND** (`pySigma`, a **server-side
Python dep, not a frontend dep**). This gives instant portability + access to the public
SigmaHQ rule library while keeping us vendor-neutral (matches OCSF/agnostic stance):

- `POST /api/rules/import` — Sigma YAML → `RuleDefinition`, **with a validation/coverage report** for un-mappable constructs (regex modifiers, temporal correlation, complex `condition` grammars). Fall back to raw + "partially imported" status.
- `GET /api/rules/{id}/export?format=sigma` — deterministic, re-importable.
- **Secrets:** export **booleans not values** (#10) — we keep secrets env-only.

Our `RuleMatch` (field/op/value) + `RuleDefinition` already mirror Sigma selections +
Panther match expressions, so import/export is a **mapping layer, not a rewrite.** This
also unlocks a **detection-as-code** story (git-sync + PR review + CI regression tests via
bundled fixtures) as an export/import feature rather than an in-GUI-only capability.

---

## 9. Validation, complex-form UX, and save model

The rules editor is a large nested config object; treat it with the same rigor as the
Settings form.

- **Keep explicit save + a persistent dirty indicator** (the `StickySaveBar` + draft-snapshot + deep-equal minimal-PATCH pattern already in `settings-dirty.ts`). **Do NOT autosave** a rule blob — analysts review multi-field security-control changes before committing; autosave risks silent partial writes. Reserve autosave only for isolated imperative toggles (a standalone kill-switch), and never mix the two in one view.
- **Add the missing nav guard** — a `beforeunload` listener registered **only while dirty** + an in-app route guard that pops the existing `AlertDialog` ("Discard N unsaved changes?"). (The app uses a custom `@/soc/router`, so wire it into `navigate()`.)
- **Introduce a small `zod` schema** (~13 KB, framework-agnostic, MIT) mirroring the `config.py` Pydantic models as the **single source of truth for client-side validation + defaults** (`.default()`), satisfying the CLAUDE.md rule that `types.ts` stays in sync with `models.py`. Run `.safeParse()` on the draft → field→error map; **gate `StickySaveBar.saveDisabled`** on validity. This is standalone — **react-hook-form is not required** (the hand-rolled controlled approach already works; adopt RHF only if array-heavy forms proliferate, e.g. if `SourceEditor.tsx` at 1819 lines multiplies).
- **Accessible inline errors** — validate on blur (not keystroke), render below the field, `aria-invalid` + `aria-describedby`, `role="alert"` per-section summary, actionable copy ("Poll interval must be 5–3600 seconds"). Don't flag empty required fields until a save attempt.
- **Reset-to-default at two levels** — a `RotateCcw` per-`SettingsCard` (revert that section's owned keys via the existing `SECTION_KEYS` map) + the global Discard. Distinguish copy: **Discard** = back to last saved; **Reset to defaults** = back to shipped defaults (derived from the zod `.default()`).
- **Progressive disclosure** — ≤2 disclosure levels; tuck default-OFF nested blocks (caps/tuning/batch/baseline/campaign) behind an "Advanced" card gated by a master toggle so an off feature's fields **never render or validate** (never block Save).
- **Save feedback** — busy state on Save, success toast + re-snapshot the baseline (dirty clears) **only after a 2xx**; on partial/failed PATCH keep the draft + bar + map the 409/validation error back to the offending field. Never optimistically clear dirty.

---

## 10. Implementation plan (concrete, phased)

**Phase 1 — dep-free spine (no new npm deps):**
1. `NumberField` + `LabeledSlider` components (§5). Replace raw `<Input type=number>` blocks in `Tuning.tsx` (~L513–546).
2. Four-section rule editor shell (Radix `Tabs`) with a **flat predicate-row builder** (§4a) + the threshold/suppression sub-cards. Discriminated-union `Define`.
3. Rules management `DataTable` (§6f) + per-row Switch + bulk actions + persisted views.
4. **Preview panel** (§6b) on `GET /api/logs` — histogram (recharts) + count + warnings; RO, no `decide()`, no LLM. Inline fixtures test panel.
5. Generalize `stores/tuning.py` → a per-rule **version ledger**; History drawer + tiny inline diff + rollback (§6c). Wire lifecycle events to the audit index (#2).
6. Shadow state + HITL routing for risky changes (§6a/6d). Health chip (§6e).

**Phase 2 — small justified deps:**
7. `zod` validation schema (§9) — gates Save, single source of defaults.
8. Extend `MitreHeatmap` into the coverage view + creation-time mapping nudge (§6f).

**Phase 3 — gated / optional:**
9. `react-querybuilder` (official shadcn registry) for **nested AND/OR exceptions** (§4b) — behind a flag.
10. `pySigma` backend import/export (§8).
11. (Only if power-users demand it) lazy-loaded CodeMirror 6 raw-YAML escape hatch (§4c).

**Gates before commit (same bar as the rest of webui):** `pytest -q` green,
`npm run build` (tsc+vite) clean, Vitest specs for `NumberField`/`LabeledSlider`/adapter
round-trip green, no new `react-hooks/rules-of-hooks` eslint errors, `case_manager.py`
byte-identical.

---

## 11. Best-source citations (kept)

**Rule-management UX + lifecycle (Elastic — the reference):**
- Rule UI / management: <https://www.elastic.co/guide/en/security/8.19/rules-ui-management.html>
- Rule concepts (7 types, Define/About/Schedule/Actions): <https://www.elastic.co/docs/solutions/security/detect-and-alert/detection-rule-concepts>
- Validate & test rules (preview against a historical window): <https://www.elastic.co/docs/solutions/security/detect-and-alert/validate-and-test-rules>
- Alert suppression: <https://www.elastic.co/guide/en/security/8.19/alert-suppression.html>
- Exceptions + shared lists: <https://www.elastic.co/docs/solutions/security/detect-and-alert/add-manage-exceptions> · <https://www.elastic.co/docs/solutions/security/detect-and-alert/create-manage-shared-exception-lists>
- MITRE coverage heatmap: <https://www.elastic.co/docs/solutions/security/detect-and-alert/mitre-attandckr-coverage>
- Monitor rule executions / monitoring dashboard: <https://www.elastic.co/docs/solutions/security/detect-and-alert/monitor-rule-executions> · <https://www.elastic.co/docs/solutions/security/dashboards/detection-rule-monitoring-dashboard>
- Rules-as-code repo: <https://github.com/elastic/detection-rules>

**Detection-as-code + import/export (Splunk / Panther / Sigma):**
- Splunk ES correlation searches (guided vs manual, throttling, annotations): <https://help.splunk.com/en/splunk-enterprise-security-7/administer/7.3/correlation-searches/configure-correlation-searches-in-splunk-enterprise-security>
- Panther Simple Detections (GUI⇄YAML) + testing: <https://docs.panther.com/detections/rules/writing-simple-detections> · <https://docs.panther.com/detections/testing> · <https://github.com/panther-labs/pypanther>
- Sigma spec + backends: <https://sigmahq.io/docs/basics/rules.html> · <https://github.com/SigmaHQ/sigma-specification> · <https://sigmahq.io/docs/digging-deeper/backends>
- Datadog version history / diff / rollback: <https://docs.datadoghq.com/security/detection_rules/>
- DaC reference (VCS-managed rules): <https://dac-reference.readthedocs.io/en/latest/core_component_managing_detection_rules_in_a_vcs.html>
- Tuning-not-disabling anti-pattern: <https://cardinalops.com/blog/how-to-prevent-and-fix-siem-rule-failures/>

**Condition builder (build vs buy):**
- react-querybuilder docs + shadcn compat: <https://react-querybuilder.js.org/> · <https://react-querybuilder.js.org/docs/compat> · <https://github.com/react-querybuilder/react-querybuilder>
- Export/import (formatters/parsers, tree-shaking): <https://react-querybuilder.js.org/docs/utils/export> · <https://react-querybuilder.js.org/docs/utils/import>
- Zapier Paths (AND/OR grouping, depth cap): <https://zapier.com/blog/zapier-paths-conditional-workflows/>
- Retool tree-data UI patterns: <https://retool.com/blog/designing-a-ui-for-tree-data>
- Monaco vs CodeMirror 6 bundle cost: <https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026>

**Threshold / numeric UX:**
- Baymard sliders: <https://baymard.com/blog/slider-interfaces>
- NN/g input steppers + sliders/knobs: <https://www.nngroup.com/articles/input-steppers/> · <https://www.nngroup.com/articles/sliders-knobs/>
- Carbon NumberInput · Chakra NumberInput: <https://carbondesignsystem.com/components/number-input/usage/> · <https://chakra-ui.com/docs/components/number-input>
- MDN step / number input: <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/step>
- Live preview pattern: <https://ui-patterns.com/patterns/LivePreview>

**Complex-form UX + validation:**
- GitHub Primer "Saving" pattern: <https://primer.style/product/ui-patterns/saving/>
- NN/g progressive disclosure: <https://www.nngroup.com/articles/progressive-disclosure/>
- shadcn Forms (RHF + zod): <https://ui.shadcn.com/docs/forms/react-hook-form> · zod: <https://zod.dev/>
- Accessible validation: <https://webaim.org/techniques/formvalidation/> · <https://www.smashingmagazine.com/2023/02/guide-accessible-form-validation/>
- beforeunload / nav blocking: <https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event> · <https://tanstack.com/router/v1/docs/framework/react/guide/navigation-blocking>
