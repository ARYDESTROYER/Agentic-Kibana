# Round 5 — PROPOSAL: UI/UX Consolidation + Rule & Dashboard Customizability + Loose Coupling

> **Status:** DRAFT for review · **Branch:** `Testing` · **Author:** Round-5 planning agent · **Date:** 2026-07-01
>
> **Inputs (read in full):** `understand/EXECUTIVE_SUMMARY.md`, `understand/AUDITS.md`,
> `RESEARCH_SUMMARY.md` (the P2 decision brief), plus the five `understand/*_MAP.md`
> subsystem maps and the seven `RESEARCH_*.md` domain docs.
>
> **Companion docs to keep in sync when this ships:** `CLAUDE.md`, `docs/HANDOFF.md`,
> `README.md`, `ROADMAP.md`, `CHANGELOG`, and a Round-5 `IMPLEMENTATION.md` (written as it lands).

---

## 0. The bright-line invariants (repeated up top, non-negotiable)

Every wave, every PR, every codemod holds these. If a change cannot be made without violating one, it is out of scope.

1. **#3 — `engine/case_manager.py` `decide()` is BYTE-IDENTICAL.** The close/escalate decision is deterministic code over `(verdict, confidence, risk_score, policy)`. It is never LLM-, playbook-, dashboard-, rule-editor-, or automation-driven. Verified: `decide()` reads `self._prefs.auto_close` (`case_manager.py:136`) and `_entry_for` reads `policy.false_positive` / `policy.true_positive`. Every G6 rule/auto-close change is UI-plumbing that writes the fields `decide()` already reads — it does not touch the function.
2. **#6 — one usage-ledger write per LLM call.** No rule preview, no dashboard widget, no what-if simulator bills the LLM. The rule-preview / decision-simulator paths are explicitly `decide()`-pure and LLM-free.
3. **#9 — log-/user-influenceable values are UNTRUSTED.** Fenced + labelled in prompts; rendered as plain text / SVG `<text>` / code-block in the UI. This extends to every new surface: dashboard widget titles/labels, custom-dashboard names, rule names, rule field values, saved-view names, terminology overrides. **Never** `dangerouslySetInnerHTML` a user-typed string.
4. **#2 — append-only audit.** Every rule create/edit/enable/disable/rollback, every auto-close policy change, every reset writes to `tlsoc-agent-audit-*`. New lifecycle events extend it; nothing mutates history.
5. **#10 — secrets are booleans in the UI** (`configured ✓`), never values. Any new config surface (rule model-overrides, SSO, channels) keeps the secret-boolean contract.
6. **`PUT /api/settings` deep-MERGES.** Verified: `put_settings` (`routes.py:821-838`) does `merged = _deep_update(state.prefs.model_dump(...), body)` then re-validates the whole `Preferences`. A full-doc-replace would wipe unrendered blocks (Round-4 configs, rule catalogs). **Any new Settings section MUST send only its changed keys through this merge path** — never a full snapshot, never a sibling-clobbering partial. The `demo` block is force-preserved server-side (`routes.py:830`); leave that guard intact.
7. **Deep-link back-compat for all page ids.** `PAGE_IDS` (`nav.ts:332`) + `#/settings?s=<id>` + `#/cost`/`#/investigate` in-memory `NavOpts`. Reorganizing nav/Settings relabels display strings and adds redirects; it **never** deletes a route id without an alias.
8. **`webui/src/lib/types.ts` stays hand-mirrored to `backend/app/models.py`.** No codegen exists yet (Wave-A introduces `openapi-typescript` for *request/enum* types only; response mirroring stays manual until `response_model=` lands). Every model change is mirrored by hand in the same PR.
9. **No new npm RUNTIME deps beyond §5's approved ledger.** All additive, default-safe, reversible. Lazy-load anything not on the hot read path.

---

## 1. Executive intent — "consolidation, not reinvention"

All five understanding-phase domains and all seven P2 research docs reached the **same** conclusion independently: **the foundation is good; the discipline is missing.** The stack — shadcn/ui + Radix + Tailwind v3 + single-source CSS-var tokens + a real set of shared primitives (`@/ui/card`, `PageHeader`, `badges.tsx`, `ui/tabs`, `EmptyState`, `Skeleton`, `Alert`, `DataTable`, `RiskGauge`, the chart wrappers, `UserPrefsStore`) — is the correct base for G2. The app is not dragged down by the wrong architecture; it is dragged down by a **small set of structural root causes that each metastasize across dozens of pages**, layered with a handful of **real correctness bugs**.

The structural root causes (each named repeatedly across audits):

- **Two card grammars** — a shared `@/ui/card` (with `shadow-elev1`) vs. 44 hand-rolled `rounded-lg border bg-card p-5/p-6` divs; 18 pages never import `@/ui/card`. Hand-rolled cards are flat; four pages mix both on one screen.
- **Two nav systems** — `nav.ts` (6 groups, single-item wrappers) vs. `Settings.tsx`'s self-rolled IA (`SECTION_GROUPS`, 6 groups × ~20 sections, its own `#/settings?s=` sub-router + scroll-spy TOC). Admin surfaces have two coexisting homes; nesting reaches 4-5 deep.
- **Two semantic-color systems, already drifted** — charts pull `palette.ts SEMANTIC`; badges/pills/gauges use an independent switch in `badges.tsx` + `ui/badge.tsx`. `escalated` is orange in charts, red in badges.
- **Three API/type layers** — `lib/api.ts` (~120 typed methods) + 16 co-located `*.api.ts` (111 raw call sites) + `useEventStream`; `lib/types.ts` mirrors only Round-1/2, so G6 has no typed foundation.
- **A hard `max-w-[1400px]` shell cap** (`AppShell.tsx:601`) with no per-page opt-out — ~140-440px dead gutter on wide monitors.
- **Two god-files** — `Settings.tsx` (2673 LOC) and `CaseDetail.tsx` (4210 LOC) concentrate most FE debt and most brittle-test surface.
- **The "add config + endpoint, forget the form" pattern** — rich engine config (`rule_catalog`, `correlation_rules`, `asset_networks`, `SlaPolicy`, `PriorityMatrix`, the Round-4 blocks) appears **0× in the webui**; the dead `GET /api/settings/schema` (220 LOC, 0 consumers) was meant to fix this and never got wired.

**The thesis:** fix the structural root causes **once, up front**, extract the small set of missing shared primitives, then adopt them everywhere via codemod — *before* the feature work — so every subsequent change lands on the consolidated, loosely-coupled version. G6 (rules) is ~70% backed by existing config models: the gap is API surface + UI wiring, not the config layer. G7 (custom dashboards) is greenfield but rides a proven zero-migration KV persistence template (`UserPrefsStore` + the `inbox.py`/`tuning.py` CAS pattern). Nothing here is a rewrite.

**What we are NOT doing:** not swapping the design system (shadcn/Radix/Tailwind stays), not moving to Tailwind v4 / OKLCH (deferred — flips the token contract), not replacing recharts (it is what shadcn Charts is built on and our wrappers already exceed it), not a big-bang router rewrite, not full Feature-Sliced-Design, not runtime plugin loaders. Every dep in §5 is small, additive, mostly dev-only, and the three heavier runtime deps are lazy-loaded off the hot read path.

---

## 2. Goal-by-goal — problem → solution → why

### G1 — A cohesive color scheme (light + dark), WCAG-AA *real*, not claimed

**Problem (measured).** The token architecture is clean (single-source HSL triplets in `theme.css` `:root`/`.dark`, surfaced to Tailwind and to recharts via `palette.ts token()`), **but each `--{hue}` token is overloaded three ways** — as small TEXT color, as a 10%-wash background, and as a solid FILL with white text (`AUDITS §8`). A hue bright enough to read as a solid fill is too light to read as text on white. Measured light-theme contrast for `text-{hue}` + the `bg-{hue}/10 text-{hue}` badge wash (`ui/badge.tsx:16-22`) on a white card: warning **3.24**, medium **3.54**, high **3.83**, success **4.07**, info **4.08**, low **4.17** — **everything except critical (5.06) FAILS the 4.5:1 text bar.** Dark theme: white-on-`--primary` = **3.35** (the default primary Button + primary Badge fail), white-on-dark-`--critical` = **4.26**, teal branding preset = **3.74**. Borders are near-invisible: light `--border` = **1.27:1**. **Yet `theme.css:49,82,175,203` and `theme-tokens.ts:237-239` assert "WCAG-AA".** The claims are false in code, in exactly the places the code denies it. Secondary: `--low` is green (severity/verdict red-green CVD hazard), FP verdict is green (same hazard), and the default `--primary` is the generic `#217 88% 50%` azure every shadcn clone ships (no ownable identity).

