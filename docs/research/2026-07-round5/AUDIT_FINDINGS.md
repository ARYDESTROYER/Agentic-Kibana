# Round-5 Adversarial Audit — Consolidated Findings

> Consolidated from 16 dimension auditors (27f0983..HEAD, 10 commits). De-duplicated,
> prioritized by severity, split into **MUST-FIX (before ship)** vs
> **POLISH (nice-to-have)**. Each item keeps `{title, file:line, issue, fix, dimension}`.
>
> **Verdict roll-up by dimension:** clean = 8 (#3 decide, #2/#10, settings deep-merge,
> deep-links/nav, bundle+lazy, data-integrity+states) · minor-issues = 5 (#6 ledger,
> #9 fencing, RBAC, a11y, dead-code, backend regressions) · major-issues = 3 (design
> consistency, rules correctness, dashboards correctness).

## Severity counts (post-dedup)

| Severity | MUST-FIX | POLISH | Total |
|----------|---------:|-------:|------:|
| Critical | 1 | 0 | 1 |
| High     | 4 | 0 | 4 |
| Medium   | 4 | 3 | 7 |
| Low      | 0 | 11 | 11 |
| **Total**| **9** | **14** | **23** |

**De-dup note:** The server↔client dashboard **widget-type allowlist divergence** was
independently reported by 3 dimensions (`dashboards correctness` = CRITICAL,
`#9 fencing` = medium, `design consistency`-adjacent). Merged into ONE critical item
(C1). Its "no test crosses the two allowlists" companion is kept as the separate H1
(different fix: a contract test). The **FE-rules-RBAC-on-`automation`-vs-backend-`rules`**
mismatch was reported by both `RBAC gates` (medium) and `rules correctness` (low) —
merged into one medium (M2).

---

# MUST-FIX (before ship)

Real invariant violations / regressions / broken write-paths / broken deep-links,
plus the #6-ledger regression. Dispatch these first.

## CRITICAL

