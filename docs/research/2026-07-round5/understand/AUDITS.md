# Round 5 — Cross-Cutting Audits (Understanding Phase)

> **Scope:** Consolidated read-only findings from the "Cross-cutting audits" mapping
> domain for the Round-5 UI/UX overhaul. Each section is one audit, mapped to the
> overhaul goals (G1–G9). Every finding is de-duplicated across mapping agents and
> carries `file:line` citations. **This is a mapping document — no files were edited.**
>
> **Non-negotiable (repeated in every section):** `engine/case_manager.py` `decide()`
> must stay **byte-identical**. All UI/token/plumbing work must route the case-close
> path through `decide()` and must never change the load-bearing wire keys listed per
> section.

## Goal legend

| Goal | Description |
|------|-------------|
| G1 | Better cohesive color scheme (light + dark) |
| G2 | ONE consistent design standard on the existing shadcn/ui + Radix + Tailwind stack |
| G3 | Declutter Settings (2673 lines), reduce deeply nested submenus |
| G4 | Dashboard uses more screen real-estate, stop wasting space |
| G5 | Make the "Security Posture Dashboard" hero band compact |
| G6 | Real customizability for rules (detection / correlation / risk / auto-close / tuning) in the UI |
| G7 | Let users create their own custom dashboards |
| G8 | Loosely coupled codebase (easy to move / detach / reuse components) |
| G9 | Highest quality, fully tested |

---

## 1. Settings Information Architecture (G3)

**Surface:** `nav.ts` Settings group, `Settings.tsx` (2673 lines), `SettingsGrid.tsx`
primitives, `settings_schema.py`, `settings-dirty.ts`, and the standalone admin pages
(Users / Security / Sessions / Account / AdminSessions / Roles) that Settings re-embeds.

### The core problem
Settings is the operator's single tuning surface (a client-side buffered draft against a
saved snapshot: `GET /api/settings` → edit a draft → per-section dirty map drives a
`StickySaveBar` → minimal changed-key `PUT /api/settings`). It is the largest UI file in
the app and the primary IA pain point.

### Confirmed issues
- **Scale — one 2673-line god-file.** `Settings.tsx` holds ~26 distinct
  components/section-renderers (TextPref / NumPref / SwitchPref / ModelPicker /
  SecretInput + ~11 Section renderers + the page) in one module (`Settings.tsx:1-2673`).
  This is the single worst coupling hotspot in the settings surface and the precondition
  for any IA change.
- **Nesting depth up to 5 tiers to reach a control:** Group (`SECTION_GROUPS`
  `Settings.tsx:172`) → Section (`SectionMeta`) → in-section TOC anchor (`SectionShell`
  `Settings.tsx:474`; e.g. `GENERAL_TOC:710`, `DETECTION_TOC:902`, `ADVANCED_TOC:1166`,
  `KNOWLEDGE_TOC:1882`) → `SettingsCard` → control.
- **Count:** 6 groups, 21 sections (`SECTION_GROUPS` `Settings.tsx:172-373`; `SectionId`
  union has 21 ids `Settings.tsx:129-152`). Miller's 7±2 holds at the group level, but
  **Administration is a catch-all** (6 unrelated sections `Settings.tsx:307-355`): identity
  (Users/Security/Sessions) mixed with cosmetics (Appearance & branding) and power-user
  internals (Advanced: caps/kill-switch/suppression/lock).
- **Duplication — the biggest structural problem.** 6 destinations exist BOTH as full
  standalone pages AND as embedded Settings sections: `App.tsx` routes `users(164)`,
  `security(162)`, `sessions(156)`, `account(154)`, `admin_sessions(158)`, `roles(111)` to
  standalone pages; `Settings.tsx` ALSO renders the SAME bodies via `UsersInner(2472)`,
  `SecurityMfaInner`/`OrgSecuritySection(2478)`, `SessionsInner(2429)`, `AccountInner(2425)`,
  `AdminSessionsInner(2485)`. `Users.tsx:78` is literally `<ProtectedRoute><UsersInner/></ProtectedRoute>`.
  Two chromes, two nav paths, one body.
- **Nav/Settings mismatch.** The nav "Settings" disclosure children (`nav.ts:266-271`:
  users/security/roles/sessions) route to the STANDALONE pages (via `App.tsx` renderPage),
  NOT to `#/settings?s=admin_users`. Clicking "Users" under Settings leaves the Settings
  page entirely — confusing dual entry with no visual continuity.
- **Appearance split across two groups.** "Appearance & customization" (My account →
  `customization`, `Settings.tsx:206`, CustomizationSection) vs "Appearance & branding"
  (Administration → `appearance`, `Settings.tsx:340`, BrandingEditor). **Default theme is
  editable in BOTH** (CustomizationSection org-theme vs BrandingEditor default-theme).
- **Models split across three places.** `ModelsSection` (`Settings.tsx:794`) punts to the
  standalone Models page (`Settings.tsx:831`, nav Analytics child `nav.ts:214`); Batch jobs
  + Baseline are Analytics children (`nav.ts:215-216`) but their config (`prefs.batch`,
  `prefs.baseline`) has NO settings section.
- **Round-4 config has no Settings home.** `prefs.threshold_tuning`, `prefs.batch`,
  `prefs.baseline`, `prefs.campaign` (`config.py:1995-1998`) are absent from
  `SectionId`/`SECTION_GROUPS` entirely. Their config lives ONLY on standalone pages
  (`Tuning.tsx:107-152` has its own draft/`saveConfig` via `tuningApi.putConfig`;
  Baseline.tsx, Campaigns.tsx). **The app has TWO parallel settings systems with different
  save UX** — see also §3 and §5.
- **Dead schema endpoint.** `GET /api/settings/schema` (`routes.py:808`,
  `settings_schema.py`) builds a full descriptive Preferences schema intended to let the
  webui render forms generically, but **NO webui code consumes it** (0 hits for
  `getSettingsSchema`/`settingsSchema`/`settings/schema`). Every field is hand-wired.
- **Triple-maintained section→key mapping.** The section list exists 3× and must stay in
  sync by hand: `SECTION_GROUPS` (`Settings.tsx:172`), the `SectionId` union
  (`Settings.tsx:129`), and `SECTION_KEYS` (`settings-dirty.ts:35`). `SECTION_KEYS` is
  already partly stale (no mapping for Round-4 configs; `rag` deliberately double-listed
  under knowledge + advanced so both dots light).
- **Mixed save models inside one page.** The unified `StickySaveBar` (`Settings.tsx:2651`)
  drives the changed-key PUT, but several embedded sections manage their OWN save
  lifecycle: KeysSection has its own "Update keys" button (`Settings.tsx:894`);
  EnrichmentProvidersEditor "manages its own save lifecycle" (`Settings.tsx:1049-1052`);
  AutomationSection fetches playbooks itself; CaseIdSection debounces its own preview.
  **A user can face unsaved changes governed by 3 different save mechanisms on one screen.**
- **Cross-page punt-outs everywhere.** GeneralSection "Open Sources" (`Settings.tsx:731`),
  ModelsSection "Open Models admin" (`831`), AdvancedSection "Open catalog"→
  `intelligence?tab=catalog` (`1317`), KnowledgeSection "Open" (`1972/1985`). Cards whose
  only content is a button that leaves Settings add perceived depth without holding controls.
- **Search is the real nav.** 21 sections + a search box (`Settings.tsx:2567`) + per-section
  keyword arrays implicitly concede the tree is too deep to browse.
- **TOC + rail redundancy.** Grid sections render a sticky in-section TOC (`SectionShell`
  `Settings.tsx:491`) ON TOP OF the left rail — two nav mechanisms compete. Only 4 sections
  (`GRID_SECTIONS` `Settings.tsx:382`) get the TOC, so the interaction is inconsistent.

### Actionable recommendations
1. **Extract each section renderer** to `webui/src/soc/pages/settings/<section>.tsx`. Each
   takes only `{prefs, update}` (`SecProps` `Settings.tsx:409`) so extraction is mechanical.
2. **One section registry** (array of `{id, group, perm, ownedKeys, title, blurb, icon,
   Component}`) as the single source of truth; derive `SectionId`, `SECTION_GROUPS`,
   `SECTION_KEYS`, and the `renderSection` switch from it — kills the 3-file sync.
3. **Collapse the standalone Users/Security/Sessions/Account/AdminSessions/Roles pages into
   Settings sections** (they already expose `*Inner` bodies); route the nav children to
   `#/settings?s=<id>` and delete the duplicate chrome. Keep the `*Inner` pattern (one body,
   two hosts) — invert the direction (nav → Settings, not Settings → standalone).
4. **Extract shared field primitives** (TextPref/NumPref/SwitchPref/SecretInput/ModelPicker,
   `Settings.tsx:501-659`) into `webui/src/soc/components/settings/fields.tsx` so
   Tuning/Baseline/Campaigns/Models reuse them (Tuning.tsx re-implements toggles at 501/585).
5. **Unify the Round-4 config pages under the Settings save model** OR fully commit to
   per-page saves — not both on the same product.
6. **Wire `settings_schema.py`** to auto-render scalar/boolean/enum blocks
   (batch/baseline/campaign/sla/priority_matrix/budget) so new Preferences get a UI for free
   (also addresses G6 root cause). Special-case `demo` (managed via `/api/demo/*`) and the
   settings-lock so a user can't lock themselves out.

### Load-bearing constraints (do not break)
- `decide()` reads `prefs.fp_auto_close` via `AutonomyControls` (`Settings.tsx:1093`); the
  UI can be reorganized but the wire keys must stay identical. **(See §3 — the field this UI
  writes is actually the DEAD one; the correct field is `prefs.auto_close`.)**
- Wire keys that must stay byte-identical: `threshold_automation`, `cross_source_correlation`,
  `default_correlation`, `risk_weights`, `case_id_format`, `threat_context`, `rag`,
  `enrichment`, `notifications`, `sso`, `session_policy`, `caps`, `auto_forward_allowlist`.
- `*Inner` components self-scope to the caller and must NOT be wrapped in `<Can>` when
  embedded (`Settings.tsx:2422-2430`).
- Deep-links `#/settings?s=<id>` (`sectionFromHash` `Settings.tsx:2188`) and standalone
  routes (`#/users`, `#/security`) are live cutover fallbacks — removing a route needs a
  redirect or old bookmarks 404.
- React #310 hooks-order guards are documented (`Settings.tsx:2338-2345`,
  `CustomizationSection.tsx:14`) — keep all hooks above early returns. `GRID_SECTIONS`
  (`Settings.tsx:382`) controls Card-wrap vs bare — mis-tagging double-wraps/unwraps chrome.

---

## 2. Dashboard Space / Density (G4, G5)

**Surface:** the shell (`AppShell`), Overview (Security Posture Dashboard), Metrics, Cases.

### The core problem
The design system HAS a compact header (`PageHeader`) and archetype layouts
(`layouts.tsx`), but the primary landing page opts into the heaviest one
(`CommandCenterLayout` + `HeroPanel`). Roughly a third of the first viewport is chrome +
hero before any data appears.

### Confirmed issues
- **Overview hero is the #1 space waster (G5).** Overview uses `CommandCenterLayout` →
  `HeroPanel` with `p-6 sm:p-8` (`HeroPanel.tsx:46`) + display-size title
  (`.hero-display h1` clamp up to 2.125rem, `theme.css:204-212`) + a 2-line description
  (`Overview.tsx:552-553`). Measured band ~150–160px. Combined with the `h-14` top bar
  (`AppShell.tsx:493` = 56px) and `py-6` content padding (`AppShell.tsx:601` = 24px),
  **~258px of a ~820px laptop viewport (~31%) is chrome+hero BEFORE the first metric.** The
  hero carries zero live data. **Fix:** replace `HeroPanel` with the compact `PageHeader`
  (used by Metrics/Cases) → band drops ~155px → ~64px, reclaiming ~90px.
- **Overview Risk gauge eats the rest of the fold (G4).** `RiskGauge` at `size={208}`
  (`Overview.tsx:617`) in a `flex-col items-center gap-6 pb-6` card + extra `py-2` wrapper +
  a 3-row stat list → card ~320–360px tall in `lg:col-span-1` of a 3-col grid
  (`Overview.tsx:606-608`). After the ~258px hero+chrome, this single gauge fills the rest
  of the fold; timing StatCards, Signal breakdown and Workload are ALL below the fold.
  **Fix:** shrink to ~150–160px, make it a horizontal gauge+stats strip, or move it into the
  KPI row.
- **Global max-width caps wide monitors (G4).** Every page is centered in `max-w-[1400px]`
  (`AppShell.tsx:601`). On 1920px this leaves ~260px unused gutter; on 2560px ~1160px. Real
  wasted horizontal real-estate for dense tables. **Fix:** page-aware width (wide for
  Cases/Metrics tables, narrow for reading/settings). *(See §11 for the full width strategy
  and the `.container`-config red herring.)*
