# WEBUI Pages Map — Round 5 P1 (Understanding Phase)

> **Scope.** A page-by-page structural + UX audit of the TLSOC standalone web UI
> (`webui/`, the primary surface). For every page: **purpose**, **structure /
> key structures**, and the concrete **UI/UX problems** (space waste, clutter,
> inconsistency, coupling, customization gaps), with `file:line` citations. Ends
> with a **prioritized cross-page problem list** mapped to the overhaul goals.
>
> **Overhaul goals referenced throughout:**
> - **G1** — cohesive light+dark color scheme.
> - **G2** — ONE design standard on the existing shadcn/Radix/Tailwind stack.
> - **G3** — declutter Settings (2673 lines) + reduce nested submenus.
> - **G4** — dashboard uses more screen real-estate.
> - **G5** — compact the "Security Posture Dashboard" hero band.
> - **G6** — real rule customizability in the UI (detection / correlation / risk
>   / auto-close / tuning).
> - **G7** — user-created custom dashboards.
> - **G8** — loose coupling (movable/detachable/reusable components).
> - **G9** — highest quality, fully tested.
>
> **READ-ONLY mapping.** No files were edited. **NON-NEGOTIABLE:**
> `engine/case_manager.py` `decide()` must stay byte-identical — none of the UI
> recommendations touch it.

---

## Cross-cutting findings up front (the patterns that repeat everywhere)

These recur on almost every page and are the real overhaul levers. Details cited
per-page below.

1. **Two card grammars.** The shared `Card`/`CardHeader`/`CardContent` primitive
   (`webui/src/ui/card.tsx`, with `shadow-elev1` + standardized `px-5 py-4`
   padding) is imported by ~10-16 pages, but many pages hand-roll
   `rounded-lg border border-border bg-card p-5/p-6` instead. Worst offenders:
   **CaseDetail.tsx** (31 hand-rolled card boxes, zero `@/ui/card` import),
   **Models.tsx** (3), **Roles.tsx** (2, and the two even disagree —
   `bg-card p-5` vs `bg-surface p-4`), plus Cost/Metrics local `ChartCard`
   duplicates. None of the hand-rolled boxes carry `shadow-elev1`, so they render
   visibly flatter than every Card-based page. (**G2/G8**)

2. **Hand-rolled segmented controls.** No shared `SegmentedControl`/`ToggleGroup`
   primitive exists; the same `role=group` + `<button aria-pressed>` pattern is
   re-implemented in **≥8** places with drifting classes: `Cost.tsx:200-239`,
   `Metrics.tsx:392-446` (twice in-file), `Overview.tsx:512-539`,
   `Inbox.tsx:410-432`, `Approvals.tsx:563-580`, `SourceEditor.tsx:643`,
   `Knowledge.tsx:1301-1324`, `Scans.tsx:465-495`. A `ui/tabs.tsx` primitive
   exists but is not used for these. (**G2**)

3. **No shared FilterBar/Toolbar.** The `flex flex-wrap items-center gap-2
   rounded-lg border border-border bg-card` filter bar + `Showing X of Y` count
   trailer is **byte-identical** between `Audit.tsx:275` / `Audit.tsx:353-356`
   and `Cases.tsx:920` / `Cases.tsx:1060-1061`, and re-invented in Scans/Memory/
   Knowledge. (**G2/G8**)

4. **`errMsg` / `describeError` duplicated per page.** The `e instanceof ApiError
   ? e.message : fallback` helper is copy-pasted verbatim across AdminSessions,
   Sessions, Tuning, Baseline, Campaigns, BatchJobs, Users, Approvals. No shared
   `lib` util. (**G8**)

5. **Embedded-vs-standalone double header.** Pages that are BOTH a standalone
   route AND embedded in a host (Settings sections / TabbedPage hosts) render
   their own `PageHeader` unconditionally, producing a second title band inside
   the host. Non-GRID Settings sections wrap the embedded body in
   `<Card><CardContent p-6>` (`Settings.tsx:2644-2646`) causing card-in-card.
   Hit by Account, AdminSessions, Analytics, Cost, Standup, and the TabbedPage
   children. (**G3/G4/G5**)

6. **Client-side-only list processing with silent caps.** Cases (200), Audit
   (200), Scans (50) fetch one capped page and filter/sort/facet in-memory;
   facet dropdowns are populated only from the loaded window, so values outside
   it are unselectable and the "Showing X of Y" counts are window-relative, not
   population-relative. (**G9**)

7. **No user customization plumbing consumed.** A `UserPrefsStore` + saved-views
   + per-table column-state infra exists app-wide (used by Cases), but Audit,
   Scans, Campaigns, BatchJobs, Memory, Inbox, Sessions, Users, Knowledge do NOT
   wire `columnState`/`ColumnsMenu`/`SavedViewsBar` even though `DataTable` fully
   supports them. (**G6/G7**)

8. **`#9` untrusted rendering is upheld everywhere** — every page renders
   log/source-derived text as plain text / `InlineCode` / `CodeBlock`, never
   `dangerouslySetInnerHTML`. This is a genuine strength and MUST be preserved
   through any restyle.

---

## OVERVIEW GROUP

### `Home.tsx` — landing host (Dashboard | Standup)

- **Purpose.** 49-line TabbedPage host; renders a two-tab segmented control
  (Dashboard→`Overview`, Standup→`Standup`) driven off `NavOpts.tab`. Owns no
  content. Default landing surface (`#/overview`). `Home.tsx:28-49`.
- **Structure.** `TabbedPage` (`TabbedPage.tsx:46-92`) — controlled Radix Tabs,
  **inactive tab UNMOUNTED** (resets sub-page state + refetches on switch,
  `TabbedPage.tsx:82-86`).
