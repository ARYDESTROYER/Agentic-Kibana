# WEBUI Shell, Nav, Components & Lib Map — Round 5 P1 (Understanding)

> **Scope.** Read-only mapping of the standalone SPA's *shell/nav/router*, the *component
> inventory* (reuse + consistency), and the *lib layer* (api/types/prefs/util/auth). This is
> the structural substrate every UI/UX overhaul goal (G1–G9) touches. Consolidated from many
> mapping agents; de-duplicated with file:line citations preserved.
>
> **Hard constraint (repeated for every reader):** `backend/app/engine/case_manager.py`
> `decide()` must stay **byte-identical**. Nothing in this domain proposes changing it. Any
> rules/auto-close UI (G6) is a *config reader/writer only* — it must never tempt a `decide()` edit.
>
> **Overhaul goals referenced:** G1 cohesive color (light+dark) · G2 one design standard on the
> existing shadcn/Radix/Tailwind stack · G3 declutter Settings + flatten nesting · G4 use screen
> real-estate · G5 compact "Security Posture" hero band · G6 real rule customizability · G7
> user-created custom dashboards · G8 loose coupling · G9 highest quality, fully tested.

---

## 0. Executive orientation — the five structural facts

1. **The 1400px cap is the app-wide real-estate governor.** Every routed page renders inside
   one wrapper: `mx-auto w-full max-w-[1400px] px-4 py-6 animate-fade-in sm:px-6`
   (`AppShell.tsx:601`). It is unconditional, per-page opt-out impossible. This single line is
   the highest-leverage G4/G7 change in the whole domain.
2. **There are two parallel navigation systems.** `nav.ts` defines the rail IA (6 groups); and
   `Settings.tsx` re-implements its *own* IA (`SECTION_GROUPS`, 6 groups × ~20 sections, its own
   `#/settings?s=` sub-router + scroll-spy TOC). Admin surfaces (Users/Security/Sessions/Account)
   have **two coexisting homes**. This duplication is the root of both the G3 clutter and the
   2673-line `Settings.tsx`.
3. **There are three parallel API/type layers, not one contract.** `lib/api.ts` (~120 typed
   Round-1/2 methods) + 16 co-located `*.api.ts` builders (all Round-3/4 features, raw string
   paths + local types) + `useEventStream.ts` (SSE). `lib/types.ts` mirrors only the Round-1/2
   surface; Round-3/4 shapes live in the sibling files. No single source of truth (G8).
4. **The persistence infra for custom dashboards already exists** — `PrefsContext` +
   `UserPrefsStore` (single JSON-in-KV doc, no new index/migration). Saved views are the exact
   template. But there is **zero dashboard/widget/layout schema anywhere** (G7), and the `misc`
   bag has a **clobbering write bug** that would silently destroy any dashboard config stored there.
5. **The component library is mostly good and loosely coupled** — but its *richest* features
   (column customization, saved views, pagination) are wired to exactly **one page (Cases)**, and
   there are recurring "hand-rolled clone of a shared primitive" smells (three header components,
   two stat tiles, two matrix tables, three duration formatters, four copy-button impls).

---

## 1. Shell / Nav / Router

### 1.1 AppShell — the single app frame (`webui/src/soc/AppShell.tsx`)

Every routed page renders inside `AppShell`: a `flex min-h-screen` row of `[NavSidebar]` +
`[main column]`, where the main column has a sticky frosted `GlassSurface` top bar over a
`<main>` content slot.

| Element | Location |
|---|---|
| `AppShell` FC (export) | `AppShell.tsx:355-616` |
| **Content wrapper (the G4 cap)** — `mx-auto w-full max-w-[1400px] px-4 py-6 animate-fade-in sm:px-6` | `AppShell.tsx:601` (verified) |
| `<main id="socMain" role="main" tabIndex={-1}>` | `AppShell.tsx:600` |
| Sticky top bar `GlassSurface` `sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4` | `AppShell.tsx:489-493` |
| Breadcrumb (productName / pageLabel, plain text) | `AppShell.tsx:496-502` |
| Right action cluster `ml-auto flex items-center gap-2` (Search/⌘K, bell, theme, version, health, user) | `AppShell.tsx:504-594` |
| `healthView()` pure fn (exported, testable) | `AppShell.tsx:103-158` |
| `useHealth()` 15s poll, 2-fail debounce | `AppShell.tsx:168-197` |
| `useNavPrefs()` state consumed here; toggled by ⌘B | `AppShell.tsx:377, 421-424` |
| CommandPalette mount (once) | `AppShell.tsx:609` |
| NavSidebar mount | `AppShell.tsx:473-483` |

**Issues (G4/G5-critical):**

- **The width cap wastes horizontal space, not padding.** On a 1920px display with the 240px
  expanded rail the usable column is ~1680px but content is pinned to 1400px + centered → ~140px
  dead gutter each side; on 2560px it is ~440px per side. Horizontal padding is thin (`px-4 sm:px-6`
  = 16/24px) while the cap is generous — the opposite of what wide screens want. No wide/fluid
  override, no per-page opt-out. (`AppShell.tsx:601`)
- **Breadcrumb duplicates the page title.** The chrome shows `productName / pageLabel`
  (`AppShell.tsx:496-501`) and each page repeats the same label in its own `PageHeader`/H1 below —
  redundant vertical band in exactly the area G5 wants compact. On wide screens nothing scales up
  to fill the 56px-tall bar; the middle stays empty.
- **Magic-number sticky offsets drift.** `layouts.tsx` sticky rails use `top-20` (80px)
  (`layouts.tsx:83,131`) but the actual header is `h-14` (56px) — rails stick 24px too low, leaving
  a visible gap on scroll. `max-w-[1400px]`, `w-16`/`w-60`, `h-14` are all inline literals, not
  tokens, so the shell width budget cannot be computed in one place.
- **Demo-mode spacing hack:** `cn(demoActive && 'mt-4')` at `AppShell.tsx:604` — ad-hoc 16px gap
  only in demo mode; banner/content spacing is inconsistent with the no-banner state.
- **Ad-hoc z-index scale:** skip-link `z-[100]` (`:464`), header `z-30` (`:493`), collapsed
  fly-out `z-50` (`NavSidebar.tsx:453`) — scattered magic values, no documented scale.
- **a11y nit:** the health pill sets `aria-live="polite"` on its trigger (`AppShell.tsx:563`), so
  every 15s poll that changes the label is announced even when nothing is actionable.

**Coupling:** AppShell imports 11 siblings and is bound to `useTheme`/`usePrefs`/`useDemo`
providers (App.tsx wraps it). `useNavPrefs` is **defined in `NavSidebar.tsx` but owned/driven from
AppShell** and threaded back as props — a circular-feeling ownership split. Content width/padding/
per-route re-key are all hardcoded in the shell so **pages have no hook to widen themselves** — the
shell and pages are coupled through an implicit 1400px contract. Good: `healthView()` is exported
and pure; `GlassSurface` decouples via `--glass-*` tokens.

**Load-bearing (do not regress):** skip-link → `#socMain` + `tabIndex={-1}` (WCAG 2.4.1); `key={page}`
forces remount + fade replay + scroll reset on nav; health-pill demo muting (`:397-410`); the
`glass-surface` class + reduced-transparency fallback (`GlassSurface.tsx:57-59`); `useNavPrefs`
synchronous localStorage hydration (no first-paint collapse flash).

---

### 1.2 NavSidebar — sole primary navigation (`webui/src/soc/components/NavSidebar.tsx`)

Renders `NAV_GROUPS` in two width states: expanded `w-60` (240px) drawer / collapsed `w-16` (64px)
icon rail, toggled by the shell hamburger + ⌘/Ctrl+B. Items with `children` become WAI-ARIA
disclosures (drawer) or inline CSS fly-outs (rail); childless items are direct links.

| Structure | Location |
|---|---|
| `NavSidebar` FC + `NavSidebarProps` | `NavSidebar.tsx:521-629` / `:495-514` |
| `useNavPrefs(): NavPrefsValue` (exported shell-owned hook) | `:109-204`; interface `:92-101` |
| `filterGroups(groups, has)` RBAC filter (drops permless items + empty groups) | `:213-227` |
| `ExpandedItem` (drawer disclosure/link) | `:268-376` |
| `CollapsedItem` (rail button + fly-out) | `:382-489` |
| `ChildLink` | `:234-262` |
| localStorage keys `soc.nav.collapsed` / `soc.nav.openGroups` (+ legacy `nav_collapsed`/`nav_open_groups`) | `:59-63` |

**Issues:**

- **G3/clutter — 3–4 single-item groups whose header text duplicates the item label.** Verified:
  `overview → [Overview]` (`nav.ts:142-160`), `intelligence → [Intelligence]` (`:183-200`),
  `analytics → [Analytics]` (`:202-220`), `notifications → [Notifications/Inbox]` (`:221-234`). The
  rail renders `INTELLIGENCE` (group heading) directly above an `Intelligence` row — pure vertical
  waste (a full text row + `gap-3` group spacing per group).
