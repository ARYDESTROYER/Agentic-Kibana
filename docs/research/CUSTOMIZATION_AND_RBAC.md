# Data-source customization & RBAC — competitor research + TLSOC design

> Research synthesis (Elastic Security, Splunk ES, Microsoft Sentinel, Google
> SecOps/Chronicle, Panther, Wazuh, CrowdStrike Falcon LogScale) mapped to a
> concrete design for the TLSOC suite. Companion: `UX_AND_DESIGN.md`.
>
> Sourcing note: several vendor doc hosts (learn.microsoft.com, docs.cloud.google.com,
> www.elastic.co, docs.splunk.com, docs.panther.com, documentation.wazuh.com,
> library.humio.com) return 403 to automated fetch from this environment, so
> findings are drawn from official-doc search extractions; the canonical doc URLs
> are cited inline in the per-product research notes captured during this round.

## 1. How the field handles "many sources / many indices, with roles"

| Product | Multi-source unit | "raw events" vs "already-triaged alerts" | "investigate every event from this source" |
|---|---|---|---|
| Elastic Security | **Data view** (1..N indices/streams/aliases, wildcards, CCS) | source indices (`logs-*`) vs system **`.alerts-security.alerts-<space>`** | **Detection rules** (schedule + look-back) read source patterns, write alerts |
| Splunk ES | `index=` + `sourcetype=` scoping | ingest indexes vs summary **`index=notable`** / **`index=risk`** | **Correlation searches** (scheduled) → Notable / Risk |
| MS Sentinel | data connectors → table-per-source | source tables vs **`SecurityAlert`**; incidents from analytics rules | **Scheduled / NRT analytics rules** |
| Google SecOps | `metadata.log_type` per record | UDM events vs detections/alerts | **YARA-L** continuous (streaming <5 min) + retrohunt |
| Panther | Data Transport → Schema/Log Type | RBAC scopes alerts **per log type** | `rule(event)` runs per event of declared `LogTypes` |
| Wazuh | agents/syslog → decoders | **`wazuh-archives-*`** (raw) vs **`wazuh-alerts-*`** (rule-matched) | every decoded event evaluated against the ruleset |
| LogScale | Repository (+ ingest token → parser) | filtered **Views** vs raw repo | **Filter Alert** (per-event, ~10 s) |

**Universal pattern:** everyone separates a *raw-events* tier from an *already-triaged
alerts* tier, and models "auto-investigate everything from a source" as a
**continuously-evaluated rule keyed on source/index/log-type**. This is exactly the
user's request ("one index = all events, one index = alerts, investigate every
alert").

