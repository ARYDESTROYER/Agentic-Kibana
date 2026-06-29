# Round 2 — Per-Wave Implementation Design

Ordered by dependency. Cross-cutting invariants for every wave:
- **#3 byte-identical:** `engine/case_manager.decide()`/`apply()` are NEVER touched.
  Demo mode uses a sandboxed policy copy; templates/watchlists only RECOMMEND.
- **#9 untrusted fencing:** all log/source/user-influenceable text (avatars, display
  names, session UA/IP, source_name, email body vars, terminology labels) renders as
  PLAIN text; never reaches an LLM prompt unfenced.
- **#10 secrets:** env-only / in-memory secret tier; UI shows `configured ✓` booleans,
  never values.
- **ZERO new runtime deps:** stdlib (Python) only; webui composes vendored shadcn +
  Tailwind + existing libs. `react-grid-layout`/`cmdk` are flagged as deliberate
  additions to vet, NOT assumed.
- Additive request/response fields need NO proxy change (both proxies forward
  arbitrary JSON). Keep `webui/src/lib/types.ts` in sync with backend models.

Dependency order: **W1** (bugs, standalone) → **W2** (login/profile; profile model is
the spine for W3/W4/W7) → **W3** (sessions, depends on W2 user model + JWT) → **W4**
(Settings IA, depends on W2 profile + W3 sessions pages existing) → **W5** (demo mode,
isolated) → **W6** (source feeds, isolated) → **W7** (email + pervasive customization,
depends on W2 prefs + W4 IA).

---

## WAVE 1 — Critical bug fixes
Fully specified in `ROUND2_BUGS.md`. Purely webui/presentational + one optional
additive `/api/health.persistent`. Land first; unblocks confidence in the gauge,
MFA enrollment, chat, and the health chip before larger waves. No data model changes.

---

## WAVE 2 — Login redesign + user profile / account self-service

**Approach:** Restyle the existing 4-mode `Login.tsx` into a 2-column split
(brand hero + form) without changing any submit handler or the mode state machine;
add a self-service profile (display_name/avatar/alt_email/timezone/locale/prefs) on
the `User` model surfaced via new `GET/PUT /api/account/me`.

**Backend:**
- `backend/app/models.py:439` `User` — add additive defaulted fields: `display_name:str=''`,
  `alias:str=''`, `avatar:str=''` (bounded data-url), `alt_email:str=''`,
  `timezone:str=''`, `locale:str=''`, `prefs:dict[str,Any]=Field(default_factory=dict)`.
  All defaulted → old stored KV docs load unchanged (no index/migration).
- `backend/app/models.py:477` `User.public()` — add the new NON-secret fields
  (password_hash/mfa_secret/mfa_recovery_hashes stay excluded). This projection feeds
  both `/account/me` and `/users`.
- `backend/app/stores/users.py:169-174` — add the new field names to the `update()`
  `allowed` set (else `update()` silently drops them); never None-clear via update()
  (use `''` / `save(model_copy)`).
- Avatar validator (tight, on the profile field): allow empty or
  `data:image/(png|webp|jpeg);base64,<body>`; reject `svg`; base64-decode + magic-byte
  sniff; cap `_MAX_AVATAR_LEN=64_000`. Browser resizes to 256×256 WebP q0.85 before
  upload, so backend only validates a tiny string.

**Endpoints:**
- `GET /api/account/me` — resolve principal (Depends `current_user` / mirror
  `/auth/me` at routes.py:1152); auth-disabled → stub; env single-admin
  (`state.users.get` → None) → `{username, role, env_managed:true}` + empty profile;
  else `user.public()`.
- `PUT /api/account/me` — body `AccountProfileBody` (all Optional). Gate with
  `require_auth`/`current_user` (NOT `users:manage`). Reject env-managed (400, copy
  change-password lines 1206-1211). Validate avatar + cap prefs size. Patch via
  `state.users.update(principal.username, **patch)`, `await state.refresh_users()`,
  audit `USER_MGMT`/`AUTH_EVENT` actor=principal. Return `public()`.
- `PUT /api/me/avatar` — thin set/clear, same validator, audited.