- **G3/duplication — the shared-id host+child anti-pattern.** Hosts list *themselves* as their own
  child (overview→overview, chat→chat, metrics→metrics, inbox→inbox), forcing an `idIsAlsoChild`
  special-case in **four** places (`:286, :325, :396, :403`) to preserve the "exactly one
  aria-current" invariant. This encodes a `nav.ts` data convention into the render logic.
- **G3/deep nesting — the Settings disclosure children route to STANDALONE pages, not into
  Settings.** `users/security/roles/sessions` (`nav.ts:266-271`) route to bare pages
  (`App.tsx:162/164/111/156`) that *also* exist as sections inside `Settings.tsx`
  (`SECTION_GROUPS`, `Settings.tsx:172-373`). Two competing homes for the same destinations. Also
  `roles` is advertised as a Settings child but has **no** matching Settings section (it's folded
  into `admin_users`), breaking the "Settings child == Settings section" mental model.
- **Doc drift:** JSDoc (`:6`) and the prop doc (`:500`) claim `~248px`, but the class is `w-60`
  = **240px** (`:556`, verified). Any layout math keyed to 248 is 8px wrong.
- **Four+ inconsistent active-state treatments** (G1/G2): expanded leaf `bg-primary
  text-primary-foreground shadow-glow` (`:301`); expanded parent `font-medium text-foreground` +
  faint `bg-primary/[0.06]` (`:317,:330`); collapsed active `bg-primary … shadow-glow` OR
  `bg-primary/10` + left bar (`:407-421`); child `bg-primary/10 text-primary` (`:253,:475`). No
  single "you are here" style.
- **Magic sizing scattered** (~8 literals in one file): leaf `min-h-8`/`pl-9`, parent `px-2.5 py-2`,
  chevron `h-7 w-7`, rail button `h-10 w-10`, fly-out `w-52`, brand `h-9 w-9`, header `h-14`. None
  reference shared spacing tokens.
- **Collapsed fly-out always in DOM/tab order:** rail children are kept mounted with `opacity-0
  pointer-events-none` revealed on hover/focus-within (`:446-457`). Deliberate a11y choice
  (documented `:435-441`, tested) but every collapsed child is a focusable, SR-audible, visually
  hidden target at all times — re-evaluate `hidden`/`inert` in the overhaul.

**Coupling:** tightly bound to `nav.ts` (types + `navParentOf` + the shared-id convention) and to
the shell (all state via `useNavPrefs`). `useNavPrefs` mixes persistence (usePrefs context,
`api.prefs.putUser`, localStorage) into a presentational file — it arguably belongs in `soc/prefs`
or a `nav-state` module (G8). Rendering the sidebar in isolation needs **3 mocks** (auth, prefs,
api) per its test.

**Load-bearing:** the WAI-ARIA disclosure contract + the exactly-one-aria-current invariant
(8 tests, `NavSidebar.test.tsx:81-163`); the inline (non-portal) fly-out keyboard reachability
(tested `:180-193`); `useNavPrefs` synchronous hydration + reconcile-don't-clobber logic (7 tests,
`:211-289`); stable localStorage keys; the parent-label-navigates-AND-opens contract (`:543-550`).

---

### 1.3 nav.ts — the IA source of truth (`webui/src/soc/nav.ts`)

6 top-level `NavGroup`s (overview/triage/intelligence/analytics/notifications/platform), a flat
`NavItem[]` with optional `NavChild[]`, RBAC `perm` gates, and the routable-`PageId` set.

| Structure | Location |
|---|---|
| `type PageId` union (31 ids) | `nav.ts:53-84` |
| `type NavGroupId` (6 groups) | `:86-92` |
| `NavPerm` / `NavItem` / `NavChild` / `NavGroup` interfaces | `:99-102 / :104-120 / :127-133 / :135-139` |
| `NAV_GROUPS` (the IA data to reshape for G3) | `:141-289` |
| `NAV_ITEMS` / `NAV_CHILDREN` | `:292 / :295` |
| `HIDDEN_ROUTE_IDS` (routable-but-not-a-rail-item) | `:309-325` |
| `PAGE_IDS` (router truth set) | `:332-338` |
| helpers `navItem` / `navParentOf` / `navLabel` / `isPageId` | `:345 / :354 / :362 / :372` |

**Issues (G3 root cause quantified):**

- **Two parallel navigation systems.** `nav.ts` ≈ 6 groups / ~10 rail items / ~12 children.
  `Settings.tsx` re-implements its OWN IA: 6 `SECTION_GROUPS` × ~20 `SectionMeta` sections, each
  with a scroll-spy sub-TOC of anchors (`Settings.tsx:172-373`; `sectionFromHash` uses a separate
  `#/settings?s=<id>` router at `:2188`). **Net nesting to reach a control is up to 4 deep:** Rail
  group → Settings item → Settings section-group → section → anchored card.
- **Double-home for every admin surface** (Users/Security/Sessions/Account/AdminSessions exist both
  as standalone pages AND as `*Inner` Settings sections) — different chrome per entry path,
  maintenance hazard.
- **`admin_sessions` is orphaned from the rail** (routable + a Settings section, but in no
  `NavItem`/`NavChild`) while its sibling personal `sessions` IS a rail child — inconsistent.
- **`catalog` vs `playbooks` are two PageIds for one destination** (`playbooks` → `<Intelligence
  tab="catalog">`, `catalog` → standalone `<Catalog>`) — needless duplication in the union +
  render switch.
- **Semantic mis-grouping:** `baseline`/`batchjobs` (operational) sit under Analytics with perms
  that disagree with siblings; `Platform` is a catch-all (Sources + Audit + Auto-tuning + Settings)
  and Auto-tuning (a triage-logic concept) is split from Automation which lives inside
  Settings›Triage logic.
- **Comment/code drift** makes the file untrustworthy as SoT: header + Round-2 block say
  Intelligence hosts "Playbooks & Agents"/"Catalog" but the child is labelled just "Playbooks";
  the `HIDDEN_ROUTE_IDS` "hidden" framing is stale (some listed ids are also nav children).

**Load-bearing:** the two-file routing contract (`PageId` union ↔ `renderPage` switch, no
compile-time link); deep-link back-compat (`HIDDEN_ROUTE_IDS` keeps `#/cost`, `#/investigate`,
`#/standup`, `#/catalog`, `#/dashboard`, `#/admin_sessions`, … resolving — prefer *redirect* over
delete); RBAC perms duplicated in **three** places (nav.ts, Settings SectionMeta, in-page
`<Can>`/`<ProtectedRoute>`).

---

### 1.4 Router + App root (`router.tsx` + `App.tsx`)

`router.tsx` (~90 lines) is a hash router: `#/pageid` → validated `PageId`, plus an *out-of-URL*
`NavOpts` (caseId/status/window/tab) held in React state. `App.tsx` is the root: provider stack
(Theme > Tooltip > Auth > Prefs > Demo > Router), boot gate (auth → setup/wizard → AppShell), ~30
lazy pages, and `renderPage()` — a 31-arm switch turning `PageId+opts` into a page element.

| Structure | Location |
|---|---|
| `Navigate` type = `(page: PageId, opts?: NavOpts) => void` | `router.tsx:23` |
| `RouterProvider` (page + opts as TWO `useState`) | `router.tsx:43` |
| `pageFromHash()` (validates via `isPageId`, else `overview`) | `router.tsx:34` |
| hashchange effect **RESETS opts to undefined** | `router.tsx:54-60` |
| `useRoute()` / `useNavigate()` | `router.tsx:81 / :90` |
| ~30 `React.lazy()` imports | `App.tsx:35-66` |
| `renderPage(page, opts, navigate, onRerunWizard)` — 31-arm switch | `App.tsx:75-171` |
| host remaps (`dashboard`→Home tab, `playbooks`→Intelligence tab=catalog) | `App.tsx:99-104` |
| settings arm passes `onNavigate` + `onRerunWizard` (only bespoke callback) | `App.tsx:161` |
| default → `<Home>` (unknown ids) | `App.tsx:168-170` |
| Suspense `key={page}` + ErrorBoundary `resetKey={page}` | `App.tsx:246-252` |
| provider stack (5 nested) | `App.tsx:262-275` |
| `NavOpts = { caseId?, status?, window?, tab? }` | `types.ts:1530` |

**Issues:**

- **Three-way page-inventory duplication kept in sync by hand:** `PageId` union (`nav.ts:53-84`, 31
  ids) + `renderPage` switch (`App.tsx:81-170`, 31 arms) + `PAGE_IDS`/`HIDDEN_ROUTE_IDS`
  (`nav.ts:309-338`). Adding a page edits 3+ files; drift is silent (a `PageId` in `PAGE_IDS`
  without a switch arm silently renders `<Home>`). **This is the core G8 blocker and directly
  blocks G7** — a new page id cannot be registered from data.
