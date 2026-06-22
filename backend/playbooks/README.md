# TLSOC Markdown Playbooks

A **playbook** is an operator-authored Markdown file that tells the agent *how to
think about a particular kind of cluster*: which tools to suggest, which RAG
queries to pull context with, and what verdict bias / escalation hint to keep in
mind. It is the deterministic sibling of the plain-text **runbooks** — where a
runbook is selected by a fuzzy keyword/rule score, a playbook is selected by an
**explicit, auditable match contract**.

> **Playbooks can only RECOMMEND.** A playbook never closes, escalates, or sets a
> verdict on its own. Deterministic code (`engine/case_manager.py`) and operator
> settings make every close/escalate decision — a `TRUE_POSITIVE` is never
> auto-closed (non-negotiable #3). `escalate_if` and `suggested_verdict_bias` are
> *hints for the investigator*, not actions.

Each file has two parts: a **front-matter manifest** (between the `---` fences) and
a free-text **Markdown body** (your operator procedure). The body is injected as
TRUSTED guidance into the investigator when the playbook is selected.

## Full example

```markdown
---
id: mail_credential_bruteforce
name: Mail credential brute force
version: 2
description: A burst of failed mail / webmail authentications from one source.
priority: 50
match:
  rule_ids: [mail_auth, roundcube_login, postfix, web_auth, waf_auth, suricata_mail]
  entity_types: [ip, user]
  min_event_count: 5
  mitre: [T1110]
  any_tags: [credential-access]
suggested_tools: [es_query, enrich]
rag_queries:
  - mail authentication brute force playbook
  - roundcube failed login burst
escalate_if: any single attempt SUCCEEDED after the failure burst
suggested_verdict_bias: lean TRUE_POSITIVE if a success follows the burst
---

## Procedure

1. Confirm the volume and the time window of the failed authentications.
2. Check whether ANY attempt **succeeded** from the same source/user — a success
   after a failure burst is the escalation trigger.
3. Enrich the source IP reputation; correlate with `postfix` / `suricata_mail`.
4. If only failures and the source is low-reputation noise, lean toward a benign
   verdict; otherwise surface for human review.
```

## Front-matter fields

### Top level (`PlaybookManifest`)

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `id` | string (slug) | **required** | Unique id. Must match `^[a-z0-9][a-z0-9_-]{0,63}$`. A bad/missing id skips the file. |
| `name` | string | falls back to `id` | Human-readable name. |
| `version` | int ≥ 1 | `1` | Bump when you change a playbook; higher version wins ties. |
| `description` | string | `""` | One-line summary for the catalog UI. |
| `match` | object | empty | The match contract (see below). |
| `priority` | int | `0` | Higher priority wins when multiple playbooks match. |
| `suggested_tools` | list | `[]` | Tool names the investigator should consider (e.g. `es_query`, `enrich`). |
| `rag_queries` | list | `[]` | Queries to pull supporting context from the RAG corpus. |
| `escalate_if` | string | `""` | A human-readable escalation hint. Advisory only. |
| `suggested_verdict_bias` | string | `""` | A verdict nudge for the investigator. Advisory only. |

Unknown front-matter keys are **ignored** (logged as a warning) — a typo or a newer
schema field never makes a playbook fatal to load.

### `match` (`PlaybookMatch`) — the selection contract

Every criterion is **any-of** and **optional**. A playbook matches a cluster iff
**ALL of its PRESENT (non-empty) criteria are satisfied**; an empty / omitted
criterion does **not** constrain.

| Field | Type | Matches when |
|-------|------|--------------|
| `rule_ids` | list of rule ids | the cluster's rule set (`rule_values` ∪ `primary_rule()`) intersects this list. |
| `entity_types` | list of `ip` / `user` / `host` | the cluster entity type is in this list. |
| `min_event_count` | int | `cluster.count >= min_event_count`. |
| `mitre` | list of techniques | matches **opportunistically** against the cluster's rule names (see note). |
| `any_tags` | list of tags | matches **opportunistically** against the cluster's rule names (see note). |

> **Note on `mitre` / `any_tags`.** Clusters carry no MITRE techniques or tags
> *before* investigation, so these two criteria currently match opportunistically
> against the cluster's (lowercased) rule names — e.g. a rule literally named like a
> technique/tag will satisfy them. Treat them as additive hints; rely on
> `rule_ids` / `entity_types` / `min_event_count` for precise targeting.

## Selection order

Among all matching playbooks the engine picks **one**, deterministically:

1. highest `priority`
2. then highest `version`
3. then lexicographically smallest `id`

When nothing matches, selection returns `(None, "no_playbook_matched")`.

## Real rule ids in this repo's catalog

Use these when authoring `match.rule_ids`:

`mail_auth`, `waf_auth`, `web_auth`, `roundcube_login`, `postfix`,
`modsec_sqli`, `modsec_xss`, `suricata_mail`, `openvas_report`.

## Loading & reload

Playbooks live in this directory as `*.md` files. They are loaded in sorted order;
an invalid file is **skipped** (logged) and never breaks the rest. The registry
reloads **atomically** (validate-then-swap) so a broken edit can never replace a
known-good live set.

> **Selection note — `mitre` / `any_tags` are advisory, not hard filters.** A
> cluster carries no MITRE techniques or tags at *selection* time (those come from
> the verdict, after investigation), so requiring them would make every
> technique-tagged playbook unmatchable. The hard match criteria are therefore
> `rule_ids`, `entity_types`, and `min_event_count`; `mitre`/`any_tags` only
> *boost* the match reason when a rule name happens to carry the signal. They never
> exclude an otherwise-matching playbook.
