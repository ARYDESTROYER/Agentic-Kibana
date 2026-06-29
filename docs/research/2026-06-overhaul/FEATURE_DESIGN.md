# FEATURE_DESIGN — 2026-06 Overhaul Implementation Design

> Per-feature implementation design, **ordered by dependency**. Each feature
> lists: approach, exact backend files, exact frontend files, new endpoints,
> data-model changes (config.py / models.py / constants.py / stores), settings
> added, tests, and risks. Grounded in `CODEBASE_MAP.md`; informed by
> `RESEARCH_DOSSIER.md`. Non-negotiables #1/#2/#3/#9/#10 hold throughout.

Dependency order (build top-to-bottom):

1. **F1 — OOBE first-user + multi-user** (foundation: real users in a store)
2. **F2 — RBAC** (needs users; everything else gates on roles)
3. **F3 — MFA (TOTP)** (extends the user/auth model)
4. **F4 — SSO (OIDC)** (extends auth; provisions users → roles)
5. **F8 — Status taxonomy + disposition** (data-model base for case UI/automation)
6. **F7 — Case-ID nomenclature** (small, depends only on KV counter)
7. **F5 — Notifications (email + channel abstraction)** (gated by RBAC; triggers off F8)
8. **F6 — Multi-source + Auto-Correlate toggles** (correlation engine + sub-source roles)
9. **F9 — Ingestion customization + connector help** (extends AuthField + SourceInstance.config)
10. **F10 — Run-a-playbook + threshold automation** (depends on #3, F8 status, F5 notify)
11. **F11 — Threat-context panel + reusable-knowledge loop** (RAG + F8 close hook)
12. **F12 — Full Settings menu** (surfaces F1–F11 + existing prefs)
13. **F13 — UI cleanup (RiskGauge fix, alignment, loading)** (last; cosmetic + the gauge bug)

---

## F1 — OOBE first-user setup + multi-user

**Approach.** Today auth is single-admin-from-env, default OFF. Introduce a real
`User` store so multi-user + first-run setup work. On boot, if auth is enabled and
**no users exist**, force an OOBE that creates the first admin; seed
`Admin` / `Admin@123` now with a `must_change_password` flag so it is replaced on
first login. Keep the env single-admin path as a fallback/back-compat. Multi-user =
`UserRepository` (indexed in ES, table in SQL — NOT the KV-singleton pattern,
because we filter/sort by username/role).

**Backend files (change/add):**
- `backend/app/auth/service.py` — extend `AuthService` to read users from
  `UserRepository` (not just the env map); add `create_user`, `set_password`,
  `verify(token)` returns role/must_change. Hash via existing `auth/passwords.py`.
- `backend/app/auth/passwords.py` — bump PBKDF2 iterations to 310k (RESEARCH §12);
  back-compat verify (the stored format already embeds iteration count).
- `backend/app/stores/base.py` — new `UserRepository` ABC (`save`, `get`,
  `get_by_username`, `list`, `delete`, `find_active`).
- `backend/app/stores/users.py` — new ES `UserStore` (index `tlsoc-agent-users`).
- `backend/app/stores/sql/models.py` — new `UserRow` (username PK, role idx,
  active idx, created_at idx, `doc` JSON for full model incl. password_hash,
  mfa_secret_encrypted, must_change_password).
- `backend/app/stores/sql/repositories.py` — `SqlUserRepository`.
- `backend/app/state.py` — `_build_state_backend()` wires `self.users`; seed first
  admin (`Admin`/`Admin@123`, `must_change_password=True`) if auth enabled and the
  store is empty; never overwrite an existing admin.
- `backend/app/api/routes.py` — OOBE + user routes (below); change `POST
  /auth/login` to surface `must_change_password` and reject login (issue a one-time
  "change password" token) until changed.
- `backend/app/constants.py` — `USERS_INDEX = "tlsoc-agent-users"`,
  `ActionType.USER` (or reuse `COLLAB`) for user-management audit.

**Frontend files (change/add):**
- `webui/src/soc/pages/Login.tsx` — handle `must_change_password` → show change-password
  form before completing login.
- `webui/src/soc/components/SetupWizard.tsx` (new) — 6-step first-run dialog
  (Welcome → Admin account → Connector → Configure → LLM → Review), shown by
  `App.tsx` when `setup_complete=false` (extends the existing wizard gate).
- `webui/src/soc/pages/admin/Users.tsx` (new) — admin-only user table (add/disable/
  reset-password/role picker), reached from Settings → Administration.
- `webui/src/soc/App.tsx` — route OOBE; bounce to change-password on the login flag.
- `webui/src/lib/types.ts` — `User`, `AuthMe.user.role`, `AuthMe.user.must_change_password`.
- `webui/src/lib/api.ts` — `api.auth.changePassword`, `api.users.{list,create,update,delete}`,
  `api.setup.initAdmin`.

**New endpoints:**
- `POST /api/setup/init-admin` (public, ONLY when no users exist) — create first
  admin.
- `POST /api/auth/change-password` (self) — replace own password, clear
  `must_change_password`.
- `GET /api/users`, `POST /api/users`, `PUT /api/users/{username}`,
  `DELETE /api/users/{username}` (all `require_role(['super_admin'])`).

**Data-model changes:**
- `models.py`: new `User` model (`username`, `password_hash`, `role`, `active`,
  `mfa_secret_encrypted`, `mfa_recovery_hashes[]`, `must_change_password`,
  `created_at`, `updated_at`, `last_login_at`, `groups[]`).
- `constants.py`: `USERS_INDEX`; user-mgmt audit `ActionType`.
- `config.py Secrets`: keep `auth_admin_username/password` as env fallback; add
  `auth_seed_admin: bool = True` (seed `Admin`/`Admin@123` on empty store).
- stores: `UserRepository` + ES/SQL impls.

**Settings added:** `Preferences` unchanged for F1 (users are NOT preferences — they
are persisted state). Auth toggles stay in `Secrets`. (F12 surfaces a Users admin page.)

**Tests:**
- `tests/test_users_store.py` — round-trip save/get/list/delete on FakeES + SQLite.
- `tests/test_oobe.py` — init-admin only when empty; seed admin has
  `must_change_password`; login blocked until changed.
- `tests/test_auth_primitives.py` (extend) — 310k-iter hash verify; old-format hash
  still verifies.

**Risks:** seeding a known password (`Admin@123`) is a security smell — MUST force
change on first login (code-enforced) and document it. UserRow.active invalidates
stateless JWTs only on next request lookup (add an `active` check in `verify` —
adds a store read per request; acceptable, or embed `active_at` in JWT). Concurrent
init-admin race — make the "no users exist" check + create atomic (store-level
create-if-not-exists).

---

## F2 — RBAC (roles + permission matrix; FastAPI deps + React guard)

**Approach.** Add `role` to `AuthUser` + JWT claims. Flip the existing
`require_admin` seam (`deps.py:80`) from default-allow to deny-by-default, and add a
parameterized `require_role(roles)` / `require_permission(resource, action)`
dependency. Permission matrix is **configuration** (data), enforcement is **code**.
React filters nav + actions from `user.role`; server enforces on every request.

**Backend files (change/add):**
- `backend/app/auth/service.py` — `AuthUser` gains `role: str`; `authenticate`/
  `encode` embed `role` in JWT; `verify` reads it (falls back to user store).
- `backend/app/api/deps.py` — replace `require_admin` body with role check; add
  `require_role(*roles)` and `require_permission(resource, action)` factories
  reading `Preferences.rbac`.
- `backend/app/rbac/policy.py` (new) — `can(user, resource, action, rbac_config) ->
  bool`; default matrix constant.
- `backend/app/api/routes.py` — annotate every state-changing route with the right
  dependency (cases write/close → tier2+; sources/settings/users → admin/manager;
  proposals approve → manager+). The `approve/reject` routes already depend on
  `require_admin` (now enforcing).
- `backend/app/constants.py` — `class Role(str, Enum)` for users:
  `SUPER_ADMIN, SOC_MANAGER, ANALYST_TIER2, ANALYST_TIER1, RESPONDER, AUDITOR`
  (distinct from the existing LLM `Role` — name it `UserRole`).
- `backend/app/audit/audit_log.py` — log denied requests (`status=denied`,
  `deny_reason`) — see #2 (append-only).

**Frontend files (change/add):**
- `webui/src/soc/AppShell.tsx` — filter `NAV_GROUPS` by `useAuth().role`.
- `webui/src/soc/auth.tsx` (new) — `AuthContext` exposing `user.role`,
  `hasPermission(resource, action)`.
- `webui/src/soc/components/Can.tsx` (new) — `<Can resource action>` wrapper +
  `ProtectedRoute` for page gating; `/unauthorized` fallback.
- `webui/src/soc/pages/*` — wrap admin actions (close, approve, settings write,
  user mgmt) in `<Can>`.
- `webui/src/lib/types.ts` — `UserRole`, extend `AuthUser`.

**New endpoints:** `GET /api/roles` (list role → permission matrix for the UI).
(Permission matrix mutation rides `PUT /api/settings` under `rbac`.)

**Data-model changes:**
- `constants.py`: `UserRole` enum.
- `config.py Preferences`: `rbac: RBACConfig` with `enabled: bool = False`
  (back-compat: when disabled, all authenticated users are treated as admin),
  `roles: dict[str, dict[str, list[str]]]` (role → resource → actions),
  `default_role: str = "analyst_tier1"`. Store role assignment on the `User`
  (F1), not Preferences.
- `models.py`: `AuditDoc` gains optional `status` + `deny_reason` + `actor_role`
  (additive).

**Settings added:** `rbac.enabled`, `rbac.roles` (matrix editor), `rbac.default_role`.

**Tests:**
- `tests/test_rbac_policy.py` — `can()` truth table per (role, resource, action).
- `tests/test_route_auth_coverage.py` (extend) — every state-changing route
  declares a role dependency; deny-by-default verified.
- parametrized route tests: `(role, action) → expected status (200/403)`.

**Risks:** flipping `require_admin` to enforce while auth is OFF must stay a no-op
(when `auth.is_enabled` is False the gate already short-circuits — keep that). Token
size grows slightly with `role` claim (fine). `rbac.enabled=False` MUST grant admin
to all authenticated users so existing single-admin deployments don't break.

---

## F3 — MFA (TOTP + browser QR, recovery codes; stdlib)

**Approach.** Pure-stdlib TOTP (RESEARCH §4) — no backend deps. QR rendered
client-side from the `otpauth://` URI. Two-phase login: password OK →
`{requires_mfa, session}` → `POST /auth/mfa/verify`. Secrets encrypted at rest in
the user store under the secret tier discipline.

**Backend files (change/add):**
- `backend/app/auth/mfa.py` (new) — `generate_secret()`, `provisioning_uri(user,
  issuer, secret)`, `verify_totp(secret, code, window=1)`, `recovery_codes()`.
  Stdlib `hmac/hashlib/struct/base64/time/secrets` only.
- `backend/app/auth/service.py` — login returns `requires_mfa` + an ephemeral
  half-auth session token when `user.mfa_enabled`; `verify_mfa(session, code)`
  mints the real JWT; recovery-code path consumes a single-use hash.
- `backend/app/api/routes.py` — MFA routes (below).
- `models.py User` — `mfa_enabled`, `mfa_secret_encrypted`, `mfa_recovery_hashes[]`,
  `mfa_last_step` (replay protection).
- `config.py Preferences` — `mfa: MfaConfig` (`enabled`, `issuer`, `digits=6`,
  `period=30`, `enforce_for_roles: list[str]`).
- `config.py Secrets` — `mfa_encryption_key: str | None` (Fernet key for at-rest
  secret encryption; if `cryptography` absent, store under the same in-memory-only
  discipline as connector secrets and warn).

**Frontend files (change/add):**
- `webui/src/soc/pages/Login.tsx` — MFA code step when `requires_mfa`.
- `webui/src/soc/pages/admin/MfaSetup.tsx` (new) — enroll: fetch secret + URI,
  render QR client-side (`qr-creator` — small, ~4.75kB; only new dep, justified;
  OR a dependency-free inline SVG QR encoder if no-new-deps is enforced), show +
  download recovery codes, verify a test code to confirm.
- `webui/src/lib/api.ts` — `api.auth.mfa.{setup,confirm,verify,disable}`.

**New endpoints:**
- `POST /api/auth/mfa/setup` (self, authed) → `{secret, otpauth_uri, recovery_codes}`.
- `POST /api/auth/mfa/confirm` (self) — verify a test code, persist enabled.
- `POST /api/auth/mfa/verify` (login phase 2) → real JWT.
- `POST /api/auth/mfa/disable` (self, requires current TOTP; admin can force-disable).

**Data-model changes:** `models.py User` MFA fields; `Preferences.mfa`;
`Secrets.mfa_encryption_key`.

**Settings added:** `mfa.enabled`, `mfa.issuer`, `mfa.enforce_for_roles`.

**Tests:**
- `tests/test_mfa.py` — RFC 6238 vectors; ±1 window; replay rejected; recovery-code
  single-use; secret encrypt/decrypt round-trip.
- login-flow test: password→requires_mfa→verify→JWT.

**Risks:** at-rest secret encryption — pick Fernet with a Secrets-provided key;
document key rotation. The browser QR is the only spot tempted to add an npm dep —
prefer the no-new-deps inline SVG encoder to honor the webui "no new deps" rule
(falls back to displaying the secret + URI as copyable text).

---

## F4 — SSO (Google + Microsoft + generic OIDC)

**Approach.** Authorization Code + PKCE; server-side code exchange; validate the
`id_token` against provider JWKS (RS256). Configured from settings (provider, client
id, discovery URL, scopes, allowed domains/tenants, group→role map). Needs
`PyJWT[crypto]` (RS256) — the ONLY new backend dependency (justified; lazily imported
so offline tests don't require it). Auto-provision users → roles via the group map.

**Backend files (change/add):**
- `backend/app/auth/oidc.py` (new) — `OidcProvider` (discovery fetch + JWKS cache via
  `jwt.PyJWKClient`); `authorization_url(state, nonce, code_challenge)`,
  `exchange_code(code, verifier)`, `validate_id_token(token, nonce)`.
- `backend/app/auth/service.py` — `oidc_login(claims)`: map `sub`/`email` →
  existing or auto-provisioned `User` (role from `group_role_map` or default),
  mint JWT.
- `backend/app/api/routes.py` — OIDC authorize/callback routes (below); store
  state+nonce in a short-lived KV (`KVStore` namespace `oidc_state`, TTL via
  expiry field check).
- `config.py Preferences` — `sso: SSOConfig` (`enabled`, `provider`,
  `discovery_url`, `client_id`, `scopes`, `allowed_domains[]`, `allowed_tenants[]`,
  `group_claim_name`, `group_role_map`, `auto_create_users`, `default_role`).
- `config.py Secrets` — `sso_client_secret: str | None` (env-only).
- `backend/requirements.txt` — `pyjwt[crypto]>=2.13.0` (lazy import in `oidc.py`).

**Frontend files (change/add):**
- `webui/src/soc/pages/Login.tsx` — "Sign in with Google / Microsoft" buttons when
  `sso.enabled`; redirect to authorize URL; handle callback session.
- `webui/src/soc/pages/admin/SSO.tsx` (new, under Settings) — configure provider,
  show callback URL to register with the IdP, group→role map, test button.
- `webui/src/lib/api.ts` — `api.auth.sso.{providers, authorize}`.

**New endpoints:**
- `GET /api/auth/sso/providers` (public) → enabled providers + display.
- `GET /api/auth/sso/authorize?provider=` (public) → `{auth_url}` (sets state/nonce).
- `GET /api/auth/sso/callback?code=&state=` (public) — validate, mint JWT cookie,
  redirect to `/`.

**Data-model changes:** `Preferences.sso`; `Secrets.sso_client_secret`;
`User` gains `oauth_provider`, `oauth_sub`, `groups[]` (additive).

**Settings added:** the entire `sso` block (provider presets for Google/Microsoft +
generic).

**Tests:**
- `tests/test_oidc.py` — mock JWKS + token; validate signature/aud/iss/nonce/exp;
  domain/tenant allowlist; group→role mapping; auto-provision idempotence (no race
  dupes).

**Risks:** the only new backend dep — keep it lazy-imported and behind
`sso.enabled`. State/nonce must be single-use (CSRF/replay). Auto-provision race:
atomic create-if-not-exists. Never trust a client-supplied id_token; always do the
server-side code exchange + JWKS verify.

---

## F8 — Improved case STATUS taxonomy + disposition (replace NEEDS_HUMAN)

**Approach.** See `STATUS_TAXONOMY.md` for the full model + migration. Two-axis:
lifecycle `CaseStatus` (extended additively) + `Disposition`. `decide()` and its #3
truth table are **untouched**; new fields are populated in `apply()` and via analyst
lifecycle actions. `needs_human` retained as a deprecated alias.

**Backend files (change/add):**
- `backend/app/constants.py` — extend `CaseStatus` (NEW/INVESTIGATING/ESCALATED/
  ON_HOLD/RESOLVED added; OPEN/NEEDS_HUMAN/CLOSED retained); add `Disposition` enum.
- `backend/app/models.py Case` — add `disposition: Disposition | None = None`,
  `status_reason: str = ""`, `escalation_level: int = 0` (all additive/defaulted);
  optional `status_history: list[dict]`.
- `backend/app/engine/case_manager.py` — `apply()` sets `case.disposition` from
  the Verdict→Disposition map if unset, and maps the existing `Decision.escalate`
  to `CaseStatus.ESCALATED` **only in the non-close branch** (preserves the invariant
  assertion). `decide()` itself unchanged.
- `backend/app/api/routes.py` — extend `CaseAction.action` with `hold`, `resume`,
  `resolve`, `set_disposition`; transition guard (illegal moves → 400); audit each
  with `status_changed_from/to` + `status_reason`.
- `backend/app/engine/metrics.py` — add `by_disposition`; keep `by_status`.

**Frontend files (change/add):**
- `webui/src/soc/components/badges.tsx` — color tokens for new statuses; new
  `DispositionBadge`.
- `webui/src/soc/pages/Cases.tsx` — status + disposition facets/filters; lifecycle
  action menu (hold/resume/resolve/close/reopen/escalate) gated by `<Can>`.
- `webui/src/soc/pages/CaseDetail.tsx` — status timeline + disposition picker.
- `webui/src/soc/pages/Metrics.tsx` — disposition donut alongside verdict.
- `webui/src/lib/types.ts` — extend `Case` + `CaseStatus`/`Disposition` unions.

**New endpoints:** none new (extends `POST /api/cases/{id}/action`).

**Data-model changes:** `constants.py` (CaseStatus, Disposition); `models.py Case`
(disposition, status_reason, escalation_level, status_history).

**Settings added:** optional `Preferences.status_taxonomy` (custom status labels/
colors) — defer unless needed; the enum defaults suffice.

**Tests:**
- `tests/test_case_manager.py` (extend) — `decide()` truth table UNCHANGED;
  `apply()` populates disposition; ESCALATED only in non-close branch; NEEDS_HUMAN
  never CLOSED (invariant still raises).
- `tests/test_case_status_transitions.py` — legal/illegal transitions; stored
  old-enum cases load (`needs_human`/`open`/`closed`).
- `tests/test_metrics.py` (extend) — `by_disposition`.

**Risks:** the temptation to rewrite `decide()` into status+disposition — DON'T;
keep the pure truth table and layer the disposition on top (this is what keeps #3
provably intact and the migration zero-rewrite). Old cases without `disposition`
must render fine (default None → "Undetermined" in UI).

---

## F7 — Customizable case-ID nomenclature (live preview)

**Approach.** Keep `Case.case_id` as the immutable system id. Add a configurable,
human-facing `case_number` rendered from a template; default template keeps the
current look but supports `CASE-2026-000123`. Atomic sequence in the KV store, reset
bucket per period. Live preview in settings. No migration (old ids unchanged).

**Backend files (change/add):**
- `backend/app/engine/case_id.py` (new) — `render(template, ctx) -> str`
  (placeholders `{prefix}`, `{sep}`, `{year}`, `{yy}`, `{mm}`, `{seq:0Nd}`,
  `{source}`, `{verdict}`); `validate_template(template)`.
- `backend/app/stores/base.py` / `stores/memory.py`-style — a tiny `SequenceStore`
  over `KVStore` (namespace `case_seq`, key per `{prefix}:{reset_bucket}`), atomic
  increment via read-modify-write (low volume) or Redis `INCR` when available.
- `backend/app/engine/case_manager.py` / `agents/pipeline.py` — at case creation,
  if `prefs.case_id_format.enabled`, set `case.case_number` from the template +
  next seq. `case_id` still `new_id('case-')`.
- `backend/app/models.py Case` — add `case_number: str = ""` (additive).
- `backend/app/api/routes.py` — `POST /api/settings/case-id/preview` (render N
  sample numbers from a candidate template without persisting).

**Frontend files (change/add):**
- `webui/src/soc/pages/admin/CaseIdSettings.tsx` (new, under Settings) — template
  editor + placeholder picker + live preview (calls the preview endpoint).
- `webui/src/soc/pages/Cases.tsx` / `CaseDetail.tsx` — display `case_number` when
  set, fall back to `case_id`.
- `webui/src/lib/types.ts` — `Case.case_number`, `CaseIdFormatConfig`.

**New endpoints:** `POST /api/settings/case-id/preview` (admin).

**Data-model changes:**
- `config.py Preferences` — `case_id_format: CaseIdFormatConfig`
  (`enabled=False`, `template="CASE-{year}-{seq:06d}"`, `reset_period`
  ∈ none/calendar_year/fiscal_year/fiscal_quarter, `seq_start=1`).
- `models.py Case` — `case_number`.
- KV: `case_seq` namespace.

**Settings added:** `case_id_format.*` (template, reset period, preview).

**Tests:**
- `tests/test_case_id.py` — template render/validate; sequence increments
  atomically; period reset bucket; legacy (disabled) keeps `case_id` look;
  uniqueness within a period bucket.

**Risks:** sequence atomicity under concurrent creation — KV read-modify-write is
not transactional; for ES/SQL prefer a store-level upsert/`INCR` (Redis) or accept
that the poller is effectively single-threaded for case creation. Template injection
— restrict placeholders to a known set; reject `{...}` not in the allowlist.

---

## F5 — Email alerting + pluggable NotificationChannel abstraction

**Approach.** Pluggable `NotificationChannel` ABC (email first; Slack/Teams/
PagerDuty/Telegram/webhook as later channels via the same interface). SMTP with
top-10 provider presets + custom. Per-condition triggers (case created/verdict-
change/escalation/close), dedup + rate-limit + digest, Jinja-lite templating.
Fire-and-forget async; never blocks case ops; audited.

**Backend files (change/add):**
- `backend/app/notifications/channel.py` (new) — `NotificationChannel` ABC
  (`async send(event: NotificationEvent) -> NotificationResult`), `NotificationEvent`
  (case_id, severity, title, entity, rule_name, risk_score, verdict, disposition,
  case_url, trigger), channel factory/registry.
- `backend/app/notifications/email.py` (new) — `EmailChannel` over `aiosmtplib`
  (async) with provider presets (host/port/encryption/auth from `RESEARCH §6`);
  STARTTLS/SSL/2525; OAuth2 XOAUTH2 hook for Gmail/M365 (env token).
- `backend/app/notifications/templates.py` (new) — Jinja2 (or stdlib `str.format`)
  render; HTML + plain text; fence untrusted log values as plain text (#9).
- `backend/app/notifications/dispatch.py` (new) — `NotificationService`: dedup
  (`KVStore`/Redis hash of `(rule_id, entity, time_bucket)`, TTL=window), per-
  recipient rate-limit, exponential backoff, digest batching, async dispatch.
- `backend/app/engine/case_manager.py` / `agents/pipeline.py` — AFTER `apply()` (and
  after save), fire `notify_async(case, trigger)` when triggers match. **Never inside
  `decide()`.**
- `backend/app/api/routes.py` — notification config test/send routes (below).
- `backend/app/constants.py` — `ActionType.NOTIFICATION` (audit each send).

**Frontend files (change/add):**
- `webui/src/soc/pages/admin/Notifications.tsx` (new, under Settings) — SMTP form
  (provider preset dropdown + custom), recipients, per-condition triggers, digest
  schedule, template editor, "Send test" button. Channel list (email enabled now;
  others "coming soon" disabled).
- `webui/src/soc/pages/CaseDetail.tsx` — "Notify" action (manual send, gated).
- `webui/src/lib/types.ts` — `NotificationConfig`, channel types.

**New endpoints:**
- `PUT /api/settings` carries `notifications` config (deep-merge).
- `POST /api/notifications/test` (admin) — send a test to a recipient.
- `POST /api/cases/{id}/notify` (analyst) — manual send.

**Data-model changes:**
- `config.py Preferences` — `notifications: NotificationConfig` (`enabled`,
  `channels: list[ChannelConfig]` with `type`, `provider`, host/port/encryption,
  `from_addr`, `recipients[]`, `triggers` {on_create, on_verdict_change,
  on_escalate, on_close}, `immediate_severity_threshold`, `digest_window_seconds`,
  `dedup_window_seconds`, `rate_limit_per_recipient_per_day`, `templates`).
- `config.py Secrets` — `smtp_password` (+ per-channel secrets in
  `connector_secrets`-style tier, env/in-memory only).
- `models.py Case` — optional `notifications_sent: list[dict]` (additive audit).
- `constants.py` — `ActionType.NOTIFICATION`.

**Settings added:** the `notifications` block.

**Tests:**
- `tests/test_notifications.py` — provider preset resolution; dedup within window;
  rate-limit; digest batching; trigger matching by severity/verdict; secrets never
  echoed; send failure does not break case flow; `aiosmtplib` mocked.

**Risks:** new dep `aiosmtplib` (async) — or use stdlib `smtplib` via
`asyncio.to_thread` to avoid the dep. SMTP creds in the secret tier (never
Preferences). Dedup/rate-limit state best in Redis for multi-node; in-memory
fallback is single-node only. Email content must fence untrusted log fields (#9).

---

## F6 — Multi-source telemetry + Auto-Correlate toggle (per source AND per sub-source)

**Approach.** Two-tier correlation (RESEARCH §7). Per-`SourceInstance` and
per-IndexPattern (the `events`/`alerts` "sub-source") auto-correlate toggle gates
whether a source's clusters auto-forward / participate in cross-source grouping.
Optional cross-source pass groups clusters by shared entity within a window;
surfaced as RELATED cases (no forced merge — 1:1 cluster→case preserved).

**Backend files (change/add):**
- `backend/app/engine/correlation.py` — add `cross_source_correlate(clusters, prefs)`
  (second pass; entity+time-bucket grouping; source-agnostic signature). Honor the
  per-source/sub-source toggle.
- `backend/app/engine/signatures.py` — `cross_source_signature(entity_type, value,
  ts, window)` (NOT rule-based).
- `backend/app/engine/ingest.py handle_clusters` — read
  `SourceInstance.config['auto_correlate_enabled']` (default True) and the
  IndexPattern-role toggle; skip auto-forward when disabled (route to candidates);
  call the cross-source pass after per-source correlation when
  `prefs.cross_source_correlation.enabled`.
- `backend/app/config.py SourceInstance` — `index_patterns()` already carries role;
  add per-pattern `auto_correlate` in config (sub-source toggle).
- `backend/app/models.py` — `Cluster.source_ids: list[str]`,
  `Cluster.cross_source_cluster_id`, `Case.related_case_ids`,
  `Case.cross_source_cluster_id`, `Case.source_breakdown` (all additive).
- `backend/app/constants.py` — extend `EntityType` with `FILE_HASH`, `DOMAIN`
  (optional, for richer cross-source keys).

**Frontend files (change/add):**
- `webui/src/soc/components/SourceEditor.tsx` — per-source "Auto-correlate" switch +
  per-index-pattern (sub-source) toggle in `IndexPatternsEditor`.
- `webui/src/soc/pages/CaseDetail.tsx` — "Sources" pill + source breakdown card +
  "Related cases" facet (cross-source group).
- `webui/src/soc/pages/Cases.tsx` — "Show related only" + multi-source filter
  (already supports source filter; extend).
- `webui/src/lib/types.ts` — `SourceConfigExtras.auto_correlate`, cross-source Case
  fields.

**New endpoints:** none required (rides `POST /sources` config + `GET /cases`).
Optional `POST /api/correlate/run` (manual cross-source pass).

**Data-model changes:**
- `config.py Preferences` — `cross_source_correlation: CrossSourceCorrelationConfig`
  (`enabled=False`, `time_window_seconds=300`, `min_sources_to_cluster=2`,
  `entity_keys`, `source_weighting`, `per_entity_type_windows`).
- `config.py SourceInstance.config` — `auto_correlate_enabled` (source),
  per-pattern `auto_correlate` (sub-source).
- `models.py Cluster`/`Case` — cross-source fields.

**Settings added:** `cross_source_correlation.*`; per-source/sub-source toggles in
the source editor.

**Tests:**
- `tests/test_correlation.py` (extend) — cross-source by shared IP; ignores
  different entities; respects window + `min_sources`; disabled-by-default;
  per-source toggle suppresses auto-forward; sub-source (alerts vs events) toggle.
- signature test: cross-source signature is source-agnostic + idempotent.

**Risks:** cross-source can over-cluster (blast radius) — keep it opt-in, gated by
`min_sources_to_cluster` + per-source toggle, and surface as RELATED (no merge) so
signatures/audit stay 1:1. Burst windows can fragment — document the bucket math.

---

## F9 — Ingestion customization per source + contextual help per connector

**Approach.** Per-source field-mapping overrides + parsing hints in
`SourceInstance.config` (already free-form). Extend `AuthField` with `help_link` +
`help_code` so each connector ships per-field setup help (tooltip/popover) with zero
per-connector frontend code. Empty-state + a (?) affordance everywhere.

**Backend files (change/add):**
- `backend/app/connectors/base.py` — `AuthField` gains `help_link: str | None`,
  `help_code: str | None`, `help_code_language: str = "yaml"` (additive).
- All connector manifests (`connectors/elastic.py`, `wazuh.py`, `opensearch.py`,
  receivers) — populate `help`/`help_link`/`help_code` for required auth fields.
- `backend/app/models.py RawEvent.from_hit` / `connectors/elastic.py _effective_prefs`
  — honor `SourceInstance.config['field_mappings_extra']` overrides.
- `backend/app/api/routes.py` — optional `POST /api/sources/{id}/analyze-sample`
  (suggest field mappings from a pasted sample record).

**Frontend files (change/add):**
- `webui/src/soc/components/HelpTip.tsx` (new) — Tooltip/Popover auto-detect
  (`>60 chars || link || code → popover`), `HelpCircle` button + `aria-label`
  (uses existing Radix `ui/tooltip.tsx`/`ui/popover.tsx`).
- `webui/src/soc/components/SourceEditor.tsx` — replace the plain `help` `<p>` with
  `<HelpTip>`/`<ConnectorFieldHelp field={f}>`; add an "Advanced field mapping"
  collapsible.
- `webui/src/soc/components/ConnectorPicker.tsx` — `<CategoryHelp category>` on
  section headers.
- `webui/src/soc/pages/Sources.tsx` — empty-state with Plug icon + "Connect your
  first source" CTA.
- `webui/src/lib/types.ts` — extend `AuthField`; `SourceConfigExtras.field_mappings_extra`.

**New endpoints:** optional `POST /api/sources/{id}/analyze-sample`.

**Data-model changes:** `connectors/base.py AuthField` (+help_link/help_code);
`SourceInstance.config['field_mappings_extra']` (no schema — connector owns shape).

**Settings added:** per-source field-mapping editor + parsing hints in the source
wizard (no global Preferences key).

**Tests:**
- `tests/test_connector_help.py` — manifests expose help fields; `GET
  /connectors/{type}` returns them.
- `tests/test_ingest_field_overrides.py` — per-source `field_mappings_extra` applied
  in `from_hit`; falls back to global prefs.

**Risks:** sample records may contain PII — sanitize before storing; never persist a
sample to the config index. Unknown `AuthField.type` already falls back to text
input — keep that graceful.

---

## F10 — Run-a-playbook action + threshold-based playbook automation

**Approach.** A playbook RUN is a CONTEXT-ONLY action: re-investigate the case with
the chosen playbook injected (recommend-only, #3-safe). Threshold automation matches
a case AFTER `decide()` and may TAG / set a RECOMMENDATION / request approval / send
a notification / queue a playbook run — but it calls `decide()` again with new
inputs; it NEVER sets status directly. NEEDS_HUMAN never auto-closes.

**Backend files (change/add):**
- `backend/app/engine/threshold_automation.py` (new) — `evaluate(case, prefs) ->
  list[AutomationAction]`; rules in priority order; conditions on verdict/risk/
  severity/entity_type/rule/source.
- `backend/app/agents/pipeline.py` — after `CaseManager.apply()` + save: run
  threshold automation; execute SAFE actions (tag/recommend/notify/queue-playbook-
  run); REQUIRES_APPROVAL actions become HITL `Proposal`s (existing proposer/approve
  path); audit each (`ActionType.DECISION` / `PROPOSAL`).
- `backend/app/playbooks/registry.py` — already deterministic select; add
  `run(case_id, playbook_id)` = reinvestigate with the playbook forced as context.
- `backend/app/api/routes.py` — `POST /api/cases/{id}/run-playbook` (manual run);
  automation rules ride `PUT /api/settings`.
- `backend/app/engine/case_manager.py` — UNCHANGED (`decide()` stays pure).

**Frontend files (change/add):**
- `webui/src/soc/pages/CaseDetail.tsx` — "Run playbook" action (pick from catalog),
  shows the resulting re-investigation; "Automation matched" markers.
- `webui/src/soc/pages/Catalog.tsx` — show playbook automation rules + triggers.
- `webui/src/soc/pages/admin/Automation.tsx` (new, under Settings) — threshold rule
  editor (condition → action), priority order, live "would-match" preview.
- `webui/src/lib/types.ts` — automation rule + action types.

**New endpoints:** `POST /api/cases/{id}/run-playbook` (analyst+); automation config
via `PUT /api/settings`.

**Data-model changes:**
- `config.py PlaybookConfig` — add `automation: list[AutomationRule]`
  (`id`, `enabled`, `conditions`, `action` ∈ tag/recommend/notify/run_playbook/
  request_approval, `payload`, `priority`).
- `config.py Preferences` — `threshold_automation: ThresholdAutomationConfig`
  (`enabled=False`, `rules[]`).
- `models.py Case` — `automation_actions: list[dict]` (audit trail; additive).

**Settings added:** `playbooks.automation` / `threshold_automation.rules`.

**Tests:**
- `tests/test_threshold_automation.py` — rules match in priority order; SAFE actions
  apply; REQUIRES_APPROVAL → proposal (no live write); `decide()` NOT bypassed (a
  re-run calls `decide()` again); NEEDS_HUMAN never auto-closed; disabled-by-default.
- `tests/test_playbook_run.py` — manual run re-investigates with the playbook
  injected; deterministic selection unchanged.

**Risks:** the central #3 risk — automation must NEVER set `case.status` directly;
it calls `decide()` with new inputs OR records an analyst-attributed action. CI test
asserts `decide()` is the only producer of CLOSED/auto-close. Write actions
(suppress/block) MUST route through the HITL `Proposal`/approve path (ToolTier
REQUIRES_APPROVAL), never auto-execute.

---

## F11 — Threat-context case panel + reusable-knowledge accumulation loop

**Approach.** Assemble a threat-context object on case load (verdict anchor → IOC
reputation → MITRE techniques → related cases → asset → threat actor → evidence),
parallel-fetched with fail-open. MITRE technique metadata from a bundled
enterprise-attack JSON (cached). Reusable-knowledge loop: on CLOSE, auto-chunk the
case into RAG (`source='resolved_case'`) so future investigations retrieve "we've
seen this before"; threat-intel docs ingested as `source='threat_context'`, injected
as a TRUSTED block.

**Backend files (change/add):**
- `backend/app/engine/threat_context.py` (new) — `assemble(case, prefs) ->
  ThreatContextPanel` (parallel: enrichment, MITRE lookup, related cases, asset
  risk); fail-open per section.
- `backend/app/engine/mitre.py` (new) — load/cache bundled enterprise-attack JSON;
  `technique(id) -> {id, name, tactics, platforms, sub_techniques}`.
- `backend/app/runbooks/` or `backend/app/threat/` — bundled MITRE STIX/JSON corpus.
- `backend/app/tools/rag.py RagService` — add `index_resolved_case(case)` (called on
  CLOSE); new seed/source `threat_context`; retrieval filtered by source for the
  investigator's TRUSTED block.
- `backend/app/engine/case_manager.py apply()` — on transition to CLOSED, fire
  `rag.index_resolved_case(case)` (best-effort, never blocks).
- `backend/app/api/routes.py` — `GET /api/cases/{id}/threat-context`;
  `POST /api/threat-context/import` (admin) to ingest threat-intel docs into RAG.
- `backend/app/constants.py` — `ActionType` reuse `CONTEXT`; optional
  `ThreatActorType` enum.

**Frontend files (change/add):**
- `webui/src/soc/pages/CaseDetail.tsx` — "Threat Context" tab (panels in the
  research-recommended order; all untrusted text plain/`CodeBlock`).
- `webui/src/soc/pages/Knowledge.tsx` — "Threat Contexts" + "Resolved cases"
  sections; import threat-intel; tag/search.
- `webui/src/lib/types.ts` — `ThreatContextPanel`, MITRE technique, threat-context
  RagDocument.

**New endpoints:** `GET /api/cases/{id}/threat-context`;
`POST /api/threat-context/import` (admin).

**Data-model changes:**
- `config.py Preferences` — `threat_context: ThreatContextConfig` (`enabled`,
  `mitre_enabled`, `reuse_resolved_cases`, `ioc_malicious_threshold=50`).
- `config.py RagConfig` — `use_threat_context: bool`, `use_resolved_cases` (exists).
- `models.py Case` — optional `threat_context_applied: list[dict]`,
  `knowledge_used: list[dict]` (additive).

**Settings added:** `threat_context.*` (enable, MITRE, reuse, thresholds).

**Tests:**
- `tests/test_threat_context.py` — panel assembly fail-open (missing enrichment
  doesn't blank it); MITRE lookup from bundled JSON; threshold maps reputation →
  is_malicious.
- `tests/test_resolved_case_loop.py` — close → resolved_case chunk indexed; future
  retrieval surfaces it; injected as TRUSTED (fenced) block.

**Risks:** threat-actor inference is LLM/RAG-derived — only display above a
confidence bar, never assert. Threat-intel docs are UNTRUSTED corpus content — keep
the TRUSTED-block injection fenced and clearly labeled (#9). MITRE JSON freshness —
document the quarterly refresh.

---

## F12 — Full Settings menu incorporating ALL of the above

**Approach.** No new backend mechanism — everything rides `GET/PUT /api/settings`
(deep-merge + validate). Restructure the webui Settings into sections, split a
new admin-only "Administration" area (Users, RBAC, SSO, audit), and bind each
section to its Preferences subtree (or the relevant store for Users).

**Backend files (change/add):**
- `backend/app/api/routes.py` — optional sectioned `GET /api/settings/{section}` for
  large subtrees (otherwise the full dump is fine); ensure every new Preferences
  block (rbac, mfa, sso, notifications, case_id_format, cross_source_correlation,
  threat_context, playbooks.automation) is in the model so PUT round-trips.
- `backend/app/config.py` — all the new nested models referenced by F1–F11.

**Frontend files (change/add):**
- `webui/src/soc/pages/Settings.tsx` — tabbed/sidebar sections: Data Sources,
  Models & LLM, Correlation & Cases (+ Case-ID format), Automation (playbooks +
  thresholds + cross-source), Notifications, Security (RBAC/MFA/SSO/rate-limits),
  Knowledge & Threat Context, Enrichment, Appearance (branding), Advanced (caps,
  read-only mode).
- `webui/src/soc/pages/admin/` — Users, SSO, Notifications, Automation, CaseIdSettings
  (new pages from F1–F10), all gated by `<Can>`/role.
- `webui/src/soc/nav.ts` — add an "Administration" group (admin-only).
- `webui/src/soc/components/HelpTip.tsx` — reused per setting.

**New endpoints:** optional `GET /api/settings/{section}`; `GET /api/settings/schema`
(for form generation) — optional.

**Data-model changes:** none beyond the nested Preferences models added in F1–F11.

**Settings added:** consolidates ALL feature settings; adds a "read-only settings
mode" panic toggle surface (already in Preferences).

**Tests:**
- `tests/test_settings_roundtrip.py` — every new nested block PUTs and re-GETs
  unchanged; partial deep-merge doesn't wipe siblings; `read_only_settings_mode`
  rejects writes except the unlock.

**Risks:** settings sprawl — keep validation centralized in `Preferences.model_validate`
and return field-level errors. Cache invalidation on save (AppState caches prefs) —
refresh after PUT (already done in `update_prefs`).

---

## F13 — UI cleanup (RiskGauge fix, case-detail alignment, loading)

**Approach.** Fix the diagnosed RiskGauge glitch, tidy case-detail alignment, add
professional loading (skeletons + shimmer + stagger, reduced-motion-safe). No
backend changes.

**RiskGauge fix (the map's diagnosis):**
`webui/src/soc/components/RiskGauge.tsx` is needle-less by design (muted track +
severity arc, 180°→0°). At small `size` the stroke (`round(size*0.07)`) is too thick
vs. the radius, so the arc clips/overlaps and reads as broken. **Fix:** clamp stroke
to `Math.min(10, Math.round(size*0.05))` (or enforce min `size=140`); verify the
`arc()` path command and the centered-value offset (`cy - r*0.52`); confirm the
`stroke-{low|medium|high|critical}` tokens resolve (theme.css + tailwind). Verify the
Overview "Active Risk Index" (`riskIndex = avg_risk*0.7 + criticalDensity*100*0.3`)
renders 0..100 with the corrected gauge.

**Frontend files (change):**
- `webui/src/soc/components/RiskGauge.tsx` — stroke clamp + path/offset verify.
- `webui/src/soc/pages/CaseDetail.tsx` — alignment (8px grid; KPI strip; tabs;
  right-side panel) per RESEARCH §8.
- `webui/src/soc/components/LoadingBar.tsx`, `Stagger.tsx` — ensure
  `motion-safe`/`motion-reduce` variants; shimmer 1.5–2.5s; stagger 0.1s.
- `webui/src/styles/theme.css` / `tailwind.config.js` — confirm severity tokens +
  `animate-pulse`/shimmer keyframes; WCAG AA contrast pass.
- skeletons: add `SkeletonCard` usage on Cases/Overview/Metrics initial loads.

**New endpoints:** none.

**Data-model changes:** none.

**Settings added:** none (theme already in `branding`).

**Tests:**
- webui build (`tsc --noEmit && vite build`) is the static check.
- optional Vitest: RiskGauge renders valid SVG path at size=100 and 200 (no NaN,
  arc within viewBox); reduced-motion disables animation.

**Risks:** dark-mode contrast regressions — validate WCAG AA after token changes.
Don't add npm deps. Keep all attacker-influenceable text plain/`CodeBlock` (#9).
