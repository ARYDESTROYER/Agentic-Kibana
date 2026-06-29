# Round 2 — Best-of-the-Best Gap List (vs top SOC products)

Prioritized gaps vs Sentinel, Google SecOps/Chronicle, Splunk ES 8.5, Stellar Cyber
6.5/6.6, Panther, Hunters, TheHive 5. Every item is additive, stays behind the existing
auth/audit/AutoClosePolicy spine, NEVER touches `case_manager.decide()`, keeps
attacker-influenceable text fenced/plain (#9), and adds ZERO runtime deps unless
explicitly flagged. Value/Effort on a 1-5 scale (5 = highest value / largest effort).

---

## Sequencing note (build the primitives first)
Ship the **SavedView** model + a generic **bulk-action** endpoint FIRST — saved views,
SLA at-risk filters, watchlist filters, and case-queue tiers all compose on top of them.
Then the **UserPrefsStore** cascade (W7) carries personal views/columns/dashboards.

---

## TIER 1 — Ship now (highest value/effort ratio)

| # | Feature | Value | Effort | Why now |
|---|---------|-------|--------|---------|
| 1 | **Saved views/filters on Cases** (named filter+sort+columns, personal vs org, pin-as-default, system presets: My open / Unassigned / NEEDS_HUMAN / SLA at-risk) | 5 | 2 | The single most-cited table-stakes gap (Stellar case queues, Linear/Asana). Composes everything else. |
| 2 | **Bulk case actions** (multi-select → close/assign/tag/comment/status/reinvestigate; per-case audit; closes still run real `decide()`) | 4 | 2 | Baseline across all leaders; `POST /api/cases/bulk` returns per-id `{ok,error}`. |
| 3 | **Command palette (Cmd-K)** — fuzzy jump to pages/cases-by-id/sources + run actions; context-aware | 4 | 2 | Expected analyst-productivity pattern; lets the rail stay at ~5 groups (cmdk dep — vet). |
| 4 | **Global search** across cases/sources/knowledge/memory (`GET /api/search`) wired into Cmd-K + top bar | 4 | 2 | Reuses RAG retrieval for knowledge/memory; cap 50. |
| 5 | **API keys/tokens management UI** (scoped, revocable, prefix + last-used) on the existing JWT/PBKDF2 auth | 4 | 2 | Buyers check for it; vendor-agnostic open-API requirement. |
| 6 | **Audit-log viewer page** (`GET /api/audit` keyset + facets + export) reading `tlsoc-agent-audit-*` | 5 | 3 | Compliance/forensics table-stakes; the append-only index already exists (#2). Global (admin) + per-user "My activity" from ONE component. |

---

## TIER 2 — High value, moderate effort

| # | Feature | Value | Effort | Notes |
|---|---------|-------|--------|-------|
| 7 | **Case linking + merge** (`linked_case_ids`; merge unions evidence/tags/comments/audit into a survivor; HITL only, audited) | 4 | 3 | Splunk finding-groups + TheHive merge; we already have cluster signatures. |
| 8 | **SLA timers** (per-severity clock, `sla_due_at`/`sla_state`, at-risk filter + badge; display+filter only, no enforcement) | 4 | 2 | Pairs with saved views (#1). |
| 9 | **Case & task templates / checklists** (per verdict/persona/source; tasks recorded on case; RECOMMENDATIONS only — never alter `decide()`) | 4 | 3 | Sentinel incident-tasks + TheHive templates. |
| 10 | **Watchlists** (VIP users / crown-jewel assets / known-good IPs; context boosters in correlation/risk + triage chip) | 4 | 3 | Extends HITL suppression/asset proposals; entries TRUSTED operator data, matched log values stay UNTRUSTED. |

---

## TIER 3 — Differentiating, larger effort

| # | Feature | Value | Effort | Notes |
|---|---------|-------|--------|-------|
| 11 | **Dashboards builder** (user-composed shareable widget grid over `/api/metrics` + cost ledger; one global time + filter) | 4 | 4 | react-grid-layout — vet the dep. Org publishes a default; users clone-and-personalize (UserPrefsStore, W7). |
| 12 | **Scheduled reports** (cron PDF/MD digests via the standup aggregator → existing notifications) | 3 | 3 | Reuses aggregate-then-summarise (#7 non-negotiable). |
| 13 | **Hunting / saved-query builder** (named reusable read-only queries over sources; Stellar Query Library parity) | 4 | 4 | Builds on the `es_query` tool + per-source browse. |
| 14 | **Data retention/lifecycle policy surface** (per-state-index TTL + archive tier, operator-editable, sweep job; audit retention ≥ compliance floor) | 3 | 3 | Compliance gap for regulated buyers (PCI 12mo / SOC2 ~1yr). |

---

## TIER 4 — Strategic packaging (later)

| # | Feature | Value | Effort | Notes |
|---|---------|-------|--------|-------|
| 15 | **Integrations marketplace/catalog** (render the connector registry + entry points as an in-app gallery with status/test-connection) | 4 | 3 | Packaging play over existing SPI (16 receivers + pull connectors). |
| 16 | **Auto-documenting "case wall"** (elevate audit/comment stream into a Chronicle-style immutable human+agent unified timeline per case) | 3 | 3 | Reuses the audit viewer component scoped per-case. |
| 17 | **Keyboard shortcuts beyond Cmd-K** (j/k row nav, e=assign, c=close, / =search, ? =cheatsheet) | 2 | 2 | Polish; cheap on the React/shadcn stack. |

---

## Cross-cutting customization (covered in W4 IA + W7)
- **Two-scope settings:** org Preferences (admin) vs per-user `UserPrefsStore` (KV), with
  a `GET /api/prefs/effective` cascade `user ?? org ?? system`.
- **Terminology overrides** (org label map: case/incident, analyst/responder) via a
  `t(key)` helper — admin-owned.
- **Theming/branding tokens** (CSS custom properties) org-level; users only pick
  light/dark/system. `branding.accent_color2` (already plumbed, unused) wired in W2.
- **Avatars** as bounded `data:image/(png|webp|jpeg)` data-urls (64KB cap, SVG rejected,
  magic-byte sniff) — reuses the BrandingConfig logo pattern; browser resizes to 256×256
  WebP before upload; shadcn Avatar + deterministic initials fallback (no network /
  air-gapped); Gravatar opt-in only (SHA-256, default OFF for a SOC tool).

---

## Concrete data contracts (additive; all behind auth/audit, no `decide()` change)
- `SavedView{id,name,scope:'personal'|'org',owner_id,target,filters,sort,columns,is_default}`
- `POST /api/cases/bulk {ids[],action,payload}` → per-id `{ok,error}`
- `ApiKey{id,name,prefix,hash(PBKDF2),scopes[],last_used_at,expires_at,revoked}` (plaintext
  returned ONCE)
- `Case.linked_case_ids[]`; `POST /api/cases/merge {survivor_id,merged_ids[]}` (idempotent)
- `Preferences.sla_policy{by_severity,business_hours}`; per-case `sla_due_at`/`sla_state`
- `CaseTemplate{applies_to,tasks[]}`; `Case.tasks[{done,done_by,done_at}]`
- `Watchlist{type:'user'|'host'|'ip'|'rule',entries[],note}`
- `ReportSchedule{type,cron,format,recipients[],filters}`
- `Dashboard{widgets:[{type,query,layout}]}`
- Canonical audit event `{ts,actor{type},action{category,verb},target,outcome,severity,
  source_ip,changes[{field,before,after,redacted}]}` with keyset pagination + facets +
  CSV/NDJSON export; secrets redacted server-side in diffs.