- **Content padding is uniformly generous.** `px-4 py-6 sm:px-6` (`AppShell.tsx:601`) on top
  of each page's own header, plus per-section `space-y-6`/`space-y-8` (Overview uses
  `space-y-6` `Overview.tsx:604`, Metrics `space-y-8` `Metrics.tsx:859`) and `gap-5`/`gap-6`
  grids → loose rhythm. **Fix:** `py-4`/`py-5` on the wrapper; standardize to a single 6-unit
  section rhythm. *(See §7/§8 for the fuller spacing consolidation.)*
- **Card padding heavy for KPI/stat tiles.** `KpiTile` uses `p-5` (`KpiTile.tsx:102`);
  `StatCard` `p-5 pl-6` (`StatCard.tsx:49`); base Card `px-5 py-4`/`px-5 pb-5`
  (`card.tsx:22,54`). 20px on small numeric tiles → fewer per row, taller rows. **Fix:** `p-4`
  on tiles, `py-3` header.
- **KPI grid caps at 3 cols on Overview despite 7 tiles.** 7 KPI tiles render at
  `xl:grid-cols-3` inside `lg:col-span-2` (`Overview.tsx:645`) → wrap to 3 rows beside the
  gauge. Skeleton mirrors this (`Overview.tsx:490-497`). **Fix:** give KPIs the full row (drop
  the col-span-2 nesting), go to `xl:grid-cols-4`/`2xl:grid-cols-7`, place charts below.
- **Metrics has two stacked bands.** Full `PageHeader` (`Metrics.tsx:458-464`) + `TabsList`
  (`Metrics.tsx:873-891`) = header ~64px + tab strip ~40px, and the description duplicates
  the tabs. The compact "embedded" variant exists (`Metrics.tsx:455-456`). **Fix:** fold
  window toggle + refresh into the TabsList row, drop the standalone description (~64px saved).
- **Metrics KPI grids mix widths inconsistently:** `lg:grid-cols-6` (149, 628, 1024, 1165,
  1223), `lg:grid-cols-5` (486, 1308), `lg:grid-cols-4` (154, 936). Tiles resize between
  tabs. **Fix:** one responsive column formula (e.g. `sm:grid-cols-3 lg:grid-cols-6`).
- **Cases devotes a full KPI band + views bar + filter bar before the table (G4).** Stack:
  PageHeader (`Cases.tsx:845-868`, ~64px) + 4-tile KPI Stagger (`871-902`, ~110px) +
  SavedViews/Columns row (`905-917`, ~40px) + padded filter bar `rounded-lg border p-3`
  (`920`, ~56px) = ~270px of controls before row 1 of the primary content. **Fix:** collapse
  KPIs into inline pill counts, merge SavedViews/Columns into the filter bar (~150px reclaimed).
  Consider adopting `WorklistLayout` (`layouts.tsx`), which Cases does NOT currently use.
- **Section eyebrow headings add vertical cost without density benefit.** Overview repeats
  uppercase labels each in its own `space-y-3` block ("Response timing" `Overview.tsx:668-672`,
  "Signal breakdown" `716-719`). **Fix:** inline as card-group captions or drop where card
  titles already name the content.

### Reuse opportunities
- `PageHeader` already exists and is used by Metrics + Cases — reuse on Overview instead of
  `HeroPanel` (instant G5 win, no new component).
- Promote the Metrics "embedded" compact-header pattern (`Metrics.tsx:455-456`) to a shared
  `dense`/`compact` prop on `PageHeader`.
- The window-toggle segmented control is re-implemented inline in `Overview.tsx:512-539` AND
  `Metrics.tsx:392-415` with near-identical markup (Overview `bg-card/70 rounded-md p-0.5`
  vs Metrics `bg-surface p-1`) — extract a shared `SegmentedToggle` (also §6/§12).
- Define one density scale (wrapper padding + section gap + card padding) once, instead of
  the current `py-6`/`space-y-6`/`space-y-8`/`gap-5`/`gap-6` mix.

### Customization gaps
- No user-facing **density toggle** (comfortable/compact) despite `usePrefs`/UserPrefsStore
  and a theme-mode radio already in the UserMenu (`AppShell.tsx:312-337`).
- No user control over content **max-width** (fixed 1400px).
- Overview layout (which widgets, gauge size, KPI order) is hardcoded — ties into G7. The KPI
  set (`Overview.tsx:416-482`) is a fixed array with no reorder/hide.

### Risks
- Padding changes to `KpiTile`/`StatCard`/`Card` are **global** — verify Cost/Models still
  breathe, and keep Vitest specs green (`metrics-posture.test.tsx`, `cases-bulk.test.tsx`).
- The Overview loading skeleton (`Overview.tsx:485-509`) mirrors the grid exactly — if columns
  or gauge size change, **the skeleton must change in lockstep** or there's a layout shift.
- Relocating the window toggle + refresh must preserve `setWindowKey`/`load` handlers and the
  `aria-pressed`/`role=group` a11y (`Overview.tsx:514-539`, `Metrics.tsx:395-415`).
- Preserve the 8px-grid convention and WCAG-AA spacing; keep mobile (`sm`) stacking intact.

---

## 3. Rules Customization (G6)

**Surface:** engine rule knobs (detection/correlation, risk, signatures, `threshold_tuner`,
`threshold_automation`, `AutoClosePolicy`, `SourceInstance` feeds) vs the hand-wired subset
that `Settings.tsx` exposes.

### The core problem
The engine exposes a rich, mostly-safe set of "rule" knobs, but `Settings.tsx` hand-wires
only a curated subset and `/settings/schema` is unconsumed, so **any knob not explicitly
coded into a section is uneditable**. The net: powerful decision-relevant knobs are invisible,
and — most seriously — the one auto-close panel that IS shown writes to a DEAD field.

### Confirmed issues (ordered by severity)
- **CRITICAL / correctness bug — the Auto-close UI edits a dead field.** `AutonomyControls`
  binds to `prefs.fp_auto_close` (`Settings.tsx:1093-1095`), but `decide()` consumes
  `prefs.auto_close` (`case_manager.py:132-138` → `_entry_for` `:51-56` reads
  `policy.false_positive`/`policy.true_positive`). The back-compat migration
  `_migrate_fp_auto_close` (`config.py:1794-1813`) only fires when `auto_close` is ABSENT —
  but `put_settings` merges over a full `model_dump` (`routes.py:828-833`) where `auto_close`
  is ALWAYS populated by its `default_factory` (`config.py:1891`). **So toggling "Auto-close
  confident false positives" changes nothing the engine acts on.** `settings-dirty.ts`
  detection tracks `fp_auto_close` (not `auto_close`), confirming the whole path targets the
  dead field. **FIX FIRST — point the UI at `prefs.auto_close.false_positive`; `decide()`
  already reads that; do NOT touch `decide()`; do NOT delete `fp_auto_close` (legacy configs
  still migrate).**
- **HIGH / missing knob — TRUE_POSITIVE & NEEDS_HUMAN auto-close classes un-editable.**
  `AutoClosePolicy` has three `VerdictAutoClose` entries (`config.py:511-533`); the UI only
  renders the FP one (via the wrong field). The documented TP-auto-close opt-in
  (`auto_close.true_positive` `config.py:524-529`) has NO control anywhere.
- **HIGH / missing knob — per-rule correlation.** `Preferences.correlation_rules` dict
  (`config.py:1909`; consumed by `correlate()` via `correlation_for`/`correlation_for_def`
  `correlation.py:100-101`) has NO editor. Settings only edits `default_correlation.n` and
  `.window_seconds` (`Settings.tsx:927-928`); `group_by` (`config.py:396`) and `mode`
  (EVERY/THRESHOLD/NEVER, `config.py:393`) are not editable even for the default rule.
- **HIGH / missing knob — detection RULE CATALOG.** `Preferences.rule_catalog:
  list[RuleDefinition]` (`config.py:1899`; `RuleDefinition`/`RuleMatch` `config.py:399-457`;
  `match_rule()` `config.py:2042-2057`) has NO UI. `Catalog.tsx` is about PLAYBOOKS + personas
  (imports `Playbook`/`PlaybookMatch` `Catalog.tsx:42`), not `rule_catalog`. The entire
  config-driven detection layer (field predicate equals/prefix/tag/exists, priority, per-rule
  correlation override, per-rule `model_override` `config.py:1905`) is admin-by-JSON only.
- **MEDIUM / missing knob — asset criticality.** `risk.py:_asset_criticality` (`risk.py:30-50`)
  reads `prefs.asset_criticality` (`config.py:1917`) and `prefs.asset_networks` (CIDR list,
  `config.py:1920` / `AssetNetwork` `config.py:1230-1235`). Neither has UI — only the risk
  WEIGHT is tunable (`Settings.tsx:939`), so the factor is inert without JSON.
- **MEDIUM / dead wiring — `in_scope_rules`/`excluded_rules`** (`config.py:1852-1853`) are
  listed in `settings-dirty.ts` (advanced) but have NO rendered control.
- **MEDIUM / partial knob — adaptive tuner.** `ThresholdTuningConfig` has 8 fields
  (`config.py:1123-1142`), `Tuning.api.ts` declares all 8, but `Tuning.tsx` renders only
  `enabled/min_samples/fp_rate_target/cadence/shadow_eval` (`Tuning.tsx:502-588`).
  `max_n_step`, `wilson_z`, `ewma_alpha` (the statistical safety knobs) have no control.
- **MEDIUM / missing knob — SLA policy & priority matrix.** `SlaPolicy` (`config.py:1032-1052`)
  and the ITIL `priority_matrix` (`config.py:1055-1072`) have NO editor. SLA is consumed for
  display (`Standup.tsx:571`, `Metrics.posture.api.ts:128`) but its `enabled` flag and P1–P4
  targets can't be set; `priority_matrix` has zero UI references. Both drive user-visible
  badges/queues. *(These also lack a Settings home per §1.)*
- **LOW / partial — suppression rules** can only be CREATED by approving an agent Proposal
  (Approvals.tsx). `SuppressionRule` (`config.py:1189-1227`) supports full operator authoring
  (field/value/reason/expiry/enabled) but there is no direct create/edit/disable UI.
- **LOW / view-only — personas.** `PersonaConfig.enabled` + `overrides` (rule→persona pin,
  `config.py:917-926`) is view-only in `Catalog.tsx:252-300`.
- **LOW / root cause — `/api/settings/schema` unconsumed** (`routes.py:815`,
  `settings_schema.py`). Because the UI is hand-wired section-by-section, each new engine knob
  must be manually plumbed or it's invisible — the direct cause of every gap above.

### Actionable recommendations
1. **Fix the dead-field bug first:** bind auto-close editing to `prefs.auto_close`. Consolidate
   into a single `VerdictAutoClose` sub-editor rendered twice (`false_positive` + `true_positive`)
   — DRY, and fixes the bug in one place.
2. Reuse `SettingsCard`/`SettingsGrid`/`NumPref`/`SwitchPref`/`TextPref`/`SectionShell` plus the
   proven `AutomationRuleEditor` list-builder pattern (`Settings.tsx:1864`) for new
   `rule_catalog` and `correlation_rules` editors.
3. Add the 3 missing tuner fields (`max_n_step`/`wilson_z`/`ewma_alpha`) using the existing
   `Tuning.tsx` draft/save pattern (types already exist `Tuning.api.ts:42`).
4. Add editors for asset criticality (map + CIDR), SLA policy, priority matrix, and a
   proactive operator suppression-rule builder (must still audit via the proposal/audit path).
5. **Add a schema-driven "Advanced (all settings)" fallback tab** consuming
   `GET /settings/schema` so future engine knobs are editable-by-default and never orphaned
   (root-cause fix; reduces the 2673-line burden — G3 + G8).
6. NET-NEW #3-safe rule types: predicate-based auto-forward (severity ≥ X /
   enrichment-malicious) beyond the flat `auto_forward_allowlist` exact-match
   (`config.py:1928`); per-rule model/persona pinning surfaced with the rule-catalog editor.

### Load-bearing constraints
- **#3:** any auto-close editor keeps `decide()` byte-identical — UI/plumbing only.
- A `rule_catalog` editor must respect `maybe_seed_rule_catalog()`/`RULE_CATALOG_SEED_VERSION`
  (`config.py:2083`) — saving an empty catalog could trigger reseed-on-boot; preserve the
  seed-version marker.
- `threshold_automation` rules can NEVER set status/disposition (asserted at
  `threshold_automation.py:205`) — offer only tag/recommend/notify/run_playbook/request_approval
  (`config.py:985`).
- `correlation` `n`/`window`/`group_by` feed cluster formation and thus #4 idempotency
  indirectly (`signatures.py` is entity-only). Editing is safe but changes case formation
  going forward — surface that; do NOT retroactively re-key open cases.
- A generic schema form must exclude `demo` (managed via `/api/demo/*`) and special-case
  `read_only_settings_mode` so a user can't lock themselves out.

---

## 4. Custom Dashboards (G7)

**Verdict: FEASIBLE with no new heavy deps.** All the pieces exist; the missing pieces are a
widget **registry**, a per-user **layout** model (persisted like UserPrefs), and a lightweight
grid/drag surface.

