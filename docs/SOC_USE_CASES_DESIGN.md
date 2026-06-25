# SOC Use Cases — Detection Rules & Response Plan

> **Status:** proposal / design (not yet implemented). Companion to
> [`VIGIL_STUDY.md`](VIGIL_STUDY.md) and [`../ROADMAP.md`](../ROADMAP.md).
> **Scope:** how this suite covers the modern AI-SOC use cases — *which rules the
> agent uses to find threats, and how it safely takes action* — grounded in the
> primitives that already exist and honest about the gaps.

---

## 0. The principle (read this first)

This suite **does not** catch threats with hardcoded `if X then alert` signatures,
and it **does not** let the LLM act on its own. Two invariants shape every design
choice below:

1. **Rules are configuration, not code.** The agent is *guided* by editable
   primitives (detection rules, correlation, risk weights, playbooks, personas,
   memory, RAG, policies). Operators tune these; no redeploy needed.
2. **The LLM recommends; deterministic code decides (non-negotiable #3).** This
   already governs close/escalate (`engine/case_manager.decide`). We extend the
   *same* pattern to response actions — the LLM may *propose* an action, but a
   pure policy function (+ optionally a human) decides whether it runs.

So "design rules the AI uses to find threats and take action" = two layers:

| Layer | Purpose | Status |
|---|---|---|
| **L1 — Finding rules** | What becomes a case, how it's prioritized & investigated | Mostly **exists** |
| **L2 — Response rules** | How a recommended action is approved & executed | **Net-new** (agent is read-only today) |

---

## 1. Layer 1 — the finding rules (control plane that exists)

| Primitive | File | Controls |
|---|---|---|
| `RuleDefinition` + `RuleMatch` (`equals/prefix/tag/exists`) | `backend/app/config.py:253` | Classifies a raw log into a *named* detection rule |
| `CorrelationRule` (`every`/`threshold(n,window)`/`never`, `group_by`) | `backend/app/config.py:205` | What activity becomes a case + how events cluster |
| `RiskWeights` + `asset_networks` / `asset_criticality` | `backend/app/config.py:274`, `engine/risk.py:30` | Prioritization (crown-jewel boost) |
| Personas | `backend/app/agents/personas.py` | Routes cluster to a specialist investigator |
| Playbooks (Markdown, deterministic select) | `backend/app/playbooks/` | Investigation procedure — RECOMMEND only |
| Memory (durable trusted facts) | `backend/app/stores/memory.py` | Operator "baselines-as-facts" |
| RAG (`runbook`/`mitre`/`suppression`/`resolved_case`) | `backend/app/tools/rag.py` | Institutional knowledge + prior decisions |
| `AutoClosePolicy` | `backend/app/config.py:322` | Deterministic close/escalate |

The seeded catalog today is 13 `event.module` rules + 5 ModSec OWASP-CRS
sub-rules (`config.py:753`). Everything below is *additive* to that.

---

## 2. Layer 2 — the response/action framework (new design)

Today every tool is `ToolTier.SAFE` and read-only (`tools/base.py`). The tier
enum already has `safe / managed / requires_approval / forbidden` — the seam is
ready. The flow we add:

```
investigator PROPOSES action     ActionPolicy.decide()            outcome
(LLM, never executes)      →      (pure fn, mirrors      →   ├─ AUTO    → execute (reversible only)
                                   case_manager.decide)       ├─ APPROVE → HITL queue (audited)
                                                              └─ DENY    → blocked (audited)
                                         ↓ on AUTO / human-approved
                               ResponseConnector.execute()  →  ActionType.RESPONSE audit (append-only)
```

New pieces:

1. **Response tools** (tiered, proposed never auto-called): `block_ip`,
   `isolate_host`, `disable_user`, `reset_credential`, `add_suppression`. Each
   carries `tier: ToolTier` and `reversible: bool`.
2. **`ResponseConnector` SPI** — mirrors the log-source `Connector` pattern under
   `connectors/response/`: EDR (isolate host), firewall/WAF (block IP), IdP
   (disable user / reset cred). Manifest-driven, wired from the wizard.
3. **`ActionPolicy.decide(action, verdict, confidence, risk, policy)`** — pure
   function beside `case_manager.decide`. Per-action-type gates. **Code-enforced
   invariants (not tunable): NEEDS_HUMAN never auto-acts; irreversible actions
   never auto-act.**
4. **HITL approval queue** — proposed actions attach to the case; a human
   approves in the UI; only then the executor runs. New `ActionType.RESPONSE` +
   `ActionType.APPROVAL` audit records.

This is the "approval workflow (HITL action gating)" already listed as a Wave-2
leftover in `CLAUDE.md`.

---

## 3. Use-case coverage matrix

| Use case | Covered by L1 today | Gap to build |
|---|---|---|
| **SIEM Alert Triage** | ✅ correlation → risk → narrative → AutoClose | — |
| **MITRE ATT&CK Mapping** | ✅ investigator emits `mitre[]` | Real STIX-backed MITRE module (precision) |
| **Incident Response** | ⚠️ verdict + recommended_action only | **L2** (response connectors + ActionPolicy + HITL) |
| **Threat Hunting** | ⚠️ manual investigate + es_query | Scheduled hypothesis hunts + **baselines** |
| **Insider Threat** | ❌ only velocity/volume + memory | **UEBA baseline engine** (per-user/peer/temporal) |
| **Phishing / BEC** | ❌ no email source, no linguistics | Email connector + behavioral/linguistic features |
| **Threat Exploration** (hash/firmware) | ❌ | File-hash baseline store + enrichment expansion |

**The recurring missing ingredient** for the bottom four is a **behavioral
baseline / profiling engine** (per-user, peer-group, temporal "normal"). The
suite has zero UEBA today; risk is a fixed weighted formula. This is the single
largest net-new build.

---

## 4. Concrete starter RULES (drop-in, additive to the seed catalog)

These are real, copy-edit-ready entries an operator would add. They use only
existing schema (`RuleDefinition`, `CorrelationRule`, `RuleMatch`).

### 4.1 Detection rules (`rule_catalog`)

```jsonc
// Brute-force / credential stuffing — group by user, escalate fast
{ "name": "auth_bruteforce", "priority": 40,
  "match": { "field": "event.outcome", "op": "equals", "value": "failure" },
  "correlation": { "mode": "threshold", "n": 8, "window_seconds": 300, "group_by": "user" } }

// Impossible-travel candidate — every successful auth, grouped by user (baseline
// engine in §5 turns this into a real geo/velocity check)
{ "name": "auth_success_track", "priority": 90,
  "match": { "field": "event.action", "op": "equals", "value": "user_login" },
  "correlation": { "mode": "every", "group_by": "user" } }

// Off-hours data movement — insider-threat signal (needs baseline for "off-hours")
{ "name": "bulk_egress", "priority": 60,
  "match": { "field": "event.category", "op": "tag", "value": "network" },
  "correlation": { "mode": "threshold", "n": 1, "window_seconds": 60, "group_by": "user" } }

// Scanner / recon — many distinct rules from one IP (diversity drives risk)
{ "name": "recon_scan", "priority": 50,
  "match": { "field": "rule.id.keyword", "op": "prefix", "value": "913" },
  "correlation": { "mode": "threshold", "n": 20, "window_seconds": 120, "group_by": "ip" } }
```

### 4.2 Risk tuning (`asset_networks` / weights)

```jsonc
"asset_networks": [
  { "cidr": "10.10.0.0/16", "criticality": 90 },   // prod / crown jewels
  { "cidr": "10.20.0.0/16", "criticality": 40 }     // corp workstations
],
"risk_weights": { "volume": 0.2, "velocity": 0.25, "reputation": 0.25,
                  "diversity": 0.2, "asset_criticality": 0.1 }
```

### 4.3 Memory facts (baselines-as-facts, until the UEBA engine lands)

```
- [network] 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 are internal ranges
- [scanner] 10.30.0.5 is the authorized Nessus scanner — recon from it is benign
- [asset] hostnames matching ^pay- are PCI-scoped; treat findings as high severity
```

### 4.4 Response policy (L2, proposed schema)

```jsonc
"action_policy": {
  "add_suppression": { "auto": true,  "min_confidence": 0.9, "max_risk_score": 25 },
  "block_ip":        { "auto": true,  "reversible_ttl_minutes": 60,
                       "min_confidence": 0.9, "min_risk_score": 70 },
  "isolate_host":    { "auto": false },   // always HITL
  "disable_user":    { "auto": false },   // always HITL
  "reset_credential":{ "auto": false }    // always HITL
}
// Code-enforced regardless of the above: NEEDS_HUMAN ⇒ never auto; irreversible ⇒ never auto.
```

---

## 5. Baseline / UEBA engine (sketch — the big gap)

Unlocks insider threat, threat hunting, threat exploration.

- **`engine/baseline.py`** — rolling per-entity profiles persisted in the state
  store (no new infra): per `user`/`host`/`ip` track active-hour histogram,
  typical source ASNs/geos, typical data-volume percentiles, typical rule mix.
- **Peer groups** — operator-defined cohorts (e.g. by department tag); compare an
  entity to its cohort's distribution.
- **Deviation as a risk factor** — add a `behavioral` term to `RiskWeights` so a
  sharp deviation (off-hours + abnormal volume + new geo) raises risk
  deterministically; the investigator then explains it. *No ML retraining — a
  transparent statistical baseline, fully auditable.*
- **Feeds the existing pipeline** — baseline output is just another deterministic
  input to `compute_risk`, so the spine is untouched.

---

## 6. Phased plan

| Phase | Deliverable | Rides existing seam | Tests |
|---|---|---|---|
| **P1** | L2 response framework: `ResponseConnector` SPI, response tools (tiered), `ActionPolicy.decide`, HITL queue + audit, webui approvals panel | `ToolTier`, `case_manager.decide` pattern, connector registry, audit log | offline policy unit tests + route-coverage |
| **P2** | Starter rule pack from §4 seeded into `default_rule_catalog` (+ 2 playbooks, 1 persona) | `rule_catalog`, playbook registry | catalog seed-version test |
| **P3** | Baseline/UEBA engine (§5) + `behavioral` risk term | `compute_risk`, state store | baseline math unit tests |
| **P4** | Email source connector + phishing features | connector SPI + OCSF | connector parse tests |
| **P5** | STIX-backed MITRE module | RAG corpus | mapping tests |

Each phase ends with: `pytest -q` green, `webui` build clean, docs + Journal
updated, commit + push.

---

## 7. Non-negotiables this plan preserves

- #1 read-only log access stays read-only; response actions use **separate**
  response connectors with their own scoped creds.
- #2 every proposed/decided/executed action is audited, append-only.
- #3 deterministic code (and HITL) decides outcomes & actions — never raw LLM.
- #9 all log-/tool-derived values remain fenced UNTRUSTED in prompts.