- **Inconsistent leaf→host resolution:** sibling children of the same parent resolve to *different*
  shells. `dashboard` → `<Home tab=dashboard>` (host) but `standup` → standalone `<Standup>` (no
  tab bar), though both are Overview children. Same split for `cost` (standalone) vs the Analytics
  `metrics` host tab. A real UX bug.
- **NavOpts are lost on back/forward + deep-link:** `status/tab/caseId/window` live in React state,
  **not the URL** (`router.tsx:6-8, 59-60`). So `#/cases` cannot carry a status filter, `#/overview`
  cannot carry `tab=standup`, and back/forward wipes opts. This **defeats shareable/bookmarkable
  views** — a baseline prerequisite for G7 custom dashboards. (Note: Home.tsx/Intelligence.tsx
  docstrings *claim* deep-link tab support that does not actually work.)
- **`onNavigate` prop type is inconsistent:** 29 pages type it as `Navigate`; 7 type it loosely as
  `(page: any, opts?: any) => void` (`Account.tsx:56`, `AdminSessions.tsx:44`, `Catalog.tsx:547`,
  `Memory.tsx:499`, `Sessions.tsx:283`) or `unknown` (`Security.tsx:526`) — mistyped page ids
  compile clean.
- **`renderPage` is a hand-written prop-threading switch, not table-driven.** Each arm passes a
  bespoke prop subset; no uniform page-props contract → a page cannot be registered/rendered
  generically (blocks a plugin/registry model for G7/G8; the switch grows linearly forever).
- **Mixed RBAC:** some pages self-gate (`<ProtectedRoute>` inside models/roles); nav items carry
  `perm`; `renderPage` does **zero** permission checks — a hand-typed `#/roles` relies on the page's
  own guard.
- **Boot double-spinner:** `authLoading` spinner then a second identical "Starting console…" while
  `setupChecked` is false (`App.tsx:220-222`).

**Load-bearing:** deep-link contract for all 31 ids; default fallback to `overview` (do not 404);
auth/setup boot ordering (`App.tsx:196-235`); `onRerunWizard` wiring (only path to re-open the
wizard from Settings, `App.tsx:161 → :251`); provider nesting order; single Suspense/ErrorBoundary
keyed by page (white-screen recovery on chunk-load failure); AppShell breadcrumb + active-rail
highlight depend on `navItem`/`navParentOf`/`navLabel` resolving every routable id.

---

## 2. Component inventory (reuse + consistency)

### 2.1 Page scaffolding — the top-band layer (`PageHeader`, `HeroPanel`, `layouts.tsx`, `TabbedPage`)

| Structure | Location |
|---|---|
| `PageHeader({eyebrow,title,description,icon,actions,className})` | `PageHeader.tsx:23` (27 consumers) |
| `HeroPanel({…,meta,children})` (+ decorative `bg-hero-glow`) | `HeroPanel.tsx:27` (3 consumers) |
| `CommandCenterLayout` (Overview only) | `layouts.tsx:41` |
| `WorklistLayout` / `InvestigationLayout` (**zero consumers**) | `layouts.tsx:73 / :118` |
| `TabbedPage({header,tabs,value,onValueChange})` | `TabbedPage.tsx:46` (Home/Workspace/Intelligence) |
| `.hero-display h1` clamp typography | `theme.css:204-210` |

**Issues:**

- **G5 root cause — `HeroPanel` has no compact variant.** `p-6 sm:p-8` (32px), title `text-2xl
  sm:text-3xl`, further enlarged on Overview by `.hero-display h1` clamp up to 34px + eyebrow +
  2-line description → the Overview hero band is **~150–190px** of mostly-empty wash before any data.
- **Stacked spacing** (G4/G5): `CommandCenterLayout` is `flex flex-col gap-6` → 24px gap on top of
  the hero's 32px bottom padding, on top of AppShell `py-6` = **~80px vertical whitespace before hero
  content even starts** (`Overview.tsx:544`, `layouts.tsx:43`, `AppShell.tsx:601`).
- **Three header styles** (G2): `PageHeader` (`text-2xl`, icon `h-10 w-10`) vs `HeroPanel`
  (`text-2xl sm:text-3xl`, `p-8`, `meta`+`children`) vs `CaseDetail` hand-rolls its OWN header
  (`text-lg`, `px-6 py-4`, `CaseDetail.tsx:1278`). 18 of 45 pages don't use `PageHeader` at all.
- **Multiple `<h1>` per view:** `PageHeader` and `HeroPanel` both render `<h1>`; `TabbedPage`
  embeds a `PageHeader` (`TabbedPage.tsx:68`) whose sub-pages may also render `<h1>` — document-
  outline a11y defect.
- **`TabbedPage` unmounts inactive tabs** (Radix `forceMount` off, `:82-87`) → switching tabs
  RESETS sub-page state + forces data reload (loses scroll/filter/in-progress state). This pushed
  Standup/Overview to avoid it.
- **`layouts.tsx` is mostly dead API** (G8): `CommandCenterLayout` used once; `WorklistLayout` +
  `InvestigationLayout` have **zero consumers**.
- **Zero test coverage** for all four (G9).

**Recommendation:** **Merge `PageHeader` + `HeroPanel` into ONE `PageHeader` with a `variant`/`size`
prop (`compact` | `default` | `hero`)** — single highest-leverage G2+G5 move. Add a `compact`
variant (icon `h-8 w-8`, title `text-xl`, no description) for data-dense pages. Adopt it in
CaseDetail. Either adopt or delete the two unused layouts. Fix `TabbedPage` mount behavior. **Watch:
the Overview display type depends on the exact `.hero-display h1` descendant selector hitting
HeroPanel's internal `<h1>` — a merge must keep an `<h1>` reachable by that selector.**

---

### 2.2 Tables / lists (`DataTable`, `ColumnsMenu`, `SavedViewsBar`, `EmptyState`, `PageSkeleton`)

`DataTable<T>` is a clean generic grid (sort/pagination/selection/loading/empty/density + column
show/hide/reorder) used by **12 pages**, but its richest features are wired to **one**.

| Structure | Location |
|---|---|
| `DataTable<T>` + `DataTableProps`/`DataTableColumn`/`ColumnState`/`SortState` | `DataTable.tsx:185-517` (`:81 / :52 / :40 / :46`) |
| `resolveColumns()` (applies hidden+order, respects `lockVisible`) | `DataTable.tsx:162-183` |
| footer pager + `showPager` gate | `DataTable.tsx:431-514 / :264-265` |
| `ColumnsMenu` (controlled; up/down reorder) | `ColumnsMenu.tsx:61-163` |
| `SavedViewsBar` (depends on `usePrefs()`) | `SavedViewsBar.tsx:51-215 (:58)` |
| `EmptyState` (variant default/error, compact) | `EmptyState.tsx:26-83` (~30 consumers) |
| `PageSkeleton` (hardcoded 4 KPI tiles) | `PageSkeleton.tsx:16-44` |
| `PrefsContext.updateTableColumns` | `soc/prefs.tsx:210-226` |
| Sole full consumer | `Cases.tsx:904-917, 1101-1140` |

**Issues:**

- **Column customization, saved views, and pagination are single-page.** `ColumnsMenu` and
  `SavedViewsBar` are imported **only** by `Cases.tsx`; `page/total/onPageChange` used **only** in
  Cases. So Users/Roles/Audit/Cost/Tuning/Campaigns/BatchJobs/Sessions/Knowledge/Models get no
  column control, no saved views, and **render ALL rows unpaginated** — data-heavy ledgers/audit
  dump unbounded rows into the DOM (perf + G4/G6 gap).
- **Density inconsistent** (G2/G4): default `normal`; only 4 callers set `compact`; the other 8 get
  the roomier `px-4 py-3` silently.
- **Double-centering wastes vertical space** (G4/G5-adjacent): a full `<EmptyState>` passed into
  `empty=` renders inside DataTable's own centered `py-14` wrapper (`:363-370`) plus EmptyState's own
  `py-8` — two nested centering containers. Confirmed on 6 pages.
- **No sticky header / no max-height scroll** — headers scroll away on long unpaginated tables.
- **3 components bypass DataTable** with raw `<Table>` (RoleMatrixEditor, UnifiedLogsSheet,
  SourceLogsSheet) → styling drift.
- **`PageSkeleton` is one fixed shape** (header + 4 KPI tiles + 1 card) shown for every lazy page →
  visible layout pop, contradicting its own "no layout shift" docstring.
- Dead-but-declared: `ColumnState.widths` is applied but no UI sets widths.

**Coupling:** `DataTable` is exemplary — pure generic, no fetch/router/api imports (great G8).
`SavedViewsBar` is **tightly** coupled to `PrefsContext` + toast (not pure). `ColumnsMenu` is
loosely coupled (controlled). The customization data model spans three layers that must stay in
sync: `DataTable.ColumnState` ↔ `PrefsContext.tables` ↔ backend `UserPrefsStore`.