**Solution.**
- **Split each overloaded hue into three orthogonal roles** (`AUDITS §8` rec 1; `RESEARCH_COLOR §1.2`): `--{hue}` (step-9 solid fill), `--{hue}-foreground` (text-on-fill), `--{hue}-text` (step-11 AA text for `text-{hue}` badges/chips/deltas). Generate values from **Radix Colors scales pasted as static CSS vars** (zero runtime dep — no chroma-js/d3). This eliminates the hand-tuned light/dark drift in one move.
- **Adopt the 3-axis semantic palette** — SEVERITY / STATUS / VERDICT as independent maps (`RESEARCH_COLOR §1.2`). Drop green from severity (`--low` → blue `205°`); verdict FP → neutral blue-grey (kills the red/green CVD hazard). One `label→token` map drives **both** `badges.tsx` and `palette.ts` (fixes the drift in Problem #11) — see G2.
- **Add colorblind-safe chart ramps** as new tokens `--chart-1..8` (Okabe-Ito categorical) + a viridis sequential ramp; rewrite `CATEGORICAL` off these and **trim 8→≤6** and CVD-verify (`RESEARCH_COLOR §1.7`, `RESEARCH_A11Y §7.3`). Fixes the Cost-donut adjacency collisions and the `accent`-in-CATEGORICAL near-invisible segment (`AUDITS §8`).
- **Add a runtime AA guard** in `theme-tokens.applyBranding` (reuse the existing `contrastRatio` at `branding.api.ts:111`) that auto-darkens or rejects an operator accent failing 4.5:1 — closes the branding hole where `applyBranding` currently has no guard.
- **Correct the false in-code AA claims** at the four cited lines.
- **Give the product an ownable default primary** and set the currently-unset `--accent2`/hero-aurora so the login hero is branded, not monochrome blue.
- **Add a ~20-line in-repo contrast checker** to the CI gate so a token edit cannot silently regress 4.5:1/3:1 again (`RESEARCH_A11Y §7.6`).

**Why.** The root cause is token role-overloading (`EXECUTIVE_SUMMARY §2 #5`, `AUDITS Appendix #3`). Splitting the token roles is the single fix that resolves G1 *and* the systemic a11y contrast failures (G9) together. Radix Colors as a static generator keeps the shadcn/Tailwind wiring and adds zero deps. The 3-axis split is the shared root that chart colors (G1.7), non-color a11y signaling (§7.1), and every badge build on — one change, compounding wins.

---

### G2 — ONE consistent design standard on the existing stack

**Problem.** The same visual job is done 2-4 ways depending on page vintage (`AUDITS §7`):
- **Card primitive unused by ~half the pages** (biggest): 44 raw `rounded-lg border bg-card` divs vs. 66 `<Card>`; **18 pages never import `@/ui/card`** (Cases, CaseDetail, Models, Roles, Audit, Tuning, Campaigns, BatchJobs, Sessions, Users, Scans, Chat, Analytics, Home, Intelligence, Workspace, AdminSessions, Baseline). Because `<Card>` carries `shadow-elev1` and raw cards don't, **four pages render mixed elevation on one screen** (Settings, Investigate, Standup, Wizard).
- **Padding ad-hoc:** `p-3`×17, `p-4`×10, `p-5`×17, `p-6`×49 with no rule; CaseDetail is the worst (28 cards at `p-6`, visibly roomier than every other page).
- **Page title rendered 3 ways / 2 sizes** (`PageHeader` `text-2xl` vs `HeroPanel` `text-2xl sm:text-3xl`); 26 use `PageHeader`, 4 use `HeroPanel`, 5 hand-roll.
- **Tab/segmented control 3 ways** (`ui/tabs`, `TabbedPage`, 4 hand-rolled strips).
- **Raw `<button>` bypasses `Button` 45×**; severity chips hand-rolled 5× despite `badges.tsx`; button variants are imbalanced (outline 129×, `default`/primary-filled only 3× — no clear primary CTA per view).
- **No typography or spacing scale layer:** Tailwind defaults untouched, 101 arbitrary `text-[..]` escapes across 40 files (11px expressed as both `text-[11px]` and `text-[0.6875rem]`), 8 variants of one "small-caps label" motif, no shared `<Heading>`/`<Eyebrow>`/`<Label>`. **Fonts declared but never loaded** — `Inter`/`JetBrains Mono` are named in config but there is no `@font-face`/`@import`/`<link>`; the app renders in the OS system fallback and the `.text-display` OpenType features are silent no-ops (`AUDITS §9`).

**Solution.**
- **Ship the fonts we already claim** (`RESEARCH_COLOR §1.1`): add `@fontsource-variable/inter` + `@fontsource-jetbrains-mono` as **dev-deps** (build-time WOFF2, subset latin, preload one weight, ship the variant carrying `ss01`/`cv01`). Zero runtime JS; single highest-impact type fix.
- **Adopt `<Card>` as the ONE panel primitive; codemod the 44 raw cards** (`AUDITS §7` rec 1). This fixes elevation AND padding together. Add a `variant="flat"` for dense/inline cases (filter bars) instead of forcing shadow everywhere.
- **Make `PageHeader` the single page-title standard** with a `compact`/`density` variant; have `HeroPanel` compose it (this also serves G5). Retire the hand-rolled headers.
- **One `label→token` semantic map** driving both `badges.tsx` and `palette.ts` (fixes Problem #11 drift); route ALL severity/status/verdict/disposition chips through `badges.tsx`.
- **Extract the missing shared control primitives** (`EXECUTIVE_SUMMARY §2 #15`): `SegmentedControl` (collapses the 4 hand-rolled strips), `FilterBar`, `ConfirmDialog`, `SecretField`, `TagInput`, a `<Field label>` a11y wrapper (auto `useId()` + `htmlFor`/`id` + `aria-describedby`), `NumberField` + `LabeledSlider` (for G6 thresholds), and hooks `useAsync`, `useDirtyDraft`, `usePrefersReducedMotion`, `useMediaQuery`. Replace 45 raw `<button>`s with `<Button>` via codemod.
- **Introduce one typographic primitive layer** (`<Heading level>`, `<Text variant>`, `<Eyebrow>`, `<Label>`, `<Metric>`) and **extend `tailwind.config` `fontSize` by ADDING named sub-xs rungs** (`micro`=11px, `2xs`=10px) as `[size,{lineHeight,letterSpacing}]` tuples — **never remap the existing `xs`/`sm`** (that reflows the whole app + every snapshot). This retires ~90 of 101 escapes with near-zero JSX churn. Density-tune the scale at 14px body / 16px root, `tabular-nums` on numerics.
- **Sanction an 8px spacing subset** (`RESEARCH_COLOR §1.4`): two conventions app-wide — page-section rhythm `space-y-6`, card-grid gap `gap-4` — encoded as a `PageShell`/`SectionStack` wrapper. Wire (or delete) the dead `--density-unit`, `--radius-sm/md/lg/xl`, `.text-display*` surfaces — pick one truth.

**Why.** "The primitives exist; the discipline doesn't" (`AUDITS Appendix #4`). G2/G4/G5 are largely *adopting* what already ships (codemod raw cards → `<Card>`, HeroPanel → PageHeader) plus a few missing shared pieces. Elevation + padding are coupled to card construction — you cannot fix them centrally until panels move to `<Card>`, after which future look changes are one edit to `ui/card.tsx`. The type/spacing scales upgrade 800+ existing usages with zero class-name churn because the class names stay identical; only the tuple definitions change.

---

### G3 — Declutter Settings (2673-line god-file) + flatten nested submenus

**Problem.** `Settings.tsx` is one 2673-line module holding ~26 components/section-renderers, 3 parallel save mechanisms, and a section taxonomy hand-synced across **three files** (`SECTION_GROUPS` `:172`, the `SectionId` union `:129`, `SECTION_KEYS` in `settings-dirty.ts:35`, already partly stale). Nesting reaches **5 tiers** to a control (Group → Section → in-section TOC anchor → `SettingsCard` → control). **The biggest structural problem is duplication:** six destinations exist BOTH as standalone pages AND embedded Settings sections (`Users`/`Security`/`Sessions`/`Account`/`AdminSessions`/`Roles`); `Users.tsx:78` is literally `<ProtectedRoute><UsersInner/></ProtectedRoute>`. The nav "Settings" children route to the **standalone** pages, not `#/settings?s=...`, so clicking "Users" under Settings leaves the Settings page entirely. Appearance is editable in two groups; Models is split across three places; the entire Round-4 config (`prefs.threshold_tuning/batch/baseline/campaign`, `caps.max_concurrent`) has **no Settings home** and lives only on standalone pages with different save UX. The `GET /api/settings/schema` reflector (220 LOC) has **0 consumers**. A `GRID_SECTIONS` allowlist bug double-wraps Automation (card-in-a-card).

**Solution.** Staged (`AUDITS §1` recs, `RESEARCH_SETTINGS_IA §3`):
1. **Regroup to 5 top-level groups, promote Security to its own group** (the single highest-leverage IA change — every reference product does it):
   - **Account** (personal): Profile · Security & two-factor · Sessions · Appearance
   - **General**: Data scope · Models · Detection & rules (G6 home) · Cases · Automation · Standup
   - **Integrations**: Sources & feeds · Notifications · Enrichment · Knowledge
   - **Security & access** (NEW): Users · Roles (split out) · SSO · Session/token policy · Active sessions · Secret keys
   - **Organization**: Branding · Advanced · Experimental/Demo · Danger zone (isolated, red, last)

   **Rename display labels only — keep section `id`s stable** (deep-linked); ship redirect aliases if any id must change.
2. **Decompose the monolith into a data-driven section registry** — one array of `{id, group, perm, ownedKeys, title, blurb, icon, Component}` as the single source of truth; derive `SectionId`, `SECTION_GROUPS`, `SECTION_KEYS`, and the render switch from it (kills the 3-file sync). Extract each section renderer to `pages/settings/<section>.tsx` (each takes only `{prefs, update}` — mechanical).
3. **Collapse the six duplicate standalone/embedded homes** — keep the `*Inner` bodies (one body, two hosts), route the nav children to `#/settings?s=<id>`, delete the duplicate chrome, add redirects from the old standalone routes.
4. **Wire the dead `settings_schema.py`** → a generic "Advanced (all settings)" fallback renderer (see G6 — this is the shared root-cause fix), so future engine knobs are editable-by-default; special-case `demo` (managed via `/api/demo/*`) and `read_only_settings_mode` (can't self-lock).
5. **Two disclosure tiers only** (`RESEARCH_SETTINGS_IA §3.4`): default-OFF engine features (tuning/batch/baseline/campaigns/event-detection) behind a head-of-section enable toggle; Danger Zone visible-but-guarded (never hidden); search/anchors auto-expand collapsed cards. Vendor a ~40-line Radix `ui/collapsible.tsx`.
6. **Fix the double-wrap** (`GRID_SECTIONS` Automation card-in-a-card) and unify the 3 save mechanisms onto the one `StickySaveBar` changed-key PUT model.
7. **Close the deep-link/search gaps:** router currently strips `?`/clears `opts` on hashchange so palette→section deep-links drop — write the full hash directly; register sections as Cmd-K jump targets from a lifted shared `settings-sections.ts`; add card-level `&a=<anchor>` deep-links; deepen the filter from section- to setting-level.

**Why.** Search is the de-facto nav today (21 sections + a search box + per-section keyword arrays implicitly concede the tree is too deep). The data-driven registry is the same single-source pattern the dashboards (§4.3) and coupling (§6.2) sections both lean on. Collapsing the duplicate homes removes an entire nav paradigm and is the precondition for wiring G6 rule editors cleanly. Cap the hierarchy at **two levels** (rail group → section page → in-page cards/tabs; never a third menu level).

---

### G4 — Dashboard uses more screen real-estate (kill wasted space)

**Problem.** ~31% of a ~820px laptop fold is chrome+hero before the first metric (`AUDITS §2`): `h-14` top bar (56px) + `HeroPanel p-6 sm:p-8` (~150-160px) + `py-6` content padding (24px) = ~258px, and the hero carries zero live data. The 208px `RiskGauge` (`Overview.tsx:617`) then fills the rest of the fold — timing StatCards, Signal breakdown, and Workload are all below it. Globally, **every page is capped at `max-w-[1400px]`** (`AppShell.tsx:601`) with no per-page opt-out → ~260px dead gutter at 1920px, ~1160px at 2560px. Grids **don't scale past `lg`**: `2xl:` used 0 times, `xl:` ~20, `lg:` 84; at 1280px+ most grids stop adding columns and inflate cell whitespace. Overview crams 7 KPI tiles into a `lg:col-span-2 xl:grid-cols-3` sub-grid beside the gauge, plus a redundant `<dl>` duplicating 3 tiles and ~120 lines of client posture math shadowing the server endpoint. Cases stacks ~270px of controls (KPI band + views bar + padded filter bar) before row 1. The `.container` config (`2xl: 1440px`) is a **red herring** — it is unused; the real cap is the `AppShell` literal.

**Solution.**
- **Centralize the width cap in ONE `<PageContainer variant='default'|'wide'|'full'>` primitive** (`AUDITS §11` rec 1, `RESEARCH_COLOR §1.6`) so operational pages (Cases/Metrics/Cost/Dashboards) opt into wide/fluid (≤1760-1920px) while narrative pages (Settings/Account/Knowledge) stay prose-width (~72ch). Adopt the tiny first-party `@tailwindcss/container-queries` dev-plugin for per-archetype responsive widths. **Widen via per-page opt-in, never global removal** (prose line-length must not blow out).
- **Un-nest Overview's KPI grid** — give KPIs the full row (drop the `col-span-2` nesting), go `xl:grid-cols-4`/`2xl:grid-cols-7`, place charts below; delete the redundant `<dl>` and the ~120 lines of client posture math (use the server posture endpoint). Update the loading skeleton in lockstep (it mirrors the grid — else layout shift).
- **Adopt the universal three-zone dashboard layout** (`RESEARCH_DASHBOARD §2.1`): compact control bar (time-range pill + auto-refresh + a "last refreshed" stamp) → KPI strip of 4-6 drill-down tiles → widget grid of named groups ordered general→specific. Every tile deep-links into the filtered case list carrying the current range, serialized to the URL for shareability.
- **Add columns at `2xl` instead of stretching**; one responsive column formula for Metrics (which currently mixes `lg:grid-cols-6/5/4` so tiles resize between tabs); collapse Cases' KPI band into inline pill counts + merge SavedViews/Columns into the filter bar (~150px reclaimed).
- **Tighter card padding for tiles** (`p-4` on `KpiTile`/`StatCard`, `py-3` headers) — verify Cost/Models still breathe (global change).

**Why.** The width primitive is the single highest-leverage G4/G7 change (`EXECUTIVE_SUMMARY §2 #6`) — it unblocks dense tables now and the custom-dashboard grid later. The three-zone layout is what Grafana/Datadog/Elastic Security/Sentinel/Splunk ES all converge on. Killing the client posture math removes a shadow of the server endpoint (correctness + LOC). Padding changes are global, so they ship with a vitest re-run gate.

---

### G5 — Compact the "Security Posture Dashboard" hero band

**Problem.** `HeroPanel` (`Overview.tsx` via `CommandCenterLayout`) is ~176px of chrome before any data: `p-6 sm:p-8` + a display-size title (`.hero-display` clamp up to 2.125rem) + a 2-line description whose eyebrow+title **restate the breadcrumb**. `HeroPanel` and `PageHeader` are near-identical but drift (title is a full step larger on the dashboard than on every `PageHeader` page).

**Solution.** **Merge `HeroPanel` into `PageHeader` with a `compact`/`density` variant** (`EXECUTIVE_SUMMARY §3 QW1`, `AUDITS §2`). Swap Overview to the compact header (band drops ~155px → ~64px, reclaiming ~90px). Shrink the 208px `RiskGauge` to ~150-160px (or make it a horizontal gauge+stats strip / fold it into the KPI row), and have it show a **numeric value + band label**, not just a colored arc (a11y §7.1). Drop the section eyebrow headings that repeat what the card title already names.

**Why.** Both components exist and are near-identical — merging is low-risk and immediately visible, the fastest route to visible progress (QW1). **Caution (load-bearing):** `App.smoke.test.tsx:94/:104` and `settings.render.test.tsx:177` boot on the literal string `"Security Posture Dashboard"`. Extract it to a single exported constant (`Overview.PAGE_TITLE`) referenced from source + all three test files, and **update the guards in lockstep — do not delete them** (they are the white-screen boot safety net).

---

### G6 — Real rule customizability in the UI (detection / correlation / risk / auto-close / tuning)

**Problem.** The engine exposes a rich, mostly-safe set of "rule" knobs, but `Settings.tsx` hand-wires only a curated subset, and `/settings/schema` is unconsumed, so **any knob not explicitly coded into a section is uneditable** (`AUDITS §3`). Concretely:
- **CRITICAL — the auto-close UI edits a DEAD field.** `AutonomyControls` binds `prefs.fp_auto_close` (verified `Settings.tsx:1094-1095`); `decide()` reads `prefs.auto_close` (`case_manager.py:136`). The `_migrate_fp_auto_close` migration only fires when `auto_close` is ABSENT, but `put_settings` merges over a full `model_dump` where `auto_close` is always populated by its `default_factory`. **Toggling "Auto-close confident false positives" changes nothing the engine acts on.** (Full fix in §3, bug #1.)
- The **TRUE_POSITIVE opt-in** (`auto_close.true_positive`, OFF by default) and **NEEDS_HUMAN** (never-auto-close, must be locked) classes have no control.
- **`correlation_rules`** (per-rule), **`rule_catalog`** (18 seeded `RuleDefinition`/`RuleMatch`, config-driven detection), **`asset_networks`/`asset_criticality`**, **`SlaPolicy`**, **`priority_matrix`**, **suppression rules**, and the **Round-4 blocks** (tuning/batch/baseline/campaign, `caps.max_concurrent`) appear **0× in the webui** or only partially (`Tuning.tsx` renders 5 of 8 fields; the statistical safety knobs `max_n_step`/`wilson_z`/`ewma_alpha` have no control). RBAC grants are fragmented (baseline→`settings:read`, campaigns→`cases:read`, batch→`models:read`, tuning→`automation:read`).

**Solution** (`AUDITS §3` recs, `RESEARCH_RULES_UX §5`):
1. **Fix the dead-field bug first** — write ONE `VerdictAutoClose` sub-editor rendered twice (`false_positive` + `true_positive`), post to `prefs.auto_close` (the field `decide()` reads), lock `needs_human` (code-enforced never-auto-close). Add the `true_positive` opt-in OFF by default. **Do not touch `decide()`; do not delete `fp_auto_close`** (legacy configs still migrate).
2. **Consolidate one "Detection & rules" home** exposing three clearly-labeled rule tiers, each already backed by code:
   - **Detection rule — Match + Threshold** (`RuleDefinition` + `CorrelationRule`): predicate rows → group-by + trigger-after-N + within-window (`n=1` = simple match, `n>1` = threshold/brute-force).
   - **Detection rule — Anomaly/Baseline** (`BaselineConfig`): fire on deviation from the learned hour-of-week baseline.
   - **Case-automation rule** (`CaseAutomationRule`): post-`decide()`, HITL-safe (tag/recommend/notify/run_playbook/request_approval) — **never sets status** (asserted at `threshold_automation.py:18-19,48-49`).

   Keep **Threshold / Suppression / Exceptions / MITRE-mapping** as distinct, clearly-labeled concepts (conflating them is the #1 analyst footgun). Editor shell = Elastic's four-section **Define → About → Schedule → Actions** (Radix `Tabs`), where Define is polymorphic on rule type (a TS discriminated union). A thin deterministic adapter maps form ↔ existing wire keys so `decide()` stays byte-identical.
3. **Condition builder — split build-vs-buy:** simple all-AND predicates BUILD (flat `{field, op, value}` rows over Radix `Select`/`Input` — exactly what `RuleMatch` is, zero deps, common case); nested AND/OR (exceptions) BUY via `react-querybuilder` v8 through its official shadcn registry, **flag-gated + lazy**, nesting capped at 3, fed OCSF-typed fields; raw-YAML escape hatch = optional lazy CodeMirror 6 (never Monaco).
4. **Threshold UX** (`RESEARCH_RULES_UX §5.5`): never slider-only for load-bearing values. Ship the zero-dep `NumberField` (stepper + clamp-on-blur + unit + reset) as primary and `LabeledSlider` (Radix slider ⇄ linked input + ticks) for ordinal `severity_floor` + exploration. Enforce bounds in the UI; surface the tuner's suggestion inline; keep the live "effective config" preview and the copy **"below floor: candidate only — never dropped" (#4)**.
5. **Add the missing typed config endpoints** for baseline/campaign/batch mirroring `routes_tuning`'s `GET/PUT /tuning/config` (only tuning has one today); add the 3 missing tuner fields; add editors for asset criticality (map + CIDR), SLA policy, priority matrix, and a proactive operator suppression-rule builder (still audited via the proposal/audit path).
6. **Lifecycle** (`RESEARCH_RULES_UX §5.6`): three states enabled/disabled/shadow(preview); a **Test/Preview against 7-14 days of recent data** (histogram via existing recharts, RO scoped key, hard-capped, **never `decide()` / never bills LLM** — the highest-value trust feature and the safe what-if via a thin `POST /api/triage/preview-decision` wrapper over the pure `decide()`); an immutable version ledger + red/green diff + one-click rollback (generalize `stores/tuning.py`'s CAS ledger, no diff library); risky changes routed through the existing Approvals/Proposals HITL queue; all lifecycle events to the append-only audit index. Make **"Tune" the primary CTA** over "Disable."
7. **Schema-driven fallback** — extend `settings_schema.py` to descend into element models (fixing the list/dict `general`-bucket collapse) and wire the dead `GET /api/settings/schema` → a generic renderer for the long tail of knobs. Blueprint = the connector `AuthField`/manifest/entry-point SPI (the cleanest loose-coupling exemplar).
8. **Typed foundation FIRST** — mirror the real config types (`AutoClosePolicy`, `correlation_rules`, `rule_catalog`, Round-4 blocks) into `lib/types.ts` before any editor (G6 has no typed foundation without this). Use `zod` (~13KB) as the single source of client-side rule validation + defaults mirroring `config.py`.
9. **RBAC cleanup** — unify the fragmented grants under one rules permission; ship proper labels/`aria` on every control from the start (the unlabeled-control defects cluster exactly here, `AUDITS §10`).

**Phasing:** **Phase 1 (dep-free)** — auto-close bug fix, NumberField/LabeledSlider, four-section editor, flat builder, preview panel, version ledger, shadow state. **Phase 2** — zod + MITRE coverage view. **Phase 3 (gated)** — react-querybuilder, pySigma (backend-only Sigma import/export), optional CodeMirror.

**Why.** The backend is ~70% there; the default editor ships with zero new npm deps. The dead-field bug is the flagship autonomy toggle doing nothing — small fix, highest value. The schema-driven renderer structurally breaks the "add config + endpoint, forget the form" coupling failure (`AUDITS Appendix #2`) — it serves G3, G6, and G8 at once. **Load-bearing:** a `rule_catalog` editor must respect `maybe_seed_rule_catalog()`/`RULE_CATALOG_SEED_VERSION` (saving an empty catalog could trigger reseed-on-boot). Editing `correlation` `n`/`window`/`group_by` changes case formation going forward — surface that; **do NOT retroactively re-key open cases** (#4).

---

### G7 — User-created custom dashboards

**Problem.** Zero infra — no widget registry, grid, or per-user layout; every tile is hardcoded JSX in `Overview.tsx` (872 LOC) and `Metrics.tsx` (1446 LOC), which couple fetch AND layout. `UserPrefs` has no `dashboards` field. `PageId`/`renderPage` is a hardcoded switch with no `dashboards` route. **AND `user_prefs.py`'s `misc` write CLOBBERS instead of deep-merging** (codified in `test_user_prefs.py:323-325`) — would silently destroy dashboard config if hung off `misc` (bug #5).

**Solution** (`RESEARCH_CUSTOM_DASHBOARDS §4`, `AUDITS §4`):
- **Persistence = one additive `dashboards: dict[str, DashboardLayout]` field on `UserPrefs`** (zero-migration, same pattern as `saved_views`), persisted via the KVStore — **no new ES index / SQL table / migration**. Use the **lost-update-safe `kv_mutate` CAS pattern** (`inbox.py`/`tuning.py`), NOT `user_prefs.py` (fix its `misc` clobber either way — bug #5). Absolute grid-unit coordinates over 12 cols (Grafana/Metabase model), `schema_version` from day one, per-breakpoint `layouts`, store positions + type + options only (never data, never pixels).
- **Grid = `react-grid-layout` v2.2.3** (the one justified new dashboard dep — MIT, ~18.5KB gz, **lazy-loaded in edit mode only**; React-18-compatible; its item shape `{i,x,y,w,h,minW,minH,static}` *is* the persistence schema).
- **Widget registry = in-house `Map`-based** (`soc/dashboard/registry.ts`): `enum WidgetType → WidgetDef {lazy Component, defaultSize, declarative configFields, RBAC requires}`. Widget bodies **reuse** existing `KpiTile`/`BarList`/`charts.tsx`/`DataTable`/`MitreHeatmap`; each existing pure metric function (posture/coverage/shift payload key) *is* a widget. Promote the page-local `ChartCard` (`Metrics.tsx:174`) to `soc/components/ChartCard.tsx`. Reconcile-on-load drops unknown types + RBAC-filters + appends new role defaults.
- **One `DashboardDataProvider` context** fetches each source once and hands results to all widgets (avoids the N-widget fan-out — a 10-widget dashboard would otherwise re-fetch `listCases`+`getMetrics`+posture 10×). Respect the DASH/`available:false` sentinels (never print `'—'` as a number or treat DASH as 0).
- **Builder UX = the universal 5-step loop:** read-only default → explicit Edit mode (sticky Save/Discard/Reset, unsaved-changes guard, `<Can>`-gated) → Add from a curated gallery (never a blank canvas) → per-widget config Sheet → RGL drag/resize → explicit Save. Per-role immutable defaults (analyst=triage, manager=SLA/MTTR, auditor=posture, admin=cost/health) with **clone-to-customize on first edit** via the org←user cascade + `CustomizationConfig.default_dashboards`. **MVP = 3-5 widgets;** defer sharing/ACLs, cross-filtering, import/export.
- **Server-side widget-type allowlist on PUT**; cap dashboards-per-user + widgets-per-dashboard; debounce ~500ms; new routes `require_auth` + `require_permission('metrics','view')` + never-raise.

**Why.** Greenfield but a zero-risk recipe exists — the `UserPrefsStore` zero-migration cascade, the pure GET-only metric endpoints, and the theme-aware chart primitives are the exact plumbing (`EXECUTIVE_SUMMARY §4b`). RGL is the one dashboard dep, justified (Grafana/Metabase/Kibana precedent) and lazy so the read path stays lean. **Non-negotiables held:** #3 (layout is advisory, never feeds `decide()` — `metrics.py:165-172` is explicit), #9 (titles/labels plain-text/SVG only, allowlist-validated), #10 (calm read-only default). **Load-bearing:** G7 needs keyboard-operable move/resize (roving tabindex + arrow keys) and a non-drag alternative (up/down buttons) per WCAG 2.5.7 — build it accessibly (no existing keyboard-DnD to reuse).

---

### G8 — Loose coupling

**Problem.** The foundation is loosely coupled where designed, tightly coupled where it grew organically (`AUDITS §5/§6`). Concentrated failures:
1. **Navigation prop-drilling** — `App.renderPage` threads `onNavigate` into ~31 pages (40+ sites), each with `onNavigate ? … : undefined` branches, despite a router context (`router.tsx:90 useNavigate`); Cases + Audit already prove the prop redundant (`const navigate = onNavigate ?? route.navigate`). 7 pages type it as `any`.
2. **Three parallel FE registries** — `nav.ts` (`NAV_GROUPS`) + `App.tsx` (~35 `React.lazy` + a ~90-line `renderPage` switch) + the `PageId` union / `HIDDEN_ROUTE_IDS`, hand-synced (causes "page code-split but missing from nav" bugs).
3. **Three API/type layers** — `lib/api.ts` + 16 `*.api.ts` (111 raw call sites) + `useEventStream`; `types.ts` (2047 LOC) mirrors only Round-1/2 with 0 `response_model=` anywhere; duplicate type names are an import-the-wrong-one hazard.
4. **Layering inversions** — shared `components/` import UP into `pages/*.api` (`CaseTriageHeader`→`CaseDetail.api`, `RoleMatrixEditor`→`Roles.api`, `ModelsCatalog`→`Models.api`, `NotificationPrefs`→`Inbox.api`); `SessionsTable` lives in a page but is imported cross-page; rich editors are trapped inside pages.
5. **No shared data-fetching hook** — 27 pages hand-roll `useState(loading)`, 29 hand-roll `try/finally setLoading(false)`; error-message helper duplicated 25× with 3 names.
6. **Backend:** `AppState` god-object (~1830 LOC) with a fragile ordered `_wire()` ritual + setter-injection (pipeline constructible half-wired); `poller_manager`/`reset` take the ENTIRE `AppState` and reach privates (tightest coupling in the codebase); `routes.py` is a 4751-line/124-endpoint monolith; the notification SPI has no entry-point seam (2 of 3 registries do).

**Solution** (`AUDITS §5/§6`, `RESEARCH_COUPLING §6`):
- **FE registry:** collapse the 3 tables into one typed `FEATURES[]` (`registry.ts`) deriving nav + routes + palette, with a single `enabled(ctx)` capability predicate (RBAC / prefs-toggle / demo-mode as three distinct axes). Migrate **behind existing exports** — non-breaking. This is the same single-source registry §4.3 (dashboards) and §3.5 (settings Cmd-K) lean on.
- **FE DI:** replace `onNavigate` with `useNavigate()`-only (Cases/Audit already show the fallback); expose the `api` singleton via `useApi()` context for test injection. TanStack Query is optional and **not approved here** — the `.api.ts` builder path gets ~80% of the value at 0 bytes.
- **Extract `useAsync<T>(fn,deps)` → `{data,loading,error,reload}`** (deletes hundreds of lines; start with Baseline/Campaigns/Tuning/BatchJobs); extract `usePosture`, `useDirtyState`; one shared `errorMessage(e,fallback)` + a `LoadError` component (kills the 25 copies + the 3 error idioms — also §12 states).
- **Invert the layering inversions** — move trapped editors (RoleMatrix tri-state cell, TemplateEditor live-preview, config editors, `SessionsTable`) into `components/`; move `NavOpts` out of the backend-types file. Enforce feature-folder boundaries with `eslint-plugin-import-x` (dev-dep, warn→error per feature).
- **Split the two god-files** — `Settings.tsx` (via the G3 registry) and `CaseDetail.tsx` into its already-conceptual panels (header/trace/thread/tasks/related/close-dialog; several extractions already exist). **Do NOT re-merge the 16 `*.api.ts`** — that split is a deliberate parallel-safety decision.
- **Backend (finish the pattern, don't rewrite):** clean `operationId`s + `Annotated` DI aliases; split `routes.py` **one feature per PR** (paths byte-identical → webui contract untouched; run `pytest` (1461) + `test_route_auth_coverage` after each slice); upgrade the router loader to sorted, raise-on-failure auto-discovery; extract one generic `EntryPointRegistry[T]` (collapses ~120 LOC dup) and add discovery to notifications (`tlsoc.channels`) + LLM providers, via stdlib `importlib.metadata` (NOT pluggy/stevedore); give `poller_manager`/`reset` a narrow `Protocol` instead of the whole `AppState`; promote the 3 setter-injected pipeline collaborators to optional constructor kwargs; route OIDC-state + `_real_audit` through public accessors.
- **Contract sync:** `openapi-typescript` (dev-dep, 0 runtime bytes) for request/enum types; add `response_model=` to the ~10-15 highest-churn endpoints; commit `openapi.json` + the generated file; enforce with a CI `git diff --exit-code` gate. Mind the Pydantic-v2 `Optional`→`anyOf[...,null]` gotcha.

**Why.** G8 is achievable without a rewrite — do the extractions + inversions once, up front, before the codemods and feature work (`EXECUTIVE_SUMMARY §5`). **Load-bearing:** removing `onNavigate` requires RouterProvider above every page (it is) and any bare-rendered test page wrapped in `<RouterProvider>`; `NavOpts` is intentionally NOT URL-serialized — preserve in-memory opts + `HIDDEN_ROUTE_IDS`/`PAGE_IDS` validation or `#/cost`/`#/investigate` deep-links break; TabbedPage hosts round-trip their tab via `NavOpts.tab`; `decide()` is a clean pure fn untouched by any refactor; the `_wire()` ordering is load-bearing for the #6 cost-ledger guarantee.

---

## 3. Confirmed bugs to fix in-flight

Each is verified against source and shipped as part of the wave that touches the surrounding surface (not a separate wave). None touch `decide()`.

| # | Bug | Evidence (verified) | Fix |
|---|-----|---------------------|-----|
| **1** | **Auto-close UI edits a DEAD field** — the flagship autonomy toggle does nothing. | `Settings.tsx:1094-1095` binds `prefs.fp_auto_close`; `decide()` reads `prefs.auto_close` (`case_manager.py:136`); the `_migrate_fp_auto_close` migration only fires when `auto_close` is absent, but `put_settings` (`routes.py:826`) always populates it via `default_factory`. | Point the editor at `prefs.auto_close.false_positive`; add the `true_positive` opt-in (OFF default); lock `needs_human`. Consolidate into one `VerdictAutoClose` sub-editor rendered twice. **Do NOT touch `decide()`; do NOT delete `fp_auto_close`** (legacy migrate path). Update `settings-dirty.ts` to track `auto_close`. |
| **2** | **KpiTile delta colors by sign, not meaning** — "open alerts +30%" renders green with an up arrow. | `KpiTile.tsx:85,88` `delta.value >= 0 ? 'text-success' : 'text-critical'` and same for the arrow. | Add a `goodDirection: 'up'|'down'` prop: **color = improvement, arrow = true direction.** Pass the correct direction at each call site (lower-is-better for MTTA/MTTR/dwell/FP/open). |
| **3** | **Wizard demo toggle is cosmetic** — writes a dead `demo_mode` key, never arms Demo Mode. | `Wizard.tsx:168` `demo_mode: demoMode` into prefs; 0 hits to `POST /api/demo/enable`; the real state is `Preferences.demo` managed by `/api/demo/*`. | On enable, call `POST /api/demo/enable` (admin-gated); on disable, `POST /api/demo/disable`. Stop writing the dead `demo_mode` key. If the wizard user lacks admin, hide the toggle. |
| **4** | **Clipboard fails silently over plain HTTP** — optimistic "Copied" with nothing copied on `http://host:8080`. | `CodeBlock.tsx:99-102` + `ChatPanel.tsx:338-341` call `navigator.clipboard?.writeText`; the purpose-built `lib/clipboard.ts copyText()` (line 55, has a fallback) is never used. | Route both call sites through `copyText()`; only show "Copied" on a truthy return. |
| **5** | **`misc` prefs write CLOBBERS instead of deep-merging** — would destroy any dashboard/config stored in `misc` (blocks G7). | `user_prefs.py` replaces rather than deep-merges the `misc` bag; codified in `test_user_prefs.py:323-325`. | Deep-merge the `misc` bag (use the `kv_mutate` CAS pattern). **This requires updating `test_user_prefs.py:323-325`** (it currently asserts the wrong replace-not-merge behavior). Fix BEFORE G7 hangs anything off it — though G7 uses a dedicated `dashboards` field, not `misc`. |
| **6** | **Automation rules with `suspicious`/`benign` verdict can never fire.** | `Settings.tsx:1436-1441` offers verdict options `suspicious`/`benign` (these are `Disposition` values); the `Verdict` enum has only `FALSE_POSITIVE`/`TRUE_POSITIVE`/`NEEDS_HUMAN` (`constants.py:182-184`). Those conditions never match. | Populate the verdict dropdown from the real `Verdict` enum (3 values). Migrate/reject any saved rule carrying an impossible verdict on load with an inline warning. |
| **7** | **Roles nav/page permission mismatch** — nav gates on a non-action; page requires a different one. | `nav.ts:269` gates `roles` on `{resource:'roles', action:'view'}` (not a real action); `Roles.tsx:118` requires `useCan('roles','manage')`. | Unify on the real permission. Gate the nav item and the page on the same resolvable grant; verify against the RBAC matrix. |
| **8** | **One-click destructive close with no confirm** (Cases). | Cases bulk/inline close has no confirmation. | Route destructive closes through the shared `ConfirmDialog` primitive (§2). Keep the close POSTing through `decide()` (#3). |
| **9** | **Campaigns "Recorrelate" gated by READ perm** — every viewer sees an enabled admin button. | Admin recorrelate action gated by a read permission. | Gate the mutating action on the manage/admin grant; disable-with-tooltip for read-only users. |
| **10** | **`api.setup.initAdmin` POSTs to a removed endpoint (404).** | `api.setup.initAdmin` → `setup/init-admin` (removed in Round-4 audit); live flow uses `setup/account`. Never called today (dead stub). | Delete the dead stub (nothing calls it). |
| **11** | **`request_approval` automation action is a dead end** — forces Proposal kind → approve 400s. | `threshold_automation` `request_approval` path. | Either wire the approval kind so it can be approved, or remove `request_approval` from the offered actions until it round-trips. Prefer wiring; fall back to removal if out of scope. |
| **12** | **`TuningLedgerRow` renders every row "Active"** regardless of state. | Tuning ledger row status hardcoded. | Render the real per-row state (applied/rolled-back/shadow) from the ledger. |
| **13** | **SQL `sort_field='risk_score'` silently no-ops.** | SQL repository sort ignores `risk_score`. | Map `risk_score` to the real column (or reject unknown sort fields explicitly). Add a regression test. |
| **14** | **`derive_priority` disagrees between the triage chip and the shift report** on `matrix.enabled`. | `engine/priority.py` consumed two ways with divergent `matrix.enabled` handling. | Single source of truth for priority derivation; both consumers call the same path. Add a test pinning agreement. |

**Handling.** #1, #2, #3, #4, #6, #7, #8, #9, #10 ship inside the UI waves that touch their surfaces. #5, #11, #12, #13, #14 ship inside the backend/loose-coupling wave (each with a net-new regression test — several currently have none). Every bug fix keeps wire keys byte-identical.

---

## 4. Scope + non-goals + risk register + rollback

### 4.1 In scope
- Token role-split + 3-axis palette + chart ramps + AA guard + fonts (G1/G2).
- Card/header/badge/button/tab codemod to primitives; typography + spacing scale layer; missing shared primitives + hooks (G2).
- Settings IA regroup (6→5, Security promoted) + data-driven section registry + duplicate-home collapse + schema-driven fallback (G3).
- `<PageContainer>` width modes + Overview/Metrics/Cases density + three-zone dashboard layout + hero compaction (G4/G5).
- Rule customization Phase 1-2 (auto-close fix, four-section editor, flat builder, NumberField/LabeledSlider, preview via pure `decide()`, version ledger, shadow state, zod, typed config endpoints, `settings_schema` renderer) + gated Phase 3 (react-querybuilder, pySigma, CodeMirror) (G6).
- Custom dashboards MVP (3-5 widgets, `UserPrefs.dashboards`, widget registry, RGL edit mode, org/role defaults) (G7).
- FE registry unification + `useNavigate` + `useAsync`/`errorMessage`/`LoadError` + layering inversions + god-file splits + backend router-split (one feature/PR) + entry-point registry + openapi-typescript (G8).
- a11y: `<Field>` wrapper (~39 unlabeled controls), non-color signaling (`SEMANTIC_ICON`), 4 new WCAG 2.2 AA criteria, MotionConfig + reduced-motion refinement, jest-axe/eslint-a11y CI gate + contrast checker (G9).
- Terminology glossary extension + one-verb-per-concept relabel (UI strings only).
- The 14 confirmed bugs.
- **G10 — a second UI-polish pass** after the structural work lands (visual review, spacing/rhythm sweep, empty/error/loading consistency, micro-copy).

### 4.2 Non-goals (explicit)
- No design-system swap; no Tailwind v4 / OKLCH / `@theme inline` (deferred — flips the shadcn token contract, needs a full retest).
- No recharts replacement (Tremor rejected — needs Tailwind v4, competing token system, re-opens #9).
- No big-bang router rewrite; no runtime plugin loaders / Module Federation for first-party code; no full Feature-Sliced-Design.
- No TanStack Query (optional, not approved this round); no `react-hook-form` (controlled draft-snapshot already works).
- No State-store / OCSF-mapper SPIs; no phone-first responsive rebuild (add a mobile drawer + dialog margins, but the console stays desktop-primary).
- No change to `decide()`, no retroactive re-keying of open cases when correlation config changes, no rule/dashboard/automation path that sets status or bills LLM in preview.
- Dashboard sharing/ACLs, cross-filtering, import/export — deferred past MVP.

### 4.3 Risk register — what could break

**Tests / strings that will break (migrate to `data-testid` BEFORE touching UI):**
- **`App.smoke.test.tsx:94/:104` + `settings.render.test.tsx:177`** — the `"Security Posture Dashboard"` boot guard. Extract to a constant, update in lockstep, **do not delete** (white-screen safety net). *Highest priority.*
- **The 273 Vitest specs must be re-snapshotted in BOTH light and dark** after any token change; any `--{hue}` split or `label→token` unification invalidates color snapshots.
- **Class-string / hex assertions** — `RiskGauge.test.tsx` (`stroke-muted`, `text-low/medium/high/critical`, exact SVG structure), `ui-glitch-fixes.test.tsx` (`min-w-0`/`flex-1`), `theme-tokens.test.tsx` (specific token names + `quiet`/`command` packs + font enum + ACCENT_PRESETS length), `settings-dirty.test.ts` (`--critical`/`--font-display`/`--radius`) — any card codemod or token split breaks these. Anchor to `data-testid` / assert SECURITY behavior generically first.
- **`test_user_prefs.py:323-325`** — codifies the `misc` clobber bug (#5). Fixing the deep-merge REQUIRES updating this test.
- **Nav labels + topology** — `NavSidebar.test.tsx` (`getByRole('button',{name:…})` for "Overview"/"Dashboard"/"Standup"/"Cases"/"Metrics"/"Analytics"/"Chat"/"Workspace" + host==child collisions). Preserve the `aria-expanded`/`aria-controls`/`aria-current` assertions (the real value); import labels from `nav.ts` so renames flow automatically.
- **Metrics tab strip** — `analytics-consolidation.test.tsx:115-124` asserts exactly 4 tabs + copy; `metrics-posture.test.tsx` pins tile labels + values + the ATT&CK Navigator link.
- **Settings section labels** — `settings.render.test.tsx` hardcodes group/section labels + deep-link `#/settings?s=admin_users` (near-certain break under G3; ship redirect + update labels).
- **Static source-text assertions** — `CaseDetail.tabs.test.tsx`/`CaseDetail.live.test.tsx` `readFileSync` `CaseDetail.tsx`; `bundle-first-paint.test.ts` reads built chunks + forbids static recharts/framer imports. Splitting/moving files or changing lazy→eager breaks these — update the `readFileSync`/`path.resolve` targets and keep lazy imports lazy.
- **Backend pytest (1461) is SAFE for UI-only work** UNLESS wire-keys or `settings_schema` field names change. G6 typed endpoints / schema reflector changes / `DashboardStore` MUST add net-new tests (no G6/G7 coverage exists) and keep `types.ts` hand-mirrored. `test_settings_roundtrip.py:131-183` + `test_rule_catalog.py` assert config wire-names — safe unless renamed.
- **Pages with ZERO tests** (net-new coverage if changed): Overview, Standup, Approvals, Memory, Investigate, Sources, Catalog.

**Behavioral / correctness risks:**
- Global padding/width/token changes ripple across every page — gated by full vitest + visual review, per-batch.
- `CaseDetail.tsx` (160KB, 33 raw `p-6` cards) is the highest-risk migration — a dedicated workstream with visual review, not a blind sed; its `{caseId,onClose,onNavigate?}` contract must not change when split (4 hosts + `route.opts.caseId`).
- Backend router split must keep paths byte-identical (webui contract) — `pytest` + `test_route_auth_coverage` after each slice; any non-GET route must keep its `require_permission` gate (the coverage test fails otherwise).
- Reduced-motion global rule (`theme.css:273-280`) sets `transition-duration ~0 !important` on all elements — re-test Radix Select/Dialog/Sheet open state.
- Overview loading skeleton mirrors the grid — change columns/gauge and the skeleton must change in lockstep.
- `--{hue}` tokens are solid fills with white text (StatCard/RiskGauge/CaseTriageHeader/NotificationBell/DangerZone) — any darkening for text-legibility must be re-verified as white-on-fill.
- New rule/dashboard/automation surfaces are exactly where unlabeled-control a11y defects cluster — ship labels/aria from the start.

**Load-bearing invariants (restated):** deep-link back-compat for all page ids + `#/settings?s=<id>` + old standalone routes (redirect, don't 404); `PUT /api/settings` merge; secret-boolean; #9 plain-text rendering of untrusted values; the 401/reauth ladder + auth back-compat; NavSidebar synchronous nav-prefs hydration; QRCode encoder math; Login stays eager + framer-motion-free; `resolveDark` precedence + "quiet"-material glass behavior; graceful-degradation paths; anchor IDs (`detection-correlation`, `advanced-suppression`, `tuning-policy`) are deep-link targets — relabel, don't rename the id.

### 4.4 Rollback posture
- **Every change is additive + default-safe.** New engine features stay default-OFF; new dashboards default read-only; token roles add new vars (old vars kept where consumed); the auto-close fix points at an existing field (`fp_auto_close` retained for migration).
- **Codemods are mechanical and per-batch reviewable** — each card/header/button batch is its own commit with a vitest gate, revertable in isolation.
- **Backend router split is path-byte-identical** — reverting a slice restores the monolith with no contract change.
- **New deps are lazy/dev where possible** — RGL/react-querybuilder/CodeMirror never touch the default read bundle; removing a gated feature removes its dep from the loaded surface.
- **No migration to reverse:** `UserPrefs.dashboards` + rule config default to `[]`/existing defaults; legacy buckets load unchanged; reset = delete the user's bucket key.
- **Journal + IMPLEMENTATION.md track each wave** so any wave can be reverted at its commit boundary.

---

## 5. New-dependency ledger (approved list, with justification)

Nothing outside this table gets installed. Current runtime deps (verified): recharts ^2.15.4, framer-motion ^11.18.2, cmdk, lucide-react, sonner, tailwind-merge, clsx, class-variance-authority, the Radix primitives, React 18.3.1. Tailwind ^3.4.19 (v3).

| Dep | Type | Size | For (goal) | Justification | Verdict |
|---|---|---|---|---|---|
| `@fontsource-variable/inter` | **dev** (build-time WOFF2) | assets only, 0 runtime JS | G1/G2 | Ship the font we already declare (config lies today); consistency across OSes, offline-safe, enables `ss01`/`cv01`. | **APPROVE** |
| `@fontsource-jetbrains-mono` | **dev** | assets only, 0 runtime JS | G1/G2 | Mono for IDs/logs/numerics. | **APPROVE** |
| `@tailwindcss/container-queries` | **dev** (Tailwind plugin) | tiny, 0 runtime | G4/G7 | Per-archetype responsive widths for `<PageContainer>`. First-party. | **APPROVE** |
| `@tanstack/react-virtual` | runtime | ~10 KB gz | G4/G9 | Virtualize cases/logs tables (1000+ rows). Loads with the pages that need it. | **APPROVE (scoped)** |
| `@tanstack/react-table` | runtime | ~15 KB gz | G8 | Headless engine under the existing `DataTable` — kills ~13 duplicated filter/sort/slice paths; our component API stays; additive + reversible. | **APPROVE (deliberate wave)** |
| `react-grid-layout` v2.2.3 | runtime, **lazy (edit mode only)** | ~18.5 KB gz | G7 | The custom-dashboard drag/resize grid; item shape *is* the persistence schema; MIT; React-18; Grafana/Metabase precedent. The one dashboard dep. | **APPROVE** |
| `zod` | runtime | ~13 KB gz | G6 | Single source of client-side rule validation + defaults mirroring `config.py`. | **APPROVE (Rules Phase 2)** |
| `react-querybuilder` v8 | runtime, **flag-gated + lazy** | RQB core (tree-shake formatters) | G6 | Nested AND/OR condition trees (exceptions) via the official shadcn registry (copies editable source in). | **APPROVE (Rules Phase 3, gated)** |
| CodeMirror 6 | runtime, **lazy** | ~300 KB | G6 | Optional raw-YAML rule escape hatch. Never Monaco. | **APPROVE (Rules Phase 3, opt-in)** |
| `openapi-typescript` | **dev** | 0 runtime bytes | G8 | Generate request/enum TS types from OpenAPI; fits the plain fetch wrapper. | **APPROVE** |
| `eslint-plugin-import-x` | **dev** | 0 runtime | G8 | Enforce feature-folder boundaries (`no-restricted-paths`), warn→error per feature. | **APPROVE** |
| `jest-axe` / `@axe-core` | **dev** | 0 prod bundle | G9 | A11y assertions in Vitest/CI. | **APPROVE** |
| `eslint-plugin-jsx-a11y` | **dev** | 0 prod bundle | G9 | Lint a11y at author time. | **APPROVE** |
| `pySigma` | **backend** only | Python | G6 | Sigma rule import/export; instant access to SigmaHQ while staying vendor-neutral (frontend needs nothing). | **APPROVE (Rules Phase 3)** |
| `@dnd-kit` | runtime | ~10 KB | G2/G9 | Column / saved-view reorder drag surfaces. | **CONDITIONAL — install only when a drag surface actually ships (implies the WCAG 2.5.7 non-drag alternative)** |

**Runtime bytes added to the default read-only bundle: effectively zero** — RGL, react-querybuilder, and CodeMirror are all lazy-loaded and never touch the hot read path; react-table/react-virtual/zod are small and load with their pages.

**Explicitly REJECTED:** Tremor (Tailwind v4 hard-blocker + competing token system + re-opens #9), nivo/ECharts/visx (heavy or no a11y), `@elastic/datemath` (drags moment.js), `react-awesome-query-builder` (deprecated moment.js/immutable/lodash), Monaco (2-5MB), chroma-js/d3 color runtimes, windy-radix-palette, gridstack/dnd-kit-for-grids/snapgrid, pluggy/stevedore, `react-hook-form`, TanStack Query (not approved this round — separate justification required), OKLCH + Tailwind-v4 `@theme` (deferred), Module Federation / runtime plugin loaders, full FSD, moment.js in any form.

---

## 6. Success criteria

The overhaul is done when ALL of the following hold:

**Correctness / invariants**
- `engine/case_manager.py` `decide()` is **byte-identical** (diff-verified in CI).
- All 14 confirmed bugs fixed, each with a regression test; the auto-close toggle demonstrably changes what `decide()` acts on (via `POST /api/triage/preview-decision`).
- `PUT /api/settings` still deep-merges; no unrendered block is wiped by any new section (round-trip test).
- #6 (one ledger write/call) holds; rule preview + dashboards + what-if bill **zero** LLM calls (asserted).
- #9 upheld: every new widget title/label, rule name, rule field value, dashboard name renders plain text/SVG (no `dangerouslySetInnerHTML`; allowlist-validated).
- Deep-link back-compat: all page ids + `#/settings?s=<id>` + old standalone routes resolve (redirect test).

**Tests green (the gate before every commit)**
- Backend `pytest -q` green (≥1461, rising with net-new G6/G7 + bug-fix tests).
- `npm run build` clean (`tsc --noEmit && vite build`).
- `vitest run` green (≥273, re-snapshotted in light + dark; brittle string/class assertions migrated to `data-testid`).
- `npm run lint` — 0 `react-hooks/rules-of-hooks` errors; new `eslint-plugin-jsx-a11y` + `import-x` boundaries pass (warn→error rollout).
- CI drift gate green (`openapi.json` + generated types committed, `git diff --exit-code`).
- New: responsive tests (none exist today) + jest-axe assertions on load-bearing surfaces.

**A11y AA — real, not claimed**
- The in-repo contrast checker gates 4.5:1 (text) / 3:1 (non-text) in both themes; the false in-code "WCAG-AA" comments corrected; no severity/status/verdict badge fails 4.5:1 in either theme; the teal branding preset + dark primary button pass or are guard-corrected.
- Non-color signaling on every badge/gauge/chart legend/heatmap (`SEMANTIC_ICON`); RiskGauge shows numeric value + band label.
- The 4 new WCAG 2.2 AA criteria met (target size, focus-not-obscured, dragging alternative, accessible auth); ~39 unlabeled controls fixed via `<Field>`; keyboard-only + NVDA/VoiceOver spot-checks pass on Settings, the rule editor, and a custom dashboard.

**Density / space reclaimed (G4/G5)**
- Overview hero band ≤ ~64px (from ~176px); the first metric row is above the fold on a ~820px laptop viewport.
- Operational pages (Cases/Metrics/Cost/Dashboards) use the `wide`/`fluid` width mode — no dead 1400px gutter on ≥1920px; grids add columns at `xl`/`2xl`.
- One card grammar (`<Card>` everywhere; 44 raw cards codemodded; 0 mixed-elevation screens); one page-title standard; one segmented control; one badge authority; the typography/spacing scale layer live (≤ ~10 arbitrary `text-[..]` escapes remain, all justified).

**Settings / IA (G3)**
- 5 top-level groups, Security promoted; ≤2 menu levels; the 6 duplicate standalone/embedded homes collapsed to one host each; `Settings.tsx` decomposed to a data-driven registry + per-section files (no 2673-line god-file); the section taxonomy has ONE source of truth; the schema-driven fallback renders orphaned knobs.

**Rules usable (G6)**
- An operator can, in the UI: edit auto-close (FP + TP opt-in, needs_human locked) and see it affect the simulator; create/edit/enable/disable/shadow a detection rule (match+threshold and anomaly), a correlation rule, and a case-automation rule; edit tuning (all 8 fields), baseline, campaign, batch, asset criticality, SLA, priority matrix; preview a rule against 7-14 days of data (no LLM, no `decide()`); roll back a rule change from the version ledger; and reach any remaining knob via the schema fallback. Every action is audited and RBAC-gated under one unified rules permission.

**Dashboards usable (G7)**
- An operator can create a custom dashboard, add 3-5 widgets from a curated gallery, drag/resize (mouse + keyboard) in an explicit edit mode, configure each widget, save, and reload it persisted per-user (zero-migration KV); per-role default dashboards clone-to-customize on first edit; the read-only default never bills extra round-trips (one `DashboardDataProvider` fetch).

**Loose coupling (G8)**
- One `FEATURES[]` registry drives nav+routes+palette; `onNavigate` prop-drilling removed (pages render standalone via `useNavigate`); `useAsync`/`errorMessage`/`LoadError` adopted (25 error copies + 3 idioms gone); layering inversions inverted; both god-files split; `routes.py` split one-feature-per-PR (paths byte-identical); the notification/LLM entry-point seams added; request/enum types generated from OpenAPI.

**Quality (G9/G10)**
- The G10 second polish pass completed (visual rhythm sweep, empty/error/loading consistency via `LoadError`/`EmptyState`/skeletons, micro-copy + terminology one-verb-per-concept), with docs (`CLAUDE.md`/`HANDOFF.md`/`README.md`/`ROADMAP.md`/`CHANGELOG`/Round-5 `IMPLEMENTATION.md`) and the Journal updated.

---

## 7. Sequencing (recommended)

Additive + reversible at every step; `pytest`/`build`/`vitest`/`lint` green + `decide()` byte-identical + docs/Journal updated before each commit.

1. **Wave 0 — test-anchoring + foundations (unblock everything, dep-light).** Migrate brittle string/class assertions to `data-testid`; extract the `"Security Posture Dashboard"` constant. Ship fonts (§1.1), the 3-axis palette + token role-split + chart ramps + AA guard (G1), the type + spacing scale layer, chrome tokens, `SEMANTIC_ICON`, the `KpiTile` fix (bug #2), the 4 WCAG 2.2 criteria + `<Field>` wrapper, and the a11y/contrast CI gate.
2. **Wave 1 — primitives + codemod + IA + coupling Wave-1.** Extract the missing shared primitives/hooks; codemod raw cards→`<Card>`, HeroPanel→PageHeader (G5), raw buttons→`<Button>`, hand-rolled strips→`SegmentedControl`, errors→`LoadError`; `<PageContainer>` width modes + Overview/Metrics/Cases density (G4); Settings regroup + Security promotion + data-driven registry + duplicate-home collapse + deep-link fixes (G3); `FEATURES[]` registry + `useNavigate` + `useAsync` + operationIds + openapi-typescript (G8 W1). Fix bugs #1, #3, #4, #6, #7, #8, #9, #10 in-flight.
3. **Wave 2 — dashboards MVP (G7).** Three-zone layout + TimeRangePicker; `UserPrefs.dashboards` + `misc` clobber fix (bug #5) + widget registry + RGL edit mode; 3-5 seed widgets per role.
4. **Wave 3 — rules Phase 1-2 (G6).** Auto-close editor (bug #1 hardened) + four-section editor + NumberField/LabeledSlider + flat builder + preview via pure `decide()` + version ledger + shadow state (dep-free), then zod + typed config endpoints + `settings_schema` renderer + MITRE view. Fix bugs #11, #12, #13, #14.
5. **Wave 4 — coupling Wave 2-3 (G8).** Split `routes.py`/`CaseDetail.tsx` one-slice-per-PR; ESLint boundaries + `response_model`s + entry-point discovery + CI drift gate.
6. **Wave 5 — gated/conditional (G6 Phase 3).** react-querybuilder + pySigma + optional CodeMirror; `@tanstack/react-table` under DataTable; `@dnd-kit` iff a drag surface ships.
7. **Wave 6 — G10 second polish pass + adversarial audit + docs.** Visual rhythm sweep, state consistency, terminology one-verb-per-concept, keyboard/AT spot-checks, docs + Journal + `IMPLEMENTATION.md`.

---

*Every wave: additive + reversible · `case_manager.py` byte-identical (#3) · #6/#9/#10/#2 upheld · `PUT /api/settings` merge preserved · deep-links + wire keys byte-identical · `types.ts` hand-mirrored · `pytest -q` green + `npm run build` clean + `vitest run` green + `npm run lint` (no rules-of-hooks errors) · docs + Journal updated.*