**Frontend:**
- `webui/src/soc/pages/Login.tsx:276-563` — wrap the existing `max-w-sm` card in a
  `lg:grid-cols-2 min-h-screen` grid: left = brand hero (`bg-hero-glow`/`bg-accent-bar`
  + `branding.org_name`/`logo_data_url`/tagline, aurora glow drift, `hidden lg:block`),
  right = the existing Card + all 4 forms verbatim. SSO block (416-443): per-`p.type`
  brand icons (google/microsoft/generic). MFA mode (446-496): 6-cell segmented OTP,
  `submitMfa` unchanged. OOBE (`setup`/`change` modes): password-strength meter
  (client-only, zxcvbn-style scoring with NO new dep — a tiny local heuristic).
- `webui/src/soc/theme.tsx:120` `applyAccent` — additionally set a secondary CSS var
  from `branding.accent_color2` (already plumbed end-to-end but UNUSED) via existing
  `hexToHslTriplet`, wired into the hero gradient. Optionally consume
  `branding.dark_mode_default`.
- New Profile UI (consumed under W4 Settings > Account): display_name, avatar
  (browser crop helper), alt_email, timezone, locale; calls `api.account.me`.
- `webui/src/lib/api.ts` — add `api.account.get/put`, `api.account.avatar`.

**Data model / config:** additive `User` fields (KV doc, no migration). No new
Preferences.

**Settings:** none new in W2 (Account section page lands in W4).

**Tests:** profile round-trip PUT→GET; env-managed 400; secrets-never-leak (assert
password_hash/mfa_secret absent from `public()`); avatar validator (accept small
webp/png, reject svg/oversize/malformed-base64); webui tsc+vite clean; Login renders
all 4 modes under auth-on.

**Risks:** Login is only mounted when `auth_enabled` (App.tsx:99) — verify against an
auth-on backend. All branding text PLAIN (no dangerouslySetInnerHTML). Keep
`support_url` http(s) guard, `data:image/` guard for new image fields. After any user
mutation call `state.refresh_users()`. `UserStore.update` drops non-allowlisted/None.

---

## WAVE 3 — Sessions & access policy (registry, admin terminate, TTL/idle/absolute)

**Approach:** Keep the stdlib HS256 JWT but make it the short-lived ACCESS token
carrying a new `sid` (128-bit) + `tv` (token_version) claim; add a backend-agnostic
`SessionStore` over the existing KVStore; enforce idle/absolute/revocation in
`require_auth` (async, has AppState) rather than slowing the sync `verify()`.

**Backend:**
- `backend/app/constants.py:44-62` — add `SESSIONS_NS='sessions'`, `SESSIONS_KEY='entries'`.
- `backend/app/stores/sessions.py` (NEW) — `SessionStore(kv)` mirroring
  `stores/users.py`/`stores/memory.py` (RMW one JSON list; EsKVStore/SqlKVStore
  adapters; persisted so it survives `_wire()` rebuilds). Row: `{sid, username,
  refresh_hash, refresh_prev_hash, token_version, created_at, last_active_at,
  last_authn_at, absolute_expiry_at, idle_expiry_at, revoked, revoked_at, revoked_by,
  revoke_reason, ip, ip_city, ip_country, ua_raw, ua_browser, ua_os, client_type,
  mfa_method}`.
- `backend/app/auth/tokens.py` — no change needed: `encode()` only overwrites
  `iat`/`exp`; `sid`/`tv`/`last_authn` pass through; `decode()` returns full claims.
- `backend/app/auth/service.py` — add `sid`+`tv` to the claims dict at the TWO session
  mint sites (`authenticate` :190, `mint_session` :277) — NOT `begin_mfa` (pending
  tokens are exchanged, not registered; `verify` already rejects `mfa=='pending'`).
  `AuthUser` gains `sid: str|None=None` (defaulted). Inject a SessionStore handle +
  policy values into `__init__` (:108).