### TLSOC implementation (shipped this round)
- `SourceInstance.config.index_patterns: [{pattern, role}]` where `role ∈ {events, alerts}`.
- **`alerts`-role patterns** → every matching cluster is auto-forwarded to the LLM
  investigation (bypasses `auto_forward_allowlist`, still gated by
  `background_scan_enabled`). `events`-role → correlate then allowlist (today's path).
- N patterns per source, comma-joined for the read; each event tagged with its
  originating pattern/role + source. Back-compat: absent `index_patterns` → the single
  `data_view_pattern` with role `events`.

## 2. Field mapping / "what if a field (e.g. source IP) is missing?"

Every product normalizes heterogeneous logs to a canonical schema (ECS / CIM / UDM /
Panther `p_` fields) and treats **most normalized fields as optional**: a missing
field is simply absent (null), never a hard failure. Correlation falls back to
whatever entity *is* present:
- Elastic correlates on `host.name`/`user.name`/`host.id`, not solely IP.
- Splunk asset/identity framework keys on `src`/`dest`/`dvc`/`user` (hostname/MAC lookups).
- Sentinel entity mapping requires no IP — map whatever identifiers exist (≤3 per entity).
- Chronicle UDM nouns are optional (only ≥1 noun required); ECG joins on user/host/hash.
- Wazuh falls back to the **agent** (host) identity; Panther/LogScale leave the IP
  indicator list empty and correlate on other indicators.

### TLSOC implementation (shipped this round) — the no-source-IP fix
Previously `correlate()` grouped by a single entity and **silently dropped events
whose entity field was null** → a source with no `source.ip` produced *no cases*.
Now:
- `entity_strategy` (per-source `config.entity_strategy`, or `Preferences.entity_strategy`,
  default `auto`): `auto` falls back **IP → host → user → rule (+coarse time bucket)** so
  a case **always** forms; explicit `ip|host|user|rule` also selectable.
- The actual entity type used is recorded on the cluster/case (`case.entity.type`) so
  the UI shows "grouped by host/rule".
- A configurable `message_field` joins the existing per-source field mapping.
- Back-compat: events that have the primary entity under the default strategy cluster
  byte-identically to before (all prior correlation tests stay green).

## 3. Multi-source querying / scoping

- Elastic: pick one data view in Discover (no "search all" button); detection rules
  carry their own scope. Splunk: `index=`/`sourcetype=` ∩ the role's allowed indexes
  (default = `srchIndexesDefault`). Chronicle/LogScale: scope to one repo/log-type or a
  View/`union` across many. **Default is generally a chosen scope, not implicit all.**

### TLSOC implementation
- Chat gained `source_id` (single-source select; absent → primary). The webui chat
  composer has a **source selector defaulting to "All sources"** (currently = primary,
  honestly labelled).
- Cases/Scans carry `source_id`/`source_name` and have a **filter-by-source facet** + sort.
- **Deferred (designed, not yet built): true cross-source aggregation** — query/poll all
  configured pull sources and union results (à la Splunk `union`/LogScale Views). Today
  only the primary pull source is actively polled; this is the next architectural step.

## 4. RBAC / user management — design for a FastAPI + optional-JWT app

**Field consensus:** separate **functional RBAC** (what you can *do*) from **data
RBAC** (what data you can *see*). Roles converge on **admin / analyst / read-only**:

| Product | Functional roles |
|---|---|
| Panther | Admin / Analyst / AnalystReadOnly (+ log-type-scoped View/Manage Alerts) |
| Elastic | superuser / editor / viewer × Kibana feature+space privileges |
| Splunk | admin / power / user (+ ess_admin/ess_analyst/ess_user); capabilities + `srchIndexesAllowed` |
| Sentinel | Reader / Responder / Contributor / Playbook Operator |
| Chronicle | viewer / limitedViewer / editor / admin (IAM) + SOAR permission groups |
| Wazuh | administrator / read-only analyst; policies = {actions, resources, allow/deny} |
| LogScale | Admin / Member / Reader (+ named permissions; org-level ManageUsers) |

### Recommended TLSOC RBAC (a focused follow-up; auth scaffolding already exists)
The suite already has optional auth (`app/auth/`: PBKDF2 + stdlib HS256 JWT, a user
map, `require_auth` gate, default OFF). Add — **behind the existing optional auth** so
the no-auth default is unchanged:
1. **Roles** `admin | analyst | viewer` (capability sets):
   - `viewer` — read all GET surfaces; no mutations.
   - `analyst` — viewer + case actions/feedback/comments, chat, reinvestigate, memory edits.
   - `admin` — analyst + sources/settings/branding/users, RAG import/delete, prefs.
2. **Enforcement at the router layer** — extend `require_auth` into a
   `require_capability(cap)` dependency; annotate each route with a capability; a
   CI route-coverage test asserts every `/api` route declares one (mirrors the existing
   auth-coverage test). Map HTTP method → default capability (GET=read) with explicit
   overrides for mutations.
3. **User model + admin UI** — `User{username, password_hash, role, active, created_at}`
   persisted in the StateStore (a `users` KV/table, backend-agnostic like `MemoryStore`);
   `GET/POST/PUT/DELETE /api/users` (admin-only); a webui **Administration → Users** page
   (add/disable/role-change; never echo password hashes). Seed an initial admin from env.
4. **API keys / tokens** — issue scoped, role-bound tokens for automation (least-privilege;
   note Panther's anti-pattern of full-access tokens — avoid it).
5. **SSO (later)** — OIDC/SAML realm + group→role mapping (every competitor supports this);
   out of scope for the first cut.
6. **Data RBAC (later)** — per-source visibility scoping (Panther's per-log-type,
   Sentinel's row-level, LogScale's filtered Views) once multi-source is fully wired.

**Why deferred to its own round:** RBAC is security-sensitive (auth bypass = critical),
needs schema (users store) + enforcement on *every* route + a coverage test + careful
back-compat with the no-auth default. Rushing it alongside a large UI round risks a
half-enforced model, which is worse than none. The design above is ready to implement.

## 5. Priority recommendations for TLSOC

1. ✅ **(this round)** entity-agnostic correlation (no-IP fix) — was silently dropping alerts.
2. ✅ **(this round)** per-source N index patterns with `events`/`alerts` roles.
3. ✅ **(this round)** `source_id` on cases + filter-by-source + chat source select.
4. ✅ **(this round)** per-source field mapping + `message_field` + entity strategy UI.
5. ⏭️ **(next)** RBAC + Users admin (design in §4).
6. ⏭️ **(next)** true cross-source aggregation (poll/query all configured sources).
7. ⏭️ **(next)** a "detection rule" abstraction (scheduled query → auto-case) like the
   field's correlation/analytics rules, generalizing the alerts-role pattern.
