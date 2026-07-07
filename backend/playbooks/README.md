# TLSOC Markdown Playbooks

A **playbook** is an operator-authored Markdown file that tells the agent *how to
think about a particular kind of cluster*: which tools to suggest, which RAG
queries to pull context with, and what verdict bias / escalation hint to keep in
mind. It is the deterministic sibling of the plain-text **runbooks** — where a
runbook is selected by a fuzzy keyword/rule score, a playbook is selected by an
**explicit, auditable match contract**.

> **Playbooks can only RECOMMEND.** A playbook never closes, escalates, or sets a
> verdict on its own — only deterministic code (`engine/case_manager.py`'s
> `decide()`) against the operator-configured `AutoClosePolicy` can do that
> (non-negotiable #3). FALSE_POSITIVE auto-close is on by default above a
> confidence/risk bar; TRUE_POSITIVE auto-close is a real, opt-in (off by default)
> policy knob; only NEEDS_HUMAN never auto-closes. A playbook's `escalate_if` and
> `suggested_verdict_bias` are *hints for the investigator*, not actions, and can
> never override that policy.

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

Use these when authoring `match.rule_ids`. This is the full, live set generated
from the default rule catalog (`backend/app/config.py`,
`_REAL_EVENT_MODULES` + `_MODSEC_SUBRULES`) — 13 `event.module` rules plus 5
ModSecurity sub-rules, 18 real ids total:

**`event.module` rules** (priority 100):
`mail_apache_access`, `mail_auth`, `mail_fim`, `ml_stats`, `modsec_audit_log`,
`openvas_report`, `postfix`, `roundcube_login`, `suricata_mail`,
`waf-nginx-access`, `waf_auth`, `web_apache_access`, `web_auth`.

**ModSecurity OWASP CRS sub-rules** (`rule.id` prefix match, priority 50 — these
classify before the generic `modsec_audit_log` rule above):
`modsec_xss` (941xxx), `modsec_sqli` (942xxx), `modsec_lfi` (930xxx),
`modsec_rce` (932xxx), `modsec_scanner` (913xxx).

Operators can edit, disable, or extend this catalog freely — nothing here is
hardcoded beyond seeding these real detections.

## Shipped playbooks in this directory

| File / `id` | Name | Priority | Scope (`rule_ids` / `entity_types`) |
|---|---|---|---|
| `brute_force_login.md` | Brute-force / password-spray login | 50 | `mail_auth, waf_auth, web_auth, roundcube_login, postfix` / `ip, user, host` |
| `phishing_reported_email.md` | Reported phishing email | 45 | `postfix, roundcube_login, mail_auth, mail_apache_access, suricata_mail` / `user, ip` |
| `suspicious_outbound_connection.md` | Suspicious outbound / beacon-like connection | 40 | `suricata_mail, ml_stats` / `ip, host` |

Each also carries `mitre` (T1110/T1078, T1566, T1071 respectively) and
`any_tags` hints — see each file's front matter for the full match contract and
its Markdown body for the phased investigation procedure.

## API + configuration

- `GET /api/playbooks` — list the loaded catalog (id/name/version/priority/
  description/match summary).
- `POST /api/playbooks/reload` — atomically re-read this directory and hot-swap
  the live registry (validate-then-swap; a broken file never replaces a
  known-good set).
- `GET /api/playbooks/selection/{case_id}` — show which playbook (if any) was
  selected for a given case and why.
- **`Preferences.playbooks.dir`** overrides the default location (this
  directory, `backend/playbooks/`) if you want to point at an operator-owned
  playbook directory instead. `Preferences.playbooks.enabled` (default `true`)
  turns the whole system off if you never want playbook injection.

## Loading order

Playbooks live in this directory (or the `Preferences.playbooks.dir` override) as
`*.md` files, loaded in sorted order at boot and on every
`POST /api/playbooks/reload`. An invalid file is **skipped** (logged) and never
breaks the rest.

> **Selection note — `mitre` / `any_tags` are advisory, not hard filters.** A
> cluster carries no MITRE techniques or tags at *selection* time (those come from
> the verdict, after investigation), so requiring them would make every
> technique-tagged playbook unmatchable. The hard match criteria are therefore
> `rule_ids`, `entity_types`, and `min_event_count`; `mitre`/`any_tags` only
> *boost* the match reason when a rule name happens to carry the signal. They never
> exclude an otherwise-matching playbook.