- `backend/app/api/deps.py:63` `require_auth` — after `auth.verify()` returns a
  principal, do the async session check: load by `sid` (Redis hot path → SessionStore
  fallback), reject if missing/revoked/`tv` mismatch/`now > absolute_expiry`/`now >
  last_active+idle`; lazily bump `last_active` (only if >60s stale); on failure 401
  `{code:'session_invalid'|'session_expired'|'reauth_required'}`. Keep the no-auth
  no-op path.
- `require_fresh_auth(window)` (NEW dep) — step-up gate: 401 `reauth_required` when
  `now - last_authn > window`. Compose onto sensitive routes.
- `backend/app/state.py:77` — build a SessionStore in `_wire()` (`_build_sessions`
  over `self._kv`) and pass into AuthService; refresh on `refresh_users` if a cached
  active-sid set is kept.
- `backend/app/config.py:96-102` Secrets / Preferences — add policy:
  `access_ttl=900`, `idle_timeout=1800`, `absolute_lifetime=43200`, `refresh_ttl=604800`,
  `sudo_reauth_window=600`, notify-on-new-device/terminate booleans (UI-editable
  Preferences sub-model, mirrors `mfa.enforce_for_roles`).
- Refresh rotation + reuse detection in `/api/auth/refresh`: match `refresh_hash` →
  rotate (new hash, old → `refresh_prev_hash`); a replay of `refresh_prev_hash` →
  THEFT: revoke + bump `tv` + audit + notify.

**Endpoints:** `POST /api/auth/refresh`, `POST /api/auth/reauth` (step-up, stamps
`last_authn`); `GET /api/sessions` (own), `POST /api/sessions/{sid}/revoke`,
`POST /api/sessions/revoke-others`; admin `GET /api/admin/sessions`,
`POST /api/admin/sessions/{sid}/revoke`, `POST /api/admin/users/{id}/revoke-all`
(`require_admin` + `require_fresh_auth`). Extend `/api/auth/logout` to revoke current
sid. Session-create hooks at ALL THREE cookie-set sites (routes.py:1136 login, :1403
mfa/verify, :1615 sso/callback) — else some login paths produce unregistered sessions.

**Frontend:** new Sessions page (W4 Settings > Account > Security): table of session
cards, current pinned + "This device" badge, columns Device/Browser, Location
(IP + city/country PLAIN), Last active (humanizeAge), Signed in, per-row destructive
Revoke (AlertDialog), top-right "Sign out all other sessions". Admin sessions console
(all users, filter, force-terminate). Re-auth modal triggered on
`code:'reauth_required'`. `api.ts`: `sessions.list/revoke/revokeOthers`,
`admin.sessions.*`, `auth.refresh/reauth`.

**Data model / config:** SessionStore KV doc; policy fields on Preferences; `sid`/`tv`
claims; `AuthUser.sid`.

**Settings:** token policy editor (TTL/idle/absolute/sudo window, notify toggles)
under W4 Settings > Organization > Security & SSO.