- **Problems.**
  - **Compounding spacing / orphaned tab bar (G4/G5):** TabbedPage adds
    `space-y-6` + `mt-6` per TabsContent, THEN each sub-page adds its own
    `HeroPanel` + `space-y-6`. The tab bar floats above two independently-branded
    heroes (Overview "Security Command Center"/Radar vs Standup "Shift
    handoff"/Inbox) with divergent copy tone.
  - **Full remount on tab switch** re-fires every API call and loses the window
    selection — jarring vs a cheap tab switch.
  - Standup exists ONLY as this tab, not an independent route — cannot be reused
    without the Home host (`nav.ts:143-156`).

### `Overview.tsx` — the "Security Posture Dashboard" (the Dashboard tab)

- **Purpose.** Default dashboard. Fetches 5 datasets via `Promise.allSettled`
  (`Overview.tsx:179-208`; cases 200-cap, metrics, usage, rag, posture),
  derives a risk index + timing + severity/workload breakdowns, renders a
  HeroPanel + Active-Risk-Index gauge + 7-tile KPI grid + MTTD/MTTA/MTTR
  StatCards + three BarList signal cards. **The prime target for G4/G5/G7.**
- **Key structures.** `CommandCenterLayout` hero config `Overview.tsx:544-570`;
  KPI array `409-482`; RiskGauge card `608-640`; timing `303-334`; risk index
  `346-357`; `bandOf()` thresholds `144-151`.
- **Problems.**
  - **G5 (hero wastes a whole band):** `HeroPanel.tsx:46` uses `p-6 sm:p-8`
    (32px), an `h-11` icon chip, a clamped `hero-display` h1 (~34px,
    `theme.css:210`), and a `max-w-2xl` two-line description
    (`Overview.tsx:552-553`). Measured band ≈176px of chrome BEFORE any data,
    plus a decorative `bg-hero-glow` wash. The eyebrow ("Security Command
    Center") + title ("Security Posture Dashboard") restate the breadcrumb
    (`AppShell.tsx:497-501`); the only functional hero content is the window
    toggle + refresh + "Last refresh" meta.
  - **G4 (wasted horizontal space):** whole app clamped to `max-w-[1400px]`
    (`AppShell.tsx:601`). First body row is `lg:grid-cols-3` with the RiskGauge
    at `col-span-1` and 7 KPIs jammed into `col-span-2` as inner `xl:grid-cols-3`
    (`645`) → the 7th tile sits alone with 2 empty cells; no 4-up/5-up
    breakpoint, no `2xl:`.
  - **Redundant data across widgets:** the RiskGauge card's 3-row `<dl>`
    (`622-638`, Open/Critical/Critical-High) duplicates three KPI tiles
    (`419/435/437`); risk shows in gauge + RiskBadge + risk-breakdown card. A
    whole 1/3 column of redundant real-estate.
  - **Duplicated client posture math:** ~120 lines of client MTTD/MTTA/MTTR
    derivation (`229-334`) shadow the authoritative server posture endpoint
    (already fetched, `188`); the code comment itself admits lifecycle "lives in
    ONE place — Analytics" (`663-667`).
  - **Inconsistent bar rendering:** the SAME horizontal-bar pattern is done 3
    ways — shared `BarList` for Source Signals (`730`), hand-rolled `<ul>` for
    Severity Pressure (`750-788`), another hand-rolled clickable `<ul>` for Case
    Workload (`801-855`). (**G2**)
  - **200-case cap misleads:** tiles present client-sampled aggregates
    (`Artifacts In Scope`, `Critical/High Alerts`) as authoritative absolute
    counts (`184`).
  - **KPI click affordance inconsistent:** only some tiles have `onClick`; three
    identical-looking tiles are inert.
  - **G7 blocker — ZERO custom-dashboard infrastructure.** No widget registry,
    no draggable grid, no per-user layout persistence. Every tile/card is
    hardcoded JSX. Time window (24h/7d/30d) is fixed and not persisted (resets on
    tab switch). Risk-index weighting (`avg*0.7 + criticalDensity*0.3`, `355`)
    and severity bands (`80/60/35/15`, `144-151`) are magic constants with no UI.
- **Coupling.** Imports `fetchPosture`/`PostureResponse` from a **sibling page's**
  module (`./Metrics.posture.api`) and `humanizeMins`/`ratioPct` from
  `./posture.format` — the dashboard drags Metrics' private modules
  (`Overview.tsx:69-70`). `CommandCenterLayout` exposes an unused `strip` slot
  (`layouts.tsx:45`) — a ready seam for a compact KPI band.
- **Reuse.** Add a `compact` variant to `HeroPanel` (drop/thin the glow, shrink
  chip/padding) and merge `HeroPanel` + `PageHeader` (near-identical prop
  surfaces) into one `PageHero density=...`; wire the KPI row into the unused
  `strip`; collapse the three bar cards onto `BarList`; delete client posture
  math; build a widget registry from the KPI array (foundation for G7).
- **Risks.** Preserve every KPI `onNavigate('cases',{status})` drill-through
  contract; keep `Promise.allSettled` per-widget degrade + honest-DASH; re-tune
  the loading skeleton (currently `h-32` under-reserves the ~176px hero → layout
  shift). No dedicated Overview/Home render test exists beyond `App.smoke.test`
  asserting "Security Posture Dashboard" (**G9**).

### `Standup.tsx` — daily shift-handoff (the Standup tab)

- **Purpose.** Forward-looking handoff: urgency-ranked attention queue (rows
  deep-link to Cases pre-seeded with a status filter), SLA breach pressure,
  per-analyst workload, period-over-period delta tiles, action-items CRUD,
  acknowledge/sign-off, and a secondary model-generated prose summary. Data from
  `GET /api/standup/report` (deterministic) + legacy `GET /api/standup` (prose).
  `Standup.tsx:145`; data layer `Standup.report.api.ts`.
- **Problems.**
  - **Hero-within-a-tab (G4/G5):** full-width `HeroPanel` (`293-328`, `p-6/sm:p-8`)
    directly under the Home segmented bar → a second big title band before data.
  - **Re-implements shared tiles (G2/G8):** `DeltaTiles` (`406-455`) hand-builds
    KPI tiles duplicating `KpiTile` (label/value/delta/accent + identical arrow
    coloring, used by 8 pages); `MiniStat` (`655-662`) duplicates `StatCard`;
    workload bars (`705-716`) duplicate `BarList`.
  - **Inconsistent inset-chip surfaces:** `bg-card/70` / `bg-surface` used
    interchangeably for the same "inset chip" role (`282/425/554/657`).
  - **Hardcoded one-off tokens:** myAck banner `border-success/40 bg-success/10`
    (`917-921`), delta `text-success`/`text-critical` (`439`) bypass
    palette.ts/badges.tsx.
  - **Truncation with no "more":** SLA breach `slice(0,6)` (`614`), acks
    `slice(0,8)` (`962`).
  - **Window artificially limited (G6):** only 24h/7d (`89-92`) despite backend
    accepting arbitrary `window_hours` — no 8h/12h shift lengths for a SHIFT
    handoff.
  - **Opaque, non-configurable ranking (G6):** urgency is server-computed; UI
    shows a bare rank number with no legend/weights.
- **Coupling.** Cleanly takes only `onNavigate`; colocated data layer. But
  tightly bound to the Home host layout contract (renders its own hero assuming
  it's a bare tab body). Dead exports `listActionItems`/`listAcknowledgements`
  (no importers).
- **Reuse.** Swap DeltaTiles→`KpiTile`, MiniStat→`StatCard`, workload→`BarList`;
  one tokenized inset surface; shared WindowToggle with Overview.
- **Risks.** Keep `onNavigate('cases',{status})` contract, `normalizeReport`
  degraded/disabled coercion, the window-seed-before-first-load gate
  (`186-216`), the two `Can cases:write` gates, and the
  `data-testid="delta-tile-<key>"` the test pins (**G9**,
  `standup-report.test.tsx`).

---

## TRIAGE GROUP

### `Cases.tsx` — analyst triage worklist (1382 lines)

- **Purpose.** Primary worklist: dense `DataTable` of recent cases with
  filter/sort/paginate/bulk-act/open-detail. Fetches ONE capped page
  (`LIST_LIMIT=200`) and does ALL filtering/sorting client-side, self-healing
  facets on reload. Posts only HUMAN lifecycle actions (never bypasses
  `decide()`). `Cases.tsx:435`.
- **Key structures.** `load()` `464-476`; 18 inline column defs `641-831`
  (re-created every render); filter engine `applyFilters/buildFacets/healFilters`
  `202-307`; sort comparators `379-398`; saved-view (de)serialize `324-364`;
  `BulkActionBar` `1195-1382`; `CaseDetail` sheet mounted `1163-1170`.
- **Problems.**
  - **G4 (tall stack):** 5 full-width bands before a single row — PageHeader,
    4-up KPI Stagger (`871-902`), SavedViews+Columns bar (`905-917`), wrapping
    filter bar (`920-1065`), up to 3 stacked Alerts (`1068-1098`) — all
    `space-y-6`. Table is below the fold on a laptop.
  - **Filter bar overflows uncontrollably (G3):** one `flex flex-wrap` with a
    16rem search + 4 fixed-width Selects + time Popover + cross-source toggle +
    Clear + right-aligned count; below ~1100px it wraps to ragged rows, `ml-auto`
    count jumps. No "more filters" affordance.
  - **Destructive one-click close, NO confirm:** per-row red Trash2 immediately
    posts `{action:'close'}` (`809-830`) — a mis-click closes a case.
  - **Three redundant count readouts:** DataTable footer + filter-bar
    "Showing N of M" + truncation Alert (`1060/1068`).
  - **Column overload:** 18 columns, 5 overlapping "how bad" signals
    (severity/severity_ai/risk/urgency/confidence) + 3 tiny count columns; wide
    default → horizontal scroll.
  - **KPI tiles inconsistent scope:** "Total (server)" beside "Open (in view)"
    on different denominators; two of three sibling tiles clickable, one silently
    isn't.
  - **Ad-hoc Popover re-implements a Select** for time range (`997-1037`);
    "Oldest first" as a one-way header action button (`852-861`).
- **Coupling.** **Static import of the 4210-line `CaseDetail`** (`Cases.tsx:90`)
  — opening the Cases route eagerly loads the whole detail sheet into the chunk
  (biggest bundle/coupling issue; should be lazy). Untyped `route.opts` bag
  access; loose `as Record<string,unknown>` casts for `rule`/`severity`; tagging
  smuggled through `{action:'acknowledge', tags:[...]}` (`1154`).
- **Customization gaps (G6).** **No rule affordance from a case** — no "tune this
  detection rule", "suppress this signature", "adjust auto-close", "make a rule
  from this case", despite the backend having all of it. Severity bands +
  filter facets + time ranges + bulk status/disposition options all hardcoded.
- **Reuse.** Extract shared `FilterToolbar` (shared with Audit); move the
  column/filter engine to `cases.columns.ts`/`cases.filters.ts`; lazy-load
  CaseDetail; adopt `WorklistLayout` (`layouts.tsx:73`) to move filters to a
  rail and free full width/height for the table (G4).
- **Risks.** Preserve truncation honesty, filter self-heal, `Can cases:close`
  gate, HUMAN-only actions (#3), #9 rendering, drill-through contract, tolerant
  saved-view (de)serialize.

### `Scans.tsx` — "Automated scans" board (card grid)

- **Purpose.** Read-only board of cases the background poller/agent auto-opened.
  Fetches `GET /api/scans` (cap 50) + `/api/scans/notifications`, derives 4 KPI
  tiles + a client filter/sort toolbar, renders a responsive **card grid** of
  `ScanCard` tiles that open `CaseDetail`. `Scans.tsx:168`.
- **Problems.**
  - **Design inconsistency (G1/G2):** renders a card grid while its sibling
    `Cases.tsx` renders a DataTable for the SAME `Case` object — two visual
    languages, no shared list primitive. Scans has no bulk actions, column
    config, saved views, or pagination that Cases has.
  - **Spacing drift:** KPI `gap-5` (`417`) vs Cases KPI `gap-4` (`872`); page
    `space-y-8` (`369`) pushes cards below the fold; KPI skeleton hardcodes
    `h-[7.5rem]`, card skeleton `h-44`.
  - **Nav/page icon mismatch:** rail `ScanLine` (`nav.ts:179`) vs page
    `ScanSearch` (`372/427/581`).
  - **Dead prop `onNavigate`** (`164-168`); empty state says "Enable background
    scans in Settings" with no link.
  - Fake `role=tab` buttons with no `role=tablist`/`aria-controls` (`468-493`);
    obscure `￿` sort sentinel (`345/347`).
- **Coupling.** Hard import of the `CaseDetail` PAGE module (`69`); duplicates
  `sortedUniq`, the self-heal facet effect, and the needs-human/TP KPI derivation
  independently from Cases (no shared `useCaseFilters` hook). Hardcoded
  `localStorage` key inline (`144`).
- **Customization gaps.** No rule controls (where auto-scan output lands but you
  can't tune WHAT gets scanned, **G6**); no saved views / table-vs-card toggle /
  density (**G7**); facets derived only from the 50-cap.
- **Reuse.** Shared `useCaseList`/`useCaseFilters` hook + `FilterToolbar` +
  `DataTable` across Scans and Cases; converge on ONE case-list surface with a
  card/table toggle. Move `CaseDetail` to `components/`.
- **Risks.** Keep `onClose→void load()` refresh, the pre-first-load watermark
  seed, #9 plain-text, self-heal, and read-only-over-`decide()` (#3).

### `Approvals.tsx` — HITL approval queue

- **Purpose.** The queue where the deterministic spine surfaces agent-DRAFTED
  recommendations (suppression rules or durable memories) for human
  approve/reject. **Approving is the only thing that makes a rule live / saves a
  memory (#3).** Filter Pending/All, optional group-by, act singly or in bulk.
  `Approvals.tsx:367`.
- **Problems.**
  - **Wasted vertical space / low density (G4):** each proposal is a full-width
    `Card p-5` with `mt-5` gaps between 4 blocks and `gap-8` between groups; a
    queue of short `field == value` rules eats a whole screen for 2-3 items. No
    compact/table view (contrast Cases' DataTable).
  - **Reassurance told 3×:** the "nothing is applied automatically" message
    appears in PageHeader description (`652`), a persistent Alert (`656-668`),
    AND the footer (`728-732`) — pushing the queue far down.
  - **Bespoke UI (G2):** the Pending/All filter is a unique hand-rolled toggle
    (`563-580`); the sticky bulk bar (`689-715`) reimplements Cases' `BulkBar`;
    the left accent stripe `before:...w-[3px]` (`206`) exists ONLY here.
  - **Ad-hoc color semantics (G1):** kind accents suppression→warning,
    memory→info (`190-195`) are not tied to palette.ts.
  - **RBAC is reactive:** Approve/Reject always enabled; a non-admin learns they
    can't only after a 403 toast (`124/476`). Should use `<Can>`.
  - **No select-all** (card checkboxes only); non-semantic case-link buttons.
- **Coupling.** No `.api.ts` extraction (unlike EnrichmentProviders/
  NotificationBell/branding); `ProposalCard` inline + not exported; business
  helpers (`kindMeta/describeError/asText`) live in the page; toast baked into
  handlers.
- **Customization gaps (G6, direct hit).** This is where suppression RULES go
  live, yet it offers **ZERO editing** — approve-as-drafted or reject only; a
  human cannot tweak field/value/reason, nor author a suppression/correlation/
  auto-close/tuning rule here. No filter by kind/confidence/source/age; single
  hardcoded group-by; no saved views; no auto-refresh.
- **Reuse.** Shared `SegmentedControl` + `BulkActionBar` + `ProposalCard` in
  `components/`; move `describeError`/`asText` to `lib`; optional `DataTable`
  compact view for density.
- **Risks.** Keep approve-is-the-only-apply contract + per-proposal server
  authorization; UNTRUSTED payload rendering; 403/404/409 handling + reload
  resync; selection self-heal; `busyId`/`bulkBusy` single-flight. **No tests
  exist** — G9 means any refactor is unguarded.

### `Campaigns.tsx` — cross-case CAMPAIGN surface

- **Purpose.** Read-only view over deterministic campaign clustering: a
  `DataTable` of campaigns + a right Sheet detail (shared entities, MITRE union,
  member-case deep links) + admin "Recorrelate". Also exports `CampaignChip` for
  CaseDetail. Advisory only (never `decide()`, #3/#4). `Campaigns.tsx` +
  `Campaigns.api.ts`.
- **Problems.**
  - **RBAC affordance wrong (functional):** the mutating "Recorrelate" is wrapped
    in `<Can cases:read>` (`220-229`) — the SAME perm gating the whole page — so
    every viewer sees an ENABLED button; the docstring says it's admin-only
    server-side, so non-admins get a 403 toast. Sibling Tuning correctly gates
    mutations behind a `manage` perm.
  - **No data density (G4/G5):** plain `space-y-6` stack; no KPI/summary band
    despite the API returning `total` + per-campaign status/severity. The "off"
    Alert (`234-244`) permanently consumes a full band when clustering is
    disabled (the DEFAULT), and only tells you to go to Settings (no link/CTA).
  - **Zero table customization (G6):** hardcoded columns, no `columnState`/
    ColumnsMenu, no `sortable`, no status filter (despite API `status` param).
  - **No pagination / unbounded fetch** (`list()` with no limit/offset).
  - **Status rendered 3 ways with 2 mappings:** plain muted text in the table
    (`136-138`) vs colored `statusVariant()` badge in the sheet (`316-318`).
  - Magic truncation caps (3 entities / 4 MITRE); duplicated status-label
    expression written 3× (`137/311/317`).
- **Coupling.** Well-decoupled API (uses low-level `api.get/post`), clean
  `onNavigate` threading. BUT `CampaignChip` is exported from the PAGE module and
  consumed by CaseDetail — pulls page code into CaseDetail's bundle; belongs in
  `soc/components/badges.tsx`. Perm keyed to `cases`/`read` with no distinct
  campaign resource.
- **Reuse.** Move `CampaignChip` to badges.tsx; `statusLabel()` helper; adopt
  `columnState`/ColumnsMenu/sort; shared KPI band; consolidate the two "what is a
  campaign" messages into an actionable EmptyState with a Settings deep-link.
- **Risks.** Keep advisory/read-only contract; #9 fencing; RBAC direction (keep
  403→toast); render-test assertions (title/name/`10.0.0.5`/`T1021`/row-click/
  `/^open$/i`/CampaignChip aria-label).

---

## INTELLIGENCE GROUP

### `Intelligence.tsx` — host (Knowledge | Memory | Playbooks & Agents)

- **Purpose.** 65-line thin host grouping three "what the agents know" surfaces
  under one nav item via `TabbedPage`. Owns the unified PageHeader; renders each
  child `embedded`. `Intelligence.tsx:31`.
- **Problems.**
  - **Nav-label vs tab-value drift:** `nav.ts:194-196` declares children
    `knowledge`/`memory`/**`playbooks`** but the tabs are
    `knowledge`/`memory`/**`catalog`** (`44-61`) — two tokens for one view.
  - **Tab switches never update the URL:** `onValueChange` calls
    `navigate('intelligence',{tab:next})` but the router only writes `#/`+page
    (`router.tsx:47-52`), so sub-tabs aren't deep-linkable/back-addressable and a
    refresh always resets to Knowledge — contradicting the file's own docstring.
  - **Full unmount + refetch on every switch** (TabbedPage forceMount off) across
    Knowledge (1737 lines) / Memory (960) / Catalog (589) — skeleton flash + lost
    filter/scroll state.
  - **Dead wiring:** passes `onNavigate` to Memory + Catalog which both ignore it.
  - **Inconsistent embedded header:** Knowledge + Memory render a right-floated
    Refresh strip (`justify-end`); Catalog renders `null` — two tabs show a stray
    right-floated button, one doesn't.
  - **Eyebrow incoherence:** host eyebrow "Intelligence" but children's own
    headers still say "Knowledge" (Knowledge AND Catalog) / "Platform" (Memory).
  - **Nested tabs-in-tabs:** Catalog renders a second Personas|Playbooks Tabs
    bar → a two-level tab stack (G3).
- **Coupling.** Hard-imports the three concrete pages; deeply coupled to the
  router's non-URL-persisted opts model; three places must agree on the token set
  (nav.ts / tabs / App.tsx route arms) and already drift. Purely presentational
  (touches no `decide()`), so cheap to move if the contract travels.
- **Reuse.** Extract an `EmbeddablePageHeader`/`useEmbeddedHeader` primitive;
  push URL-sync into TabbedPage/router once for ALL W4 hosts; flatten Catalog's
  inner tabs into the host bar; normalize one shared `EmbeddedPageProps`.

### `Knowledge.tsx` — Knowledge / RAG corpus (1737 lines)

- **Purpose.** Operator window into the RAG retrieval corpus: corpus-health KPIs,
  "Corpus by source" BarList, threat-intel/resolved-case sections, Import +
  threat-intel import, "Try a retrieval" search, indexed-documents DataTable,
  document drill-in Sheet, delete dialog. Standalone + embedded in Intelligence.
- **Problems.**
  - **Space/scroll waste (G4/G5):** one long vertical scroll (`space-y-8`) of
    full-width bands; the primary task (documents table) sits far below ~5
    secondary bands. "Corpus by source" is a full-width band for ONE BarList that
    duplicates the source-count KPI.
  - **Redundant document listings:** threat-intel + resolved-case docs appear in
    dedicated `CorpusSourceSection` `<ul>` cards AND again in the full DataTable
    — same rows, two inconsistent row treatments.
  - **Local `CardIcon` reinvented** (`187-191`) — the `bg-primary/10 text-primary`
    chip is hand-rolled again in CaseDetail/KpiTile/NavSidebar/RoleMatrixEditor/
    CaseThread/EnrichmentProvidersEditor; the card-header-with-icon block is
    copy-pasted 4× within this file.
  - **Bespoke density toggle** (`1301-1324`, one-off `localStorage`) and bespoke
    `<ul>` row lists — a second inconsistent "document row" language beside the
    real DataTable.
  - **Redundant permission double-gate** (`1705-1709`, `useCan` ternary AROUND a
    `<Can>`).
  - **Two near-identical import cards** (ImportCard + ThreatIntelImportCard,
    ~120 duplicated lines of tag-chip + size-guard logic).
  - **Placeholder disabled "Min. similarity" input** hardcoded to `0.70`
    (`1022-1028`) — decorative, takes a grid column, implies configurability.
  - Inconsistent grid gaps (`gap-4` vs `gap-6` vs `space-y-8`).
  - Scattered source-classification heuristics (5 independent `.includes()`
    functions with overlapping keyword sets).
- **Customization gaps (G6).** No retrieval-config surface: similarity floor,
  chunk size/overlap, hybrid BM25-vs-vector weighting, embedding model are the
  RAG "rules" an operator wants but are all backend-only; Top-K is per-query
  only; density is the only persisted pref (client-only, not wired to
  UserPrefsStore); no column choosing; no user-defined source taxonomy.
- **Reuse.** Shared `SectionCard` (or route through `SettingsCard`); `TagInput`;
  fold the two import cards into one with a kind selector; shared segmented
  density control; a single `sourceKind(label)` taxonomy helper; replace the
  bespoke `<ul>` with DataTable/`DocRow`.
- **Risks.** #9 fencing (titles/source labels/chunk text/tags via
  plain/CodeBlock/InlineCode — never markdown); the guarded-seed force-delete
  400→force-retry; `rag:manage` gate; the FileReader multi-file queue +
  size-guard; embedded-vs-standalone header.

### `Memory.tsx` — durable operator facts (960 lines)

- **Purpose.** CRUD for durable facts the agents always know (internal IP ranges,
  known scanners, naming conventions, standing exceptions): 4 KPI tiles, an "Add
  a memory" card, a saved-memories toolbar (sort + group-by-category + filters),
  and a list (optionally grouped) of `MemoryRow` cards with inline edit/toggle/
  delete. Standalone + embedded in Intelligence. `Memory.tsx:498`.
- **Problems.**
  - **Wasted vertical space (G4):** `space-y-8` root; a persistent "What is
    memory?" Alert (`727-741`) duplicates the PageHeader description AND footer
    note — same guidance in 3 places. The **AddMemoryCard is ALWAYS expanded**
    at the top (the #1 space waster; should collapse to a button/dialog).
  - **Three-row control clutter (G3):** header+count+group+sort row THEN a
    separate full filter toolbar row — a switch + 4 Radix Selects/inputs + clear
    for what's usually a short list.
  - **Duplication:** filter-toolbar pattern copy-pasted near-verbatim from sibling
    Knowledge; the tag editor written twice in-file (AddMemoryCard + MemoryRow
    edit).
  - **Hardcoded/magic widths** (`w-[12rem]`/`w-[11rem]`/`w-[10rem]`, three
    arbitrary widths in one toolbar).
  - **`TooltipProvider` instantiated 5×** (should wrap the app once).
  - **Card padding drift:** `p-5` (row) / `p-5`+ring (edit) / `p-6` (add) — three
    paddings on one page; a one-off left "accent rail" makes rows look unlike
    every other row list.
  - Re-implements `SeverityBadge` as page-local `severityVariant()`; delete is a
    bare `text-critical` icon rather than a destructive variant.
- **Coupling.** Low backend coupling (api facade only). Loose `onNavigate:
  (page:any,opts?:any)` (never used — dead prop). Dual-mount contract to
  preserve. Filter/tag logic should be shared, not moved.
- **Customization gaps.** Sort/filter/group state is **ephemeral** (resets on
  mount) — no `UserPrefsStore`/`SavedViewsBar`; free-text categories (no managed
  taxonomy); no bulk ops; no import/export; hardcoded terminology despite the
  terminology-override feature. (Not a G6/G7 rules/dashboard surface, but the
  un-persisted view state is the debt.)
- **Reuse.** Shared `FilterBar`/`ListToolbar` (with Knowledge); `TagInput`;
  `KpiGrid`; move `SourceBadge` to badges.tsx; one root TooltipProvider; collapse
  AddMemoryCard into a Dialog; adopt SavedViews + terminology.
- **Risks.** #9 (fact text is agent-authored UNTRUSTED — keep whitespace-pre-wrap
  plain text, never markdown); memory must never appear to influence
  close/escalate (#3); dual-mount; optimistic upsert + `busyId` lock; edit-buffer
  re-seed guard; category self-heal; `__any__` sentinel. **No tests exist** (G9).

### `Catalog.tsx` — read-only "Playbooks & Agents"

- **Purpose.** Read-only showcase of personas (`GET /api/personas`) +
  playbooks/runbooks (`GET /api/playbooks`) as 2-col card grids behind an
  internal Tabs; best-effort `GET /api/settings` to annotate playbook cards with
  automation-rule counts. Hosted as Intelligence's "Playbooks & Agents" tab;
  suppresses its own header when embedded. `Catalog.tsx:556`.
- **Problems.**
  - **Double-nested tabs (primary clutter):** Catalog's own Personas|Playbooks
    Tabs INSIDE Intelligence's TabbedPage → two stacked TabsList rows.
  - **Wasted vertical space (G4/G5):** header + tabbar + tabbar + a full-width
    `CatalogNote` before any card; `space-y-8` beneath the host's `space-y-6`.
  - **Low grid density:** caps at `lg:grid-cols-2` (no `xl:`), unlike Models
    (`lg:grid-cols-4`).
  - **No search/filter** despite importing the `Search` icon (used only as a
    persona glyph).
  - **Dead prop `onNavigate`:** declared/passed but never used; the playbook card
    tells users to "Manage them under Settings → Threshold automation" as PLAIN
    TEXT instead of a deep-link.
  - **Duplicate badge-grid logic:** `MatchCriteria` (`318-371`) reimplements
    `BadgeRow` but WITHOUT its `+N` overflow cap — inconsistent badge behavior
    between the two card types.
  - Local `BadgeVariant` union redefined (drifts from ui/badge); bespoke 11px
    label token repeated 3×.
- **Coupling.** Reaches into the FULL Settings blob just for a badge count
  (`getSettings()` → `prefs.threshold_automation.rules`, `489-497`) — couples to
  the exact rule schema + a heavyweight fetch. Otherwise self-contained.
- **Customization gaps (G6, direct).** Strictly READ-ONLY. Playbook MATCH
  CRITERIA (rule_ids/entity_types/mitre/min_event_count/any_tags) and persona
  keywords/focus_tools — exactly the detection/correlation config users want —
  are view-only; can't create/edit/enable/reorder priority. Points users OUT to
  the 2673-line Settings.tsx.
- **Reuse.** `MatchCriteria`→`BadgeRow`; shared `SectionLabel`; import
  `BadgeVariant`; drop `CatalogNote`; collapse the double tab layer; unify a
  shared `CatalogCard` across Persona/Playbook/Models cards; ask backend for
  `automation_count` on `/api/playbooks`.
- **Risks.** Any G6 "edit match criteria" work keeps #3 (playbooks only
  recommend); preserve #9 + the four graceful states per catalog + best-effort
  403-silent getSettings + embedded-flag; add a test (only `models-catalog.test`
  exists).

---

## ANALYTICS GROUP

### `Analytics.tsx` — thin reporting host

- **Purpose.** 47-line host: renders a PageHeader and delegates ALL content to
  `Metrics.tsx` via `<Metrics embedded tab onTabChange/>`; threads the route tab
  so `#/metrics`/`#/cost` deep-links land right. `Analytics.tsx:30`.
- **Problems.**
  - **Double page header / eyebrow==title:** `Analytics.tsx:33-38` sets
    eyebrow="Analytics" AND title="Analytics"; standalone Metrics shows
    "Analytics/Metrics" — inconsistent title, wasted band.
  - **Redundant description** duplicating the tab labels below.
  - **Tab model diverges from nav model (G3):** nav children are Metrics|Cost|
    Models|Baseline|Batch jobs (`nav.ts:212-216`) but the in-page tab strip is
    Operational|Performance|Posture|Cost — two competing mental models.
  - **Same page, two presentations:** `#/metrics?tab=cost` renders Cost embedded
    (no header); `#/cost` renders standalone Cost (full header).
  - **Wrapper-around-a-wrapper:** Analytics→Metrics→embedded Cost, 3-deep host
    chain; route id `'metrics'` hardcoded in Analytics.
- **Reuse.** Delete Analytics; fold its header job into Metrics (which already
  has an embedded/standalone header branch); render `<Metrics>` directly from
  App.
- **Risks.** Preserve `#/metrics`/`#/cost` deep-links + the tab round-trip; the
  `analytics-consolidation.test` locks EXACTLY four tabs; `NavSidebar.test`
  asserts one aria-current when host id == child id.

### `Metrics.tsx` — consolidated analytics (1447 lines)

> Mapped by two agents (A: shell+tabs+data; B: Performance/Posture tabs). Merged.

- **Purpose.** The single "Analytics" surface: a Tabs strip owning Operational
  (verdict/disposition donuts, persona/playbook bar-lists, cases-per-day,
  feedback quality, an LLM-spend pointer, knowledge/memory) / Performance
  (server-side MTTA/MTTR/dwell p50/p90 + quality rates + period-over-period
  deltas) / Posture (aging, SLA, MITRE coverage heatmap + Navigator export) /
  Cost (embeds the standalone Cost page). Co-located `Metrics.posture.api.ts` data
  layer. `Metrics.tsx:232`.
- **Problems.**
  - **G7 — ZERO custom-dashboard capability:** every widget, tab membership,
    window is hardcoded (`METRICS_TABS 210`, `kpis 555-606`, chart grids
    `645-763`/`985-1059`).
  - **G4 wasted space:** grids never exceed `lg:grid-cols-6`/`xl:grid-cols-4` (no
    `2xl:`), letterboxed inside `max-w-[1400px]`. Verdict/disposition cards stack
    a DonutChart AND a full redundant legend `<ul>` of the same segments
    (`648-728`) — ~2× card height.
  - **G5-adjacent:** every tab opens with an all-caps `<h2>` eyebrow + generous
    `space-y-8` before the first data (`982/1009/1021/1218/1303/1373`).
  - **Hand-rolled toolbar (G2):** window/sort segmented buttons are raw `<button>`
    groups with duplicated classes (`392-446`, done twice in-file).
  - **Local `humanizeMinutes`** (`105-115`) duplicates the shared one in
    `posture.format.ts:25`; local `statBlockTile` duplicates `statP50Duration`.
  - **Three overlapping tile primitives** (KpiTile / StatCard / QualityTile) used
    interchangeably across tabs.
  - **Local `ChartCard`/`ChartEmpty`** (`174-205`) duplicate shared Card +
    `EmptyState` (which is imported and used elsewhere in the SAME file).
  - **DELTA ARROW/COLOR CONTRADICTION (real bug):** `deltaView()` flips the sign
    for `lowerIsBetter` metrics (`posture.format.ts:83`) so KpiTile colors it
    green, but `KpiTile.tsx:88` picks the arrow from `value >= 0` while the label
    keeps the original sign → a FP-rate/MTTA that DROPPED shows a **green UP
    arrow next to a "-12%" label**. Affects MTTA/MTTR/FP-rate/Escalation tiles.
  - **Dead computation:** `maxAge` computed only to satisfy lint, dumped into an
    `sr-only` "max N" span (`1185/1243-1244`).
  - **Synthetic BurnDownChart:** fed a fabricated 2-point series from a single
    snapshot (`1189-1195`) — draws a trend from non-timeseries data.
  - Magic truncations (top-8 techniques `1206`, top-8 oldest, top-10 breaching)
    with no "view all"; MITRE hardwired to `window_hours=0`.
- **Coupling.** **Hard page→page dependency:** imports and mounts the entire Cost
  PAGE (`89`, `<Cost embedded/>` `916`). Tab state has three coupled sources
  (tabProp / localTab / onValueChange). Deeply coupled to exact server payload
  shapes; data layer calls `api.get` with raw path strings duplicated outside the
  typed client; `posture.format`/`Metrics.posture.api` live in `pages/` but are
  imported by Overview too — a de-facto shared module in the wrong place.
- **Customization gaps.** No user control over which metrics/order/window (3
  fixed presets, per-widget window impossible); SLA/aging thresholds hardcoded;
  no saved analytics view; no pin-to-Overview.
- **Reuse.** Promote `ChartCard`/`ChartEmpty` to `soc/components` (or use
  EmptyState); one shared SegmentedControl; delete local `humanizeMinutes`;
  converge tiles onto KpiTile; extract PerformanceTab/PostureTab to their own
  files; move `posture.format`/`Metrics.posture.api` to `lib/`; wrap each chart in
  a widget descriptor (foundation for G7).
- **Risks.** Don't touch `decide()`; #9 plain-text on all labels; honest-DASH +
  the `deltaView` lowerIsBetter color-flip (fix the arrow/label bug WITH a test
  asserting arrow==label sign); the parallel-safe `Promise.resolve().then` fetch;
  the Cost tab owning its own window; `#/metrics`/`#/cost` deep-links; the
  `analytics-consolidation` 4-tab assertion.

### `Cost.tsx` — LLM spend / cost ledger (944 lines)

- **Purpose.** Reads ONE endpoint (`GET /api/usage/summary`) and derives
  everything client-side: 4 KPI tiles, a spend-over-time TrendArea + 3 series
  stats, 3 efficiency StatCards, 3 ranked BarList breakdowns, a
  dimension-switchable ledger DataTable + composition DonutChart, and a
  top-drivers list. Standalone route + embedded as Metrics' Cost tab. `Cost.tsx:297`.
- **Problems.**
  - **G4 tall single-column stack** of full-width Cards; 3 efficiency StatCards +
    3 ranked breakdowns are two separate full-width rows that could share.
  - **Redundant metrics:** "Total tokens" + "LLM calls" tiles restate the "Total
    cost" tile's sub-line (`546-548`).
  - **Duplicated `SegmentedToggle`** (local `200-239`, not exported) — Metrics
    and Overview reimplement the same pill toggle (3 copies). Third `SectionTitle`
    definition (alongside Settings + SourceEditor). Two near-identical card
    primitives (KpiTile top-accent vs StatCard left-accent) for the same job.
  - **Confusing trend delta semantics:** spend delta is negated (`551-554`) so a
    spend INCREASE renders as a red DOWN-arrow; convention isn't labelled.
  - **Trend throws away the real time axis:** `cost_over_time` carries `ts` but
    the chart uses the bucket INDEX as x (`349-352`) and hides the axis.
  - **O(n²) `indexOf` in render** for color index (`448/476`).
  - **No customization (G6/G7):** fixed windows, `MAX_DONUT_SLICES=6`, top-10/
    top-8 caps; no budget/alert threshold UI here (backend has a BudgetGate); no
    saved default view; no ledger export.
- **Coupling.** Tightly coupled to the exact `UsageSummary` shape; cross-page
  toggle/header duplication with Metrics + Overview; embedded contract with
  Metrics (Cost owns its own window; two selectors appear if that suppression
  regresses).
- **Reuse.** Promote `SegmentedToggle`; unify KpiTile+StatCard into one
  metric-card with an accent-position variant; consolidate the 3 `SectionTitle`s;
  shared `EmbeddablePageHeader`; derive skeleton from the layout config.
- **Risks.** #9 InlineCode on model ids / driver keys; keep the embedded
  contract; keep the optional-field guards → EmptyState; the cost-delta negation
  convention; read-only (never a mutating endpoint).

### `Models.tsx` — LLM admin (+ `Models.api.ts`, `ModelsCatalog.tsx`, `BudgetCard.tsx`)

- **Purpose.** First-class LLM admin: a 3-tab page (Catalog | Cost & budget |
  Providers) behind `ProtectedRoute models`. Catalog = capability chips + per-1M
  pricing + provenance badge + read-only role assignment + per-row price-override
  + metered test-call. Cost & budget = a pre-flight estimator + budget-ceiling
  editor with burn-down. Providers = static registry grid.
- **Problems.**
  - **Design-system non-reuse (biggest):** hand-rolls `rounded-lg border
    border-border bg-card p-5` in 3 places (CostEstimator `464`, ProvidersGrid
    `563`, BudgetCard `189`) instead of `@/ui/card` — no `shadow-elev`,
    inconsistent padding vs every Card-based page.
  - **Provider name rendered 3 inconsistent ways:** raw `r.provider` +
    `capitalize` in the catalog column (shows "Openai_compatible" with an
    underscore) vs `humanizeToken()` in the filter dropdown and Providers grid.
  - **`fmtMoney` currency misuse:** passes a 3-letter ISO code as a literal
    symbol → "EUR0.0042".
  - **Two reinvented section headers** (CostEstimator + BudgetCard) instead of
    `SettingsCard`; arbitrary `StatCard accent="medium"` (a risk token) for an
    "Overrides" count.
  - **Wasted vertical space** in the Catalog tab (full-width paragraph + `w-48`
    filter leaving the row empty); thin static Providers tab (informational
    dead-end); uneven loading (skeleton in catalog, bare "Loading…" text
    elsewhere); dense PricingCell (3 lines at 0.7rem, no headers).
- **Coupling.** **Tight cross-import ring:** `Models.api.ts` is the source of
  types, and BOTH `ModelsCatalog.tsx` AND `BudgetCard.tsx` import from
  `@/soc/pages/Models.api` — a `components/` file depending on a `pages/` module.
  Role-assignment split across Models (display-only) + Settings (editor);
  `MODEL_ROLE_SLOTS` exported but imported nowhere (dead). BudgetCard owns its own
  fetch (page Refresh doesn't refresh the burn-down).
- **Customization gaps (G6).** No role-assignment control here (display-only,
  `MODEL_ROLE_SLOTS` scaffolded-but-empty); no capability editing; no provider
  config from the Providers tab; cache-rate override missing (only in/out per-M);
  no add/hide-model or enable toggle; coarse budget granularity (daily/monthly
  only, no per-role/model/provider sub-budgets).
- **Reuse.** Replace the 3 hand-rolled boxes with Card/SettingsCard; standardize
  `humanizeToken`; move `Models.api.ts`+types out of `pages/`; extract
  CostEstimator/ProvidersGrid to `components/`; a shared `ProvenanceBadge`; fold
  per-role assignment INTO this page using `MODEL_ROLE_SLOTS`.
- **Risks.** The metered TestCallDialog makes a REAL cost-ledger LLM call — keep
  `canManage`-gated + the 2000-char cap; #9 CodeBlock for the reply; keep
  `encodeURIComponent` on price PUT/DELETE; #3 BudgetCard copy accurate; keep
  `models-catalog.test` selectors.

### `Baseline.tsx` — anomaly baseline warm-up (+ `Baseline.api.ts`, `BaselineGauge.tsx`)

- **Purpose.** Read-only "warm-up + coverage" surface: how per-entity streaming
  baselines (EWMA/EWMV + 168 hour-of-week buckets + t-digest) warm up + their
  robust percentiles. `Baseline.tsx` is an ~88-line fetch wrapper rendering ONE
  child, `BaselineStatsOverview`. Advisory producer (never `decide()`, #3/#4).
- **Problems.**
  - **DEAD/UNWIRED FEATURE:** the entire per-signature drill-in
    (`fetchBaselineSignature` + `BaselineSignatureCard` + `BaselinePercentileSparkline`
    + `BaselineWarmupGauge` + `PercentileReadout`) is built and TESTED but only
    referenced by tests — the page renders ONLY the overview. Operators can never
    drill into a signature's warm-up/percentiles (the module's load-bearing
    "audit that a baseline is still warming" feature). Half the slice is
    unreachable.
  - **Docstring lies about embedding:** claims `BaselineSignatureCard` is embedded
    on CaseDetail — grep finds ZERO CaseDetail references; the `embedded` branch
    is dead code.
  - **Wasted space (G4):** whole body = 4 StatCards + one Progress bar + a caption
    → a single short band on a wide viewport; `stats.signatures[]` is fetched but
    never rendered.
  - **Fragile green "warm" hack:** `[&>div]:bg-success` on `<Progress>` (`100/366`)
    fights the primitive's hard-set `bg-primary` — winner depends on Tailwind CSS
    source order.
  - **No `enabled=false` affordance** (default-OFF feature) — no Alert/CTA like
    the sibling Campaigns page; no refresh spin; no `onNavigate` (nav dead-end);
    magic thresholds; typography soup (`text-[10px]`/`text-[11px]`); ad-hoc
    mini-stat pattern copy-pasted 3×; PageHeader without an eyebrow (unlike
    siblings), the "#3 advisory" disclaimer printed twice.
- **Customization gaps (G6).** Config knobs (warmup_target/half_life_days/
  modified_z_threshold/seasonality) are DISPLAYED read-only exactly where a user
  would want to tune them, but there's no in-page control; no signature filter/
  watchlist/pin (G7).
- **Reuse.** Extract a shared `MiniStat`; add a `tone` variant to `ui/progress.tsx`;
  **wire up the already-built drill-in** as a DataTable + Sheet (reuses tested
  components, fills the wasted space, delivers the intended feature);
  adopt the Campaigns page as the archetype (enabled=false Alert / error
  EmptyState+Retry / spinning Refresh / onNavigate / DataTable+Sheet).
- **Risks.** #9 signature strings via plain/InlineCode; keep the XSS + numeric-
  guard tests green; keep the deferred-Promise fetch pattern; keep the `baseline`
  page id stable.

### `BatchJobs.tsx` — async LLM batch-job viewer (+ `Batch.api.ts`)

- **Purpose.** READ-ONLY status dashboard of the durable async batch-job registry
  (~50%-off async batch API): PageHeader + 4-tile StatCard row + 9-column
  DataTable of job progress. No mutating controls. `BatchJobs.tsx:70`.
- **Problems.**
  - **Heavyweight hero on a trivially-simple page (G5):** full icon-chip +
    eyebrow + h1 + 2-line description restating title/docstring on a control-free
    status table.
  - **Non-responsive 9-col table** at fixed density; no pagination/sorting despite
    DataTable supporting both (no column sets `sortable`).
  - **Spacing/grid inconsistency with siblings (G2):** `flex flex-col gap-6` vs
    Tuning/Campaigns/Baseline `space-y-6`; stat grid `gap-3 sm:grid-cols-4` vs
    Tuning `gap-4 sm:grid-cols-2` — each page hand-rolls its KPI grid.
  - **Confusing "Requests" StatCard:** label "Requests", value = retrieved count,
    sub "of N retrieved" → "Requests: 10 / of 14 retrieved"; also uses risk-token
    `accent="medium"` for a neutral count; redundant with the per-row column.
  - **In-flight accounting drops jobs:** `active` excludes retrieved, `done` =
    only retrieved; terminal `errored`/`expired` are in NEITHER tile.
  - **Duplicated boilerplate:** `errMsg` byte-identical to Baseline; the
    load/error state machine repeated across BatchJobs/Baseline/Tuning/Campaigns
    (no shared hook); refresh-icon spacing diverges (`mr-2`/`mr-1.5`/none) with a
    double-gap bug on siblings; no last-updated/auto-refresh; lowercase "Provider
    batch id" header; hardcoded discount math in `DiscountPill`.
- **Coupling.** Low overall (imports only shared primitives + colocated Batch.api).
  BUT `Batch.api.ts` lives at `soc/` root, NOT in `pages/` like
  Campaigns.api/Tuning.api/Models.api — inconsistent co-location. State-token
  knowledge split (order/meta in Batch.api, active/done aggregation in the page).
- **Customization gaps.** No column customization (9-col table, `columnState`
  unused); no state/provider filter or sort; no batch-policy config here (batch
  default-OFF, no enable affordance); no custom dashboard; no auto-refresh
  cadence.
- **Reuse.** Shared read-only async-page scaffold (`useResource`/`<AsyncSection>`);
  shared KPI stat-row primitive; shared discount/pricing formatter;
  `<StatusBadge meta>`; shared `<RefreshButton>`; relocate Batch.api.ts to
  `pages/`.
- **Risks.** Keep read-only posture (#3); #9 plain-text; the tested
  `BatchJobsInner` export + `batchApi` mock shape; asserted copy
  ("of 14 retrieved", tile labels, state tokens); the `Promise.resolve().then`
  wrapper.

---

## PLATFORM / ADMIN GROUP

### `Sources.tsx` — data-source management (483 lines)

- **Purpose.** Platform > Sources: loads connector manifests + configured sources
  (parallel), renders each source as a full-width Card with a triage summary
  (index patterns + roles, entity strategy, message field, secret count) + per-
  source actions (browse Logs Sheet, make primary, edit/add via the 1819-line
  SourceEditor Dialog, remove). Thin orchestrator. `Sources.tsx:106`.
- **Problems.**
  - **G4/G5 wasted space:** single full-width column (`space-y-4`, each Card
    `p-5`); on wide screens each card stretches full width for ~2 lines. Sibling
    `ConnectorPicker` already uses a responsive grid (`grid-cols-1 sm:grid-cols-2
    lg:grid-cols-3`) — Sources doesn't.
  - **No overview / health:** `GET /api/sources/health` (last-poll freshness /
    buffer depth / can_browse) exists in the backend but is entirely unrendered —
    the page can't tell if a source is actually ingesting.
  - **G6 customization gap:** per-feed `correlate`/`auto_investigate`/
    `severity_floor` are in the model but never surfaced on the card — you can't
    see (let alone toggle) auto-behavior without opening the giant editor.
  - **Polish bug:** `{humanizeToken(ingest_mode)}` renders a stray em-dash when
    `ingest_mode` is null → "Elastic · —".
  - **Cluttered action bar:** up to 4 always-visible ghost buttons that wrap; no
    kebab/overflow (other row surfaces use DataTable row actions).
  - **Chip-size drift:** `h-11` here vs PageHeader `h-10` vs ConnectorPicker
    `h-9`; hardcoded type scale (`text-[0.95rem]`, `text-[0.7rem]`); `title=`
    tooltips + non-interactive `+N` (patterns 4+ inaccessible); no empty-config
    signal.
- **Coupling.** Heavy dependency on the 1819-line `SourceEditor`; imports
  `categoryMeta` OUT of the `ConnectorPicker` component (should be a shared lib);
  make-primary via `upsertSource` re-serializes the whole source to flip one flag;
  untyped `s.config as (...)` casts duplicating config-key knowledge.
- **Customization gaps.** No inline per-feed rule toggles (G6); no health view;
  no sort/filter/search/group; no enable/disable on the card; no test-connection/
  poll-now; unused `onNavigate` (no per-source detail route caps how much rule
  customization the page can surface).
- **Reuse.** Adopt ConnectorPicker's grid; shared `SourceIcon`/`ConnectorAvatar`;
  move `categoryMeta`/`CATEGORY_META` to a shared lib; DataTable row-action/kebab;
  a typed `readSourceConfig()` accessor; an `api.sources/health` wrapper +
  `SourceHealthPill`.
- **Risks.** Preserve all fields on make-primary re-serialize; keep the legacy
  `data_view_pattern` branch in `summarisePatterns`; secret-count-only display;
  #9; SourceEditor's scrollable-modal assumptions; `Can sources:manage` on every
  state-changer; Round-4 config keys + legacy aliases migration.

### `Settings.tsx` — the 2673-line configuration monolith (G3 primary target)

> Mapped by three agents (A: IA/registry lines 1-900; B: section renderers
> 900-1800; C: layout primitives + rail + render switch 1800-2673 + registry).
> Merged.

- **Purpose.** ONE page rendering EVERY org + personal preference plus five
  embedded standalone pages (Account, Sessions, Users, AdminSessions, Security
  MFA+SSO). IA = 3-level tree: **6 GROUPS → 20 SECTIONS → per-section anchored
  cards** navigated by an in-section scroll-spy TOC. Single dirty draft, minimal-
  patch save via `StickySaveBar`.
- **Key structures.** `SectionId` union (20 ids, `129-152`); `SECTION_GROUPS`
  (`172-373`); `ALL_SECTIONS` (`375`); `GRID_SECTIONS` set (`382-387`);
  `SectionShell` + `SettingsTOC` + `useActiveAnchor` (`434-499`); local form
  primitives `TextPref/NumPref/SwitchPref/ModelPicker/SecretInput` (`501-706`);
  `renderSection()` switch (`2420`); rail+body grid (`2563`); GRID wrap decision
  (`2641-2647`). Section renderers: `GeneralSection 716`, `ModelsSection 794`,
  `DetectionSection 910`, `AutonomyControls 1093`, `AdvancedSection 1174`,
  `OrgSecuritySection 1350`, `AutomationRuleEditor 1470`, `AutomationSection 1767`,
  `KnowledgeSection 1888`, `CaseIdSection 2023`.
- **Problems.**
  - **G3 MONOLITH:** 2673 lines in ONE file — 20 section bodies + registry + ~10
    form primitives + the shell. The single biggest decomposition target.
  - **G3 TWO nav paradigms:** an outer grouped rail AND, for the 4 grid sections,
    a SECOND in-section sticky TOC bar — nested/duplicated nav (the deep-submenu
    clutter G3 targets).
  - **G2/consistency BUG:** `GRID_SECTIONS` lists only
    general/detection/knowledge/advanced, but `AutomationSection` ALSO renders a
    SectionShell+SettingsGrid — because "automation" isn't in the set, the render
    path wraps it in an outer Card → **card-grid-inside-a-card double chrome**.
  - **Two competing section layouts:** grid sections use SectionShell+SettingsGrid
    (boxed card grid + TOC); the other 16 sit on a bare single-card surface — two
    visual grammars gated by the hardcoded `GRID_SECTIONS` allowlist (a manual
    dual source of truth).
  - **G3 duplicate/overlap across groups:** Appearance appears TWICE (personal
    "Appearance & customization" `204` vs org "Appearance & branding" `340`);
    Security TWICE (self MFA `188` vs org SSO `323`); Sessions TWICE (own `196` vs
    all-users `330`) — near-identical names, overlapping search keywords.
  - **G3 unbalanced groups:** "Administration" is a 6-section catch-all
    (Users/Security/Sessions/Branding/Advanced) mixing branding + "Advanced"
    (caps/killswitch/allowlist/suppression) that aren't administration;
    "Configuration" has 3, "Experimental" has 1. Thin single-purpose sections
    (Standup = one window control; Cases = only case-ID nomenclature).
  - **Repeated hardcoded "inset panel" recipe** (`rounded-md border border-border
    bg-surface px-4 py-3/py-4`) copy-pasted ≥8× (`1121/1223/1311/1396/1497/1966/
    1979`) instead of a shared `InsetPanel`; local `PostureTile` (`1384-1407`)
    duplicates KpiTile/StatCard.
  - **Hand-rolled disabled-dimming** (`cn(..., !enabled && 'opacity-60')`)
    reimplemented 4× (CrossSource/Rag/Autonomy/Automation).
  - **`AutomationRuleEditor` is a 295-line inline condition-builder + 5-way
    action-payload if-ladder** (`1470-1765`) buried in the monolith — the closest
    thing to a real rule editor but not reusable/co-located with other rule types.
  - **Duplicated enum option lists** (VERDICT/STATUS/ENTITY/AUTOMATION_ACTIONS
    `1411-1461`, RESET_PERIOD/CASE_ID_PLACEHOLDERS) that must track backend enums
    by hand; repeated `'__any__'` sentinel juggling.
  - **Cutover debt:** five external page bodies imported and rendered inline
    (`114-118`) while their standalone routes stay live — the same UI at two entry
    points, doubling maintenance.
  - **Launcher-not-editor:** several cards just deep-link OUT (Models → Models
    page; Detection catalog → intelligence#catalog `1311-1322`; Knowledge corpus
    → Knowledge page `1965-1992`) — the setting appears here but the real editing
    is elsewhere.
  - **Mixed save lifecycle:** most sections save via the page dirty-map, but
    `EnrichmentProvidersEditor` (`1053`) self-saves — invisible inconsistency.
- **Customization gaps (G6/G7 — major).**
  - **Rule config fragmented across 3 sections + separate nav pages:** Detection
    (correlation/risk/escalation/auto-close/cross-source `910-985`), Automation
    (`1767-1880`), Advanced (suppression + a catalog that deep-links out
    `1297-1325`); adaptive tuning + baseline + campaigns are ENTIRELY OUTSIDE
    Settings as standalone nav pages. **No single "Rules" home.**
  - **Round-4 config blocks MISSING (grep-confirmed):** `threshold_tuning`,
    `campaign`, `baseline`, `batch` have NO section renderer anywhere in
    Settings.tsx and don't appear in `SECTION_GROUPS`; `caps.max_concurrent` is
    also omitted from the Advanced caps card.
  - **G7 absent:** no custom-dashboard section/entry point; only per-table saved
    views exist.
  - Auto-close policy exposes ONLY the FALSE_POSITIVE class (`1093-1163`); the
    TRUE_POSITIVE opt-in has no control. Risk weights are 5 raw inputs with no
    normalization preview. Correlation is global N+window (per-feed lives in
    Sources).
- **Coupling.** Hard cross-page dependency on 5 pages via `*Inner` imports;
  `renderSection()` switch + `SectionId` union + `SECTION_GROUPS` + `GRID_SECTIONS`
  are four things that must stay in sync (already drifting); `onNavigate` string-
  coupled to other pages' route ids/tabs.
- **Reuse.** Hoist the form primitives to `soc/components`; make `SECTION_GROUPS`
  a data-driven `id→component` registry; split each section body into its own file
  (leave Settings.tsx a thin rail + router); collapse the personal/org duplicate
  pairs into single sections with a scope toggle; merge the thin sections; unify
  ALL sections on ONE SectionShell layout and delete `GRID_SECTIONS`; extract
  `InsetPanel` + `DisabledGroup`; extract `AutomationRuleEditor` to its own file
  driven by a `payloadFields` descriptor; centralize the enum lists; **add the
  missing Round-4 rule/tuning sections and a unified "Rules & tuning" home (G6).**
- **Risks.** Preserve the `/api/settings` load/save contract + minimal-patch +
  per-section dirty mapping (all keyed to top-level Preferences keys); write-only
  secrets (booleans only, #10); keep standalone routes during cutover; preserve
  per-section RBAC (rail filter AND inner `<Can>` for deep-links); keep anchor ids
  (deep-link + scroll-spy targets); `decide()` byte-identical (AutonomyControls is
  only the UI over `fp_auto_close`); `threshold_automation` wire key +
  `AutomationRule→CaseAutomationRule` alias; `'__any__'`→undefined serialization;
  rules-of-hooks ordering (`2338-2345`); DangerZone reset stays behind
  manage+`<Can>`.

### `Users.tsx` — admin "Users & roles"

- **Purpose.** Admin (`users:manage`) account table + add/reset/assign-roles/
  enable-disable/delete. Default export (standalone `#/users`) + `UsersInner`
  (embedded in Settings `admin_users`). Mutations via `api.users.*` except custom-
  role assign via `rolesApi.assignUserRoles`. `Users.tsx:76/91`.
- **Problems.**
  - **Duplicated `ROLE_LABELS`/`roleLabel`** (`54-65`) — the exact map already
    exported from `Roles.api.ts:147-161` (which Users imports for
    `BUILTIN_ROLES`). Two sources of truth. Duplicated `errMsg`.
  - **G4 bare stack:** PageHeader + single full-width DataTable; no KPI band
    (total/active/admins/must-reset) despite the data being in `users[]`.
  - **No search / role-filter / active-only filter; columns non-sortable;** no
    bulk actions (DataTable supports selection but it's off).
  - **Row actions = 3 unlabeled icon-only ghost buttons** (KeyRound/ShieldCheck/
    Trash2, `242-279`); the ShieldCheck (assign roles) is cryptic AND conditional
    so the action column width jumps; delete via **native `window.confirm()`**
    (`153`) — breaks the design system (the same file's dialogs use `<Dialog>`).
  - **Two overlapping role-editing surfaces** (inline Select changes base role AND
    the AssignRoles dialog sets base + custom roles); `userCustomRoles` reads
    custom roles via an unsafe `as unknown as {...}` cast because the typed `User`
    has no `prefs/custom_roles` — custom-role badges can't show in the table.
  - Bare centered Switch with no state text; hardcoded `text-[10px]` badges;
    sparse 5-col table (no MFA/last-password-change).
- **Coupling.** Dual mount (standalone `ProtectedRoute` + Settings `<Can>` +
  `UsersInner`); split role API (`api.roles.get` + `rolesApi`); tight to
  `Roles.api.ts` (`BUILTIN_ROLES`); untyped `prefs.custom_roles` cast; overlapping
  types (`RolesResponse` vs `RolesMatrixResponse`).
- **Customization gaps.** No column customization/saved views/filters; hardcoded
  role labels; no pagination control; hardcoded 8-char password rule.
- **Reuse.** Import `ROLE_LABELS`/`roleLabel` from Roles.api; shared `errMsg`; add
  `custom_roles?`/`prefs?` to the `User` type; wire DataTable's sort/selection/
  pagination/columnState; replace `window.confirm` with a shared `ConfirmDialog`;
  consolidate role APIs; a header KPI band from `users[]`.
- **Risks.** Keep server-enforced last-active-super_admin guard (409) surfacing;
  `must_change_password` on create; dual-mount auth-off back-compat (no second
  ProtectedRoute in `UsersInner`); #9 plain usernames; keep `custom_roles` on the
  assignment endpoint.

### `Roles.tsx` — RBAC role administration (+ `Roles.api.ts`, `RoleMatrixEditor.tsx`)

- **Purpose.** Admin surface: built-in + custom role roster (DataTable), a create/
  clone/edit dialog wrapping the resource×action matrix editor with a preview-
  diff, and a permission spot-check "Simulate". Gated `ProtectedRoute roles:manage`.
  RBAC only gates WHO may call close/escalate (#3 intact). `Roles.tsx:109/117`.
- **Problems.**
  - **Design consistency (biggest):** hand-rolls card containers with hardcoded
    utilities instead of `<Card>` — SimulatePanel `bg-card p-5 space-y-4` (`624`),
    PreviewDiff `bg-surface p-4 space-y-3` (`540`) — the two even disagree, and
    neither carries `shadow-elev1`. 16 sibling pages import `<Card>`; this page
    imports 0.
  - **Nav/permission MISMATCH (functional):** nav gates on `roles:view`
    (`nav.ts:269`) but the page's `ProtectedRoute` requires `roles:manage`
    (`111`), and the RBAC vocabulary defines roles as `['read','manage']` with NO
    'view' — a role granted only view would see the nav link then hit
    Unauthorized.
  - **Flat/wasted layout (G4):** single `space-y-6` stack; the 4-column roster and
    Simulate panel could sit side-by-side; Simulate is pushed below the fold.
  - **Capability banner wastes a band (G5-adjacent):** a full-width Alert stating
    "you can/can't modify" is redundant with the disabled action buttons.
  - **Meaningless matrix headers:** `RoleMatrixEditor` renders generic "Action 1/
    Action 2…" (`230-234`) because it pads to the widest action count — "Action 2"
    means different actions per resource; columns convey nothing.
  - **Native `window.confirm` for delete** (`216`); hardcoded action vocabulary in
    SimulatePanel (`672`) duplicating `RESOURCE_ACTIONS`; icon semantics
    inconsistent (ShieldCheck means the feature AND a custom role AND "signed in
    as"); ad-hoc `text-critical` delete vs badge `destructive`/`critical` mix; 3
    tiny icon-only row actions.
- **Coupling.** `RoleMatrixEditor` (a shared component) imports UP into
  `@/soc/pages/Roles.api` for the RBAC vocabulary + types — a layering inversion;
  vocab/types should live in `lib/rbac.ts`. SimulatePanel action fallback
  duplicates `RESOURCE_ACTIONS`; `RESOURCE_ACTIONS` is a hand-maintained mirror of
  the backend policy (no runtime sync).
- **Customization gaps.** IS the RBAC customization surface, but doesn't cover
  assigning roles to users (`assignUserRoles` exists, unused — split to Users); no
  UI to customize the vocabulary; the model already has an `automation` resource
  (anticipating a rules surface) but this page only governs WHO may manage it, not
  the rules; no import/export; Simulate is single-cell only.
- **Reuse.** Replace both hand-rolled cards (and the Models twin) with `<Card>`/
  `SettingsCard`; extract RBAC vocab+types to `lib/rbac.ts`; shared `ConfirmDialog`
  (with Users); move PreviewDiff/SimulatePanel to `components/`; standardize the
  danger affordance.
- **Risks.** Don't loosen `ProtectedRoute roles:manage` or the `!canManage`
  disables (fix the nav/page mismatch by ALIGNING, never widening); keep the
  tri-state deny-wins cell state machine; #9 role name/description in plain text/
  CodeBlock; name sanitizer + built-in-shadow guard; keep `RESOURCE_ACTIONS` in
  sync with backend policy.

### `Sessions.tsx` — own sessions + activity (exports the shared `SessionsTable`)

- **Purpose.** Signed-in user's sessions (device/browser, location/IP, last-
  active, age) + recent activity; revoke one or "sign out all other sessions". #9
  plain text; #10 no token shown. Standalone route + `SessionsInner` embedded in
  Settings; its `SessionsTable`/helpers are reused by AdminSessions. `Sessions.tsx:286/295`.
- **Problems.**
  - **Wasted vertical space from an always-mounted PageHeader** for a ~2-5-row
    table; in the Settings-embedded path this is a SECOND heavy header under
    Settings chrome (double titles).
  - **Tabs overkill for two tabs** (full TabsList + inter-element gaps push the
    data down).
  - **Header actions not responsive-safe** ("Sign out all other sessions" wraps
    awkwardly next to Refresh).
  - **Two near-identical AlertDialog blocks** inline (`445-505`) + two MORE in
    AdminSessions — four copies of one confirm shape, no shared `<ConfirmDialog>`.
  - **Inconsistent destructive color:** `text-critical hover:text-critical`
    className hack (`192/393`) vs dialog `variant="destructive"`.
  - Magic `text-[10px]` badges; Activity fails soft to an unexplained empty tab;
    Refresh spinner keyed only to `loading` not `activityLoading`; `otherCount`
    computed but never surfaced; revoke aria-label embeds the raw sid.
- **Coupling.** **AdminSessions imports `SessionsTable`+helpers from this PAGE**
  (page→page, `AdminSessions.tsx:26`) — a reusable table living in a page file
  (G8 smell; should be `soc/components/`). Dual mount + dead `onNavigate` prop.
  Route duplication (Settings sub-section + nav child + hidden standalone).
  Duplicated `errMsg`. `ActivityList` reuses session helpers → implicit shared UA/
  geo shape (`Pick<Session,...>`).
- **Customization gaps.** Fixed columns (no `columnState`); no pagination/sort/
  filter wired despite DataTable support; no in-context session-policy hint.
- **Reuse.** Extract `SessionsTable`+helpers to `soc/components/`; shared
  `ConfirmDialog` (collapse 4 dialogs); `errMsg` to lib; a `useSessions()` hook
  (fixes the spinner mismatch); Button `variant` for destructive; wire DataTable
  columnState/sort.
- **Risks.** #9/#10 (device/location/IP/action plain, sid never a credential);
  current-session-first ordering + "This device" branch (revoke=sign-out-this-
  device); revoke-current redirect flow; keep `SessionsTableProps` back-compat for
  AdminSessions; the render test (default export + revoke-confirm); no `<Can>` gate
  on `SessionsInner` (self-scoped, auth-off).

### `AdminSessions.tsx` — all-users session console

- **Purpose.** Admin (`users:manage`) console: list every account's sessions,
  filter by username, force-terminate one (with email-notify checkbox), revoke-all
  for a user. Reuses `SessionsTable`/helpers from `Sessions.tsx`. Default export
  (hidden `#/admin_sessions`, ProtectedRoute) + `AdminSessionsInner` (embedded in
  Settings, `<Can>`-gated). `AdminSessions.tsx:47/61`.
- **Problems.**
  - **Double header when embedded:** `AdminSessionsInner` renders a FULL PageHeader
    (icon chip + "Administration" eyebrow + h1) inside the shared Settings
    `<Card p-6>` — a redundant hero band; the eyebrow duplicates the Settings group
    label.
  - **Wasted vertical band + poor real-estate (G4):** `space-y-6` stack; the filter
    is a lone 224px input on an otherwise empty full-width row; no summary/KPI
    (total sessions / distinct users / stale) uses the freed width — the console is
    one input + one table.
  - **No result count / density** (DataTable footer summary unused).
  - **Client-side-only filtering ignores a server capability:** `admin.sessions.
    list(username?)` forwards `?username=` but the page calls it with no arg and
    filters in-memory — silently caps at the unpaginated server return; the server
    filter is dead code.
  - **Revoke-all is hidden by design:** only appears when the filter narrows to
    EXACTLY one distinct username (`revokeAllCandidate`) — undiscoverable for a core
    admin action; no per-user grouping or per-row "revoke all".
  - **Duplicated AlertDialog + notify-checkbox scaffolding** (two near-identical
    dialogs, plus a third copy in Sessions); inconsistent destructive styling
    (`variant="outline"`+manual critical text vs `variant="destructive"`);
    duplicated `errMsg`.
- **Coupling.** Hard dependency on `Sessions.tsx` (page→page import); dual entry +
  dual gating (ProtectedRoute + `<Can>`); orphaned standalone route (hidden,
  reachable only by deep-link/Settings — the documented "consolidation-REDIRECTS
  deferred" item); unused `onNavigate`.
- **Customization gaps.** No column config (despite per-table column-state store);
  no saved views/persisted filter; no bulk selection (DataTable supports it); no
  exposed sort/pagination; per-action notify default-OFF with no org default; no
  in-context link to session/token POLICY knobs.
- **Reuse.** Extract `SessionsTable`+helpers to `components/`; shared
  `ConfirmDestructiveDialog`/`NotifyConfirmDialog` (collapse 3 dialogs); `errMsg`
  to lib; DataTable footer summary; wire column-state + saved views; semantic
  destructive variant.
- **Risks.** Keep BOTH client gates (backend enforces `users:manage` + step-up
  independently); #9/#10; both named + default exports referenced (App/Settings/
  test); `SessionsTable` back-compat for the personal page; keep the type/confirm
  step on revoke-all (bumps token_version server-side).

### `Security.tsx` — MFA + token/session policy + SSO/OIDC editor

- **Purpose.** Dual-purpose: (a) per-user TOTP MFA enrollment (any signed-in
  user); (b) admin block (`<Can settings:manage>`) with the token/session policy
  editor + OIDC provider editor. Inner exports (`SecurityMfaInner`,
  `SecuritySsoInner`) are BOTH the `/security` route body AND embedded in
  Settings (account_security tab + SSO/session section) — a controlled/uncontrolled
  hybrid. `Security.tsx:545/534`.
- **Problems.**
  - **Design-system break:** the group→role map uses a RAW `<textarea>`
    (`254-267`) — the ONLY raw textarea in all of `soc/` — with `bg-card` (vs the
    primitive's `bg-background`) and NO focus ring (a11y + consistency regression)
    despite `ui/textarea.tsx` existing.
  - **Duplicated copy-to-clipboard:** `CopyField` (`76-104`) reimplemented as
    `CopyButton` in MfaSetupCard (`48`) and again in ChatPanel (`333`) — three
    copies.
  - **Standalone route double-fetches** `getSettings()` (page + nested
    SessionPolicyEditor) — two round-trips, two Skeletons, two prefs copies that
    can drift; and has TWO separate Save buttons with no unified save (`saveSso`
    PUTs only `{sso}`, not `session_policy`).
  - Hardcoded `text-[10px]` badge; unused PageHeader `actions` slot (weak
    hierarchy); three inconsistent section-header treatments; lossy silent
    group-map parsing (drops partial lines mid-type, no invalid-role guard);
    jittery comma-list re-serialize on every keystroke; icon-only Remove-provider
    with NO confirm (single-click deletes a configured provider); long single
    scroll of full-width provider cards with no collapse/summary.
- **Coupling.** Controlled/uncontrolled dual-mode branching on `Boolean(update)` is
  the central knot (a second copy of prefs state only for standalone); NOT self-
  contained (imported by the 2673-line Settings.tsx); secret handling split across
  two mechanisms + two sources; hardcoded `ROLES` array (drifts from backend RBAC
  + custom-roles); inline string↔array/map serialization; `callbackUrl` from
  `window.location.origin` inline.
- **Customization gaps.** **No custom-role support in SSO provisioning** (only 6
  hardcoded roles for default_role + group map, despite the custom-roles feature);
  freeform textarea group→role map with no picker/validation; no per-provider
  ordering/priority/test-sign-in; NO detection/correlation/risk/auto-close/tuning
  rule surface here (G6 lives elsewhere).
- **Reuse.** ONE shared `CopyField` (delete the 3 copies); `<Textarea>` primitive;
  reusable `TagInput` + `KeyValueEditor`/`RoleMapEditor`; unify the standalone save
  into one PageHeader-actions Save (or route through the controlled path); one
  shared `SubHeader`; source `ROLES` from a shared constant incl. custom roles;
  collapse provider cards into an accordion.
- **Risks.** Don't break the controlled contract of `SecuritySsoInner`/
  `SecurityMfaInner` (both call sites); write-only secrets (booleans only); #9 on
  echoed text; full-object PUT semantics on save (partial could lock admins out);
  keep destructive-remove parity/confirm; `/security` + legacy route must resolve;
  MFA secret/recovery-codes stay transient.

---

## WORKSPACE GROUP

### `Workspace.tsx` — host (Chat | Investigate)

- **Purpose.** 57-line thin host composing Chat + Investigate into one tabbed
  surface via `TabbedPage` (Round-2 W4 declutter). Owns only a unified PageHeader +
  tab bar; behavior lives in the sub-pages. Active tab from `NavOpts.tab`.
  `Workspace.tsx:28`.
- **Problems.**
  - **DUAL-RENDER INCONSISTENCY (biggest):** the "Investigate" nav child navigates
    by its raw id → App renders **standalone** `<Investigate>` (full PageHeader, no
    tab bar) — NOT inside Workspace. But clicking the parent "Workspace" renders
    `<Investigate embedded>` inside the tab host. Same content, two visually
    different pages depending on entry path.
  - **Magic-number height coupling:** embedded Chat frame `h-[calc(100vh-220px)]`
    (`Chat.tsx:72`) hand-sums topbar + wrapper padding + PageHeader + TabsList +
    gaps across 4 files with no shared token — any chrome change silently
    over/under-fills the frame.
  - **Wasted vertical space:** PageHeader + description (restating the tab labels) +
    tab bar + gaps THEN Chat's own header row for just "New chat" — two header
    bands for one screen.
  - **Redundant/duplicated copy:** the Workspace description near-duplicates Chat's
    and Investigate's own descriptions.
  - **Inactive-tab state loss:** TabbedPage unmounts the other tab → flipping
    Chat↔Investigate wipes in-progress form input + result + transcript.
  - **`onValueChange` always re-navigates** even for a no-op tab click.
  - **caseId deep-link dropped:** CaseDetail navigates `('chat',{caseId})` but
    Workspace only reads/forwards `tab` → the case-scoped chat is unreachable.
  - Same icon (MessageSquare) for the header chip AND the first tab.
- **Coupling.** Workspace + TabbedPage + Chat.embedded + Investigate.embedded = a
  4-file layout contract held by a magic number; the `embedded` toggle is
  duplicated prop-drilling; Workspace hard-imports both sub-pages (opening Chat
  eagerly pulls in the heavy Investigate + CaseDetail).
- **Reuse.** Hoist the embedded/standalone header logic into TabbedPage; a single
  `CHILD_ROUTES` map (id→{host,tab}) shared by nav/NavSidebar/App so "investigate"
  always resolves to a Workspace tab; a shared CSS var for shell chrome height;
  thread `caseId` generically; `forceMount` (or lift state) so switching tabs
  doesn't discard work.
- **Risks.** Keep all `#/chat`/`#/investigate` deep-links + `navigate('chat',
  {tab})` + CaseDetail's `('chat',{caseId})` + CommandPalette resolving; the single
  aria-current invariant (`NavSidebar.test`); ONE chat engine (#5); TabbedPage is
  shared by 4 hosts.

### `Chat.tsx` — conversational triage (thin wrapper over `ChatPanel.tsx`)

- **Purpose.** Chat.tsx is a thin page shell (PageHeader + "New chat" reset +
  full-height frame); ALL behavior (transcript, composer, result table, per-message
  cost/model meta, provenance accordion, memory action/suggestion, model + source
  pickers) lives in the reusable `ChatPanel` (designed to embed in the case sheet
  via `<ChatPanel caseId compact/>`). In practice Chat is only ever `embedded`
  inside Workspace. `Chat.tsx:53`; engine `ChatPanel.tsx:816`.
- **Problems.**
  - **Dead branch:** Chat's `embedded=false` PageHeader path is unreachable (the
    only caller always passes `embedded`) — dead UI + a duplicate title concept.
  - **Dead prop `onNavigate`** (accepted, dropped).
  - **BROKEN deep-link / lost case scope:** `CaseDetail.tsx:4128` navigates
    `('chat',{caseId})` but App forwards only `tab` → "Open full chat" lands on a
    generic chat with NO case scope; ChatPanel's whole `caseId` feature + "Scoped
    to case" chip is unreachable from the flyout.
  - **MAJOR non-reuse / duplicated engine:** the case sheet hand-rolls a SEPARATE,
    lower-fidelity `ChatTab` (`CaseDetail.tsx:4066-4160`) that does NOT import
    ChatPanel — dropping ChatPanel's result table/meta/provenance/memory for
    in-case chat; two divergent chat UXs.
  - **Fragile hardcoded heights** (`104px`/`220px`); a 25-line header comment
    documenting the coupling is itself a smell.
  - **Inline `<style>` block** (`ChatPanel.tsx:972-986`) — the ONLY component under
    soc/ui doing this (keyframes + `.socMsgActions` hover), re-emitted per mount;
    not reusing shared `Stagger`/`LoadingBar`.
  - **Feedback is fake** (component-local only; never calls the real feedback API);
    **source picker misleading** ("All sources" permanently caveated to "queries
    the primary source"); model-picker label cramping; composer footer redundancy;
    ResultTable has zero customization (fixed 50-row cap).
- **Coupling.** Chat frame tightly coupled to sibling chrome via unshared magic
  numbers; 4-level host chain (chat→Workspace→TabbedPage→Chat→ChatPanel); `caseId`
  has no wiring path from the router; ChatPanel injects global CSS + re-fetches
  models/sources per mount (no caching).
- **Customization gaps.** Starter prompts hardcoded (and diverge between the two
  chat surfaces); no default-model/source persistence; result table not
  customizable; "All sources" a placeholder; no saved/persistent chat history
  (lost on reset/tab-switch); feedback non-persistent.
- **Reuse.** Consolidate the two chats: make CaseDetail's ChatTab embed
  `<ChatPanel caseId compact/>` and delete the hand-rolled tab; fix the caseId
  deep-link once (thread it App→Workspace→Chat→ChatPanel); move the inline `<style>`
  into theme.css / reuse LoadingBar+Stagger; a shared FullHeightPage wrapper; hoist
  starter prompts to one config; wire feedback to the real API; share the
  models/sources fetch.
- **Risks.** #9 (Markdown/renderInline/ResultTable/Provenance render as text nodes
  / InlineCode / CodeBlock — never `dangerouslySetInnerHTML`; `discoverHref`
  allowlist); keep the `reset()` imperative handle; `send()` deliberately doesn't
  push errors into history; reduced-motion scroll; keep the compact/full-bleed
  layout + the "transcript lane is the only scroller" flex invariant.

### `Investigate.tsx` — ad-hoc entity investigation (739 lines)

- **Purpose.** On-demand agentic investigation against an IP/user/host over a
  lookback window (`POST /api/investigate`), rendering the returned Case as a rich
  inline verdict `ResultCard` (badges, recommended action, evidence, MITRE, risk
  breakdown, reproduce query, facts) + a per-session `sessionStorage` history +
  the CaseDetail sheet. One of Workspace's two tabs; `embedded` toggles its own
  PageHeader. `Investigate.tsx:350`.
- **Problems.**
  - **MASSIVE content duplication with CaseDetail:** `ResultCard` (`154-336`)
    re-implements a subset of the 2600-line CaseDetail sheet (badges/summary/
    evidence/MITRE/reproduce-query). After a run the user sees the full verdict
    inline AND can "Open case" to see effectively the same content again — two
    divergent renderings, inconsistent detail (ResultCard doesn't filter ruled-out
    evidence).
  - **Local one-off `SectionLabel`** (`148-152`) hardcoding the small-caps class
    that appears ~45× across pages with no shared primitive.
  - **Off-grid rhythm:** `space-y-7` (28px) unique to this page (siblings use
    space-y-8/6).
  - **Speculative dead UI:** `riskFactors()` reads undeclared
    `risk_factors`/`risk_breakdown`/`risk_components` via the Case index signature
    — the whole Risk-breakdown section is driven by undocumented, untyped fields
    the backend may never populate.
  - Dead `Telescope` icon fallback; subtly-wrong Run-button disabled logic (click
    can't trigger the empty-submit hint, only Enter); the primary CTA crammed into
    ~16% width while the entity-type control gets 33%; a permanent "Saved to the
    case queue" banner on every result; bespoke role=button recent-list rows.
- **Coupling.** Hard dependency on the heavy CaseDetail sheet (drift risk); dual
  mounting via `embedded`; relies on the Case index signature for risk fields;
  seeds lookback from the global `SettingsResponse.prefs` bag (a per-user pref store
  would be cleaner); module-private sessionStorage key.
- **Customization gaps.** Fixed 3-option lookback (no custom range); entity type
  hardcoded to ip/user/host (can't investigate by domain/hash/email despite the
  enrichment layer supporting them); Risk breakdown not user-configurable and
  depends on undocumented fields (G6 — surfaces risk but offers zero levers); no
  saved/named investigations beyond the ephemeral 6-item session list; no compact
  vs full ResultCard view.
- **Reuse.** Shared `SectionLabel`; dedupe verdict rendering (reuse a shared
  `CaseSummaryCard` extracted from CaseDetail); standard page shell; shared
  list-row/CaseHoverCard for recents; a shared `<AsyncResult>` for the 5 status
  blocks; declare risk fields on the Case type (or delete the block).
- **Risks.** The 400-status branch is load-bearing (400 = NEUTRAL "no in-scope
  events", NOT an error); #9 plain-text/CodeBlock on all backend strings;
  sessionStorage quota-safe non-fatal; `embedded` header suppression; keep
  `source_surface`/`group_by` in the POST body; real cost-metered runs (keep the
  loading guard, no double-submit). **No dedicated test** (G9).

---

## PRE-AUTH / FIRST-RUN

### `Login.tsx` — branded sign-in / OOBE (+ `loginParts.tsx`, `login.api.ts`)

- **Purpose.** Pre-auth gate: a five-value `Mode` state machine (signin / setup /
  change / mfa / mfa-enroll) over three reads + four submit handlers. EAGER-loaded
  (owns first paint). The only place the login white-label renders to real users;
  `BrandingEditor` reuses the same `loginParts` for its preview. `loginParts.tsx`
  is the #9 security boundary (operator copy as plain text; illustrations are
  code-authored enum-keyed SVG/CSS). `Login.tsx:104`.
- **Problems.**
  - **Massive single-file page** (807 lines / ~34KB): 5 modes + 4 handlers + a
    hardcoded password blocklist + 3 layout shells; all 4 form bodies inlined in
    one 375-line `formInner` const; the icon-in-input password field near-duplicated
    4×.
  - **Icon-in-input copy-pasted ~7-9×** (`pointer-events-none absolute left-3
    ... text-muted-foreground` + hand-placed `pl-9`) — no `IconInput` primitive.
  - **Broken/misleading indentation** from a prior refactor (over-indented card
    body).
  - **Hardcoded non-tokenized hero bg** `bg-[hsl(222_28%_9%)]` inlined 3× — always
    dark regardless of theme (G1: the hero doesn't participate in light/dark).
  - **Password policy duplicated + drift risk** (`OOBE_MIN_PASSWORD_LEN=12` +
    ~55-entry blocklist hardcoded as a "mirror" of the server) AND **two
    independent strength implementations** (`scorePassword` vs
    `oobePasswordPolicyError`) that can disagree ("Strong" while rejected).
  - Support link + footer text in 2 places with brittle per-layout `lg:hidden`
    suppression; fixed `max-w-sm` form wastes the split column on wide screens;
    static "Audited, cost-metered agentic triage." tagline NOT white-labelable;
    inline errors lack `aria-live`/`role=alert` (inconsistent with the meter's
    aria-live); SSO block mode-fragile + hand-built divider; raw white-alpha hero
    chrome everywhere (not tokenized, AA risk).
- **Coupling.** GOOD: `loginParts` (BrandHero + curated LAYOUT/ILLUSTRATION enums +
  coercers) shared by Login AND BrandingEditor — the enum-key contract is the good
  part. `LOGIN_BRANDING_DEFAULTS` spread into theme.tsx + BrandingEditor (3
  consumers). `LoginBranding` is a structural superset re-declared in 3 files
  instead of `lib/types.ts`. EAGER coupling: `bundle-first-paint.test` hard-asserts
  no framer-motion in loginParts.
- **Customization gaps.** Static tagline not white-labelable; illustration+layout
  are a fixed code enum (deliberate #9 boundary, but a ceiling); per-mode copy
  (setup/change/mfa) hardcoded English (only signin is white-labelable); password
  policy not operator-configurable; no i18n hook anywhere (the most-seen screen
  can't be translated).
- **Reuse.** Extract `IconInput`/`FieldWithIcon` (collapses 9 blocks, reusable in
  Settings/editors); split the 4 mode bodies into components; tokenize the hero
  (a `--login-hero` var pair) to join light/dark (G1); promote the password policy
  to shared constants (or fetch from backend) + unify with `scorePassword`; reuse a
  Separator; fold login white-label fields into `lib/types.ts Branding`; a shared
  `FormError` with aria-live.
- **Risks.** The Mode machine + 4 handlers are behavior-locked by tests
  (`login.render.test`, `BrandingEditor.login.test`); MUST NOT reintroduce
  framer-motion; `loginParts` is the #9 boundary (copy as plain text, illustrations
  code-authored); BrandHero shared with the editor preview; curated enum key sets
  are the backend wire contract; Login is EAGER (don't make it lazy/heavy);
  `LOGIN_BRANDING_DEFAULTS` shape depended on by theme + editor.

### `Wizard.tsx` — first-run setup wizard (941 lines, 4 steps)

- **Purpose.** Standalone first-run surface, mounted full-screen when
  `setup_complete:false` (re-runnable from Settings). 4 steps (Welcome / Sources /
  Provider keys / Review): name deployment + optional demo toggle, connect log
  sources (delegating to the shared 1819-line SourceEditor), enter write-only LLM
  keys, review, then `putSettings` + `completeSetup`. One of two EAGER pages.
  `Wizard.tsx:96`.
- **Problems.**
  - **FUNCTIONAL/CONTRACT GAP — the demo toggle is cosmetic:** the Welcome Switch
    drives `demoMode`, persisted via `putSettings({demo_mode} as
    Partial<Preferences>)`, but the real demo tenant is a structured
    `Preferences.demo` block armed only by `POST /api/demo/enable`. There is NO
    backend `demo_mode` pref key and no mapping (grep = 0 hits). A user who flips
    "Demo mode" finishes with the demo tenant still OFF — the toggle writes a dead
    loose key (the `as Partial<Preferences>` cast is the tell).
  - **`deployment_name` written but never read into real behavior** — not a real
    Preferences field (grep = 0), stored as a loose extra key that "round-trips
    harmlessly" (the header even claims it's "shown across the console").
  - **Stale initial state:** `SourcesStep` derives `adding` from a prop via
    `useState` (reads only on first mount) — fragile prop-derived-into-state.
  - **Space:** whole wizard hard-capped at `max-w-5xl` including the dense
    SourceEditor on the Sources step (cramped in ~1024px).
  - **Duplicated hero/stepper, no shared primitive:** the numbered stepper is
    hand-rolled (~48 lines) with per-state color logic duplicated by ReviewRow's
    status circle; `SecretField` (write-only + reveal + configured badge) is inline
    and not exported (high-value shared candidate).
  - **Clutter:** Welcome stacks a marketing FEATURES grid (duplicating the hero
    description) + input + demo card + conditional Alert; demo explained in 3 places
    across 2 steps; inconsistent X-icon semantics (close/error/not-configured);
    reveal button is a raw `<button>`; free stepper navigation with no "not done"
    affordance; skeleton only matches the Welcome step.
- **Coupling.** Tight to the 1819-line SourceEditor; mounted imperatively by App
  (no route, can't lazy-load/deep-link); force-casts two non-existent Preferences
  fields through `putSettings`; the demo boolean is decoupled from the real demo
  subsystem in the WRONG way (should call `api.demoEnable`); reuses HeroPanel/
  EmptyState/LoadingBar cleanly.
- **Customization gaps.** Hardcoded `STEPS` (can't add/remove/reorder for
  white-label); NO first-run touchpoint for detection/correlation/risk/auto-close/
  tuning policy (G6 — connect a source + key then run with defaults); keys fixed to
  exactly 3 providers (no Azure/Bedrock/Vertex/base_url); no branding capture in
  first-run; demo is a bare boolean not wired to the real enable path.
- **Reuse.** Extract a shared `Stepper` + `StatusPill`; extract `SecretField`→
  shared `SecretInput` (reused by Settings keys + SourceEditor); unify
  StepHeading with PageHeader/HeroPanel; move the FEATURES grid to a data+card
  component.
- **Risks.** Preserve `finish()` ordering (putSettings BEFORE completeSetup; only
  advance on success) + the onComplete/onExit contract App depends on; keep EAGER
  (no lazy without fallback); write-only secrets (never echo, cleared after save,
  #10); #9 plain-text operator/source text; SourceEditor prop interface stability
  (shared with the Sources page); the free-navigation + review-tolerates-missing
  behavior on re-run; verify backend accepts `demo_mode`/`deployment_name` before
  making them typed.

---

## THE BIG SHARED SHEET

### `CaseDetail.tsx` — full-screen case report (4210 lines) + `CaseDetail.api.ts`

> Mapped by two agents (A: lines 1-2835 — action model/header/footer/OverviewTab;
> B: lines ~1120-4210 — lifecycle actions/close dialog/Trace/Collaboration/
> OverviewTab tail/Feedback). Merged.

- **Purpose.** The core analyst workflow surface: a full-width right `Sheet` opened
  with a caseId that fetches a Case and renders a **7-tab** report (Overview / Why /
  Threat context / Trace / Collaboration / Feedback / Chat) + a header of
  icon-actions + a footer lifecycle-action bar (one primary CTA + unified
  Close-with-disposition + overflow), all gated by a shared confirm-with-fields
  dialog that ALWAYS POSTs an existing backend verb so `decide()`/`apply()` stay
  server-side (#3). `CaseDetail.api.ts` is a deliberately co-located typed client
  (Round-3 read + collaboration endpoints). The busiest page in the app.
- **Key structures.** `CaseDetail` component `604`; `ActionKind`/`ActionDef`/
  `ALL_ACTIONS` `187-369`; `ACTION_PERMISSION` `207`; `actionPlanForStatus` `407`;
  `runAction()` (the #3-preserving close path — `action: wireAction ?? key`) `1150`;
  confirm `<Dialog>` `1870-2014`; footer bar `1774-1861`; `OverviewTab` `2423`
  (~410 lines); `CollaborationThreadTab` `3589`; `AssigneePicker` `3498`;
  `FeedbackTab` `3809`; live-SSE debounced refetch `818-838`.
- **Problems.**
  - **MONOLITH:** 4210 lines in ONE file; the exported component alone is ~1485
    lines with ~40 `useState` hooks; all 7 tab bodies + helpers inlined. The worst
    file for G8/G9 — nothing is unit-testable or reusable in isolation.
  - **Design-system non-reuse (biggest, G2):** `rounded-lg border border-border
    bg-card p-6` hand-rolled **28× (+3 `p-5` = 31)**; `@/ui/card` is NOT imported at
    all. Any elevation/radius/padding change must be done 31×. Inconsistent padding
    (`p-6` vs `p-5` in the collab aside for no reason).
  - **Wasted vertical space in OverviewTab (G4):** `space-y-7 p-6` stacking 9+
    full-width cards single-column with 28px gaps → a long scroll of half-empty
    cards.
  - **Redundant signal display:** verdict+confidence shown as big HeadlinePanels
    (half-width, floating) AND again as VerdictBadge/ConfidenceBadge AND in the
    CaseTriageHeader chip; risk shown 3× (chip + RiskBadge + breakdown card); the
    status/disposition/escalation triplet shown twice (header `1298-1306` +
    Overview `2544-2572`).
  - **Header icon overload:** 6-7 unlabeled ghost icon-buttons; two (chat/trace)
    merely `setTab(...)` duplicating tabs directly below; `pr-8` magic offset to
    dodge the Sheet's built-in close X (with a warning comment).
  - **Tab overload:** 7 tabs at `text-xs`; Why/Threat/Trace are facets of one "why
    was this decided" story; Feedback + Collaboration are both human-input surfaces.
  - **Doc drift:** header docstring lists 5 tabs; the actual TabsList renders 7.
  - **Duplicated tone maps** (TONE_TEXT/BORDER/ACCENT `492-514`) re-declared in
    CaseTriageHeader; hardcoded non-tokenized risk-bar thresholds (`2503-2504`)
    duplicating palette/RiskGauge; magic Select sentinels (`__none__`/`__all__`/
    `__unassigned__`/`__unknown__`/`__configured__`) scattered.
  - **Dead/vestigial action defs:** `close` + `confirm_fp` fully defined but
    `actionPlanForStatus` never returns them (everything uses `close_disposition`)
    — a trap that could regress the #12 unification; `set_disposition` still wired
    into overflow.
  - **Resolution vs Disposition confusion:** the unified Close dialog shows BOTH a
    required Disposition select AND an optional Resolution select, with "benign"/
    "duplicate" appearing in BOTH pickers, unexplained.
  - **Generic error surfacing:** action/export failures render a top-of-body Alert
    titled "Could not load case" (misleading) that collides with loaded content.
  - **Brittle presentation logic:** `RULED_OUT_RE`/`isRuledOut` classify evidence
    by regex over the UNTRUSTED summary string in the browser (belongs server-side
    / a typed field); RelatedCrossSource N+1 fetches up to 200 cases to label a few
    related titles; synthetic BurnDownChart from a single snapshot; FeedbackTab
    fake-star feedback + 24px hit-areas re-implemented per widget.
  - **NO customizability (G6/G7):** tab set + OverviewTab section order/visibility
    all hardcoded; auto-close policy is only EXPLAINED here (read-only) with no
    in-context path to adjust the bar; DISPOSITION/RESOLUTION/PRIORITY/OUTCOME
    option sets frozen client constants; lifecycle action plan per status is fixed;
    feedback rubric fixed.
- **Coupling.** `CaseDetail.api.ts` types (TriageChips/RiskChip/…) are imported by
  the SHARED `CaseTriageHeader.tsx` — a component reaching UP into a page module
  (inverted dependency; move to `lib/types.ts`). OverviewTab reads raw Case fields
  with many defensive `as` casts across ~400 lines. All 40 hooks + loaders live on
  the parent and are threaded as ~20-25 props into each tab (tabs not
  independently mountable). Local `HeadlinePanel`/`MetaItem`/`SectionHeading`
  private. Three parallel action structures (`ALL_ACTIONS`/`ACTION_PERMISSION`/
  `actionPlanForStatus`) kept consistent by hand. RBAC via two mechanisms
  (`useCan` booleans + `<Can>`/`hasPermission`).
- **Reuse.** Extract each tab body to `soc/pages/case-detail/*` (mechanical,
  high-value for G8/G9 + lazy import); promote HeadlinePanel/MetaItem/SectionHeading
  to `components/`; move CaseDetail.api types to `lib/types.ts`; centralize
  critical/high/…→token maps in palette.ts; collapse the redundant verdict/
  confidence/badge/chip triple into ONE compact status band (G4/G5); factor the
  action model into a `useCaseActions` hook + `<CaseActionDialog>` (shareable with
  Cases bulk); shared `OptionalSelect` for the sentinel pattern; derive option
  lists from a single shared enum mirror; **replace the 31 hand-rolled boxes with
  Card/SectionCard** (the single highest-leverage cleanup); consolidate the header
  icons into a kebab; embed `<ChatPanel caseId compact/>` and delete the parallel
  ChatTab; a `useCaseCollab(id)` hook to de-prop-drill Collaboration; a
  `GET /api/cases?ids=` endpoint to kill the N+1.
- **Risks.** **#3:** every close/escalate MUST keep POSTing an EXISTING verb via
  `wireAction ?? key` (`close_disposition→close`); the disposition is a payload
  field the backend applies through `decide()`/`apply()`; keep the required-
  disposition submit-gate. **#9:** dozens of UNTRUSTED plain-text sites + evidence/
  queries in CodeBlock — a layout refactor must not switch any to markdown/HTML.
  RBAC gating (`cases:close`/`cases:write`) must not loosen. Lazy-tab fetch gating
  + post-action state invalidation + the SSE debounce refs must survive extraction.
  The `pr-8` X-avoidance must not reintroduce a second close control. Removing the
  vestigial `close`/`confirm_fp` defs must update `ActionKind`/`ACTION_PERMISSION`
  + any tests.

---

## PRIORITIZED CROSS-PAGE PROBLEM LIST (for the overhaul)

Ranked by leverage × breadth × goal-alignment. **P0** = do first (unblocks the
most, or a real bug); **P3** = lower / opportunistic.

### P0 — foundations that unblock everything else

1. **Establish + enforce ONE card/section primitive (G2, G8).** Adopt `@/ui/card`
   (or a `SectionCard`/`SettingsCard` wrapper) everywhere and delete the hand-rolled
   `rounded-lg border border-border bg-card p-5/p-6` boxes. Worst: **CaseDetail
   (31)**, Settings inset-panels (≥8), Models (3), Roles (2), Cost/Metrics
   `ChartCard`. Fixes the flat/no-`shadow-elev1` inconsistency and the padding
   drift. *Prerequisite for a coherent restyle.*

2. **Extract shared list/control primitives (G2, G8).** `SegmentedControl`/
   `ToggleGroup` (≥8 hand-rolled copies), `FilterBar`/`Toolbar` (byte-identical
   Audit==Cases), `ConfirmDialog`/`ConfirmDestructiveDialog` (native
   `window.confirm` in Users+Roles; ~4 duplicated AlertDialogs in Sessions+
   AdminSessions), `IconInput`/`FieldWithIcon` (Login ×9, Settings), `SecretField`/
   `SecretInput` (Wizard, Settings, SourceEditor, Security CopyField ×3), `TagInput`
   (Knowledge, Memory, Security), `MiniStat`/`KpiGrid`, `SectionLabel` (~45 inline
   copies). Move `errMsg`/`describeError` to `lib`.

3. **Fix layering inversions + page→page imports (G8).** Move `CaseDetail.api`
   types, RBAC vocab (`Roles.api` → `lib/rbac.ts`), `Models.api`,
   `posture.format`/`Metrics.posture.api`, `NotificationPrefs`↔`Inbox.api`, and
   `SessionsTable`/helpers (Sessions→`components/`) out of page modules so shared
   components/pages stop importing UP into pages. Lazy-load `CaseDetail` from Cases.

4. **Fix the confirmed bugs (G9).** (a) Metrics **delta arrow/color
   contradiction** (green UP arrow next to a "-12%" label for lowerIsBetter tiles —
   `deltaView` sign-flip vs `KpiTile` arrow-from-value); (b) Wizard **demo toggle
   is cosmetic** (writes a dead `demo_mode` key, never arms `Preferences.demo` /
   `POST /api/demo/enable`); (c) **Roles nav/page perm mismatch** (`roles:view` vs
   `roles:manage`, and `view` isn't a real action); (d) Cases **one-click
   destructive close with no confirm**; (e) Campaigns **Recorrelate gated by read
   perm** so every viewer sees an enabled admin button.

### P1 — the headline goals (space, hero, dashboard, Settings)

5. **Compact the hero band (G5).** Add a `compact` variant to `HeroPanel` (thin/
   drop `bg-hero-glow`, `px-5 py-4`, `h-9` chip, collapse description into meta),
   keep the window toggle + refresh, and merge `HeroPanel`+`PageHeader` (near-
   identical prop surfaces) into one `PageHero density=...`. Fixes Overview (~176px
   band), Standup, Wizard, and the double-header pattern.

6. **Reclaim dashboard real-estate (G4).** Overview: full-width KPI strip (use the
   unused `CommandCenterLayout.strip` slot), 4-up/5-up + `2xl:` breakpoints, shrink
   the RiskGauge card + delete its redundant `<dl>`, collapse Severity/Workload
   onto `BarList`, delete the ~120 lines of client posture math. Same density pass
   for Metrics (grids capped at `lg:grid-cols-6`), Cost, Approvals (card→optional
   table), Sources (list→responsive grid), AdminSessions (add a summary band).

7. **Declutter + decompose Settings (G3, G8).** Split the 2673-line monolith into a
   data-driven `id→component` registry + per-section files; unify ALL sections on
   ONE `SectionShell` layout and delete the `GRID_SECTIONS` allowlist (fix the
   automation double-card bug); collapse the personal/org duplicate pairs
   (Appearance ×2, Security ×2, Sessions ×2) into single scope-toggle sections;
   merge thin sections; remove one of the two nav paradigms (rail + per-section
   TOC).

### P2 — customization (the "make it yours" goals)

8. **A single "Rules & tuning" home (G6).** Rule config is fragmented across
   Settings›Detection + Settings›Automation + Settings›Advanced + standalone
   Tuning/Baseline/Campaigns pages + Sources per-feed, and the Round-4 blocks
   (`threshold_tuning`/`campaign`/`baseline`/`batch`, plus `caps.max_concurrent`)
   have **no Settings UI at all**. Add the missing sections + a unified rules
   surface. Make Approvals/Catalog editable (currently approve-only / read-only).
   Extract `AutomationRuleEditor` from Settings into a reusable, descriptor-driven
   component. Surface per-feed correlate/auto_investigate/severity_floor on the
   Sources card. Add "make a rule from this case" affordances on Cases/CaseDetail.

9. **Custom dashboards + per-user view persistence (G7).** Build a widget registry
   + arrangeable grid (Overview/Metrics tiles are the seeds; `CommandCenterLayout`
   is a clean host). Wire the EXISTING `UserPrefsStore`/saved-views/column-state
   into the many pages that ignore it (Audit, Scans, Campaigns, BatchJobs, Memory,
   Inbox, Sessions, Users, Knowledge). Persist window/filter/tab defaults.

### P3 — consistency, correctness, and dead code

10. **Color-scheme cohesion (G1).** Tokenize the always-dark Login/BrandHero hero
    (`bg-[hsl(222_28%_9%)]` ×3 + raw white-alpha chrome) into theme vars so it
    joins light/dark; centralize the critical/high/medium/low/info→token maps
    (duplicated in CaseDetail, CaseTriageHeader, Overview, Inbox, Standup) into
    palette.ts; retire ad-hoc `text-critical` className hacks for a semantic
    `destructive` variant; kill scattered `text-[10px]`/`text-[11px]`/`space-y-7`
    off-scale values.

11. **Wire up / remove dead surfaces.** Baseline's built-and-tested per-signature
    drill-in is unreachable (wire it as DataTable+Sheet); Chat's `embedded=false`
    branch + several `onNavigate` props are dead; CaseDetail's `close`/`confirm_fp`
    action defs + `MODEL_ROLE_SLOTS` are vestigial; Investigate's `riskFactors`
    reads undocumented fields; Metrics `maxAge`/synthetic BurnDown are cosmetic.

12. **Consolidate the two chat implementations + fix the caseId deep-link.** Make
    CaseDetail embed `<ChatPanel caseId compact/>` (delete the hand-rolled ChatTab)
    and thread `caseId` App→Workspace→Chat→ChatPanel so the case-scoped chat becomes
    reachable; wire the fake chat feedback to the real API; move ChatPanel's inline
    `<style>` into theme.css.

13. **Client-side-cap honesty + shared list hooks (G9).** Wherever a page fetches a
    single capped page and filters in-memory (Cases 200 / Audit 200 / Scans 50),
    either paginate server-side (DataTable + `res.total` already returned by Audit)
    or keep the truncation banner honest; extract a shared `useCaseList`/
    `useResource`/`<AsyncSection>` to end the duplicated load/error/empty state
    machines and the facet-from-loaded-window bug.

14. **Fill the test gaps (G9).** No dedicated tests for Overview/Home/Standup,
    Approvals, Memory, Investigate, Sources, Catalog — add render/interaction tests
    (esp. #9 plain-text, #3 close-path, filter/sort/group, destructive confirms)
    BEFORE refactoring those surfaces.

> **Invariants to hold across ALL of the above:** `engine/case_manager.py`
> `decide()` byte-identical (#3); every close/escalate keeps POSTing an existing
> backend verb; #9 untrusted-data fencing (plain text / InlineCode / CodeBlock,
> never `dangerouslySetInnerHTML`); #10 secrets shown as booleans only; RBAC gates
> preserved; Login stays EAGER + framer-motion-free.