### What already exists (reuse targets)
- **Deterministic, pure, GET-only metric endpoints** as canonical widget data sources:
  `metrics.py` `compute_metrics(:111)`, `posture_metrics(:497)`, `feedback_stats(:85)`,
  `lifecycle_intervals(:206)`, `quality_metrics(:252)`, `aging(:307)`, `sla_metrics(:351)`;
  `routes_metrics.py` `GET /api/metrics/posture(:62)`, `/api/mitre/coverage(:86)`,
  `/api/mitre/coverage/navigator.layer.json(:109)`; plus `usageSummary`/`ragStats`/
  `listCases`/`standup` clients.
- **Theme-aware, aria-labelled chart primitives** (registry-ready, plain typed props,
  `isAnimationActive=false`): `charts.tsx` `DonutChart(:106)`, `HBarChart(:196)`,
  `TrendArea(:277)`, `MiniBars(:377)`, `Sparkline(:419)`; `charts-soc.tsx` `MitreHeatmap(:111)`,
  `BurnDownChart(~:236)`; card widgets `KpiTile`/`StatCard`/`BarList`.
- **A battle-tested per-user persistence pattern:** `UserPrefsStore` (`user_prefs.py:48`,
  one KV doc, zero migration, never raises) with `add_view(:145)`/`set_table_state(:195)` and
  the ORG←USER cascade `resolve_effective_prefs(:224)`; routes `/api/views`
  (`routes.py:1643-1737`); client `api.views` (`api.ts:637`).

### Confirmed gaps
- **No widget registry or custom-dashboard concept** exists in `webui/src` or `backend/app`.
  Dashboards are hand-authored monoliths: `Overview.tsx` (872 lines) and `Metrics.tsx` (1446
  lines) hardcode both fetch AND layout — a user can't add/remove/rearrange a tile.
- **Fetch and render are tightly coupled per page.** `Overview.tsx:179-208` fetches 5 sources
  in one `Promise.allSettled`; derived widgets (`215-298`, `409-482`, `360-406`) are inlined.
  A registry needs each widget to own its fetch+render (declare a `dataSource`).
- **`ChartCard` is defined LOCALLY inside `Metrics.tsx:174`** — a Dashboards page would have
  to duplicate it. **Promote to `soc/components/ChartCard.tsx`.**
- **No drag/grid dep** installed (`package.json`: recharts + radix + framer-motion + cmdk +
  lucide + tailwind utils only). Prefer a dep-free CSS-grid + HTML5-drag approach first; any
  new dep is a deliberate CLAUDE.md #8 decision and must build under `tsc --noEmit && vite build`.
- **`UserPrefs` (`models.py:633`) has no `dashboards` field.** Add a typed `Dashboard[]` field
  defaulted to `[]` (matches the `SavedView` precedent; keeps zero-migration).
- **`PageId` union (`nav.ts:53-84`) + `App.renderPage` (`App.tsx:81-170`) are a hardcoded
  switch** with no `dashboards` id/route. *(This is the same central-registry coupling as §5.)*
- **N-widget fan-out redundancy:** each metric endpoint is windowed by one `window_hours` over
  a bounded fetch (`routes_metrics.py:43` `_STORE_FETCH_LIMIT=5000`; Overview `listCases`
  limit=200). A 10-widget dashboard re-fetching `listCases`+`getMetrics`+posture = 10+
  redundant round-trips. **Fix:** a `DashboardDataProvider` context that fetches each source
  once and hands results to all widgets.
- **DASH/`available:false` contract must be respected.** `posture_metrics`/`compute_metrics`
  return honest DASH sentinels (`'—'` `metrics.py:23`) + `available`/`reason` blocks
  (`metrics.py:66`). Overview handles this manually (`Overview.tsx:303-334`); a generic
  renderer must NOT print `'—'` as a number or treat DASH as 0.
- **No org-default / shareable dashboards** analogous to `CustomizationConfig.default_saved_views`
  (`config.py:590-615`); needs the same ORG←USER cascade.

### Actionable recommendations
1. **DashboardsStore = `UserPrefsStore` verbatim** (or a `dashboards: Dashboard[]` field on
   `UserPrefs`). Mirror `add_view`/`update_view`/`delete_view` (`user_prefs.py:145-192`) as
   `add_dashboard`/…; mirror routes `/api/views` → `/api/dashboards`; mirror `api.views` client
   → `api.dashboards.{list,create,update,remove,clone}`. Zero-migration, backend-agnostic.
2. **Org-default dashboards** via `resolve_effective_prefs` cascade + a
   `CustomizationConfig.default_dashboards` (like `default_saved_views`), with a `clone`
   precedent (`api.ts:652`).
3. **Widget registry** entries: `{id, title, dataSource, defaultSize, adapt(payload)→props,
   Render}`, mapping to the existing chart/card primitives.
4. Promote `ChartCard`; reuse `CommandCenterLayout` (`layouts.tsx:41`) as the page scaffold;
   add a shared formatting layer (see §5 coupling note on `posture.format.ts`).
5. Cap dashboards-per-user and widgets-per-dashboard (mirror `CustomizationConfig` caps
   `config.py:617-638` and the ~200/user ring) so a config doc can't grow unbounded.

### Load-bearing constraints
- **#3:** no widget or its data path touches `decide()` — all metric functions are read-time/
  advisory (`metrics.py:165-172` is explicit).
- **#9:** widget labels/values are UNTRUSTED where source-derived (source_name, tags, entity
  values, MITRE ids). Chart primitives render labels as plain SVG `<text>` (`charts.tsx:11-13`);
  technique ids are validated/dropped in `mitre_coverage`. Never `dangerouslySetInnerHTML` a
  widget title/label — including a user-typed dashboard name.
- New dashboard routes must never-raise (`routes_metrics.py:46-59` returns `[]` on store
  error) and inherit `require_auth` + a narrow `require_permission` (`metrics:view`).
- New `UserPrefs.dashboards` field must default to `[]` (`models.py:634`) so legacy buckets
  load unchanged; persist via the KVStore, NOT a new ES index / SQL table.

---

## 5. Coupling — Frontend (G8)

**Surface:** navigation prop-drilling, the `App.tsx` central registry, backend-shape coupling,
duplicated cross-cutting concerns.

### Confirmed issues
- **Navigation prop-drilling (biggest, lowest-risk win).** A router context already exists
  (`router.tsx:90` `useNavigate`, `:81` `useRoute`), yet `App.renderPage` threads `onNavigate`
  into ~31 pages as an optional callback (40+ sites, e.g. `Overview.tsx:84`, `Metrics.tsx:220`,
  `Approvals.tsx:368`, `Home.tsx:23`, `Intelligence.tsx:26`, `Campaigns.tsx:75`, `Chat.tsx:43`,
  `Cost.tsx:285`, `Scans.tsx:165`, `Inbox.tsx:245`, `CaseDetail.tsx:601`). Every page then
  requires `App.tsx` to function and carries `onNavigate ? … : undefined` branches everywhere
  (`Overview.tsx:596/690/814`, `Metrics.tsx:1268`, `Settings.tsx:730/830/1313/1968`).
- **Proof the prop is redundant:** Cases + Audit already fall back to context —
  `Cases.tsx:436-437` and `Audit.tsx:75-76` both do
  `const navigate = onNavigate ?? route.navigate;`.
- **Weak/untyped nav contract.** 7 pages type it as `(page: any, opts?: any) => void`
  (`Account.tsx:56`, `AdminSessions.tsx:44`, `Catalog.tsx:547`, `Memory.tsx:499`,
  `Sessions.tsx:283`, plus Settings sub-sections `:716/:799/:1178/:1892`); `Security.tsx:526`
  uses `onNavigate?: unknown`. Defeats `PageId` type-checking.
- **`App.tsx` renderPage is a 90-line central registry** (`App.tsx:75-171`) + a lazy-import
  table (`:35-66`). Every new page must be manually wired in TWO places, and it must stay in
  sync with `nav.ts` (`nav.ts:306` admits "rendered by … the integrator in App.renderPage").
  A merge-contention magnet. *(Same pattern blocks G7 — §4.)*
- **No shared data-fetching hook — the single largest duplication.** 27 pages hand-roll
  `useState(loading)` and 29 pages hand-roll `try/finally setLoading(false)` with an identical
  load/error/loading triad (e.g. `Baseline.tsx:36-53`). No `useAsync`/`useFetch`/`useQuery`
  anywhere. A ~30-line `useAsync` would delete hundreds of lines. *(Ties into §12 states.)*
- **`CaseDetail.tsx` is 4210 lines**, embedded as a sheet by FOUR callers
  (`Cases.tsx:1163`, Investigate, Scans, itself) — the hardest component to move/reuse and the
  worst merge hotspot.
- **Shell components coupled to routing types:** `CommandPalette.tsx:51/99` (also imports
  `NAV_GROUPS`/`isPageId`/`PageId` `:50/:165`), `NotificationBell.tsx:37/171`, `NavSidebar.tsx`
  import the app-level `Navigate` type — preventing lift into a generic library.
- **`NavOpts` misfiled in the backend-contract file** (`lib/types.ts:1530`) — a pure-UI routing
  transport in the backend-types module blurs the boundary. Move to `soc/router.tsx` or a
  `soc/nav-types.ts`.
- **Duplicated posture-fetch semantics:** `fetchPosture` (`Metrics.posture.api.ts`) is called
  from `Overview.tsx:188` (`''`) and `Metrics.tsx:278` (`'prev'`) with independent load/delta
  state — the same boilerplate twice.

### Actionable recommendations
1. **`useNavigate()`-only convention:** delete the `onNavigate` prop, call the router hook
   (`router.tsx:90`). Cases/Audit already show the fallback — flip to hook-only (~40 sites gone,
   pages render standalone).
2. **One `useAsync<T>(fn, deps)`** returning `{data, loading, error, reload}`; adopt across the
   ~29 pages (start small: Baseline/Campaigns/Tuning/BatchJobs). Biggest LOC cut, lowest risk.
3. **Replace the renderPage switch + lazy table with a declarative `PAGE_REGISTRY`**
   (`Record<PageId, {load, gate?}>`); nav.ts validates against the same registry — collapses
   the two parallel registries (also the prerequisite for G7).
4. Extract `useDirtyState`/`useUnsavedChanges` from `settings-dirty.ts` for any editor page.
5. Extract a `usePosture(hours, period)` hook shared by Overview + Metrics.
6. **Split `CaseDetail.tsx`** into its already-conceptual panels (header/trace/thread/tasks/
   related/close-dialog); several extractions already exist (`CaseTriageHeader`, `CaseThread`,
   `CaseTasks`, `CaseActivityFeed`, `TraceTimeline`).
7. Move `NavOpts` out of `lib/types.ts`.

### Load-bearing constraints
- Removing `onNavigate` requires the RouterProvider mounted above every page (`App.tsx:267`) —
  it is, but any page rendered bare in a test must be wrapped in `<RouterProvider>` or
  `useRoute()` throws (`router.tsx:83`).
- The `onNavigate ? clickable : static` branches encode a real fallback — verify no page renders
  outside RouterProvider before deleting the static branch.
- `NavOpts` is intentionally NOT serialized to the URL (`router.tsx:6-9/:59`); preserve in-memory
  opts semantics and `HIDDEN_ROUTE_IDS`/`PAGE_IDS` validation (`nav.ts:309/332`) or old
  `#/cost`, `#/investigate` deep-links break.
- TabbedPage hosts (Home/Workspace/Analytics/Intelligence) drive their tab from `NavOpts.tab`
  and mirror back via `onNavigate(host,{tab})` (`Home.tsx:32`, `Intelligence.tsx:42`,
  `Analytics.tsx:43`) — preserve the round-trip.
- CaseDetail's single `{caseId, onClose, onNavigate?}` contract (`CaseDetail.tsx:17`) must not
  change when split; it opens from 4 hosts + `route.opts.caseId` (`Cases.tsx:489/1163`).
- **Do NOT re-merge the 16 per-feature `*.api.ts` modules** into `api.ts` — that split is a
  deliberate parallel-safety decision (documented in `Tuning.api.ts`, `CaseDetail.api.ts`) and
  re-merging REDUCES modularity.

---

## 6. Coupling — Backend (G8)

**Surface:** the four plugin SPIs (StateStore / connector / enrichment / notification), the DI
hub (`app/state.py`, ~1830 lines), and routes coupling. Overall the SPIs are well-designed
(constructor injection, no reach-back, entry-point extensibility for 2 of 3 registries); the
coupling debt is concentrated in the god-object `AppState` and its fragile `_wire()` ritual.

### Confirmed issues
- **Asymmetric extension seam.** Connectors (`connectors/registry.py:27`
  `'tlsoc.connectors'`) and enrichers (`enrichment/registry.py:30` `'tlsoc.enrichers'`)
  support out-of-tree `pip install` plugins via entry points, but the notification SPI has NO
  equivalent — `notifications/channel.py:131-149` `_load_builtins()` hardcodes
  `from . import email/resend/webhook`. A third party CANNOT ship a channel without editing core.
