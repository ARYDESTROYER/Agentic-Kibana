# Round 5 — Executive Summary: State of the App + What the Overhaul Must Do

> **Scope:** UI/UX overhaul of the TLSOC Agentic Triage Suite webui (Vite+React+TS+Tailwind+shadcn/Radix SPA) with supporting backend wiring for rule customization (G6) and custom dashboards (G7). Synthesized from 5 domain maps: `WEBUI_PAGES_MAP.md`, `DESIGN_SYSTEM_MAP.md`, `WEBUI_SHELL_COMPONENTS_MAP.md`, `BACKEND_MAP.md`, `AUDITS.md`.
>
> **HARD INVARIANT (repeated by every domain):** `engine/case_manager.py` `decide()` stays **byte-identical**. Zero new runtime deps. #9 untrusted-data fencing, #10 secrets-as-booleans, RBAC gates, and the 401/reauth ladder are preserved throughout.

---

## 1. Verdict (one paragraph)

**This is a consolidation job, not a reinvention.** All five domains independently reached the same conclusion: the shadcn/Radix/Tailwind + CSS-var-token foundation is genuinely good and is the correct base for G2 — the problem is that it is **not enforced end-to-end**. The app is dragged down by a small set of *structural root causes* that each metastasize across dozens of pages: two parallel card grammars, two parallel nav systems (`nav.ts` rail vs `Settings.tsx`'s self-rolled IA), two parallel semantic-color systems that have already drifted, three parallel API/type layers, a hard `max-w-[1400px]` shell cap with no per-page opt-out, and two god-files (`Settings.tsx` 2673 LOC, `CaseDetail.tsx` 4210 LOC) that concentrate most FE debt. Layered on top are **real correctness bugs** — most critically the Auto-close Settings panel writes to a **dead field** (`prefs.fp_auto_close`) that `decide()` never reads, so the flagship autonomy toggle does nothing — plus measured **WCAG-AA failures that in-code comments falsely deny**. The highest-leverage work is therefore: extract the missing shared primitives + fix the structural root causes once, up front, then adopt them everywhere via codemod. The rich backend config models for G6 already exist; the gap is almost entirely API-surface + UI wiring, not the config layer. G7 (custom dashboards) is greenfield but has a proven zero-migration KV persistence template to hang off of.

---

## 2. Top 15 Problems, Ranked by Impact

| # | Problem | Goal(s) | Effort | Evidence |
|---|---------|---------|--------|----------|
| **1** | **Auto-close UI edits a DEAD field.** `AutonomyControls` binds `prefs.fp_auto_close` (`Settings.tsx:1093-1094`); `decide()` reads `prefs.auto_close` (`case_manager.py:132-138`); the migration never fires because `put_settings` always populates `auto_close` via default_factory. **Toggling "Auto-close confident false positives" changes nothing the engine acts on.** Fix is UI-plumbing only — point at `prefs.auto_close.false_positive`, add the `true_positive` opt-in, lock `needs_human`. Never touch `decide()`. | G6 | **S** (small, high-value) | Domain 2, 4, 5 |
| **2** | **Two god-files drive most FE debt.** `Settings.tsx` = 2673 LOC / 26 components / 5-level nesting / 3 parallel save mechanisms / section taxonomy hand-synced across 3 files. `CaseDetail.tsx` = 4210 LOC / 4 host callers / 31–33 raw `p-6` cards / never imports `@/ui/card`, `PageHeader`, or `badges`. Splitting both is the **precondition** for G3, G6, G8 and any safe G1/G2 codemod. | G3, G5, G6, G8 | **L** | Domain 1, 5 |
| **3** | **Two card grammars (elevation + padding drift).** A shared `@/ui/card` (with `shadow-elev1`) exists but pages hand-roll `rounded-lg border border-border bg-card p-5/p-6` instead: CaseDetail 31×, Settings ≥8×, Models 3×, Roles 2× (and the two disagree). Hand-rolled cards carry no elevation → render visibly flatter. Single biggest G2/G8 lever; fixable by codemod. | G2, G8 | **M** | Domain 1, 5 |
| **4** | **Two parallel navigation systems = the G3 clutter root.** `nav.ts` (6 groups, 3–4 single-item wrappers whose header duplicates the item) + `Settings.tsx`'s OWN IA (`SECTION_GROUPS`, 6 groups × ~20 sections, its own `#/settings?s=` sub-router + scroll-spy TOC = two nav paradigms). Admin surfaces (Users/Security/Sessions/Account) have **two coexisting homes**. Net nesting up to **4 deep**. Collapse into one data-driven route/section registry (`PAGE_REGISTRY`). | G3, G8 | **L** | Domain 1, 3, 5 |
| **5** | **WCAG-AA failures the code comments deny.** Measured: most light-theme severity/info/success/warning hues fail 4.5:1 (3.24–4.17:1); dark white-on-`--primary` (3.35), white-on-`--critical` (3.60), and `teal` preset (3.74) fail on the most common CTA/badge labels; `--border` ≈1.3:1 (borders invisible). Yet `theme.css:49,82,175,203` assert "WCAG-AA". Root cause: each `--{hue}` token is overloaded as text + 10%-wash + solid fill and **cannot** satisfy both at once. Fix: split into `--{hue}` / `--{hue}-foreground` / `--{hue}-text` (Radix Colors as generator) **and** correct the stale claims. | G1, G9 | **M** | Domain 2, 5 |
| **6** | **Hard `max-w-[1400px]` shell cap, no per-page opt-out.** Every routed page renders inside `mx-auto w-full max-w-[1400px] … px-4 sm:px-6` (`AppShell.tsx:601`). ~140px dead gutter/side at 1920px, ~440px at 2560px. Pages have no hook to widen. A shell-provided width mode (`fixed|wide|fluid`) via `<PageContainer>` is the single highest-leverage G4/G7 change. (The `tailwind.config` `.container` is a red herring — unused.) | G4, G7 | **S–M** | Domain 3, 5 |
| **7** | **Rule config is invisible / fragmented (G6 has no home).** `rule_catalog` (18 seeded `RuleDefinition`s w/ `RuleMatch` field/op/value), `correlation_rules`, `asset_networks`/`asset_criticality`, `SlaPolicy`, `PriorityMatrix`, `suppression_rules` appear **0× in the webui** — editable only via the monolithic `PUT /api/settings` deep-merge blob. Round-4 blocks (`threshold_tuning`/`campaign`/`baseline`/`batch`, `caps.max_concurrent`) have **no Settings UI at all**. Models are fully expressive; customization is invisible. Consolidate into one "Detection & Rules" home. | G6 | **L** | Domain 1, 4 |
| **8** | **Dead `GET /api/settings/schema` pipeline blocks G3+G6.** `settings_schema.py` (220 LOC) builds a generic form descriptor with **0 webui consumers** — and structurally can't describe list/dict rule collections (they collapse into a junk `general` bucket). Extend the reflector to descend into element models + wire it → a generic renderer replaces much of `Settings.tsx` AND unlocks orphaned rule knobs. One change serves G3, G6, and loosens the systemic "add config + endpoint, forget the form" coupling failure. | G3, G6, G8 | **M–L** | Domain 4, 5 |
| **9** | **Three parallel API/type layers (G8's biggest blocker).** `lib/api.ts` (~120 typed methods, 797 LOC) + **16 co-located `*.api.ts`** (raw string paths + local types, **111 raw call sites**) + `useEventStream.ts`. `lib/types.ts` (2047 LOC, 48 importers) mirrors **only** Round-1/2 — the real `AutoClosePolicy`, `correlation_rules`, Round-4 blocks are **unmirrored**, so G6 has no typed foundation. Duplicate type names (`MitreTechnique`, `ActivityResponse`, `ModelRole`) are an import-the-wrong-one hazard. | G6, G8 | **M** | Domain 3 |
| **10** | **Overview hero + dashboard waste ~31% of the fold.** `HeroPanel` ≈176px of chrome before any data; eyebrow+title restate the breadcrumb; 208px risk gauge; 7 KPIs crammed into a 2/3 column with a redundant `<dl>` duplicating 3 tiles; ~120 lines of client posture math shadowing the server endpoint. Swap `HeroPanel`→`PageHeader` (both exist, near-identical → merge with a `compact` variant) reclaims ~90px; shrink gauge + un-nest KPI grid reclaims the rest. | G4, G5 | **M** | Domain 1, 3, 5 |
| **11** | **Two parallel semantic-color systems, already drifted.** Charts pull `palette.ts SEMANTIC`; every badge/pill/gauge uses an independent switch in `badges.tsx` + `ui/badge.tsx` cva. Confirmed drift: `escalated` orange in charts / red in badges; `duplicate` different surfaces; 4 hand-rolled 0–100 band ladders disagree on cutoffs. No single color authority. Fix: ONE `label→token` map driving both. | G1, G2, G8 | **M** | Domain 2 |
| **12** | **G7 custom dashboards = zero infra, but a proven template exists.** No widget registry, grid, or per-user layout — every tile is hardcoded JSX. BUT `PrefsContext`/`UserPrefsStore` (single JSON-in-KV doc, zero migration) + saved-views as the `DashboardView` template + pure metric functions (each posture/coverage/shift payload key *is* a widget) make this a per-user `DashboardStore` (copy `inbox.py`/`tuning.py`) + a widget descriptor/registry + `<WidgetGrid>`. No new index/table/migration. | G7 | **L** | Domain 1, 3, 4 |
| **13** | **`misc` prefs write CLOBBERS instead of deep-merging.** `user_prefs.py:103-122` REPLACES rather than deep-merges the `misc` bag (codified in `test_user_prefs.py:323-325`) — would silently destroy any dashboard config stored there. Must fix BEFORE G7 hangs anything off it; use the lost-update-safe `kv_mutate` CAS pattern (`inbox.py`/`tuning.py`), not `user_prefs.py`, for the new `DashboardStore`. | G7, G9 | **S** | Domain 3, 4 |
| **14** | **Layering inversions + trapped editors block G8.** Shared `components/` import UP into `pages/*.api` (CaseTriageHeader→CaseDetail.api, RoleMatrixEditor→Roles.api, ModelsCatalog→Models.api, NotificationPrefs→Inbox.api); `SessionsTable` lives in a page but imported by another page. Rich editors (RoleMatrix tri-state cell, TemplateEditor live-preview, the config editors) are trapped inside pages. Extract to `components/`; invert the dependency direction. | G8 | **M** | Domain 1, 3 |
| **15** | **Missing shared control primitives → hand-rolled everywhere.** No shared SegmentedControl, FilterBar, ConfirmDialog, IconInput, SecretField, TagInput, `<Field>` a11y wrapper, `useAsync`, `useDirtyDraft`. Each hand-rolled 2–9× with drifting classes; `window.confirm()` still used for destructive deletes (Users, Roles); ~39 form controls have unassociated labels (clustered in the future G6 rule builder). Extract once; a single `<Field>` fixes the a11y cluster. | G2, G8, G9 | **M** | Domain 1, 2, 5 |

**Effort key:** S = ≤1 day-ish / low-risk plumbing · M = a focused sub-wave · L = a full wave / needs sequencing.

**Confirmed bugs surfaced in passing (fix regardless — not counted in the 15):**
- Metrics delta arrow/color contradiction: improving lower-is-better metrics show a **green UP arrow next to "-12%"** (`deltaView` sign-flip vs `KpiTile`).
- Wizard demo toggle is **cosmetic** — writes a dead `demo_mode` key, never arms `Preferences.demo` / `POST /api/demo/enable` (0 backend hits).
- Roles **nav/page perm mismatch:** nav gates `roles:view` (not a real action); page requires `roles:manage`.
- Cases: one-click destructive close with **no confirm**. Campaigns: admin "Recorrelate" gated by **read** perm (every viewer sees an enabled button).
- Clipboard over plain HTTP: `CodeBlock.tsx:99-111` + `ChatPanel:338-347` call `navigator.clipboard?.writeText` (undefined on `http://host:8080`) then optimistically show "Copied"; the purpose-built `lib/clipboard.ts copyText()` fallback is never used.
- `api.setup.initAdmin` POSTs to the removed `setup/init-admin` (would 404); live flow uses `setup/account`.
- Automation verdict options offer `suspicious`/`benign` (Disposition values) that can never match a `Verdict` → those rules silently never fire.
- `request_approval` automation action is a dead end (forces Proposal kind → approve 400s); `TuningLedgerRow` renders every row "Active"; SQL `sort_field='risk_score'` silently no-ops; `derive_priority` disagrees between triage chip and shift report on `matrix.enabled`.

---

## 3. The 3 Biggest Quick Wins

These are the fastest routes to visible, high-value progress and should lead the overhaul.

### QW1 — Hero compaction (G5)
Overview's `HeroPanel` is ~176px of chrome before any data; the eyebrow+title restate the breadcrumb. `HeroPanel` and `PageHeader` are near-identical. **Action:** merge them into one component with a `compact`/`density` variant, swap Overview to it (reclaims ~90px), and shrink the 208px risk gauge. Low risk, immediately visible. **Caution:** `App.smoke.test.tsx` boots on the literal string "Security Posture Dashboard" — update that guard in lockstep, don't delete it (see §6).

### QW2 — Dashboard density (G4)
Un-nest Overview's KPI grid (7 tiles in a cramped 2/3 column), delete the redundant `<dl>` that duplicates 3 tiles, and remove the ~120 lines of client posture math that shadow the server endpoint. Introduce a `<PageContainer variant="wide|fluid">` so the dashboard escapes the hard `max-w-[1400px]` gutter on wide displays. `CommandCenterLayout.strip` is an unused seam ready for a compact KPI band. Together QW1+QW2 recover the ~31% of the fold currently burned on chrome.

### QW3 — Settings IA declutter (G3)
The 2673-line `Settings.tsx` has 6 groups → ~20 sections → per-section scroll-spy TOC (two nav paradigms); Appearance/Security/Sessions each appear twice; a `GRID_SECTIONS` allowlist bug double-wraps Automation (card-in-a-card). **Action (staged):** (a) collapse the duplicate homes and single-item nav wrappers; (b) decompose the monolith into a **data-driven section registry** + per-section files; (c) fix the double-wrap. This is the precondition for wiring G6 rule editors cleanly. Full split is L-effort, but the dedup + registry scaffolding is a fast, high-visibility first cut.

---

## 4. Customization Plan Seeds

### 4a. Rules customization (G6)
**Backend reality:** the *data model* is already rich and mostly ready — the gap is API surface + UI wiring, not config.
- **Auto-close (highest value, smallest fix):** write a `VerdictAutoClose` sub-editor rendered twice (FP / TP), with `needs_human` **locked** (code-enforced never-auto-close). Post to `prefs.auto_close` (the field `decide()` actually reads). Add the supported `true_positive` opt-in (OFF by default). **Do not touch `decide()`.**
- **Detection / correlation / asset / SLA / priority / suppression:** consolidate `rule_catalog`, `correlation_rules`, `asset_networks`/`asset_criticality`, `SlaPolicy`, `PriorityMatrix`, `suppression_rules` into one **"Detection & Rules"** home. Add typed config endpoints for baseline/campaign/batch mirroring `routes_tuning`'s `GET/PUT /tuning/config` (only tuning has one today).
- **Schema-driven fallback:** extend `settings_schema.py` to descend into element models (fixing the list/dict `general`-bucket collapse) and wire the dead `GET /api/settings/schema` → a generic renderer for the long tail of knobs. Use the connector `AuthField`/manifest/entry-point SPI as the blueprint (the codebase's cleanest loose-coupling exemplar).
- **What-if safety:** a thin `POST /api/triage/preview-decision` wrapper over the pure `decide()` gives a safe simulator with **no engine change**.
- **Typed foundation:** mirror the real config types (`AutoClosePolicy`, `correlation_rules`, Round-4 blocks) into `lib/types.ts` first — G6 has no typed foundation without this (no codegen exists; every model change is hand-mirrored).
- **RBAC cleanup:** unify the fragmented grants (baseline→`settings:read`, campaigns→`cases:read`, batch→`models:read`, tuning→`automation:read`) under one rules permission.

### 4b. Custom dashboards (G7)
**Greenfield, but a zero-risk recipe exists.**
- **Persistence:** a per-user `DashboardStore` copying `inbox.py`/`tuning.py` (the `KVStore` + `kv_mutate` CAS + per-user-key pattern, mirrored on ES/SQL/SQLite). **No new index/table/migration.** Do **not** build on `user_prefs.py` (lost-update-unsafe; fix its `misc` clobber bug — Problem #13 — either way).
- **Schema:** add a `dashboards` field mirroring the existing `saved_views` template; introduce a widget descriptor schema (none exists anywhere yet).
- **Widget registry:** each existing pure metric function (posture / coverage / shift payload key) *is* a widget — dispatch to them by name. Reuse existing chart primitives.
- **Grid:** a `<WidgetGrid>` + per-user layout, fed by the width-mode `<PageContainer>` from QW2.
- **Frontend infra already present:** `PrefsContext` + `UserPrefsStore` cascade is the exact plumbing; `last_list_state` is plumbed-but-dead and can be revived; saved-views is the working precedent.

---

## 5. Loose-Coupling Verdict (G8)

**The foundation is loosely coupled where it was designed to be, and tightly coupled where it grew organically.** Exemplary, reusable pieces exist (DataTable, format.ts, cn.ts, RiskGauge, BarList, EnrichmentProvidersEditor, the connector SPI, the KV-store pattern, the per-feature routers). The coupling failures are concentrated and fixable:
1. **Layering inversions** — shared `components/` import UP into `pages/*.api`; a page-local table (`SessionsTable`) is imported cross-page. Invert the dependency direction; move trapped editors into `components/`. (Problem #14)
2. **Three API/type layers** instead of one contract — the biggest blocker; unify toward one typed client + one `types.ts` mirror. (Problem #9)
3. **Dual page/nav registries** (`App.tsx` / `nav.ts` / `PAGE_IDS`) — collapse into one `PAGE_REGISTRY` route table; URL-serialize `NavOpts` for bookmarkable views. (Problem #4)
4. **The "add config + endpoint, forget the form" pattern** — the recurring coupling failure that leaves rich models invisible; the schema-driven renderer (Problem #8) structurally breaks it.
5. **Hand-rolled clones** (3 headers, 2–3 stat tiles, 2 matrix tables, 3 form-primitive vocabularies, 3 duration formatters, 4 copy-button impls, 4 focus-ring recipes, 2 overlay surfaces) — extract shared primitives once, adopt via codemod. (Problems #3, #11, #15)

**Verdict:** G8 is achievable without a rewrite. Do the extractions + inversions **once, up front**, before the codemods and feature work, so every subsequent change lands on the loosely-coupled version.

---

## 6. Explicit List of Tests / Strings That Will Break

**Migrate brittle tests to `data-testid` anchors BEFORE touching UI (G9).** ~10 test files hardcode strings/classes.

- **`App.smoke.test.tsx` — the "Security Posture Dashboard" boot guard.** The smoke test boots on this literal string. G5 hero compaction / rename **must update this guard in lockstep — do not delete it.** Highest-priority migration.
- **The 273 Vitest specs** must be **re-snapshotted in BOTH light and dark themes** after any token change (Domain 2). Any severity/hue token split (Problem #5) or `label→token` unification (Problem #11) invalidates color snapshots.
- **Tests hardcoding Tailwind classes / hex values** — any card-grammar codemop (`p-6`→`@/ui/card`, Problem #3) or `--{hue}` split will break class-string assertions. Anchor to `data-testid` first.
- **`test_user_prefs.py:323-325`** — **codifies the `misc` clobber bug** (Problem #13). Fixing the deep-merge REQUIRES updating this test (it currently asserts the wrong, replace-not-merge behavior).
- **`NavSidebar` doc-drift** — JSDoc says "248px" but the class is `w-60` = **240px** (verified). Cosmetic, but note when touching nav.
- **Backend `pytest` is SAFE for a UI-only overhaul** — UNLESS wire-keys or schema field names change. Any G6 typed-endpoint work, `settings_schema.py` reflector change, or new `DashboardStore` **must add net-new tests** (no G6/G7 coverage exists today) and keep `types.ts` hand-mirrored.
- **Pages with ZERO tests** (net-new coverage needed if changed): Overview, Standup, Approvals, Memory, Investigate, Sources, Catalog.
- **Load-bearing invariants any change must respect:** `decide()` byte-identical (#3); full-doc-replace persistence (`PUT /api/settings` must **merge**, or unrendered blocks get wiped); secret-boolean contract (#10); untrusted-fencing validators + plain-text rendering of untrusted values in CodeBlock/ChatPanel/CaseThread/logs (#9); the 401/reauth gate + auth back-compat ladder; NavSidebar `aria-current` + synchronous nav-prefs hydration; QRCode encoder math; deep-link back-compat for all 31 page ids; Login stays eager + framer-motion-free; `resolveDark` precedence + "quiet"-material glass-opacity behavior + graceful-degradation paths.
- **Dead/misleading tokens to reconcile (not tests, but will surprise codemods):** `--destructive` (fully wired but shadowed by `--critical`, different hue), `--density-unit` (declared, never consumed), no `--shadow-*`/`--chart-*` scale (hardcoded shadows, invisible in dark), Inter/JetBrains fonts declared but never loaded, 101 arbitrary `text-[..]` sizes. Several "customization" tokens silently do nothing.