**Recommendation (directly serves G6/G7):** promote the Cases pattern into a `<ListToolbar>` =
SavedViewsBar + ColumnsMenu + density + search; make `columnState` opt-in-by-default via a `tableId`
that DataTable resolves from `PrefsContext` itself; add client pagination into DataTable; fix the
double-centering; parameterize `PageSkeleton`.

---

### 2.3 Dashboard tiles / gauges (`KpiTile`, `StatCard`, `RiskGauge`, `BaselineGauge*`, `BudgetCard`)

| Structure | Location |
|---|---|
| `KpiTile` (top accent chip, `delta`, `onClick`) | `KpiTile.tsx:56` (+ `KpiAccent`/`KpiDelta` `:5,:14`) |
| `StatCard` (left accent bar; no delta/onClick) | `StatCard.tsx:43` (`StatAccent` `:5`) |
| `RiskGauge` (SVG half-circle; `bandOf()` non-canonical) | `RiskGauge.tsx:59 (:19)` |
| Baseline widgets (Warmup/Sparkline/SignatureCard/StatsOverview) | `BaselineGauge.tsx:71/127/190/317` |
| `BudgetCard` (self-fetching config editor + burn-down) | `BudgetCard.tsx:120` |

**Issues:**

- **`KpiTile` and `StatCard` are ~90% the same card** (identical shell, identical 7-value accent
  union) — the only difference is accent placement (chip vs left bar) + KpiTile's delta/onClick.
  Two files, copy-pasted accent map. **Plus a THIRD hand-rolled clone** in `CaseTriageHeader`
  (`ChipShell` `:119`, `RiskCard` `:237`, its own `TONE_ACCENT` `:52`, top-bar accent). Three accent
  placements for one visual family (G2).
- **Magic `min-h-[7.5rem]`** repeated across 4+ files (Scans.tsx:420, CaseTriageHeader.tsx:119/237)
  instead of owned by the component.
- **No widget grid / no widget registry** (G7 blocker): every page hand-writes the same responsive
  grid; grep for `WidgetGrid|DashboardGrid|widget registry` = nothing. Tiles are directly-imported
  JSX, not data-addressable widgets — a custom-dashboard builder cannot enumerate or instantiate them.
- **`BudgetCard` is misclassified** as a shared component (G8): it is a stateful self-fetching
  FEATURE panel (calls `modelsApi.getBudget/putBudget/budgetStatus`, toast, Save, RBAC) living next
  to pure primitives; imported by one place (Models). Cannot be dropped on a dashboard read-only.
- **Inconsistent surface tokens**: BudgetCard `bg-surface`, BaselineGauge `bg-surface/40`,
  KpiTile/StatCard `bg-card` — sibling widgets look subtly different (G1).
- **`RiskGauge.bandOf()` is non-canonical** (collapses `info` into low, `medium>=35`) — disagrees
  with `RiskBadge`/palette for the same score (G1 cross-component inconsistency).

**Recommendation:** merge `KpiTile`+`StatCard` into one `StatTile` with `accentStyle: 'chip' |
'bar-left' | 'bar-top'` (keep thin named re-exports for the ~10 consumers); fold CaseTriageHeader's
clones onto it; add a `<KpiGrid>`/`<WidgetGrid>` container owning the responsive breakpoints (the
seam for G7); split `BudgetCard` into a pure `<BudgetGauge>` + a `<BudgetEditor>`; establish a
`{kind,title,defaultProps,component}` **widget descriptor + registry** (RiskGauge/BaselineWarmupGauge/
StatTile/BudgetGauge/Sparkline as the initial catalog).

**Load-bearing:** `RiskGauge` SVG structure is pinned by `RiskGauge.test.tsx` (single track + single
progress path, dashOffset math, TEXT_CLASS literal classes last in `cn`); `BaselineGauge` `#9`
tests (signature rendered as plain mono text — never `dangerouslySetInnerHTML`); `BudgetCard` `#3`
copy ("never changes a case decision").

---

### 2.4 Charts (`charts.tsx`, `charts-soc.tsx`, `BarList.tsx`, `palette.ts`)

The app's *complete* charting toolkit: 5 generic recharts wrappers + 4 SOC-shaped views + a
CSS-only ranked bar list. All colors resolve through `palette.ts` → `hsl(var(--token))` so SVG
tracks the live theme. recharts is isolated into its own lazy vite chunk.

| Structure | Location |
|---|---|
| Donut/HBar/TrendArea/MiniBars/Sparkline | `charts.tsx:106/196/277/377/419` |
| MitreHeatmap/BurnDown/AreaSpark/MultiSeriesTrend | `charts-soc.tsx:111/261/349/426` |
| `BarList` (dep-free, 6 consumers) | `BarList.tsx:47` |
| `token`/`categorical`/`semanticColor` | `palette.ts:17/59/103` |
| recharts manualChunk isolation | `vite.config.ts:54` |

**Issues:**

- **G7 blocker — no dashboard/widget-builder layer.** Charts are hand-placed statically in pages.
  No chart-type registry, no serializable chart-spec, no data-binding indirection. Each primitive
  takes a **different** data shape (Donut `segments[]`, TrendArea `{x,y}[]`, MultiSeriesTrend
  rows+series[], BarList `items[]`) with no unifying adapter — a builder would re-implement all the
  page-local data-shaping (`Metrics.tsx:126/1180/1188`).
- **Duplicated `ChartTooltip`/`SocTooltip` + `AXIS_TICK`** across the two files (`charts.tsx:46,:76`
  vs `charts-soc.tsx:44,:31`) — divergence risk.
- **Near-duplicate spark primitives** (Sparkline/MiniBars/AreaSpark) with slightly different magic
  numbers.
- **Inconsistent semantic coloring:** `MultiSeriesTrend` uses `semanticColor(label)` but `DonutChart`
  uses only `categorical(i)` — a `critical` donut segment gets an arbitrary color.
- **`BurnDownChart` hardcodes `info`/`success`** with no `colorToken` override (unlike every sibling).
- **`isAnimationActive={false}` baked into every chart** as a product decision, not a token/pref.
- **Thin tests** (only MitreHeatmap sr-only table) — 9 chart exports untested (G9; recharts renders
  nothing measurable under jsdom without a sized container).
- **Two color-passing conventions:** recharts charts take `hsl` strings via palette; `BarList` takes
  raw tailwind classes (`bg-critical`).

**Recommendation:** consolidate the two chart files (one `ChartTooltip` + one axis style); collapse
the three sparks into `<InlineChart variant>`; use `seriesColor()` everywhere; add a thin
`chart-spec → component` registry + per-type data adapters (the minimum G7 seam); unify BarList's
color contract. **Do NOT** make any chart reachable from an eager import path — `vite.config.ts:44-55`
documents that this drags ~422KB recharts onto first paint (G8 landmine); keep colors as
`hsl(var(--token))` (live theme).

---

### 2.5 Settings section components (`SettingsGrid` primitives + 4 sections)

`SettingsGrid.tsx` is the **intended** shared layout system (`SettingsGrid` + `SettingsCard` +
`StickySaveBar` + `SettingsTOC`) used by 4 grid sections + Tuning.tsx. The other four section files
render inside the OLD single-card chrome — **two parallel section-layout conventions side by side,
the core of the G3 clutter.**

| Structure | Location |
|---|---|
| `SettingsGrid` / `SettingsCard` / `StickySaveBar` / `SettingsTOC` | `SettingsGrid.tsx:35/74/137/203` |
| `GRID_SECTIONS` set (which sections opt out of the outer Card) | `Settings.tsx:382` |
| `SectionTitle`/`SubHeader` (**private, not exported**) | `Settings.tsx:411/421` |
| outer `<Card><CardContent p-6>` wrap | `Settings.tsx:2644` |
| page-level `StickySaveBar` | `Settings.tsx:2651` |
| CustomizationSection / DemoModeSection / DangerZone / SessionPolicyEditor | respective files |

**Issues:**

- **Double/triple-card nesting:** `demo` and `customization` aren't in `GRID_SECTIONS`, so
  `renderSection()` wraps them in the outer `<Card p-6>`, then `DangerZone` renders THREE more
  `<Card>`s inside — card-in-card-in-card (`DangerZone.tsx:385`).
- **Four different heading treatments** for one role: grid `SectionTitle` (h2 `text-lg`),
  DemoModeSection hand-rolls its own identical h2 (`:162`), CustomizationSection bare h3 `text-sm`
  with no top title, DangerZone h3 `text-sm`, SessionPolicy h2 `text-sm`. `SectionTitle`/`SubHeader`
  are private to Settings.tsx so sections can't import them — a reuse barrier.
- **`SettingsCard` primitive unused** by these 4 sections (they re-implement its titled-card shape).
- **Two save mental-models:** the global `StickySaveBar` covers the grid sections; Customization/
  Demo/DangerZone/SessionPolicy save INLINE with their own buttons/toast → confusing (G2/G3).
- **Inconsistent spacing scales** across siblings (`space-y-8`/`-6`/`-4`/`-5`).
- **`GRID_SECTIONS` is a brittle opt-out list** — a new section not added silently gets double-carded
  (the exact trap DangerZone falls into).