**Tests:** sid mint at all 3 cookie sites; idle/absolute expiry reject; revoke single
+ revoke-all (`tv` bump) invalidates; refresh rotation + reuse-detection theft path;
step-up `require_fresh_auth`; audit on every create/revoke (#2); admin-gate coverage
(extend the route-auth-coverage CI test); no-auth no-op.

**Risks:** `verify()` is sync + I/O-free (hot path) — do the async store check in
`require_auth`, not inside verify. JWT secret is ephemeral if `auth_jwt_secret` unset
(restart invalidates all) — persist sessions in KV, not memory-only, so they survive
`_wire()`. `require_fresh_auth` must no-op when auth off. `current_username` returns
`''` when auth off — audit attribution tolerates empty actor. Higher-cardinality
sessions in a single JSON list → prune revoked/expired rows or move to per-sid keys.

---

## WAVE 4 — Settings IA consolidation (Users/Security/SSO under Settings) + UI consolidation

**Approach:** Two-scope Settings (Personal Account / Organization) in ONE left rail
with grouped headers; move Users/Security/SSO + the W2 Profile/W3 Sessions pages into
Settings sub-sections; declutter the top-level rail by removing the standalone admin
group; consolidate near-duplicate pages into tabbed surfaces.

**Backend:** no new endpoints required (Settings round-trips via existing
`/api/settings`, `/api/branding`, `/api/roles`, plus W2/W3 routes). Optional:
`GET /api/prefs/effective` if W7 customization cascade is co-shipped.

**Frontend:**
- `webui/src/soc/pages/Settings.tsx:94-107` `SectionId` union + `:253 isSectionId` —
  add `account`, `profile`, `preferences`, `account_security`, `sessions`,
  `admin_users`, `admin_security`. `:127-249 SECTION_GROUPS` — add an `account` group
  (Profile/Account/Preferences/Notifications/Security/Sessions, no perm → all signed-in
  users) and put admin items under the existing `administration` group with perms
  (`admin_users` → `users:manage`, `admin_security` → `settings:manage`).
- `:2122-2186 renderSection()` — add `case` arms rendering the embedded bodies. Refactor
  `Users.tsx` `UsersInner` and `Security.tsx` MFA + SSO sections into exported
  sub-components; wrap admin ones in `<Can …>` (RBAC-aware filtering at 2049-2071 hides
  perm'd sections + auto-jumps off a hidden active section — no extra wiring). Do NOT
  double-wrap with `ProtectedRoute` inside Settings.
- Route SSO writes through Settings' single `update()`/`save()` (`prefs.sso`) to avoid
  two competing save buttons; preserve per-provider `secretConfigured` +
  `configured.sso_client_secrets`. Settings PUT still strips `sources`/`setup_complete`.
- `webui/src/soc/nav.ts:75-130 NAV_GROUPS` — DECLUTTER: drop the `admin` group (users +
  security); rail auto-collapses empty groups (AppShell.tsx:229), no AppShell edit.
  Keep `users`/`security`/`sessions` in the `PageId` union + App.tsx switch ONLY if you
  still want them deep-linkable; sub-tabs use the existing `#/settings?s=<id>` query
  pattern (Settings.tsx:1903/1931) — the router only reads the bare page id.
- **Page consolidation** (`webui/src/soc/App.tsx:46 renderPage` + `nav.ts`): merge
  Investigate into Chat as a `Chat | Investigate` segmented control on one scaffold
  (CLAUDE.md: ONE chat engine); Cost into Metrics as a tab (`Overview | Cost |
  Feedback`); Standup into Overview as a tab/panel; Knowledge/Memory/Catalog under one
  Intelligence area (distinct tabs, distinct CRUD). Use `NavOpts.tab` (types.ts:981)
  for sub-views. Removing a PageId requires editing BOTH `nav.ts` AND the hand-written
  `App.renderPage` switch (else falls through to `default:<Overview>`).
- Group the rail into ≤5 top-level groups (Overview / Triage / Intelligence /
  Analytics / Admin) honoring Miller's 7±2.

**Data model / config:** none new (W4 is pure IA). W7's terminology/saved-views land
later.

**Settings:** the entire Settings tree is the deliverable; see `ROUND2_BEST_OF_BEST.md`
for the recommended section tree.

**Tests:** webui tsc+vite clean; Settings hooks ordering (visibleGroups/effect stay
ABOVE the `loading`/`!prefs` early returns — React #310); section deep-link
`#/settings?s=admin_users`; RBAC hides admin sections in auth-on+rbac-on and shows all
in auth-off (allow-all when auth/rbac off, auth.tsx:117); consolidated tab routes.

**Risks:** allow-all default (auth off) must keep showing everything — don't add perms
that hide things in the default profile. `NavOpts` not URL-persisted (router.tsx) →
tab deep-links reset on refresh unless router serialization is extended (W7/later).
Migration safety: keep standalone Users/Security pages + the existing SecuritySection
link-outs during cutover, remove rail items only after embedded sections verified.

---

## WAVE 5 — Demo Mode + Experimental Settings (synthetic old+recent + live-sim, reversible, isolated)

**Approach:** First-class reversible TENANT STATE (off|seeded|live), not a fork.
Synthetic OCSF events flow through the REAL pipeline via a `DemoPullConnector`, but
all writes land in a SEPARATE in-memory store and a deterministic MOCK LLM so demo is
$0, isolated, and one-flip reversible.

**Backend:**
- `backend/app/config.py:999` Preferences — add `demo` block: `{mode:'off'|'seeded'|'live',
  seed:int=1337, run_id:str, history_days:int=14, tick_seconds:float=10,
  tick_jitter:float=0.3, incident_rate:float=0.05}`. Read live via `get_prefs()`.
- `backend/app/connectors/demo.py` (NEW) `DemoPullConnector(PullConnector)`,
  `capabilities=['browse']`, `source_id='demo'`, no es client, returns generated OCSF
  events for the cursor window; register in `connectors/registry.py` only when
  `demo.mode != 'off'`.
- `backend/app/engine/demo_generator.py` (NEW) — registry of named seeded SCENARIOS
  (`generate(rng, window, org, params)->list[OCSFEvent]`), a fixed fictional org
  fixture (~12 employees / 40 hosts / DC / VIP / corp /16), a benign baseline (diurnal
  Poisson + Zipf entity + severity pyramid 70/22/7/1) and 4-6 MITRE ATT&CK storylines
  (phishing→cred-access→lateral→exfil; RDP brute force; SQLi→webshell;
  impossible-travel; ransomware beacon; insider staging) shipped as YAML/JSON data.
- `backend/app/state.py:66 _wire()` — build `self.demo_cases = CaseStore(InMemoryESClient())`
  (throwaway, GC'd on disable) and a demo IngestService bound to it. A `DemoSimulator`
  asyncio task (mirror `_start_receivers` :537) started in `startup()` :510 when
  `mode=='live'`: each jittered tick emits a Poisson benign batch scaled by the diurnal
  envelope + low-prob ignites a queued storyline → demo `ingest()`. Pre-generate the
  trailing `history_days` at enable for "old" cases (backdated `created_at`).
- Gate real data: extend the poll gate `poller.py:179` (`and not prefs.demo_mode`) OR
  swap `self._source` to the DemoPullConnector via `rebuild_log_source` (:466) — pick
  ONE mechanism. Gating BEFORE `source.poll` (:103) keeps the real durable cursor
  untouched.
- `backend/app/llm/gateway.py` — select a deterministic MockProvider when `demo_run_id`
  is set; scenario-keyed verdicts so the same storyline always yields the same verdict;
  usage rows `pricing_source='zero'` with a plausible synthetic `$` for the cost page.
  NEEDS_HUMAN stays open (HITL showcase); FP runs through the REAL `decide()` (proving
  the deterministic gate) but against a SANDBOXED AutoClosePolicy copy — live policy
  untouched.
- Isolation: demo events → `tlsoc-demo-*` indices / `demo_run_id`-tagged SQL rows; a
  StateStore write-guard asserts `row.demo == tenant.demo_mode_active`; every demo
  Case `tags=['demo']`, `case_id='demo-…'`.

**Endpoints:** `POST /api/demo/enable`, `POST /api/demo/reset` (delete-by run_id +
re-seed from same seed), `POST /api/demo/disable` (stop tick, hard-delete by run_id
across cases/audit/usage/events, flip off), `GET /api/demo/status`. All admin-gated.

**Frontend:** `<DemoBanner/>` (shadcn Alert, amber) in the app shell when
`status.mode!='off'` with Reset + "Exit & clear"; `SAMPLE` Badge on demo rows; cost
tiles suffixed "(simulated)"; `useDemoGuard()` disables real-write actions (real
connector run, real notifications, live policy change) while in demo. An Experimental
Settings panel (under W4 Settings) toggles demo mode + knobs.

**Data model / config:** Preferences.demo; throwaway InMemory demo store; demo-namespaced
indices/`demo_run_id`.

**Tests:** seeded-generator determinism (same seed → same events); isolation/write-guard
(demo never writes prod stores); enable→reset→disable lifecycle; $0-cost assertion;
real cursor untouched in demo.

**Risks:** poll gate at :179 is the ONLY run decision — pick source-swap OR flag-branch
and be consistent (or both real+demo flow). `CaseStore.save` writes the real backend —
demo MUST use the separate InMemory store (tags alone don't isolate storage).
`pipeline.investigate_cluster` spends real tokens + writes real audit/usage — mock or
short-circuit. `rebuild_log_source` re-points but doesn't restart the task. Gate before
`source.poll` to protect the durable cursor (#4).

---

## WAVE 6 — Source multi-feed (alerts/events/ignore) customization

**Approach:** Promote `IndexPattern` to a richer per-feed `Feed` model (keep the wire
key `config['index_patterns']` + class name to avoid a breaking rename); add the
`ignore` role; split the overloaded `auto_correlate` into `correlate` +
`auto_investigate` with a behavior-preserving migration; add per-feed
query/field-mapping/severity-floor/schedule.

**Backend:**
- `backend/app/constants.py:261` `IndexRole` — add `IGNORE='ignore'`.
- `backend/app/config.py:742` `IndexPattern`→richer `Feed` (back-compat extension):
  `id:str=''` (lazy `slug(pattern)`), `pattern`, `role:IndexRole=EVENTS`, `enabled:bool=True`,
  `query:str|None=None` (connector-native filter, operator-TRUSTED), `field_mapping:dict={}`
  (override; falls back to source-level), `message_field:str|None=None`,
  `severity_floor:int|None=None` (OCSF severity_id 1-6), `correlate:bool=True`,
  `auto_investigate:bool|None=None` (None→derived), `poll_interval_seconds:int|None`,
  `label:str=''`. All Optional+defaulted so stored `{pattern,role,auto_correlate}` and
  bare-string entries still validate (malformed entries skipped, config.py:807).
- `SourceInstance.index_patterns()` (:793) returns `Feed` objects + a pure
  `upgrade_feed(dict)->dict` (legacy → `id=slug`, `correlate=true`,
  `auto_investigate=(role=='alerts' or legacy auto_correlate)`, others default). Add a
  `feeds()` canonical accessor; keep `index_patterns()` working so existing call sites
  compile.
- `connectors/elastic.py:139 _index_patterns` + `:151` role coercion allowlist — add
  `'ignore'` (else it silently downgrades to `events`); `:132-136` union build excludes
  IGNORE feeds; per-feed `query`/`severity_floor` require splitting the single union
  body (poll :396 / search :455) into per-pattern sub-queries (the main architectural
  friction). Effective mapping = `{**source.field_mapping, **feed.field_mapping}`;
  effective message_field = `feed.message_field or source.message_field`.
- `engine/ingest.py:160 handle_clusters` forwarded-gate + `:61 _auto_correlate_allowed`
  — IGNORE → skip ingest entirely; severity_floor → register candidate + live-tail but
  set `auto_investigate_eligible=False` (NEVER drop, #4); role drives smart defaults
  (alerts → auto-investigate + bypass allowlist; events → allowlist path).
- `engine/poller.py` — per-feed durable cursor key `f'{source.id}:{feed.id}'` so a fast
  alerts feed and a slow events feed never share/skip (#4); group feeds by interval.
- Keep `config['data_view_pattern']` synced (comma-join of non-ignore patterns) for the
  legacy fallback.

**Endpoints:** none required (`/api/sources` round-trips `config` verbatim; additive).
Optional `GET /api/sources/{id}/feeds` returning resolved effective feeds for the UI.

**Frontend:** `webui/src/soc/components/SourceEditor.tsx:423 IndexPatternsEditor` —
per-row editable table: role segmented control events/alerts/ignore (alerts=red/amber,
events=blue, ignore=muted/strikethrough, pinned for precedence), enabled toggle,
severity-floor slider (1-6), correlate + auto-investigate switches, query monospace
input with a "test" affordance (bounded browse endpoint), mapping override drawer
(reuse the existing field-mapping editor), schedule input (default "inherit"), and an
effective-config preview chip. Update `deriveIndexPatterns` (:158 reader) +
`buildConfig` (:803 writer; exclude IGNORE from the derived `data_view_pattern`).
`types.ts:277 IndexPattern` + `:316 SourceConfigExtras` — add the new optional fields.

**Data model / config:** Feed fields on `config['index_patterns']` (loose JSON, no
migration); IndexRole.IGNORE.

**Settings:** the per-source Feeds editor (under W4 Sources & Connectors).

**Tests:** legacy `{pattern,role,auto_correlate}` + bare-string still validate and yield
identical effective `auto_investigate`; IGNORE excludes a sub-index from a broad events
pattern (longest-pattern-wins precedence); severity_floor blocks auto-forward but keeps
candidate (#4); per-feed cursor isolation (fast vs slow); effective mapping override
precedence; webui tsc+vite clean; `pytest -q` green.

**Risks:** TWO parsers in lock-step (`SourceInstance.index_patterns()` +
`ElasticConnector._index_patterns()`) — update BOTH. The single union ES query is the
friction for per-feed query/severity (restructure to per-pattern sub-queries).
Per-feed field-mapping has no precedent (mappings were per-source/global). Role coercion
hardcodes `('events','alerts')` — a new role silently becomes events until updated.
`auto_correlate=false` (manual triage, still correlated, #4) is distinct from IGNORE
(drop) — document it; #4 forbids silently dropping events. Feeds are PULL-centric;
PUSH declares role wholesale (`_push_source_role`).

---

## WAVE 7 — Email (Resend + SES + templates) + pervasive customization + best-of-best

**Approach:** Add Resend (HTTPS-API) and SES (SMTP preset + optional SigV4 API)
channels to the existing NotificationChannel SPI; ship a preloaded, operator-overridable
template SET rendered by a tiny stdlib mustache-subset renderer with hard
UNTRUSTED-escaping; add a two-store customization model (org Preferences + per-user
UserPrefsStore) for saved views / dashboards / table columns / terminology / theming.

**Backend (email):**
- `backend/app/notifications/resend.py` (NEW) — `@register_channel class
  ResendChannel(_HttpChannel)` type='resend'. `send()`: API key = `self._secret`; POST
  `https://api.resend.com/emails` with `Authorization: Bearer`, mandatory `User-Agent`,
  optional `Idempotency-Key` (e.g. `case-notify/{case_id}/{trigger}`), body
  `{from, to, subject, html, text}`; reuse `_post(json=…, headers=…, success_max=300)`;
  map errors on `name` (retry only 429 `rate_limit_exceeded`/5xx, NOT quota/4xx config),
  honor `retry-after`; client-side ~4 rps token bucket (5/s per-team). 200 → `{id}` =
  provider message id (store for audit).
- SES: ship an SES SMTP preset (`email-smtp.{region}.amazonaws.com:587`, region-templated)
  — already at `email.py:91`; accept either pre-made SMTP creds OR a raw IAM key pair and
  derive the SMTP password via the ~12-line stdlib HMAC chain
  (`AWS4`+secret→date(`11111111`)→region→`ses`→`aws4_request`→`SendRawEmail`→
  `base64(0x04+sig)`). Optional `ses_api.py` v2 SendEmail via stdlib SigV4 (same key
  ladder) for ConfigurationSet/MessageId — but keep SMTP as the simple default.
- Register: add `from . import resend as _resend` / `ses_api` to
  `channel.py:124 _load_builtins()` (the ONLY place new modules self-register).
- Widen types in ALL THREE: `config.py:948 NotificationChannelConfig.type` Literal,
  `types.ts:704 NotificationChannelType` union, `NotificationsEditor.tsx:75 CHANNEL_META`
  + `:120 CHANNEL_TYPES` (the UI list is hardcoded, NOT driven by `channel_types()`).
- Templates: `backend/app/notifications/templates.py` — a stdlib mustache-subset renderer
  (`{{var}}` auto-escaped via `html.escape`, `{{{var}}}` raw for trusted header HTML only,
  `{{#section}}`/`{{^section}}`, dotted dict lookup, NO eval/getattr, ~80 LOC). Add a
  `NotificationTemplates` model (per-trigger `{subject, html, text}` overrides) on
  `NotificationConfig` (config.py:980); `render()` loads operator overrides + escapes each
  interpolated var on a whitelisted variable set from `build_meta`, falls back to the
  built-in default per trigger. `header_safe()` (strip CRLF/control, cap 120) for Subject;
  `text_safe()` (strip newlines from untrusted) for the .txt part. 5 preloaded templates:
  `case.new`, `case.escalation`, `case.resolved`, `digest.daily`, `test`. Email shell
  consumes `GET /api/branding` tokens.
- Threading: deterministic `Message-Id` from `case_id` on new-case; `In-Reply-To`/
  `References` on escalation/resolved; `X-TLSOC-Case-Id`/`-Severity`/`-Verdict` headers.
  NotifyPolicy (deterministic, in Preferences, NEVER LLM/playbook): per-severity routing,
  NEEDS_HUMAN always emails.

**Backend (customization):**
- `backend/app/stores/user_prefs.py` (NEW) — `UserPrefsStore` over the KVStore (mirror
  `stores/memory.py`; EsKVStore/SqlKVStore; keyed by user_id, `'default'` when auth off;
  no new index). Holds personal saved views, per-table column state, personal dashboard
  layout, last-used list state, theme mode, pinned default-view ids.
- `backend/app/config.py` Preferences/BrandingConfig — add `terminology:dict[str,str]`,
  org default saved views/dashboard, a full branding token set; admin-only PUT.
- `backend/app/models.py` — `SavedView`, `ColumnState`, `DashboardLayout`,
  `WidgetPlacement`, `UserPrefs`, plus `ApiKey`, `Watchlist`, `CaseTemplate`,
  `ReportSchedule` (best-of-best, see that doc).

**Endpoints (email):** `GET /api/notifications/providers` already exposes
`email_presets`/`channel_types`; add `POST /api/notifications/preview?trigger=`
(server-side render of `_sample_case` → `{subject,html,text}`, escaping authoritative);
secret set via existing `POST /api/notifications/channels/{id}/secret`.
**Endpoints (customization):** `GET /api/prefs/effective` (merged cascade),
`GET/PUT /api/prefs/user`, `GET/PUT /api/prefs/org` (admin), `GET/POST/PUT/DELETE
/api/views`, `POST /api/views/{id}/clone`, `PUT /api/prefs/user/tables/{table_id}`,
`GET/PUT /api/prefs/user|org/dashboard`, `GET/PUT /api/terminology` (PUT admin).

**Frontend:** Resend/SES channel config rows + domain-verification/sandbox-status
callouts + test-send + a template preview pane (`api.notifications.preview`). A
`PrefsContext` hydrated once from `/api/prefs/effective`; `SavedViewsBar`; a TanStack
`DataTable` persisting column state; `DashboardGrid` (react-grid-layout — vet the dep);
a `t(key)` terminology helper over default strings; theme tokens as CSS custom
properties + a user light/dark/system toggle.

**Data model / config:** NotificationTemplates + NotifyPolicy on Preferences;
UserPrefsStore KV; terminology/org-defaults/branding-tokens on Preferences.

**Settings:** Notifications (channel-first matrix + template editor + preview) and
Appearance/Terminology + Saved-views/Dashboard sections under W4 IA.

**Tests (email):** Resend self-registers (`channel_types()` contains it) + `send()` ok
via injected poster; `SendResult.detail` never leaks secrets; renderer escapes `<script>`
+ `{{ }}` in untrusted vars; `header_safe` strips CRLF (header-injection); `text_safe`
strips newlines; each of the 5 templates renders with a fixture; raw marker only for the
trusted header. **Tests (customization):** UserPrefsStore CRUD on SQLite+fake-ES;
cascade resolver precedence; admin-gate on every `/api/prefs/org`+`/api/terminology`
(extend route-auth-coverage); SavedView clone personal←org.

**Risks:** `send()` MUST never raise (#3 channel isolation) → try/except → `SendResult`.
`detail` is audited verbatim — no secrets. Body already escaped by `render()` — channels
deliver verbatim, never re-inject raw case fields (#9). The webui channel list is
hardcoded (3 places to widen) + the `type` Literal REJECTS unknown types on PUT. SES
SigV4 multi-credential (access+secret+region) needs the full secret bucket, not the
single `_resolve_secret` string — keep SES on SMTP for simplicity. `react-grid-layout`
is a NEW dep — vet against the no-new-deps rule before committing. All terminology/view
text rendered as data, never markup, never unfenced into a prompt (#9).