- **God-object DI hub.** `AppState` (`state.py:42`, ~1830 lines) owns everything: 8 `_real_*`
  handles (`:225-251`), demo lifecycle (`1424-1567`), 3 background schedulers (`767-902`), the
  batch service (`1728-1810`), event-detection routing (`618-753`), plus stdlib helpers
  (`parse_user_agent 1642`, `geo_for_ip 1709`). Anything needing one store imports the whole hub.
- **Fragile ordered wiring ritual.** `_wire()` (`state.py:137-296`) has hidden ordering
  constraints documented only in prose: `_build_wave1_stores()` MUST run before the gateway so
  PriceOverlay/BudgetGate are live (`143-148`, `213-216`) and is deliberately NOT re-called
  (a re-call "would mint a fresh PriceOverlay handle the already-built gateway would not see").
  Temporal coupling with no dependency graph.
- **Post-construction setter injection.** Collaborators are injected by mutating public attrs:
  `self._real_pipeline.notifier` (`state.py:262`), `.automation` (`274`), `.event_bus` (`279`),
  `.poller._primary._event_funnel = self._route_event_feed` (`294`, re-done `1207`).
  `pipeline.py:89/94/102` declare these as `None`. The pipeline is constructible half-wired.
- **Service-locator anti-pattern in engine.** `poller_manager.py:60`
  `__init__(self, state: AppState)` takes the ENTIRE hub and reaches PRIVATE members
  (`_state._schedule_close :247`, `_state.es :247`, `state.es_client_for_source :15`).
  `reset.py` similarly takes `app_state` and calls `_is_sql_backend()` (`reset.py:351`, private)
  + `.es/prefs/update_prefs/rebuild_log_source`. **The tightest coupling in the codebase** —
  neither can be unit-tested/reused without a whole AppState.
- **Routes reach into hub privates.** `routes.py:2713/2731/2737` use `state._kv.put/get` for
  OIDC state (bypassing the store abstraction); `routes.py:1434`, `routes_reset.py:105`,
  `routes_tuning.py:267/333` use `state._real_audit` (with `# noqa: SLF001`);
  `routes_setup.py:188` sets `state._seeded_default_admin`. The `_real_*` vs
  demo-switching-property split (`state.py:97-135`) leaks into routes.
- **Mega-router.** `api/routes.py` is 4751 lines with 84 imports spanning 17 packages (14
  `..connectors`, 11 `..auth`, 8 `..engine`, 7 `..notifications`) — the single most
  broadly-coupled module. The Round-3/4 feature routers (`routes_metrics/standup/tuning/…`
  mounted in `main.py:88-104`) show the good pattern; `routes.py` is the legacy monolith.
- **Demo-store indirection is an implicit contract.** Active-store properties
  (`state.py:97-135`) transparently swap to a demo stack for reads, but every WRITE path that
  must hit the REAL store uses `_real_*` (`_start_receivers :1339`, `_real_audit` writes). A new
  store added to the demo stack must be added in BOTH `DemoStack` AND the property — easy-to-miss.

### Actionable recommendations
1. Add a `tlsoc.notifications` entry-point group mirroring the other two registries (small,
   additive; must keep the fail-safe try/except so a bad plugin can't break startup).
2. Extract the demo/real active-store indirection into a `StoreLocator`/`ActiveStores` object
   so the switch lives in ONE place.
3. Give `poller_manager` and `reset` a NARROW `Protocol` (`PollerContext`/`ResetContext`)
   instead of the whole `AppState` + privates — makes them unit-testable and removes the SLF001
   reach-ins.
4. Promote the 3 setter-injected pipeline collaborators to optional constructor kwargs (keep
   the `None` default for back-compat) so the pipeline is never half-wired.
5. Split `api/routes.py` into per-domain routers (cases, sources, auth/users, settings/branding,
   chat) following the established per-feature pattern.
6. Route OIDC-state persistence + `_real_audit` uses through public accessors (`state.kv`,
   `state.real_audit`) to drop the SLF001 noqas.

### Customization gaps (relevant to G6)
- Notification channels are not operator/third-party extensible without a core edit.
- `settings_schema.py` derives the settings UI from Pydantic Preferences, but there is NO
  machine-readable schema for the pluggable RULE surfaces (correlation/risk/auto-close/tuning)
  — G6 has to be hand-wired per field because those configs live as fixed nested models on
  `config.py`.
- Adding a STATE backend is well-contained (`state.py:357-402` if/elif on a `Literal`) but there
  is no formal `StateBackend` factory/registry — a third-party backend can't register.

### Load-bearing constraints
- Do NOT change the demo/real store split (`state.py:97-135`, `1339`, SLF001 sites); the
  `_write_guard` (`1570`) is the only backstop against demo rows leaking into the real store.
- **#3:** `decide()` byte-identical (already a clean pure fn — untouched by these refactors).
- The KVStore-over-shared-KV pattern (12+ stores built at `state.py:434-495`) is zero-migration
  — preserve that they all share `self._kv` and survive `_wire()` rebuilds.
- The `_wire()` ordering is load-bearing for the cost-ledger #6 guarantee (gateway sees the same
  live PriceOverlay handle) — preserve if extracting wiring helpers.
- `apply_secrets` (`state.py:1386`) tears down and rebuilds via `_wire()` on an ES credential
  change — any `_wire()` change must stay idempotent at runtime.
- **Wide-fan-in god modules** are hard to split: `constants.py` (604 lines, imported by 110
  files), `models.py` (1319 lines, 47 classes, 95 importers), `config.py` (2177 lines, 50
  classes, 60 importers). Fan-in is normal for shared contracts; the SIZE forces broad
  recompiles/retest.

---

## 7. Design Consistency (G2)

**The system exists and is good** (tokenized shadcn/Radix + Tailwind: `theme.css` tokens,
`tailwind.config.js` `elev1`/`elev2` shadows + radius scale, shared primitives `ui/card`,
`ui/button`, `PageHeader`, `HeroPanel`, `KpiTile`, `StatCard`, `SettingsCard`, `DataTable`,
`badges.tsx`). The problem is **inconsistent application across ~40 pages that accreted over 4
build rounds** — the same visual job is done 2–4 ways depending on page vintage.

### Confirmed issues
- **Card primitive not used by ~half the pages (biggest issue).** 44 raw
  `rounded-lg border border-border bg-card` divs vs 66 `<Card>` usages; **18 pages never import
  `@/ui/card`** (Cases, CaseDetail, Models, Roles, Audit, Tuning, Campaigns, BatchJobs, Sessions,
  Users, Scans, Chat, Analytics, Home, Intelligence, Workspace, AdminSessions, Baseline).
  Examples: `Roles.tsx:624`, `Models.tsx:464 & :563`, `Audit.tsx:275`, `Investigate.tsx:691`.
- **Elevation inconsistent as a direct result.** `<Card>` carries `shadow-elev1`
  (`card.tsx:9`) so it floats; the 44 hand-rolled cards are flat. **Four pages MIX both on one
  screen** (Settings, Investigate, Standup, Wizard) — panels on the same page differ in elevation.
- **Padding scale ad-hoc on panels.** Card standard `px-5 py-4` / `px-5 pb-5`. Raw panels use
  `p-3` (17×), `p-4` (10×), `p-5` (17×), `p-6` (49×) with no rule. **CaseDetail.tsx is the
  worst:** 28 cards at `p-6` and 3 at `p-5` (`:2177/:2275/:2320/:2376/:2576`) — visibly roomier
  than every other page.
- **Grid gap disagrees between sibling pages.** `Overview.tsx:490`/`Metrics.tsx:149` `gap-5`,
  `Cost.tsx:652 & :658` `gap-4`; across pages `gap-4` (58×), `gap-5` (38×), `gap-6` (11×) for the
  same "space between cards" job.
- **Section spacing split between `space-y-*` and `gap-*`.** `space-y-6` (38×) vs `space-y-4`
  (42×) vs `gap-6` (11×), no convention.
- **Page title rendered 3 ways / 2 sizes.** `PageHeader` h1 `text-2xl font-semibold`
  (`PageHeader.tsx:50`) vs `HeroPanel` h1 `text-2xl sm:text-3xl` (`HeroPanel.tsx:60`) — a
  dashboard title is a full step larger than every PageHeader page. 26 pages use PageHeader, 4
  use HeroPanel, 3 use TabbedPage's own header; CaseDetail/Overview/Standup/Login/Wizard
  hand-roll headers.
- **Tab / segmented control implemented 3 ways.** `@/ui/tabs` (Models/Sessions/Catalog/
  CaseDetail/Metrics), the TabbedPage helper (Home/Intelligence/Workspace), and 4 hand-rolled
  segmented strips (`Metrics.tsx:399-414`, Cost, Approvals, Investigate, Memory). Metrics mixes
  both on one page.
- **Raw `<button>` bypasses the Button primitive 45×** (Metrics 5, Knowledge 5, CaseDetail 5,
  Overview 4, Standup/Settings/Cases 3 each) vs 192 `<Button>` — hand-coded focus rings/hover
  differ per page.
- **Severity/status chip hand-rolled despite `badges.tsx`.** Only 9 pages import shared
  Severity/Status/VerdictBadge; 5 hand-roll `bg-critical/…` inline (Approvals, CaseDetail,
  Metrics, Overview, Settings).
- **Button variant imbalance — `outline` is the de-facto default:** outline 129×, ghost 58×,
  destructive 40×, secondary 20×, `default` (primary-filled) only 3×. Pages lack a clear
  single primary action. Needs a "one primary CTA per view" convention.
- **Minor:** off-scale radii `rounded-[5px]` one-offs (Overview, Cost, Approvals) and stray
  `rounded-xl` (Login, ChatPanel 4×, TraceTimeline). Primitive radii disagree (Card/Dialog/Tabs
  `rounded-lg`; Button/Input/Select/Badge `rounded-md`) — acceptable as a scale but should be
  documented.

### Actionable recommendations
1. **Adopt `<Card>` as the ONE panel primitive**; codemod the 44 raw cards. This fixes elevation
   AND padding together (primitive standardizes `shadow-elev1` + `px-5 py-4`/`px-5 pb-5`).
   Consider a `variant="flat"` on Card for dense/inline cases (filter bars like `Audit.tsx:275`)
   rather than forcing shadow everywhere.
2. **Make `PageHeader` the single page-title standard;** align `HeroPanel`'s h1 or have HeroPanel
   compose PageHeader. Retire the hand-rolled headers.
3. **Collapse the 4 hand-rolled segmented controls onto `ui/tabs`** (or a shared
   `<SegmentedControl>` wrapper) — identical active/hover/focus everywhere (also §2/§12).
4. **Route ALL severity/status/verdict chips through `badges.tsx`.**
5. **Pick ONE metric tile** (KpiTile top-accent OR StatCard left-accent) as default, document
   the other's niche.
6. **Replace the 45 raw `<button>`s** with `<Button variant=ghost/outline size=sm>`.
7. **Two spacing conventions app-wide:** page-section rhythm `space-y-6`; card-grid gap `gap-4`
   (or gap-5 — pick one). Encode as a `PageShell`/`SectionStack` wrapper.

### Coupling & customization
- Elevation + padding are coupled to card construction — you cannot fix them centrally until
  panels move to `<Card>` (then future look changes = edit `ui/card.tsx` once).
- Pages that hardcode `p-6`/`gap-*`/`text-[10px]` do NOT respond to the `--density-unit` token
  — migrating to primitives is a prerequisite for any density-customization feature (G2→§2/§8).

### Risks
- **CaseDetail.tsx (160KB, 33 raw cards at p-6)** is the highest-risk file — a dedicated
  migration workstream with visual review, not a blind sed.
- Converting flat raw cards to `<Card>` makes them float — that's the GOAL, but a deliberate
  visual change; confirm for dense tables/inline panels.
- Hand-rolled buttons/segmented controls carry working `aria-pressed`/`role=group`
  (`Metrics.tsx:395/403/420`) — preserve when swapping to primitives.
- Hex literals flagged in greps are mostly LEGITIMATE (QRCode black/white, Google/Microsoft
  brand SVGs in `loginParts.tsx`, color-picker defaults in `BrandingEditor`) — do NOT tokenize.
- **273 Vitest specs** may assert specific utility classes — run vitest after each codemod batch.
- **#3:** the Close-with-disposition dialog in CaseDetail must keep POSTing through `decide()`
  while restyling.

---

## 8. Color / Contrast (G1)

**The architecture is clean** (single-source HSL-triplet tokens in `theme.css` light `:root` +
dark `.dark`, surfaced to Tailwind via `tailwind.config.js` and to recharts via `palette.ts`'s
`token()`/`hsl(var(--x))`). **But the light theme has systemic WCAG-AA failures** because
full-strength semantic hues are used as SMALL TEXT on white cards and on 10%-opacity same-hue
washes, plus a branding preset and the dark primary button fail AA.