**Coupling:** `DangerZone` cleanly splits UI from `DangerZone.api` (ResetScope/RESET_CONFIRM_PHRASE/
adminReset) — **the cleanest separation in the slice, the G8 template.** `SessionPolicyEditor` has a
dual controlled/uncontrolled mode purely because it's mounted in BOTH Settings and the standalone
Security page — consolidating IA would collapse it to one mode.

**Recommendation:** refactor the four sections onto `SettingsCard`/`SettingsGrid` + add their ids to
`GRID_SECTIONS`; promote `SectionTitle`/`SubHeader` to exported shared components; unify on ONE save
model (all controlled via parent `update()` + shared StickySaveBar, OR all self-contained). Terminology
editor is a hardcoded 7-key list (`CustomizationSection.tsx:43`) — not schema-driven (G6-adjacent).

---

### 2.6 Source-config + log-browse (`SourceEditor`, `ConnectorPicker`, `SourceLogsSheet`, `UnifiedLogsSheet`, `EnrichmentProvidersEditor`)

- **`SourceEditor.tsx` is 1819 lines** (verified) — the biggest config file after Settings.tsx.
  Bundles the picker step, dynamic field renderer, the entire ~500-line feeds sub-editor, cert
  picker, test callout, field-mapping defs, and a 530-line container with ~20 `useState`. Should
  split into `feeds/`, `fields/`, container (G8).
- **Massive duplication between `SourceLogsSheet` and `UnifiedLogsSheet`:** controls row, the
  live-tail `useEffect` (byte-identical `SourceLogsSheet.tsx:158-173` vs
  `UnifiedLogsSheet.tsx:192-207`), toggleExpand, error/loading/skeleton/empty states, and the entire
  rows table are copy-pasted. `LIVE_TAIL_INTERVAL_MS` / `TIME_RANGES` duplicated verbatim;
  `errorMessage()` triplicated (also in SourceEditor). **Extract `<LogBrowser>` + `useLiveTail`.**
- **Misleading module identity:** `App.tsx:62` lazy-imports the standalone **Logs page** as
  `UnifiedLogs` from a file named `UnifiedLogsSheet.tsx` whose default export is `UnifiedLogsView`
  (a full page, not a sheet). Hurts discoverability (G8).
- **Three backend-access conventions** in one slice: `EnrichmentProviders.api.ts` (in
  `soc/components/`), `UnifiedLogs.api.ts` (in `soc/`), and SourceEditor via `lib/api.ts` +
  `lib/connectors.ts`. `EnrichmentProvidersEditor` is the **well-decoupled model** (self-fetching,
  co-located api, RBAC, works embedded+standalone) the others should follow.
- **Hand-rolled `RoleSegmented`** (`SourceEditor.tsx:635-666`) builds a radiogroup from raw
  `<button>`s with hardcoded active colors instead of the shared Tabs/ToggleGroup (G2).
- **Redundant correlation controls** (G6): a per-SOURCE Auto-Correlate switch AND a per-FEED
  Correlate + Auto-investigate pair, plus legacy `auto_correlate` — three overlapping toggles for
  one concept, explained only in tooltip prose.
- **Customization gaps (G6):** enrichment fusion is a single global boolean (no per-provider weight/
  priority/order despite backend weighted-fusion support); correlation is a single 5-option strategy
  Select (no window/min-cluster/cross-source config); **no detection-rule / risk / auto-close /
  tuning customization reachable from the source surface at all.**

