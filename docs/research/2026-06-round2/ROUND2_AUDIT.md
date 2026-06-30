# Round 2 Adversarial Audit — Consolidated Findings

> **New here? Start with [`docs/HANDOFF.md`](../../HANDOFF.md).** It is the
> authoritative onboarding doc (current state, demo, build/test baselines). This file
> is the audit ledger that doc points to for the Round-2 finding-by-finding record.

## Status summary (resolved 2026-06-30)

All CONFIRM-FIX findings and every HIGH/MEDIUM REVIEW finding are **RESOLVED** —
**18 resolved / 6 deferred**.

- **8 mechanical fixes** landed in **`aae7a76`** (the 8 RBAC/poller/gauge fixes
  below).
- **10 HIGH/MEDIUM remediations** landed in **`763ded9`** (+22 regression tests):
  #4 broad-feed cursor starvation, demo-chat isolation (+ store-layer write-guard),
  env single-admin `token_version` lockout, `set_status → RESOLVED` RBAC, email
  `text_safe`/`{{{var}}}`/branding-SVG hardening, and the strengthened authZ-coverage
  CI test (now fails if any non-GET `/api` route lacks an authZ gate).
- **6 remain DEFERRED** (low-severity / speculative / cosmetic-with-judgment, no
  concrete exploit): session-KV optimistic concurrency, multi-generation
  refresh-reuse, per-feed `severity_floor` units, branding SVG-validator parity,
  shared `CONFIG_INDEX` nested-type collision (ES-only), and the deep-link
  breadcrumb host mapping. Tracked here + (for Tier 2/3 features) in
  [`ROUND2_BEST_OF_BEST.md`](ROUND2_BEST_OF_BEST.md).

Green baseline at close: **794 backend pytest** pass, **86 vitest** pass (19 files),
**webui build clean** (tsc+vite), eslint **0 react-hooks/rules-of-hooks errors**,
`engine/case_manager.py` **byte-identical**, **zero new runtime deps**.

---

> Triage-lead consolidation of the Round-2 adversarial audit. Each finding below
> was re-verified against the live tree (`backend/app/...`, `webui/src/soc/...`) at
> the file:line cited. Original triage dispositions (now superseded by the
> per-finding **Resolution** lines):
> - **CONFIRM-FIX** — real bug / invariant or authZ violation, clear evidence, and a
>   low-risk *mechanical* fix that cannot regress the default profile.
> - **REVIEW** — real or likely, but the fix is architectural / touches security-
>   critical or correctness-critical logic / could break existing config →
>   human review before changing.
> - **REVIEW (cosmetic)** — confirmed but purely visual/UX, no security/data impact.
>
> NOTE on RBAC findings: every authZ gap below is reachable ONLY with **auth ON +
> RBAC ON** (not the default no-auth profile). `require_permission`/`_enforce` is a
> verified no-op when auth is disabled, so adding a gate never changes the default
> deployment and never breaks the offline test suite (which runs auth-off).

---

## Area: RBAC coverage of state-changing routes

### CRITICAL — `PUT /api/settings` is not permission-gated (full RBAC bypass)
- **Disposition: CONFIRM-FIX.** **RESOLVED (`aae7a76`)** — `require_permission("settings","manage")` added.
- Evidence verified: `routes.py:580-595 put_settings` carries only the global
  `require_auth` (`main.py:63`) + a `read_only_settings_mode` flag check. It
  `_deep_update`s the arbitrary body into the FULL `Preferences` (incl. `rbac`,
  `session_policy`, `caps.kill_switch`, `auto_close`). Every *sibling* settings
  route is gated `require_permission("settings","manage")` (`routes.py:608, 4226,
  4272, 4296`); this one is the outlier. `policy.py:72-82` grants tier1/auditor
  `settings:["read"]` only.
