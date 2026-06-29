# STATUS_TAXONOMY — Recommended Status + Disposition Model

> Replaces the conflated `CaseStatus` (OPEN | NEEDS_HUMAN | CLOSED) with a
> two-axis model (lifecycle STATUS + investigative DISPOSITION), aligned to
> Sentinel / Chronicle / Splunk / NIST, while keeping non-negotiable #3 intact and
> remaining fully back-compatible with stored cases.

---

## 1. The problem with today's model

`CaseStatus = {OPEN, NEEDS_HUMAN, CLOSED}` conflates two orthogonal axes:

1. **Lifecycle** — where the case is in the response workflow (new, being worked,
   escalated, on hold, resolved, closed).
2. **Verdict outcome** — what the investigation concluded (true positive, false
   positive, benign, duplicate).

`NEEDS_HUMAN` is really *"lifecycle = needs an analyst"* — i.e. an assignment/
escalation state, not a terminal disposition. Every reference platform separates
these. Conflation blocks SLA reporting (can't measure "time in escalated"),
filtering ("show me all true positives regardless of status"), and analytics
("FP rate among closed cases").

We ALSO must not break:
- non-negotiable #3 — `decide()` is a pure function; status is set by code.
- stored cases with the old enum values.
- the existing webui `StatusBadge` (it already degrades unknown values to a neutral
  badge, so new values are visually safe).

---

## 2. Recommended two-axis model

### 2a. STATUS (lifecycle) — `CaseStatus` enum

| value | meaning | who sets it |
|---|---|---|
| `NEW` | created, not yet investigated (candidate / pre-LLM) | code (ingest/register_candidate) |
| `OPEN` | investigated, awaiting analyst (replaces today's analyst-attention default) | code (`decide()`) |
| `INVESTIGATING` | an analyst (or re-investigation) is actively working it | analyst action / reinvestigate |
| `ESCALATED` | flagged high-priority for senior/Tier-3 (the `escalate` signal) | code (`decide()` escalate) / analyst |
| `ON_HOLD` | paused (awaiting info, maintenance window, third party) | analyst action |
| `RESOLVED` | worked to completion, pending final close/audit | analyst / code |
| `CLOSED` | terminal; auto-close or analyst close (objection window applies) | code (`decide()`) / analyst |

Back-compat mapping of the old enum:
- `open` → `OPEN`
- `needs_human` → `OPEN` (lifecycle "awaiting analyst"); the *reason* it needs a
  human is captured by `decision_by=SYSTEM` + `disposition=UNDETERMINED` +
  `escalate` (already on the decision). We retain `NEEDS_HUMAN` as an **alias** so
  old docs and `decide()` keep working; see §4.
- `closed` → `CLOSED`

> Compatibility note: the **single** code path that produces a non-closed,
> needs-attention case is `decide()` returning `CaseStatus.NEEDS_HUMAN`. To avoid a
> risky rewrite of `decide()` and `apply()`'s invariant assertion, we keep
> `NEEDS_HUMAN` as a *retained, deprecated alias* of `OPEN` in the enum and have the
> UI render it as "Open · awaiting analyst". The richer ESCALATED/ON_HOLD/RESOLVED
> states are added on top and reached via analyst lifecycle actions + the
> `escalate` flag, NOT by rewriting the deterministic decision. This is the safest
> migration: zero change to the #3-critical `decide()` truth-table semantics.

### 2b. DISPOSITION (verdict outcome) — new `Disposition` enum

| value | meaning |
|---|---|
| `TRUE_POSITIVE` | confirmed malicious / real incident |
| `FALSE_POSITIVE_LOGIC` | FP — detection-rule logic was wrong |
| `FALSE_POSITIVE_DATA` | FP — data/enrichment was wrong |
| `BENIGN_POSITIVE` | real activity, expected/authorized (benign true positive) |
| `DUPLICATE` | same incident as another case |
| `UNDETERMINED` | insufficient data / needs human (default for un-dispositioned) |

`Disposition` is derived from / set alongside `Verdict` (the LLM recommendation)
but is the **analyst-confirmable, reportable** outcome. The LLM `Verdict` stays
exactly as-is (FALSE_POSITIVE/TRUE_POSITIVE/NEEDS_HUMAN) — it feeds `decide()`. The
`Disposition` is the human-facing classification on/after close.

Mapping LLM Verdict → default Disposition:
- TRUE_POSITIVE → TRUE_POSITIVE
- FALSE_POSITIVE → FALSE_POSITIVE_LOGIC (default; analyst can refine to DATA/BENIGN)
- NEEDS_HUMAN / None → UNDETERMINED

### 2c. Escalation/assignment stay SEPARATE (already partly present)
`Case.assignee` exists. Add `escalation_level: int = 0` and `status_reason: str`
(free text: why on hold / how resolved). `decide()` already computes an `escalate`
bool — surface it as `ESCALATED` status (lifecycle) without touching the close
truth table.

---

## 3. Comparison table vs. the field

| Concept | **This design** | Microsoft Sentinel | Google Chronicle / SecOps | Splunk (MC / SOAR) | NIST / SANS |
|---|---|---|---|---|---|
| Status axis | NEW, OPEN, INVESTIGATING, ESCALATED, ON_HOLD, RESOLVED, CLOSED | New, Active, Closed | (workflow) + status field | New, Pending/Open, Closed | CSF 2.0 functions (Detect/Respond/Recover) / PICERL phases |
| Disposition axis | TRUE_POSITIVE, FALSE_POSITIVE_LOGIC, FALSE_POSITIVE_DATA, BENIGN_POSITIVE, DUPLICATE, UNDETERMINED | TP, Benign Positive, FP-Incorrect Logic, FP-Incorrect Data, Undetermined | similar verdict set | TP, Benign Positive, FP-Incorrect Logic, FP-Inaccurate Data, Undetermined | (n/a — framework, not enum) |
| Status⊥Disposition? | **yes (two fields)** | yes (Status + Classification) | yes | yes | conceptually yes |
| Escalation as status? | **no — `escalate` flag + ESCALATED + escalation_level** | no (separate routing) | no | no | no |
| "Needs human"? | `OPEN` + `decision_by=SYSTEM` + `UNDETERMINED` | not a status | not a status | not a status | not a status |
| Backward transitions | RESOLVED/CLOSED reopen via analyst action (audited) | reopen via Active | configurable | configurable | n/a |
| Mandatory disposition on close | recommended (default UNDETERMINED) | yes | yes | yes (disposition) | n/a |
| Decision authority | **deterministic code (#3)** | analyst | analyst | analyst | analyst |

Where we are stricter than the field: the close/escalate transition is **code**
(`decide()`), not analyst free-will. Sentinel/Splunk let the analyst pick the close
status freely; we make auto-close a policy and analyst-close a deterministic action.
The disposition is the part the analyst classifies.

---

## 4. Migration & back-compat plan (zero-downtime, no data rewrite)

The whole point: **add fields, never break stored cases, never touch `decide()`'s
truth table.**

### Step 1 — Extend `CaseStatus` (constants.py) additively
Keep the three existing string values bit-for-bit (`open`, `needs_human`, `closed`)
and ADD the new ones (`new`, `investigating`, `escalated`, `on_hold`, `resolved`).
Stored cases with `needs_human`/`open`/`closed` validate unchanged. `decide()`
continues to return `NEEDS_HUMAN`/`CLOSED` exactly as today — **no semantic change
to #3.** The UI treats `needs_human` as "Open · awaiting analyst".

### Step 2 — Add `Disposition` enum + `Case.disposition` + `Case.status_reason` + `Case.escalation_level`
All optional with defaults (`disposition=None`, `status_reason=""`,
`escalation_level=0`). Pydantic fills defaults for stored docs missing them (the
ConfigStore/CaseStore load is schema-tolerant). No migration script.

### Step 3 — Populate `disposition` at decision time (additive, in `apply()`)
In `CaseManager.apply()`, after `decide()`, set `case.disposition` from the LLM
`verdict` using the Verdict→Disposition map IF `case.disposition` is unset.
`decide()` itself is untouched (still pure over verdict/confidence/risk/policy).
The `escalate` bool already in `Decision` is mapped: if `escalate and status ==
NEEDS_HUMAN`, the UI shows it as ESCALATED (we may also set
`case.status = CaseStatus.ESCALATED` here — but ONLY in the non-close branch, never
the close branch, preserving the invariant assertion). Add a back-compat shim:
`escalate` true → `status = ESCALATED` is still "not closed", so the
`apply()` assertion (NEEDS_HUMAN/None never CLOSED) is unaffected.

### Step 4 — Analyst lifecycle actions (routes)
Extend `POST /api/cases/{id}/action`'s `action` field with `hold`, `resume`,
`resolve`, `set_disposition` (in addition to existing `close`, `reopen`,
`escalate`, `confirm_fp`, `acknowledge`). Each appends to `history` + audits a
`DECISION` (with `status_changed_from`/`to`/`status_reason`) — never touches
`decide()`. A `@model_validator` style guard rejects illegal transitions (e.g.
CLOSED→INVESTIGATING without going through reopen) the way TheHive forbids backward
moves without admin.

### Step 5 — UI
`StatusBadge` (already permissive) gets explicit color tokens for the new statuses;
add a `DispositionBadge`. Cases list + Metrics gain status AND disposition facets.
The `needs_human` legacy value renders as "Open" with an "awaiting analyst" sub-pill.

### Step 6 — Reporting
`engine/metrics.compute_metrics` adds `by_disposition` and `by_status` (it already
has `by_status`/`by_verdict`). FP-rate, MTTR-per-disposition, and
status-transition counts become available with no schema change to old cases.

### Rollback
Because every change is additive and `decide()`/`apply()` semantics are unchanged,
rollback = stop reading the new fields. Stored cases keep working on the old code.

---

## 5. Recommended enums (copy targets for constants.py)

```python
class CaseStatus(str, Enum):
    NEW = "new"
    OPEN = "open"                 # retained
    NEEDS_HUMAN = "needs_human"   # retained alias of "awaiting analyst" (decide() still uses it)
    INVESTIGATING = "investigating"
    ESCALATED = "escalated"
    ON_HOLD = "on_hold"
    RESOLVED = "resolved"
    CLOSED = "closed"             # retained

class Disposition(str, Enum):
    TRUE_POSITIVE = "true_positive"
    FALSE_POSITIVE_LOGIC = "false_positive_logic"
    FALSE_POSITIVE_DATA = "false_positive_data"
    BENIGN_POSITIVE = "benign_positive"
    DUPLICATE = "duplicate"
    UNDETERMINED = "undetermined"
```

`Verdict` is unchanged. `decide()` is unchanged. The new axis sits beside them.