**Load-bearing (non-negotiables):** `feedToWire`/`buildConfig` must produce **byte-identical** legacy
wire config (#4 cursors, severity-floor "never dropped" semantics, IGNORE precedence); secrets are
strictly write-only (#10); all log rows + `_raw` + provider results are UNTRUSTED plain-text/CodeBlock
(#9); demo guard on Test buttons; enrichment is advisory, never feeds `decide()` (#3).

---

### 2.7 Case-detail components (`CaseThread`, `CaseTasks`, `CaseActivityFeed`, `CaseTriageHeader`, `TraceTimeline`, `CaseHoverCard`)

- **Duplicated tone→color maps across three files** instead of a shared helper: `TONE_RING`
  (`CaseActivityFeed.tsx:48`), `TONE_TEXT`/`TONE_ACCENT`/`TONE_BAR` (`CaseTriageHeader.tsx:45-65` —
  `TONE_ACCENT` and `TONE_BAR` are byte-identical, pure duplication), `TONE_TEXT`+`TONE_RING`
  (`TraceTimeline.tsx:47-58`). None use `palette.semanticColor`. Band coverage even diverges
  (`SpanTone` omits `critical`).
- **Hardcoded score→band cutoffs (80/60/35/15) copy-pasted**, not imported: `CaseTriageHeader.toneForScore`
  (`:84-90`) duplicates `badges.tsx riskVariant` (`:276-282`) + `severityBandFromNumber` (`:22-30`)
  — silent drift risk (G1).
- **Inconsistent section-header ownership:** `CaseTasks` renders its own internal header; CaseThread/
  CaseActivityFeed rely on an external `SectionHeading` — which is defined **privately inside the
  4210-line `CaseDetail.tsx:578`**, a reusable primitive trapped in a page.
- **`CaseHoverCard` is stylistically inconsistent** (no `#9` JSDoc banner, `export function` vs
  `React.FC`, imports `Case` from `@/lib/types` while siblings import from `CaseDetail.api` — a split
  type source).
- **Duplicated live-SSE wiring** (byte-identical `useEventStream`+`onEvent('case.activity')`) in
  CaseThread (`:617-628`) and CaseActivityFeed (`:111-122`).
- **Wasted vertical space** in the triage header (`min-h-[7.5rem]` on 4-across grid + fixed
  RiskGauge `size=108`) — relevant to G5.
- **Risk-factor weight COPY hardcoded** as string literals the comment says must be "kept in sync
  with `engine/priority.py`" — a manual cross-repo sync burden in a UI component.

**Coupling debt is entirely in shared TYPES living under `pages/CaseDetail.api`** (components depend
on a page-scoped types module) and in duplicated tone/threshold/contract-string constants. The
components themselves are correctly pure/presentational (mutations via caller handlers) — good G8.

**Load-bearing (#3/#9):** `renderBody` plain-text-only rendering (`CaseThread.test.tsx` asserts XSS
neutralization); TraceTimeline trusted/untrusted split (untrusted → fenced CodeBlock); the
`DecisionStep` must stay **visually distinct** and surface the exact `(verdict,confidence,risk_score,
policy clause)` — it is the UI manifestation of #3. The four triage chips are "honestly distinct"
(risk/severity/impact/priority answer different questions) — a G5 compaction must not collapse them
into four look-alikes.

---

### 2.8 Editor components (`BrandingEditor`, `RoleMatrixEditor`, `NotificationsEditor`, `NotificationPrefs`, `ModelsCatalog`) — the G6 precedent

These are the console's whole form-UX vocabulary and the closest precedent for a future rules editor.

**The single largest cohesion debt: THREE parallel form-primitive vocabularies, none shared.**
- `NotificationsEditor` defines local `FieldRow`/`SwitchRow` (`:205,:227`);
- `SourceEditor.tsx` defines its OWN `FieldRow`/`SwitchRow`;
- `Settings.tsx` defines a THIRD set `TextPref`/`NumPref`/`SwitchPref` (`:501/:529/:567`);
- `BrandingEditor` defines its own `Heading`/`ColorField`/`ImageUpload` (`:291/:302/:354`).

A future G6 rules editor would spawn a **fourth** set. There is no shared `<Field>` / `<SwitchRow>` /
`<ChipInput>`.

Other issues:
- **Dirty-tracking copy-pasted and fragile:** `JSON.stringify(a) !== JSON.stringify(b)` in try/catch
  appears in BrandingEditor (`:626`), NotificationPrefs (`:62-127`), Tuning (`:135`), Account
  (`:223`) — key-order sensitive, silently returns dirty on throw. **Extract `useDirtyDraft`.**
- **Nested save-bar conflict:** `BrandingEditor` self-saves (its own Save/Discard) while embedded in
  Settings which renders its OWN `StickySaveBar`; `NotificationsEditor` by contrast is a pure
  controlled lens deferring to the parent. Inconsistent within the SAME page.
- **Two matrix editors, two table impls:** `RoleMatrixEditor` uses the shared shadcn `<Table>`;
  `NotificationPrefs` uses a **raw `<table>`** (`:242-316`). RoleMatrix columns are mislabeled
  "Action 1..N" with no sticky first column (Resource name scrolls away) — the exact trap a G6 rules
  matrix must avoid.
- **`BrandingEditor` mutates `document.documentElement` globally** for live preview (`:191-264`),
  cleanup only on unmount — strong DOM coupling, hard to test/reuse (G8/G9).

**Reusable G6 blocks that already exist but are trapped in bigger files:** `RoleMatrixEditor`'s
tri-state cell + `cellState`/`cycleCell` (`:69-133`, exported pure fns, deny-wins precedence) →
per-rule action grid; `NotificationsEditor`'s `TemplateEditor` (`:743-993`, server-rendered
sandboxed-iframe preview + variable chips) → rule "test against sample event"; the `min_risk` Slider
+ trigger switches → a rule threshold/condition surface. **All need extraction first.**

**Recurring G8 smell:** "shared component + page-owned `.api` constants" — RoleMatrix imports from
`Roles.api`, NotificationPrefs from `Inbox.api`, ModelsCatalog from `Models.api`. `ModelsCatalog` is
otherwise the cleanest (presentational, callbacks-only, reuses `DataTable`).

---

### 2.9 Nav/notify/auth chrome (`CommandPalette`, `NotificationBell`, `MfaSetupCard`, `QRCode`, `ReauthDialog`)

- **`CommandPalette` is a 358-line monolith** mixing localStorage recents, debounced remote search,
  RBAC nav filtering, and a **side-effecting `api.demo.enable()` embedded in a render-time
  CommandItem** (`:309-314`). Quick-actions should be a declarative, injectable, RBAC-filterable
  registry (G8). It hard-depends on **four** context providers + NAV_GROUPS (the test needs 5 provider
  wrappers).
- **`CopyButton` (private in `MfaSetupCard.tsx:48`) and an `<OtpInput>` are missing shared
  primitives** — copy-with-feedback is reimplemented 4× (CodeBlock, ChatPanel, Standup, MfaSetupCard);
  three near-identical one-time-code inputs exist across ReauthDialog + MfaSetupCard.
- **Hardcoded colors bypass tokens** (G1): `QRCode` `fill="#000000"/"#ffffff"` (defensible for scan
  contrast but the `bg-white` wrapper is unexplained + jarring in dark mode); `NotificationBell`
  unread badge `text-white` over `bg-critical` (raw color, not a `--critical-foreground` token);
  `severityDot` maps `medium → bg-primary` (brand color as severity — semantically wrong, hand-rolled
  instead of `palette.ts`).
- **Dead class:** `MfaSetupCard.tsx:159` uses `h-4.5 w-4.5` (not in the Tailwind scale, not in
  config) — icons fall back to intrinsic size.
- **`NotificationBell` forces `enabled:true`** into `useEventStream` (`:89`) — realtime is not
  injectable/observable; every session fires an EventSource probe regardless of prefs.

**Load-bearing:** `QRCode` encoder is spec-critical (documented past inverted-format-info bug; tests
pin size/determinism) — do not touch GF/RS/mask math casually; `ReauthDialog`'s `setReauthHandler`
singleton + waiters queue is the whole app's step-up-auth retry mechanism; MFA secret/recovery codes
shown once, in state only; CommandPalette `shouldFilter={false}` (`:200`) is load-bearing for #9
(server ranking authoritative).

---

### 2.10 Shared support (`ChatPanel`, `CodeBlock`, `GlassSurface`, `LoadingBar`, `Stagger`, `Can`, `HelpTip`, `badges`, `DemoBadge`, `DemoBanner`)

- **CLIPBOARD BUG (real, default-deploy).** `lib/clipboard.ts` `copyText()` was written to fix
  copy-over-plain-HTTP (nginx serves `http://host:8080`, where `navigator.clipboard` is undefined),
  but the two heaviest copy surfaces don't use it: `CodeBlock.tsx:99-111` and `ChatPanel` CopyButton
  (`:338-347`) both do `navigator.clipboard?.writeText(...)` then optimistically `setCopied(true)` —
  over plain HTTP the write no-ops but the UI shows "Copied". **Route both through `copyText`.**
- **`ChatPanel.tsx` is ~1154 lines** (verified) and re-implements primitives that already exist:
  a file-local `CopyButton` (`:333`), a file-local `ResultTable` (`:264`) instead of `DataTable`, and
  a file-local inline-markdown renderer `renderInline`/`Markdown` (`:139-211`).
- **Inline-markdown inconsistency** (G2): ChatPanel formats `**bold**`/`` `code` ``/bullets, but
  `CaseThread.tsx:395`, `Inbox.tsx:173`, `Standup.tsx:392` render bodies as flat `whitespace-pre-wrap`
  plain text. **Extract a shared `<Markdown>` (UNTRUSTED-safe) next to CodeBlock** and reuse.
- **Inline `<style>` keyframes in a component** (`ChatPanel.tsx:972-986` `@keyframes socTypingPulse`)
  — the only embedded `<style>` in the slice; belongs in `theme.css`.
- **Hardcoded demo-warning class string** `'border-warning/50 bg-warning/10 text-warning'` copy-pasted
  in `DemoBadge.tsx:41`, `DemoModeSection.tsx:163`, and hand-rolled in `DemoBanner.tsx:86-98` — three
  amber treatments (G1/G2).
- **`badges.tsx` defines FOUR overlapping numeric→band→variant ladders** (`severityBandFromNumber`
  `:22`, `riskVariant` `:276`, `postureFromScore` `:313`, `computeUrgency` `:429`) all hardcoding the
  same cut points — **one shared `band(score, thresholds)` helper (in `palette.ts`)** would remove the
  drift (G1). `UrgencyPill` (`:408-442`) embeds triage-prioritization logic (risk+age+escalation with
  hardcoded weights) in a badge, duplicating `engine/priority.py` client-side — non-configurable (G6).
- **`GlassSurface` has a single consumer** (AppShell top bar) — the "command-center material" system
  is effectively one bar; either wire it into other overlays (G1) or acknowledge it's near-dead.

**Good G8 baseline:** LoadingBar, Stagger, GlassSurface, CodeBlock/InlineCode, badges, HelpTip,
DemoBadge are pure/props-driven, trivially movable. **Load-bearing #9:** `CodeBlock.toText` +
ChatPanel's markdown render model/log text as React text nodes only (never `dangerouslySetInnerHTML`);
`discoverHref` rejects `javascript:`/`data:` URLs; `Can`/`ProtectedRoute` default-allow when auth
disabled.

---

## 3. Lib layer — api / types / prefs / util / auth

### 3.1 `lib/api.ts` — the (partial) contract surface

Central typed fetch client: one `request<T>()` core (cookie `credentials:'include'`, 401→login
bounce, reauth-required retry-once gate, `ApiError`, querystring builder) exposed as generic verbs +
~120 hand-typed methods.

| Structure | Location |
|---|---|
| `request<T>()` core (401/reauth handling) | `api.ts:242-293` |
| `api.get/post/put/del` | `:296-301` |
| `ApiError` | `:151-161` |
| `setUnauthorizedHandler` / `setReauthHandler` | `:171-188` |
| `buildQuery` (drops undefined/null/empty) | `:206-214` |
| `putSettings` (opaque `Partial<Preferences>`) | `:555` |
| `export type Api = typeof api` | `:797` |
| SSE client (separate) | `useEventStream.ts:96` |

**Issues (the file is 797 lines, verified):**

- **TWO parallel API layers.** `api.ts` wraps Round-1/2; **all 12+ Round-3/4 routers** are consumed
  via **16 co-located `*.api.ts`** files that call raw string paths through the generic verbs and
  re-declare their OWN local types (**111 raw `api.get/post/...` call sites outside `api.ts`**). The
  true contract is split across 17 files, no single source of truth. Intent stated verbatim at
  `Tuning.api.ts:18-19` ("stays parallel-safe"). **A third path** is SSE (`useEventStream.ts`).
- **Dead endpoint:** `api.setup.initAdmin` POSTs to removed `setup/init-admin` (`:425-428`); the live
  OOBE flow uses `setup/account` (`login.api.ts:87`). Never called in app code — a caller would 404.
- **Orphaned backend endpoints with NO client anywhere:** `cases/{id}/forwarding`, `sources/health`,
  **`sources/{id}/secrets`** (a real gap — no typed client to set per-source connector secrets),
  **`settings/schema`** (the schema that would drive a customizable rules form, G6 — never called),
  `runbooks`, `cases/{id}/trace`, `playbooks/reload`, `playbooks/selection/{id}`.
- **`request<T>()` returns `body as T` with NO runtime validation** (`:292`) — every response trusted
  blindly; a backend contract change surfaces as a render crash, not a caught error.
- **`api.ts` is a single 798-line flat object** across ~25 domains, organized by comment banner only
  — no module boundary, not tree-shakeable per feature (G8).

**Customization gaps:** G6 rules are only reachable through an incoherent surface (`putSettings`
opaque `Partial<Preferences>` + `Tuning.api.ts` + `Models.api.ts`) — no unified rules/customization
client, no typed method per rule block, `settings/schema` unwrapped. **G7 has no dashboard/widget
client at all** — closest is the per-user prefs cascade + saved views.

**Load-bearing:** the 401/reauth retry-once gate + login-bounce that excludes `auth/*` +
`credentials:'include'`; `buildQuery` drop-empty semantics (relied on app-wide); the additive-JSON
contract means new *fields* are safe but any path/param **rename** is breaking with no compile-time
guard for the 111 raw call sites (grep all `*.api.ts`, not just `api.ts`); `export type Api = typeof
api` is mirrored by test doubles.

---

### 3.2 `lib/types.ts` — the canonical TS mirror (2047 lines, verified)

Hand-maintained mirrors of backend Pydantic contracts, imported by **48 files** (highest fan-in).
Deliberately does NOT import from Python; relies on additive-JSON + index signatures.

**Drift that directly blocks G6:**
- **The REAL auto-close policy is absent.** `types.ts:889` mirrors only the DEPRECATED
  `fp_auto_close`. The current `Preferences.auto_close: AutoClosePolicy` (per-verdict-class
  `VerdictAutoClose`, `config.py:496-532/1801`) — the object `decide()` actually enforces — is
  **entirely unmirrored.** A rules-customization panel (G6) has no typed contract for the real policy.
- **`Preferences.correlation_rules: dict[str, CorrelationRule]`** (per-rule overrides) is unmirrored
  — `types.ts` only models the single global `default_correlation`.
- **Four Round-4 config blocks unmirrored:** `threshold_tuning`, `batch`, `baseline`, `campaign`
  (`config.py:1995-1998`), plus `CapsConfig.max_concurrent`. Pages carry local mirrors instead.
- **`Branding.login_*` white-label unmirrored** (no index signature) — worked around by
  `LoginBranding extends Branding` in `login.api.ts:34-45` (a documented deferral).

**Fragmentation + collisions (G8):** 15 sibling `*.api.ts` files hold dozens of backend-mirroring
types the canonical file never sees (whole collab/trace/triage-chip/posture/RBAC/models/standup/inbox
surfaces). **Duplicate type NAMES with different shapes:** `MitreTechnique` (types.ts:1989 vs
`Metrics.posture.api.ts:133`), `ActivityResponse` (types.ts:204 vs `CaseDetail.api.ts:292`),
`ModelRole`/`MODEL_ROLES` vs `MODEL_ROLE_SLOTS` — active import-the-wrong-one hazard.

**G7 blocking:** **no type for custom dashboards / widget layouts anywhere.** The only
dashboard-adjacent shapes are the fixed `Metrics` + `PostureResponse` (sibling file). G7 needs a
new `DashboardConfig`/`WidgetConfig`/layout contract authored from scratch.

**Load-bearing:** the `[key: string]: unknown` index signatures are **load-bearing for additive JSON
forwarding** — removing one turns silent-forward into a hard type error (but they also *mask* drift:
missing fields compile fine, fail at runtime; there is no sync test). Keep all changes ADDITIVE (48
importers). Write to `auto_close` (new), never `fp_auto_close` (a backend `before` validator migrates
it). **`SourceUpsert.config` is asymmetric** — reads get `Partial<SourceConfigExtras>` typing, writes
are bare `Record<string, unknown>`.

---

### 3.3 `soc/prefs.tsx` — PrefsContext (the G7 persistence infra)

**This is the most important lib finding for custom dashboards.** `PrefsContext` is the single
client-side owner of per-user customization: hydrates once from `GET /api/prefs/effective` (merged
ORG←USER cascade), exposes theme mode, saved views (personal + org-shared), terminology `t(key)`,
per-table column state, a free-form `misc` bag, and mutators that persist to the backend
`UserPrefsStore` — **a single JSON-in-KV doc, no new index/table/migration.**

| Structure | Location |
|---|---|
| `PrefsProvider` | `prefs.tsx:112-271` |
| `usePrefs()` / `useTerm()` | `:274-286` |
| `PrefsContextValue` interface (the full API) | `:63-108` |
| `DEFAULT_TERMS` + `EMPTY_EFFECTIVE` (pre-hydrate shape) | `:35-61` |
| `setThemeMode`/`saveView`/`cloneView`/`deleteView`/`updateTableColumns`/`t` | `:149-236` |
| Backend `UserPrefsStore` + `resolve_effective_prefs` | `stores/user_prefs.py:48-293` |
| `UserPrefs`/`SavedView`/`ColumnState` models (`misc`:653, `last_list_state`:651) | `models.py:601-654` |
| org bounds (terminology capped; **personal NOT capped**) | `config.py:590-638` |

**The G7 story:** custom dashboards can ride this cascade with **ZERO new store/index/migration** —
add a `dashboards` field to `UserPrefs` (+ `OrgCustomization` for org-shared) + `EffectivePrefs`, and
surface get/save/delete on `PrefsContextValue`, **mirroring `saved_views` exactly** (personal +
org-shared + clone + cascade merge). `SavedView` is the perfect `DashboardView` template;
`SavedViewsBar` is a ready-made switcher template.

**But there are blocking bugs/gaps:**
- **CORRECTNESS BUG — the `misc` bag is REPLACED, not deep-merged, on write.** `NavSidebar.persistMisc`
  sends `putUser({ misc: { [ONE_KEY]: v } })`; the backend `patch()` does `merged[key] = value` at
  the **top level** (`user_prefs.py:103-122`), so the whole `misc` object is overwritten.
  `test_user_prefs.py:323-325` codifies this (`got.misc == {'density':'compact'}` exactly). NavSidebar
  only survives because it never writes two keys in one call. **This would silently destroy any
  dashboard config stashed in `misc`.** Fix requires a server deep-merge OR a client `updateMisc(patch)`
  read-modify-write — and updating that test deliberately.
- **`last_list_state` is fully plumbed but UNWIRED** — no PrefsContext getter/setter, no consumer.
  The promised "reopen where you left off" is dead capability (wire it for free, no backend change).
- **No `dashboards`/`widgets`/`layout` schema** in prefs/types/models/routes — the single largest G7 gap.
- **Optimistic writes swallow all errors silently** (`.catch(() => {})`) with no context-level toast
  (G9) — a failed dashboard save looks like success until reload.
- **No size bounds on personal prefs** (`misc`/`saved_views`/`tables`) — the whole buckets dict is one
  KV doc; a large dashboard blob grows it unbounded (availability risk at scale).
- **Theme ownership is split** across `theme.tsx` (localStorage `soc.theme`, first paint) AND
  `prefs.tsx` (backend `theme_mode`, overrides on mount) — two sources of truth for one setting; org
  `default_theme` only applies via `resolveDark` for `system` (G1/G2 precedence risk).

**Load-bearing:** `patch()` top-level-replace is RELIED ON by single-key callers but WRONG for
multi-key objects — a shared landmine; fixing it breaks `test_user_prefs.py:323-325` (must update
deliberately). `EMPTY_EFFECTIVE` is the app-wide failure/pre-hydrate fallback — any new field (e.g.
`dashboards`) MUST be added here with a safe default. The no-auth `'default'` bucket must keep
working (customization is first-class even with auth OFF). #9: saved-view names, terminology labels,
filter values, and any future dashboard title/config are user-influenceable DATA — plain-text render,
never unfenced into a prompt.

---

### 3.4 `lib/util` + `soc/auth.tsx` + `useEventStream`

**Utilities** (framework-free plumbing):

| Structure | Location |
|---|---|
| `lib/format.ts` (humanizeAge/formatTimestamp/fmtMoney/fmtNumber/fmtTokens/fmtPercent/humanizeToken) | pure, no-throw; **44 importers** |
| `lib/cn.ts` `cn()` = `twMerge(clsx(...))` | **90 imports**, sole class merger |
| `lib/connectors.ts` (secret routing mirror) | thin service, tied to backend secrets contract |
| `lib/avatar.ts` / `lib/clipboard.ts` | narrow helpers |
| `soc/auth.tsx` `AuthProvider`/`refresh`/`hasPermission`/`useAuth` | `:54/:60/:114/:160`; 32 call sites |
| `lib/useEventStream.ts` `useEventStream(topics, opts): {live}` | `:96` (default-OFF SSE) |

**Issues:**
- **Three DIVERGENT duration formatters** produce different strings for the same input (G2):
  `posture.format.ts:25 humanizeMinutes` (`<1m` floor), `Metrics.tsx:105 humanizeMinutes` (no `<1m`
  branch), `Overview.tsx:104 fmtDuration` (1440-min/day path). Metrics.tsx even imports posture's AND
  defines its own. **None live in `lib/format.ts`.** Consolidate into ONE canonical `humanizeDuration`.
- **Near-duplicate percent logic:** `format.ts:104 fmtPercent` and `posture.format.ts:39 ratioPct`
  are byte-identical; Metrics imports both and uses them interchangeably; callers hand-divide by 100
  before `ratioPct` (the exact double-normalization `fmtPercent` was built to avoid).
- **`humanizeToken` ignores the terminology cascade** — a customer renaming `case`→`incident` gets
  the override only where a component calls prefs `t()`, while ~40 `humanizeToken(...)` call sites emit
  the raw enum. **Route all enum-label rendering through one terminology-aware helper** (the G6 seam).
- **`fmtMoney` hardcodes symbol + uses `toFixed` (no grouping)** — `$12345.67` with no thousands
  separators, inconsistent with `fmtNumber` (`toLocaleString`); no locale configurability.
- **`connectors.ts` hardcodes the backend secret-routing** (`KNOWN_SECRET_KEYS`/`CONFIG_TO_SECRET_KEY`)
  — a manual mirror with no sync test; new secret keys require hand edits (G6 source-wizard risk).
- **`useEventStream`'s `{ live }` polling-suppression signal is used by only 1 of 3 call sites** —
  CaseActivityFeed/CaseThread ignore it and keep full-cadence polling; only NotificationBell slows.
- **`auth.tsx` fail-open risks:** `hasPermission` short-circuits `role==='super_admin'` before the
  matrix (`:119`, magic role name coupling); `refresh` swallows all errors to null — a transient
  `/roles` 500 collapses `rbacEnabled→false` which **fails OPEN to allow-all** in the UI for that
  render (advisory gate, but flashes actions the user can't perform).

**Load-bearing:** `format.ts` (44 importers) + `cn.ts` (90 imports, twMerge-must-run-last) are stable
public APIs — consolidations must **preserve chosen output** and update the ~46 test files;
`auth.tsx` back-compat ladder (authEnabled false → allow; rbacEnabled false → allow; super_admin →
allow; else matrix) must be kept exactly; `useEventStream` default-OFF + 204-probe → keep-polling
fallback + `MAX_COLD_FAILURES` give-up + Last-Event-ID resume + hand `onEvent` verbatim (no rendering,
#9) is non-negotiable; `clipboard.ts` execCommand fallback is required for plain-HTTP deploys (do NOT
drop as "deprecated").

---

## 4. Cross-cutting synthesis by goal

**G1 (cohesive color).** Color decisions are scattered and hardcoded: 4 numeric→band ladders in
`badges.tsx`, 3 tone maps in case components, `RiskGauge.bandOf()` non-canonical vs badges, raw
`text-white`/`#000`/`bg-primary`-as-severity in chrome, mixed surface tokens (`bg-card` vs
`bg-surface/40`) across sibling widgets, 3 amber "demo" treatments, theme decided across 3 places
(theme.tsx + prefs.tsx + localStorage). **One `palette.ts`-owned `band(score, thresholds)` + a single
tone helper + consolidated theme ownership** is the through-line fix.

**G2 (one design standard).** Recurring "hand-rolled clone of a shared primitive": 3 header
components, 2 stat tiles (+ a 3rd clone), 2 matrix tables, 3 form-primitive vocabularies, 3 duration
formatters, 4 copy-button impls, hand-rolled RoleSegmented/buttons instead of ToggleGroup/Button. The
primitives largely exist (shadcn/Radix + SettingsGrid + DataTable) — the work is **adoption +
consolidation**, not invention.

**G3 (declutter Settings, flatten nesting).** Two parallel nav systems (`nav.ts` + `Settings.tsx`
`SECTION_GROUPS`), up-to-4-deep nesting, double-home admin surfaces, 3–4 single-item nav groups with
redundant headers, `GRID_SECTIONS` opt-out brittleness, double/triple-card nesting. **Pick ONE home
per surface** (route rail children into `#/settings?s=…` instead of standalone pages), collapse
single-item groups, put Settings on the SAME `NavGroup` shape.

**G4 (screen real-estate).** The `max-w-[1400px]` cap at `AppShell.tsx:601` is the governor; thin
padding + generous cap = wasted side gutters; unpaginated tables dump unbounded rows; density
defaults roomy; double-centered empty states; ~80px hero whitespace. **A shell-provided width mode
(`fixed`|`wide`|`fluid`) is the single highest-leverage change.**

**G5 (compact hero).** `HeroPanel` has no compact variant (`p-8` + `text-3xl` clamp + decorative glow
+ stacked `gap-6` + `py-6`). **Add a `compact` `PageHeader` variant** and drop the breadcrumb/title
duplication.

**G6 (rule customizability).** The typed foundation is largely **missing**: the real
`AutoClosePolicy`/`correlation_rules`/Round-4 blocks are unmirrored in `types.ts`; `settings/schema`
+ `sources/{id}/secrets` have no client; rules are scattered across Settings›Detection + Platform›
Auto-tuning + Analytics›Baseline with no single "Detection & Rules" home; enrichment/correlation
customization is coarse. But the **UX building blocks exist and are trapped**: `RoleMatrixEditor`
tri-state grid, `TemplateEditor` live-preview, `BudgetCard` config-editor pattern, DangerZone's UI/
api split. **Mirror the types first, extract the trapped editors, unify a rules home.**

**G7 (custom dashboards).** No dashboard/widget/layout type, no widget registry, no widget grid, no
dashboard client, no nav affordance to surface a user dashboard — **build-from-scratch on the
component side.** BUT the **persistence infra already exists** (`PrefsContext` + `UserPrefsStore`,
saved-views as the template, zero-migration KV pattern). Prerequisites: (a) fix the `misc` clobber
bug; (b) URL-serialize `NavOpts` (bookmarkable views); (c) make the page inventory data-driven (route
table) so a dashboard page can be registered from data; (d) add a widget descriptor + `<WidgetGrid>`.

**G8 (loose coupling).** Best-in-class: DataTable, format.ts, cn.ts, RiskGauge, BarList, the
pure/props-driven support primitives, EnrichmentProvidersEditor (the model). Worst: the 3-way page
inventory (nav.ts/App.tsx/PAGE_IDS), the 2 API layers + 16 sibling api files, page-scoped types under
`pages/*.api.ts`, `SectionHeading`/`SectionTitle` trapped in page files, monoliths (Settings 2673,
SourceEditor 1819, ChatPanel 1154, api.ts 797, types.ts 2047), `BrandingEditor`'s global DOM mutation,
`useNavPrefs` mixing persistence into a view file.

**G9 (fully tested).** Notable coverage GAPS: PageHeader/HeroPanel/layouts/TabbedPage (zero), 9 of the
chart exports (zero), most DataTable-consuming pages beyond Cases. Strong existing nets to KEEP GREEN:
NavSidebar (15 tests: aria-current + hydration), RiskGauge/BaselineGauge (#9 + geometry), CaseThread/
CaseTriageHeader (#9 + testids), customization.render, danger-zone, demo.render, ui-glitch-fixes,
Tuning.render, metrics-posture, theme-tokens (`glass-surface` class ordering), QRCode.

---

## 5. Prioritized recommendation seams (for the build phase)

1. **Shell width mode** (`AppShell.tsx:601`): replace unconditional `max-w-[1400px]` with a
   `ContentWidth` context / per-page prop (`fixed|wide|fluid`). Highest-leverage G4/G7. *Validate
   across every page (Chat has special height anchoring); keep the `key={page}` remount + `#socMain`
   skip-link.*
2. **Data-driven route table** (collapse `nav.ts` PageId union + `App.tsx` renderPage switch +
   PAGE_IDS into one `{id, lazyImport, propsAdapter, perm, navPlacement}` registry). Kills the drift
   class, unlocks G7/G8. *Preserve all 31 deep-link ids via redirect, keep the `overview` fallback.*
3. **URL-serialize `NavOpts`** (`router.tsx`) — bookmarkable/shareable views, a G7 prerequisite.
4. **Fix the `misc` clobber bug** + add `updateMisc(patch)` + wire `last_list_state` (`prefs.tsx` /
   `user_prefs.py:103-122`), then add a `dashboards` field mirroring `saved_views` (G7 persistence).
5. **Merge PageHeader+HeroPanel** into one variant component (G2/G5); **merge KpiTile+StatCard** into
   `StatTile` + add `<WidgetGrid>` (G2/G7). *Keep `.hero-display h1` reachable; keep named re-exports.*
6. **Mirror the real config in `types.ts`** (`auto_close`/`correlation_rules`/Round-4 blocks/
   `login_*`) + wire `settings/schema` + `sources/{id}/secrets` clients (G6). *Additive only; write to
   `auto_close`, never `fp_auto_close`; never let this tempt a `decide()` edit.*
7. **Extract shared form primitives** (`<Field>`/`<SwitchRow>`/`<ChipInput>`/`<CopyButton>`/`<OtpInput>`
   + `useDirtyDraft`) and the trapped editors (`TemplateEditor`, RoleMatrix tri-state cell) — the G6
   rules-editor foundation.
8. **Reconcile the two navigation systems** — route Settings children into `#/settings?s=…`, put
   Settings on the `NavGroup` shape, collapse single-item groups (G3; shrinks Settings.tsx).
9. **Consolidate duplicated utils** into `lib/format.ts` (`humanizeDuration`, terminology-aware
   `humanizeToken`) + shared `<LogBrowser>`/`useLiveTail` + shared `<Markdown>` (G2/G8). *Fix the
   plain-HTTP clipboard bug by routing CodeBlock/ChatPanel through `copyText`.*

All build-phase work stays additive where possible, keeps the 12 non-negotiables (esp. #3/#9/#10),
and keeps the test suite green (vitest 273 / pytest 1461 baseline) — `case_manager.py` **byte-identical.**