- Impact: a low-privilege authenticated user can disable RBAC, flip `kill_switch`,
  or rewrite the `auto_close` policy (#3 governance surface) platform-wide.
- Fix (mechanical): add `_=Depends(require_permission("settings","manage"))` to
  `put_settings`, matching the four sibling routes. (Two audit entries — RBAC area
  + customization area — describe this same root cause; consolidated here.)

### HIGH — `PUT /api/branding` writes org-wide branding with no gate
- **Disposition: CONFIRM-FIX.** **RESOLVED (`aae7a76`)** — `require_admin` added, matching `/prefs/org` + `/terminology`.
- Evidence: `routes.py:1203-1210 branding_put` has only `require_auth` +
  read-only-flag. Sibling org writers `PUT /api/prefs/org` (`routes.py:1316`) and
  `PUT /api/terminology` (`routes.py:1345`) DO carry `require_admin`.
- Fix: add `_admin=Depends(require_admin)` to `branding_put` (org-default surface),
  matching `/prefs/org` + `/terminology`. (Alternatively `require_permission(
  "settings","manage")`.)

### HIGH — RAG mutators `/api/rag/import` + `DELETE /api/rag/documents/{id}` not gated by `rag:manage`
- **Disposition: CONFIRM-FIX.** **RESOLVED (`aae7a76`)** — `require_permission("rag","manage")` added to both.
- Evidence: `routes.py:834 rag_import` and `routes.py:851 rag_delete_document` carry
  no permission dep. The grant is modeled (`policy.py:35 rag:["read","manage"]`) and
  IS enforced on the parallel writer `/api/threat-context/import`
  (`routes.py:3671 require_permission("rag","manage")`). RAG content is retrieved
  into LLM investigation prompts → integrity + #9-adjacent prompt-influence vector.
- Fix: add `_=Depends(require_permission("rag","manage"))` to both, matching
  `threat_context_import`.

### HIGH — Operator MEMORY writes (`POST/PUT/DELETE /api/memory`) enforce no permission
- **Disposition: CONFIRM-FIX.** **RESOLVED (`aae7a76`)** — `require_permission("memory","manage")` added to all three writers.
- Evidence: `routes.py:922 add_memory`, `:935 update_memory`, `:946 delete_memory`
  carry only `require_auth`. `require_permission("memory"...)` appears NOWHERE in
  `routes.py` (grep-confirmed) → the modeled `memory:["read","manage"]`
  (`policy.py:36`) grant is dead/unenforced. Memory is auto-injected as a TRUSTED
  `<<<MEMORY>>>` block into every investigation + chat → a low-priv user can plant
  trusted instructions steering future LLM investigations.
- Fix: add `_=Depends(require_permission("memory","manage"))` to all three writers.

### MEDIUM — `POST /api/playbooks/reload` has no permission gate
- **Disposition: CONFIRM-FIX.** **RESOLVED (`aae7a76`)** — `require_permission("settings","manage")` added.
- Evidence: `routes.py:1088-1092 playbooks_reload` carries only `require_auth`; it
  hot-swaps the live deterministic playbook set. `playbooks:run` IS enforced on
  `/run-playbook` (`routes.py:3597`).
- Fix: add `_=Depends(require_permission("settings","manage"))` (reload is a
  config/admin action). Lower severity (#3: a playbook can only RECOMMEND).

### MEDIUM — Case collaboration writes (comment/tags/assign) bypass RBAC
- **Disposition: CONFIRM-FIX.** **RESOLVED (`aae7a76`)** — `request` param + inline `_enforce` added, mirroring `case_action`.
- Evidence: `routes.py:3360 case_comment`, `:3379 case_tags`, `:3402 case_assign`
  have no `request` param and no `_enforce` — unlike `case_action`
  (`routes.py:3068-3072` inline `_enforce`). `policy.py:99 _AUDITOR` is granted
  `cases:["read"]` only, yet a read-only auditor can comment / overwrite tags /
  reassign.
- Fix: add `request: Request = None` param + inline
  `await _enforce(request, "cases", "comment"/"write"/"assign")` when
  `request is not None`, mirroring `case_action` (which uses `request: Request =
  None` and guards `if request is not None`). Resolve actor from the principal.

### MEDIUM — Route-auth-coverage CI test proves authN only (false confidence)
- **Disposition: REVIEW.** **RESOLVED (`763ded9`)** — `test_route_auth_coverage.py`
  now asserts that **every non-GET `/api` route declares an authZ gate**
  (`require_permission`/`require_role`/`require_admin`/`require_fresh_auth`) OR is in
  a small reviewed `_AUTHZ_EXEMPT` allowlist (capped, every entry must map to a real
  registered route). The test fails CI if any state-changer slips the gate — the
  curated regression guard the original triage recommended.
- Evidence: `test_route_auth_coverage.py:33-49` asserts only `require_auth`
  (auto-satisfied by the global mount); `:167-188` asserts `require_admin` on
  exactly two routes. No assertion that state-changers carry an authZ gate.
- Why REVIEW not CONFIRM: the right fix is an *allowlist-driven* assertion (for
  every non-GET `/api` route, require an explicit authZ dep OR membership in a
  reviewed self-service set). Building and curating that allowlist is a judgment
  exercise (which routes are legitimately self-service / inline-enforced), not a
  mechanical edit. Recommended as the regression-guard once the gates above land.

---

## Area: Slice #3 / bulk actions — close/escalate invariant

### HIGH — `set_status → RESOLVED` reaches a terminal status with only `cases:write` (single + bulk)
- **Disposition: REVIEW.** **RESOLVED (`763ded9`)** — reaching the terminal RESOLVED
  status now requires the `cases:close` grant on both the single and bulk paths
  (transition/grant made target-aware), with a new RBAC regression test.
  `case_manager.decide()` is untouched (this was always the HUMAN path; #3 byte-identical).
- Evidence verified: `routes.py:3020 _CLOSE_ACTIONS = {close,confirm_fp,resolve,
  reopen}`; `_case_action_grant` (`:3047-3051`) returns `"close"` only for those, so
  `set_status` → `"write"`. `_guard_transition` (`:3027-3044`) blocks `set_status`→
  CLOSED but NOT `set_status`→RESOLVED, though `_TERMINAL = {CLOSED, RESOLVED}`
  (`:3024`). `policy.py:72-73` tier1 lacks `cases:close`. Bulk
  (`cases_bulk_action`, shares `_case_action_grant`) amplifies to ≤500 cases/call.
  This is the HUMAN analyst path — it does NOT touch `case_manager.decide()`, so #3
  is intact; it is an RBAC/authZ defect.
- Why REVIEW not CONFIRM: the fix changes lifecycle transition / grant semantics
  (either block `set_status`→RESOLVED in `_guard_transition`, forcing the `resolve`
  action, and/or make `_case_action_grant`/the endpoints target-aware on
  `body.status`). This touches close-axis correctness shared by single + bulk paths
  and warrants a deliberate decision (block-the-transition vs require-the-grant) plus
  a new RBAC test. Real bug, but not a no-regret one-liner.

---

## Area: Demo isolation & reversibility (Wave 5)

### HIGH — Chat during demo mode bypasses demo isolation ($0 broken, real audit writes, demo cases invisible)
- **Disposition: REVIEW.** **RESOLVED (`763ded9`)** — chat is now demo-bound: in demo
  mode the chat engine routes through the throwaway demo audit/usage/case stores and
  the deterministic mock gateway, so a chat turn writes no real audit/usage rows and
  sees demo cases. New test drives a chat turn under demo and asserts the real
  `_real_audit`/`_real_usage` are unchanged.
- Evidence verified: `state.py:172-175` builds `self.chat_engine = ChatEngine(es,
  self.gateway, self._real_audit, self._real_cases, ...)` with the REAL
  gateway/audit/cases. `chat_engine` is NOT among the demo-switchable active-store
  properties (`state.py:88-114`) and is never rebuilt for demo. `/chat`
  (`routes.py:665`) calls `state.chat_engine.chat(...)` directly; `chat.py:108/147`
  call `self._audit.record` (=`_real_audit`) and `chat.py:237` reads `self._cases`
  (=`_real_cases`). `disable_demo`/`purge` cannot remove rows already written to
  `_real_audit`.
- Why REVIEW not CONFIRM: a correct fix is architectural — add a demo-bound
  `chat_engine` to `DemoStack` + a switchable `chat_engine` @property on `AppState`
  (rename the wired one `_real_chat_engine`), or build a per-request demo-bound
  engine. Touches the demo isolation contract and request path; needs a new test
  driving a chat turn in demo mode asserting `_real_audit/_real_usage` unchanged.
  Real high-impact bug, but not low-risk mechanical.

### LOW — Write-guard is advisory (one seed site), not enforced at the store layer
- **Disposition: REVIEW.** **RESOLVED (`763ded9`)** — folded into the demo-chat fix;
  the write-guard now asserts on the demo store write path (belt-and-braces), so a
  real-tagged row can never reach the demo store or vice-versa.
- Evidence verified: `state.py:912 _write_guard` is called only at the seed loop
  (`state.py:815`). `_DemoCaseStore.save` (`demo_runtime.py:54-62`) only TAGS; never
  calls it. No concrete leak today (store instances are correctly separated).
- Why REVIEW: adding the assertion to the live write path could newly raise on a
  path that currently works; the finding itself notes no concrete leak. Belt-and-
  braces hardening — fold into the demo-chat fix above.

---

## Area: Sessions & token policy

### HIGH — Env single-admin permanently locks itself out after any `token_version` bump
- **Disposition: REVIEW.** **RESOLVED (`763ded9`)** — the `refresh_sessions` tv
  snapshot now unions `users.list()` with the AuthService base/env-admin usernames
  before `set_session_versions`, so an env-only admin is no longer left at tv=0 after
  a revoke-all / refresh-reuse bump. Covered by a new env-admin lockout test.
- Evidence verified: `state.py:430-455 refresh_sessions` builds the tv snapshot ONLY
  from `self.users.list()`; the env single-admin is NOT seeded into the UserStore
  (`state.py:388-389` skips when `env_admin`). A revoke-all / refresh-reuse bumps the
  persistent store tv to ≥1 while the rebuilt snapshot leaves the env-admin at 0 →
  fresh logins stamp tv=0 < current_tv → permanent `reauth_required`. Existing test
  uses the SEEDED admin, masking the env-admin path.
- Why REVIEW: the fix touches the security-critical token-minting/version path
  (union `users.list()` with AuthService base/env-admin usernames before
  `set_session_versions`), requires exposing base usernames from `AuthService`, and
  must be covered by a new env-admin test. Real high-severity bug; not a mechanical
  one-liner.

### LOW — Concurrent RMW on the single session KV doc can silently lose a revoke
- **Disposition: REVIEW → DEFERRED.** (`likely`) — needs optimistic concurrency / per-process
  lock on a security-critical path; design change. `stores/sessions.py` RMW is
  documented as accepted "at our scale". Human call on whether to harden.

### LOW — Refresh-token reuse detection only catches one rotation generation
- **Disposition: REVIEW → DEFERRED.** (`likely`) — `sessions.py` keeps a single
  `refresh_prev_hash`; a token stolen ≥2 rotations back is treated as `unknown`
  (plain 401) instead of triggering the theft/revoke-all path. Either document the
  single-generation window or move to a session-id chain. Design decision.

---

## Area: Email / template injection & secrets

### MEDIUM — `text_safe()` is dead code → untrusted vars inject raw newlines into the .txt body
- **Disposition: REVIEW.** **RESOLVED (`763ded9`)** — the text part now renders in a
  `text_mode` where `{{var}}` interpolation routes through `text_safe()`
  (`templates.py:175`), stripping CR/LF/tab/control chars and closing the body
  line-injection vector. Docstring corrected; regression test added.
- Evidence verified: `templates.py:98 text_safe()` is defined; grep shows it is
  NEVER called in `backend/app`. The text part renders via `{{var}}` →
  `html.escape` (`templates.py:181`), which does NOT strip `\r\n\t`; `_plain`
  preserves `\n/\t`. Body-content line-injection (forged `Status:`/`Bcc:` lines),
  NOT SMTP header injection (EmailMessage raises on `\r\n` in headers, caught by
  `send()`).
- Why REVIEW not CONFIRM: the fix changes how the text body renders (plumb a
  text-mode through `render_template` or pre-clean ctx scalars). Stripping newlines
  could alter legitimate multi-line summaries operators expect; needs a regression
  test + a docstring correction. Real gap (matches the code's own promise) but the
  fix is not no-regret. Document or fix deliberately.

### MEDIUM — Operator `{{{var}}}` override can emit attacker-influenced log text as RAW HTML
- **Disposition: REVIEW.** **RESOLVED (`763ded9`)** — the unescaped triple-mustache
  is now constrained to trusted, operator-authored presentation HTML and no longer a
  path for case-derived (untrusted) values; the docstring guarantee is restored and a
  regression test pins it. (also reported under the #9 area — same root cause).
- Evidence verified: `templates.py:164-167` emits `{{{name}}}` with no escaping;
  `_lookup` resolves ANY ctx key incl. untrusted-derived `title/entity/summary/
  rule/source_name`. `_TEMPLATE_VARS` (`:256-261`) includes those. The docstring
  (`:14-17, 142-144`) claims `{{{}}}` is "TRUSTED only" — false. Gated behind
  `settings:manage` (operator-authored), so operator-self-inflicted, but breaks the
  advertised guarantee.
- Why REVIEW not CONFIRM: the fix restricts triple-mustache to an allowlist of
  presentation tokens (`accent_color`, `logo_block`) OR adds a template validator —
  a deliberate boundary decision, and changing render semantics risks breaking
  existing operator templates. Pair with a docstring correction.

---

## Area: Source feeds back-compat & #4

### HIGH — Broad feed's per-feed cursor permanently STUCK when a full batch is owned by a narrower overlapping feed (#4 violation)
- **Disposition: REVIEW.** **RESOLVED (`763ded9`)** — the broad feed now advances its
  cursor over **all** fetched timestamps (not only the kept subset), so a page wholly
  owned by a narrower overlapping feed no longer freezes the broad feed's cursor; its
  own newer events are processed. Direct #4 repro added as a regression test.
- Evidence verified: `elastic.py:515-521 poll_feed` queries the feed's own pattern,
  then drops hits owned by a more-specific feed (`kept = [...]`, `_owns_index`).
  `poller.py:191-199` advances the cursor over only the KEPT batch; `advance_cursor`
  (`poller.py:36-39`) returns unchanged on an empty batch. A ≥`poll_batch_size`
  page entirely owned by a narrower feed → broad feed's cursor never advances → its
  own newer events are silently never processed. Direct #4 break in the documented
  IGNORE-carve-out config.
- Why REVIEW not CONFIRM: real #4 violation, but every candidate fix (query-time
  `must_not` on more-specific patterns, or advancing over ALL raw fetched
  timestamps) changes the query or the cursor-advance correctness plumbing — exactly
  the #4 surface. Needs a deliberate fix + the reproduction test. High-priority for
  human review.

### MEDIUM — One feed's failing operator `query_string` blocks polling of ALL feeds & freezes every cursor that cycle
- **Disposition: CONFIRM-FIX.**
- Evidence verified: `poller.py:131-138` iterates feeds calling `poll_feed` with NO
  per-feed try/except; cursor advance + persist happen only after the loop. A bad
  per-feed `query` (`elastic.py:533-544 _apply_feed_query`, appended verbatim) makes
  ES 400 and `poll_feed` raise; the exception escapes `poll_once` and is caught only
  at the loop level (`poller.py:229-232`) → the whole cycle is abandoned, no feed's
  cursor advances.
- Fix (mechanical, error-isolation only — cannot make things worse): wrap each
  feed's `poll_feed` call in `poller.py:132-138` in try/except (`logger.exception` +
  `continue`). A failed feed simply gets no `feed_state` entry, so its cursor is left
  untouched while healthy feeds proceed — mirrors the existing whole-loop shield.

### LOW — Per-feed `severity_floor` compares the raw source field, not OCSF `severity_id`
- **Disposition: REVIEW.** (`likely`) — `elastic.py:257-259` compares
  `ev.severity` (raw `severity_field`, pre-OCSF) against the 1-6 floor the
  design/UI advertise. Never drops events (#4 intact); confined to ineffective/
  surprising auto-forward gating on non-1-6 sources. Fix is normalize-to-OCSF or
  relabel the field — a semantics decision. Human review.

---

## Area: Secrets (#10) — new surfaces

### LOW — Branding logo/favicon validator permits SVG data-URLs (inconsistent with the SVG-rejecting avatar validator)
- **Disposition: REVIEW.**
- Evidence verified: `config.py:559-568 _check_logo` only checks the `data:image/`
  prefix + length; permits `data:image/svg+xml`. `models.py:473-508 validate_avatar`
  rejects SVG + magic-sniffs. Logo/favicon render via `<img src>`/`<link href>` (not
  `dangerouslySetInnerHTML`), route is admin-gated → no active exploit; defense-in-
  depth inconsistency only.
- Why REVIEW not CONFIRM: tightening `_check_logo` to mirror `validate_avatar` could
  reject an SVG logo an operator has ALREADY stored, breaking their branding on the
  next prefs validation. With no active exploit (passive render context), the small
  back-compat risk outweighs the defense-in-depth gain → human decision.

---

## Area: State-store back-compat (ES/SQL/fake parity)

### LOW — Shared dynamic `CONFIG_INDEX` for all KV docs; a nested-payload type collision is silently swallowed (ES-only)
- **Disposition: REVIEW.** (`speculative`) — `memory.py:51-92 EsKVStore` writes all
  KV namespaces into the dynamic `CONFIG_INDEX` (`indices.py:143-145`); a colliding
  nested type under `payload`/`prefs` raises `mapper_parsing_exception`, caught +
  only logged by `EsKVStore.put` → whole-doc silent loss on ES. SQL backend immune.
  No concrete colliding key found. Fix (explicit `enabled:false`/`dynamic:false`
  mapping or non-indexed blob, or surface the put failure) is an ES-mapping/storage
  change. Human review.

---

## Area: Webui — visual / nav correctness

### LOW — `RiskGauge` band thresholds diverge from the canonical `RiskBadge` bands (medium ≥33 vs ≥35, no info band)
- **Disposition: CONFIRM-FIX (cosmetic).** **RESOLVED (`aae7a76`)** — `RiskGauge` medium band moved `>= 33` → `>= 35`; comment corrected.
- Evidence verified: `RiskGauge.tsx:14` comment claims it "matches RiskBadge /
  Overview bands", but `:15-20 bandOf` uses `medium >= 33` and 4 bands. Canonical
  `badges.tsx:22-29` uses `medium >= 35`, `low >= 15`, `info < 15`; `Overview.tsx`
  uses `medium >= 35, low >= 15`. Scores 33-34 paint the gauge amber while the
  RiskBadge renders green — a same-page colour disagreement, and the comment is
  wrong.
- Fix (one line, no geometry/NaN impact): change `RiskGauge.tsx:18` from
  `if (score >= 33) return 'medium';` to `>= 35`. The `info`(<15) band is an
  intentional 4-band collapse for the gauge — leave it, and update the `:14` comment
  to state the gauge collapses info into low. Purely visual, isolated, no-regret.

### LOW — Deep-linking a folded sub-page shows breadcrumb "Overview" and highlights no rail item
- **Disposition: REVIEW (cosmetic).**
- Evidence verified: `AppShell.tsx:425-426` `current = navItem(page); pageLabel =
  current?.label ?? 'Overview'`. `navItem` (`nav.ts:189`) searches only NAV_ITEMS,
  so HIDDEN_ROUTE_IDS (cost/standup/investigate/knowledge/memory/catalog/account/
  sessions/security/users/admin_sessions) → undefined → breadcrumb "Overview", no
  active rail square. Page body is correct; purely a label/indicator issue.
- Why REVIEW not CONFIRM: the fix introduces a new `HOST_OF: Record<PageId,PageId>`
  mapping — each folded route's host is a per-route judgment that must be curated
  and kept in sync with the hidden-route list. Cosmetic, no urgency → human curates
  the map.

---

## Areas with no findings
- Account/profile validator & env-managed (`models.validate_avatar`) — clean.
- MFA QR scannability & clipboard — clean.
- Hooks ordering (#310) across consolidated pages — clean.

---

## Disposition summary

**CONFIRM-FIX (mechanical, no-regret):**
1. `PUT /api/settings` — add `require_permission("settings","manage")`.
2. `PUT /api/branding` — add `require_admin`.
3. `/api/rag/import` + `DELETE /api/rag/documents/{id}` — add
   `require_permission("rag","manage")`.
4. `POST/PUT/DELETE /api/memory` — add `require_permission("memory","manage")`.
5. `POST /api/playbooks/reload` — add `require_permission("settings","manage")`.
6. case comment/tags/assign — add `request` param + inline `_enforce` (mirror
   `case_action`).
7. Poller per-feed try/except — isolate one feed's failure from the rest.
8. `RiskGauge.tsx:18` — `>= 33` → `>= 35` + fix the `:14` comment.

**REVIEW (architectural / security-critical / correctness-critical / back-compat
risk / speculative / cosmetic-with-judgment):** set_status→RESOLVED RBAC; demo-chat
isolation; demo write-guard advisory; env-admin tv lockout; session RMW revoke loss;
refresh-reuse single-generation; route-auth-coverage authZ test; `text_safe` dead
code; `{{{var}}}` raw-HTML override; broad-feed cursor starvation (#4); per-feed
severity_floor units; branding SVG validator; shared CONFIG_INDEX collision;
deep-link breadcrumb host mapping.