### C1 — Server & client dashboard widget-type allowlists are disjoint → every Save of a default/gallery dashboard 400s
- **file:** `backend/app/api/routes_dashboards.py:66-75` (+ `webui/src/soc/dashboard/registry.ts:53-62`)
- **dimension:** dashboards correctness (also flagged by #9 fencing, design consistency)
- **issue:** Server `WIDGET_TYPES` frozenset (14 types: `kpi.open_cases`/`kpi.mtta`/
  `chart.cases_per_day`/`barlist.*`/`queue.attention`/…) and the client `WidgetType`
  union (9 types: `kpi.needs_human`/`gauge.active_risk`/`kpi.cost_budget`/
  `chart.autonomous_vs_human`/`kpi.lifecycle_timing`/`table.connector_health`/…) were
  authored independently and share only **3** values (`chart.verdict_mix`,
  `table.recent_cases`, `mitre.heatmap`). The client can only build widgets from its
  own registry (role defaults + gallery), so every real Edit→Save sends a type the
  server rejects. `_clean_widget()` raises 400 on any unknown type and
  `_sanitize_layout` iterates ALL widgets, so ONE unknown type aborts the entire
  PUT/POST/clone. For super_admin the default set is 100% rejected; all other roles
  also fail (≥1 rejected widget). **No custom dashboard can be persisted** — a
  shipping regression of the feature's core write path. This is ALSO a #9
  allowlist-integrity defect (the two allowlists documented as kept in lockstep have
  drifted).
- **fix:** Reconcile to a single source of truth. Fastest correct fix: replace the
  server `WIDGET_TYPES` frozenset with the exact 9 client-registry types
  (`kpi.needs_human`, `kpi.cost_budget`, `chart.verdict_mix`,
  `chart.autonomous_vs_human`, `kpi.lifecycle_timing`, `table.connector_health`,
  `table.recent_cases`, `mitre.heatmap`, `gauge.active_risk`). Update backend route
  tests (`test_round5_dashboards_routes.py`) to use REAL client types instead of
  `kpi.open_cases`/`barlist.top_mitre`, and add an end-to-end test that POSTs a
  role-default dashboard and asserts 200. (See H1 for the anti-drift contract test.)

## HIGH

### H1 — No test exercises a real client widget through the real server validator → allowlists drift undetected
- **file:** `backend/tests/test_round5_dashboards_routes.py:44` (+ webui dashboard tests)
- **dimension:** dashboards correctness
- **issue:** Route tests hardcode server-only types (`kpi.open_cases`,
  `chart.cases_per_day`, `kpi.mtta`, `barlist.top_mitre` — none in the client
  registry); webui tests exercise only client types. Neither suite validates a widget
  the UI actually emits against the server allowlist, so C1 passed CI green. No runtime
  endpoint hands the server allowlist to the client (zero cross-references).
- **fix:** Add a contract test that keeps the two allowlists in lockstep: emit the
  server `WIDGET_TYPES` to a committed fixture (or a `GET /api/dashboards/widget-types`
  endpoint) and assert in a webui test that `registry.ts` `WIDGET_TYPES` === the server
  set. Add a backend test that round-trips each client widget type through
  `POST /api/dashboards` and asserts 200, so a one-sided widget addition fails CI
  immediately.

### H2 — Bug-#6 verdict validator is case-sensitive, rejects every legitimate lowercase verdict the UI emits
- **file:** `backend/app/api/routes_rules.py:73,151`
- **dimension:** rules correctness
- **issue:** `_VALID_VERDICTS = {v.value for v in Verdict}` is UPPERCASE
  (`FALSE_POSITIVE`/`TRUE_POSITIVE`/`NEEDS_HUMAN`), but `_validate_automation_verdict`
  does a case-sensitive `str(verdict) not in _VALID_VERDICTS`. Both new editors emit
  LOWERCASE verdicts (`constants.ts:132`, `automation.tsx:70`:
  `true_positive`/`false_positive`/`needs_human`) and `adapter.ts` passes them
  verbatim. So `PUT /api/rules/case-automation/{id}` 400s on REAL verdicts, GET
  `/api/rules` falsely flags them invalid, and rollback of any snapshot carrying one is
  blocked. The engine matcher (`threshold_automation.py:111`) `.upper()`s both sides and
  fires them correctly, and the generic settings PUT persists them fine — so the fix
  breaks the router's own CRUD path. `GET /api/rules` returns `valid_verdicts`
  UPPERCASE, mismatching the FE's lowercase `VALID_VERDICT_SET`. The test at
  `test_routes_rules.py:169` cements the wrong behavior (conflates a lowercase Verdict
  with a Disposition).
- **fix:** Make the membership test case-insensitive to mirror the engine matcher:
  `if str(verdict).upper() not in {v.value.upper() for v in Verdict}`. Same in
  `list_rules` for the invalid-verdict compute. Return `valid_verdicts` in the case the
  UI uses (lowercase) or have the FE upper-fold. Fix `test_routes_rules.py:169` to only
  treat true dispositions (`suspicious`/`benign`) as invalid, and assert
  `false_positive` is ACCEPTED.

### H3 — Custom Dashboards page bills an LLM call (`GET /api/standup`) on every load/refresh, consumed by no widget (#6 regression)
- **file:** `webui/src/soc/dashboard/DashboardDataProvider.tsx:132`
- **dimension:** #6 LLM ledger
- **issue:** `DASHBOARD_SOURCES.standup` → `api.standup(ctx.windowHours)` is in
  `DASHBOARD_SOURCE_KEYS`; the provider defaults `sourceKeys = DASHBOARD_SOURCE_KEYS`
  (line 209) and fetches ALL declared sources on mount + every refresh tick.
  `DashboardBuilder.tsx:276` mounts it with NO `sourceKeys` prop (never narrows to
  placed widgets). `GET /api/standup` (`routes.py:3543-3561`) calls
  `standup_service.generate()` → `gateway.complete()` (`standup.py:314`) → a **UsageDoc
  is written** (billing) whenever standup is enabled + an LLM key is present, with no
  caching/dedup. **No widget consumes the `standup` source.** So the Dashboards page
  unconditionally bills an LLM call for data nothing displays — a Round-5 regression
  against "dashboards never bill the LLM" (#6/#7 spirit). Unlike the correctly-guarded,
  zero-UsageDoc-tested rule-preview and preview-decision paths, there is no guard/test.
- **fix:** Do not fetch billable sources from the dashboard. Preferred: in
  `DashboardBuilder`, compute the union of `registry[widget.type].sources` across shown
  widgets and pass it as `<DashboardDataProvider sourceKeys={neededSources}>` (removes
  standup since no widget declares it). Or remove `standup` from `DASHBOARD_SOURCES` /
  `DASHBOARD_SOURCE_KEYS` until a widget needs it, or replace the standup thunk with a
  non-billing read. Add a regression test (mirror
  `test_round5_w0f_preview_decision.py`'s `usage_store.write` spy, or a vitest asserting
  the provider never calls `api.standup` for a widget-less/standup-less dashboard) so
  dashboards are pinned to zero UsageDoc writes.

### H4 — `Field` primitive never names a Radix Select trigger → 19 nameless comboboxes app-wide (WCAG 4.1.2 / 1.3.1 / 3.3.2)
- **file:** `webui/src/soc/components/Field.tsx:80`
- **dimension:** a11y real
- **issue:** `Field` clones its `id`/`aria-describedby`/`aria-invalid` onto its single
  child. When that child is a Radix `<Select>` (Root — a context provider rendering NO
  DOM), the `id` is swallowed, so `<label htmlFor={id}>` points at nothing and the real
  `role="combobox"` trigger gets no accessible name. A screen reader announces a bare
  "combobox". 19 nameless SelectTriggers across 8 files: `RuleEditor.tsx`
  (184,349,397,455,480,644), `settings/automation.tsx` (267,316,362,428),
  `casedetail/ConfirmActionDialog.tsx` (124=Disposition-REQUIRED,145,190 — case-close
  flow), `pages/CaseDetail.tsx` (939,1037), `Users.tsx:198`, `Security.tsx:245`,
  `casedetail/FeedbackPanel.tsx:256`, `DataTable.tsx:516` (rows-per-page on EVERY
  paginated table). Many pair a bare `<Label>` with no `htmlFor` (1.3.1). The team
  disabled the axe `button-name` rule to hide it, so the "48→0 unlabeled controls
  Field-wrapped" claim is only partially true for Selects.
- **fix:** Forward the Field control id to the Select trigger, or require an explicit
  name. Two options: (1) In `Field.tsx`, pass the generated id to the trigger (accept a
  `controlId` render-prop; call sites put `id={id}` on `<SelectTrigger>`, matching
  `ConditionBuilder.tsx:99` / `settings/primitives.tsx:275`). (2) Immediate blanket fix:
  add `aria-label` to each of the 19 nameless `<SelectTrigger>`s. Then re-enable the axe
  `button-name` rule in `RuleEditor.a11y.test.tsx:41` and `settings.a11y.test.tsx:84-89`
  so the regression can't return, and give the bare `<Label>`s a real `htmlFor`.

## MEDIUM (must-fix)

### M1 — Arbitrary-text-size CI gate neutralized by a regenerated baseline (design regression + gate integrity)
- **file:** `webui/scripts/grep-baseline.json:44`
- **dimension:** design consistency
- **issue:** `grep-baseline.json` was regenerated in Round-5 commit `3e447da` after new
  arbitrary text sizes were added, grandfathering them so `gate-grep.mjs` passes green
  despite **9 net-new violations**. The design-consistency gate no longer catches the
  regressions it exists to catch.
- **fix:** Revert affected baseline counts to their pre-Round-5 values, migrate the new
  sizes to scale steps, and only ratchet counts DOWN (never regenerate up).

### M2 — G6-R9 rules permission not unified end-to-end: backend enforces `rules`, frontend still gates on `automation` (nav↔page↔endpoint mismatch)
- **file:** `webui/src/soc/rules/types.ts:59-61` (+ `settings-sections-meta.ts:229`)
- **dimension:** RBAC gates (also flagged by rules correctness)
- **issue:** R9's "one coherent rules grant" landed on the backend (every read gates on
  `rules:read`, every mutation on `rules:manage` — `routes_rules.py:169/215/468/491`,
  proven by `test_routes_rules.py:367`), but the FE still uses the OLD `automation`
  resource: `RULES_PERM={resource:'automation'}`, `DetectionRulesHome.tsx:99`
  `useCan('automation','manage')` threaded into the version-ledger Restore button, and
  the Settings section gate `settings-sections-meta.ts:229` on `automation:read`.
  Meanwhile the ledger/rollback/preview buttons call endpoints that require
  `rules:read`/`rules:manage`, and the primary Save rides `PUT /api/settings` needing
  `settings:manage`. So ONE surface spans THREE resources. For built-in roles this is
  invisible (`_settings_like` derives rules/automation/settings identically from
  `settings` in DEFAULT_MATRIX only). For a **custom role** the three are independent:
  a role granted the advertised unified `rules:*` cannot see/use the editor (UI hides on
  `automation:read`); a role with `automation:manage` but not `rules:manage` sees
  enabled Restore/preview buttons that then 403. Exactly the bug-#7 mismatch class
  reintroduced. No test catches it (built-in auditor holds all grants).
- **fix:** Unify the FE on `rules`: `types.ts:59-61` →
  `RULES_PERM={resource:'rules',action:'manage'}` / `RULES_READ_PERM={...,'read'}`;
  `settings-sections-meta.ts:229` → `{resource:'rules',action:'read'}`. Decide the write
  path: either point rule Save at rules-specific endpoints (effective write grant
  `rules:manage`), OR document that rule editing additionally requires `settings:manage`
  and grant `settings` on default rules-capable roles. Add a custom-role test granting
  ONLY `rules:read`/`rules:manage` and asserting the FE section is visible, the ledger
  loads, and rollback succeeds.

### M3 — Preview ANDs all predicate rows but the adapter saves only the first → preview counts silently diverge from the deployed rule
- **file:** `backend/app/api/routes_rules.py:610-614`
- **dimension:** rules correctness
- **issue:** `preview_rule` evaluates `all(p.matches(src) for p in predicates)` over
  EVERY predicate row, but the save adapter
  (`adapter.ts:52-54 detectionMatchToWire`) keeps ONLY the first row (`RuleDefinition.match`
  is a single `RuleMatch`; the editor even warns "Only the first condition is saved").
  So with 2+ condition rows the preview reports the ANDed count (fewer) while the
  deployed rule fires on the first predicate alone (more). Operators calibrating on the
  preview under-count what the rule actually fires on.
- **fix:** Make the preview match the saved semantics: evaluate only the first predicate
  row (or have the FE send just the persisted row) until nested AND/OR ships. Otherwise
  gate the multi-row preview behind the "not saved yet" warning and clearly label it a
  what-if over unsaved logic.

### M4 — `DashboardWidget` type declares `id`/`config` but the wire contract is `i`/`options` (type lies about the wire; silent config loss for new code)
- **file:** `webui/src/lib/types.ts:2398-2418`
- **dimension:** type sync
- **issue:** The webui `DashboardWidget` interface declares `id: string` (required) +
  `config?`. Backend source of truth uses `i: str` (`models.py:648`) + `options: dict`
  (`models.py:657`), and every route reads/writes them verbatim
  (`routes_dashboards.py:145-149`). The TS interface MISDESCRIBES the wire/store shape;
  it works only because `layout-utils.ts` casts to `Record<string,unknown>` and reads
  `i`|`id` / `options`|`config`, plus a `[key:string]:unknown` escape hatch. A dev
  writing NEW code against the declared type (`widget.id`, `widget.config = {...}`, or a
  `DashboardWidget` literal) produces a widget with no `i`/`options`, which the backend
  silently re-keys (mints fresh `i`, drops `config`) — losing identity + config on the
  round-trip. The JSDoc contradicts itself (claims `{i,x,y,...}` is the schema while the
  body uses `id`).
- **fix:** Make the interface match the wire: rename `id`→`i` (keep required; client
  always sends via `normalizeWidget`) and `config`→`options`; OR keep both but add
  `i?: string; options?: Record<string,unknown>;` so the real wire keys are typed, and
  document `layout-utils.normalizeWidget()` as the mandatory serialization boundary.
  Align the JSDoc. Add a vitest round-trip assertion (build widget → `normalizeWidget` →
  assert `i`/`options` present).

---

# POLISH (nice-to-have)

Latent gaps, pre-existing issues, hygiene, and defense-in-depth. No live invariant
violation or broken write-path. Can ship after the must-fix set.

## MEDIUM (polish)

### P1 — Preview hard cap (`le=1000`) is 5× `GET /api/logs`' 200, contradicting the "exactly like GET /api/logs" invariant
- **file:** `backend/app/api/routes_rules.py:567,644,697`
- **dimension:** rules correctness
- **issue:** `_PreviewIn.limit` is `le=1000` and `_read_recent_events` passes it through
  as per-source `size` + `merged[:limit]` with no 200 clamp. `GET /api/logs` hard-caps
  at `min(limit or 100, 200)`. The docstrings claim parity, so the preview can pull up
  to 1000 rows/source through the read-only key — a larger, un-parity read-only
  scatter-gather than the audited logs surface, weakening the stated #1/#6 bound.
- **fix:** Clamp to the same ceiling (`le=200` or
  `limit = max(1, min(int(body.limit), 200))`) so both per-source `size` and the merged
  slice match `GET /api/logs`. Update docstrings to reference the shared cap constant.

### P2 — WORK_TRACKER.md committed despite self-declared "do-not-commit"
- **file:** `WORK_TRACKER.md:1`
- **dimension:** dead code + leftovers
- **issue:** 358-line Round-5 scratch tracker committed to repo root in `f50e0b2`; its
  header (lines 3-4) says "TEMPORARY working memory… DELETE THIS FILE… Not to be
  committed." Tracked in git, not in `.gitignore`.
- **fix:** `git rm WORK_TRACKER.md`, add to `.gitignore`; fold anything worth keeping
  into `docs/research/2026-07-round5/IMPLEMENTATION.md`.

### P3 — `.vite/vitest/results.json` cache artifact committed and not gitignored
- **file:** `.vite/vitest/results.json:1`
- **dimension:** dead code + leftovers
- **issue:** Vitest run-cache (has stale `failed:true` entries) committed in `a9e2b49`;
  `.gitignore` has no `.vite/` rule; churns on every local test run.
- **fix:** `git rm --cached .vite/vitest/results.json`, add `.vite/` to `.gitignore`.

## LOW (polish)

### P4 — Dashboard breadcrumb `<a href={c.href}>` lacks a `javascript:`/`data:` scheme guard (latent #9 gap)
- **file:** `webui/src/soc/components/PageHeader.tsx:61-64`
- **dimension:** #9 fencing
- **issue:** Breadcrumbs render `<a href={c.href}>` with an unvalidated href; React does
  not sanitize href, so a `javascript:`/`data:text/html` crumb would execute on click.
  No page passes a dynamic/untrusted crumb href today (all label-only), so not a live
  vuln — a defense-in-depth gap in shared chrome. Sibling `ThreatContextPanel.mitreUrl()`
  already guards with `^https?://`.
- **fix:** `safeHref = c.href && /^(https?:|\/|#)/i.test(c.href) && !/^\s*javascript:/i.test(c.href) ? c.href : undefined;`
  render `<a>` only when set, else a plain `<span>`. Add a test that a `javascript:` href
  renders as a non-link span.

### P5 — `settings.a11y` test scopes out the `button-name` app-defect under a "jsdom artifact" framing
- **file:** `webui/src/soc/__tests__/settings.a11y.test.tsx:84-89`
- **dimension:** a11y real
- **issue:** The axe smoke disables `button-name` (real nameless comboboxes on the
  highest-blast-radius surface) alongside the legitimate `landmark-unique` jsdom
  artifact, weakening the "no axe violations" green.
- **fix:** After H4 lands, remove `button-name: { enabled: false }` from `AXE_OPTS` in
  `settings.a11y.test.tsx` and `RuleEditor.a11y.test.tsx:41`; keep only the justified
  `landmark-unique` exception.

### P6 — jsx-a11y kept at `warn` with only the recommended subset → WCAG-2.2 criteria unenforced by lint
- **file:** `webui/eslint.config.js:86,89`
- **dimension:** a11y real
- **issue:** Only `jsxA11y.configs.recommended.rules`, all forced to `warn`. So "0
  jsx-a11y warnings" proves only the static subset is clean; naming/label regressions
  can slip in as advisory warnings that don't fail `npm run lint`.
- **fix:** After H4, promote the now-clean high-signal rules
  (`label-has-associated-control` with a shadcn `<Label>` component-map; keep the axe
  `button-name` assertions) to `error`, per the file's own warn→error rollout note. Add
  jsx-a11y component-mappings so wrapper `<Label>`/`<Input>` are recognized.

### P7 — Un-requested dashboard sources are stuck `loading:true` forever (latent — no active caller)
- **file:** `webui/src/soc/dashboard/DashboardDataProvider.tsx:160`
- **dimension:** data integrity + states
- **issue:** `initialSourceState()` seeds EVERY key `{loading:true}`, but the fetch
  effect only flips `loading:false` for `activeKeys`. A partial `sourceKeys` prop + a
  descendant widget reading a source outside the subset → permanent skeleton. Latent
  (the only mount site uses the default all-keys set) but nothing enforces placed
  widgets stay within the mounted subset — and H3's fix (narrowing `sourceKeys`) would
  surface it for a misconfigured widget.
- **fix:** Seed only active keys as loading; treat un-requested keys as
  settled-with-no-data — e.g. `React.useState(() => initialSourceState(activeKeys))` in
  the provider, or return `{loading:false,data:null,error:null}` in `useDashboardSource`
  when key ∉ activeKeys. **Coordinate with H3** (do together).

### P8 — `CorrelationRule.group_by` narrower than backend `EntityType`, now exercised by the rules editor via a cast
- **file:** `webui/src/lib/types.ts:729`
- **dimension:** type sync (also flagged by rules correctness)
- **issue:** Typed `'ip'|'user'|'host'`, but backend permits the full enum
  (ip/user/host/file_hash/domain/rule). Round-5's editor now actively produces the wider
  set (`ThresholdForm.groupBy: EntityTypeFull`, `adapter.ts:70,110` write it back with an
  explicit cast that defeats the compiler). Works at runtime but the type lies about the
  allowed set.
- **fix:** Widen `group_by` to `EntityTypeFull` (already at `types.ts:2179`) and drop the
  `as CorrelationRule['group_by']` casts in `adapter.ts:70,110`.

### P9 — `OrgCustomization` (the `/api/prefs/org` response type) missing `default_dashboards`
- **file:** `webui/src/lib/types.ts:1271-1277`
- **dimension:** type sync
- **issue:** `/api/prefs/org` returns backend `CustomizationConfig` (extended with
  `default_dashboards` in `config.py:625`), but the FE types it as `OrgCustomization`,
  which lacks the field (only the endpoint-UNwired `CustomizationConfig` interface at
  `types.ts:2376` carries it). Editing org default dashboards through this endpoint is
  untyped (survives only via the `[key:string]:unknown` index signature).
- **fix:** Add `default_dashboards?: Record<string, DashboardLayout>;` to
  `OrgCustomization`, or re-point `api.prefs.getOrg/putOrg` to `CustomizationConfig` and
  merge/delete the redundant `OrgCustomization`.

### P10 — FE rules RBAC constant gates on `automation` (duplicate view of M2, kept for tracking)
- **file:** `webui/src/soc/rules/types.ts:59-61`
- **dimension:** rules correctness
- **issue:** Same root cause as M2 (FE `RULES_PERM`/`RULES_READ_PERM` on `automation`
  vs backend `rules`). **Resolved by M2's fix** — no separate action needed; listed so
  the orchestrator doesn't treat it as an independent task.
- **fix:** Fixed by M2. Also update the stale `types.ts` comment that claims the backend
  exposes `automation` for this surface.

### P11 — Concurrent rule edits do full-Preferences read-modify-write with no CAS (pre-existing, not Round-5-introduced)
- **file:** `backend/app/api/routes_rules.py:91-96`
- **dimension:** rules correctness
- **issue:** Every CRUD handler reads `state.prefs`, `model_copy(update={one_block})`,
  `state.update_prefs(full_prefs)` with no `_rev`/CAS/lock (`state.py:1464` is a plain
  full-doc save). Two concurrent edits (or a rule edit racing the nightly
  `threshold_tuner`) each snapshot the same base → last writer clobbers the other
  block. Pre-existing app-wide pattern (settings PUT is identical), but Round 5 adds
  several new concurrent full-prefs writers.
- **fix:** Route Preferences mutations through a CAS/locked read-modify-write (per-block
  merge under a prefs lock with `_rev` compare-and-set), or at minimum serialize
  `update_prefs` with an `asyncio.Lock` and re-read `state.prefs` inside the lock.

### P12 — `PUT /api/settings` has no audit row — now carries the decision-critical auto-close policy (pre-existing gap, significance raised by Round 5 bug #1)
- **file:** `backend/app/api/routes.py:828`
- **dimension:** #2 audit + #10 secrets
- **issue:** `put_settings()` persists a deep-merged Preferences but writes NO
  append-only audit record (no #2 who/when). Pre-existing (byte-identical at baseline).
  But Round-5's bug-#1 fix repointed the flagship auto-close toggle to `prefs.auto_close.<verdict>`
  — the field `decide()` reads — and it saves through this un-audited PUT. So an
  operator can change which cases auto-close with no audit trail. By contrast, rule
  edits and reset both audit their config changes. **NOT a Round-5 regression** —
  observation only.
- **fix:** In `put_settings()`, after `state.update_prefs(prefs)`, add a best-effort
  append-only audit row (actor + `result_summary='updated settings: '+changed-top-level-keys`,
  never values) mirroring `routes_prefs.terminology_put`. Add a `request: Request` param
  to source the actor.

### P13 — G8 half-done: `OidcStateStore` + `AppState.oidc_state` are dead code; SSO routes still reach `state._kv` privately
- **file:** `backend/app/api/routes.py:2250,2268,2274` (+ `auth/oidc.py:293`, `state.py:141`)
- **dimension:** backend regressions
- **issue:** Round-5 added `OidcStateStore` + a public `AppState.oidc_state`, but
  `sso_authorize`/`_consume_oidc_state` still call `state._kv.put/get` against an inline
  `_OIDC_STATE_NS`, duplicating the store's logic. Nothing consumes `.oidc_state` —
  both store and accessor are dead code contradicting the documented G8 deliverable.
  `test_oidc_state_public_accessor_round_trips` exercises the store in isolation only,
  giving false confidence the route was decoupled. No functional regression (inline code
  byte-identical).
- **fix:** Either (a) migrate the routes to `state.oidc_state.stash/consume`, delete the
  inline namespace, add a route-level regression driving `/auth/sso/authorize` →
  `/callback`; OR (b) delete the store + accessor + isolated test and correct the test
  docstring.

### P14 — `state._real_audit` still reached privately in `routes.py` despite the new public `real_audit` accessor (G8 incomplete)
- **file:** `backend/app/api/routes.py:1268`
- **dimension:** backend regressions
- **issue:** `AppState.real_audit` was added but `routes.py:1268` still calls
  `state._real_audit.record(...)` with `# noqa: SLF001` — the last private reach the
  accessor was meant to eliminate. No functional change; an inconsistency.
- **fix:** Change to `await state.real_audit.record(...)` and drop the `# noqa: SLF001`.

### P15 — `default_dashboards` validator uses a hardcoded 32 instead of its own ClassVar cap
- **file:** `backend/app/config.py` (`CustomizationConfig._bound_default_dashboards`)
- **dimension:** #2 audit + #10 secrets
- **issue:** Declares `_MAX_DEFAULT_DASHBOARDS: ClassVar[int] = 32` but the bound check
  hardcodes `if len(v) > 32`, so the ClassVar is dead and a future cap change won't take
  effect. No security/audit/secret impact.
- **fix:** `if len(v) > cls._MAX_DEFAULT_DASHBOARDS:` and reference it in the error
  message, matching `_MAX_THEME_TOKENS`/`_MAX_TERM_KEYS`.

### P16 — Stale `api.setup.initAdmin` mock in two test files
- **file:** `webui/src/soc/__tests__/login.render.test.tsx:50` (+ `App.smoke.test.tsx:61`)
- **dimension:** dead code + leftovers
- **issue:** `api.ts` deleted the `setup.initAdmin` stub but both tests still mock it;
  zero call sites — dead mock property for a removed method.
- **fix:** Remove the `initAdmin` mock line from the setup mock in both files.

### P17 — `SectionHeading` `tone` prop is dead (accepted, eslint-silenced, never used)
- **file:** `webui/src/soc/pages/casedetail/shared.tsx:442`
- **dimension:** dead code + leftovers
- **issue:** Destructures `tone` as `_tone = info` with an eslint-disable because it is
  never used; 31 callers pass `tone=` (e.g. `OverviewPanel.tsx:548 tone=critical`) with
  no visual effect. Pre-existed at baseline but Round 5 copied it verbatim into the new
  split file.
- **fix:** Either implement `tone` (map to a heading/icon color class) or remove the prop
  from the type, destructure, eslint-disable, and all 31 call sites.

### P18 — `framer-motion` remains a listed dependency with zero importers (advisory)
- **file:** `webui/package.json` (`framer-motion@^11.18.2`)
- **dimension:** bundle + lazy
- **issue:** Zero importers in the source graph (never chunked, harmless to the shipped
  bundle) but worth pruning to prevent re-introduction.
- **fix:** Remove `framer-motion` from `package.json` dependencies.

---

## Clean dimensions (no findings — do NOT re-audit)

- **#3 decide() integrity** — `case_manager.py` byte-identical (same SHA at base+HEAD);
  the only new `decide()` caller (`routes_triage.py:102`, `POST /api/triage/preview-decision`)
  is a pure wrapper, no mutation/store/UsageDoc. Auto-close editor now writes the real
  `prefs.auto_close.<verdict>` field; `needs_human` code-locked.
- **Settings deep-MERGE** — `PUT /api/settings` byte-identical; all new config endpoints
  use single-block `model_copy(update={block})`; no sibling wiped.
- **deep-links + nav registry** — `PageId`/`FEATURES`/`ROUTES` byte-identical sets, only
  `dashboards` added; all 6 settings redirects resolve; zero deep-link back-compat break;
  tsc clean.
- **bundle + lazy** — entry 263.88 kB (77.31 kB gzip), byte-identical reproducible dist;
  recharts/RGL/framer all lazy or absent; all 10 bundle-first-paint assertions pass.
- **data integrity + states** — fetch-once contract holds; DASH/available sentinels
  consistent server→client; three-state primitives on all reworked pages (P7 is the one
  latent edge).
- **#2 audit + #10 secrets** — all new mutations audited append-only; no new field echoes
  a secret (P12/P15 are pre-existing/nit observations).