### Confirmed WCAG-AA failures
- **Light theme, systemic (semantic-hue small text).** `text-{hue}` and the badge
  `bg-{hue}/10 text-{hue}` wash (`ui/badge.tsx:16-22`) on white card (`--card 0 0% 100%`) /
  on the 10% wash — text-xs (12px) needs 4.5:1. Measured (on card / on wash): warning
  **3.24 / 2.92**; medium **3.54 / 3.17**; high **3.83 / 3.39**; success **4.07 / 3.61**; info
  **4.08 / 3.60**; low **4.17 / 3.69**; critical **5.06 / 4.32**. **Everything except
  critical-on-card FAILS 4.5:1.** Affected across nearly every page: `badge.tsx:16-22` (all
  severity/status/verdict/disposition badges), `KpiTile.tsx:85`, `CaseTriageHeader.tsx:46-50`,
  `DemoBanner.tsx:90`, `BudgetCard.tsx:275`, `EnrichmentProvidersEditor.tsx:291`, `alert.tsx:15`,
  `CaseActivityFeed.tsx:50-52`.
- **Branding — `teal` accent preset fails.** `theme-tokens.ts:243` (#0d9488) yields only
  **3.74:1** for white `--primary-foreground` on the button fill (`button.tsx:14`). The comment
  at `theme-tokens.ts:237-239` claiming every preset is "vetted to keep white text at WCAG-AA"
  is FALSE for teal. (azure 4.63, indigo 6.29, violet 5.70, emerald 5.48, crimson 6.29 pass.)
- **Dark theme primary button fails.** dark `--primary` (`theme.css:105`, `217 84% 62%`) with
  white `--primary-foreground` (`theme.css:106`) is only **3.35:1** — the default primary Button
  and destructive links fail AA in dark mode. Dark `critical` badge text-on-tint is **4.26:1**
  (`theme.css:122`), just under 4.5:1.
- **Non-text (1.4.11).** Borders are near-invisible: light `--border 220 18% 90%` = 1.27:1 on
  white; `--input` = 1.37:1; dark `--border` = 1.34:1 — below the 3:1 guidance for essential UI
  boundaries. `--muted-foreground` (`theme.css:35`) is borderline: 6.14:1 on card but 5.72:1 on
  the tinted `--canvas`.

### Root cause — token role-overloading
Each `--{hue}` token is used simultaneously as (a) TEXT color, (b) 10%-wash background, and (c)
SOLID fill with white text (`StatCard.tsx:30-35`, `RiskGauge.tsx:36-37`,
`CaseTriageHeader.tsx:53`, `NotificationBell.tsx:124`, `DangerZone.tsx:342`). A hue bright enough
to read as a solid fill is too light to read as text on white. shadcn's own convention splits
these into `--{hue}` (fill) + `--{hue}-foreground` (text-on-fill); the app reuses the fill hue
as text.

### Actionable recommendations
1. **Adopt Radix Colors scales** as the generator: step 9 = solid fill, step 11 = AA text,
   step 12 = white. Map `--{hue}` = step 9 (fill), add `--{hue}-foreground` (text-on-fill) and a
   new `--{hue}-text` = step 11 for `text-{hue}` badge/chip/delta usage. Drop-in HSL/OKLCH source,
   keeps shadcn/Tailwind wiring, eliminates the hand-tuned light/dark drift (dark passes, light
   fails today).
2. Consolidate the 3 badge/chip patterns (`ui/badge.tsx`, CaseTriageHeader `TONE_TEXT`/
   `TONE_ACCENT`, KpiTile `ACCENT_CHIP`, CaseActivityFeed) onto ONE `tone` map keyed off the new
   `--{hue}-text`.
3. Add a runtime `assertAA(fg,bg)` in `theme-tokens.applyBranding` (reuse `contrastRatio`
   `branding.api.ts:111`) to auto-darken/reject an operator accent that fails 4.5:1 — closes the
   branding hole (the `applyBranding` `theme-tokens.ts:371-400` path currently has NO runtime AA
   guard).
4. Bump input/card border contrast (especially input fields) to ≥3:1 as a conscious decision.

### Distinctiveness (G1 identity)
- Default `--primary` is a generic `#217 88% 50%` azure (`theme.css:30`) — the same hue every
  shadcn clone ships; no ownable brand color for a security product. `accent2`/hero-aurora is
  UNSET (`theme.css:78`) so the login hero falls back to primary blue (monochrome, not branded).
- `palette.ts` includes `accent` in `CATEGORICAL` (`palette.ts:55`), but `--accent` is the
  neutral hover-surface gray (`theme.css:40`) → a chart segment can render near-invisible.

### Risks
- `--{hue}` tokens are used as SOLID fills with white text — any darkening for text-legibility
  must be re-verified as white-on-fill background (StatCard/CaseTriageHeader/RiskGauge/
  NotificationBell/DangerZone).
- `palette.ts` feeds recharts via live CSS vars — visually review donut/stacked-bar adjacency
  after any token change.
- `theme.css` comments assert the light/dark blocks are the byte-for-byte "quiet default"
  baseline and MATERIAL_PACKS "quiet" is identity — a token change alters that; update
  `theme-tokens.test.tsx` and snapshots (see §13).
- Branding `applyBranding` rewrites `--primary`/`--ring` at runtime — a global primary lightness
  change must not break the override path.

---

## 9. Typography / Spacing (G2, and its intersection with G1)

**No first-class typography or spacing scale layer exists:** the app uses Tailwind's default
`fontSize`/`spacing` untouched (`tailwind.config.js` has NO `fontSize`/`spacing`/`lineHeight`/
`letterSpacing` extends), and every page hand-authors sizes/weights/tracking/labels inline.

### Confirmed issues
- **Fonts declared but never loaded (the single biggest type issue).** `tailwind.config.js:57-58`
  sets `sans: ['Inter', …]`/`mono: ['"JetBrains Mono"', …]`, `theme.css:81` sets
  `--font-display: 'Inter'`, and `theme-tokens.ts:103` vets `inter` — but there is NO `@font-face`,
  NO `@import`, NO `<link>` (`index.html:1-10` has no font link; `main.tsx:1` imports only
  `theme.css`; find for woff/woff2/ttf/otf returns nothing). The app renders in the OS system-UI
  fallback; the intended Inter identity never ships and `.text-display`/`.hero-display` OpenType
  features (`theme.css:182/208` `ss01`/`cv01`) are silent no-ops on system fonts.
- **101 arbitrary font-size escapes across 40 files** — a missing scale step. `text-[11px]`×35,
  `text-[10px]`×28, `text-[0.65rem]`×14, `text-[0.6875rem]`×8, `text-[0.7rem]`×7,
  `text-[0.8125rem]`×4, `text-[0.6rem]`×2, `text-[9px]`×1, `text-[0.625rem]`×1, `text-[0.95rem]`×1.
  Worst offenders: `BaselineGauge.tsx` (9), `ChatPanel.tsx:296-670` (8), `CaseTriageHeader.tsx:124-241`
  (5), `ModelsCatalog.tsx` (5), `EnrichmentProvidersEditor.tsx:130-226` (5), `AppShell.tsx:247-576` (4).
  They cluster at ~10–11px because Tailwind's smallest step is `text-xs` (12px).
- **Same value expressed two ways.** 11px is both `text-[11px]` (35×) and `text-[0.6875rem]`
  (8×); ~10px is `text-[10px]` (28×), `text-[0.625rem]` (1×) AND `text-[0.65rem]` (14×, actually
  10.4px). One intended "micro-label" fragments into 3–4 renderings.
- **Eight variants of one "small-caps label" motif** (57 total inline uses): `text-xs font-semibold
  uppercase tracking-wider`×27, `text-[11px] … tracking-wider`×13, `text-xs … tracking-wide`×7,
  `text-[0.65rem] … tracking-widest`×7, `text-[11px] … tracking-wide`×4, `text-[10px] …
  tracking-wider`×3, `text-[0.6rem] … tracking-widest`×2, `text-[10px] … tracking-wide`×1. Even
  shared primitives disagree: `PageHeader.tsx:46`, `KpiTile.tsx:63`, `StatCard.tsx:57`,
  `table.tsx:80`, `CaseTriageHeader.tsx:124`. **No shared `<Eyebrow>`/`<Label>` component exists.**
- **Heading sizes drift — no shared heading component.** 3 `<h1>`, 31 `<h2>`, 19 `<h3>`, 2 `<h4>`
  hand-styled; raw-heading font-size splits across `text-sm`×22, `text-xs`×13, `text-lg`×8,
  `text-base`×4, `text-3xl`×2, `text-2xl`×2, `text-xl`×1. Three "title" sizes with no rung labels
  (`PageHeader.tsx:50` text-2xl, `HeroPanel.tsx:60` text-2xl sm:text-3xl, `card.tsx:33` CardTitle
  text-base).
- **Dead/unused type system pieces.** `.text-display`/`.text-display-xl`/`.text-display-lg`
  (`theme.css:177-197`) have ZERO usages; `.hero-display` (`theme.css:204-212`) used exactly ONCE
  (`Overview.tsx:548`) — and even there it's a no-op without Inter. `font-display` family
  (config `:61`) effectively unused.
- **Radius scale dead.** `--radius-sm/md/lg/xl` (`theme.css:66-69`) + `rounded-r-*`
  (`config:51-54`) — `rounded-r-*` used 0 times. Real usage: `rounded-md`×171, `rounded-lg`×113,
  `rounded-full`×69, `rounded`×46, `rounded-sm`×30, `rounded-xl`×7 — the operator-tunable radius
  scale doesn't drive the chrome.
- **Density unit dead.** `--density-unit: 0.25rem` (`theme.css:71/137`) is in `ALLOWED_TOKENS`
  (`theme-tokens.ts:91`) but referenced by NOTHING — the intended density knob has no effect.
- **Card body padding inconsistent** (mirrors §7): `card.tsx:22/54/63` `px-5 py-4`, but page-level
  card-ish containers use `p-6` (61×/14 files), `p-5` (14 files), `p-4` (16 files) roughly equally.
- **Fractional (4px-grid) spacing is pervasive, so the "8px grid" is really a 4px grid.**
  `space-y-1.5` (6px)×164 is the most common vertical rhythm; `gap-1.5` (6px)×124, `gap-2.5`
  (10px)×21, `px-1.5`×20, `py-2.5` (10px)×20, `py-0.5`×19, `p-3.5` (14px)×4. 6px/10px are not
  8px-grid steps — the docs describe an 8px grid the code doesn't follow.
- **Line-height largely unmanaged.** `leading` set only ~73× total (`leading-relaxed`×53,
  `leading-none`×10, `leading-tight`×6, `leading-snug`×4) against 850+ text-size usages; most text
  inherits Tailwind per-size default leading with no deliberate rhythm.

### Actionable recommendations
1. **Introduce ONE typographic primitive layer** in `ui/` (`<Heading level>`, `<Text variant>`,
   `<Eyebrow>`, `<Label>`, `<Metric>`); route PageHeader/HeroPanel/KpiTile/StatCard/CardTitle/
   TableHead through it — collapses the 8 label variants + 7 heading sizes.
2. **Extend `tailwind.config.js` `fontSize` with a NAMED SOC scale that ADDS the missing sub-xs
   rungs** (not remapping existing ones): `micro: ['0.6875rem', {lineHeight:'1rem'}]` (11px, kills
   35+8), `2xs: ['0.625rem', {lineHeight:'0.875rem'}]` (10px, kills 28+14+1). One change retires
   ~90 of 101 escapes. **Use the `[size, {lineHeight}]` tuple form** so leading is bundled.
3. **Collapse the label motif to ONE spec** applied via `<Eyebrow>`/`<Label>`.
4. **Make CardHeader/CardContent padding the single card standard** (refactor page-level p-6/p-5/p-4
   to `<Card>` or a `padding` prop).
5. **EITHER load Inter + JetBrains Mono (self-hosted woff2 via `@font-face`) OR drop the
   Inter/JetBrains declarations + `.text-display` OpenType features** and standardize on system
   fonts. The config currently lies about the type identity — pick one truth.
6. **Delete OR wire the dead surface** (`.text-display*`, `rounded-r-*`, `--density-unit`) — either
   way, reduce complexity (G8/G9).

### Customization gaps
- `--density-unit` is presented as a density knob but drives no spacing utility.
- `--font-display`/FONT_ALLOWLIST lets an operator "pick" Inter, but Inter isn't loaded — the
  selection can't take effect.
- No typographic-density / text-size preference (compact vs comfortable) despite the density token.
- Finer radius steps (`--radius-sm/md/lg/xl`) have no visible effect (only the legacy `--radius`
  anchor reaches the chrome).

### Risks
- **ADD named rungs; do NOT remap Tailwind's default `xs`/`sm`** — remapping reflows the entire app
  + every snapshot.
- `theme-tokens.ts` `ALLOWED_TOKENS` is a security allow-list (#10) — any new typography token must
  be added deliberately; font-family stays constrained by FONT_ALLOWLIST (#9/#10).
- If self-hosting Inter, load the variant that contains `ss01`/`cv01` or the features stay no-ops.
- Bulk find/replace must map values correctly (0.65rem = 10.4px, not 10px; 0.6875rem = 11px) —
  a naive replace silently changes sizes. Snapshot/visually diff after.
- Keep sizes ≥11px and verify muted-foreground label contrast (WCAG AA on the grid).

---

## 10. Accessibility (a11y)

**Baseline is strong** (proper `focus-visible` rings everywhere, a real skip-link + main
landmark, WAI-ARIA disclosure nav, sortable-table `aria-sort` + keyboard rows, `role="img"`+labels
on all charts, global `prefers-reduced-motion` + `prefers-reduced-transparency`). But **two
systemic defects recur** and a handful of contrast values miss AA.

### Confirmed issues
- **Systemic contrast fail (light theme) — colored badges** (see §8 for the numbers).
  `ui/badge.tsx:16-22` renders solid-hue text on a same-hue 10% tint; on white card all 7 hues
  except critical fail 4.5:1 for text-xs. Badges appear on nearly every page. **Fix:** darken the
  light-theme severity text tokens (`theme.css:50-56`) or add a `--*-badge-fg` per hue ≥4.5:1.
- **Systemic missing form-control names.** ~39 form fields have a visible `<Label>` NOT
  programmatically associated (no `htmlFor`/`id`) AND no `aria-label` — screen readers announce no
  name. Concentrated in the rule/automation builder (a G6 area): `Settings.tsx:1544` (Verdict),
  `:1562` (Status), `:1580` (Minimum risk), `:1596` (Minimum severity), `:1611` (Entity type),
  `:1657` (Action), `:1682` (Tags), `:1700` (Recommendation), `:1722` (Playbook), `:1751` (Proposal
  kind), `:1943` (IOC threshold); `Security.tsx:158/162/167/173/219` (OIDC Inputs);
  `CaseDetail.tsx:1368` (Model), `:1463` (Playbook); `Memory.tsx` (2). **Fix:** `id`+`htmlFor`
  pairs, or `aria-label`/`aria-labelledby` on Radix `SelectTrigger`, using `React.useId()`.
- **Marginal contrast (dark).** dark `critical` badge text-on-tint 4.26:1 (`theme.css:122`);
  primary-foreground white on dark `--primary` (`theme.css:105`) 3.35:1 — default Buttons + primary
  Badges fail AA in dark.
- **Tiny text.** 62 `text-[10px]`/`text-[11px]` occurrences (BaselineGauge 9,
  EnrichmentProvidersEditor 5, AppShell 4, Settings/Catalog/Approvals 3 each). 10px is below the
  12px floor and compounds with `text-muted-foreground`. **Fix:** ≥12px for non-decorative labels.
- **Avatar `alt=""`** (`AppShell.tsx:238`, `Account.tsx:127`) — defensible as decorative; give
  Account.tsx a meaningful `alt` (minor).
- **Toast/live-region gaps.** Only 4 explicit `aria-live` regions exist (`AppShell.tsx:563`,
  `SettingsGrid.tsx:159`, `ChatPanel.tsx:1010`, `loginParts.tsx:103`). sonner is accessible by
  default, but page-level async error/empty/loading changes (Cases, Metrics, Overview) are NOT
  wrapped — screen-reader users aren't told when a table finishes loading or an inline error
  appears. **Fix:** wrap page-level status/error banners in `role=status`/`role=alert` (the
  `<Alert>` primitive already sets `role=alert` — see §12).

### Exemplary patterns (preserve these)
`button.tsx:8-10` (focus-visible ring on all variants), `DataTable.tsx:310-338/379-401`
(aria-sort + keyboard rows), `NavSidebar.tsx:340-360` (disclosure aria-expanded/aria-controls +
aria-current), `AppShell.tsx:461-470/600` (skip-link + `<main id="socMain" role="main">`),
`KpiTile.tsx:104-119` (semantic button/div switch), `CommandPalette.tsx:192-353` (cmdk + Radix
focus trap), `Login.tsx:437-579` (htmlFor/id/autoComplete/aria-describedby), `SwitchPref`
(`Settings.tsx:567-594`, passes `aria-label` to Switch), `theme.css:272-299` (reduced-motion +
reduced-transparency), all chart/gauge SVGs (`role="img"` + aria-label).

### Actionable recommendations
1. **A tiny `<Field label=…>{control}</Field>` wrapper** (like SwitchPref) that auto-generates a
   `useId()` and wires `htmlFor`/`id` + `aria-describedby` — reused across Settings/Security/
   CaseDetail/Memory rule/config forms, eliminating the whole class of defect AND shrinking
   Settings.tsx (supports G3 + G8). The Input primitive already forwards `id`.
2. Standardize page-level error/empty banners on the `<Alert role=alert>` primitive (`alert.tsx:30`)
   — gains the live-region announcement for free (§12).
3. Fix badge contrast once in `theme.css`/`ui/badge.tsx` — every consumer inherits it (§8).

### Customization gaps
- **G6 rule builder is exactly where the unlabeled-control defects cluster** (`Settings.tsx
  ~1500-1760`; auto-close/tuning ~1120-1145, 1940-1950) — new customization must ship with proper
  labels/aria from the start or it's unusable for keyboard/AT users.
- **G7 custom dashboards** must expose keyboard-operable move/resize (roving tabindex + arrow keys)
  and per-widget accessible names — no existing keyboard-DnD pattern to reuse; build it accessibly.
- No user-facing font-size/density preference (`--density-unit` exists but isn't user-exposed) —
  combined with the 62 `text-[10px]` usages, users needing larger text have no in-app remedy.

### Risks
- Use **stable per-instance ids** (`React.useId`) — hardcoded ids in repeated rule rows collide
  and BREAK label association.
- The global reduced-motion rule (`theme.css:273-280`) sets `transition-duration ~0 !important` on
  ALL elements incl. `::before`/`::after` — re-test Radix Select/Dialog/Sheet open state under
  reduced-motion (code uses data-state animations, so should be safe).
- Keep existing a11y specs green (`NavSidebar.test.tsx` asserts aria-expanded/aria-current; target
  273 passing).
- **#9:** badges/PageHeader already render UNTRUSTED values as plain text — any contrast/label
  refactor must not introduce `dangerouslySetInnerHTML` or relax that.

---

## 11. Responsive / Width Strategy (G4)

**Surface:** `AppShell` content cap, `NavSidebar` mobile behavior, grid/breakpoint ceilings,
dialogs/sheets/tables, hero band. The SPA renders every page in a fixed left sidebar + a single
centered content column; content width is hard-capped and grids almost never scale past `lg`
(1024px), so wide monitors waste horizontal margins while there is effectively **no phone/tablet
story** and **zero responsive tests**.

### Confirmed issues
- **Hard width cap wastes ultrawide space.** `mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6`
  (`AppShell.tsx:601`). Every page centers in 1400px → ~520px dead margin at 1920px, ~1160px at
  2560px. No ultrawide tier, no per-page opt-out for data-dense pages (Cases/Metrics/Cost).
  *(Same lever as §2 G4.)*
- **Grids do not scale past `lg`.** `2xl:` used **0 times**, `xl:` only ~20, `lg:` 84. Column
  ceilings are `lg:grid-cols-*` (Overview `Overview.tsx:490/503/606/720`; Cases KPI row
  `grid-cols-2 … lg:grid-cols-4` `Cases.tsx:872`; Metrics tops at `lg:grid-cols-6` with only 2 `xl:`
  overrides). At 1280px+ most grids stop adding columns and inflate cell whitespace — the exact G4
  problem.
- **NavSidebar has NO mobile/responsive treatment.** `sticky top-0 flex h-screen shrink-0 … w-16 /
  w-60` with NO breakpoint prefix and NO off-canvas drawer (`NavSidebar.tsx:552-557`); `AppShell`
  renders it inline (`AppShell.tsx:472-483`). On a 375px phone even the collapsed 64px rail steals
  ~17% of the viewport permanently; the 240px expanded drawer leaves ~135px for content. No
  hamburger-opens-overlay pattern.
- **Settings sidebar only collapses at `lg`.** `grid gap-6 lg:grid-cols-[224px_minmax(0,1fr)]` /
  `256px…` (`Settings.tsx:2377/2563`) — single-column 768–1024px, then a rigid 256px rail; never
  widens or adds a third column on wide screens. `SettingsGrid` caps at `xl:grid-cols-3`
  (`SettingsGrid.tsx:39`) so the grid grows, but the page frame doesn't.
- **Dialog has no small-screen margin/scroll fallback.** `fixed left-1/2 top-1/2 … w-full max-w-lg
  -translate-x-1/2` (`dialog.tsx:37`) with no `w-[calc(100%-2rem)]`/`mx-4` and no `max-h`/scroll —
  edge-to-edge on <512px, tall dialogs overflow with no internal scroll.
- **Hero band wastes vertical space (ties G5).** `HeroPanel` `p-6 sm:p-8` + `flex-col gap-5` +
  2xl/3xl title (`HeroPanel.tsx:46/60`); `CommandCenterLayout` stacks hero + strip + body each
  `gap-6` (`layouts.tsx:43-47`); footprint doesn't shrink on shorter/denser viewports.
- **Media coverage thin and untested.** Almost entirely `sm:` (181 uses), big gap at `md:` (11),
  nothing at `2xl:` — most layouts jump 1-col → `sm:`/`lg:` with the 768–1024px tablet band
  underserved. **ZERO responsive tests** (no matchMedia/resize/innerWidth specs) — G9 unmet for
  this axis.
- **Tablet dead-zone:** iPad-portrait (768px) shows single-column cards in a ~500px content column
  (sidebar 240px + `lg:` grid at 1024px).

### What already works (reference patterns)
- Tables scroll horizontally on mobile — `DataTable.tsx:278` `overflow-hidden` over `table.tsx:8`
  `relative w-full overflow-auto` (correct; don't nest more overflow containers).
- Sheets are full-width on mobile, capped on desktop — `ui/sheet.tsx:55-64` `w-full max-w-*`
  (mirror this idiom).
- Login split — `grid min-h-screen lg:grid-cols-2` + `hidden`/`lg:` hero (`Login.tsx:796`) — the
  reference responsive split.
- `theme.css:186-198` clamp() display typography — breakpoint-free responsive text (reuse the
  approach for hero padding to compact G5).
- **`.container` config is a red herring:** `tailwind.config.js:8` sets `container` with
  `2xl: '1440px'`, but `.container` is essentially UNUSED (only a comment hit in RiskGauge). The
  real cap is the `AppShell` literal — do NOT "fix" the config and assume the layout changed.

### Actionable recommendations
1. **Centralize the width cap in ONE `<PageContainer variant='default'|'wide'|'full'>` primitive**
   so pages opt into wide/full instead of fighting a global edit (also G8). Extend the
   `layouts.tsx` archetypes with an optional `wide` prop.
2. Adopt `ui/sheet.tsx`'s `w-full max-w-*` idiom as the standard responsive-container pattern; use
   the Login split as the two-pane reference.
3. Add a **`useMediaQuery`/`useIsMobile` hook** (none exists) so NavSidebar/dialogs/layouts share
   one breakpoint source of truth; add a mobile off-canvas drawer for NavSidebar as a SEPARATE
   transient state (do NOT persist it — it would fight the desktop collapsed pref on resize).
4. Give Dialog a small-screen margin + `max-h` + internal scroll.
5. Add responsive tests (G9).

### Customization gaps
- No user/operator control over density or width despite the UserPrefs cascade (a natural home for
  a density + max-width preference).
- The fixed 1400px cap + lg-ceiling grids would constrain any G7 grid-based dashboard builder from
  using ultrawide real-estate.
- Nav collapse is user-persistable but there's no responsive/auto-collapse policy exposed as a
  setting.

### Risks
- Changing `max-w-[1400px]` affects EVERY page — line-length on prose/forms (Settings, Account,
  Knowledge) gets too wide if uncapped globally. Widen via a per-page opt-in, not removal.
- NavSidebar collapsed state persists to localStorage + server `UserPrefs.misc` (`useNavPrefs`
  `NavSidebar.tsx:109-204`) — a mobile-overlay mode must be transient.
- Preserve `min-w-0` on flex/grid children (`AppShell.tsx:486`, `layouts` min-w-0) or added columns
  overflow instead of wrapping. HeroPanel/layouts are shared — compacting globally changes the
  dashboard AND every archetype consumer.
- Run vitest after breakpoint retunes (snapshot/class-assert tests in `__tests__`).

---

## 12. States — Loading / Empty / Error

**The webui ships good canonical primitives for all three async states** (`EmptyState.tsx`
default + error variant; `skeleton.tsx` Skeleton/SkeletonCard/SkeletonRow; `LoadingBar.tsx`;
`PageSkeleton.tsx`; `ui/alert.tsx` default/destructive/warning; `DataTable.tsx` built-in skeleton +
empty slot; global reduced-motion). The problem is **inconsistent application across ~40 pages** —
three error idioms, plain-text vs skeleton vs spinner loading, arbitrary retry, and a
25-way-duplicated error helper. Directly relevant to G2 and G9.

### Confirmed issues
- **Error rendering splits three ways with no rule.** (a) `<Alert variant="destructive">` used by
  19 pages (`Sources.tsx:200`, `Cases.tsx:1091`, `Audit.tsx:360`, `Metrics.tsx:863`, `Cost.tsx:673`,
  `Inbox.tsx:472`, `Memory.tsx:875`, `Knowledge.tsx:349`, `Investigate.tsx:618`, `Catalog.tsx:184`,
  `CaseDetail.tsx:1623`, Overview, Standup, Approvals, Scans, Account, Settings, Login, Wizard).
  (b) `<EmptyState variant="error">` used by 4 (`Campaigns.tsx:247`, `BatchJobs.tsx:212`,
  `Tuning.tsx:416`, Settings). (c) plain `<EmptyState>` with NO error variant/retry for a failure —
  `Baseline.tsx:75`. Same failure looks different per page.
- **Load failure is silent (toast-only) then falls through to a misleading empty state.**
  `Roles.tsx:138`, `Users.tsx:114`, `AdminSessions.tsx:82`, `Models.tsx:107` only `toast.error(...)`
  on the initial-load error — after the toast dismisses, the DataTable shows "No results"
  (`DataTable.tsx:367`), so a backend outage is indistinguishable from genuinely-empty data.
  Contrast `Cases.tsx:1090`/`Inbox.tsx:471` (persistent error panel).
- **Loading indicator inconsistent: skeleton vs spinner vs plain text.** Plain-text "Loading…"
  (worst — layout shift): `BudgetCard.tsx:174`, `BrandingEditor.tsx:702`, `Models.tsx:554`,
  `NotificationBell.tsx:274`, `SourceEditor.tsx:1519`. Inline spinner+text: `Baseline.tsx:72`.
  Proper layout-mirroring skeletons (good): `Overview.tsx:488`, `Metrics.tsx:147`, `Cost.tsx:650`,
  `Standup.tsx:344`, `Inbox.tsx:485`, `CaseTriageHeader.tsx:350`, `NotificationPrefs.tsx:205`,
  `SessionPolicyEditor.tsx:148`.
- **Retry affordance arbitrary.** WITH retry: `Inbox.tsx:477`, `Campaigns.tsx:253`, BatchJobs,
  Tuning, `Cost.tsx:676`, `Catalog.tsx:189`, CaseDetail, Overview, Account. WITHOUT (must reload
  the whole page): `Sources.tsx:200`, `Cases.tsx:1091`, `Audit.tsx:360`, `Metrics.tsx:863`,
  `Knowledge.tsx:349`, `Memory.tsx:875`, `Investigate.tsx:618`, `Baseline.tsx:75`.
- **Error-message helper duplicated 25× with 3 names and 2 signatures.** `errMsg(e, fallback)`:
  Account/AdminSessions/Baseline/BatchJobs/Campaigns/Inbox/Memory/Models/Roles/Sessions/Settings/
  Tuning/Users + BrandingEditor/BudgetCard/EnrichmentProvidersEditor/NotificationPrefs/
  NotificationsEditor. `errorMessage(e)`: Sources/Wizard/SourceEditor/SourceLogsSheet/
  UnifiedLogsSheet. `errMessage(e[, fallback])`: Catalog/Knowledge. **No shared helper in
  `webui/src/lib` despite `ApiError` at `lib/api.ts:152`.** Inline ad-hoc variants too
  (`Cases.tsx:1095`, `Audit.tsx:364`, `Metrics.tsx:866`).
- **Error-alert icon + title ad-hoc.** Icons: AlertTriangle (39), AlertCircle (`Inbox.tsx:473`, 9),
  ShieldAlert (`Campaigns.tsx:249`). Titles vary ("Something went wrong" `Sources.tsx:202`, "Could
  not load cases" `Cases.tsx:1093`, "Investigation failed" `Investigate.tsx:619`). Some destructive
  Alerts omit the icon (`Investigate.tsx:618`, `Metrics.tsx:863`).
- **Two different empty-state visuals.** Canonical `EmptyState.tsx` (bordered/tinted icon chip +
  semibold title + muted description) vs DataTable's built-in fallback (`DataTable.tsx:364-369`, a
  smaller un-chipped Inbox icon at opacity-40 + a lone "No results" span).
- **Empty/error/loading precedence differs per page.** Some error-first (`Campaigns.tsx:246`), some
  loading-first (`Baseline.tsx:70`), some error-above-skeleton (`Inbox.tsx:471`), some error only
  after skeleton clears (`Metrics.tsx:858`). No documented "loading > error > empty > data" order.
- **Refresh-without-flicker exists but isn't standardized.** `UnifiedLogsSheet.tsx:150` and
  `SourceLogsSheet.tsx:120` take a `showSkeleton` flag so a manual refresh keeps content and spins
  the Refresh button; most dashboards (Overview/Metrics/Cost) hard-swap to a full skeleton on every
  reload, blanking the screen.

### Actionable recommendations
1. **One shared `errorMessage(e, fallback = 'Something went wrong')`** in `webui/src/lib` (built on
   `ApiError`); delete the 25 local copies.
2. **Promote `Catalog.tsx:179` `LoadError`** (destructive Alert + AlertTriangle + title + message +
   always-present Retry) to `soc/components/LoadError.tsx` and use it for EVERY full-panel fetch
   failure — one error look/icon/title.
3. **Standardize page loading via SkeletonCard/Skeleton layout-mirroring grids** (Overview/Metrics
   are the reference); replace every plain-text "Loading…".
4. **Route ALL table/list empties through `DataTable empty={<EmptyState compact …/>}`** (as
   `Cases.tsx:1122`); optionally make DataTable's default fallback render a compact `<EmptyState>`.
5. **Reuse the `showSkeleton`-on-refresh idiom** as the default refetch behavior for dashboards.
6. Consider one `<AsyncBoundary loading error empty onRetry>` wrapper encoding "loading > error >
   empty > data" (also §5's `useAsync`).

### Risks
- Keep exactly ONE alert role per rendered error — both `EmptyState.variant='error'`
  (`EmptyState.tsx:44`) and destructive `Alert` (`alert.tsx:30`) set `role='alert'`; don't
  double-announce.
- New loading components must rely on existing shimmer/`animate-*` classes to stay reduced-motion
  safe (`theme.css:272`) — no inline JS animations.
- DataTable's `loading` skeleton + `empty` slot are consumed by 12 tables — changing the default
  empty must stay backward-compatible with callers that pass `empty=`.
- When adding persistent error UI to the silent-toast pages, ensure a genuinely-empty result still
  shows the normal EmptyState (not an error) — the inverse of today's bug.
- 273 Vitest specs may assert current copy/markup — verify after consolidation.
- **#3:** no state change touches `decide()`.

---

## 13. Terminology Consistency

**The webui labels the same domain concepts with different words on different surfaces.**
CLAUDE.md claims a Round-4 "terminology cleanup" landed, but it's only partly reflected in shipped
UI strings — "rule" is overloaded across six concepts, and "correlation/clustering/detection" are
used interchangeably. There is a real terminology-override subsystem that is almost entirely
un-wired, so the org-rename feature can't fix most labels. Undermines G2 + G3.

### Confirmed issues
- **Overloaded "rule" — six distinct concepts, mostly no disambiguating adjective:**
  (a) case-automation rules — `Settings.tsx:1824` "Threshold automation", `:1848/:1859`
  ("No automation rules"); (b) detection-rule catalog — `Settings.tsx:1301/1312`, `Catalog.tsx:337`
  ("rule: {r}"); (c) suppression rules — `Settings.tsx:1299/1306/1307`; (d) auto-forward allowlist
  "rule values" — `Settings.tsx:1249/1260/1263`; (e) OCSF source field mapping — `Settings.tsx:756`
  ("Rule / module field"), `:757`, `:1638/:1642`; (f) tuner-tracked correlation rules —
  `Tuning.tsx:407/457/548`.
- **"Advanced" blurb double-counts "rule."** `Settings.tsx:350` lists "suppression rules" AND "rule
  catalog" as distinct, but the section header `Settings.tsx:1299` "Suppression & rule catalog"
  collapses them into one card — three names for two things.
- **"detection" means three things** — `Settings.tsx:246-248` "Detection & correlation" (core
  triage config) vs "detection rule catalog" (`Settings.tsx:1301/1312`) vs the EVENT-feed
  "detection" funnel.
- **"correlation" vs "clustering" vs "auto-investigate" used interchangeably.** `Settings.tsx:248`
  ("Clustering, … cross-source correlation"), `:903` anchor "Correlation", `:922` card
  "Correlation", `:975` "Cross-source correlation", `Tuning.tsx:407` "a correlation rule". The knob
  at `Settings.tsx:927` is "Threshold (N)" under "Correlation" but the concept is elsewhere
  "clustering". The planned rename didn't reach these labels.
- **Campaign page contradicts itself.** `Campaigns.tsx:237` AlertTitle "Campaign clustering is off."
  but the primary button `Campaigns.tsx:227` is "Recorrelate" (state `recorrelating` `:113/:123/:221`,
  toast `:118` "Re-correlated: N campaigns"). Two verbs on one screen.
- **"Security Posture Dashboard" duplicated across two pages.** `Overview.tsx:2 & :551` title vs
  `Metrics.tsx:462` "…and security posture." (relates to G4/G5 — §2/§13/§14).
- **"scan" is an orphan term.** `Scans.tsx:373/429/583`, `nav.ts:179` "Automated scans" — but the
  mechanism is polling/ingestion + the EVENT detection funnel; "scan" appears nowhere else in the
  domain vocabulary (not in DEFAULT_TERMS).
- **Nav host labels don't match child labels / page titles.** `nav.ts:170-178` labels the `chat`
  item "Workspace" but the page is "Chat"; `nav.ts:209` labels `metrics` "Analytics" but the page
  is "Metrics". The breadcrumb noun changes mid-navigation. `nav.ts:252` tuning rail "Auto-tuning"
  vs `Tuning.tsx:392` "Adaptive tuning" vs `Tuning.tsx:494` "Enable auto-tuning" — three labels.
- **Two tabs both called "Dashboard."** `nav.ts:11` comment (overview) and `:205` comment
  (Analytics) both use "Dashboard"; the rail child labels partially fix it (`:155` "Dashboard" under
  Overview, `:212` "Metrics" under Analytics) but the comments + the "Security Posture Dashboard"
  title keep the collision alive.
- **The terminology-override system is essentially un-wired.** `prefs.tsx:35-44` DEFAULT_TERMS
  defines only case/cases/alert/alerts/source/sources/analyst — MISSING event, detection, campaign,
  case-automation, rule, verdict, disposition. The `t()` helper (`prefs.tsx:229-235`, `useTerm`
  `:284`) is called in only ONE real place (`Cases.tsx:847 & :876`, `t('cases')`); every other
  apparent hit is a false positive. `CustomizationSection.tsx:43-50` TERM_KEYS exposes the SAME 7
  nouns to admins — so the "call a case an incident" feature (`CustomizationSection.tsx:216`) can't
  touch any confused term.
- **"alert" noun inconsistent with the two-tier ALERT/EVENT model.** Copy still says "raw alert
  volume" generically (`Wizard.tsx:190/397`, `Overview.tsx:553` "alert load", `CaseDetail.tsx:2036/
  2045` "Alerting & notifications", `Settings.tsx:283` "Alerting & notifications"). "Alert" is used
  as (a) ingest tier, (b) outbound alerting, (c) generic synonym for events — none disambiguated.
- **Catalog cross-reference vs stale Settings label.** `Catalog.tsx:424-425` says "Settings →
  Threshold automation" (matches the CARD `Settings.tsx:1824`), but the SECTION is "Automation"
  (`Settings.tsx:262`, blurb `:263`). One feature: "Automation" (section) / "Threshold automation"
  (card) / "automation rules" (empty state).

### Actionable recommendations
1. **Establish ONE canonical glossary:** extend `prefs.tsx` DEFAULT_TERMS to include event,
   detection, detection_rule, alert, case, campaign, case_automation, correlation, suppression,
   verdict, disposition; route top-traffic labels through `useTerm()`/`t()` so there's one place to
   enforce consistency AND power the admin-rename feature.
2. **One verb per concept:** "clustering" for intra-source grouping (retire "Correlation" card
   title `Settings.tsx:922` OR vice-versa), "campaign correlation" for the cross-case pass; make
   `Campaigns.tsx` use ONE verb consistently (button vs alert).
3. **Namespace "rule" with a mandatory adjective everywhere:** "case-automation rule",
   "detection rule", "suppression rule", drop "rule" from auto-forward ("auto-forward value"
   `Settings.tsx:1249-1263`), rename the OCSF field mapping (`Settings.tsx:756-757`) to
   "signature field"/"detection-name field" (it is NOT a rule).
4. **Align each nav host label with its page title** (rename pages or rail items); consolidate the
   two "Dashboard" meanings into "Overview" (posture) vs "Metrics/Analytics".
5. **Unify the tuner's three labels** to one ("Auto-tuning") across `nav.ts:252`, `Tuning.tsx:392`,
   `Tuning.tsx:494`.

### Customization gaps
- The org-rename feature covers only case/alert/source/analyst — it CANNOT rename the
  highest-confusion terms (event, detection, campaign, rule, detection-rule, case-automation,
  verdict, disposition, correlation/clustering). For G6, the rule vocabulary needs stable, distinct,
  renameable names first.
- No canonical glossary maps wire-keys (`auto_correlate`, `threshold_automation`, `correlation.n`,
  `severity_floor`) to their user-facing noun, so contributors keep inventing labels ("scan",
  "clustering", "recorrelate", "auto-forward rule value").

### Load-bearing constraints
- **Wire keys / request-body field names MUST NOT change:** `threshold_automation`,
  `auto_correlate`/`correlate`/`auto_investigate`, `default_correlation.n`, `severity_floor`,
  `rule_field`/`rule_name_field` (OCSF mapping), `config['index_patterns']`. Relabel UI strings
  only — keep aliases + wire keys.
- **#3:** terminology fixes touch webui strings + the prefs glossary only, never `decide()`.
- Section anchor IDs (`detection-correlation`, `advanced-suppression`, `tuning-policy`) are
  deep-link/scroll targets (`Settings.tsx:903-907`, `Catalog.tsx:424`, `CaseDetail.tsx:2036`) —
  renaming the anchor id (not just the label) breaks cross-page links.
- Introduce NEW DEFAULT_TERMS keys rather than repurposing existing ones — changing the DEFAULT for
  an existing key ("cases") silently renames an already-shipped label for every tenant.
- **#9:** terminology values are user-supplied, already rendered as plain text (`prefs.tsx:15`) —
  keep it that way.

---

## 14. Tests Baseline (G9)

**Which tests the overhaul will break, so the redesign doesn't silently regress them.** The webui
vitest suite (43 spec files under `webui/src/**/__tests__`) is where the risk lives — many specs
hardcode exact user-facing strings, exact Tailwind classes, exact CSS token names, and even
`readFileSync` component source statically. The backend pytest suite (~140 files) is pure API/logic
(HTTP status + JSON wire-keys + config values, NO DOM) — **a pure UI redesign will not break
backend tests** unless it renames config wire-keys or settings-schema field names.

### Confirmed brittle assertions (highest risk first)
- **Hero title string (breaks G4/G5).** The exact string `'Security Posture Dashboard'` is asserted
  in THREE places — `App.smoke.test.tsx:94` and `:104`, and `settings.render.test.tsx:177`; produced
  at `Overview.tsx:551`/`:2`. G5 wants this hero compact; renaming/removing it breaks the primary
  "does the app boot at all" smoke test. **Update the assertion in lockstep — do NOT delete the test
  (it's the boot-smoke safety net; deleting it could mask a white-screen ship).**
- **Nav labels + tree topology (breaks G3).** `NavSidebar.test.tsx` hardcodes exact labels via
  `getByRole('button',{name:…})` — "Overview" (`:157/:171`), "Dashboard" (`:101/:121/:184`),
  "Standup" (`:102/:118/:185`), "Cases" (`:128/:129`), "Metrics"+"Analytics" (`:142/:143`),
  "Chat"+"Workspace" (`:149/:150`) — from `nav.ts` label fields (`:144-270`). It pins topology:
  Overview→{Dashboard,Standup} (`:83/:101-102`), Cases childless (`:128-129`), host==child
  collisions Analytics→Metrics (`:137-144`) and Workspace→Chat (`:146-151`). Reorganizing groups,
  renaming items, flattening submenus, or moving Dashboard/Standup all break this file. **Its
  aria-expanded/aria-controls/aria-current assertions are the real load-bearing value — preserve
  those; the labels are incidental.**
- **Tab-strip labels + order (breaks G4).** `analytics-consolidation.test.tsx:115-124` asserts
  EXACTLY four tabs (/operational/, /performance/, /posture/, /^cost$/) AND
  `getAllByRole('tab').toHaveLength(4)`, plus copy /detailed cost ledger/ (`:135/:149/:153/:169`),
  /by model/ (`:136`), /verdict mix/ (`:143`), a button /cost tab/ (`:146`). Consolidating/renaming/
  reordering Metrics tabs breaks 5 tests.
- **Posture tile + section labels (breaks G4/G5).** `metrics-posture.test.tsx` pins "MTTA (p50)"
  (`:171`), "Dwell (p50)" (`:177`), "FP rate" (`:183`), "SLA attainment" (`:202`), /MITRE ATT&CK
  coverage/ (`:194`), tab names (`:166/:190`), a link /export att&ck navigator layer/ →
  `/api/mitre/coverage/navigator.layer.json` (`:198-199`), and value strings '45m'/'3h'/'63%'
  (`:172-174/:184`).
- **Exact Tailwind utility classes (breaks G1/G2).** `RiskGauge.test.tsx` asserts 'stroke-muted'
  (`:38`), 'text-low'/'text-medium'/'text-high'/'text-critical' (`:109-124`), 'justify-end' +
  '.absolute.inset-0' (`:157-159`), and SVG structure (exactly 2 `<path>`, no
  `<linearGradient>`/`<defs>`, `stroke='currentColor'`). `ui-glitch-fixes.test.tsx:82-87` asserts
  SettingsCard carries 'min-w-0'/'flex-1'/'break-words'. `theme-tokens.test.tsx:214` asserts
  GlassSurface has 'glass-surface', `:228` 'border'/'border-border/70', `:221-222` inline
  'var(--glass-tint)' + 'blur(22px)'.
- **Design-token allow-list + material packs (breaks G1).** `theme-tokens.test.tsx` is tightly bound
  to `theme-tokens.ts` — asserts specific token names ('--primary', '--ring', '--accent2',
  '--radius', '--critical', '--font-display', '--grid-opacity', '--glow-strength', '--glass-opacity',
  '--glass-tint'), the exact 'quiet' vs 'command' packs + per-key values (`:107-141`), the font enum
  ('inter'→Inter, 'grotesk'→Space Grotesk), ACCENT_PRESETS length≥4 (`:167`). `settings-dirty.test.ts:143-188`
  also pins '--critical'/'--font-display'/'--radius'. A new palette (G1) that renames tokens or
  replaces the packs breaks both. **These encode SECURITY invariants (#9/#10): token allow-listing,
  CSS-injection sanitisation, WCAG-AA accent-contrast advisory — a naive "replace the token file"
  drops the guards these protect.**
- **Static source-text assertions (breaks G8 refactor/relocation).** `CaseDetail.tabs.test.tsx`
  `readFileSync`s `CaseDetail.tsx` and asserts literal `value="collab"`/`value="feedback"`,
  'TabsTrigger', `<CollaborationThreadTab>`/`<FeedbackTab>`, and CollaborationTab absent
  (`:28/:41-101`). `CaseDetail.live.test.tsx:21/:28` reads it for `liveCaseId` prop-forwarding.
  `bundle-first-paint.test.ts:58-89` reads built chunks + `loginParts.tsx` and forbids static
  imports of recharts/framer-motion. Moving/renaming `CaseDetail.tsx` or `loginParts.tsx`, splitting
  the JSX, or changing lazy→eager imports breaks these even though behavior is unchanged.
- **Settings section labels (breaks G3).** `settings.render.test.tsx` hardcodes 'General & data
  scope' (`:114/:127`), 'Settings' (`:119`), 'Profile' (`:131`), 'Security & two-factor' (`:132`),
  'Sessions & activity' (`:133`), 'Users & roles' (`:136`), 'Security & SSO' (`:137`), 'Active
  sessions' (`:138`), 'Add user' (`:145`), deep-link '#/settings?s=admin_users' (`:142`). Since G3
  is specifically about de-cluttering/renaming Settings + reducing nesting, this is a near-certain
  break.
- **Secondary UI-string/class coupling (each breaks on same-surface restyle):** Standup
  (`standup-report.test.tsx:143`, testids `delta-tile-open`/`delta-tile-needs_human`, 'was 8');
  CaseTriageHeader ('Risk'/'Medium'/'Low'/'P2', triage-chip testids, RISK_FACTOR_HELP weights
  '25%/20%/30%/15%/10%', 'never closes or escalates'); MitreHeatmap sr-table; BaselineGauge ('Warming
  up'/'Warm'/'p50/p95/p99'/'Anomaly baseline'/'Signatures'/'Warm buckets'); UnifiedLogsSheet
  ('Source'/'Partial results'); command-palette ('Cases'/'Go to Settings'/'New chat', placeholder
  /jump to a page.../); danger-zone ('Reset cases & logs'/'Factory reset', 'RESET CASES'); models-catalog
  ('Claude Opus 4.8'/'GPT-4o mini'/'Exact'/'Heuristic', pricing); login.render ('Sign in'/'Two-factor
  authentication'/'Create your admin account'/'Strong'); notifications/templates ('Alerting &
  Notifications'/'Email templates'/'No channels yet'); demo.render ('Experimental'/'Seeded'/'Live');
  audit.render ('Audit log').
- **Backend suite — LOW RISK.** ~140 pytest files assert only HTTP status + JSON wire-keys + config
  values (no render/getByText). The only display-adjacent surface is
  `test_settings_roundtrip.py:131-183` (asserts `/api/settings/schema` field NAMES/types +
  section wire-keys 'rag'/'notifications'/'branding'/'rbac') and `test_rule_catalog.py` (rule
  wire-names) — config keys, not UI labels, so **safe UNLESS G3/G6 renames config keys or schema
  field names. Backend needs NO changes for a UI-only overhaul.**

### Actionable recommendations
1. **Introduce stable `data-testid` anchors** on load-bearing surfaces (Overview hero, each Metrics
   tab, each nav item, Settings sections) and migrate the brittle string/role assertions to testids
   — do this ONCE up front so future rewordings don't cascade into test churn.
2. **Centralize nav labels:** have `NavSidebar.test.tsx` import label constants from `nav.ts` (or a
   shared labels module) instead of literals, so a rename flows automatically and only the
   topology/aria assertions remain hand-written.
3. **Extract 'Security Posture Dashboard' to a single exported constant** (e.g. `Overview.PAGE_TITLE`)
   referenced from source + all 3 test files.
4. **For token tests, assert the SECURITY behavior generically** (allow-listing, sanitisation, AA
   advisory) rather than pinning individual token values, so a palette refresh doesn't require
   editing value literals.
5. When a G8 refactor relocates `CaseDetail.tsx`/`loginParts.tsx`, update the `readFileSync`/
   `path.resolve()` targets in the static tests.

### Customization gaps (test coverage)
- **G6 rules customizability has thin UI test coverage** — only `Tuning.render.test.tsx` (asserts
  'auth-brute') + backend `test_rule_catalog.py`/`test_threshold_automation.py`. No webui test
  exercises user-editable detection/correlation/risk/auto-close rules end to end. Plan NEW tests for
  the new rule-editing UI rather than expecting existing ones to guard it.
- **G7 custom dashboards has NO existing webui test surface** — Overview is tested only for the hero
  title + smoke. Net-new tests needed; nothing existing blocks it.

---

## Appendix — Cross-audit themes (the recurring root causes)

Several findings repeat across audits; fixing the root causes yields compounding wins:

1. **Two god-files drive most FE debt.** `Settings.tsx` (2673 lines, §1/§3/§10/§13/§14) and
   `CaseDetail.tsx` (4210 lines / 160KB, §5/§7/§14) concentrate the coupling, padding/elevation
   drift, unlabeled-form defects, and brittle-test surface. Splitting them is the precondition for
   G3, G6, G8, and safe G1/G2 codemods.

2. **The dead `settings_schema.py` is the single highest-leverage backend fix.** Wiring it (§1/§3/§6)
   simultaneously declutters Settings (G3), unlocks customizability for orphaned rule knobs (G6), and
   loosens the "add config + endpoint, forget the form" coupling failure (G8).

3. **Token role-overloading is the root of the color failures.** One `--{hue}` used for text + wash +
   fill (§8) cannot satisfy WCAG-AA text and readable fill at once — it drives the systemic light-mode
   badge failures (§8/§10). Splitting into `--{hue}` / `--{hue}-foreground` / `--{hue}-text` fixes G1
   and the a11y contrast defects together.

4. **The primitives exist; the discipline doesn't.** `<Card>`, `PageHeader`, `badges.tsx`, `ui/tabs`,
   `EmptyState`, `Skeleton`, `Alert`, chart primitives, `UserPrefsStore` — all high-quality and
   reuse-ready. G2/G4/G5/G7/G12 are largely a matter of *adopting* them consistently (codemod raw
   cards → `<Card>`; HeroPanel → PageHeader; hand-rolled errors → `LoadError`) plus adding a few
   missing shared pieces (`useAsync`, `useNavigate`-only convention, `PageContainer`, `SegmentedControl`,
   a `<Field>` a11y wrapper, one typographic layer).

5. **`decide()` is safe throughout.** Every audit confirms none of the recommended UI/token/plumbing
   changes need to touch `engine/case_manager.py`; the one place the UI intersects the decision spine
   (the auto-close editor, §3) is a *field-name plumbing bug* — point the UI at `prefs.auto_close`,
   which `decide()` already reads, without changing `decide()` itself.

6. **Wire keys are load-bearing everywhere.** Every rename/IA/terminology change is UI-string-only;
   the backend contract (`threshold_automation`, `auto_correlate`, `correlation.n`, `severity_floor`,
   `rule_field`, `fp_auto_close`/`auto_close`, `config['index_patterns']`, settings-schema field
   names) must stay byte-identical, and deep-link anchor IDs must be preserved or redirected.
